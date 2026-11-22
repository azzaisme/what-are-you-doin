import { beforeAll, describe, expect, it } from 'vitest';

import { BUCKET_LITRES, BUCKET_SLOPE_X, bucketAsset } from '../../src/assets/props.ts';
import { MAX_PARTICLES, ParticleFX } from '../../src/fx/particles.ts';
import { BRIDGE_X, BUCKET_STUMP, timberYardLevel } from '../../src/levels/timber-yard.ts';
import { ACTION_POUR, ACTION_RESET_PROPS, neutralCommand } from '../../src/sim/commands.ts';
import type { PlayerCommand } from '../../src/sim/commands.ts';
import { propBody } from '../../src/sim/lab-physics.ts';
import { EYE_HEIGHT, LabSim } from '../../src/sim/lab-sim.ts';
import { NO_DRIVE, UteVehicle } from '../../src/sim/physics/vehicle.ts';
import { PhysicsWorld, initPhysics } from '../../src/sim/physics/world.ts';
import { SnapshotRing, writeEntity, ANIM_MAX } from '../../src/sim/snapshots.ts';
import { BucketWater, WATER, fitLitres, surfaceHeight } from '../../src/sim/water.ts';
import { pose, quatFromYawPitchRoll } from '../../src/voxels/math.ts';
import type { Quat } from '../../src/voxels/math.ts';
import { M, voxelMaterial } from '../../src/voxels/palette.ts';

beforeAll(() => initPhysics());

const cmd = (n: number, c: Partial<PlayerCommand> = {}): PlayerCommand => ({ ...neutralCommand(n), ...c });
const UP: Quat = { x: 0, y: 0, z: 0, w: 1 };
const zero = () => ({ x: 0, y: 0, z: 0 });
const tiltQ = (deg: number) => quatFromYawPitchRoll(0, (deg * Math.PI) / 180, 0);

/** What the water ledger is off by: bucket + sources + spilled + lost + flower - start - top-ups. */
const accounted = (s: LabSim) => s.water.imbalance;

/** Player 1 in first person, holding the yard's bucket (picked up from its stump, view eased up). */
function holdBucket(s: LabSim, start = 0): (c?: Partial<PlayerCommand>, k?: number) => void {
    let n = start;
    let pitch = 0;
    let yaw = 0;
    const step = (c: Partial<PlayerCommand> = {}, k = 1) => {
        for (let i = 0; i < k; i++) {
            const y = (c.yaw ?? yaw) as number;
            yaw = y;
            s.step(cmd(n++, { pitch, ...c, yaw: y }));
        }
    };
    step({}, 60);
    s.fpActive = true;
    s.placePlayer(BUCKET_STUMP.x, BUCKET_STUMP.z + 1, 0);
    step({}, 20);
    pitch = -Math.atan2(s.player.y + EYE_HEIGHT - s.bucket.pose.p.y, s.player.z - s.bucket.pose.p.z);
    step({}, 3);
    step({ grab: true });
    expect(s.physics.heldId).toBe(s.bucket.id);
    pitch = 0;
    step({}, 90);
    return step;
}

describe('bucket water model (#61, #62)', () => {
    it('a still, upright bucket keeps its water, and the surface stays level', () => {
        const w = new BucketWater();
        for (let n = 0; n < 60 * 60; n++) w.step({ q: UP, v: zero(), w: zero() });
        expect(w.volume).toBe(WATER.capacity);
        expect(Math.abs(w.sx) + Math.abs(w.sz)).toBeLessThan(1e-9);
    });

    it('what a tipped bucket holds falls smoothly with the tilt, to nothing upside down', () => {
        let prev = fitLitres(0);
        for (let r = 0.01; r <= 1; r += 0.01) {
            const v = fitLitres(r);
            expect(v).toBeLessThanOrEqual(prev + 1e-12);
            expect(prev - v).toBeLessThan(0.6);
            prev = v;
        }
        expect(fitLitres(0)).toBeGreaterThan(WATER.capacity);
        expect(fitLitres(Infinity)).toBe(0);
        expect(fitLitres(NaN)).toBe(0);
    });

    it('a slow tilt within the freeboard keeps the water; tipping it past the rim spills the excess', () => {
        const slow = new BucketWater();
        // tip to 25 degrees over 3 s, hold, and back
        for (let n = 0; n <= 180; n++) slow.step({ q: tiltQ((25 * n) / 180), v: zero(), w: zero() });
        for (let n = 0; n < 120; n++) slow.step({ q: tiltQ(25), v: zero(), w: zero() });
        for (let n = 180; n >= 0; n--) slow.step({ q: tiltQ((25 * n) / 180), v: zero(), w: zero() });
        expect(slow.volume).toBe(WATER.capacity);
        // tipped 60 degrees and held there: it keeps only what fits under the rim
        const tipped = new BucketWater();
        let out = 0;
        for (let n = 0; n < 240; n++) out += tipped.step({ q: tiltQ(60), v: zero(), w: zero() });
        const fits = fitLitres(WATER.radius * Math.tan(Math.PI / 3));
        expect(tipped.volume).toBeLessThanOrEqual(fits + 1e-9);
        expect(tipped.volume).toBeGreaterThan(fits - 0.05);
        expect(out).toBeCloseTo(WATER.capacity - tipped.volume, 9);
    });

    it('a steady carry keeps its volume; an impact or an abrupt jerk spills', () => {
        // walking pace with gentle starts and stops (2 m/s^2), swaying 3 cm at 1.8 Hz
        const steady = new BucketWater();
        for (let n = 0; n < 60 * 20; n++) {
            const t = n / 60;
            const vx = Math.min(1.4, Math.max(0, 1.4 - Math.abs(((t % 10) - 5) * 2) + 2)) * Math.sign(5 - (t % 10));
            const sway = 0.03 * 2 * Math.PI * 1.8 * Math.cos(2 * Math.PI * 1.8 * t);
            steady.step({ q: UP, v: { x: vx, y: sway, z: 0 }, w: zero() });
        }
        expect(steady.volume).toBe(WATER.capacity);
        // dropped: falling at 4 m/s, stopped by the ground in one tick
        const dropped = new BucketWater();
        for (let n = 0; n < 30; n++) dropped.step({ q: UP, v: { x: 0, y: -4 + 0 * n, z: 0 }, w: zero() });
        for (let n = 0; n < 120; n++) dropped.step({ q: UP, v: zero(), w: zero() });
        // swung at 4 m/s into a wall and stopped dead
        const bumped = new BucketWater();
        bumped.step({ q: UP, v: zero(), w: zero() });
        for (let n = 0; n < 10; n++) bumped.step({ q: UP, v: { x: 4, y: 0, z: 0 }, w: zero() });
        for (let n = 0; n < 120; n++) bumped.step({ q: UP, v: zero(), w: zero() });
        console.log('spilled: dropped', (10 - dropped.volume).toFixed(2), 'bumped', (10 - bumped.volume).toFixed(2));
        expect(dropped.volume).toBeLessThan(WATER.capacity - 0.2);
        expect(bumped.volume).toBeLessThan(WATER.capacity - 0.2);
    });

    it('upside down it empties, and never goes below zero', () => {
        const w = new BucketWater();
        let n = 0;
        for (; n < 600 && w.volume > 0; n++) w.step({ q: tiltQ(180), v: zero(), w: zero() });
        expect(n).toBeLessThan(90);
        expect(w.volume).toBe(0);
        for (let k = 0; k < 60; k++) w.step({ q: tiltQ(180), v: zero(), w: zero() });
        expect(w.volume).toBe(0);
        expect(w.add(-5)).toBe(0);
        expect(w.add(25)).toBe(WATER.capacity);
        expect(w.volume).toBe(WATER.capacity);
    });

    it('stays finite and in range whatever comes in (NaN, infinities, huge spins)', () => {
        const w = new BucketWater();
        const junk = [NaN, Infinity, -Infinity, 1e300, -1e300, 0];
        for (let n = 0; n < 600; n++) {
            const j = (k: number) => junk[(n * 7 + k * 3) % junk.length];
            w.step({
                q: { x: j(0), y: j(1), z: j(2), w: j(3) },
                v: { x: j(4), y: j(5), z: j(1) },
                w: { x: j(2), y: j(3), z: j(4) }
            });
            for (const v of [
                w.volume,
                w.sx,
                w.sz,
                w.vx,
                w.vz,
                w.local.x,
                w.local.z,
                w.lip.x,
                w.lip.y,
                w.lip.z,
                w.spilled
            ])
                expect(Number.isFinite(v)).toBe(true);
            expect(w.volume).toBeGreaterThanOrEqual(0);
            expect(w.volume).toBeLessThanOrEqual(WATER.capacity);
        }
    });

    it('the drawn water follows the volume and the surface (bucket asset, 1 cm lattice)', () => {
        const a = bucketAsset();
        const water = a.parts.find((p) => p.name === 'water')!;
        const anim = new Float64Array(10);
        const out = a.parts.map(() => pose());
        // (tests run on 5-10 cm lattices, where the bucket's floor is drawn thicker than on the 1 cm one)
        for (const litres of [10, 5]) {
            anim[BUCKET_LITRES] = litres;
            a.evaluate(pose(), anim, out);
            const h = surfaceHeight(litres);
            expect(water.volume.sample(0, h - 0.004, 0)).toBeGreaterThan(0);
            expect(water.volume.sample(0, h + 0.004, 0)).toBe(0);
            expect(a.partHidden!(anim, 1)).toBe(false);
        }
        // a sloped surface: higher on +x
        anim[BUCKET_LITRES] = 5;
        anim[BUCKET_SLOPE_X] = 0.5;
        a.evaluate(pose(), anim, out);
        const h = surfaceHeight(5);
        expect(water.volume.sample(0.08, h + 0.03, 0)).toBeGreaterThan(0);
        expect(water.volume.sample(-0.08, h - 0.03, 0)).toBe(0);
        // empty: not drawn at all
        anim[BUCKET_LITRES] = 0;
        expect(a.partHidden!(anim, 1)).toBe(true);
    });
});

describe('the bucket in the level (#61, #63)', () => {
    it('starts full, its water weighs on it, and a carry about the yard keeps (nearly) all of it', () => {
        const s = new LabSim({ level: timberYardLevel });
        s.step(cmd(0));
        s.step(cmd(1));
        const body = s.physics.bodies.get(s.bucket.id)!.body;
        expect(s.water.volume).toBe(10);
        expect(body.mass()).toBeGreaterThan(11);
        expect(body.mass()).toBeLessThan(12.5);
        const step = holdBucket(s, 1000);
        // walk, stop, turn, walk on: twice round a loop in the open yard, stopping at each corner
        let yaw = 0;
        const corners = [
            [5.6, 8.5],
            [0.5, 8.5],
            [0.5, 6.5],
            [3.5, 6.5]
        ];
        for (let lap = 0; lap < 2; lap++)
            for (const [x, z] of corners) {
                const want = Math.atan2(-(x - s.player.x), -(z - s.player.z));
                let d = want - yaw;
                d = Math.atan2(Math.sin(d), Math.cos(d));
                for (let i = 1; i <= 30; i++) step({ yaw: yaw + (d * i) / 30 });
                yaw += d;
                for (let i = 0; i < 600 && Math.hypot(s.player.x - x, s.player.z - z) > 0.3; i++)
                    step({ moveZ: 1, yaw });
                step({ yaw }, 40);
                expect(Math.hypot(s.player.x - x, s.player.z - z)).toBeLessThan(0.5);
            }
        expect(s.physics.heldId).toBe(s.bucket.id);
        console.log('after a careful carry', s.water.volume.toFixed(2), 'L');
        expect(s.water.volume).toBeGreaterThan(9.5);
        expect(Math.abs(accounted(s))).toBeLessThan(1e-9);
    }, 60_000);

    it('pouring tips it forward and empties it where you look; again stops; its weight goes with the water', () => {
        const s = new LabSim({ level: timberYardLevel });
        const step = holdBucket(s, 0);
        step({ action: ACTION_POUR });
        expect(s.pouring[0]).toBe(true);
        step({}, 40);
        const mid = s.water.volume;
        expect(mid).toBeLessThan(9);
        // the water leaves on the side away from you
        const lip = s.water.water.lip;
        expect(Math.hypot(lip.x, lip.z)).toBeGreaterThan(0.1);
        step({ action: ACTION_POUR });
        expect(s.pouring[0]).toBe(false);
        step({}, 90);
        const after = s.water.volume;
        step({}, 120);
        expect(s.water.volume).toBeCloseTo(after, 1);
        step({ action: ACTION_POUR });
        step({ moveZ: 0.2 }, 300);
        // all but the dregs
        expect(s.water.volume).toBeLessThan(0.3);
        const body = s.physics.bodies.get(s.bucket.id)!.body;
        expect(body.mass()).toBeLessThan(2.5);
        // letting go stops the pour
        step({ action: ACTION_POUR });
        step({ grab: true });
        expect(s.pouring[0]).toBe(false);
        expect(Math.abs(accounted(s))).toBeLessThan(1e-9);
    }, 60_000);

    it('Reset props refills every water source (recorded as a top-up)', () => {
        const s = new LabSim({ level: timberYardLevel });
        s.step(cmd(0));
        const butt = s.water.sources[0];
        // 25 L drawn from the butt and since spilled (as after a few refills)
        butt.litres = 15;
        s.water.spilled += 25;
        expect(Math.abs(s.water.imbalance)).toBeLessThan(1e-9);
        s.step(cmd(1, { action: ACTION_RESET_PROPS }));
        expect(butt.litres).toBe(40);
        expect(Math.abs(s.water.imbalance)).toBeLessThan(1e-9);
    });

    it('a spare bucket after a fall is empty and fills on the stump; nothing is counted twice', () => {
        const s = new LabSim({ level: timberYardLevel });
        s.step(cmd(0));
        s.physics.place(s.bucket.id, pose(BRIDGE_X + 3, -0.1, -2.3));
        let n = 1;
        for (; n < 400 && s.progress.recoveries === 0; n++) s.step(cmd(n));
        expect(s.progress.recoveries).toBe(1);
        expect(s.water.volume).toBeLessThan(0.01);
        for (let i = 0; i < 300; i++) s.step(cmd(n++));
        // back on its stump, under the tap
        expect(s.water.volume).toBeCloseTo(10, 6);
        expect(s.water.sources[0].litres).toBeCloseTo(30, 6);
        expect(s.water.lost + s.water.spilled).toBeCloseTo(10, 6);
        expect(Math.abs(accounted(s))).toBeLessThan(1e-9);
    }, 60_000);

    it('is deterministic: the same commands give the same water', () => {
        const run = () => {
            const s = new LabSim({ level: timberYardLevel });
            const step = holdBucket(s, 0);
            const trace: number[] = [];
            for (let k = 0; k < 6; k++) {
                step({ moveZ: 1, sprint: true }, 30);
                step({ moveZ: -1, sprint: true }, 30);
                trace.push(s.water.volume, s.bucket.anim[BUCKET_SLOPE_X]);
            }
            return { s, trace };
        };
        const a = run();
        const b = run();
        expect(a.trace).toEqual(b.trace);
        // running back and forth at a sprint, the water did slop out (and the same out each time)
        expect(a.s.water.volume).toBeLessThan(10);
        expect(a.trace.every((v) => Number.isFinite(v))).toBe(true);
    }, 60_000);

    it('a bucket in the ute’s bed keeps most of its water on a gentle drive; a hard stop slops some out', () => {
        const drive = (throttle: number, brakeHard: boolean) => {
            const pw = new PhysicsWorld();
            pw.addTerrain(() => 0, -80, 80, -80, 80, 80);
            pw.killBox = { minX: -80, maxX: 80, minZ: -80, maxZ: 80 };
            const u = new UteVehicle(pw, 1, pose(0, 0.3, -40));
            const run = (input: typeof NO_DRIVE, ticks: number, w?: BucketWater) => {
                for (let i = 0; i < ticks; i++) {
                    u.drive(input);
                    pw.step();
                    if (w) {
                        const b = bucket.body;
                        const r = b.rotation();
                        const v = b.linvel();
                        const av = b.angvel();
                        w.step({ q: r, v, w: av });
                    }
                }
            };
            run(NO_DRIVE, 120);
            // the bucket set down in the middle of the bed (floor top at 0.97 m), with its water's weight
            const def = propBody('bucket')!;
            const bucket = pw.addDynamic(2, def.shape, pose(0, 1.0, -41.1), def.opts);
            bucket.body.setAdditionalMass(10, true);
            const w = new BucketWater();
            run(NO_DRIVE, 90, w);
            expect(w.volume).toBe(10);
            run({ throttle, steer: 0, brake: false }, 60 * 4, w);
            run({ throttle: 0, steer: 0, brake: brakeHard }, 60 * 3, w);
            return { w, speed: u.pb.body.linvel() };
        };
        const gentle = drive(0.35, false);
        const hard = drive(1, true);
        console.log(
            'bucket in the bed: gentle drive keeps',
            gentle.w.volume.toFixed(2),
            'L, a hard stop',
            hard.w.volume.toFixed(2),
            'L'
        );
        expect(gentle.w.volume).toBeGreaterThan(9);
        expect(hard.w.volume).toBeLessThan(gentle.w.volume);
    }, 60_000);
});

describe('droplets (#65)', () => {
    it('spills and fills show pooled droplets: bounded, short-lived, and never counted as water', () => {
        const sim = new LabSim({ level: timberYardLevel });
        const ring = new SnapshotRing(sim.entities.length, 64);
        const fx = new ParticleFX(timberYardLevel, []);
        fx.bucketSlot = sim.bucket.slot;
        const anim = new Float64Array(ANIM_MAX);
        const at = pose(0, 1, 8, quatFromYawPitchRoll(0, 1.2, 0));
        const drops = () => {
            let n = 0;
            for (let i = 0; i < fx.count; i++) if (voxelMaterial(fx.buffer[i * 4 + 3]) === M.BucketWater) n++;
            return n;
        };
        let litres = 10;
        let most = 0;
        const frame = (tick: number) => {
            anim[BUCKET_LITRES] = litres;
            writeEntity(ring.beginWrite(tick), sim.bucket.slot, at, true, anim, ANIM_MAX);
            fx.update(tick / 60, ring, { x: 0, z: 8 });
            expect(fx.count).toBeLessThanOrEqual(MAX_PARTICLES);
            most = Math.max(most, drops());
        };
        // three seconds of a fast spill (6 L/s), sampled at the voxel rate
        let tick = 0;
        for (; tick < 180; tick += 3) {
            litres = Math.max(0, litres - 0.3);
            frame(tick);
        }
        expect(fx.spawned.pour).toBeGreaterThan(20);
        expect(most).toBeGreaterThan(0);
        // the pool holds at most 32 bursts of 8: a long spill never grows past that
        expect(most).toBeLessThanOrEqual(32 * 8);
        // stopped: within a second every droplet is gone
        for (const end = tick + 60; tick < end; tick += 3) frame(tick);
        expect(drops()).toBe(0);
        // filling: a short stream from the tap, also gone when it stops
        for (const end = tick + 30; tick < end; tick += 3) {
            litres += 0.2;
            frame(tick);
        }
        expect(fx.spawned.fill).toBeGreaterThan(0);
        for (const end = tick + 60; tick < end; tick += 3) frame(tick);
        expect(drops()).toBe(0);
    });
});
