import { describe, expect, it } from 'vitest';

import {
    CHUNK_SIZE,
    GRID_SIZE,
    candidateCells,
    cellCenterX,
    cellIndexX,
    cellIndexY,
    chunkCoord,
    chunkLocal,
    clampCellSizeCm,
    createCellRange,
    packChunkCoord,
    rangeCellCount,
    unpackChunkCoord
} from '../../src/voxels/grid.ts';

const S = GRID_SIZE;
const H = GRID_SIZE / 2;

describe('grid coordinate contract (§5.1)', () => {
    it('uses a cell size inside the supported 5-10 cm range', () => {
        expect(GRID_SIZE).toBeGreaterThanOrEqual(0.05);
        expect(GRID_SIZE).toBeLessThanOrEqual(0.1);
        expect(clampCellSizeCm(0.5)).toBe(5);
        expect(clampCellSizeCm(37)).toBe(10);
        expect(clampCellSizeCm(7.3)).toBe(7.5);
        expect(clampCellSizeCm(NaN)).toBe(5);
    });

    it('uses floor, not truncation, for negative coordinates', () => {
        expect(cellIndexX(H)).toBe(0);
        expect(cellIndexX(-H)).toBe(-1);
        expect(cellIndexX(-S - 1e-9)).toBe(-2);
        expect(cellIndexY(-12.5 * S)).toBe(-13);
    });

    it('uses half-open cell bounds', () => {
        expect(cellIndexX(0)).toBe(0);
        expect(cellIndexX(S)).toBe(1);
        expect(cellIndexX(S - 1e-9)).toBe(0);
    });

    it('places cell centres between grid planes', () => {
        expect(cellCenterX(0)).toBeCloseTo(H, 12);
        expect(cellCenterX(-1)).toBeCloseTo(-H, 12);
        expect(cellIndexX(cellCenterX(-37))).toBe(-37);
    });

    it('splits negative cells into chunks without gaps or overlap', () => {
        const seen = new Map<string, number>();
        for (let i = -40; i < 40; i++) {
            const c = chunkCoord(i);
            const l = chunkLocal(i);
            expect(l).toBeGreaterThanOrEqual(0);
            expect(l).toBeLessThan(CHUNK_SIZE);
            expect(c * CHUNK_SIZE + l).toBe(i);
            const id = `${c}:${l}`;
            expect(seen.has(id)).toBe(false);
            seen.set(id, i);
        }
        expect(chunkCoord(-1)).toBe(-1);
        expect(chunkLocal(-1)).toBe(15);
    });

    it('round-trips packed chunk coordinates, including negatives, as small integers', () => {
        const out = { x: 0, y: 0, z: 0 };
        for (const [x, y, z] of [
            [0, 0, 0],
            [-1, -1, -1],
            [511, -512, 3],
            [-512, 511, -200]
        ]) {
            const key = packChunkCoord(x, y, z);
            expect(key).toBeLessThan(2 ** 30);
            unpackChunkCoord(key, out);
            expect(out).toEqual({ x, y, z });
        }
    });

    it('computes candidate ranges with floor(min) .. ceil(max)-1 and tolerance', () => {
        const r = createCellRange();
        expect(candidateCells(0, 0, 0, S, S, S, r)).toBe(true);
        // exact grid planes: tolerance widens outward by one cell on each side at most
        expect(r.minI).toBe(-1);
        expect(r.maxI).toBe(1);
        expect(candidateCells(0.2 * S, 0.2 * S, 0.2 * S, 0.8 * S, 0.8 * S, 0.8 * S, r)).toBe(true);
        expect([r.minI, r.maxI]).toEqual([0, 0]);
        expect(candidateCells(-2.5 * S, -0.1 * S, 3.1 * S, -1.1 * S, 0.1 * S, 3.9 * S, r)).toBe(true);
        expect([r.minI, r.maxI, r.minJ, r.maxJ, r.minK, r.maxK]).toEqual([-3, -2, -1, 0, 3, 3]);
    });

    it('rejects invalid or runaway bounds', () => {
        const r = createCellRange();
        expect(candidateCells(NaN, 0, 0, 1, 1, 1, r)).toBe(false);
        expect(rangeCellCount(r)).toBe(0);
        expect(candidateCells(0, 0, 0, Infinity, 1, 1, r)).toBe(false);
        expect(candidateCells(1, 0, 0, 0, 1, 1, r)).toBe(false);
        expect(candidateCells(0, 0, 0, 1e9, 1, 1, r)).toBe(false);
    });
});
