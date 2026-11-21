import { beforeAll, describe, expect, it } from 'vitest';

import { terrainHeight } from '../../src/levels/river-lab.ts';
import { runDropTest } from '../../src/sim/drop-test.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { GRID_SIZE } from '../../src/voxels/grid.ts';

beforeAll(() => initPhysics());

// capture every 6 ticks (10 Hz) for 3 s after the drop
const TICKS = Array.from({ length: 31 }, (_, i) => i * 6);

describe('scripted physics drop test (Epic 2 gate)', () => {
    it('is deterministic: the same drop gives identical poses and identical voxel cells', () => {
        const a = runDropTest(TICKS);
        const b = runDropTest(TICKS);
        expect(b.map((f) => f.hash)).toEqual(a.map((f) => f.hash));
        expect(b.map((f) => f.pose)).toEqual(a.map((f) => f.pose));
    });

    it('falls, tumbles through several rotations, and comes to rest on the bank', () => {
        const f = runDropTest(TICKS);
        const first = f[0];
        const end = f[f.length - 1];
        expect(first.pose.p.y - end.pose.p.y).toBeGreaterThan(2);
        // the plank turns through a wide range of orientations while falling
        const angles = f.map((x) => x.angle);
        expect(Math.max(...angles)).toBeGreaterThan(1.5);
        expect(new Set(angles.map((a) => Math.round(a * 4))).size).toBeGreaterThan(5);
        // at rest: above the ground, not sinking
        expect(end.pose.p.y).toBeGreaterThan(terrainHeight(end.pose.p.x, end.pose.p.z) - 0.02);
        expect(end.pose.p.y).toBeLessThan(terrainHeight(end.pose.p.x, end.pose.p.z) + 0.35);
    });

    it('voxel output: stepped silhouettes change with rotation, the plank never vanishes, rest is stable', () => {
        const f = runDropTest(TICKS);
        // 2.4 x 0.2 x 0.1 m in cells
        const volumeCells = (2.4 * 0.2 * 0.1) / GRID_SIZE ** 3;
        for (const x of f) {
            expect(x.cells.length).toBeGreaterThan(volumeCells * 0.5);
            expect(x.cells.length).toBeLessThan(volumeCells * 3.5);
            for (const c of x.cells) for (const v of c) expect(Number.isInteger(v)).toBe(true);
        }
        // while falling, almost every capture is a different set of cells
        const falling = f.slice(0, 12);
        expect(new Set(falling.map((x) => x.hash)).size).toBeGreaterThanOrEqual(falling.length - 1);
        // the last captures are asleep on the bank: identical cells, no flicker at rest
        const tail = f.slice(-4).map((x) => x.hash);
        expect(new Set(tail).size).toBe(1);
    });
});
