/**
 * Snapshot codec (design doc §6.2): the host's entity poses for one tick, packed small enough to
 * travel as room presence (strings of at most 1 KiB each, 4 KiB in all) and unpacked on the guest
 * into its snapshot ring, where the existing interpolation and voxel pipeline take over. Only
 * transforms and animation channels travel; every device rebuilds its own voxels (§4.2: never
 * network cells).
 *
 * Layout (little endian): u8 version, u32 tick, u16 count, then per visible entity:
 *   u16 index (sim entity order, identical on every device running the same build)
 *   u8 flags: bit 0-1 quaternion component dropped, bit 2 has animation
 *   i16 x3 position in 4 mm units (+-131 m: the Valley reaches +-125 m)
 *   i16 x3 the three smallest quaternion components, scaled by 32767 * sqrt(2)
 *   [u8 n, i16 x n animation channels in 1/500 units, angles wrapped to +-8 pi]
 * Entities not listed are hidden at that tick.
 */

import type { SnapshotRing } from '../sim/snapshots.ts';
import { ANIM_MAX, writeEntity } from '../sim/snapshots.ts';
import type { Pose } from '../voxels/math.ts';
import { pose } from '../voxels/math.ts';

export const SNAPSHOT_VERSION = 2;
const POS_UNIT = 0.004;
const ANIM_UNIT = 1 / 500;
/** Animation values are wrapped into +-ANIM_WRAP / 2 (angles grow without bound: walk phase, wheels). */
const ANIM_WRAP = 16 * Math.PI;
const Q_SCALE = 32767 * Math.SQRT2;
/** Presence strings are at most 1 KiB: base64 chunks of this many characters. */
export const CHUNK = 1000;

export interface EncodableEntity {
    pose: Pose;
    anim: Float64Array;
    visible: boolean;
    asset: { animChannels: number };
}

const clampI16 = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v)));
const wrapAnim = (v: number) => {
    const w = ((((v + ANIM_WRAP / 2) % ANIM_WRAP) + ANIM_WRAP) % ANIM_WRAP) - ANIM_WRAP / 2;
    return Number.isFinite(w) ? w : 0;
};

/** Packs the visible entities of one tick. */
export function encodeSnapshot(tick: number, entities: readonly EncodableEntity[]): Uint8Array {
    let size = 7;
    for (const e of entities) if (e.visible) size += 15 + (e.asset.animChannels > 0 ? 1 + 2 * e.asset.animChannels : 0);
    const buf = new ArrayBuffer(size);
    const dv = new DataView(buf);
    dv.setUint8(0, SNAPSHOT_VERSION);
    dv.setUint32(1, tick >>> 0, true);
    let o = 7;
    let count = 0;
    for (let i = 0; i < entities.length; i++) {
        const e = entities[i];
        if (!e.visible) continue;
        count++;
        const q = e.pose.q;
        // smallest three: drop the largest component, make it positive
        const c = [q.x, q.y, q.z, q.w];
        let big = 0;
        for (let k = 1; k < 4; k++) if (Math.abs(c[k]) > Math.abs(c[big])) big = k;
        const sign = c[big] < 0 ? -1 : 1;
        const n = e.asset.animChannels;
        dv.setUint16(o, i, true);
        dv.setUint8(o + 2, big | (n > 0 ? 4 : 0));
        dv.setInt16(o + 3, clampI16(e.pose.p.x / POS_UNIT), true);
        dv.setInt16(o + 5, clampI16(e.pose.p.y / POS_UNIT), true);
        dv.setInt16(o + 7, clampI16(e.pose.p.z / POS_UNIT), true);
        let w = 9;
        for (let k = 0; k < 4; k++) {
            if (k === big) continue;
            dv.setInt16(o + w, clampI16(c[k] * sign * Q_SCALE), true);
            w += 2;
        }
        o += 15;
        if (n > 0) {
            dv.setUint8(o, n);
            for (let k = 0; k < n; k++) dv.setInt16(o + 1 + 2 * k, clampI16(wrapAnim(e.anim[k]) / ANIM_UNIT), true);
            o += 1 + 2 * n;
        }
    }
    dv.setUint16(5, count, true);
    return new Uint8Array(buf);
}

export function toBase64Chunks(bytes: Uint8Array): string[] {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const b64 = btoa(bin);
    const out: string[] = [];
    for (let i = 0; i < b64.length; i += CHUNK) out.push(b64.slice(i, i + CHUNK));
    return out;
}

export function fromBase64Chunks(chunks: readonly string[]): Uint8Array {
    const bin = atob(chunks.join(''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/** Reads a snapshot's tick without decoding it (or -1 if it is not a valid snapshot). */
export function snapshotTick(bytes: Uint8Array): number {
    if (bytes.length < 7) return -1;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint8(0) !== SNAPSHOT_VERSION) return -1;
    return dv.getUint32(1, true);
}

/**
 * Unpacks snapshots into a guest's snapshot ring. Keeps each entity's last pose (so an entity
 * reappearing does not slide in from the origin) and unwraps animation channels so cycles stay
 * continuous across the wrap.
 */
export class SnapshotDecoder {
    private readonly last: Pose[];
    private readonly lastAnim: Float64Array[];
    private readonly visible: Uint8Array;
    private readonly anim = new Float64Array(ANIM_MAX);
    lastTick = -1;
    /** Malformed or out-of-range input seen (ignored, never thrown). */
    rejected = 0;

    readonly entityCount: number;

    constructor(entityCount: number) {
        this.entityCount = entityCount;
        this.last = Array.from({ length: entityCount }, () => pose());
        this.lastAnim = Array.from({ length: entityCount }, () => new Float64Array(ANIM_MAX));
        this.visible = new Uint8Array(entityCount);
    }

    /** Writes one snapshot into the ring; returns false (and changes nothing) if it is stale or bad. */
    apply(bytes: Uint8Array, ring: SnapshotRing): boolean {
        const tick = snapshotTick(bytes);
        if (tick < 0 || tick <= this.lastTick) return false;
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const count = dv.getUint16(5, true);
        const seen = new Uint8Array(this.entityCount);
        let o = 7;
        try {
            for (let n = 0; n < count; n++) {
                const i = dv.getUint16(o, true);
                const flags = dv.getUint8(o + 2);
                if (i >= this.entityCount) throw new RangeError('entity index');
                const p = this.last[i];
                p.p.x = dv.getInt16(o + 3, true) * POS_UNIT;
                p.p.y = dv.getInt16(o + 5, true) * POS_UNIT;
                p.p.z = dv.getInt16(o + 7, true) * POS_UNIT;
                const big = flags & 3;
                const c = [0, 0, 0, 0];
                let w = 9;
                let sum = 0;
                for (let k = 0; k < 4; k++) {
                    if (k === big) continue;
                    c[k] = dv.getInt16(o + w, true) / Q_SCALE;
                    sum += c[k] * c[k];
                    w += 2;
                }
                c[big] = Math.sqrt(Math.max(0, 1 - sum));
                const len = Math.hypot(c[0], c[1], c[2], c[3]) || 1;
                p.q.x = c[0] / len;
                p.q.y = c[1] / len;
                p.q.z = c[2] / len;
                p.q.w = c[3] / len;
                o += 15;
                if (flags & 4) {
                    const na = dv.getUint8(o);
                    const prev = this.lastAnim[i];
                    for (let k = 0; k < Math.min(na, ANIM_MAX); k++) {
                        let v = dv.getInt16(o + 1 + 2 * k, true) * ANIM_UNIT;
                        // unwrap: continue from the previous value instead of jumping across the wrap
                        if (this.visible[i]) v += Math.round((prev[k] - v) / ANIM_WRAP) * ANIM_WRAP;
                        prev[k] = v;
                    }
                    o += 1 + 2 * na;
                }
                seen[i] = 1;
            }
        } catch {
            this.rejected++;
            return false;
        }
        const buf = ring.beginWrite(tick);
        for (let i = 0; i < this.entityCount; i++) {
            this.visible[i] = seen[i];
            this.anim.set(this.lastAnim[i]);
            writeEntity(buf, i, this.last[i], seen[i] === 1, this.anim, ANIM_MAX);
        }
        this.lastTick = tick;
        return true;
    }
}
