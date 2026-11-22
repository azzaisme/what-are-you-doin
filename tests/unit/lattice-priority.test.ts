import { describe, expect, it } from 'vitest';

import { assetTier } from '../../src/assets/cell-tier.ts';
import { createLabEntities } from '../../src/sim/lab-entities.ts';
import type { SimEntity } from '../../src/sim/lab-entities.ts';
import { STATE_STRIDE } from '../../src/workers/protocol.ts';
import { VoxelService } from '../../src/workers/voxel-service.ts';

// #107: objects on different lattices resolve by priority (priority desc, then id asc), as objects
// on one lattice always have. Unit tests run every lattice at one cell size (the size is fixed per
// process); the logic is the same at any size, and the browser test checks the real 1 cm lane.

const entities = createLabEntities().entities.filter((e) => e.asset.parts.length > 0);
const byName = (n: string) => entities.find((e) => e.name === n)!;
const beaver = byName('beaver'); // base, priority 3
const bucket = byName('bucket'); // fine, priority 4
const ute = byName('ute'); // coarse, priority 2
const head = byName('dummy-head'); // fine, priority 2

type Place = { e: SimEntity; x: number; y: number; z: number };

function states(places: Place[]): Float64Array {
    const s = new Float64Array(entities.length * STATE_STRIDE);
    for (const p of places) {
        const o = entities.indexOf(p.e) * STATE_STRIDE;
        s[o] = 1;
        s[o + 1] = p.x;
        s[o + 2] = p.y;
        s[o + 3] = p.z;
        s[o + 7] = 1;
    }
    return s;
}

/** A lattice drawing only `drawn`, given the states of every object. */
function lane(drawn: SimEntity[], places: Place[]) {
    const svc = new VoxelService(new Set(drawn.map((e) => e.id)));
    svc.build(1, 'yard', undefined, false);
    const r = svc.frame(1, 0, 'coverage50', false, states(places));
    return { svc, stats: r.stats };
}

const cells = (svc: VoxelService, e: SimEntity) => svc.world.objectCells(e.id);
/** Cells of `e` this lattice actually shows (its winner value in the composite). */
function shown(svc: VoxelService, e: SimEntity): number {
    let n = 0;
    const w = svc.world;
    for (const [key] of cells(svc, e)) {
        const c = w.chunks[key >>> 12];
        if (c.dyn && c.dyn[key & 4095] !== 0) n++;
    }
    return n;
}

describe('lattice priority (#107)', () => {
    it('the tiers this test relies on', () => {
        expect(assetTier(beaver.asset)).toBe('base');
        expect(assetTier(bucket.asset)).toBe('fine');
        expect(assetTier(ute.asset)).toBe('coarse');
        expect(assetTier(head.asset)).toBe('fine');
        expect(bucket.priority).toBeGreaterThan(beaver.priority);
        expect(beaver.priority).toBeGreaterThan(ute.priority);
    });

    it('a higher-priority object on another lattice empties the cells it shares with a lower one', () => {
        const apart = [
            { e: beaver, x: 0, y: 0, z: 0 },
            { e: bucket, x: 6, y: 0, z: 0 }
        ];
        const inside = [
            { e: beaver, x: 0, y: 0, z: 0 },
            { e: bucket, x: 0, y: 0.45, z: 0 }
        ];
        const a = lane([beaver], apart);
        const b = lane([beaver], inside);
        // the beaver rasterizes the same either way; the bucket takes some of its cells
        expect(cells(b.svc, beaver).size).toBe(cells(a.svc, beaver).size);
        expect(a.stats.latticeHidden).toBe(0);
        expect(b.stats.latticeHidden).toBeGreaterThan(5);
        expect(b.stats.latticeMasks).toBe(1);
        expect(Object.fromEntries(b.svc.world.latticeHiddenByObject())).toEqual({ [beaver.id]: b.stats.latticeHidden });
        expect(shown(b.svc, beaver)).toBe(cells(b.svc, beaver).size - b.stats.latticeHidden);
        // a frame where nothing moved keeps them hidden (and still reports them)
        const again = b.svc.frame(2, 0.05, 'coverage50', false, states(inside));
        expect(again.stats.latticeHidden).toBe(b.stats.latticeHidden);
        expect(again.stats.changedCells).toBe(0);
        // apart, nothing is taken and the bucket is not even rasterized here
        expect(a.stats.latticeMasks).toBe(0);
        expect(shown(a.svc, beaver)).toBe(cells(a.svc, beaver).size);
    }, 60_000);

    it('the winner keeps its cells: a lower-priority object on another lattice changes nothing', () => {
        const apart = lane(
            [bucket],
            [
                { e: bucket, x: 0, y: 0.45, z: 0 },
                { e: beaver, x: 6, y: 0, z: 0 }
            ]
        );
        const inside = lane(
            [bucket],
            [
                { e: bucket, x: 0, y: 0.45, z: 0 },
                { e: beaver, x: 0, y: 0, z: 0 }
            ]
        );
        expect(inside.stats.latticeHidden).toBe(0);
        expect(inside.svc.world.dynamicHash()).toBe(apart.svc.world.dynamicHash());
        expect(shown(inside.svc, bucket)).toBe(cells(inside.svc, bucket).size);
    }, 60_000);

    it('every lattice pair: coarse under base, fine under base, by priority', () => {
        // the beaver (3) outranks the ute (2): the coarse lattice gives way where the beaver stands in it
        const coarse = lane(
            [ute],
            [
                { e: ute, x: 0, y: 0, z: 0 },
                { e: beaver, x: 0, y: 0.6, z: 0 }
            ]
        );
        expect(coarse.stats.latticeHidden).toBeGreaterThan(0);
        // the beaver (3) outranks the ragdoll's head (2): the fine lattice gives way too
        const fine = lane(
            [head],
            [
                { e: head, x: 0, y: 0.5, z: 0 },
                { e: beaver, x: 0, y: 0, z: 0 }
            ]
        );
        expect(fine.stats.latticeHidden).toBeGreaterThan(0);
        // and the base lattice keeps the beaver there
        const base = lane(
            [beaver],
            [
                { e: head, x: 0, y: 0.5, z: 0 },
                { e: beaver, x: 0, y: 0, z: 0 }
            ]
        );
        expect(base.stats.latticeHidden).toBe(0);
    }, 60_000);

    it('cells come back when the winner moves away, and the result matches a fresh build', () => {
        const svc = new VoxelService(new Set([beaver.id]));
        svc.build(1, 'yard', undefined, false);
        const inside = [
            { e: beaver, x: 0, y: 0, z: 0 },
            { e: bucket, x: 0, y: 0.45, z: 0 }
        ];
        const apart = [
            { e: beaver, x: 0, y: 0, z: 0 },
            { e: bucket, x: 6, y: 0, z: 0 }
        ];
        svc.frame(1, 0, 'coverage50', false, states(inside));
        const back = svc.frame(2, 0.05, 'coverage50', false, states(apart));
        expect(back.stats.latticeHidden).toBe(0);
        expect(svc.world.dynamicHash()).toBe(lane([beaver], apart).svc.world.dynamicHash());
        // and again into the beaver: the same as a fresh build there
        svc.frame(3, 0.1, 'coverage50', false, states(inside));
        expect(svc.world.dynamicHash()).toBe(lane([beaver], inside).svc.world.dynamicHash());
        expect(svc.verifyGrid().misaligned).toBe(0);
    }, 60_000);

    it('one lattice for everything (?tiers=off) has no masks', () => {
        const all = lane(entities, [
            { e: beaver, x: 0, y: 0, z: 0 },
            { e: bucket, x: 0, y: 0.45, z: 0 }
        ]);
        expect(all.stats.latticeMasks).toBe(0);
        expect(all.stats.latticeHidden).toBe(0);
        // the overlap is resolved inside the one lattice instead
        expect(all.stats.dynDynOverlaps).toBeGreaterThan(0);
    }, 60_000);
});
