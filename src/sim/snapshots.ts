/**
 * Snapshot ring buffer and interpolation. The simulation writes one snapshot per tick; renderers
 * read interpolated entity states at any time inside the buffered window. Engine-free and
 * protocol-shaped: the same layout is what a network snapshot would carry (pose + animation).
 */

import { lerpPose, pose } from '../voxels/math.ts';
import type { Pose } from '../voxels/math.ts';

import { SIM_DT } from './clock.ts';

/** Per-entity layout: px py pz qx qy qz qw visible anim[0..ANIM_MAX). */
export const ANIM_MAX = 10;
export const STRIDE = 8 + ANIM_MAX;

export class SnapshotRing {
    readonly capacity: number;
    readonly entityCount: number;
    private readonly ticks: Float64Array;
    private readonly data: Float64Array[];
    private head = -1;
    private size = 0;

    constructor(entityCount: number, capacity = 32) {
        this.capacity = capacity;
        this.entityCount = entityCount;
        this.ticks = new Float64Array(capacity);
        this.data = [];
        for (let i = 0; i < capacity; i++) this.data.push(new Float64Array(entityCount * STRIDE));
    }

    clear(): void {
        this.head = -1;
        this.size = 0;
    }

    /** Returns the buffer to fill for a new tick. */
    beginWrite(tick: number): Float64Array {
        this.head = (this.head + 1) % this.capacity;
        this.ticks[this.head] = tick;
        this.size = Math.min(this.capacity, this.size + 1);
        return this.data[this.head];
    }

    get newestTick(): number {
        return this.size ? this.ticks[this.head] : -1;
    }

    get oldestTick(): number {
        if (!this.size) return -1;
        return this.ticks[(this.head - this.size + 1 + this.capacity) % this.capacity];
    }

    /**
     * Interpolated state of one entity at a time. Clamps to the buffered window.
     * Returns false when the entity is hidden at that time (or nothing is buffered).
     */
    sample(entity: number, time: number, outPose: Pose, outAnim: Float64Array): boolean {
        if (!this.size) return false;
        const t = time / SIM_DT;
        // find bracketing snapshots, newest first
        let bi = this.head;
        let ai = this.head;
        for (let n = 0; n < this.size; n++) {
            const idx = (this.head - n + this.capacity) % this.capacity;
            if (this.ticks[idx] <= t) {
                ai = idx;
                bi = n === 0 ? idx : (idx + 1) % this.capacity;
                break;
            }
            ai = idx;
            bi = idx;
        }
        const ta = this.ticks[ai];
        const tb = this.ticks[bi];
        const f = tb > ta ? Math.min(1, Math.max(0, (t - ta) / (tb - ta))) : 0;
        const A = this.data[ai];
        const B = this.data[bi];
        const o = entity * STRIDE;
        _a.p.x = A[o];
        _a.p.y = A[o + 1];
        _a.p.z = A[o + 2];
        _a.q.x = A[o + 3];
        _a.q.y = A[o + 4];
        _a.q.z = A[o + 5];
        _a.q.w = A[o + 6];
        _b.p.x = B[o];
        _b.p.y = B[o + 1];
        _b.p.z = B[o + 2];
        _b.q.x = B[o + 3];
        _b.q.y = B[o + 4];
        _b.q.z = B[o + 5];
        _b.q.w = B[o + 6];
        lerpPose(_a, _b, f, outPose);
        for (let c = 0; c < ANIM_MAX; c++) {
            const va = A[o + 8 + c];
            const vb = B[o + 8 + c];
            outAnim[c] = va + (vb - va) * f;
        }
        // visibility switches at the later snapshot, never blends
        return (f < 1 ? A[o + 7] : B[o + 7]) > 0.5 && (f > 0 ? B[o + 7] : A[o + 7]) > 0.5;
    }
}

const _a = pose();
const _b = pose();

export function writeEntity(
    buf: Float64Array,
    entity: number,
    p: Pose,
    visible: boolean,
    anim: ArrayLike<number>,
    animLen: number
): void {
    const o = entity * STRIDE;
    buf[o] = p.p.x;
    buf[o + 1] = p.p.y;
    buf[o + 2] = p.p.z;
    buf[o + 3] = p.q.x;
    buf[o + 4] = p.q.y;
    buf[o + 5] = p.q.z;
    buf[o + 6] = p.q.w;
    buf[o + 7] = visible ? 1 : 0;
    for (let c = 0; c < ANIM_MAX; c++) buf[o + 8 + c] = c < animLen ? anim[c] : 0;
}
