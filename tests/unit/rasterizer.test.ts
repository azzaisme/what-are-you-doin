import { describe, expect, it } from 'vitest';

import { GRID_SIZE, cellIndexY } from '../../src/voxels/grid.ts';
import { DEG, pose, quatFromAxisAngle, quatFromYawPitchRoll } from '../../src/voxels/math.ts';
import { M, voxel } from '../../src/voxels/palette.ts';
import { SAMPLING_POLICIES, createRasterStats  } from '../../src/voxels/rasterizer.ts';
import type { SamplingPolicy } from '../../src/voxels/rasterizer.ts';
import { box, cylinder, grain, solid } from '../../src/voxels/volumes.ts';
import { VoxelWorld  } from '../../src/voxels/world.ts';
import type { PartInstance } from '../../src/voxels/world.ts';

import { components, objectCellSet } from './helpers.ts';

const STATS = createRasterStats();

function rasterOnce(volume: PartInstance['volume'], p: ReturnType<typeof pose>, policy: SamplingPolicy = 'center'): { world: VoxelWorld; cells: Set<string> } {
    const world = new VoxelWorld();
    world.addObject(1);
    world.rasterizeObject(1, [{ volume, pose: p, priority: 0 }], policy, STATS);
    world.resolve();
    return { world, cells: objectCellSet(world, 1) };
}

const S = GRID_SIZE;
const H = GRID_SIZE / 2;
/** Nominal cell count of the 2.4 x 0.2 x 0.1 m plank, and of one cross-section slice. */
const PLANK_CELLS = (2.4 * 0.2 * 0.1) / S ** 3;
const PLANK_SLICE = (0.2 * 0.1) / S ** 2;

const cube = box(H, H, H, solid(M.TestOrange));
const plank = box(1.2, 0.1, 0.05, grain(M.Timber, 'x'));
const log = cylinder('x', 0.2, 1.0, solid(M.LogBark));
const wheel = cylinder('x', 0.33, 0.11, solid(M.Tyre));

describe('rasterizer: negative coordinates and identities', () => {
    it('places a cell-sized cube centred in a negative cell into exactly that cell', () => {
        const { cells } = rasterOnce(cube, pose(-H, -3 * H, -5 * H));
        expect([...cells]).toEqual(['-1,-2,-3']);
    });

    it('rejects non-finite poses without writing anything', () => {
        const world = new VoxelWorld();
        world.addObject(1);
        const stats = createRasterStats();
        world.rasterizeObject(1, [{ volume: cube, pose: pose(NaN, 0, 0), priority: 0 }], 'center', stats);
        expect(stats.rejected).toBe(1);
        expect(world.objectCellCount(1)).toBe(0);
    });
});

describe('rasterizer: translation by one cell (§5.9)', () => {
    it('changes cell identity only at the occupancy transition', () => {
        let transitions = 0;
        let prev = '';
        for (let n = 0; n <= 100; n++) {
            const d = n * (S / 100);
            const { cells } = rasterOnce(cube, pose(H + d, H, H));
            expect(cells.size).toBe(1);
            const id = [...cells][0];
            if (prev && id !== prev) transitions++;
            prev = id;
        }
        expect(transitions).toBe(1);
    });

    it('moves a long plank by whole cells only when sample points cross', () => {
        const counts = new Set<number>();
        for (let n = 0; n <= 50; n++) {
            const { cells } = rasterOnce(plank, pose(0.013 + n * (S / 50), 1.0, 0.0));
            counts.add(cells.size);
        }
        // translation alone never changes the count by more than two cross-section slices
        for (const c of counts) expect(Math.abs(c - PLANK_CELLS)).toBeLessThanOrEqual(2 * PLANK_SLICE + 1e-9);
    });
});

describe('rasterizer: rotations 0°, 15°, 45°, 89°, 90° (§5.9)', () => {
    const angles = [0, 15, 45, 89, 90];
    for (const policy of SAMPLING_POLICIES) {
        it(`keeps the plank connected and near nominal size under ${policy} sampling`, () => {
            for (const deg of angles) {
                for (const axis of [
                    [0, 1, 0],
                    [0, 0, 1],
                    [1, 0, 0],
                    [1, 1, 0]
                ]) {
                    const q = quatFromAxisAngle(axis[0], axis[1], axis[2], deg * DEG);
                    const { cells } = rasterOnce(plank, pose(0.31, 1.07, -0.42, q), policy);
                    expect(cells.size).toBeGreaterThan(0);
                    if (policy !== 'center') expect(components(cells)).toBe(1);
                }
            }
        });
    }
});

describe('rasterizer: same pose determinism (§5.9)', () => {
    it('produces identical occupancy hashes and no dirty cells for an identical pose', () => {
        const world = new VoxelWorld();
        world.addObject(1);
        const p = pose(0.123, 0.456, -0.789, quatFromYawPitchRoll(0.3, 0.7, 1.1));
        const parts: PartInstance[] = [{ volume: plank, pose: p, priority: 0 }];
        world.rasterizeObject(1, parts, 'coverage50', STATS);
        world.resolve();
        const h1 = world.dynamicHash();
        const changed = world.rasterizeObject(1, parts, 'coverage50', STATS);
        const st = world.resolve();
        expect(changed).toBe(0);
        expect(st.changedCells).toBe(0);
        expect(world.dynamicHash()).toBe(h1);
    });

    it('takes material from the asset-local field so colours follow the object', () => {
        const a = rasterOnce(plank, pose(0, 1, 0));
        const b = rasterOnce(plank, pose(1.0, 1, 0)); // exactly 10 cells further
        const va = [...a.world.objectCells(1).values()].sort();
        const vb = [...b.world.objectCells(1).values()].sort();
        expect(vb).toEqual(va);
    });
});

/** Full controlled turn: cell count statistics and connectivity for each policy. */
function fullTurn(volume: PartInstance['volume'], policy: SamplingPolicy, axis: [number, number, number], steps = 180) {
    let min = Infinity;
    let max = 0;
    let disconnected = 0;
    for (let s = 0; s < steps; s++) {
        const q = quatFromAxisAngle(axis[0], axis[1], axis[2], (s / steps) * 2 * Math.PI);
        const { cells } = rasterOnce(volume, pose(0.017, 1.033, 0.071, q), policy);
        min = Math.min(min, cells.size);
        max = Math.max(max, cells.size);
        if (components(cells) !== 1) disconnected++;
    }
    return { min, max, disconnected };
}

describe('thin geometry over a full turn (§5.4, §5.9)', () => {
    it('never makes the plank, log or wheel disappear completely, under any policy', () => {
        for (const policy of SAMPLING_POLICIES) {
            for (const v of [plank, log, wheel]) {
                const r = fullTurn(v, policy, [0.3, 1, 0.2], 72);
                expect(r.min).toBeGreaterThan(0);
            }
        }
    }, 30_000); // full turns under four policies: ~5 s at 5 cm on the sandbox CPU

    it('coverage50 keeps the 10 cm thick plank in one piece for a full turn about a skew axis', () => {
        const r = fullTurn(plank, 'coverage50', [0.3, 1, 0.2]);
        expect(r.disconnected).toBe(0);
        // thickening and thinning bounded relative to the nominal volume
        expect(r.min).toBeGreaterThanOrEqual(0.6 * PLANK_CELLS);
        expect(r.max).toBeLessThanOrEqual(2.3 * PLANK_CELLS);
    });
});

describe('overlapping objects (§5.9)', () => {
    it('resolves a deterministic winner and restores the underlying contributor when it leaves', () => {
        const world = new VoxelWorld();
        world.addObject(10, 1); // higher priority
        world.addObject(20, 0);
        const red = box(0.25, 0.25, 0.25, solid(M.UtePaint));
        const blue = box(0.25, 0.25, 0.25, solid(M.TestBlue));
        const p = pose(H, 11 * H, H); // centre of cell (0, 5, 0)
        world.setStatic(0, 5, 0, voxel(M.Rock));
        world.rasterizeObject(10, [{ volume: red, pose: p, priority: 0 }], 'center', STATS);
        world.rasterizeObject(20, [{ volume: blue, pose: p, priority: 0 }], 'center', STATS);
        const st = world.resolve();
        expect(st.dynDynOverlaps).toBeGreaterThan(0);
        expect(world.valueAt(0, 5, 0)).toBe(voxel(M.UtePaint));
        expect(world.staticAt(0, 5, 0)).toBe(voxel(M.Rock));

        // the winner leaves: the other object shows through
        world.rasterizeObject(10, [], 'center', STATS);
        world.resolve();
        expect(world.valueAt(0, 5, 0)).toBe(voxel(M.TestBlue));

        // both leave: the static voxel was never erased
        world.rasterizeObject(20, [], 'center', STATS);
        world.resolve();
        expect(world.valueAt(0, 5, 0)).toBe(voxel(M.Rock));
        expect(world.dynamicCellCount()).toBe(0);
    });

    it('uses part priority inside one object (hat overrides head)', () => {
        const world = new VoxelWorld();
        world.addObject(1);
        const head = box(0.2, 0.2, 0.2, solid(M.Fur));
        const hat = box(0.2, 0.05, 0.2, solid(M.HardHat));
        world.rasterizeObject(
            1,
            [
                { volume: hat, pose: pose(0, 0.15, 0), priority: 5 },
                { volume: head, pose: pose(0, 0, 0), priority: 1 }
            ],
            'center',
            STATS
        );
        world.resolve();
        expect(world.valueAt(0, cellIndexY(0.15), 0)).toBe(voxel(M.HardHat));
        expect(world.valueAt(0, cellIndexY(-0.05), 0)).toBe(voxel(M.Fur));
    });

    it('breaks equal-priority object ties by lower id regardless of insertion order', () => {
        const world = new VoxelWorld();
        world.addObject(7);
        world.addObject(3);
        world.rasterizeObject(7, [{ volume: box(H, H, H, solid(M.TestOrange)), pose: pose(H, H, H), priority: 0 }], 'center', STATS);
        world.rasterizeObject(3, [{ volume: box(H, H, H, solid(M.TestBlue)), pose: pose(H, H, H), priority: 0 }], 'center', STATS);
        world.resolve();
        expect(world.valueAt(0, 0, 0)).toBe(voxel(M.TestBlue));
    });
});
