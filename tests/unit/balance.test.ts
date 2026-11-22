import { beforeAll, describe, expect, it } from 'vitest';

import { PLAYER_BODY } from '../../src/assets/player-body.ts';
import { neutralCommand } from '../../src/sim/commands.ts';
import type { PlayerCommand } from '../../src/sim/commands.ts';
import { EYE_HEIGHT, LabSim } from '../../src/sim/lab-sim.ts';
import { GRAB, wristTorque } from '../../src/sim/physics/grab.ts';
import type { Quat, Sym3, WristResult } from '../../src/sim/physics/grab.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';

beforeAll(() => initPhysics());

const cmd = (n: number, c: Partial<PlayerCommand> = {}): PlayerCommand => ({ ...neutralCommand(n), ...c });
const out = (): WristResult => ({ tx: 0, ty: 0, tz: 0, angle: 0, load: 0 });
const ident: Quat = { x: 0, y: 0, z: 0, w: 1 };
/** Inverse inertia of a body with inertia 2 kg m^2 about every axis. */
const invI: Sym3 = { m11: 0.5, m12: 0, m13: 0, m22: 0.5, m23: 0, m33: 0.5 };
const zero = { x: 0, y: 0, z: 0 };
const aboutZ = (a: number): Quat => ({ x: 0, y: 0, z: Math.sin(a / 2), w: Math.cos(a / 2) });

describe('the wrist: torque towards the angle it was picked up at', () => {
    it('is zero when held as picked up, and turns it back the shortest way when not', () => {
        const r = wristTorque(ident, ident, zero, invI, out());
        expect(Math.hypot(r.tx, r.ty, r.tz)).toBeLessThan(1e-12);
        // rolled 0.1 rad about +Z: the torque turns it back, about -Z
        const back = wristTorque(aboutZ(0.1), ident, zero, invI, out());
        expect(back.tz).toBeLessThan(0);
        expect(Math.abs(back.tx) + Math.abs(back.ty)).toBeLessThan(1e-9);
        expect(back.angle).toBeCloseTo(0.1, 9);
        // the same rotation written with the other sign of the quaternion
        const q = aboutZ(0.1);
        const flipped = wristTorque({ x: -q.x, y: -q.y, z: -q.z, w: -q.w }, ident, zero, invI, out());
        expect(flipped.tz).toBeCloseTo(back.tz, 9);
        // 350 degrees one way is 10 degrees the other
        expect(wristTorque(aboutZ(2 * Math.PI - 0.17), ident, zero, invI, out()).tz).toBeGreaterThan(0);
    });

    it('damps spin, and never twists harder than a wrist can', () => {
        const spin = wristTorque(ident, ident, { x: 0, y: 3, z: 0 }, invI, out());
        expect(spin.ty).toBeLessThan(0);
        for (const a of [0.05, 0.5, 2, 3]) {
            const r = wristTorque(aboutZ(a), ident, { x: 5, y: -4, z: 9 }, invI, out());
            expect(Math.hypot(r.tx, r.ty, r.tz)).toBeLessThanOrEqual(GRAB.maxTorque + 1e-9);
        }
        // a heavy log 1 rad off: far more than the cap wanted, so the load reads over 1 (it tips)
        const heavy: Sym3 = { m11: 1 / 60, m12: 0, m13: 0, m22: 1 / 60, m23: 0, m33: 1 / 60 };
        expect(wristTorque(aboutZ(1), ident, zero, heavy, out()).load).toBeGreaterThan(1);
        // a light thing a little off: well within it
        expect(wristTorque(aboutZ(0.02), ident, zero, invI, out()).load).toBeLessThan(0.2);
        // a lower cap for each of two carriers
        const half = wristTorque(aboutZ(1), ident, zero, heavy, out(), GRAB.maxTorque / 2);
        expect(Math.hypot(half.tx, half.ty, half.tz)).toBeCloseTo(GRAB.maxTorque / 2, 6);
    });

    it('turns nothing into NaN', () => {
        const nan = { m11: NaN, m12: 0, m13: 0, m22: 0.5, m23: 0, m33: 0.5 };
        const r = wristTorque(aboutZ(0.3), ident, zero, nan, out());
        expect([r.tx, r.ty, r.tz, r.load].every(Number.isFinite)).toBe(true);
    });
});

/** How far the plank's long axis (local X) points below the horizon (degrees). */
function tilt(q: Quat): number {
    const ax = 1 - 2 * (q.y * q.y + q.z * q.z);
    const ay = 2 * (q.x * q.y + q.w * q.z);
    const az = 2 * (q.x * q.z - q.w * q.y);
    return (Math.atan2(Math.abs(ay), Math.hypot(ax, az)) * 180) / Math.PI;
}

/** The plank's lowest corner (world), for whether it rests on the ground. */
function lowestCorner(q: Quat, p: { x: number; y: number; z: number }) {
    let low = { x: 0, y: Infinity, z: 0 };
    for (const sx of [-1.2, 1.2])
        for (const sy of [-0.1, 0.1])
            for (const sz of [-0.05, 0.05]) {
                const x =
                    (1 - 2 * (q.y * q.y + q.z * q.z)) * sx +
                    2 * (q.x * q.y - q.w * q.z) * sy +
                    2 * (q.x * q.z + q.w * q.y) * sz;
                const y =
                    2 * (q.x * q.y + q.w * q.z) * sx +
                    (1 - 2 * (q.x * q.x + q.z * q.z)) * sy +
                    2 * (q.y * q.z - q.w * q.x) * sz;
                const z =
                    2 * (q.x * q.z - q.w * q.y) * sx +
                    2 * (q.y * q.z + q.w * q.x) * sy +
                    (1 - 2 * (q.x * q.x + q.y * q.y)) * sz;
                if (p.y + y < low.y) low = { x: p.x + x, y: p.y + y, z: p.z + z };
            }
    return low;
}

/**
 * Picks the plank up `offset` m along its length from its middle and holds it up in front for two
 * seconds. Returns how far it tips, the grip's height over the middle's, and the wrist's load.
 */
function holdPlankAt(offset: number) {
    const s = new LabSim();
    for (let n = 0; n < 120; n++) s.step(cmd(n));
    const pl = s.plank;
    const c = { ...pl.pose.p };
    const q = pl.pose.q;
    const before = tilt(q);
    // the grip: along the plank's long axis (local X) from its middle, on its top face
    const ax = 1 - 2 * (q.y * q.y + q.z * q.z);
    const ay = 2 * (q.x * q.y + q.w * q.z);
    const az = 2 * (q.x * q.z - q.w * q.y);
    const grip = { x: c.x + ax * offset, y: c.y + ay * offset + 0.05, z: c.z + az * offset };
    s.fpActive = true;
    s.placePlayer(grip.x, grip.z + 1.4, 0);
    for (let n = 0; n < 10; n++) s.step(cmd(200 + n));
    const eye = s.player.y + EYE_HEIGHT;
    const dist = Math.hypot(eye - grip.y, 1.4);
    s.physics.grabById(pl.id, grip, dist, 0);
    expect(s.physics.heldId).toBe(pl.id);
    // lift it up in front: a person to chest height (looking a little down), a beaver as high as
    // it carries things, looking ahead (its paws at its eye, 1.2 m)
    const liftPitch = PLAYER_BODY === 'beaver' ? 0 : -0.35;
    let maxLoad = 0;
    for (let n = 0; n < 120; n++) {
        s.step(cmd(210 + n, { pitch: liftPitch }));
        maxLoad = Math.max(maxLoad, s.physics.rig(0)!.wristLoad);
    }
    expect(s.physics.heldId).toBe(pl.id);
    const info = { x: 0, y: 0, z: 0, mass: 0, halfWidth: 0, strain: 0 };
    s.physics.heldInfo(0, info);
    return {
        before,
        tipped: tilt(pl.pose.q),
        lifted: pl.pose.p.y - c.y,
        gripAbove: info.y - pl.pose.p.y,
        load: s.physics.rig(0)!.wristLoad,
        maxLoad,
        // its lowest corner, and the ground under that corner (m)
        lowest: lowestCorner(pl.pose.q, pl.pose.p).y,
        groundUnder: (() => {
            const l = lowestCorner(pl.pose.q, pl.pose.p);
            return s.level.terrainHeight(l.x, l.z);
        })()
    };
}

describe('balance: where you pick something up decides how it hangs', () => {
    it('held at its middle, the plank stays as it was picked up', () => {
        const r = holdPlankAt(0);
        expect(r.lifted).toBeGreaterThan(0.3);
        expect(Math.abs(r.tipped - r.before)).toBeLessThan(4);
        expect(r.load).toBeLessThan(0.5);
    });

    it('held off centre, it tips about the hand, and more the further out you grip it', () => {
        const near = holdPlankAt(0.2);
        const mid = holdPlankAt(0.45);
        const end = holdPlankAt(1.0);
        expect(Math.abs(near.tipped - near.before)).toBeLessThan(6);
        expect(mid.tipped).toBeGreaterThan(near.tipped + 20);
        // further out it tips more while it hangs free; a 2.4 m plank gripped by its end hangs 2.2 m
        // below the hand, further than a 1.4 m beaver can lift it, so there it comes to rest with its
        // far end on the ground (and only on it: never sunk into it)
        expect(mid.lowest - mid.groundUnder).toBeGreaterThan(0.02);
        const endResting = end.lowest - end.groundUnder < 0.05;
        if (endResting) expect(end.tipped).toBeGreaterThan(near.tipped + 20);
        else expect(end.tipped).toBeGreaterThan(mid.tipped + 5);
        for (const r of [near, mid, end]) expect(r.lowest - r.groundUnder).toBeGreaterThan(-0.04);
        // gripped by the end, it hangs below the hand, and the wrist is past what it can hold
        expect(end.gripAbove).toBeGreaterThan(0.3);
        expect(end.maxLoad).toBeGreaterThan(1);
    });

    it('the bucket hangs from its handle: no wrist', () => {
        const s = new LabSim();
        for (let n = 0; n < 120; n++) s.step(cmd(n));
        const b = s.bucket.pose.p;
        s.fpActive = true;
        s.placePlayer(b.x, b.z + 1.4, 0);
        for (let n = 0; n < 10; n++) s.step(cmd(200 + n));
        s.physics.grabById(s.bucket.id, { ...b }, 1.6, 0);
        expect(s.physics.heldId).toBe(s.bucket.id);
        for (let n = 0; n < 60; n++) {
            s.step(cmd(210 + n, { pitch: -0.3, yaw: Math.sin(n * 0.1) }));
            expect(s.physics.rig(0)!.wristLoad).toBe(0);
            expect(s.physics.rig(0)!.wristAngle).toBe(0);
        }
    });
});
