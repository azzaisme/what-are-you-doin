import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';

import { UTE_WHEEL_RADIUS } from '../../src/assets/ute.ts';
import { NO_DRIVE, UteVehicle } from '../../src/sim/physics/vehicle.ts';
import type { DriveInput } from '../../src/sim/physics/vehicle.ts';
import { PhysicsWorld, initPhysics } from '../../src/sim/physics/world.ts';
import { pose, quatFromYawPitchRoll } from '../../src/voxels/math.ts';

beforeAll(() => initPhysics());

const flat = () => 0;
function world(): PhysicsWorld {
    const pw = new PhysicsWorld();
    pw.addTerrain(flat, -60, 60, -60, 60, 60);
    pw.killBox = { minX: -60, maxX: 60, minZ: -60, maxZ: 60 };
    return pw;
}
function run(pw: PhysicsWorld, u: UteVehicle, input: DriveInput, ticks: number): void {
    for (let i = 0; i < ticks; i++) {
        u.drive(input);
        pw.step();
    }
}
const yawOf = (q: { x: number; y: number; z: number; w: number }) =>
    Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));

describe('the ute drives (Epic 4)', () => {
    it('settles level on its wheels with the wheels at the asset wheel centres', () => {
        const pw = world();
        const u = new UteVehicle(pw, 1, pose(0, 0.3, 0));
        run(pw, u, NO_DRIVE, 180);
        const b = u.pb.body;
        const p = b.translation();
        expect(b.mass()).toBeGreaterThan(600);
        expect(b.mass()).toBeLessThan(900);
        expect(Math.abs(p.y)).toBeLessThan(0.05);
        for (let i = 0; i < 4; i++) {
            expect(u.wheelInContact(i)).toBe(true);
            expect(Math.abs(u.wheelDrop(i))).toBeLessThan(0.05);
        }
        // at rest: it stays put (the velocity read between ticks holds the gravity the next tick's
        // suspension cancels, so measure the position)
        const p0 = { ...b.translation() };
        run(pw, u, NO_DRIVE, 60);
        const p1 = b.translation();
        expect(Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z)).toBeLessThan(0.001);
        expect(UTE_WHEEL_RADIUS).toBeGreaterThan(0);
    });

    it('accelerates forward (+z) to about its top speed, and brakes to a stop', () => {
        const pw = world();
        const u = new UteVehicle(pw, 1, pose(0, 0.05, -40));
        run(pw, u, NO_DRIVE, 60);
        run(pw, u, { throttle: 1, steer: 0, brake: false }, 60 * 6);
        const p = u.pb.body.translation();
        console.log(
            'after 6 s: z',
            p.z.toFixed(2),
            'x',
            p.x.toFixed(2),
            'speed',
            u.speed().toFixed(2),
            'spin',
            u.spin.toFixed(1)
        );
        expect(p.z).toBeGreaterThan(-40 + 25);
        expect(Math.abs(p.x)).toBeLessThan(0.5);
        expect(u.speed()).toBeGreaterThan(7);
        expect(u.speed()).toBeLessThan(10.5);
        let ticks = 0;
        while (u.speed() > 0.1 && ticks < 600) {
            run(pw, u, { throttle: 0, steer: 0, brake: true }, 1);
            ticks++;
        }
        console.log('stopped in', (ticks / 60).toFixed(2), 's');
        expect(ticks).toBeLessThan(150);
    });

    it('steers: right input turns it right (clockwise from above), left turns it left', () => {
        for (const side of [1, -1]) {
            const pw = world();
            const u = new UteVehicle(pw, 1, pose(0, 0.05, -20));
            run(pw, u, NO_DRIVE, 30);
            run(pw, u, { throttle: 0.6, steer: side, brake: false }, 120);
            const yaw = yawOf(u.pb.body.rotation());
            console.log('steer', side, 'yaw', yaw.toFixed(2), 'pos', u.pb.body.translation().x.toFixed(2));
            // yaw 0 faces +z; turning right (towards -x when facing +z) lowers yaw
            expect(Math.sign(yaw)).toBe(-side);
            expect(Math.abs(yaw)).toBeGreaterThan(0.4);
        }
    });

    it('reverses, and stays upright through a full-lock turn at speed', () => {
        const pw = world();
        const u = new UteVehicle(pw, 1, pose(0, 0.05, 0, quatFromYawPitchRoll(0, 0, 0)));
        run(pw, u, { throttle: -1, steer: 0, brake: false }, 180);
        expect(u.speed()).toBeLessThan(-2);
        expect(u.pb.body.translation().z).toBeLessThan(-3);
        run(pw, u, { throttle: 1, steer: 0, brake: false }, 300);
        run(pw, u, { throttle: 1, steer: 1, brake: false }, 300);
        const q = u.pb.body.rotation();
        // body up axis stays near world up
        const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
        expect(upY).toBeGreaterThan(0.9);
    });
});

describe('wheels load what holds them up (Epic 4 gate)', () => {
    it("a ute parked on a free platform puts its weight on it (the platform's support sees it)", () => {
        const pw = world();
        // a 4 x 0.2 x 6 m platform resting on the ground
        const plat = pw.addDynamic(2, { type: 'box', hx: 2, hy: 0.1, hz: 3 }, pose(0, 0.1, 0), { density: 300 });
        const u = new UteVehicle(pw, 1, pose(0, 0.3, 0));
        run(pw, u, NO_DRIVE, 240);
        const ground = u.groundIds.filter((g) => g === 2).length;
        // vertical reaction per tick, as force
        const n = (u.lastGroundImpulse * 60) / u.weight();
        console.log(
            'on platform wheels',
            ground,
            'reaction/weight',
            n.toFixed(3),
            'platform y',
            plat.body.translation().y.toFixed(3),
            'ute y',
            u.pb.body.translation().y.toFixed(3)
        );
        expect(ground).toBe(4);
        expect(n).toBeGreaterThan(0.9);
        expect(n).toBeLessThan(1.1);
        // the platform is pressed down onto the ground, not lifted or left floating
        expect(plat.body.translation().y).toBeLessThan(0.11);
        expect(plat.body.translation().y).toBeGreaterThan(0.08);
    });

    it('drives across a loose deck laid over a gap: the deck carries it and stays on its supports', () => {
        const pw = new PhysicsWorld();
        // two banks with a 2.4 m gap between them, a 4 m deck laid loose across it
        pw.addStatic(RAPIER.ColliderDesc.cuboid(6, 0.5, 10).setTranslation(0, -0.5, -11.2).setFriction(0.9));
        pw.addStatic(RAPIER.ColliderDesc.cuboid(6, 0.5, 10).setTranslation(0, -0.5, 11.2).setFriction(0.9));
        const deck = pw.addDynamic(2, { type: 'box', hx: 1.2, hy: 0.06, hz: 2 }, pose(0, 0.06, 0), {
            density: 450,
            friction: 0.8
        });
        const u = new UteVehicle(pw, 1, pose(0, 0.3, 6));
        // facing -z, across the deck to the far bank
        u.pb.body.setRotation(quatFromYawPitchRoll(Math.PI, 0, 0), true);
        run(pw, u, NO_DRIVE, 60);
        let onDeck = 0;
        let maxLoad = 0;
        for (let k = 0; k < 60 * 10 && u.pb.body.translation().z > -6; k++) {
            run(pw, u, { throttle: 0.4, steer: 0, brake: false }, 1);
            const n = u.groundIds.filter((g) => g === 2).length;
            onDeck = Math.max(onDeck, n);
            if (n > 0) maxLoad = Math.max(maxLoad, u.lastGroundImpulse * 60);
        }
        const p = u.pb.body.translation();
        const d = deck.body.translation();
        expect(p.z).toBeLessThan(-6);
        expect(p.y).toBeGreaterThan(-0.05);
        expect(onDeck).toBe(4);
        // the deck felt the whole ute at some point, and is still across the gap
        expect(maxLoad).toBeGreaterThan(0.8 * u.weight());
        expect(Math.abs(d.z)).toBeLessThan(0.5);
        expect(d.y).toBeGreaterThan(0);
    });

    it('accelerating on a free platform on ice pushes the platform backwards (momentum is shared)', () => {
        const pw = new PhysicsWorld();
        // ice: a frictionless static floor
        pw.addStatic(RAPIER.ColliderDesc.cuboid(80, 0.5, 80).setTranslation(0, -0.5, 0).setFriction(0));
        const plat = pw.addDynamic(2, { type: 'box', hx: 2, hy: 0.1, hz: 12 }, pose(0, 0.1, 0), {
            density: 300,
            friction: 0
        });
        const u = new UteVehicle(pw, 1, pose(0, 0.3, -6));
        run(pw, u, NO_DRIVE, 120);
        run(pw, u, { throttle: 1, steer: 0, brake: false }, 60);
        const pv = plat.body.linvel().z;
        const uv = u.pb.body.linvel().z;
        const mp = plat.body.mass();
        const mu = u.pb.body.mass();
        console.log(
            'ute v',
            uv.toFixed(2),
            'platform v',
            pv.toFixed(2),
            'momentum sum',
            (mu * uv + mp * pv).toFixed(1),
            'of',
            (mu * uv).toFixed(1)
        );
        expect(uv).toBeGreaterThan(0.5);
        expect(pv).toBeLessThan(-0.1);
        // nearly no net momentum created (the floor is frictionless)
        expect(Math.abs(mu * uv + mp * pv)).toBeLessThan(0.15 * mu * uv);
    });
});

describe('driving the Timber Yard ute with player commands', () => {
    it('get in by looking at it and pressing grab, drive it, brake, get out beside the door', async () => {
        const { LabSim, EYE_HEIGHT, UTE_SEAT } = await import('../../src/sim/lab-sim.ts');
        const { timberYardLevel } = await import('../../src/levels/timber-yard.ts');
        const { neutralCommand } = await import('../../src/sim/commands.ts');
        const s = new LabSim({ level: timberYardLevel });
        let n = 0;
        let yaw = 0;
        let pitch = 0;
        const step = (c: Record<string, unknown> = {}, k = 1) => {
            for (let i = 0; i < k; i++) s.step({ ...neutralCommand(n++, yaw, pitch), ...c });
        };
        step({}, 90);
        s.fpActive = true;
        const ute = s.ute;
        const u0 = { ...ute.pose.p };
        const q = ute.pose.q;
        const uy = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
        // the driver's door: the ute's right side (local -x)
        const sideX = -Math.cos(uy);
        const sideZ = Math.sin(uy);
        s.placePlayer(u0.x + sideX * 2.2, u0.z + sideZ * 2.2, 0);
        step({}, 20);
        // look at the door
        yaw = Math.atan2(sideX, sideZ);
        pitch = -Math.atan2(s.player.y + EYE_HEIGHT - (u0.y + 0.6), 2.2 - 0.8);
        step({}, 5);
        expect(s.driver).toBe(-1);
        step({ grab: true });
        expect(s.driver).toBe(0);
        expect(s.physics.heldId).toBe(-1);
        // the eye is in the seat
        step({}, 10);
        const eyeToUte = Math.hypot(s.player.x - ute.pose.p.x, s.player.z - ute.pose.p.z);
        expect(eyeToUte).toBeLessThan(0.6);
        expect(s.player.y + EYE_HEIGHT - ute.pose.p.y).toBeCloseTo(UTE_SEAT.eyeY, 1);
        // drive forward for 2 s
        step({ moveZ: 1 }, 120);
        const moved = Math.hypot(ute.pose.p.x - u0.x, ute.pose.p.z - u0.z);
        console.log('drove', moved.toFixed(2), 'm, speed', s.vehicle!.speed().toFixed(2));
        expect(moved).toBeGreaterThan(3);
        expect(s.vehicle!.speed()).toBeGreaterThan(2);
        // the wheels turn in the render pose
        expect(Math.abs(ute.anim[0])).toBeGreaterThan(5);
        // brake to a stop
        step({ jump: true }, 120);
        expect(Math.abs(s.vehicle!.speed())).toBeLessThan(0.2);
        // get out: on foot beside the driver's door, walking again
        step({ grab: true });
        expect(s.driver).toBe(-1);
        step({}, 10);
        const dx = s.player.x - ute.pose.p.x;
        const dz = s.player.z - ute.pose.p.z;
        expect(Math.hypot(dx, dz)).toBeGreaterThan(1);
        expect(Math.hypot(dx, dz)).toBeLessThan(2.2);
        const z0 = s.player.z;
        const x0 = s.player.x;
        // still facing the door: step back, away from the ute
        step({ moveZ: -1 }, 30);
        expect(Math.hypot(s.player.x - x0, s.player.z - z0)).toBeGreaterThan(0.5);
        // nobody in it: the handbrake holds it
        const p1 = { ...ute.pose.p };
        step({}, 60);
        expect(Math.hypot(ute.pose.p.x - p1.x, ute.pose.p.z - p1.z)).toBeLessThan(0.05);
    }, 60_000);
});

describe('the ute crosses a beam bridge (Epic 4 gate)', () => {
    it('two loose beams laid under its wheel tracks take its weight over the creek', async () => {
        const { LabSim } = await import('../../src/sim/lab-sim.ts');
        const { timberYardLevel, BRIDGE, BRIDGE_X, YARD_Y } = await import('../../src/levels/timber-yard.ts');
        const { neutralCommand } = await import('../../src/sim/commands.ts');
        const { quatMul } = await import('../../src/voxels/math.ts');
        const { UTE_TRACK_HALF } = await import('../../src/assets/ute.ts');
        const s = new LabSim({ level: timberYardLevel });
        const byName = (n: string) => s.entities.find((e) => e.name === n)!;
        const flatAlongZ = quatMul(quatFromYawPitchRoll(Math.PI / 2, 0, 0), quatFromYawPitchRoll(0, Math.PI / 2, 0));
        const beams = [byName('beam-0'), byName('beam-1')];
        beams.forEach((b, i) =>
            s.physics.place(b.id, pose(BRIDGE_X + (i === 0 ? -1 : 1) * UTE_TRACK_HALF, YARD_Y + 0.12, BRIDGE.zc, flatAlongZ))
        );
        let n = 0;
        for (; n < 60; n++) s.step(neutralCommand(n));
        // the ute on the yard bank, lined up with the bridge, facing the creek (-z)
        const v = s.vehicle!;
        s.physics.place(v.id, pose(BRIDGE_X, YARD_Y + 0.25, BRIDGE.nearEdge + 3.2, quatFromYawPitchRoll(Math.PI, 0, 0)));
        for (; n < 120; n++) s.step(neutralCommand(n));
        // player 1 in the driver's seat, easing forward
        s.fpActive = true;
        s.step(neutralCommand(n++));
        expect(s.takeDriverSeat(0)).toBe(true);
        const seen = new Set<number>();
        let maxLoad = 0;
        // out to the middle of the gap (unfastened 20 cm beams under 24 cm tyres: past here the
        // tyres' sideways push walks a beam out from under a wheel; fastening is Epic 5)
        for (let k = 0; k < 60 * 12 && s.ute.pose.p.z > BRIDGE.zc; k++, n++) {
            // a careful driver keeps the wheels on the beams: steer back onto the line and heading
            const q = s.ute.pose.q;
            const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
            let dy = yaw - Math.PI;
            dy -= Math.round(dy / (2 * Math.PI)) * 2 * Math.PI;
            const steer = Math.max(-1, Math.min(1, 4 * (s.ute.pose.p.x - BRIDGE_X) + 3 * dy));
            s.step({ ...neutralCommand(n, Math.PI), moveZ: 0.35, moveX: steer });
            for (const id of v.groundIds) if (id >= 0) seen.add(id);
            if (v.groundIds.some((id) => id === beams[0].id || id === beams[1].id))
                maxLoad = Math.max(maxLoad, v.lastGroundImpulse * 60);
        }
        const u = s.ute.pose.p;
        // over the middle of the creek, up on the beams (not down in the water)
        expect(u.z).toBeLessThan(BRIDGE.zc + 0.1);
        expect(u.y).toBeGreaterThan(YARD_Y);
        // its wheels stood on both beams and pressed on them with a good share of its weight
        expect(seen.has(beams[0].id)).toBe(true);
        expect(seen.has(beams[1].id)).toBe(true);
        expect(maxLoad).toBeGreaterThan(0.3 * v.weight());
        // the beams are still across the gap afterwards
        for (const b of beams) expect(Math.abs(b.pose.p.z - BRIDGE.zc)).toBeLessThan(0.4);
    }, 60_000);
});
