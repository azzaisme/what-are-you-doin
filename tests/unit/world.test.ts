import { describe, expect, it } from 'vitest';

import { GRID_SIZE } from '../../src/voxels/grid.ts';
import { pose, quatFromYawPitchRoll } from '../../src/voxels/math.ts';
import { M, voxel } from '../../src/voxels/palette.ts';
import { createRasterStats } from '../../src/voxels/rasterizer.ts';
import { box, cylinder, grain, solid } from '../../src/voxels/volumes.ts';
import { VoxelWorld } from '../../src/voxels/world.ts';

describe('VoxelWorld static layer', () => {
    it('never erases a static voxel when a dynamic object passes through', () => {
        const world = new VoxelWorld();
        for (let i = -5; i < 5; i++) world.setStatic(i, 0, 0, voxel(M.Grass, i & 3));
        world.addObject(1);
        const stats = createRasterStats();
        const v = box(0.15, 0.15, 0.15, solid(M.TestOrange));
        for (let n = 0; n < 100; n++) {
            world.rasterizeObject(
                1,
                [{ volume: v, pose: pose(-0.6 + n * 0.012, 0.05, 0.05), priority: 0 }],
                'center',
                stats
            );
            world.resolve();
        }
        world.rasterizeObject(1, [], 'center', stats);
        world.resolve();
        for (let i = -5; i < 5; i++) expect(world.valueAt(i, 0, 0)).toBe(voxel(M.Grass, i & 3));
        expect(world.dynStaticOverlapCells).toBe(0);
    });

    it('resolves static-static overlap by priority, keeping the first on ties', () => {
        const world = new VoxelWorld();
        world.setStatic(1, 1, 1, voxel(M.Dirt), 0);
        world.setStatic(1, 1, 1, voxel(M.Bark), 0);
        expect(world.staticAt(1, 1, 1)).toBe(voxel(M.Dirt));
        world.setStatic(1, 1, 1, voxel(M.Bark), 2);
        expect(world.staticAt(1, 1, 1)).toBe(voxel(M.Bark));
    });

    it('marks neighbouring chunks dirty when a border cell changes', () => {
        const world = new VoxelWorld();
        world.getOrCreateChunk(0, 0, 0);
        const left = world.getOrCreateChunk(-1, 0, 0);
        for (const c of world.chunks) c.dynDirty = false;
        world.addObject(1);
        const h = GRID_SIZE / 2;
        world.rasterizeObject(
            1,
            [{ volume: box(0.8 * h, 0.8 * h, 0.8 * h, solid(M.Rock)), pose: pose(h, h, h), priority: 0 }],
            'center',
            createRasterStats()
        );
        world.resolve();
        expect(left.dynDirty).toBe(true);
    });
});

describe('long run stability (§5.9)', () => {
    it('keeps chunk count, object cell counts and dirty sets bounded over thousands of voxel frames', () => {
        const world = new VoxelWorld();
        const stats = createRasterStats();
        const plank = box(1.2, 0.1, 0.05, grain(M.Timber, 'x'));
        const log = cylinder('x', 0.2, 1.0, solid(M.LogBark));
        world.addObject(1);
        world.addObject(2);
        let chunksAfterWarmup = 0;
        let maxCells = 0;
        // strictly periodic motion (period 200 voxel frames): after one period no new chunk may appear
        const PERIOD = 200;
        let hashAtPeriod = 0;
        for (let f = 0; f < 3000; f++) {
            const t = (2 * Math.PI * (f % PERIOD)) / PERIOD;
            const r = 2;
            world.rasterizeObject(
                1,
                [
                    {
                        volume: plank,
                        pose: pose(Math.cos(t) * r, 1, Math.sin(t) * r, quatFromYawPitchRoll(t, 2 * t, 3 * t)),
                        priority: 0
                    }
                ],
                'coverage50',
                stats
            );
            world.rasterizeObject(
                2,
                [{ volume: log, pose: pose(Math.sin(t) * r, 0.5, 0, quatFromYawPitchRoll(0, 0, t * 2)), priority: 0 }],
                'coverage50',
                stats
            );
            world.resolve();
            expect(world.pendingDirtyCells).toBe(0);
            maxCells = Math.max(maxCells, world.objectCellCount(1) + world.objectCellCount(2));
            if (f === PERIOD) {
                chunksAfterWarmup = world.chunkCount;
                hashAtPeriod = world.dynamicHash();
            }
            // the same pose an exact number of periods later reproduces the same composite
            if (f > PERIOD && f % PERIOD === 0) expect(world.dynamicHash()).toBe(hashAtPeriod);
        }
        expect(world.chunkCount).toBe(chunksAfterWarmup);
        expect(maxCells).toBeLessThan(2000 * (0.1 / GRID_SIZE) ** 3);
        expect(world.dynamicCellCount()).toBe(world.objectCellCount(1) + world.objectCellCount(2) - overlap(world));
    }, 120_000);
});

function overlap(world: VoxelWorld): number {
    const a = world.objectCells(1);
    let n = 0;
    for (const k of world.objectCells(2).keys()) if (a.has(k)) n++;
    return n;
}
