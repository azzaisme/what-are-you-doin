/**
 * CPU reference rasterizer (design doc §5.3).
 *
 * For each part: transform its local bounds to a conservative world AABB, convert that to candidate
 * world cells, map each candidate's world centre into local space with the inverse pose, and ask
 * the volume for occupancy and material. Output cells are always world-lattice cells: nothing here
 * ever rotates or offsets a cube.
 *
 * Sampling policies (§5.4) for thin geometry:
 *  - center:       one sample at the cell centre (reference).
 *  - coverage50:   2x2x2 sub-samples, occupied when >= 4 of 8 are inside (area-preserving-ish).
 *  - coverage25:   2x2x2 sub-samples, occupied when >= 2 of 8 are inside (mild thickening).
 *  - conservative: boxes: cell box overlaps the oriented box (separating-axis test on the 6 face
 *                  axes - conservative, it may include a few edge cells); other shapes: any of the
 *                  8 sub-samples inside.
 * Material always comes from a point inside the volume. Among the inside samples, the material with
 * the highest precedence wins (details such as eyes outrank fur); ties keep the centre sample when it
 * is inside, otherwise the first inside sub-sample in a fixed order. Conservative boxes use the
 * clamped centre.
 */

import {
    BOUNDARY_EPSILON,
    GRID_SIZE,
    candidateCells,
    cellCenterX,
    cellCenterY,
    cellCenterZ,
    createCellRange,
    rangeCellCount
} from './grid.ts';
import { aabb, invertRigidMat34, mat34, poseIsFinite, poseToMat34, transformAabb } from './math.ts';
import type { Pose } from './math.ts';
import { VALUE_PRECEDENCE } from './palette.ts';
import type { Volume } from './volumes.ts';

export type SamplingPolicy = 'center' | 'coverage50' | 'coverage25' | 'conservative';
export const SAMPLING_POLICIES: readonly SamplingPolicy[] = ['center', 'coverage50', 'coverage25', 'conservative'];

export interface CellSink {
    /** Called once per occupied cell of a part. */
    write(i: number, j: number, k: number, value: number, priority: number): void;
}

export interface RasterStats {
    parts: number;
    candidates: number;
    samples: number;
    occupied: number;
    rejected: number;
}

export function createRasterStats(): RasterStats {
    return { parts: 0, candidates: 0, samples: 0, occupied: 0, rejected: 0 };
}

export function resetRasterStats(s: RasterStats): void {
    s.parts = 0;
    s.candidates = 0;
    s.samples = 0;
    s.occupied = 0;
    s.rejected = 0;
}

/** Largest world AABB edge accepted for one part (runaway guard, §5.3). */
export const MAX_PART_EXTENT = 40;
/** Largest number of candidate cells accepted for one part. */
export const MAX_PART_CANDIDATES = 4_000_000;

// Reusable scratch: never shared across re-entrant calls (the rasterizer is not re-entrant).
const _m = mat34();
const _inv = mat34();
const _wb = aabb(0, 0, 0, 0, 0, 0);
const _range = createCellRange();
const _sub = new Float64Array(24);
let _centers = new Uint16Array(4096);
const Q = GRID_SIZE * 0.25;
const SUB_OFFSETS = [
    [-Q, -Q, -Q],
    [Q, -Q, -Q],
    [-Q, Q, -Q],
    [Q, Q, -Q],
    [-Q, -Q, Q],
    [Q, -Q, Q],
    [-Q, Q, Q],
    [Q, Q, Q]
];

/**
 * Rasterizes one volume at a world pose into the sink. Returns false when the input was rejected
 * (invalid pose, runaway bounds); nothing is written in that case.
 */
export function rasterizeVolume(
    volume: Volume,
    worldPose: Pose,
    policy: SamplingPolicy,
    priority: number,
    sink: CellSink,
    stats: RasterStats
): boolean {
    stats.parts++;
    if (!poseIsFinite(worldPose)) {
        stats.rejected++;
        return false;
    }
    poseToMat34(worldPose, _m);
    invertRigidMat34(_m, _inv);
    transformAabb(volume.bounds, _m, _wb);
    if (
        _wb.maxX - _wb.minX > MAX_PART_EXTENT ||
        _wb.maxY - _wb.minY > MAX_PART_EXTENT ||
        _wb.maxZ - _wb.minZ > MAX_PART_EXTENT ||
        !candidateCells(_wb.minX, _wb.minY, _wb.minZ, _wb.maxX, _wb.maxY, _wb.maxZ, _range) ||
        rangeCellCount(_range) > MAX_PART_CANDIDATES
    ) {
        stats.rejected++;
        return false;
    }

    const inv = _inv;
    const r00 = inv[0];
    const r01 = inv[1];
    const r02 = inv[2];
    const t0 = inv[3];
    const r10 = inv[4];
    const r11 = inv[5];
    const r12 = inv[6];
    const t1 = inv[7];
    const r20 = inv[8];
    const r21 = inv[9];
    const r22 = inv[10];
    const t2 = inv[11];

    const multi = policy !== 'center';
    if (multi) {
        // world-axis sub-sample offsets expressed in local space
        for (let n = 0; n < 8; n++) {
            const o = SUB_OFFSETS[n];
            _sub[n * 3] = r00 * o[0] + r01 * o[1] + r02 * o[2];
            _sub[n * 3 + 1] = r10 * o[0] + r11 * o[1] + r12 * o[2];
            _sub[n * 3 + 2] = r20 * o[0] + r21 * o[1] + r22 * o[2];
        }
    }
    const threshold = policy === 'coverage50' ? 4 : policy === 'coverage25' ? 2 : 1;
    const shape = volume.shape;
    const satBox = policy === 'conservative' && shape.type === 'box';

    // For the box SAT: projection radius of a world cell onto each local box axis is
    // (s/2) * sum_j |R^T[a][j]|; the box's own radius onto world axis w is sum_a h_a |R[w][a]|.
    let cellRadX = 0;
    let cellRadY = 0;
    let cellRadZ = 0;
    let boxRadWX = 0;
    let boxRadWY = 0;
    let boxRadWZ = 0;
    let hx = 0;
    let hy = 0;
    let hz = 0;
    if (satBox) {
        hx = shape.hx;
        hy = shape.hy;
        hz = shape.hz;
        const hs = GRID_SIZE * 0.5;
        cellRadX = hs * (Math.abs(r00) + Math.abs(r01) + Math.abs(r02));
        cellRadY = hs * (Math.abs(r10) + Math.abs(r11) + Math.abs(r12));
        cellRadZ = hs * (Math.abs(r20) + Math.abs(r21) + Math.abs(r22));
        // R (local->world) = transpose of inverse rotation
        boxRadWX = hx * Math.abs(r00) + hy * Math.abs(r10) + hz * Math.abs(r20);
        boxRadWY = hx * Math.abs(r01) + hy * Math.abs(r11) + hz * Math.abs(r21);
        boxRadWZ = hx * Math.abs(r02) + hy * Math.abs(r12) + hz * Math.abs(r22);
    }
    // Early-out: when a candidate's centre lies farther outside the local bounds than any
    // sub-sample can reach, none of its samples can be inside. Output is unchanged.
    const reach = multi && !satBox ? Math.sqrt(3) * GRID_SIZE * 0.25 + 1e-9 : 0;
    const vb = volume.bounds;
    const bMinX = vb.minX - reach;
    const bMinY = vb.minY - reach;
    const bMinZ = vb.minZ - reach;
    const bMaxX = vb.maxX + reach;
    const bMaxY = vb.maxY + reach;
    const bMaxZ = vb.maxZ + reach;
    const cull = !satBox;
    const bcx = _m[3];
    const bcy = _m[7];
    const bcz = _m[11];
    const halfCell = GRID_SIZE * 0.5;

    const { minI, minJ, minK, maxI, maxJ, maxK } = _range;
    stats.candidates += (maxI - minI + 1) * (maxJ - minJ + 1) * (maxK - minK + 1);
    let samples = 0;
    let occupied = 0;

    if (multi && !satBox) {
        // Two passes. Pass 1 samples every candidate centre. Pass 2 accepts a cell whose centre and
        // six face-neighbour centres are all inside without sub-sampling: it is interior and never
        // visible, so only sub-cell cavities could differ. Surface cells take the full sub-sample
        // path (coverage threshold and material precedence) exactly as before.
        const nx = maxI - minI + 1;
        const ny = maxJ - minJ + 1;
        const nz = maxK - minK + 1;
        const total = nx * ny * nz;
        if (_centers.length < total) _centers = new Uint16Array(Math.ceil(total * 1.25));
        const C = _centers;
        let idx = 0;
        for (let j = minJ; j <= maxJ; j++) {
            const wy = cellCenterY(j);
            for (let k = minK; k <= maxK; k++) {
                const wz = cellCenterZ(k);
                for (let i = minI; i <= maxI; i++, idx++) {
                    const wx = cellCenterX(i);
                    const lx = r00 * wx + r01 * wy + r02 * wz + t0;
                    const ly = r10 * wx + r11 * wy + r12 * wz + t1;
                    const lz = r20 * wx + r21 * wy + r22 * wz + t2;
                    if (lx < vb.minX || lx > vb.maxX || ly < vb.minY || ly > vb.maxY || lz < vb.minZ || lz > vb.maxZ) {
                        C[idx] = 0;
                        continue;
                    }
                    C[idx] = volume.sample(lx, ly, lz);
                    samples++;
                }
            }
        }
        const sx = 1;
        const sz = nx;
        const sy = nx * nz;
        idx = 0;
        for (let j = minJ; j <= maxJ; j++) {
            const wy = cellCenterY(j);
            const jIn = j > minJ && j < maxJ;
            for (let k = minK; k <= maxK; k++) {
                const wz = cellCenterZ(k);
                const kIn = k > minK && k < maxK;
                for (let i = minI; i <= maxI; i++, idx++) {
                    const c = C[idx];
                    if (
                        c > 0 &&
                        jIn &&
                        kIn &&
                        i > minI &&
                        i < maxI &&
                        C[idx - sx] &&
                        C[idx + sx] &&
                        C[idx - sz] &&
                        C[idx + sz] &&
                        C[idx - sy] &&
                        C[idx + sy]
                    ) {
                        sink.write(i, j, k, c, priority);
                        occupied++;
                        continue;
                    }
                    const wx = cellCenterX(i);
                    const lx = r00 * wx + r01 * wy + r02 * wz + t0;
                    const ly = r10 * wx + r11 * wy + r12 * wz + t1;
                    const lz = r20 * wx + r21 * wy + r22 * wz + t2;
                    if (lx < bMinX || lx > bMaxX || ly < bMinY || ly > bMaxY || lz < bMinZ || lz > bMaxZ) continue;
                    let hits = 0;
                    let best = c;
                    let bestPrec = c > 0 ? VALUE_PRECEDENCE[c] : -1;
                    for (let n = 0; n < 8; n++) {
                        const v = volume.sample(lx + _sub[n * 3], ly + _sub[n * 3 + 1], lz + _sub[n * 3 + 2]);
                        if (v > 0) {
                            hits++;
                            const pr = VALUE_PRECEDENCE[v];
                            if (pr > bestPrec) {
                                best = v;
                                bestPrec = pr;
                            }
                        }
                    }
                    samples += 8;
                    if (hits >= threshold) {
                        sink.write(i, j, k, best, priority);
                        occupied++;
                    }
                }
            }
        }
        stats.samples += samples;
        stats.occupied += occupied;
        return true;
    }

    for (let j = minJ; j <= maxJ; j++) {
        const wy = cellCenterY(j);
        for (let k = minK; k <= maxK; k++) {
            const wz = cellCenterZ(k);
            for (let i = minI; i <= maxI; i++) {
                const wx = cellCenterX(i);
                const lx = r00 * wx + r01 * wy + r02 * wz + t0;
                const ly = r10 * wx + r11 * wy + r12 * wz + t1;
                const lz = r20 * wx + r21 * wy + r22 * wz + t2;
                let value = 0;
                if (cull && (lx < bMinX || lx > bMaxX || ly < bMinY || ly > bMaxY || lz < bMinZ || lz > bMaxZ))
                    continue;

                if (satBox) {
                    // separating axis test, 3 local box axes then 3 world axes
                    if (
                        Math.abs(lx) < hx + cellRadX - BOUNDARY_EPSILON &&
                        Math.abs(ly) < hy + cellRadY - BOUNDARY_EPSILON &&
                        Math.abs(lz) < hz + cellRadZ - BOUNDARY_EPSILON &&
                        Math.abs(wx - bcx) < halfCell + boxRadWX - BOUNDARY_EPSILON &&
                        Math.abs(wy - bcy) < halfCell + boxRadWY - BOUNDARY_EPSILON &&
                        Math.abs(wz - bcz) < halfCell + boxRadWZ - BOUNDARY_EPSILON
                    ) {
                        // material from the centre clamped just inside the box
                        const cx = clampInside(lx, hx);
                        const cy = clampInside(ly, hy);
                        const cz = clampInside(lz, hz);
                        value = volume.sample(cx, cy, cz);
                        samples++;
                    }
                } else {
                    value = volume.sample(lx, ly, lz);
                    samples++;
                    if (multi) {
                        let hits = 0;
                        let best = value;
                        let bestPrec = value > 0 ? VALUE_PRECEDENCE[value] : -1;
                        for (let n = 0; n < 8; n++) {
                            const v = volume.sample(lx + _sub[n * 3], ly + _sub[n * 3 + 1], lz + _sub[n * 3 + 2]);
                            if (v > 0) {
                                hits++;
                                const p = VALUE_PRECEDENCE[v];
                                if (p > bestPrec) {
                                    best = v;
                                    bestPrec = p;
                                }
                            }
                        }
                        samples += 8;
                        value = hits >= threshold ? best : 0;
                    }
                }

                if (value > 0) {
                    sink.write(i, j, k, value, priority);
                    occupied++;
                }
            }
        }
    }
    stats.samples += samples;
    stats.occupied += occupied;
    return true;
}

function clampInside(v: number, h: number): number {
    const lim = h * 0.999;
    return v < -lim ? -lim : v > lim ? lim : v;
}
