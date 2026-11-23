/**
 * Snapshot codec (design doc §6.2): the host's entity poses for one tick, packed small enough to
 * travel as room presence (strings of at most 1 KiB each, 4 KiB in all) and unpacked on the guest
 * into its snapshot ring, where the existing interpolation and voxel pipeline take over. Only
 * transforms and animation channels travel; every device rebuilds its own voxels (§4.2: never
 * network cells).
 *
 * Layout (little endian), version 3:
 *   u8 version, u32 tick, u16 n (entities in the level), ceil(n / 8) bytes: bit i = entity i visible,
 *   u16 count, then per listed entity:
 *   u16 index (sim entity order, identical on every device running the same build)
 *   u8 flags: bit 0-1 quaternion component dropped, bit 2 has animation
 *   i16 x3 position in 4 mm units (+-131 m: the Valley reaches +-125 m)
 *   i16 x3 the three smallest quaternion components, scaled by 32767 * sqrt(2)
 *   [u8 n, i16 x n animation channels in 1/500 units, angles wrapped to +-8 pi]
 * A visible entity that is not listed keeps its last pose on the guest (it is at rest, or waits for
 * the next snapshot): the host lists what moved lately and refreshes the rest in turn
 * (`SnapshotEncoder`), within the room's size limit.
 */

import type { SnapshotRing } from '../sim/snapshots.ts';
import { ANIM_MAX, writeEntity } from '../sim/snapshots.ts';
import type { Pose } from '../voxels/math.ts';
import { pose } from '../voxels/math.ts';

export const SNAPSHOT_VERSION = 3;
const POS_UNIT = 0.004;
const ANIM_UNIT = 1 / 500;
/** Animation values are wrapped into +-ANIM_WRAP / 2 (angles grow without bound: walk phase, wheels). */
const ANIM_WRAP = 16 * Math.PI;
const Q_SCALE = 32767 * Math.SQRT2;
/** Presence strings are at most 1 KiB: base64 chunks of this many characters. */
export const CHUNK = 1000;
/** Quantised values per entity: position x3, quaternion x3, dropped component, then animation. */
const QN = 7 + ANIM_MAX;

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

/** Bytes before the first entity, for `n` entities. */
export const headerBytes = (n: number) => 9 + Math.ceil(n / 8);
/** Bytes of one listed entity. */
export const entryBytes = (e: EncodableEntity) => {
    const n = Math.min(ANIM_MAX, e.asset.animChannels);
    return 15 + (n > 0 ? 1 + 2 * n : 0);
};

/** An entity's wire values (what the guest will see), into `out` (QN values). */
function quantise(e: EncodableEntity, out: Int32Array): void {
    const q = e.pose.q;
    // smallest three: drop the largest component, make it positive
    const c = [q.x, q.y, q.z, q.w];
    let big = 0;
    for (let k = 1; k < 4; k++) if (Math.abs(c[k]) > Math.abs(c[big])) big = k;
    const sign = c[big] < 0 ? -1 : 1;
    out[0] = clampI16(e.pose.p.x / POS_UNIT);
    out[1] = clampI16(e.pose.p.y / POS_UNIT);
    out[2] = clampI16(e.pose.p.z / POS_UNIT);
    let w = 3;
    for (let k = 0; k < 4; k++) {
        if (k === big) continue;
        out[w++] = clampI16(c[k] * sign * Q_SCALE);
    }
    out[6] = big;
    const n = Math.min(ANIM_MAX, e.asset.animChannels);
    for (let k = 0; k < ANIM_MAX; k++) out[7 + k] = k < n ? clampI16(wrapAnim(e.anim[k]) / ANIM_UNIT) : 0;
}

/** Packs the listed entities (all visible ones when `list` is left out) of one tick. */
export function encodeSnapshot(
    tick: number,
    entities: readonly EncodableEntity[],
    list?: readonly number[]
): Uint8Array {
    const ids = list ?? entities.flatMap((e, i) => (e.visible ? [i] : []));
    const n = entities.length;
    let size = headerBytes(n);
    for (const i of ids) size += entryBytes(entities[i]);
    const buf = new ArrayBuffer(size);
    const dv = new DataView(buf);
    const bytes = new Uint8Array(buf);
    dv.setUint8(0, SNAPSHOT_VERSION);
    dv.setUint32(1, tick >>> 0, true);
    dv.setUint16(5, n, true);
    for (let i = 0; i < n; i++) if (entities[i].visible) bytes[7 + (i >> 3)] |= 1 << (i & 7);
    let o = 7 + Math.ceil(n / 8);
    dv.setUint16(o, ids.length, true);
    o += 2;
    const v = new Int32Array(QN);
    for (const i of ids) {
        const e = entities[i];
        quantise(e, v);
        const na = Math.min(ANIM_MAX, e.asset.animChannels);
        dv.setUint16(o, i, true);
        dv.setUint8(o + 2, v[6] | (na > 0 ? 4 : 0));
        for (let k = 0; k < 6; k++) dv.setInt16(o + 3 + 2 * k, v[k], true);
        o += 15;
        if (na > 0) {
            dv.setUint8(o, na);
            for (let k = 0; k < na; k++) dv.setInt16(o + 1 + 2 * k, v[7 + k], true);
            o += 1 + 2 * na;
        }
    }
    return bytes;
}

/** Snapshots an entity stays listed after it last changed (1 s): a dropped update can't leave it stale. */
export const RECENT_SNAPSHOTS = 20;
/** A resting visible entity is listed again every this many snapshots (1 s), in turn. */
export const REFRESH_SNAPSHOTS = 20;

/**
 * The host's side: which entities each snapshot lists, within a byte budget.
 *
 * - Listed: every visible entity that changed (on the wire) in the last `RECENT_SNAPSHOTS`
 *   snapshots, and each resting visible entity once every `REFRESH_SNAPSHOTS` (spread over the
 *   snapshots by index), so a newcomer or a guest that missed updates has everything within 1 s.
 * - Over the budget: the entities waiting longest since they were last sent go first, nearest to a
 *   player first among equals; the rest wait for the next snapshot. Every waiting entity's wait only
 *   grows until it is sent, so none is starved.
 */
export class SnapshotEncoder {
    private n = 0;
    private readonly prev: Int32Array[] = [];
    private readonly cur = new Int32Array(QN);
    private lastChange: number[] = [];
    private lastSent: number[] = [];
    private wasVisible: boolean[] = [];
    /** Entities listed in the last snapshot, and those eligible but left for the next one. */
    listed = 0;
    deferred = 0;

    /**
     * One snapshot of `entities` at `tick`, at most `budget` bytes (the header always fits).
     * `near(i)` ranks equally stale entities (smaller first): the distance to the nearest player.
     */
    encode(
        tick: number,
        entities: readonly EncodableEntity[],
        budget = Infinity,
        near: (i: number) => number = () => 0
    ): Uint8Array {
        const snap = ++this.n;
        const eligible: number[] = [];
        for (let i = 0; i < entities.length; i++) {
            const e = entities[i];
            if (!this.prev[i]) {
                this.prev[i] = new Int32Array(QN);
                this.lastChange[i] = snap;
                this.lastSent[i] = -Infinity;
                this.wasVisible[i] = false;
            }
            if (!e.visible) {
                this.wasVisible[i] = false;
                continue;
            }
            quantise(e, this.cur);
            const p = this.prev[i];
            let changed = !this.wasVisible[i];
            for (let k = 0; k < QN && !changed; k++) if (p[k] !== this.cur[k]) changed = true;
            if (changed) {
                p.set(this.cur);
                this.lastChange[i] = snap;
            }
            this.wasVisible[i] = true;
            const recent = snap - this.lastChange[i] < RECENT_SNAPSHOTS;
            const due = (snap + i) % REFRESH_SNAPSHOTS === 0 || snap - this.lastSent[i] >= 2 * REFRESH_SNAPSHOTS;
            if (recent || due) eligible.push(i);
        }
        eligible.sort((a, b) => this.lastSent[a] - this.lastSent[b] || near(a) - near(b) || a - b);
        let room = budget - headerBytes(entities.length);
        const list: number[] = [];
        for (const i of eligible) {
            const b = entryBytes(entities[i]);
            if (b > room) continue;
            room -= b;
            list.push(i);
            this.lastSent[i] = snap;
        }
        this.listed = list.length;
        this.deferred = eligible.length - list.length;
        list.sort((a, b) => a - b);
        return encodeSnapshot(tick, entities, list);
    }
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

/** Reads a snapshot's tick without decoding it (or -1 if it is not a valid snapshot of this version). */
export function snapshotTick(bytes: Uint8Array): number {
    if (bytes.length < 9) return -1;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint8(0) !== SNAPSHOT_VERSION) return -1;
    return dv.getUint32(1, true);
}

/**
 * Unpacks snapshots into a guest's snapshot ring. Keeps each entity's last pose: a visible entity a
 * snapshot doesn't list stays where it was last sent, and one never sent yet (a guest that just
 * joined) stays hidden until it is. Unwraps animation channels so cycles stay continuous across the
 * wrap.
 */
export class SnapshotDecoder {
    private readonly last: Pose[];
    private readonly lastAnim: Float64Array[];
    /** Drawn at the last snapshot (visible, and its pose known). */
    private readonly visible: Uint8Array;
    /** Pose received at least once. */
    private readonly known: Uint8Array;
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
        this.known = new Uint8Array(entityCount);
    }

    /** Writes one snapshot into the ring; returns false (and changes nothing) if it is stale or bad. */
    apply(bytes: Uint8Array, ring: SnapshotRing): boolean {
        const tick = snapshotTick(bytes);
        if (tick < 0 || tick <= this.lastTick) return false;
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const n = this.entityCount;
        const listed: { i: number; p: Pose; anim: Float64Array | null }[] = [];
        let o = 7 + Math.ceil(n / 8);
        try {
            if (dv.getUint16(5, true) !== n) throw new RangeError('entity count');
            const count = dv.getUint16(o, true);
            o += 2;
            for (let c = 0; c < count; c++) {
                const i = dv.getUint16(o, true);
                const flags = dv.getUint8(o + 2);
                if (i >= n) throw new RangeError('entity index');
                const p = pose();
                p.p.x = dv.getInt16(o + 3, true) * POS_UNIT;
                p.p.y = dv.getInt16(o + 5, true) * POS_UNIT;
                p.p.z = dv.getInt16(o + 7, true) * POS_UNIT;
                const big = flags & 3;
                const q = [0, 0, 0, 0];
                let w = 9;
                let sum = 0;
                for (let k = 0; k < 4; k++) {
                    if (k === big) continue;
                    q[k] = dv.getInt16(o + w, true) / Q_SCALE;
                    sum += q[k] * q[k];
                    w += 2;
                }
                q[big] = Math.sqrt(Math.max(0, 1 - sum));
                const len = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
                p.q.x = q[0] / len;
                p.q.y = q[1] / len;
                p.q.z = q[2] / len;
                p.q.w = q[3] / len;
                o += 15;
                let anim: Float64Array | null = null;
                if (flags & 4) {
                    const na = dv.getUint8(o);
                    if (na > ANIM_MAX) throw new RangeError('animation channels');
                    anim = new Float64Array(na);
                    for (let k = 0; k < na; k++) anim[k] = dv.getInt16(o + 1 + 2 * k, true) * ANIM_UNIT;
                    o += 1 + 2 * na;
                }
                listed.push({ i, p, anim });
            }
            if (o > bytes.length) throw new RangeError('length');
        } catch {
            this.rejected++;
            return false;
        }
        for (const { i, p, anim } of listed) {
            const last = this.last[i];
            last.p.x = p.p.x;
            last.p.y = p.p.y;
            last.p.z = p.p.z;
            last.q.x = p.q.x;
            last.q.y = p.q.y;
            last.q.z = p.q.z;
            last.q.w = p.q.w;
            if (anim) {
                const prev = this.lastAnim[i];
                for (let k = 0; k < anim.length; k++) {
                    let v = anim[k];
                    // unwrap: continue from the previous value instead of jumping across the wrap
                    if (this.known[i]) v += Math.round((prev[k] - v) / ANIM_WRAP) * ANIM_WRAP;
                    prev[k] = v;
                }
            }
            this.known[i] = 1;
        }
        const buf = ring.beginWrite(tick);
        for (let i = 0; i < n; i++) {
            const shown = (bytes[7 + (i >> 3)] >> (i & 7)) & 1 && this.known[i] ? 1 : 0;
            this.visible[i] = shown;
            this.anim.set(this.lastAnim[i]);
            writeEntity(buf, i, this.last[i], shown === 1, this.anim, ANIM_MAX);
        }
        this.lastTick = tick;
        return true;
    }
}
