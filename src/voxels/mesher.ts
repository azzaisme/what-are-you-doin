/**
 * Exposed-face greedy mesher (design doc §5.5, Phase B).
 *
 * Meshes an axis-aligned box of world cells into contiguous flat square faces. All vertices lie
 * exactly on world grid planes; nothing is offset, bevelled, rotated or inset. Greedy merging joins
 * coplanar adjacent faces only when material, shade and ambient-occlusion pattern are identical, so
 * it changes triangle layout but never the silhouette or colour assignment.
 *
 * Two emission modes keep static and dynamic geometry free of coplanar duplicates:
 *  - static:  emits faces of static cells that are NOT overridden by a dynamic cell, exposed against
 *             the static layer only. These meshes rebuild only when static data or an override
 *             changes, never just because something moved nearby.
 *  - dynamic: emits faces of dynamic winner cells, exposed against the composite (static + dynamic).
 * A static face that points into a dynamic cell is enclosed by that dynamic cell and cannot be seen;
 * no position+direction is ever emitted twice (tested).
 *
 * Per-vertex ambient occlusion (classic voxel corner occlusion) is written to vertex alpha and used
 * by the material as ambient occlusion only. It is derived from the same occupancy grid.
 */

import { CHUNK_BITS, CHUNK_MASK, GRID_ORIGIN_X, GRID_ORIGIN_Y, GRID_ORIGIN_Z, GRID_SIZE, localIndex, packChunkCoord } from './grid.ts';
import { SURFACE_CLASS_COUNT, VALUE_RGB, VALUE_SURFACE } from './palette.ts';
import type { VoxelWorld } from './world.ts';

export type MeshMode = 'static' | 'dynamic';

/** Vertex alpha for 0..3 occluders (3 = unoccluded). */
export const AO_LEVELS = [92, 150, 205, 255];

export class ClassBuffers {
    positions = new Float32Array(0);
    normals = new Float32Array(0);
    colors = new Uint8Array(0);
    indices = new Uint32Array(0);
    vertexCount = 0;
    indexCount = 0;

    reset(): void {
        this.vertexCount = 0;
        this.indexCount = 0;
    }

    ensure(extraVerts: number, extraIdx: number): void {
        const nv = this.vertexCount + extraVerts;
        if (nv * 3 > this.positions.length) {
            const cap = Math.max(256, Math.ceil(nv * 1.5));
            const p = new Float32Array(cap * 3);
            p.set(this.positions.subarray(0, this.vertexCount * 3));
            this.positions = p;
            const n = new Float32Array(cap * 3);
            n.set(this.normals.subarray(0, this.vertexCount * 3));
            this.normals = n;
            const c = new Uint8Array(cap * 4);
            c.set(this.colors.subarray(0, this.vertexCount * 4));
            this.colors = c;
        }
        const ni = this.indexCount + extraIdx;
        if (ni > this.indices.length) {
            const cap = Math.max(384, Math.ceil(ni * 1.5));
            const ix = new Uint32Array(cap);
            ix.set(this.indices.subarray(0, this.indexCount));
            this.indices = ix;
        }
    }
}

export class MeshOutput {
    readonly classes: ClassBuffers[] = [];
    quads = 0;
    /** Unit faces represented (sum of w*h over quads). */
    faces = 0;

    constructor() {
        for (let i = 0; i < SURFACE_CLASS_COUNT; i++) this.classes.push(new ClassBuffers());
    }

    reset(): void {
        for (const c of this.classes) c.reset();
        this.quads = 0;
        this.faces = 0;
    }

    get vertexCount(): number {
        let n = 0;
        for (const c of this.classes) n += c.vertexCount;
        return n;
    }

    get triangleCount(): number {
        let n = 0;
        for (const c of this.classes) n += c.indexCount / 3;
        return n;
    }
}

export interface MeshOptions {
    greedy: boolean;
    ao: boolean;
}

export const DEFAULT_MESH_OPTIONS: MeshOptions = { greedy: true, ao: true };

// Scratch, grown on demand. The mesher is not re-entrant.
let _emit = new Uint16Array(0);
let _solid = new Uint8Array(0);
let _mask = new Int32Array(0);
let _sliceX = new Int32Array(0);
let _sliceY = new Int32Array(0);
let _sliceZ = new Int32Array(0);

/**
 * Meshes the cell box [minI, minI+sx) x [minJ, minJ+sy) x [minK, minK+sz).
 * Output is appended to `out` (call out.reset() first for a fresh mesh).
 */
export function meshRegion(
    world: VoxelWorld,
    mode: MeshMode,
    minI: number,
    minJ: number,
    minK: number,
    sx: number,
    sy: number,
    sz: number,
    out: MeshOutput,
    opts: MeshOptions = DEFAULT_MESH_OPTIONS
): void {
    const PX = sx + 2;
    const PY = sy + 2;
    const PZ = sz + 2;
    const total = PX * PY * PZ;
    if (_emit.length < total) {
        _emit = new Uint16Array(total);
        _solid = new Uint8Array(total);
    }
    const emit = _emit;
    const solid = _solid;
    const isStatic = mode === 'static';
    const bedrock = world.bedrock;

    // ---- fill padded occupancy, one chunk lookup per run of cells in the same chunk.
    // Per-slice emit counts let the face pass skip slices with nothing to emit.
    if (_sliceX.length < sx) _sliceX = new Int32Array(sx);
    if (_sliceY.length < sy) _sliceY = new Int32Array(sy);
    if (_sliceZ.length < sz) _sliceZ = new Int32Array(sz);
    _sliceX.fill(0, 0, sx);
    _sliceY.fill(0, 0, sy);
    _sliceZ.fill(0, 0, sz);
    let anyEmit = false;
    for (let z = 0; z < PZ; z++) {
        const k = minK - 1 + z;
        const cz = k >> CHUNK_BITS;
        const lz = k & CHUNK_MASK;
        for (let y = 0; y < PY; y++) {
            const j = minJ - 1 + y;
            const cy = j >> CHUNK_BITS;
            const ly = j & CHUNK_MASK;
            const inner = z > 0 && z < PZ - 1 && y > 0 && y < PY - 1;
            let base = PX * (y + PY * z);
            let curCx = 0x7fffffff;
            let stat: Uint16Array | null = null;
            let dyn: Uint16Array | null = null;
            for (let x = 0; x < PX; x++, base++) {
                const i = minI - 1 + x;
                const cx = i >> CHUNK_BITS;
                if (cx !== curCx) {
                    curCx = cx;
                    const c = world.getChunk(cx, cy, cz);
                    stat = c ? c.stat : null;
                    dyn = c ? c.dyn : null;
                }
                const li = localIndex(i & CHUNK_MASK, ly, lz);
                const s = stat ? stat[li] : 0;
                const d = dyn ? dyn[li] : 0;
                let e: number;
                let sol: number;
                if (isStatic) {
                    e = s !== 0 && d === 0 ? s : 0;
                    sol = s !== 0 ? 1 : 0;
                } else {
                    e = d;
                    sol = s !== 0 || d !== 0 ? 1 : 0;
                }
                if (sol === 0 && bedrock !== null) {
                    const bx = i - bedrock.minI;
                    const bz = k - bedrock.minK;
                    if (bx >= 0 && bz >= 0 && bx < bedrock.width && bz < bedrock.depth && j < bedrock.bottom[bx + bz * bedrock.width]) sol = 1;
                }
                const isInner = inner && x > 0 && x < PX - 1;
                emit[base] = isInner ? e : 0;
                solid[base] = sol;
                if (isInner && e !== 0) {
                    anyEmit = true;
                    _sliceX[x - 1]++;
                    _sliceY[y - 1]++;
                    _sliceZ[z - 1]++;
                }
            }
        }
    }
    if (!anyEmit) return;

    const S = [sx, sy, sz];
    const stride = [1, PX, PX * PY];
    const origin = [GRID_ORIGIN_X + GRID_SIZE * minI, GRID_ORIGIN_Y + GRID_SIZE * minJ, GRID_ORIGIN_Z + GRID_SIZE * minK];
    const greedy = opts.greedy;
    const useAo = opts.ao;

    for (let a = 0; a < 3; a++) {
        const u = (a + 1) % 3;
        const v = (a + 2) % 3;
        const Su = S[u];
        const Sv = S[v];
        const Sa = S[a];
        const sa = stride[a];
        const su = stride[u];
        const sv = stride[v];
        if (_mask.length < Su * Sv) _mask = new Int32Array(Su * Sv);
        const mask = _mask;

        const sliceCount = a === 0 ? _sliceX : a === 1 ? _sliceY : _sliceZ;
        for (let sign = 1; sign >= -1; sign -= 2) {
            const nOff = sign * sa;
            for (let t = 0; t < Sa; t++) {
                if (sliceCount[t] === 0) continue;
                // ---- build the face mask for this slice
                let any = false;
                for (let iv = 0; iv < Sv; iv++) {
                    for (let iu = 0; iu < Su; iu++) {
                        const c = (t + 1) * sa + (iu + 1) * su + (iv + 1) * sv;
                        const e = emit[c];
                        let key = 0;
                        if (e !== 0 && solid[c + nOff] === 0) {
                            let ao = 0xff;
                            if (useAo) {
                                const L = c + nOff;
                                const um = solid[L - su];
                                const up = solid[L + su];
                                const vm = solid[L - sv];
                                const vp = solid[L + sv];
                                const a0 = cornerAo(um, vm, solid[L - su - sv]);
                                const a1 = cornerAo(up, vm, solid[L + su - sv]);
                                const a2 = cornerAo(up, vp, solid[L + su + sv]);
                                const a3 = cornerAo(um, vp, solid[L - su + sv]);
                                ao = a0 | (a1 << 2) | (a2 << 4) | (a3 << 6);
                            }
                            key = e | (ao << 16);
                            any = true;
                        }
                        mask[iu + iv * Su] = key;
                    }
                }
                if (!any) continue;

                // ---- greedy merge
                const planeA = origin[a] + GRID_SIZE * (sign > 0 ? t + 1 : t);
                for (let iv = 0; iv < Sv; iv++) {
                    for (let iu = 0; iu < Su; ) {
                        const key = mask[iu + iv * Su];
                        if (key === 0) {
                            iu++;
                            continue;
                        }
                        let w = 1;
                        let h = 1;
                        if (greedy) {
                            while (iu + w < Su && mask[iu + w + iv * Su] === key) w++;
                            outer: while (iv + h < Sv) {
                                const row = (iv + h) * Su;
                                for (let q = 0; q < w; q++) {
                                    if (mask[iu + q + row] !== key) break outer;
                                }
                                h++;
                            }
                        }
                        for (let hh = 0; hh < h; hh++) {
                            const row = (iv + hh) * Su;
                            for (let q = 0; q < w; q++) mask[iu + q + row] = 0;
                        }
                        emitQuad(out, a, u, v, sign, planeA, origin[u] + GRID_SIZE * iu, origin[v] + GRID_SIZE * iv, w * GRID_SIZE, h * GRID_SIZE, key);
                        out.quads++;
                        out.faces += w * h;
                        iu += w;
                    }
                }
            }
        }
    }
}

function cornerAo(s1: number, s2: number, c: number): number {
    if (s1 && s2) return 0;
    return 3 - (s1 + s2 + c);
}

const _p = new Float64Array(12);

function emitQuad(out: MeshOutput, a: number, u: number, v: number, sign: number, pa: number, pu: number, pv: number, wu: number, hv: number, key: number): void {
    const value = key & 0xffff;
    const ao = (key >>> 16) & 0xff;
    const cls = out.classes[VALUE_SURFACE[value]];
    cls.ensure(4, 6);
    const base = cls.vertexCount;

    // corners: p0 (u-, v-), p1 (u+, v-), p2 (u+, v+), p3 (u-, v+)
    const us = [pu, pu + wu, pu + wu, pu];
    const vs = [pv, pv, pv + hv, pv + hv];
    for (let n = 0; n < 4; n++) {
        _p[n * 3 + a] = pa;
        _p[n * 3 + u] = us[n];
        _p[n * 3 + v] = vs[n];
    }
    const pos = cls.positions;
    const nrm = cls.normals;
    const col = cls.colors;
    const rgb = VALUE_RGB[value];
    const r = rgb & 255;
    const g = (rgb >> 8) & 255;
    const b = (rgb >> 16) & 255;
    const aos = [ao & 3, (ao >> 2) & 3, (ao >> 4) & 3, (ao >> 6) & 3];
    for (let n = 0; n < 4; n++) {
        const vi = base + n;
        pos[vi * 3] = _p[n * 3];
        pos[vi * 3 + 1] = _p[n * 3 + 1];
        pos[vi * 3 + 2] = _p[n * 3 + 2];
        nrm[vi * 3] = 0;
        nrm[vi * 3 + 1] = 0;
        nrm[vi * 3 + 2] = 0;
        nrm[vi * 3 + a] = sign;
        col[vi * 4] = r;
        col[vi * 4 + 1] = g;
        col[vi * 4 + 2] = b;
        col[vi * 4 + 3] = AO_LEVELS[aos[n]];
    }
    cls.vertexCount += 4;

    // u x v = +a, so (p0, p1, p2) is counter-clockwise seen from +a. Split along the diagonal that
    // avoids the most occluded corner pair (reduces AO interpolation anisotropy).
    const flip = aos[0] + aos[2] < aos[1] + aos[3];
    const idx = cls.indices;
    let o = cls.indexCount;
    if (!flip) {
        if (sign > 0) {
            idx[o++] = base;
            idx[o++] = base + 1;
            idx[o++] = base + 2;
            idx[o++] = base;
            idx[o++] = base + 2;
            idx[o++] = base + 3;
        } else {
            idx[o++] = base;
            idx[o++] = base + 2;
            idx[o++] = base + 1;
            idx[o++] = base;
            idx[o++] = base + 3;
            idx[o++] = base + 2;
        }
    } else {
        if (sign > 0) {
            idx[o++] = base + 1;
            idx[o++] = base + 2;
            idx[o++] = base + 3;
            idx[o++] = base + 1;
            idx[o++] = base + 3;
            idx[o++] = base;
        } else {
            idx[o++] = base + 1;
            idx[o++] = base + 3;
            idx[o++] = base + 2;
            idx[o++] = base + 1;
            idx[o++] = base;
            idx[o++] = base + 3;
        }
    }
    cls.indexCount = o;
}

/** Packs a chunk/region coordinate triple, re-exported for renderer bookkeeping. */
export { packChunkCoord };

/**
 * Meshes a large box as cubic sub-blocks (multiples of the chunk size), appending into `out` and
 * skipping sub-blocks whose chunks hold nothing for this mode. Faces are identical to meshing the
 * whole box; greedy merges stop at sub-block borders. Keeps big render units cheap to build.
 */
export function meshRegionBlocked(
    world: VoxelWorld,
    mode: MeshMode,
    minI: number,
    minJ: number,
    minK: number,
    sx: number,
    sy: number,
    sz: number,
    block: number,
    out: MeshOutput,
    opts: MeshOptions = DEFAULT_MESH_OPTIONS
): void {
    for (let bj = 0; bj < sy; bj += block) {
        for (let bk = 0; bk < sz; bk += block) {
            for (let bi = 0; bi < sx; bi += block) {
                const i0 = minI + bi;
                const j0 = minJ + bj;
                const k0 = minK + bk;
                const bx = Math.min(block, sx - bi);
                const by = Math.min(block, sy - bj);
                const bz = Math.min(block, sz - bk);
                let any = false;
                for (let cy = j0 >> CHUNK_BITS; !any && cy <= (j0 + by - 1) >> CHUNK_BITS; cy++)
                    for (let cz = k0 >> CHUNK_BITS; !any && cz <= (k0 + bz - 1) >> CHUNK_BITS; cz++)
                        for (let cx = i0 >> CHUNK_BITS; !any && cx <= (i0 + bx - 1) >> CHUNK_BITS; cx++) {
                            const c = world.getChunk(cx, cy, cz);
                            if (c && (mode === 'static' ? c.staticCount > 0 : c.dynCount > 0)) any = true;
                        }
                if (any) meshRegion(world, mode, i0, j0, k0, bx, by, bz, out, opts);
            }
        }
    }
}
