import { beforeAll, describe, expect, it } from 'vitest';

import { BEAVER_HEIGHT, BEAVER_WALK_AMOUNT, BEAVER_WALK_PHASE, beaverAsset } from '../../src/assets/beaver.ts';
import { BUCKET_HANDLE_TOP } from '../../src/assets/props.ts';
import { UTE_WHEEL_RADIUS, uteAsset } from '../../src/assets/ute.ts';
import { PLATEAU_Y } from '../../src/levels/river-lab.ts';
import { FixedStepClock, MAX_CATCHUP_STEPS, SIM_DT, VoxelClock } from '../../src/sim/clock.ts';
import { neutralCommand } from '../../src/sim/commands.ts';
import { LabSim } from '../../src/sim/lab-sim.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { ANIM_MAX, SnapshotRing, writeEntity } from '../../src/sim/snapshots.ts';
import { GRID_SIZE } from '../../src/voxels/grid.ts';
import { DEG, pose, quatFromYawPitchRoll } from '../../src/voxels/math.ts';
import { M, voxelMaterial } from '../../src/voxels/palette.ts';
import { createRasterStats } from '../../src/voxels/rasterizer.ts';
import { VoxelWorld } from '../../src/voxels/world.ts';

import { keyToCell } from './helpers.ts';

describe('fixed step clock (§4.4)', () => {
    it('runs whole 60 Hz steps from accumulated time and caps catch-up', () => {
        const c = new FixedStepClock();
        expect(c.advance(SIM_DT * 0.5)).toBe(0);
        expect(c.advance(SIM_DT * 0.6)).toBe(1);
        expect(c.advance(1.0)).toBe(MAX_CATCHUP_STEPS);
        expect(c.droppedTicks).toBeGreaterThan(50);
        expect(c.advance(NaN)).toBe(0);
        expect(c.advance(-1)).toBe(0);
    });

    it('voxel clock enters a new frame exactly at multiples of 1/hz', () => {
        const v = new VoxelClock();
        v.setRate(20);
        expect(v.frameAt(0.0499)).toBe(0);
        expect(v.frameAt(0.05)).toBe(1);
        v.frame = v.frameAt(0.06);
        expect(v.due(0.09)).toBe(false);
        expect(v.due(0.1)).toBe(true);
    });
});

describe('snapshot interpolation', () => {
    it('interpolates poses and animation between ticks and clamps outside the window', () => {
        const ring = new SnapshotRing(1, 8);
        const anim = new Float64Array(ANIM_MAX);
        for (let t = 0; t < 12; t++) {
            const buf = ring.beginWrite(t);
            anim[0] = t * 10;
            writeEntity(buf, 0, pose(t, 0, 0, quatFromYawPitchRoll(t * 0.1, 0, 0)), true, anim, ANIM_MAX);
        }
        const out = pose();
        const a = new Float64Array(ANIM_MAX);
        expect(ring.sample(0, 9.25 * SIM_DT, out, a)).toBe(true);
        expect(out.p.x).toBeCloseTo(9.25, 9);
        expect(a[0]).toBeCloseTo(92.5, 9);
        ring.sample(0, 100, out, a);
        expect(out.p.x).toBe(11);
        ring.sample(0, 0, out, a);
        expect(out.p.x).toBe(4); // oldest buffered
    });
});

describe('lab simulation', () => {
    beforeAll(() => initPhysics());

    it('is deterministic: seeking to the same tick twice gives identical states', () => {
        const a = new LabSim();
        const b = new LabSim();
        a.runTo(1234);
        b.runTo(600);
        b.runTo(1234);
        for (let n = 0; n < a.entities.length; n++) {
            expect(b.entities[n].pose).toEqual(a.entities[n].pose);
            expect(Array.from(b.entities[n].anim)).toEqual(Array.from(a.entities[n].anim));
        }
        const c = new LabSim();
        c.runTo(2000);
        c.runTo(1234); // rewinds by reset + replay
        expect(c.entities[0].pose).toEqual(a.entities[0].pose);
    });

    it('keeps every published pose finite over a long run', () => {
        const s = new LabSim();
        s.stressCount = 25;
        for (let n = 0; n < 60 * 120; n++) {
            s.step(neutralCommand(n));
            if (n % 97 === 0) for (const e of s.entities) expect(Number.isFinite(e.pose.p.x + e.pose.p.y + e.pose.p.z + e.pose.q.w)).toBe(true);
        }
    }, 120_000);

    it('hangs the bucket below the beaver hand, above the ground (scripted props)', () => {
        const s = new LabSim({ props: 'scripted' });
        for (const tick of [10, 200, 450, 700]) {
            s.runTo(tick);
            const bk = s.bucket.pose.p;
            const bv = s.beaver.pose.p;
            expect(Math.hypot(bk.x - bv.x, bk.z - bv.z)).toBeLessThan(0.7);
            expect(bk.y).toBeGreaterThanOrEqual(PLATEAU_Y);
            expect(bk.y + BUCKET_HANDLE_TOP).toBeLessThan(bv.y + 1.0);
        }
    });
});

function rasterAsset(asset: typeof beaverAsset, root: ReturnType<typeof pose>, anim: Float64Array) {
    const world = new VoxelWorld();
    world.addObject(1);
    const poses = asset.parts.map(() => pose());
    asset.evaluate(root, anim, poses);
    const stats = createRasterStats();
    world.rasterizeObject(
        1,
        asset.parts.map((p, i) => ({ volume: p.volume, pose: poses[i], priority: p.priority, policy: p.policy })),
        'coverage50',
        stats
    );
    world.resolve();
    expect(stats.rejected).toBe(0);
    const cells = [...world.objectCells(1).entries()].map(([k, v]) => ({ ...keyToCell(world, k), m: voxelMaterial(v) }));
    return cells;
}

describe('beaver asset (§2.2, §3.2)', () => {
    it('is 1.4 m tall (14 cells at 10 cm) standing on a grid plane', () => {
        const anim = new Float64Array(ANIM_MAX);
        const cells = rasterAsset(beaverAsset, pose(0.05, 0, 0.05), anim);
        const minJ = Math.min(...cells.map((c) => c.j));
        const maxJ = Math.max(...cells.map((c) => c.j));
        expect(minJ).toBe(0);
        expect(maxJ - minJ + 1).toBe(Math.round(BEAVER_HEIGHT / GRID_SIZE));
    });

    it('keeps both eyes visible (small patches) plus teeth, nose, hat and hi-vis at every heading and walk phase', () => {
        const maxEye = Math.round(3 * (0.1 / GRID_SIZE) ** 2);
        const anim = new Float64Array(ANIM_MAX);
        anim[BEAVER_WALK_AMOUNT] = 1;
        for (let yaw = 0; yaw < 360; yaw += 5) {
            for (const phase of [0, 1.3, 2.9, 4.4]) {
                anim[BEAVER_WALK_PHASE] = phase;
                const ox = 0.013;
                const oz = -0.021;
                const cells = rasterAsset(beaverAsset, pose(ox, 0, oz, quatFromYawPitchRoll(yaw * DEG, 0, 0)), anim);
                const mats = new Set(cells.map((c) => c.m));
                for (const m of [M.Tooth, M.Nose, M.HardHat, M.HiVis, M.Tail, M.Muzzle]) {
                    expect(mats.has(m), `material ${m} missing at yaw ${yaw}, phase ${phase}`).toBe(true);
                }
                const occ = new Set(cells.map((c) => `${c.i},${c.j},${c.k}`));
                const has = (i: number, j: number, k: number) => occ.has(`${i},${j},${k}`);
                let left = 0;
                let right = 0;
                for (const c of cells) {
                    if (c.m !== M.Eye) continue;
                    const exposed = !has(c.i + 1, c.j, c.k) || !has(c.i - 1, c.j, c.k) || !has(c.i, c.j + 1, c.k) || !has(c.i, c.j - 1, c.k) || !has(c.i, c.j, c.k + 1) || !has(c.i, c.j, c.k - 1);
                    if (!exposed) continue;
                    const cx = (c.i + 0.5) * GRID_SIZE - ox;
                    const cz = (c.k + 0.5) * GRID_SIZE - oz;
                    const lx = Math.cos(yaw * DEG) * cx - Math.sin(yaw * DEG) * cz;
                    if (lx > 0) left++;
                    else right++;
                }
                expect(left, `left eye at yaw ${yaw}, phase ${phase}`).toBeGreaterThanOrEqual(1);
                expect(right, `right eye at yaw ${yaw}, phase ${phase}`).toBeGreaterThanOrEqual(1);
                expect(left).toBeLessThanOrEqual(maxEye);
                expect(right).toBeLessThanOrEqual(maxEye);
            }
        }
    });

    it('keeps its cell count stable while walking (no flicker of whole parts)', () => {
        const anim = new Float64Array(ANIM_MAX);
        anim[BEAVER_WALK_AMOUNT] = 1;
        const counts: number[] = [];
        for (let n = 0; n < 40; n++) {
            anim[BEAVER_WALK_PHASE] = n * 0.157;
            counts.push(rasterAsset(beaverAsset, pose(0.0, 0, 0.0, quatFromYawPitchRoll(n * 0.1, 0, 0)), anim).length);
        }
        const min = Math.min(...counts);
        const max = Math.max(...counts);
        expect((max - min) / min).toBeLessThan(0.12);
    });
});

describe('ute asset (§2.7)', () => {
    it('sits its wheels on the ground plane and spins them visibly', () => {
        const anim = new Float64Array(ANIM_MAX);
        const a = rasterAsset(uteAsset, pose(0.05, PLATEAU_Y, 0.05), anim);
        const groundJ = Math.round(PLATEAU_Y / GRID_SIZE);
        expect(Math.min(...a.map((c) => c.j))).toBe(groundJ);
        const tyreTop = Math.max(...a.filter((c) => c.m === M.Tyre).map((c) => c.j));
        expect(tyreTop - groundJ + 1).toBeLessThanOrEqual(Math.ceil((2 * UTE_WHEEL_RADIUS) / GRID_SIZE) + 1);
        anim[0] = 0.4; // wheel spin
        const b = rasterAsset(uteAsset, pose(0.05, PLATEAU_Y, 0.05), anim);
        const sig = (cells: typeof a) => cells.filter((c) => c.m === M.Chrome || c.m === M.Tyre).map((c) => `${c.i},${c.j},${c.k},${c.m}`).sort().join('|');
        expect(sig(b)).not.toBe(sig(a));
    });
});
