/**
 * Throwing, played by input on a flat range: how far a plank flies, and that nothing else changed.
 * Owner request: "throwing them should be a bit more effective" (further and straighter), for every
 * plank, without making the empty-bucket throw over Shallow Creek go further.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { levelFromData } from '../../src/levels/data.ts';
import type { LevelData } from '../../src/levels/data.ts';
import { LabSim } from '../../src/sim/lab-sim.ts';
import { GRAB, throwImpulse } from '../../src/sim/physics/grab.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { quatRotate, vec3 } from '../../src/voxels/math.ts';
import type { Pose } from '../../src/voxels/math.ts';

import { Player } from './play.ts';

beforeAll(() => initPhysics());

const GROUND_Y = 0.3;
/** Open flat ground with a plank and a bucket on it, and two targets for a thrown plank to hit. */
function range(props: LevelData['props'] = []): LabSim {
    const data: LevelData = {
        v: 1,
        id: 'range',
        name: 'Throwing range',
        size: { minX: -30, maxX: 30, minZ: -40, maxZ: 20 },
        ground: { base: GROUND_Y, noise: 0, seed: 1 },
        features: [{ type: 'flat', rect: { minX: -28, maxX: 28, minZ: -38, maxZ: 18 }, y: GROUND_Y }],
        pieces: [],
        trees: [],
        rocks: [],
        props: [
            { name: 'plank', x: 0, z: 3.6 },
            { name: 'bucket', x: 6, z: 3.6 },
            { name: 'long-plank', x: -6, z: 3.6 },
            ...props
        ],
        spawn: { x: 0, z: 5, yaw: 0 }
    };
    const s = new LabSim({ level: levelFromData(data) });
    s.step();
    s.fpActive = true;
    return s;
}

/** The lowest point of a box body (m), from its pose and its collider's half extents. */
function lowest(s: LabSim, id: number, pose: Pose): number {
    const sh = s.physics.bodies.get(id)!.shape!;
    const h =
        sh.type === 'box'
            ? { x: sh.hx, y: sh.hy, z: sh.hz }
            : sh.type === 'cylinder' && sh.axis === 'x'
              ? { x: sh.half, y: sh.r, z: sh.r }
              : sh.type === 'cylinder'
                ? { x: sh.r, y: sh.half + (sh.offsetY ?? 0), z: sh.r }
                : { x: 0.3, y: 0.3, z: 0.3 };
    const v = vec3();
    let m = Infinity;
    for (const sx of [-1, 1])
        for (const sy of [-1, 1])
            for (const sz of [-1, 1]) {
                quatRotate(pose.q, sx * h.x, sy * h.y, sz * h.z, v);
                m = Math.min(m, pose.p.y + v.y);
            }
    return m;
}

interface Throw {
    /** Horizontal distance from the thrower's feet to the piece's centre where it first touches down, and at rest. */
    touch: number;
    rest: number;
    /** How far it turned between leaving the hands and touching down (rad). */
    turned: number;
    /** Its touch-down point's distance from the line the thrower looked along (m). */
    offLine: number;
    /** Its sideways speed just after the throw, and the thrower's when they threw (m/s). */
    sideSpeed: number;
    throwerSide: number;
}

/**
 * One player walks up to `name`, looks at it and grabs it, raises the view to `pitch`, holds still
 * for a second, optionally turns at `turn` rad/s for a tenth of a second, and throws.
 */
function throwIt(
    s: LabSim,
    name: string,
    pitch: number,
    turn = 0,
    emptyFirst = false,
    run = false,
    strafe = false
): Throw {
    const pl = new Player(s);
    const e = s.entities.find((x) => x.name === name)!;
    s.placePlayer(e.pose.p.x, e.pose.p.z + 1.4, 0);
    pl.yaw = 0;
    pl.step({}, 30);
    pl.lookAt(e.pose.p.x, e.pose.p.y + (name === 'bucket' ? 0.2 : 0), e.pose.p.z, 10);
    pl.step({ grab: true });
    expect(s.physics.heldId).toBe(e.id);
    if (emptyFirst) {
        // pour it out (it is empty already on the range: this proves it)
        pl.togglePour();
        pl.step({}, 120);
        pl.togglePour();
        pl.step({}, 60);
        expect(s.water.volume).toBeLessThan(0.01);
    }
    const p0 = pl.pitch;
    for (let i = 1; i <= 30; i++) {
        pl.pitch = p0 + ((pitch - p0) * i) / 30;
        pl.step();
    }
    // stand still for a second, or run (sprint) for one and throw on the run
    const moving = run ? { moveZ: 1, sprint: true } : strafe ? { moveX: 1 } : {};
    pl.step(moving, 60);
    for (let i = 0; i < 6 && turn; i++) {
        pl.yaw += turn / 60;
        pl.step();
    }
    const feet = { x: s.player.x, z: s.player.z };
    const q0 = { ...e.pose.q };
    const yaw = pl.yaw;
    // still in the hands when thrown (a throw of nothing would prove nothing)
    expect(s.physics.heldId).toBe(e.id);
    const st = s.physics.rig(0)!.state;
    const carried = { vx: st.vx, vz: st.vz };
    pl.step({ ...moving, throw: true });
    expect(s.physics.heldId).toBe(-1);
    const v0 = s.physics.bodies.get(e.id)!.body.linvel();
    const side = { x: Math.cos(pl.yaw), z: -Math.sin(pl.yaw) };
    let out: Throw | null = null;
    for (let i = 0; i < 300; i++) {
        pl.step();
        if (!out && lowest(s, e.id, e.pose) <= GROUND_Y + 0.03) {
            const dx = e.pose.p.x - feet.x;
            const dz = e.pose.p.z - feet.z;
            const q = e.pose.q;
            const dot = Math.abs(q0.x * q.x + q0.y * q.y + q0.z * q.z + q0.w * q.w);
            out = {
                touch: Math.hypot(dx, dz),
                rest: 0,
                turned: 2 * Math.acos(Math.min(1, dot)),
                offLine: Math.abs(dx * Math.cos(yaw) - dz * Math.sin(yaw)),
                sideSpeed: v0.x * side.x + v0.z * side.z,
                throwerSide: carried.vx * side.x + carried.vz * side.z
            };
        }
    }
    expect(out).not.toBeNull();
    out!.rest = Math.hypot(e.pose.p.x - feet.x, e.pose.p.z - feet.z);
    return out!;
}

describe('throwing a plank (owner request: further and straighter)', () => {
    /**
     * The 2.4 m, 24 kg plank before this change, thrown the same way: centre to feet where it first
     * touched down at a pitch of 0, 0.3 and 0.6 rad (measured with this test's throwIt).
     */
    const BEFORE = [
        [0, 1.72],
        [0.3, 1.77],
        [0.6, 1.68]
    ] as const;

    for (const [pitch, before] of BEFORE)
        it(`a 2.4 m plank flies 30 to 50% further than it did (looking ${pitch} rad up)`, () => {
            const t = throwIt(range(), 'plank', pitch);
            console.info(`plank thrown at ${pitch} rad: touches down ${t.touch.toFixed(2)} m out (before ${before} m)`);
            expect(t.touch / before).toBeGreaterThan(1.3);
            expect(t.touch / before).toBeLessThan(1.5);
            // and flies flat: no tumbling in the air
            expect(t.turned).toBeLessThan(0.02);
            expect(t.offLine).toBeLessThan(0.02);
        });

    it('the tutorial’s long plank leaves at the same speed and flies about as far', () => {
        const t = throwIt(range(), 'long-plank', 0.3);
        console.info(`long plank thrown at 0.3 rad: touches down ${t.touch.toFixed(2)} m out`);
        expect(t.touch / 1.77).toBeGreaterThan(1.3);
        expect(t.touch / 1.77).toBeLessThan(1.5);
        expect(t.turned).toBeLessThan(0.02);
    });

    it('thrown while turning, it still flies straight along the view (no spin, no sideways swing)', () => {
        // a 2 rad/s turn as you throw: before this, the plank turned 0.51 rad in the air and landed
        // 0.97 m off the line (measured with throwIt)
        const t = throwIt(range(), 'plank', 0.3, 2);
        console.info(
            `thrown while turning: turned ${t.turned.toFixed(2)} rad in the air, ${t.offLine.toFixed(2)} m off the line`
        );
        expect(t.turned).toBeLessThan(0.02);
        expect(t.offLine).toBeLessThan(0.1);
        expect(t.touch).toBeGreaterThan(1.3 * 1.77);
    });

    it('thrown at a sprint, a plank keeps your running speed and flies further than it did', () => {
        const t = throwIt(range(), 'plank', 0.3, 0, false, true);
        console.info(
            `plank thrown at a sprint: touches down ${t.touch.toFixed(2)} m out, rests ${t.rest.toFixed(2)} m out`
        );
        // before this change, measured with throwIt on epics-5-10: 4.33 m (at rest 4.55 m)
        expect(t.touch / 4.33).toBeGreaterThan(1.1);
        expect(t.touch / 4.33).toBeLessThan(1.5);
        expect(t.turned).toBeLessThan(0.02);
    });

    it('thrown while strafing, a plank keeps the thrower’s sideways speed (only its swing in the hands goes)', () => {
        const t = throwIt(range(), 'plank', 0.3, 0, false, false, true);
        console.info(
            `thrown strafing: thrower ${t.throwerSide.toFixed(2)} m/s sideways, plank ${t.sideSpeed.toFixed(2)} m/s`
        );
        expect(t.throwerSide).toBeGreaterThan(1);
        expect(Math.abs(t.sideSpeed - t.throwerSide)).toBeLessThan(0.05 * t.throwerSide);
        expect(t.turned).toBeLessThan(0.02);
    });

    it('only planks: the general throw (speed and impulse cap) is as it was', () => {
        expect(GRAB.throwSpeed).toBe(9);
        expect(GRAB.maxThrowImpulse).toBe(45);
        expect(throwImpulse(1.5)).toBeCloseTo(13.5, 9);
        const s = range();
        const plank = s.physics.bodies.get(s.plank.id)!;
        const bucket = s.physics.bodies.get(s.bucket.id)!;
        expect(plank.throw?.maxImpulse).toBeGreaterThan(GRAB.maxThrowImpulse);
        expect(bucket.throw).toBeUndefined();
    });

    it('the empty bucket flies exactly as far as before (the Shallow Creek throw does not get longer)', () => {
        const t = throwIt(range(), 'bucket', 0.3, 0, true);
        console.info(`empty bucket thrown: touches down ${t.touch.toFixed(3)} m out, rests ${t.rest.toFixed(3)} m out`);
        expect(Math.abs(t.touch - BUCKET_BEFORE.touch)).toBeLessThan(0.01);
        expect(Math.abs(t.rest - BUCKET_BEFORE.rest)).toBeLessThan(0.01);
    });

    it('a beam and a crate are thrown exactly as before (only planks have their own throw)', () => {
        for (const [name, before] of Object.entries(OTHERS_BEFORE)) {
            const s = range([{ name, x: 12, z: 3.6 }]);
            const t = throwIt(s, name, 0.3);
            console.info(`${name} thrown: touches down ${t.touch.toFixed(3)} m out, rests ${t.rest.toFixed(3)} m out`);
            expect(Math.abs(t.touch - before.touch), name).toBeLessThan(0.01);
            expect(Math.abs(t.rest - before.rest), name).toBeLessThan(0.01);
            expect(s.physics.bodies.get(s.entities.find((e) => e.name === name)!.id)!.throw).toBeUndefined();
        }
    });

    it('what a thrown plank hits is knocked about, not launched', () => {
        // a ball and a crate where the plank comes down
        const s = range([
            { name: 'sphere', x: 0, z: 2.6 },
            { name: 'cube', x: 0.9, z: 2.6 }
        ]);
        const targets = [s.sphere, s.cube].map((e) => ({ e, from: { ...e.pose.p }, maxV: 0, maxUp: 0 }));
        const pl = new Player(s);
        s.placePlayer(0, 4.9, 0);
        pl.step({}, 30);
        pl.lookAt(s.plank.pose.p.x, s.plank.pose.p.y + 0.05, s.plank.pose.p.z, 10);
        pl.step({ grab: true });
        expect(s.physics.heldId).toBe(s.plank.id);
        const p0 = pl.pitch;
        for (let i = 1; i <= 30; i++) {
            pl.pitch = p0 + ((0.1 - p0) * i) / 30;
            pl.step();
        }
        pl.step({}, 30);
        pl.step({ throw: true });
        for (let i = 0; i < 240; i++) {
            pl.step();
            for (const t of targets) {
                const v = s.physics.bodies.get(t.e.id)!.body.linvel();
                t.maxV = Math.max(t.maxV, Math.hypot(v.x, v.y, v.z));
                t.maxUp = Math.max(t.maxUp, t.e.pose.p.y - t.from.y);
            }
        }
        for (const t of targets) {
            console.info(`${t.e.name}: up to ${t.maxV.toFixed(2)} m/s, at most ${t.maxUp.toFixed(3)} m up`);
            // it was hit
            expect(t.maxV).toBeGreaterThan(0.5);
            // slower than throwing it yourself would send it
            expect(t.maxV).toBeLessThan(GRAB.throwSpeed);
            // the crate never leaves the ground; the bouncy ball (restitution 0.78) hops a hand's
            // height at most (measured 0.11 m), never launched
            expect(t.maxUp).toBeLessThan(t.e === s.cube ? 0.05 : 0.15);
        }
        expect(s.physics.stats.linClamps).toBe(0);
        expect(s.progress.falls).toBe(0);
    });
});

/** A beam's and a crate's throw before this change, measured with throwIt on epics-5-10 (m). */
const OTHERS_BEFORE: Record<string, { touch: number; rest: number }> = {
    'beam-0': { touch: 1.372, rest: 1.146 },
    cube: { touch: 1.769, rest: 1.765 }
};

/** The empty bucket's throw before this change, measured with throwIt (m). */
const BUCKET_BEFORE = { touch: 8.738, rest: 12.19 };
