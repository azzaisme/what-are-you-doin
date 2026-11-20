import { beforeAll, describe, expect, it } from 'vitest';

import { LOG_RADIUS } from '../../src/assets/props.ts';
import { terrainHeight, riverLabLevel } from '../../src/levels/river-lab.ts';
import { ACTION_DROP, ACTION_DROP_TEST, ACTION_NONE, ACTION_RAGDOLL, PITCH_LIMIT, neutralCommand, sanitizeCommand } from '../../src/sim/commands.ts';
import type { PlayerCommand } from '../../src/sim/commands.ts';
import { buildLabPhysics } from '../../src/sim/lab-physics.ts';
import { EYE_HEIGHT, LabSim } from '../../src/sim/lab-sim.ts';
import { GRAB, clampHold, grabForce, throwImpulse, viewDir } from '../../src/sim/physics/grab.ts';
import type { GrabForceResult } from '../../src/sim/physics/grab.ts';
import { PhysicsWorld, RELEASE_MIN_CAP, initPhysics } from '../../src/sim/physics/world.ts';

beforeAll(() => initPhysics());

const PLAY_AREA = riverLabLevel.playArea;

const cmd = (n: number, c: Partial<PlayerCommand> = {}): PlayerCommand => ({ ...neutralCommand(n), ...c });
const zero = { x: 0, y: 0, z: 0 };
const out = (): GrabForceResult => ({ fx: 0, fy: 0, fz: 0, requested: 0, error: 0, saturated: false });

/** First-person sim with the character standing at (x, z) facing yaw. */
function fpSim(x: number, z: number, yaw: number, pitch = 0): LabSim {
    const s = new LabSim();
    s.step(cmd(0));
    s.fpActive = true;
    s.placePlayer(x, z, yaw);
    for (let n = 1; n < 30; n++) s.step(cmd(n, { yaw, pitch }));
    return s;
}

describe('commands are plain, validated data (§6.2)', () => {
    it('sanitizes untrusted numbers, booleans and actions', () => {
        const c = sanitizeCommand({ seq: -3.7, moveX: 9, moveZ: NaN, yaw: 7, pitch: 99, reach: -50, action: 77, jump: 'yes' as unknown as boolean, grab: true });
        expect(c.seq).toBe(0);
        expect(c.moveX).toBe(1);
        expect(c.moveZ).toBe(0);
        expect(c.yaw).toBeCloseTo(7 - 2 * Math.PI, 12);
        expect(c.pitch).toBe(PITCH_LIMIT);
        expect(c.reach).toBe(-1);
        expect(c.action).toBe(ACTION_NONE);
        expect(c.jump).toBe(false);
        expect(c.grab).toBe(true);
        expect(sanitizeCommand(null)).toEqual(neutralCommand());
    });

    it('survives a JSON round trip unchanged (network-shaped)', () => {
        const c = cmd(42, { moveX: 0.5, moveZ: -1, sprint: true, yaw: 1.25, pitch: -0.3, grab: true, reach: 0.4, action: ACTION_RAGDOLL });
        expect(sanitizeCommand(JSON.parse(JSON.stringify(c)))).toEqual(c);
    });
});

describe('grab force bounds (§2.4)', () => {
    it('never exceeds the force cap, however far or fast the target moves', () => {
        for (const d of [0.01, 0.5, 3, 100, 1e6]) {
            for (const m of [0.5, 24, 113, 5000]) {
                const f = grabForce({ mass: m, gravity: 9.81, anchor: zero, anchorVelocity: { x: 0, y: -40, z: 0 }, target: { x: d, y: d, z: -d }, targetVelocity: { x: 30, y: 0, z: 0 } }, out());
                expect(Math.hypot(f.fx, f.fy, f.fz)).toBeLessThanOrEqual(GRAB.maxForce + 1e-6);
                expect(Number.isFinite(f.fx + f.fy + f.fz)).toBe(true);
            }
        }
    });

    it('holds a light object against gravity exactly at the target, without saturating', () => {
        const f = grabForce({ mass: 2, gravity: 9.81, anchor: zero, anchorVelocity: zero, target: zero, targetVelocity: zero }, out());
        expect(f.fy).toBeCloseTo(2 * 9.81, 9);
        expect(f.fx).toBe(0);
        expect(f.saturated).toBe(false);
    });

    it('cannot lift the 113 kg log alone (needs more than the cap)', () => {
        const f = grabForce({ mass: 113, gravity: 9.81, anchor: zero, anchorVelocity: zero, target: { x: 0, y: 0.5, z: 0 }, targetVelocity: zero }, out());
        expect(f.saturated).toBe(true);
        expect(f.requested).toBeGreaterThan(113 * 9.81);
    });

    it('rejects non-finite input instead of producing NaN forces', () => {
        const f = grabForce({ mass: 1, gravity: 9.81, anchor: { x: NaN, y: 0, z: 0 }, anchorVelocity: zero, target: zero, targetVelocity: zero }, out());
        expect([f.fx, f.fy, f.fz]).toEqual([0, 0, 0]);
    });

    it('bounds throws by impulse and hold distance by reach', () => {
        expect(throwImpulse(2)).toBeCloseTo(2 * GRAB.throwSpeed, 9);
        expect(throwImpulse(113)).toBe(GRAB.maxThrowImpulse);
        expect(throwImpulse(0)).toBe(0);
        expect(clampHold(99)).toBe(GRAB.maxHold);
        expect(clampHold(-1)).toBe(GRAB.minHold);
        expect(clampHold(NaN)).toBe(GRAB.minHold);
    });

    it('view direction matches the camera convention (yaw 0 looks along -Z, pitch up is +Y)', () => {
        const d = viewDir(0, 0, { x: 0, y: 0, z: 0 });
        expect(d.z).toBeCloseTo(-1, 12);
        const u = viewDir(Math.PI / 2, 0.3, { x: 0, y: 0, z: 0 });
        expect(u.x).toBeLessThan(-0.9);
        expect(u.y).toBeCloseTo(Math.sin(0.3), 12);
    });
});

describe('physics adapter', () => {
    it('static terrain collision follows the analytic terrain, not voxels (within 2 cm)', () => {
        const pw = buildLabPhysics(riverLabLevel);
        pw.world.step();
        let worst = 0;
        for (let i = 0; i < 200; i++) {
            const x = PLAY_AREA.minX + 1 + ((i * 7.31) % (PLAY_AREA.maxX - PLAY_AREA.minX - 2));
            const z = PLAY_AREA.minZ + 1 + ((i * 3.77) % (PLAY_AREA.maxZ - PLAY_AREA.minZ - 2));
            const g = pw.groundY(x, z, 30);
            expect(g).not.toBeNull();
            // a tree or rock may stand above the ground; only check open terrain
            if (g! - terrainHeight(x, z) < 0.05) worst = Math.max(worst, Math.abs(g! - terrainHeight(x, z)));
        }
        expect(worst).toBeLessThan(0.02);
        pw.free();
    });

    it('props come to rest on the ground: none sink, none fly off', () => {
        const s = new LabSim();
        for (let n = 0; n < 240; n++) s.step(cmd(n));
        for (const e of [s.plank, s.cube, s.bucket]) {
            const g = terrainHeight(e.pose.p.x, e.pose.p.z);
            expect(e.pose.p.y).toBeGreaterThan(g - 0.02);
            expect(e.pose.p.y).toBeLessThan(g + 0.4);
        }
        expect(s.log.pose.p.y).toBeGreaterThan(terrainHeight(s.log.pose.p.x, s.log.pose.p.z) + LOG_RADIUS - 0.25);
        expect(s.physics.stats.recovered).toBe(0);
    });

    it('the character stands on the ground, walks, is stopped by the walls and steps up', () => {
        const s = fpSim(0, 6.5, 0);
        expect(s.player.grounded).toBe(true);
        expect(Math.abs(s.player.y - terrainHeight(s.player.x, s.player.z))).toBeLessThan(0.08);
        // walk towards +Z (yaw pi faces +Z) into the boundary wall
        for (let n = 0; n < 300; n++) s.step(cmd(n, { moveZ: 1, yaw: Math.PI, sprint: true }));
        expect(s.player.z).toBeLessThan(PLAY_AREA.maxZ);
        expect(s.player.z).toBeGreaterThan(PLAY_AREA.maxZ - 1);
        // jump: leaves the ground and lands again
        let maxY = s.player.y;
        const y0 = s.player.y;
        s.step(cmd(1000, { jump: true, yaw: Math.PI }));
        for (let n = 0; n < 90; n++) {
            s.step(cmd(1001 + n, { yaw: Math.PI }));
            maxY = Math.max(maxY, s.player.y);
        }
        expect(maxY - y0).toBeGreaterThan(0.5);
        expect(s.player.grounded).toBe(true);
    });

    it('walks up the 0.3 m terraces on the ridge (step behaviour)', () => {
        // the terraced ridge lies beyond the play-area walls: test the controller on bare terrain
        const pw = new PhysicsWorld();
        pw.addTerrain(terrainHeight, -28, 28, -42, 14, 251);
        pw.createCharacter(2, terrainHeight(2, -22) + 0.05, -22);
        pw.world.step();
        let grounded = 0;
        for (let n = 0; n < 150; n++) {
            pw.moveCharacter(0, -2.2, false);
            pw.step();
            if (pw.character.grounded) grounded++;
        }
        // climbs the first three 0.3 m benches; further up the treads get narrower than a
        // heightfield cell (an effective ~55 deg slope, steeper than the 50 deg climb limit)
        const c = pw.character;
        expect(c.z).toBeLessThan(-24);
        expect(c.y).toBeGreaterThan(terrainHeight(2, -22) + 0.85);
        expect(Math.abs(c.y - terrainHeight(c.x, c.z))).toBeLessThan(0.1);
        expect(grounded).toBe(150);
        pw.free();
    });

    it('grabs the plank it looks at, carries it without exploding, throws it', () => {
        // stand 1.6 m from the resting plank, look down at it
        const s = new LabSim();
        for (let n = 0; n < 120; n++) s.step(cmd(n));
        const pl = s.plank.pose.p;
        s.fpActive = true;
        s.placePlayer(pl.x, pl.z + 1.6, 0);
        const eye = s.player.y + EYE_HEIGHT;
        const pitch = -Math.atan2(eye - pl.y, 1.6);
        for (let n = 0; n < 10; n++) s.step(cmd(200 + n, { pitch }));
        s.step(cmd(300, { grab: true, pitch }));
        expect(s.physics.heldId).toBe(s.plank.id);
        // carry it around: walk, turn quickly, look up and down
        let maxSpeed = 0;
        for (let n = 0; n < 600; n++) {
            // brisk but human turning: up to ~85 deg/s
            const yaw = Math.sin(n * 0.02) * 1.2;
            s.step(cmd(301 + n, { yaw, pitch: Math.sin(n * 0.03) * 0.6, moveZ: n % 200 < 120 ? 1 : 0, sprint: n % 300 > 150 }));
            const v = s.physics.bodies.get(s.plank.id)!.body.linvel();
            maxSpeed = Math.max(maxSpeed, Math.hypot(v.x, v.y, v.z));
            expect(s.physics.stats.grabForce).toBeLessThanOrEqual(GRAB.maxForce + 1e-6);
        }
        expect(s.physics.heldId).toBe(s.plank.id);
        expect(s.physics.stats.grabError).toBeLessThan(0.6);
        // held props never explode: bounded by turning speed x reach, far below the clamp
        expect(maxSpeed).toBeLessThan(15);
        expect(s.physics.stats.linClamps).toBe(0);
        // throw: let go, it flies, lands, stays in the world
        const before = { ...s.plank.pose.p };
        s.step(cmd(1000, { throw: true, pitch: 0.3 }));
        expect(s.physics.heldId).toBe(-1);
        for (let n = 0; n < 180; n++) s.step(cmd(1001 + n));
        expect(Math.hypot(s.plank.pose.p.x - before.x, s.plank.pose.p.z - before.z)).toBeGreaterThan(1);
        expect(s.physics.stats.recovered).toBe(0);
    });

    it('a violent flick drops the held plank rather than flinging it', () => {
        const s = fpSim(0, 8, 0);
        s.step(cmd(100, { carry: true }));
        expect(s.physics.heldId).toBe(s.held.id);
        let maxSpeed = 0;
        for (let n = 0; n < 120; n++) {
            s.step(cmd(101 + n, { carry: true, yaw: Math.sin(n * 0.05) * 2.5 }));
            const v = s.physics.bodies.get(s.held.id)!.body.linvel();
            maxSpeed = Math.max(maxSpeed, Math.hypot(v.x, v.y, v.z));
        }
        expect(s.physics.heldId).toBe(-1);
        expect(s.physics.stats.grabBreaks).toBe(1);
        expect(maxSpeed).toBeLessThan(15);
    });

    it('a snagged grab lets go instead of building energy; Q drops', () => {
        const s = new LabSim();
        for (let n = 0; n < 60; n++) s.step(cmd(n));
        const lg = s.log.pose.p;
        s.fpActive = true;
        s.placePlayer(lg.x, lg.z + 1.4, 0);
        const pitch = -Math.atan2(s.player.y + EYE_HEIGHT - lg.y, 1.4);
        s.step(cmd(100, { grab: true, pitch }));
        expect(s.physics.heldId).toBe(s.log.id);
        // look straight up: the 113 kg log cannot follow, the grab breaks
        for (let n = 0; n < 120 && s.physics.heldId >= 0; n++) s.step(cmd(101 + n, { pitch: 1.4 }));
        expect(s.physics.heldId).toBe(-1);
        expect(s.physics.stats.grabBreaks).toBe(1);
        // grab the crate, then drop it with Q
        const cb = s.cube.pose.p;
        s.placePlayer(cb.x, cb.z + 1.3, 0);
        const p2 = -Math.atan2(s.player.y + EYE_HEIGHT - cb.y, 1.3);
        for (let n = 0; n < 5; n++) s.step(cmd(300 + n, { pitch: p2 }));
        s.step(cmd(310, { grab: true, pitch: p2 }));
        expect(s.physics.heldId).toBe(s.cube.id);
        s.step(cmd(311, { action: ACTION_DROP, pitch: p2 }));
        expect(s.physics.heldId).toBe(-1);
    });

    it('a just-released body cannot be flung by penetration recovery (bounded release speed)', () => {
        const s = fpSim(0, 8, 0);
        s.step(cmd(100, { carry: true }));
        for (let n = 0; n < 30; n++) s.step(cmd(101 + n, { carry: true }));
        s.step(cmd(200, { carry: false }));
        // simulate an ejection impulse right after release
        const b = s.physics.bodies.get(s.held.id)!.body;
        b.setLinvel({ x: 0, y: 0, z: -40 }, true);
        s.step(cmd(201));
        const v = b.linvel();
        expect(Math.hypot(v.x, v.y, v.z)).toBeLessThanOrEqual(RELEASE_MIN_CAP * 1.5 + 1e-6);
        expect(s.physics.stats.releaseClamps).toBeGreaterThan(0);
    });

    it('G puts the carry plank in your grip in front of you; releasing G drops it', () => {
        const s = fpSim(0, 8, 0);
        s.step(cmd(100, { carry: true }));
        expect(s.physics.heldId).toBe(s.held.id);
        expect(s.held.visible).toBe(true);
        for (let n = 0; n < 60; n++) s.step(cmd(101 + n, { carry: true }));
        expect(s.held.pose.p.z).toBeLessThan(s.player.z - 0.6);
        s.step(cmd(200, { carry: false }));
        expect(s.physics.heldId).toBe(-1);
        expect(s.held.visible).toBe(true);
    });

    it('the ragdoll launches, tumbles, settles on the ground with its joints intact', () => {
        const s = new LabSim();
        expect(s.dummyActive).toBe(false);
        s.step(cmd(0, { action: ACTION_RAGDOLL }));
        expect(s.dummyActive).toBe(true);
        for (let n = 1; n < 360; n++) s.step(cmd(n));
        const body = s.dummy[0].pose.p;
        for (const part of s.dummy) {
            // joints hold: every part stays within reach of the body
            expect(Math.hypot(part.pose.p.x - body.x, part.pose.p.y - body.y, part.pose.p.z - body.z)).toBeLessThan(0.75);
            expect(part.pose.p.y).toBeGreaterThan(terrainHeight(part.pose.p.x, part.pose.p.z) - 0.05);
        }
        expect(s.physics.stats.recovered).toBe(0);
    });

    it('physics is deterministic for the same commands, including grabs, throws and the ragdoll', () => {
        const script = (s: LabSim) => {
            s.stressCount = 10;
            s.fpActive = true;
            s.placePlayer(0.6, 5.2, 0);
            for (let n = 0; n < 400; n++) {
                s.step(cmd(n, { moveZ: n < 40 ? 0.5 : 0, pitch: -0.5, yaw: Math.sin(n * 0.02), grab: n === 60, throw: n === 200, action: n === 250 ? ACTION_RAGDOLL : n === 300 ? ACTION_DROP_TEST : ACTION_NONE }));
            }
            return s.entities.map((e) => [e.pose.p.x, e.pose.p.y, e.pose.p.z, e.pose.q.x, e.pose.q.y, e.pose.q.z, e.pose.q.w]);
        };
        expect(script(new LabSim())).toEqual(script(new LabSim()));
    });

    it('25 stress bodies keep moving and stay in the world', () => {
        const s = new LabSim();
        s.stressCount = 25;
        let minActive = 99;
        for (let n = 0; n < 900; n++) {
            s.step(cmd(n));
            if (n > 300) minActive = Math.min(minActive, s.physics.stats.activeBodies);
        }
        expect(s.physics.stats.enabledBodies).toBeGreaterThanOrEqual(25);
        expect(minActive).toBeGreaterThan(0);
        expect(s.stress.every((e) => e.visible)).toBe(true);
        s.stressCount = 0;
        s.step(cmd(901));
        expect(s.stress.some((e) => e.visible)).toBe(false);
    });

    it('scripted props mode keeps the Epic 1 motion and disables prop bodies', () => {
        const a = new LabSim({ props: 'scripted' });
        a.runTo(300);
        expect(a.physics.bodies.has(a.plank.id)).toBe(false);
        expect(a.plank.pose.p.y).toBeGreaterThan(1.2); // the hovering specimen
        const b = new LabSim();
        b.setPropsMode('scripted');
        b.runTo(300);
        expect(b.plank.pose).toEqual(a.plank.pose);
    });
});
