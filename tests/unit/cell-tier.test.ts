import { describe, expect, it } from 'vitest';

import { assetTier, tierCellCm } from '../../src/assets/cell-tier.ts';
import { createLabEntities } from '../../src/sim/lab-entities.ts';
import { GRID_SIZE, clampLatticeCm } from '../../src/voxels/grid.ts';
import { STATE_STRIDE } from '../../src/workers/protocol.ts';
import { VoxelService } from '../../src/workers/voxel-service.ts';

const entities = createLabEntities().entities;
const byName = (n: string) => entities.find((e) => e.name === n)!;

describe('per-item cell sizes', () => {
    it('small things are fine, big things coarse, the rest on the base grid', () => {
        expect(assetTier(byName('bucket').asset)).toBe('fine');
        expect(assetTier(byName('dummy-head').asset)).toBe('fine');
        expect(assetTier(byName('ute').asset)).toBe('coarse');
        for (const n of ['beaver', 'plank', 'log', 'cube', 'sphere', 'beam-0', 'dummy-body'])
            expect(assetTier(byName(n).asset), n).toBe('base');
    });

    it('lattice sizes: fine 1 cm, coarse twice the base up to 20 cm, far lattices up to 80 cm', () => {
        expect(tierCellCm('fine', 5)).toBe(1);
        expect(tierCellCm('base', 5)).toBe(5);
        expect(tierCellCm('coarse', 5)).toBe(10);
        expect(tierCellCm('coarse', 10)).toBe(20);
        expect(clampLatticeCm(1)).toBe(1);
        expect(clampLatticeCm(0.2)).toBe(1);
        expect(clampLatticeCm(40)).toBe(40);
        expect(clampLatticeCm(200)).toBe(80);
    });

    it('a lattice service draws only its own objects, and nothing beyond its reach', () => {
        const drawable = entities.filter((e) => e.asset.parts.length > 0);
        const bucket = byName('bucket');
        const svc = new VoxelService(new Set([bucket.id]));
        svc.build(1, 'yard', undefined, false);
        const states = new Float64Array(drawable.length * STATE_STRIDE);
        drawable.forEach((e, n) => {
            const o = n * STATE_STRIDE;
            states[o] = 1;
            states[o + 1] = n * 3; // spread out, all visible
            states[o + 7] = 1;
        });
        const r = svc.frame(1, 0, 'coverage50', false, states);
        expect(r.stats.objects).toBe(1);
        expect(r.stats.particles).toBe(0);
        expect(svc.world.dynamicCellCount()).toBeGreaterThan(0);
        // every vertex on this service's lattice
        expect(svc.verifyGrid().misaligned).toBe(0);
        // moved far beyond the lattice's chunk range: cleared, not a crash
        const n = drawable.indexOf(bucket);
        states[n * STATE_STRIDE + 1] = 1e6 * GRID_SIZE;
        const r2 = svc.frame(2, 0.05, 'coverage50', false, states);
        expect(r2.stats.objects).toBe(0);
        expect(svc.world.dynamicCellCount()).toBe(0);
    }, 60_000);
});
