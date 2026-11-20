/**
 * The global world lattice (design doc §5.1).
 *
 * Metres, Y up. One fixed origin, one cell size, shared by every static and dynamic object.
 * Cell (i, j, k) spans the half-open box [O + s*i, O + s*(i+1)) on each axis. Indices are signed
 * integers computed with floor(), never truncation, so negative coordinates work.
 *
 * This module is pure data/math. It must not import the engine, so it can be shared with a future
 * server or worker.
 */

/**
 * Voxel cell size is a per-player visual quality setting (owner decision, 2026-11-19). Rendering is
 * never gameplay authority, so the reconstruction lattice may differ between players; gameplay
 * snapping is a separate, fixed grid (design doc §2.4). The size is read once at startup, before any
 * derived constant is computed; changing it means reloading.
 */
export const CELL_SIZE_MIN_CM = 5;
export const CELL_SIZE_MAX_CM = 10;
export const CELL_SIZE_DEFAULT_CM = 5;
export const CELL_SIZE_STORAGE_KEY = 'uncivil.cellSizeCm';

export function clampCellSizeCm(cm: number): number {
    if (!Number.isFinite(cm)) return CELL_SIZE_DEFAULT_CM;
    return Math.min(CELL_SIZE_MAX_CM, Math.max(CELL_SIZE_MIN_CM, Math.round(cm * 2) / 2));
}

function configuredCellSizeCm(): number {
    const g = globalThis as {
        __UE_CELL_CM__?: number;
        localStorage?: Pick<Storage, 'getItem'>;
        process?: { env?: Record<string, string | undefined> };
    };
    try {
        // set by the voxel worker before it imports any voxel module
        if (typeof g.__UE_CELL_CM__ === 'number') return clampCellSizeCm(g.__UE_CELL_CM__);
        const env = g.process?.env?.UE_CELL_CM;
        if (env) return clampCellSizeCm(Number(env));
        // '#cell75' = 7.5 cm (works where storage is blocked, e.g. sandboxed pages)
        const hash = (globalThis as { location?: { hash?: string } }).location?.hash ?? '';
        const m = /^#cell(\d{2,3})$/.exec(hash);
        if (m) return clampCellSizeCm(Number(m[1]) / 10);
        const stored = g.localStorage?.getItem(CELL_SIZE_STORAGE_KEY);
        if (stored) return clampCellSizeCm(Number(stored));
    } catch {
        // storage unavailable (sandboxed frame, private mode): use the default
    }
    return CELL_SIZE_DEFAULT_CM;
}

/** Cell edge length in metres for this session. Every other size derives from it. */
export const GRID_SIZE = configuredCellSizeCm() / 100;
export const INV_GRID_SIZE = 1 / GRID_SIZE;

/** Fixed world origin of the lattice for the first level. */
export const GRID_ORIGIN_X = 0;
export const GRID_ORIGIN_Y = 0;
export const GRID_ORIGIN_Z = 0;

/** Chunk edge in cells (Phase B, §5.5). 16^3 = 4096 cells per chunk. */
export const CHUNK_BITS = 4;
export const CHUNK_SIZE = 1 << CHUNK_BITS;
export const CHUNK_MASK = CHUNK_SIZE - 1;
export const CHUNK_VOLUME = CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE;

/**
 * Tolerance used when converting a continuous AABB to a candidate cell range. Widens the range so
 * that a bound lying within floating-point noise of a grid plane never drops a candidate. Extra
 * candidates are harmless: every candidate is still tested by sampling.
 */
export const BOUNDARY_EPSILON = 1e-6;

/** Largest absolute cell index accepted anywhere. ±2^20 cells = ±104 km. Guards runaway values. */
export const MAX_CELL_INDEX = 1 << 20;

/** Cell index on one axis for a world coordinate. Uses floor so -0.05 m is cell -1. */
export function cellIndex1(world: number, origin: number): number {
    return Math.floor((world - origin) * INV_GRID_SIZE);
}

export function cellIndexX(x: number): number {
    return cellIndex1(x, GRID_ORIGIN_X);
}
export function cellIndexY(y: number): number {
    return cellIndex1(y, GRID_ORIGIN_Y);
}
export function cellIndexZ(z: number): number {
    return cellIndex1(z, GRID_ORIGIN_Z);
}

/** World coordinate of the minimum corner of a cell on one axis. */
export function cellMin1(index: number, origin: number): number {
    return origin + GRID_SIZE * index;
}

/** World coordinate of the centre of a cell on one axis. */
export function cellCenter1(index: number, origin: number): number {
    return origin + GRID_SIZE * (index + 0.5);
}

export function cellCenterX(i: number): number {
    return cellCenter1(i, GRID_ORIGIN_X);
}
export function cellCenterY(j: number): number {
    return cellCenter1(j, GRID_ORIGIN_Y);
}
export function cellCenterZ(k: number): number {
    return cellCenter1(k, GRID_ORIGIN_Z);
}

/** Inclusive integer cell range [min, max] on three axes. Empty when any max < min. */
export interface CellRange {
    minI: number;
    minJ: number;
    minK: number;
    maxI: number;
    maxJ: number;
    maxK: number;
}

export function createCellRange(): CellRange {
    return { minI: 0, minJ: 0, minK: 0, maxI: -1, maxJ: -1, maxK: -1 };
}

/**
 * Candidate cell range for one axis of a continuous interval [lo, hi], following §5.3 step 2:
 * floor(min) .. ceil(max) - 1, with the explicit boundary tolerance applied outward.
 */
export function candidateMin1(lo: number, origin: number): number {
    return Math.floor((lo - origin) * INV_GRID_SIZE - BOUNDARY_EPSILON);
}

export function candidateMax1(hi: number, origin: number): number {
    return Math.ceil((hi - origin) * INV_GRID_SIZE + BOUNDARY_EPSILON) - 1;
}

/**
 * Converts a world AABB to the candidate cells whose boxes may intersect it. Returns false (and
 * leaves an empty range) when the AABB is invalid: non-finite, inverted or beyond the guard.
 */
export function candidateCells(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
    out: CellRange
): boolean {
    out.minI = 0;
    out.minJ = 0;
    out.minK = 0;
    out.maxI = -1;
    out.maxJ = -1;
    out.maxK = -1;
    if (
        !Number.isFinite(minX) ||
        !Number.isFinite(minY) ||
        !Number.isFinite(minZ) ||
        !Number.isFinite(maxX) ||
        !Number.isFinite(maxY) ||
        !Number.isFinite(maxZ)
    ) {
        return false;
    }
    if (maxX < minX || maxY < minY || maxZ < minZ) return false;
    const minI = candidateMin1(minX, GRID_ORIGIN_X);
    const minJ = candidateMin1(minY, GRID_ORIGIN_Y);
    const minK = candidateMin1(minZ, GRID_ORIGIN_Z);
    const maxI = candidateMax1(maxX, GRID_ORIGIN_X);
    const maxJ = candidateMax1(maxY, GRID_ORIGIN_Y);
    const maxK = candidateMax1(maxZ, GRID_ORIGIN_Z);
    if (
        Math.abs(minI) > MAX_CELL_INDEX ||
        Math.abs(minJ) > MAX_CELL_INDEX ||
        Math.abs(minK) > MAX_CELL_INDEX ||
        Math.abs(maxI) > MAX_CELL_INDEX ||
        Math.abs(maxJ) > MAX_CELL_INDEX ||
        Math.abs(maxK) > MAX_CELL_INDEX
    ) {
        return false;
    }
    out.minI = minI;
    out.minJ = minJ;
    out.minK = minK;
    out.maxI = maxI;
    out.maxJ = maxJ;
    out.maxK = maxK;
    return true;
}

export function rangeCellCount(r: CellRange): number {
    if (r.maxI < r.minI || r.maxJ < r.minJ || r.maxK < r.minK) return 0;
    return (r.maxI - r.minI + 1) * (r.maxJ - r.minJ + 1) * (r.maxK - r.minK + 1);
}

/** Chunk coordinate containing a cell index (floor division by CHUNK_SIZE, negatives included). */
export function chunkCoord(cell: number): number {
    return cell >> CHUNK_BITS;
}

/** Local index of a cell inside its chunk, 0..CHUNK_SIZE-1, negatives included. */
export function chunkLocal(cell: number): number {
    return cell & CHUNK_MASK;
}

/** Linear index of a local cell inside a chunk array. x fastest, then z, then y. */
export function localIndex(lx: number, ly: number, lz: number): number {
    return lx + (lz << CHUNK_BITS) + (ly << (2 * CHUNK_BITS));
}

/**
 * Chunk coordinates are packed into a small integer: 10 bits per axis (±512 chunks = ±819 m).
 * Values stay below 2^30 so V8 keeps them as small integers (no heap numbers in hot maps).
 */
export const CHUNK_COORD_BITS = 10;
export const CHUNK_COORD_OFFSET = 1 << (CHUNK_COORD_BITS - 1);
export const CHUNK_COORD_LIMIT = CHUNK_COORD_OFFSET;

export function chunkCoordInRange(c: number): boolean {
    return c >= -CHUNK_COORD_LIMIT && c < CHUNK_COORD_LIMIT;
}

export function packChunkCoord(cx: number, cy: number, cz: number): number {
    return (
        (((cy + CHUNK_COORD_OFFSET) << (2 * CHUNK_COORD_BITS)) |
            ((cz + CHUNK_COORD_OFFSET) << CHUNK_COORD_BITS) |
            (cx + CHUNK_COORD_OFFSET)) >>>
        0
    );
}

export function unpackChunkCoord(key: number, out: { x: number; y: number; z: number }): void {
    const m = (1 << CHUNK_COORD_BITS) - 1;
    out.x = (key & m) - CHUNK_COORD_OFFSET;
    out.z = ((key >>> CHUNK_COORD_BITS) & m) - CHUNK_COORD_OFFSET;
    out.y = ((key >>> (2 * CHUNK_COORD_BITS)) & m) - CHUNK_COORD_OFFSET;
}
