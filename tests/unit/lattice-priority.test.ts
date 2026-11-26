import { beforeAll, describe, expect, it, vi } from 'vitest';

import { realBucketCarry } from '../../scripts/lattice-scenes.ts';
import type { CarryScene } from '../../scripts/lattice-scenes.ts';
import { assetTier } from '../../src/assets/cell-tier.ts';
import { combineLaneStats } from '../../src/render/voxel-pipeline.ts';
import { createLabEntities } from '../../src/sim/lab-entities.ts';
import type { SimEntity } from '../../src/sim/lab-entities.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { ANIM_MAX } from '../../src/sim/snapshots.ts';
import { CHUNK_BITS, CHUNK_MASK, cellCenterX, cellCenterY, cellCenterZ } from '../../src/voxels/grid.ts';
import { invertRigidMat34, mat34, pose, poseToMat34 } from '../../src/voxels/math.ts';
import { STATE_STRIDE } from '../../src/workers/protocol.ts';
import type { FrameStats, FromWorker, ToWorker } from '../../src/workers/protocol.ts';
import { MASK_BUDGET, VoxelService } from '../../src/workers/voxel-service.ts';

// #107: objects on different lattices resolve by priority (priority desc, then id asc), as objects
// on one lattice always have. Unit tests run every lattice at one cell size (the size is fixed per
// process); the logic is the same at any size, and the browser test checks the real 1 cm lane.

const entities = createLabEntities().entities.filter((e) => e.asset.parts.length > 0);
/** Player 1 carrying the bucket in first person, from a real grab (looking 0.4 rad down). */
let carry: CarryScene;
beforeAll(async () => {
    await initPhysics();
    carry = realBucketCarry(-0.4);
});
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

    it('the winner takes exactly the cells whose centres lie inside it', () => {
        // the bucket sunk into the beaver's chest: every beaver cell whose centre is inside a bucket
        // part (wall, handle, bottom, water) is hidden, and no other
        const at = { x: 0.1, y: 0.4, z: 0.05 };
        const b = lane(
            [beaver],
            [
                { e: beaver, x: 0, y: 0, z: 0 },
                { e: bucket, ...at }
            ]
        );
        const root = pose();
        root.p.x = at.x;
        root.p.y = at.y;
        root.p.z = at.z;
        const poses = bucket.asset.parts.map(() => pose());
        bucket.asset.evaluate(root, new Float64Array(ANIM_MAX), poses);
        const inv = poses.map((p) => invertRigidMat34(poseToMat34(p, mat34()), mat34()));
        const w = b.svc.world;
        let inside = 0;
        for (const [key] of w.objectCells(beaver.id)) {
            const c = w.chunks[key >>> 12];
            const li = key & 4095;
            const i = c.cx * 16 + (li & CHUNK_MASK);
            const k = c.cz * 16 + ((li >> CHUNK_BITS) & CHUNK_MASK);
            const j = c.cy * 16 + (li >> (2 * CHUNK_BITS));
            const x = cellCenterX(i);
            const y = cellCenterY(j);
            const z = cellCenterZ(k);
            const hit = bucket.asset.parts.some((part, n) => {
                const m = inv[n];
                const lx = m[0] * x + m[1] * y + m[2] * z + m[3];
                const ly = m[4] * x + m[5] * y + m[6] * z + m[7];
                const lz = m[8] * x + m[9] * y + m[10] * z + m[11];
                return part.volume.sample(lx, ly, lz) !== 0;
            });
            if (hit) inside++;
        }
        expect(inside).toBeGreaterThan(10);
        expect(b.stats.latticeHidden).toBe(inside);
        expect(b.stats.maskRejected).toBe(0);
    }, 60_000);

    it('your own first-person limbs win ties: other players do not cut holes in them', () => {
        const fp = byName('fp-body'); // fine (its own lane), priority 3, like every beaver
        const avatar = byName('avatar-1'); // base, priority 3, a lower id
        const both = [
            { e: fp, x: 0, y: 0, z: 0 },
            { e: avatar, x: 0.1, y: 0, z: 0 }
        ];
        const own = lane([fp], both);
        expect(own.stats.latticeHidden).toBe(0);
        // and on the base lattice the other player's beaver gives way to them instead
        expect(lane([avatar], both).stats.latticeHidden).toBeGreaterThan(0);
    }, 60_000);

    it('the budget: masks over it are skipped this frame, the highest priority first served', () => {
        // the ragdoll's head inside the beaver, the bucket and an avatar: three masks on its lattice
        const places = [
            { e: head, x: 0, y: 0.5, z: 0 },
            { e: beaver, x: 0, y: 0, z: 0 },
            { e: bucket, x: 0, y: 0.45, z: 0.05 },
            { e: byName('avatar-2'), x: 0.05, y: 0, z: 0 }
        ];
        const all = lane([head], places);
        expect(all.stats.latticeMasks).toBe(3);
        expect(all.stats.maskSkipped).toBe(0);
        // a budget the bucket's mask fits in, but not the beavers' as well
        const svc = new VoxelService(new Set([head.id]));
        svc.build(1, 'yard', undefined, false);
        svc.maskOwnBudget = false; // the budget exactly as set (not raised to the head's own cells)
        svc.maskBudget = all.stats.maskCells - 1;
        const r = svc.frame(1, 0, 'coverage50', false, states(places));
        expect(r.stats.maskCells).toBeLessThanOrEqual(svc.maskBudget);
        expect(r.stats.maskSkipped).toBeGreaterThan(0);
        expect(r.stats.latticeMasks + r.stats.maskSkipped).toBe(3);
        // the bucket (priority 4) is served first
        expect(svc.world.objectCellCount(bucket.id)).toBeGreaterThan(0);
        // nothing at all fits: every mask skipped, nothing hidden, as before #107
        svc.maskBudget = 0;
        const none = svc.frame(2, 0.05, 'coverage50', false, states(places));
        expect(none.stats.latticeMasks).toBe(0);
        expect(none.stats.maskSkipped).toBe(3);
        expect(none.stats.latticeHidden).toBe(0);
    }, 60_000);

    it('masks off (?masks=off) leaves every object on other lattices out', () => {
        const svc = new VoxelService(new Set([beaver.id]), false);
        svc.build(1, 'yard', undefined, false);
        const r = svc.frame(
            1,
            0,
            'coverage50',
            false,
            states([
                { e: beaver, x: 0, y: 0, z: 0 },
                { e: bucket, x: 0, y: 0.45, z: 0 }
            ])
        );
        expect(r.stats.latticeMasks).toBe(0);
        expect(r.stats.latticeHidden).toBe(0);
    }, 60_000);

    it('at 1 cm, through the real worker: crowded scenes stay within the budget', async () => {
        // the worker module at the fine lattice's size, with a stand-in for its global scope
        const replies: FromWorker[] = [];
        const scope = {
            postMessage: (m: FromWorker) => replies.push(m),
            onmessage: null as null | ((e: { data: ToWorker }) => unknown)
        };
        vi.stubGlobal('self', scope);
        const run = async (
            draws: string[],
            places: [string, number, number, number][],
            extra: Record<string, { q?: { x: number; y: number; z: number; w: number }; anim?: ArrayLike<number> }> = {}
        ) => {
            vi.resetModules();
            replies.length = 0;
            await import('../../src/workers/voxel-worker.ts');
            const ids = draws.map((n) => byName(n).id);
            await scope.onmessage!({
                data: { type: 'init', cellCm: 1, seed: 1, level: 'yard', objects: ids, world: false }
            });
            expect(replies.some((r) => r.type === 'ready')).toBe(true);
            const stats: FrameStats[] = [];
            for (let f = 0; f < 6; f++) {
                replies.length = 0;
                const st = new Float64Array(entities.length * STATE_STRIDE);
                for (const [n, x, y, z] of places) {
                    const o = entities.indexOf(byName(n)) * STATE_STRIDE;
                    st[o] = 1;
                    st[o + 1] = x + f * 0.004;
                    st[o + 2] = y;
                    st[o + 3] = z;
                    const q = extra[n]?.q ?? { x: 0, y: 0, z: 0, w: 1 };
                    st[o + 4] = q.x;
                    st[o + 5] = q.y;
                    st[o + 6] = q.z;
                    st[o + 7] = q.w;
                    const anim = extra[n]?.anim ?? [];
                    for (let c = 0; c < anim.length; c++) st[o + 8 + c] = anim[c];
                }
                await scope.onmessage!({
                    data: { type: 'frame', frame: f, time: f / 20, policy: 'coverage50', reference: false, states: st }
                });
                const fr = replies.find((r) => r.type === 'frame');
                if (fr?.type === 'frame') stats.push(fr.stats);
            }
            expect(stats.length).toBe(6);
            return stats;
        };
        try {
            // your limbs carrying the bucket from a real grab (scripts/lattice-scenes.ts, as
            // hands.test grabs it), three avatars 0.55 m away (bench-lattice)
            const c = carry;
            const b = c.body.p;
            const fp = await run(
                ['fp-body'],
                [
                    ['fp-body', b.x, b.y, b.z],
                    ['bucket', c.bucket.p.x, c.bucket.p.y, c.bucket.p.z],
                    ['avatar-1', b.x + 0.55, b.y, b.z],
                    ['avatar-2', b.x - 0.55, b.y, b.z],
                    ['avatar-3', b.x, b.y, b.z + 0.55]
                ],
                { 'fp-body': { q: c.body.q, anim: c.anim }, bucket: { q: c.bucket.q } }
            );
            for (const s of fp) {
                expect(s.maskLimit).toBeGreaterThanOrEqual(MASK_BUDGET);
                expect(s.maskCells).toBeLessThanOrEqual(s.maskLimit);
                expect(s.latticeMasks).toBe(1); // the bucket; the avatars tie and lose
                expect(s.maskSkipped).toBe(0);
                expect(s.maskRejected).toBe(0);
            }
            // the ragdoll's head with the beaver and four avatars around it
            const crowd = await run(
                ['dummy-head'],
                [
                    ['dummy-head', 0, 0.5, 0],
                    ['beaver', 0, 0, 0],
                    ['avatar-0', 0.35, 0, 0],
                    ['avatar-1', -0.35, 0, 0],
                    ['avatar-2', 0, 0, 0.35],
                    ['avatar-3', 0, 0, -0.35]
                ]
            );
            for (const s of crowd) {
                expect(s.maskLimit).toBeGreaterThanOrEqual(MASK_BUDGET);
                expect(s.maskCells).toBeLessThanOrEqual(s.maskLimit);
                expect(s.latticeMasks + s.maskSkipped).toBe(5);
                expect(s.maskSkipped).toBeGreaterThan(0);
                expect(s.maskRejected).toBe(0);
            }
        } finally {
            vi.unstubAllGlobals();
            vi.resetModules();
            delete (globalThis as { __UE_CELL_CM__?: number }).__UE_CELL_CM__;
        }
    }, 300_000);
    it('a mask part posed out of bounds is rejected and counted, that frame only', () => {
        // the beaver beside the ragdoll's head; a NaN in one animation channel breaks some of its
        // parts' poses (not its body), a NaN in channel 0 every part's
        const svc = new VoxelService(new Set([head.id]));
        svc.build(1, 'yard', undefined, false);
        const places = [
            { e: head, x: 0, y: 0.5, z: 0 },
            { e: beaver, x: 0, y: 0.3, z: 0 }
        ];
        const ok = svc.frame(1, 0, 'coverage50', false, states(places)).stats;
        expect(ok.latticeMasks).toBe(1);
        expect(ok.maskRejected).toBe(0);
        const hidden = ok.latticeHidden;
        expect(hidden).toBeGreaterThan(0);
        const broken = (c: number) => {
            const s = states(places);
            s[entities.indexOf(beaver) * STATE_STRIDE + 8 + c] = NaN;
            return s;
        };
        const some = svc.frame(2, 0.05, 'coverage50', false, broken(4)).stats;
        expect(some.maskRejected).toBeGreaterThan(0);
        expect(some.maskRejected).toBeLessThan(beaver.asset.parts.length);
        expect(some.latticeMasks).toBe(1); // the rest of it still masks
        expect(svc.frame(3, 0.1, 'coverage50', false, states(places)).stats.maskRejected).toBe(0);
        const all = svc.frame(4, 0.15, 'coverage50', false, broken(0)).stats;
        expect(all.maskRejected).toBe(beaver.asset.parts.length);
        expect(all.latticeMasks).toBe(0);
        expect(all.latticeHidden).toBe(0);
        const back = svc.frame(5, 0.2, 'coverage50', false, states(places)).stats;
        expect(back.maskRejected).toBe(0);
        expect(back.latticeHidden).toBe(hidden);
    }, 60_000);

    /** The 1 cm service module (cell size fixed per module load), with the real fine lane's draws. */
    async function fineService() {
        vi.resetModules();
        (globalThis as { __UE_CELL_CM__?: number }).__UE_CELL_CM__ = 1;
        const grid = await import('../../src/voxels/grid.ts');
        expect(grid.GRID_SIZE).toBe(0.01);
        const mod = await import('../../src/workers/voxel-service.ts');
        // the real fine lane (main.ts): every fine-tier object but your limbs, which have their own
        const fine = entities.filter((e) => assetTier(e.asset) === 'fine' && e.name !== 'fp-body');
        const make = (preset: 'high' | 'low' = 'high') => {
            const svc = new mod.VoxelService(new Set(fine.map((e) => e.id)));
            svc.build(1, 'yard', undefined, false);
            svc.setMaskPreset(preset);
            return svc;
        };
        return { mod, make, fine };
    }
    const fineDone = () => {
        delete (globalThis as { __UE_CELL_CM__?: number }).__UE_CELL_CM__;
        vi.resetModules();
    };
    // the ragdoll standing at the origin (scripts/bench-lattice.ts RAGDOLL)
    const RAGDOLL: Place[] = [
        { e: byName('dummy-body'), x: 0, y: 0.62, z: 0 },
        { e: byName('dummy-head'), x: 0, y: 1.08, z: 0.02 },
        { e: byName('dummy-armL'), x: 0.27, y: 0.72, z: 0 },
        { e: byName('dummy-armR'), x: -0.27, y: 0.72, z: 0 },
        { e: byName('dummy-legL'), x: 0.11, y: 0.16, z: 0 },
        { e: byName('dummy-legR'), x: -0.11, y: 0.16, z: 0 },
        { e: byName('dummy-tail'), x: 0, y: 0.36, z: -0.36 }
    ];
    /** A frame's mask work without forced clears (those are outside the budget, see clearMask). */
    const work = (svc: VoxelService) => svc.maskStats.cells - svc.maskStats.clears;

    it("at 1 cm, High, the real fine lane: a frame's mask work never exceeds its limit, abandoned attempts included", async () => {
        try {
            const { mod, make } = await fineService();
            const svc = make('high');
            let abandoned = 0;
            let ranMasks = 0;
            let f = 0;
            // the beaver from above the ragdoll down into it, 1 cm a frame, with a 2 mm jitter
            for (let y = 0.9; y >= 0; y -= 0.01, f++) {
                const s = svc.frame(
                    f,
                    f / 20,
                    'coverage50',
                    false,
                    states([...RAGDOLL, { e: beaver, x: f % 2 ? 0.002 : 0, y, z: 0 }])
                ).stats;
                expect(s.maskLimit).toBeLessThanOrEqual(mod.MASK_CAP_HIGH);
                expect(work(svc), `y ${y.toFixed(2)}`).toBeLessThanOrEqual(s.maskLimit);
                if (s.maskSkipped > 0 && svc.maskStats.scanned > 0) abandoned++;
                ranMasks += s.latticeMasks;
            }
            // the guard was exercised: attempts were stopped part-way
            expect(abandoned).toBeGreaterThan(0);
            expect(ranMasks).toBeGreaterThanOrEqual(0);
        } finally {
            fineDone();
        }
    }, 300_000);

    it('at 1 cm: a mask the budget stops is cleared and waits MASK_BACKOFF frames before it is tried again', async () => {
        try {
            const { mod } = await fineService();
            // the head alone on its lattice, the beaver touching it from above: it fits and masks
            const svc = new mod.VoxelService(new Set([head.id]));
            svc.build(1, 'yard', undefined, false);
            const at = (y: number) =>
                states([
                    { e: head, x: 0, y: 0.5, z: 0 },
                    { e: beaver, x: 0, y, z: 0 }
                ]);
            let f = 0;
            let s = svc.frame(f++, 0, 'coverage50', false, at(0.78)).stats;
            for (let n = 0; n < 3; n++) s = svc.frame(f++, 0, 'coverage50', false, at(0.78)).stats;
            expect(s.latticeMasks).toBe(1);
            expect(s.latticeHidden).toBeGreaterThan(0);
            // then deep inside: estimated from last frame, tried, stopped by the budget, cleared
            s = svc.frame(f++, 0, 'coverage50', false, at(0)).stats;
            expect(svc.maskStats.scanned).toBeGreaterThan(0);
            expect(s.latticeMasks).toBe(0);
            expect(s.maskSkipped).toBe(1);
            expect(work(svc)).toBeLessThanOrEqual(s.maskLimit);
            expect(svc.world.objectCellCount(beaver.id)).toBe(0);
            expect(s.latticeHidden).toBe(0);
            expect(svc.maskStats.clears).toBeGreaterThan(0); // remeshing what it hid, counted
            // it waits: no work for MASK_BACKOFF - 1 frames, then one more try
            for (let n = 1; n < mod.MASK_BACKOFF; n++) {
                s = svc.frame(f++, 0, 'coverage50', false, at(0)).stats;
                expect(svc.maskStats.scanned, `frame ${n} of the wait`).toBe(0);
                expect(s.maskSkipped).toBe(1);
            }
            svc.frame(f++, 0, 'coverage50', false, at(0));
            expect(svc.maskStats.scanned).toBeGreaterThan(0);
        } finally {
            fineDone();
        }
    }, 300_000);

    it('at 1 cm, hysteresis: a new mask starts only within 80 % of the budget; one that ran may use all of it', async () => {
        try {
            const { mod } = await fineService();
            const at = states([
                { e: head, x: 0, y: 0.5, z: 0 },
                { e: beaver, x: 0, y: 0.78, z: 0 }
            ]);
            const service = () => {
                const svc = new mod.VoxelService(new Set([head.id]));
                svc.build(1, 'yard', undefined, false);
                svc.maskOwnBudget = false;
                return svc;
            };
            const pin = (svc: VoxelService, x: number) => {
                svc.maskBudget = x;
                svc.maskCap = x;
            };
            // running, with room to spare: its work W
            const run = service();
            pin(run, 1e9);
            for (let f = 0; f < 3; f++) run.frame(f, 0, 'coverage50', false, at);
            const w = work(run);
            expect(w).toBeGreaterThan(0);
            // the budget brought down so W is over 80 % of it: having run, it keeps running
            pin(run, Math.ceil(w / 0.9));
            for (let f = 3; f < 13; f++) {
                const s = run.frame(f, 0, 'coverage50', false, at).stats;
                expect(s.latticeMasks, `frame ${f}`).toBe(1);
                expect(work(run)).toBeLessThanOrEqual(s.maskLimit);
            }
            // a new one whose certain cost (the scan) is over 80 % of the budget does not start
            const fresh = service();
            const held =
                fresh.frame(0, 0, 'coverage50', false, states([{ e: head, x: 0, y: 0.5, z: 0 }])) &&
                fresh.world.objectCellCount(head.id);
            pin(fresh, Math.floor(held / 0.9));
            const s = fresh.frame(1, 0, 'coverage50', false, at).stats;
            expect(s.maskSkipped).toBe(1);
            expect(fresh.maskStats.scanned).toBe(0);
        } finally {
            fineDone();
        }
    }, 300_000);

    it('at 1 cm, a pathological scene: many overlapping outranked objects, the mask work stays under the cap', async () => {
        try {
            const { mod, make, fine } = await fineService();
            const svc = make('high');
            // the ragdoll, the beaver deep inside it and eight avatars around and through it, with
            // every stress object of the fine lane piled in as well
            const stress = fine.filter((e) => e.name.startsWith('stress-'));
            expect(stress.length).toBeGreaterThan(4);
            const crowd: Place[] = [
                ...RAGDOLL,
                { e: beaver, x: 0, y: 0.2, z: 0 },
                ...[0, 1, 2, 3, 4, 5, 6, 7].map((n) => ({
                    e: byName(`avatar-${n}`),
                    x: 0.15 * Math.cos(n),
                    y: 0.2,
                    z: 0.15 * Math.sin(n)
                })),
                ...stress.map((e, n) => ({
                    e,
                    x: 0.1 * Math.cos(n * 2.4),
                    y: 0.4 + 0.05 * n,
                    z: 0.1 * Math.sin(n * 2.4)
                }))
            ];
            let skipped = 0;
            for (let f = 0; f < 45; f++) {
                const s = svc.frame(
                    f,
                    f / 20,
                    'coverage50',
                    false,
                    states(crowd.map((p) => ({ ...p, x: p.x + (f % 2) * 0.002 })))
                ).stats;
                expect(s.maskLimit).toBe(mod.MASK_CAP_HIGH); // the lattice holds far more than the cap covers
                expect(work(svc), `frame ${f}`).toBeLessThanOrEqual(mod.MASK_CAP_HIGH);
                skipped += s.maskSkipped;
                expect(s.maskRejected).toBe(0);
            }
            // every mask here would scan more than the cap allows: they are skipped (and intersect)
            expect(skipped).toBeGreaterThanOrEqual(45 * 9);
        } finally {
            fineDone();
        }
    }, 300_000);

    it('at 1 cm, the Low preset: a fixed budget, never raised; the bucket against the beaver still masks, deep overlaps skip', async () => {
        try {
            const { mod, make } = await fineService();
            expect(mod.MASK_PRESETS.low).toEqual({ budget: mod.MASK_BUDGET_LOW, own: false, cap: mod.MASK_BUDGET_LOW });
            expect(mod.MASK_PRESETS.high.own).toBe(true);
            const svc = make('low');
            // the bucket with the beaver's paw and the held plank against it (bench-lattice)
            const paw: Place[] = [
                { e: bucket, x: 0, y: 0.45, z: 0 },
                { e: beaver, x: 0, y: 0, z: 0.1 },
                { e: byName('held-plank'), x: 0, y: 0.75, z: 0 }
            ];
            let s = svc.frame(0, 0, 'coverage50', false, states(paw)).stats;
            for (let f = 1; f < 4; f++) s = svc.frame(f, 0, 'coverage50', false, states(paw)).stats;
            expect(s.maskLimit).toBe(mod.MASK_BUDGET_LOW);
            expect(s.latticeMasks).toBeGreaterThan(0);
            expect(s.latticeHidden).toBeGreaterThan(0);
            expect(work(svc)).toBeLessThanOrEqual(mod.MASK_BUDGET_LOW);
            // the beaver deep in the ragdoll: over the Low budget, it intersects, within the budget
            const svc2 = make('low');
            for (let f = 0; f < 25; f++) {
                const r = svc2.frame(
                    f,
                    0,
                    'coverage50',
                    false,
                    states([...RAGDOLL, { e: beaver, x: (f % 2) * 0.002, y: 0.2, z: 0 }])
                ).stats;
                expect(r.maskLimit).toBe(mod.MASK_BUDGET_LOW);
                expect(r.latticeMasks).toBe(0);
                expect(work(svc2)).toBeLessThanOrEqual(mod.MASK_BUDGET_LOW);
            }
            // the preset comes with each frame: back to High raises the limit to the cap here
            const high = svc2.frame(
                30,
                0,
                'coverage50',
                false,
                states([...RAGDOLL]),
                undefined,
                0,
                undefined,
                undefined,
                0,
                undefined,
                'high'
            ).stats;
            expect(high.maskLimit).toBe(mod.MASK_CAP_HIGH);
        } finally {
            fineDone();
        }
    }, 300_000);

    it('maskLimit: a lattice that can mask reports its budget, also with no mask this frame; one with none reports 0', () => {
        // the fine lattice with the ragdoll's head alone: it can mask, nothing is near
        const fine = lane([head], [{ e: head, x: 0, y: 0.5, z: 0 }]);
        expect(fine.svc.canMask).toBe(true);
        expect(fine.stats.latticeMasks).toBe(0);
        expect(fine.stats.maskLimit).toBe(Math.max(MASK_BUDGET, fine.svc.world.objectCellCount(head.id)));
        // one lattice for everything (?tiers=off): no masks, no budget
        const one = new VoxelService();
        one.build(1, 'yard', undefined, false);
        const r = one.frame(1, 0, 'coverage50', false, states([{ e: head, x: 0, y: 0.5, z: 0 }]));
        expect(one.canMask).toBe(false);
        expect(r.stats.maskLimit).toBe(0);
        // the pipeline sums the lattices' limits: only the masking one counts
        const sum = combineLaneStats(r.stats, [r.stats, fine.stats]);
        expect(sum.maskLimit).toBe(fine.stats.maskLimit);
    }, 60_000);

    it('one lattice for everything (?tiers=off): your limbs do not win ties, the lower id does (as before #107)', () => {
        const fp = byName('fp-body');
        const avatar = byName('avatar-1');
        expect(avatar.priority).toBe(fp.priority);
        expect(avatar.id).toBeLessThan(fp.id);
        // your limbs 0.2 m up, through the avatar's body: many shared cells with different values
        const places = [
            { e: fp, x: 0, y: 0.2, z: 0 },
            { e: avatar, x: 0, y: 0, z: 0 }
        ];
        const one = new VoxelService();
        one.build(1, 'yard', undefined, false);
        one.frame(1, 0, 'coverage50', false, states(places));
        const mine = cells(one, fp);
        const theirs = cells(one, avatar);
        // shared cells where the two differ: only there does it show who won
        const differ = [...mine.keys()].filter((k) => theirs.has(k) && theirs.get(k) !== mine.get(k));
        expect(differ.length).toBeGreaterThan(10);
        for (const k of differ) expect(one.world.chunks[k >>> 12].dyn![k & 4095]).toBe(theirs.get(k));
    }, 60_000);
    it('at 1 cm, your limbs carrying the bucket (a real grab): its mask hides exactly your cells inside it', async () => {
        expect(carry.held).toBe(true);
        vi.resetModules();
        (globalThis as { __UE_CELL_CM__?: number }).__UE_CELL_CM__ = 1;
        try {
            const grid = await import('../../src/voxels/grid.ts');
            expect(grid.GRID_SIZE).toBe(0.01);
            const { VoxelService: Service } = await import('../../src/workers/voxel-service.ts');
            const fp = byName('fp-body');
            const svc = new Service(new Set([fp.id]));
            svc.build(1, 'yard', undefined, false);
            const st = new Float64Array(entities.length * STATE_STRIDE);
            const put = (
                e: SimEntity,
                p: { p: { x: number; y: number; z: number }; q: { x: number; y: number; z: number; w: number } },
                anim?: ArrayLike<number>
            ) => {
                const o = entities.indexOf(e) * STATE_STRIDE;
                st.set([1, p.p.x, p.p.y, p.p.z, p.q.x, p.q.y, p.q.z, p.q.w], o);
                if (anim) for (let c = 0; c < anim.length; c++) st[o + 8 + c] = anim[c];
            };
            put(fp, carry.body, carry.anim);
            put(bucket, carry.bucket);
            const s = svc.frame(1, 0, 'coverage50', false, st).stats;
            expect(s.latticeMasks).toBe(1);
            expect(s.maskRejected).toBe(0);
            expect(s.maskCells).toBeGreaterThan(0); // its boxes meet your limbs
            // your limb cells whose centres lie inside a bucket part, from the bucket's own volumes
            const poses = bucket.asset.parts.map(() => pose());
            bucket.asset.evaluate(carry.bucket, new Float64Array(ANIM_MAX), poses);
            const inv = poses.map((p) => invertRigidMat34(poseToMat34(p, mat34()), mat34()));
            const w = svc.world;
            let inside = 0;
            for (const [key] of w.objectCells(fp.id)) {
                const c = w.chunks[key >>> 12];
                const li = key & 4095;
                const x = grid.cellCenterX(c.cx * 16 + (li & grid.CHUNK_MASK));
                const z = grid.cellCenterZ(c.cz * 16 + ((li >> grid.CHUNK_BITS) & grid.CHUNK_MASK));
                const y = grid.cellCenterY(c.cy * 16 + (li >> (2 * grid.CHUNK_BITS)));
                const hit = bucket.asset.parts.some((part, n) => {
                    const m = inv[n];
                    const lx = m[0] * x + m[1] * y + m[2] * z + m[3];
                    const ly = m[4] * x + m[5] * y + m[6] * z + m[7];
                    const lz = m[8] * x + m[9] * y + m[10] * z + m[11];
                    return part.volume.sample(lx, ly, lz) !== 0;
                });
                if (hit) inside++;
            }
            expect(s.latticeHidden).toBe(inside);
            return inside;
        } finally {
            delete (globalThis as { __UE_CELL_CM__?: number }).__UE_CELL_CM__;
            vi.resetModules();
        }
    }, 300_000);
});
