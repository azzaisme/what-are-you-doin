import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';

import { GROUND, JointGraph, NAIL } from '../../src/sim/joints/graph.ts';
import { JointSystem } from '../../src/sim/joints/joints.ts';
import { PhysicsWorld, initPhysics } from '../../src/sim/physics/world.ts';
import type { BodyOptions } from '../../src/sim/physics/world.ts';
import { pose, quatFromYawPitchRoll } from '../../src/voxels/math.ts';

beforeAll(() => initPhysics());

const ident = { x: 0, y: 0, z: 0, w: 1 };
const zero = { x: 0, y: 0, z: 0 };
const TIMBER: BodyOptions = { density: 500, friction: 0.7, nailable: true };

/** Yaw and pitch that look from `eye` at `at`. */
function aim(eye: { x: number; y: number; z: number }, at: { x: number; y: number; z: number }) {
    const dx = at.x - eye.x;
    const dy = at.y - eye.y;
    const dz = at.z - eye.z;
    return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
}

/** Swings a hammer from 0.9 m above and 0.3 m to the +z side of a point, at it. */
function hammerAt(js: JointSystem, at: { x: number; y: number; z: number }, tick = 0) {
    const eye = { x: at.x, y: at.y + 0.9, z: at.z + 0.3 };
    const { yaw, pitch } = aim(eye, at);
    return js.nail(eye, yaw, pitch, 0, tick);
}
function previewAt(js: JointSystem, at: { x: number; y: number; z: number }) {
    const eye = { x: at.x, y: at.y + 0.9, z: at.z + 0.3 };
    const { yaw, pitch } = aim(eye, at);
    return js.preview(eye, yaw, pitch, 0);
}

function world(): PhysicsWorld {
    const pw = new PhysicsWorld();
    pw.addTerrain(() => 0, -20, 20, -20, 20, 40);
    pw.createCharacter(0, 0, 8, 0);
    return pw;
}
const run = (pw: PhysicsWorld, n: number) => {
    for (let i = 0; i < n; i++) pw.step();
};

describe('joint graph (#47)', () => {
    const base = { type: 'nail' as const, anchorA: zero, anchorB: zero, rel: ident, stiffness: 1, tick: 0 };

    it('keeps one connection per pair and refuses self links and ground-to-ground', () => {
        const g = new JointGraph();
        const c = g.add({ ...base, a: 1, b: 2, nails: [zero] });
        expect(c).not.toBeNull();
        expect(g.add({ ...base, a: 2, b: 1, nails: [zero] })).toBeNull();
        expect(g.add({ ...base, a: 1, b: 1, nails: [zero] })).toBeNull();
        expect(g.add({ ...base, a: GROUND, b: GROUND, nails: [zero] })).toBeNull();
        expect(g.size).toBe(1);
        expect(g.find(2, 1)).toBe(c);
        expect(c!.strength).toBe(NAIL.strength);
        expect(c!.fatigue).toBe(0);
    });

    it('takes more nails at new spots as strength, refuses the same spot and past the limit', () => {
        const g = new JointGraph();
        const c = g.add({ ...base, a: 1, b: 2, nails: [zero] })!;
        const v0 = g.version;
        expect(g.addNail(c.id, { x: 0.01, y: 0, z: 0 })).toBe('same-spot');
        expect(g.version).toBe(v0);
        expect(g.addNail(c.id, { x: 0.1, y: 0, z: 0 })).toBe('none');
        expect(c.strength).toBe(2 * NAIL.strength);
        for (let k = 2; k < NAIL.maxPerJoint; k++)
            expect(g.addNail(c.id, { x: 0.1 * (k + 1), y: 0, z: 0 })).toBe('none');
        expect(g.addNail(c.id, { x: 2, y: 0, z: 0 })).toBe('full');
        expect(g.nailCount).toBe(NAIL.maxPerJoint);
        expect(g.version).toBeGreaterThan(v0);
    });

    it('knows which pieces hang together and whether they are anchored', () => {
        const g = new JointGraph();
        g.add({ ...base, a: 1, b: 2, nails: [zero] });
        g.add({ ...base, a: 3, b: 2, nails: [zero] });
        g.add({ ...base, a: 5, b: 6, nails: [zero] });
        expect([...g.group(1).bodies].sort()).toEqual([1, 2, 3]);
        expect(g.group(1).anchored).toBe(false);
        g.add({ ...base, type: 'anchor', a: 3, b: GROUND, nails: [zero] });
        expect(g.group(2).anchored).toBe(true);
        expect(g.group(5).anchored).toBe(false);
        g.remove(g.find(3, GROUND)!.id);
        expect(g.group(1).anchored).toBe(false);
    });

    it('treats ground as separate anchor sites: one beam can be anchored at both ends', () => {
        const g = new JointGraph();
        const near = g.add({
            ...base,
            type: 'anchor',
            a: 1,
            b: GROUND,
            anchorB: { x: 0, y: 0, z: 1.5 },
            nails: [zero]
        });
        expect(
            g.add({ ...base, type: 'anchor', a: 1, b: GROUND, anchorB: { x: 0, y: 0, z: 1.3 }, nails: [zero] })
        ).toBeNull();
        const far = g.add({
            ...base,
            type: 'anchor',
            a: 1,
            b: GROUND,
            anchorB: { x: 0, y: 0, z: -1.5 },
            nails: [zero]
        });
        expect(far).not.toBeNull();
        expect(g.find(1, GROUND, { x: 0, y: 0, z: 1.4 })).toBe(near);
        expect(g.find(1, GROUND, { x: 0, y: 0, z: -1.4 })).toBe(far);
        expect(g.find(1, GROUND, { x: 0, y: 0, z: 0 })).toBeUndefined();
    });
});

describe('hammer and nails (#48)', () => {
    it('nails a plank lying on a stone block to it: an anchor that holds against a pull', () => {
        const pw = world();
        pw.addStatic(RAPIER.ColliderDesc.cuboid(1, 0.25, 1).setTranslation(0, 0.25, 0));
        pw.addDynamic(1, { type: 'box', hx: 1.2, hy: 0.05, hz: 0.1 }, pose(0, 0.56, 0), TIMBER);
        run(pw, 60);
        const js = new JointSystem(pw);
        const pv = previewAt(js, { x: 0.5, y: 0.55, z: 0 });
        expect(pv.a).toBe(1);
        expect(pv.b).toBe(GROUND);
        expect(pv.refusal).toBe('none');
        hammerAt(js, { x: 0.5, y: 0.55, z: 0 });
        expect(js.graph.size).toBe(1);
        const c = js.graph.find(1, GROUND)!;
        expect(c.type).toBe('anchor');
        // a hard sideways shove for a second: an unfastened plank would slide right off
        const b = pw.bodies.get(1)!.body;
        const p0 = { ...b.translation() };
        for (let i = 0; i < 60; i++) {
            b.applyImpulse({ x: 0, y: 0, z: 200 / 60 }, true);
            pw.step();
        }
        const p1 = b.translation();
        expect(Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z)).toBeLessThan(0.02);
        // the same spot again is refused; a new spot reinforces the same connection
        expect(previewAt(js, { x: 0.5, y: 0.55, z: 0 }).refusal).toBe('same-spot');
        hammerAt(js, { x: 0.3, y: 0.55, z: 0 });
        expect(js.graph.size).toBe(1);
        expect(c.nails.length).toBe(2);
        // a metre along is another anchor site
        hammerAt(js, { x: -0.5, y: 0.55, z: 0 });
        expect(js.graph.size).toBe(2);
    });

    it('nails a plank across another: they move as one piece', () => {
        const pw = world();
        pw.addDynamic(1, { type: 'box', hx: 1.2, hy: 0.05, hz: 0.1 }, pose(0, 0.05, 0), TIMBER);
        pw.addDynamic(
            2,
            { type: 'box', hx: 1.2, hy: 0.05, hz: 0.1 },
            pose(0, 0.15, 0, quatFromYawPitchRoll(Math.PI / 2, 0, 0)),
            TIMBER
        );
        run(pw, 60);
        const js = new JointSystem(pw);
        const pv = hammerAt(js, { x: 0, y: 0.2, z: 0 });
        expect(pv.refusal).toBe('none');
        expect(pv.a).toBe(2);
        expect(pv.b).toBe(1);
        // lift the top plank by one end: the bottom one comes along
        const top = pw.bodies.get(2)!.body;
        const bottom = pw.bodies.get(1)!.body;
        for (let i = 0; i < 90; i++) {
            top.applyImpulseAtPoint(
                { x: 0, y: ((top.mass() + bottom.mass()) * 9.81 * 1.3) / 60, z: 0 },
                top.translation(),
                true
            );
            pw.step();
        }
        expect(bottom.translation().y).toBeGreaterThan(0.3);
        const dy = top.translation().y - bottom.translation().y;
        expect(dy).toBeGreaterThan(0.08);
        expect(dy).toBeLessThan(0.12);
    });

    it('refuses a gap, a glancing blow, something too thick, non-timber, and a body sliding past', () => {
        const pw = world();
        pw.addStatic(RAPIER.ColliderDesc.cuboid(1, 0.25, 1).setTranslation(0, 0.25, 0));
        // a plank held 10 cm above the block: a gap (kinematic-like: no gravity)
        const hover = pw.addDynamic(1, { type: 'box', hx: 1.2, hy: 0.05, hz: 0.1 }, pose(0, 0.65, 0), TIMBER);
        hover.body.setGravityScale(0, true);
        run(pw, 1);
        const js = new JointSystem(pw);
        expect(previewAt(js, { x: 0, y: 0.7, z: 0 }).refusal).toBe('gap');
        // a log on the block is too thick to nail down through
        pw.place(1, pose(0, -5, 5));
        pw.addDynamic(2, { type: 'cylinder', axis: 'x', r: 0.2, half: 1 }, pose(0, 0.71, 0), {
            ...TIMBER,
            friction: 1
        });
        pw.bodies.get(2)!.body.setGravityScale(0, true);
        run(pw, 1);
        expect(previewAt(js, { x: 0, y: 0.91, z: 0 }).refusal).toBe('too-thick');
        pw.place(2, pose(5, -5, 5));
        // a crate that is not timber
        pw.addDynamic(3, { type: 'box', hx: 0.2, hy: 0.05, hz: 0.2 }, pose(0, 0.55, 0), { density: 300 });
        pw.bodies.get(3)!.body.setGravityScale(0, true);
        run(pw, 1);
        const pv = previewAt(js, { x: 0, y: 0.6, z: 0 });
        expect(pv.a).toBe(3);
        expect(pv.refusal).toBe('not-timber');
        pw.place(3, pose(-5, -5, 5));
        // a plank sliding across the block
        pw.addDynamic(4, { type: 'box', hx: 1.2, hy: 0.05, hz: 0.1 }, pose(0, 0.55, 0), TIMBER);
        pw.bodies.get(4)!.body.setGravityScale(0, true);
        pw.bodies.get(4)!.body.setLinvel({ x: 1, y: 0, z: 0 }, true);
        run(pw, 1);
        expect(previewAt(js, { x: 0, y: 0.6, z: 0 }).refusal).toBe('moving');
        // a glancing look along the top face
        pw.bodies.get(4)!.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        const eye = { x: 0, y: 0.62, z: 2 };
        const { yaw, pitch } = aim(eye, { x: 0, y: 0.6, z: 0 });
        expect(js.preview(eye, yaw, pitch, 0).refusal).toBe('glancing');
        // nothing at all was fastened
        expect(js.graph.size).toBe(0);
    });

    it('a nailed piece put elsewhere (respawn, recovery) comes loose', () => {
        const pw = world();
        pw.addStatic(RAPIER.ColliderDesc.cuboid(1, 0.25, 1).setTranslation(0, 0.25, 0));
        pw.addDynamic(1, { type: 'box', hx: 1.2, hy: 0.05, hz: 0.1 }, pose(0, 0.56, 0), TIMBER);
        run(pw, 30);
        const js = new JointSystem(pw);
        hammerAt(js, { x: 0.5, y: 0.55, z: 0 });
        expect(js.graph.size).toBe(1);
        pw.respawn(1);
        expect(js.graph.size).toBe(0);
        expect(pw.world.impulseJoints.len()).toBe(0);
    });
});

const neutralCommandFor = (s: { tick: number; player: { yaw: number } }) => ({
    seq: s.tick + 1,
    moveX: 0,
    moveZ: 0,
    sprint: false,
    jump: false,
    yaw: s.player.yaw,
    pitch: 0,
    carry: false,
    grab: false,
    throw: false,
    reach: 0,
    action: 0
});

/** Lays both yard beams across the creek under the ute's wheel tracks, nails them (or not), drives. */
async function beamCrossing(nailed: boolean) {
    const { LabSim } = await import('../../src/sim/lab-sim.ts');
    const { timberYardLevel, BRIDGE, BRIDGE_X, YARD_Y } = await import('../../src/levels/timber-yard.ts');
    const { neutralCommand } = await import('../../src/sim/commands.ts');
    const { quatMul } = await import('../../src/voxels/math.ts');
    const { UTE_TRACK_HALF } = await import('../../src/assets/ute.ts');
    const s = new LabSim({ level: timberYardLevel });
    const byName = (n: string) => s.entities.find((e) => e.name === n)!;
    const flatAlongZ = quatMul(quatFromYawPitchRoll(Math.PI / 2, 0, 0), quatFromYawPitchRoll(0, Math.PI / 2, 0));
    const beams = [byName('beam-0'), byName('beam-1')];
    const xs = [BRIDGE_X - UTE_TRACK_HALF, BRIDGE_X + UTE_TRACK_HALF];
    // dropped from just above both capstones (the far one is 10 cm higher)
    beams.forEach((b, i) => s.physics.place(b.id, pose(xs[i], YARD_Y + 0.3, BRIDGE.zc, flatAlongZ)));
    let n = 0;
    for (; n < 60; n++) s.step(neutralCommand(n));
    const refusals: string[] = [];
    if (nailed) {
        // a nail through each beam end into its abutment's capstone
        for (let i = 0; i < 2; i++) {
            for (const end of [-1, 1]) {
                const z = BRIDGE.zc + end * (BRIDGE.gap / 2 + 0.13);
                const pv = hammerAt(s.joints, { x: xs[i], y: beams[i].pose.p.y + 0.12, z }, n);
                refusals.push(pv.b === GROUND ? pv.refusal : `b=${pv.b}`);
            }
        }
    }
    const joints = s.joints.graph.size;
    const v = s.vehicle!;
    s.physics.place(v.id, pose(BRIDGE_X, YARD_Y + 0.25, BRIDGE.nearEdge + 3.2, quatFromYawPitchRoll(Math.PI, 0, 0)));
    for (; n < 120; n++) s.step(neutralCommand(n));
    s.fpActive = true;
    s.step(neutralCommand(n++));
    expect(s.takeDriverSeat(0)).toBe(true);
    let maxLoad = 0;
    let minY = Infinity;
    const target = BRIDGE.farEdge - 2.5;
    for (let k = 0; k < 60 * 20 && s.ute.pose.p.z > target; k++, n++) {
        // a careful driver keeps the wheels on the beams: steer back onto the line and heading
        const q = s.ute.pose.q;
        const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
        let dy = yaw - Math.PI;
        dy -= Math.round(dy / (2 * Math.PI)) * 2 * Math.PI;
        const steer = Math.max(-1, Math.min(1, 4 * (BRIDGE_X - s.ute.pose.p.x) + 3 * dy));
        s.step({ ...neutralCommand(n, Math.PI), moveZ: 0.35, moveX: steer });
        if (v.groundIds.some((id) => id === beams[0].id || id === beams[1].id))
            maxLoad = Math.max(maxLoad, v.lastGroundImpulse * 60);
        const u = s.ute.pose.p;
        if (u.z < BRIDGE.nearFace && u.z > BRIDGE.farFace) minY = Math.min(minY, u.y);
    }
    const u = s.ute.pose.p;
    const beamDrift = beams.map((b, i) => Math.hypot(b.pose.p.x - xs[i], b.pose.p.z - BRIDGE.zc));
    console.log(
        nailed ? 'nailed' : 'loose',
        'ute reached z',
        u.z.toFixed(2),
        'far bank target',
        target.toFixed(2),
        'min y over gap',
        (minY - YARD_Y).toFixed(3),
        'max beam load / weight',
        (maxLoad / v.weight()).toFixed(2),
        'beam drift',
        beamDrift.map((d) => d.toFixed(3)).join(' ')
    );
    return { s, u, target, minY, maxLoad, weight: v.weight(), beamDrift, refusals, joints, YARD_Y, beams };
}

describe('placed setup: two beams put on the wheel lines and nailed by direct hammer calls carry the ute', () => {
    it('two beams nailed to both abutments: the ute drives from bank to bank', async () => {
        const r = await beamCrossing(true);
        expect(r.refusals).toEqual(['none', 'none', 'none', 'none']);
        // one anchor at each end of each beam
        expect(r.joints).toBe(4);
        // on the far bank, and it never dropped into the creek on the way
        expect(r.u.z).toBeLessThan(r.target);
        expect(r.minY).toBeGreaterThan(r.YARD_Y - 0.1);
        expect(r.maxLoad).toBeGreaterThan(0.3 * r.weight);
        // the bridge is still there, both beams still fastened at both ends
        for (const d of r.beamDrift) expect(d).toBeLessThan(0.05);
        expect(r.s.joints.graph.size).toBe(4);
    }, 60_000);

    it('is deterministic: the same nails and drive end in the same place', async () => {
        const a = await beamCrossing(true);
        const b = await beamCrossing(true);
        expect(b.u.x).toBe(a.u.x);
        expect(b.u.y).toBe(a.u.y);
        expect(b.u.z).toBe(a.u.z);
        expect(b.beamDrift).toEqual(a.beamDrift);
    }, 60_000);

    it('the same beams left loose are not held: a sideways shove after the crossing moves them, nailed ones not', async () => {
        const shove = (r: Awaited<ReturnType<typeof beamCrossing>>) => {
            const before = r.beams.map((b) => ({ ...b.pose.p }));
            for (let k = 0; k < 60; k++) {
                for (const b of r.beams)
                    r.s.physics.bodies.get(b.id)!.body.applyImpulse({ x: 400 / 60, y: 0, z: 0 }, true);
                r.s.step(neutralCommandFor(r.s));
            }
            return Math.max(...r.beams.map((b, i) => Math.hypot(b.pose.p.x - before[i].x, b.pose.p.z - before[i].z)));
        };
        const loose = shove(await beamCrossing(false));
        const nailed = shove(await beamCrossing(true));
        console.log(
            `400 N sideways for 1 s after the crossing: loose beams move ${(loose * 1000).toFixed(0)} mm, nailed ${(nailed * 1000).toFixed(1)} mm`
        );
        expect(loose).toBeGreaterThan(0.05);
        expect(nailed).toBeLessThan(0.01);
    }, 60_000);
});

describe('nails on the wire and from player input (#48, #53)', () => {
    it('nail marks survive the wire; malformed bytes are rejected', async () => {
        const { decodeNails, encodeNails } = await import('../../src/sim/joints/wire.ts');
        const marks = [
            { a: 3, b: -1, x: 0.123, y: -0.05, z: 1.5 },
            { a: 7, b: 3, x: -1.6, y: 0.1, z: 0 }
        ];
        const back = decodeNails(encodeNails(marks), 10)!;
        expect(back.length).toBe(2);
        expect(back[0].b).toBe(-1);
        expect(back[1].b).toBe(3);
        for (let i = 0; i < 2; i++) {
            expect(back[i].a).toBe(marks[i].a);
            expect(Math.abs(back[i].x - marks[i].x)).toBeLessThan(0.001);
            expect(Math.abs(back[i].z - marks[i].z)).toBeLessThan(0.001);
        }
        // an entity index this build doesn't have is dropped; garbage is refused
        expect(decodeNails(encodeNails(marks), 5)!.length).toBe(1);
        expect(decodeNails(new Uint8Array([9, 1, 0]), 10)).toBeNull();
        expect(decodeNails(new Uint8Array([1, 200, 0]), 10)).toBeNull();
    });

    /** The yard with both beams laid across the creek; a player on the near bank looking at beam-0's end. */
    async function yard() {
        const { LabSim, EYE_HEIGHT } = await import('../../src/sim/lab-sim.ts');
        const { timberYardLevel, BRIDGE, BRIDGE_X, YARD_Y } = await import('../../src/levels/timber-yard.ts');
        const { neutralCommand } = await import('../../src/sim/commands.ts');
        const { quatMul } = await import('../../src/voxels/math.ts');
        const { UTE_TRACK_HALF } = await import('../../src/assets/ute.ts');
        const s = new LabSim({ level: timberYardLevel });
        const flatAlongZ = quatMul(quatFromYawPitchRoll(Math.PI / 2, 0, 0), quatFromYawPitchRoll(0, Math.PI / 2, 0));
        const beam = s.entities.find((e) => e.name === 'beam-0')!;
        const x = BRIDGE_X - UTE_TRACK_HALF;
        s.physics.place(beam.id, pose(x, YARD_Y + 0.3, BRIDGE.zc, flatAlongZ));
        for (let n = 0; n < 60; n++) s.step(neutralCommand(n));
        // well back from the face: a nail slanting towards the creek must still come out in stone
        const at = { x, y: beam.pose.p.y + 0.1, z: BRIDGE.nearFace + 0.22 };
        const look = (i: number) => {
            const p = s.players[i];
            return aim({ x: p.x, y: p.y + EYE_HEIGHT, z: p.z }, at);
        };
        return { s, beam, x, BRIDGE, look, neutralCommand };
    }

    it('F on the beam end lying on the abutment nails it down (sanitized command path)', async () => {
        const { ACTION_NAIL } = await import('../../src/sim/commands.ts');
        const { s, beam, x, BRIDGE, look, neutralCommand } = await yard();
        s.fpActive = true;
        s.placePlayer(x + 0.1, BRIDGE.nearEdge + 0.05, 0, 0);
        let n = 100;
        for (let k = 0; k < 30; k++) s.step(neutralCommand(n++));
        const { yaw, pitch } = look(0);
        s.step({ ...neutralCommand(n++, yaw, pitch) });
        // the prompt says it would hold, and where
        const ids = s.interactionIds(0);
        expect(ids.nail).toBe(1);
        expect(ids.nailAt).not.toBeNull();
        s.step({ ...neutralCommand(n++, yaw, pitch), action: ACTION_NAIL });
        expect(s.joints.graph.size).toBe(1);
        const c = [...s.joints.graph.connections()][0];
        expect(c.a).toBe(beam.id);
        expect(c.b).toBe(GROUND);
        // a second blow at the same spot is refused (no duplicate)
        s.step({ ...neutralCommand(n++, yaw, pitch), action: ACTION_NAIL });
        expect(s.joints.graph.nailCount).toBe(1);
        expect(s.interactionIds(0).nail).toBeGreaterThan(1);
        // reset props puts the beam back where it started, loose
        const { ACTION_RESET_PROPS } = await import('../../src/sim/commands.ts');
        s.step({ ...neutralCommand(n++, yaw, pitch), action: ACTION_RESET_PROPS });
        expect(s.joints.graph.size).toBe(0);
    });

    it('a guest swings the hammer online: the host fastens it and every guest gets the nail', async () => {
        const { ACTION_NAIL } = await import('../../src/sim/commands.ts');
        const { GuestSession, HostSession, listGames } = await import('../../src/net/session.ts');
        const { MemoryHub } = await import('../../src/net/transport.ts');
        const { LabSim } = await import('../../src/sim/lab-sim.ts');
        const { timberYardLevel } = await import('../../src/levels/timber-yard.ts');
        const { s: host, beam, x, BRIDGE, look, neutralCommand } = await yard();
        const hub = new MemoryHub();
        host.fpActive = true;
        const hs = await HostSession.start(hub.transport('host'), host, 'yard', 'nail');
        const ad = listGames(hub.channel('lobby', 'watcher'))[0];
        const guests = [];
        for (let k = 0; k < 2; k++)
            guests.push(await GuestSession.join(hub.transport(`g${k}`), new LabSim({ level: timberYardLevel }), ad));
        expect(guests[0].slot).toBe(1);
        // where the solo test stands: close enough to look at the spot square on (eye 1.22 m up)
        host.placePlayer(x + 0.1, BRIDGE.nearEdge + 0.05, 0, 1);
        let n = host.tick;
        const tick = (guestCmd: ReturnType<typeof neutralCommand>) => {
            guests[0].sendInput(guestCmd);
            host.step(neutralCommand(n), hs.commandFor(1), [hs.commandFor(2), hs.commandFor(3)]);
            hs.afterStep((slot) => host.interactionIds(slot));
            n++;
        };
        for (let k = 0; k < 30; k++) tick(neutralCommand(n));
        const { yaw, pitch } = look(1);
        for (let k = 0; k < 6; k++) tick(neutralCommand(n, yaw, pitch));
        // the guest's prompt comes from the host: a nail would hold here
        expect(guests[0].hud[1].nail).toBe(1);
        tick({ ...neutralCommand(n, yaw, pitch), action: ACTION_NAIL });
        for (let k = 0; k < 6; k++) tick(neutralCommand(n, yaw, pitch));
        expect(host.joints.graph.size).toBe(1);
        expect([...host.joints.graph.connections()][0].a).toBe(beam.id);
        const beamIndex = host.entities.indexOf(beam);
        for (const g of guests) {
            expect(g.nails.length).toBe(1);
            expect(g.nails[0].a).toBe(beamIndex);
            expect(g.nails[0].b).toBe(-1);
        }
        hs.stop();
    });
});

describe('placed setup: the player, put beside each beam, shoulders it onto a wheel line and nails it with F', () => {
    it('shoulder both beams onto the wheel lines and nail them down with F: they hold', async () => {
        const { LabSim, EYE_HEIGHT } = await import('../../src/sim/lab-sim.ts');
        const { timberYardLevel, BRIDGE, BRIDGE_X } = await import('../../src/levels/timber-yard.ts');
        const { ACTION_NAIL, neutralCommand } = await import('../../src/sim/commands.ts');
        const { UTE_TRACK_HALF } = await import('../../src/assets/ute.ts');
        type Cmd = ReturnType<typeof neutralCommand>;
        const s = new LabSim({ level: timberYardLevel });
        const byName = (name: string) => s.entities.find((e) => e.name === name)!;
        let n = 0;
        let yaw = 0;
        let pitch = 0;
        const step = (c: Partial<Cmd> = {}, k = 1) => {
            for (let i = 0; i < k; i++) s.step({ ...neutralCommand(n++), yaw, pitch, ...c });
        };
        const ease = (to: number, k: number, set: (v: number) => void, from: number) => {
            for (let i = 1; i <= k; i++) {
                set(from + ((to - from) * i) / k);
                step();
            }
        };
        const goTo = (x: number, zStop: number) => {
            // line up carefully (within 1.5 cm): the beam goes down where you stand
            for (let i = 0; i < 900 && Math.abs(s.player.x - x) > 0.015; i++) {
                const d = x - s.player.x;
                step({ moveX: Math.max(-0.4, Math.min(0.4, d * 4)) });
            }
            for (let i = 0; i < 900 && s.player.z > zStop; i++) step({ moveZ: 0.5 });
            step({}, 30);
        };
        step({}, 60);
        s.fpActive = true;
        const lines = [BRIDGE_X - UTE_TRACK_HALF, BRIDGE_X + UTE_TRACK_HALF];
        const beams = [byName('beam-0'), byName('beam-1')];
        for (let b = 0; b < 2; b++) {
            const beam = beams[b];
            // the yard playthrough's carry: take it by its +x end on the shoulder, turn to the creek
            yaw = Math.PI / 2;
            s.placePlayer(beam.pose.p.x + 2.4, beam.pose.p.z, yaw);
            step({}, 20);
            pitch = -Math.atan2(s.player.y + EYE_HEIGHT - beam.pose.p.y, s.player.x - (beam.pose.p.x + 1.45));
            step({}, 5);
            step({ grab: true });
            expect(s.physics.heldId).toBe(beam.id);
            ease(-0.25, 40, (v) => (pitch = v), pitch);
            step({}, 30);
            ease(0, 120, (v) => (yaw = v), yaw);
            goTo(lines[b], BRIDGE.nearEdge + 0.4);
            ease(-0.7, 40, (v) => (pitch = v), pitch);
            step({}, 30);
            step({ grab: true });
            step({}, 120);
            expect(s.physics.heldId).toBe(-1);
            expect(Math.abs(beam.pose.p.z - BRIDGE.zc)).toBeLessThan(0.3);
            // step up to the beam where it lies on the near abutment (close enough to look at the
            // spot within 30 degrees of straight down, whatever your eye height), look, swing
            const at = { x: beam.pose.p.x, y: beam.pose.p.y + 0.1, z: BRIDGE.nearFace + 0.22 };
            const near = () => s.player.y + EYE_HEIGHT - at.y;
            for (let i = 0; i < 300 && Math.hypot(at.x - s.player.x, at.z - s.player.z) > 0.55 * near(); i++)
                step({ moveZ: 0.3 });
            step({}, 20);
            const eye = { x: s.player.x, y: s.player.y + EYE_HEIGHT, z: s.player.z };
            ({ yaw, pitch } = aim(eye, at));
            step({}, 3);
            expect(s.interactionIds(0).nail, `beam ${b}: ${JSON.stringify(s.nailPreview(0))}`).toBe(1);
            step({ action: ACTION_NAIL });
            // and a second nail beside it
            ({ yaw, pitch } = aim(eye, { ...at, z: at.z + 0.08 }));
            step({}, 3);
            step({ action: ACTION_NAIL });
            yaw = pitch = 0;
            step({}, 10);
        }
        expect(s.joints.graph.size).toBe(2);
        expect(s.joints.graph.nailCount).toBe(4);
        expect(s.progress.falls).toBe(0);
        for (const c of s.joints.graph.connections()) expect(c.b).toBe(GROUND);
        // nailed down: a hard sideways shove (a tyre walking it) for a second moves neither beam
        const before = beams.map((b) => ({ ...b.pose.p }));
        for (let k = 0; k < 60; k++) {
            for (const b of beams) s.physics.bodies.get(b.id)!.body.applyImpulse({ x: 400 / 60, y: 0, z: 0 }, true);
            step();
        }
        beams.forEach((b, i) => {
            const d = Math.hypot(b.pose.p.x - before[i].x, b.pose.p.y - before[i].y, b.pose.p.z - before[i].z);
            console.log(
                `placed setup, beams nailed with F: beam ${i} moved ${(d * 1000).toFixed(1)} mm under a 400 N shove`
            );
            expect(d).toBeLessThan(0.01);
        });
    }, 120_000);
});

describe('hammer refusals and limits (#48 audit)', () => {
    /** A 2.4 m plank resting on a 2 m stone block, still, with the query pipeline up to date. */
    function plankOnBlock(under?: (pw: PhysicsWorld) => void) {
        const pw = world();
        if (under) under(pw);
        else pw.addStatic(RAPIER.ColliderDesc.cuboid(1, 0.25, 1).setTranslation(0, 0.25, 0));
        const pb = pw.addDynamic(1, { type: 'box', hx: 1.2, hy: 0.05, hz: 0.1 }, pose(0, 0.551, 0), TIMBER);
        pb.body.setGravityScale(0, true);
        run(pw, 1);
        return { pw, js: new JointSystem(pw) };
    }
    /** Looks at a point from 1 m away, `deg` degrees off straight down (towards +z). */
    function previewAtAngle(js: JointSystem, at: { x: number; y: number; z: number }, deg: number) {
        const r = (deg * Math.PI) / 180;
        const eye = { x: at.x, y: at.y + Math.cos(r), z: at.z + Math.sin(r) };
        const { yaw, pitch } = aim(eye, at);
        return js.preview(eye, yaw, pitch, 0);
    }

    it('square on means within about 35 degrees of the face normal', () => {
        const { js } = plankOnBlock();
        const at = { x: 0.3, y: 0.6, z: 0 };
        expect(previewAtAngle(js, at, 0).refusal).toBe('none');
        expect(previewAtAngle(js, at, 33).refusal).toBe('none');
        expect(previewAtAngle(js, at, 37).refusal).toBe('glancing');
        expect(previewAtAngle(js, at, 60).refusal).toBe('glancing');
    });

    it('refuses nothing behind: the end of a plank sticking out over thin air', () => {
        const { js } = plankOnBlock((pw) =>
            pw.addStatic(RAPIER.ColliderDesc.cuboid(0.5, 0.25, 1).setTranslation(-0.6, 0.25, 0))
        );
        const pv = previewAtAngle(js, { x: 0.9, y: 0.6, z: 0 }, 0);
        expect(pv.a).toBe(1);
        expect(pv.refusal).toBe('nothing-behind');
    });

    it("can't fasten to a kinematic body, the ute, non-timber, or a tree", () => {
        // kinematic (a moving scripted body)
        let r = plankOnBlock((pw) =>
            pw.addKinematic(9, [{ shape: { type: 'box', hx: 1, hy: 0.25, hz: 1 }, x: 0, y: 0, z: 0 }], pose(0, 0.25, 0))
        );
        expect(previewAtAngle(r.js, { x: 0.3, y: 0.6, z: 0 }, 0).refusal).toBe('cannot-fasten');
        // a dynamic body that is not timber (a stone, the bucket)
        r = plankOnBlock((pw) => {
            const b = pw.addDynamic(8, { type: 'box', hx: 1, hy: 0.25, hz: 1 }, pose(0, 0.25, 0), { density: 900 });
            b.body.setGravityScale(0, true);
        });
        expect(previewAtAngle(r.js, { x: 0.3, y: 0.6, z: 0 }, 0).refusal).toBe('cannot-fasten');
        // the ute (a dynamic compound, not grabbable or nailable)
        r = plankOnBlock((pw) => {
            const u = pw.addDynamicCompound(
                7,
                [{ shape: { type: 'box', hx: 1, hy: 0.25, hz: 1 }, x: 0, y: 0, z: 0, density: 300 }],
                pose(0, 0.25, 0),
                {}
            );
            u.body.setGravityScale(0, true);
        });
        expect(previewAtAngle(r.js, { x: 0.3, y: 0.6, z: 0 }, 0).refusal).toBe('cannot-fasten');
        // a tree (static, but not an anchor: it can be felled)
        r = plankOnBlock((pw) =>
            pw.addStatic(RAPIER.ColliderDesc.cuboid(1, 0.25, 1).setTranslation(0, 0.25, 0), false)
        );
        expect(previewAtAngle(r.js, { x: 0.3, y: 0.6, z: 0 }, 0).refusal).toBe('cannot-fasten');
        expect(r.js.graph.size).toBe(0);
    });

    it('the level: every tree trunk, crown and stump (scenery and the logging stand) is not an anchor; stone is', async () => {
        const { LabSim } = await import('../../src/sim/lab-sim.ts');
        const { timberYardLevel, BRIDGE, BRIDGE_X, YARD_Y } = await import('../../src/levels/timber-yard.ts');
        const s = new LabSim({ level: timberYardLevel });
        const pw = s.physics;
        run(pw, 1);
        /** Every static collider touching a small ball at a point. */
        const staticsAt = (x: number, y: number, z: number, r = 0.12) => {
            const out: number[] = [];
            pw.world.intersectionsWithShape({ x, y, z }, ident, new RAPIER.Ball(r), (c) => {
                if (!pw.bodyOfCollider(c.handle) && !c.parent()) out.push(c.handle);
                return true;
            });
            return out;
        };
        const layout = timberYardLevel.layout(1);
        const g = timberYardLevel.terrainHeight;
        let trunks = 0;
        for (const t of layout.trees) {
            const hit = staticsAt(t.x, g(t.x, t.z) + 0.8, t.z);
            for (const h of hit) expect(pw.isAnchor(h), `tree at ${t.x},${t.z}`).toBe(false);
            trunks += hit.length;
        }
        // the logging stand's trees (Epic 6): standing trunks, then a felled one's stump
        const stand = timberYardLevel.forestry!.trees;
        let standing = 0;
        for (const t of stand) {
            const hit = staticsAt(t.x, g(t.x, t.z) + 0.6, t.z, 0.2);
            for (const h of hit) expect(pw.isAnchor(h), `stand tree at ${t.x},${t.z}`).toBe(false);
            standing += hit.length;
        }
        (s.forestry as unknown as { fell(n: number): void }).fell(0);
        run(pw, 1);
        const stump = staticsAt(stand[0].x, g(stand[0].x, stand[0].z) + 0.08, stand[0].z, 0.2).filter(
            (h) => h !== (pw as unknown as { terrainHandle: number }).terrainHandle
        );
        for (const h of stump) expect(pw.isAnchor(h), 'stump').toBe(false);
        console.log(`non-anchors: ${trunks} scenery tree colliders, ${standing} stand trunks, ${stump.length} stump`);
        expect(trunks).toBeGreaterThan(5);
        expect(standing).toBe(stand.length);
        expect(stump.length).toBe(1);
        // stone: the abutment capstone and the deck lip take nails
        for (const z of [BRIDGE.nearFace + 0.3, BRIDGE.nearEdge])
            for (const h of staticsAt(BRIDGE_X, YARD_Y + 0.1, z, 0.05))
                expect(pw.isAnchor(h), `stone at z ${z}`).toBe(true);
    });

    it('refuses to nail a plank to a logging-stand tree', async () => {
        const { LabSim } = await import('../../src/sim/lab-sim.ts');
        const { timberYardLevel } = await import('../../src/levels/timber-yard.ts');
        const s = new LabSim({ level: timberYardLevel });
        const t = timberYardLevel.forestry!.trees[0];
        const y = timberYardLevel.terrainHeight(t.x, t.z) + 1.0;
        // a plank held upright against the trunk's +z side (found with a ray: the stand trees lean), its
        // thin face towards the tree
        run(s.physics, 1);
        const hit = s.physics.world.castRay(new RAPIER.Ray({ x: t.x, y, z: t.z + 2 }, { x: 0, y: 0, z: -1 }), 2, true);
        expect(hit).not.toBeNull();
        const surface = t.z + 2 - hit!.timeOfImpact;
        const plank = s.entities.find((e) => e.name === 'plank')!;
        s.physics.place(plank.id, pose(t.x, y, surface + 0.051, quatFromYawPitchRoll(0, 0, Math.PI / 2)));
        s.physics.bodies.get(plank.id)!.body.setGravityScale(0, true);
        run(s.physics, 1);
        const eye = { x: t.x, y, z: t.z + 1.2 };
        const pv = s.joints.preview(eye, 0, 0, 0);
        expect(pv.a).toBe(plank.id);
        expect(pv.b).toBe(GROUND);
        expect(pv.refusal).toBe('cannot-fasten');
    });

    it('a full joint (four nails) refuses a fifth through the hammer; the world stops at 64 nails', () => {
        const { pw, js } = plankOnBlock();
        for (const x of [-0.3, -0.2, -0.1, 0]) expect(hammerAt(js, { x, y: 0.6, z: 0 }).refusal).toBe('none');
        expect(js.graph.size).toBe(1);
        expect(js.graph.nailCount).toBe(NAIL.maxPerJoint);
        expect(previewAt(js, { x: 0.1, y: 0.6, z: 0 }).refusal).toBe('full');
        // fill the world's nail budget with other pieces' joints
        const ident = { x: 0, y: 0, z: 0, w: 1 };
        for (let k = 0; js.graph.nailCount < NAIL.maxTotal; k++)
            js.graph.add({
                a: 100 + k,
                b: GROUND,
                type: 'anchor',
                anchorA: { x: 0, y: 0, z: 0 },
                anchorB: { x: 50 + k, y: 0, z: 0 },
                rel: ident,
                nails: Array.from(
                    { length: Math.min(NAIL.maxPerJoint, NAIL.maxTotal - js.graph.nailCount) },
                    (_, i) => ({ x: i * 0.1, y: 0, z: 0 })
                ),
                stiffness: 1,
                tick: 0
            });
        // a second plank, unfastened: a good spot, but no nails left
        pw.addDynamic(2, { type: 'box', hx: 1.2, hy: 0.05, hz: 0.1 }, pose(0, 0.551, 0.5), TIMBER).body.setGravityScale(
            0,
            true
        );
        run(pw, 1);
        expect(previewAt(js, { x: 0, y: 0.6, z: 0.5 }).refusal).toBe('limit');
    });
});

describe('joint stiffness (#47 audit)', () => {
    /**
     * A 3.2 m beam on a frictionless stone post, nailed down near its back end, pushed sideways at
     * its tip: only the joint's spring resists the turn. Returns the turn (rad), the moment and k.
     */
    function sideways(nails: number, load: number) {
        const pw = world();
        pw.addStatic(RAPIER.ColliderDesc.cuboid(0.3, 0.25, 0.3).setTranslation(-1.2, 0.25, 0).setFriction(0));
        const pb = pw.addDynamic(1, { type: 'box', hx: 1.6, hy: 0.075, hz: 0.1 }, pose(0, 0.576, 0), {
            ...TIMBER,
            friction: 0
        });
        pb.body.setGravityScale(0, true);
        run(pw, 1);
        const js = new JointSystem(pw);
        for (let k = 0; k < nails; k++) hammerAt(js, { x: -1.35 + k * 0.08, y: 0.65, z: 0 });
        pb.body.setGravityScale(1, true);
        const c = [...js.graph.connections()][0];
        let yaw = 0;
        for (let i = 0; i < 240; i++) {
            const t = pb.body.translation();
            pb.body.applyImpulseAtPoint({ x: 0, y: 0, z: load / 60 }, { x: t.x + 1.5, y: t.y, z: t.z }, true);
            pw.step();
            const q = pb.body.rotation();
            yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
        }
        const arm = pb.body.translation().x + 1.5 - c.anchorB.x;
        return { turn: Math.abs(yaw), M: load * arm, k: js.angularStiffness(c), nails: c.nails.length };
    }

    /**
     * Timber to timber: a 3.2 m beam nailed across a plank lying on the ground; once nailed the
     * plank is fixed in place, and the beam is pushed sideways at its tip. Only the nailed joint
     * (stiffness NAIL.stiffness = 0.8) resists the turn.
     */
    function timberSideways(nails: number, load: number) {
        const pw = world();
        const base = pw.addDynamic(
            2,
            { type: 'box', hx: 1.2, hy: 0.05, hz: 0.1 },
            pose(-1.2, 0.05, 0, quatFromYawPitchRoll(Math.PI / 2, 0, 0)),
            TIMBER
        );
        const pb = pw.addDynamic(1, { type: 'box', hx: 1.6, hy: 0.075, hz: 0.1 }, pose(0, 0.176, 0), TIMBER);
        base.body.setGravityScale(0, true);
        pb.body.setGravityScale(0, true);
        run(pw, 1);
        const js = new JointSystem(pw);
        // nails in a grid inside the 20 x 20 cm crossing
        const spots = [
            [-1.25, -0.05],
            [-1.15, 0.05],
            [-1.15, -0.05],
            [-1.25, 0.05]
        ];
        for (let k = 0; k < nails; k++) hammerAt(js, { x: spots[k][0], y: 0.25, z: spots[k][1] });
        base.body.setBodyType(RAPIER.RigidBodyType.Fixed, true);
        pb.body.setGravityScale(1, true);
        const c = [...js.graph.connections()][0];
        let yaw = 0;
        for (let i = 0; i < 240; i++) {
            const t = pb.body.translation();
            pb.body.applyImpulseAtPoint({ x: 0, y: 0, z: load / 60 }, { x: t.x + 1.5, y: t.y, z: t.z }, true);
            pw.step();
            const q = pb.body.rotation();
            yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
        }
        const arm = pb.body.translation().x + 1.5 - pw.bodies.get(1)!.body.translation().x - (c.anchorA.x ?? 0);
        return { turn: Math.abs(yaw), M: load * arm, k: js.angularStiffness(c), c };
    }

    it('timber to timber: a nailed joint between two pieces flexes by its 0.8 stiffness, one nail four times four', () => {
        const one = timberSideways(1, 300);
        const four = timberSideways(4, 300);
        expect(one.c.type).toBe('nail');
        expect(one.c.b).toBe(2);
        expect(one.c.stiffness).toBe(NAIL.stiffness);
        expect(four.c.nails.length).toBe(4);
        expect(one.k).toBe(NAIL.stiffness * NAIL.angularStiffness);
        console.log(
            `timber to timber, 300 N at the tip: one nail turns ${(one.turn * 1000).toFixed(2)} mrad (M/k ${((one.M / one.k) * 1000).toFixed(2)}), four ${(four.turn * 1000).toFixed(2)} mrad (M/k ${((four.M / four.k) * 1000).toFixed(2)})`
        );
        expect(one.turn).toBeGreaterThan(0.9 * (one.M / one.k));
        expect(one.turn).toBeLessThan(1.1 * (one.M / one.k));
        expect(one.turn / four.turn).toBeGreaterThan(3.6);
    });

    it('a joint flexes in proportion to its load over its stiffness: one nail four times as much as four', () => {
        const one = sideways(1, 300);
        const four = sideways(4, 300);
        expect(one.nails).toBe(1);
        expect(four.nails).toBe(4);
        expect(four.k).toBe(4 * one.k);
        console.log(
            `sideways 300 N at the tip: one nail turns ${(one.turn * 1000).toFixed(2)} mrad (M/k ${((one.M / one.k) * 1000).toFixed(2)}), four nails ${(four.turn * 1000).toFixed(2)} mrad (M/k ${((four.M / four.k) * 1000).toFixed(2)})`
        );
        expect(one.turn).toBeGreaterThan(0.9 * (one.M / one.k));
        expect(one.turn).toBeLessThan(1.1 * (one.M / one.k));
        expect(one.turn / four.turn).toBeGreaterThan(3.6);
        // twice the load, about twice the turn
        const one2 = sideways(1, 600);
        expect(one2.turn / one.turn).toBeGreaterThan(1.7);
        expect(one2.turn / one.turn).toBeLessThan(2.3);
    });
});

describe('what takes nails', () => {
    it('a plank the sawmill cut from a real log (Epic 6), carried off its rack and nailed down by player input', async () => {
        const { LabSim, EYE_HEIGHT } = await import('../../src/sim/lab-sim.ts');
        const { timberYardLevel, YARD_FORESTRY } = await import('../../src/levels/timber-yard.ts');
        const { SAWMILL, sawmillToWorld } = await import('../../src/levels/forestry.ts');
        const { SAW } = await import('../../src/sim/sawmill.ts');
        const { ACTION_NAIL, neutralCommand } = await import('../../src/sim/commands.ts');
        const s = new LabSim({ level: timberYardLevel });
        const SPOT = YARD_FORESTRY.sawmill!;
        let n = 0;
        let yaw = 0;
        let pitch = 0;
        const step = (c: Partial<ReturnType<typeof neutralCommand>> = {}, k = 1) => {
            for (let i = 0; i < k; i++) s.step({ ...neutralCommand(n++), yaw, pitch, ...c });
        };
        step({}, 60);
        s.fpActive = true;
        // the yard's log, fed into the saw's guide; the saw takes it and cuts it
        const log = s.entities.find((e) => e.name === 'log')!;
        const G = SAWMILL.guide;
        const feed = sawmillToWorld(SPOT, (G.x0 + G.x1) / 2, SAWMILL.feedY + 0.05, 0);
        s.physics.place(log.id, pose(feed.x, feed.y, feed.z, quatFromYawPitchRoll(SPOT.yaw, 0, 0)));
        for (let k = 0; k < SAW.settleTicks + 60 && s.sawmill!.phase === 'ready'; k++) step();
        expect(s.sawmill!.stats.takenIds).toEqual([log.id]);
        step({}, SAW.cutTicks + 30);
        expect(s.sawmill!.stats.planks).toBe(3);
        // a plank it put on the rack
        const rackX = SPOT.x + SAWMILL.outfeed.x;
        const sawn = s.entities.filter(
            (e) => /^extra-plank-(1[2-9]|2\d)$/.test(e.name) && e.visible && Math.abs(e.pose.p.x - rackX) < 1.5
        );
        expect(sawn.length).toBe(3);
        const plank = sawn[0];
        // ---- from here on, player input only: walk round to the rack's north side, facing south
        const walkTo = (x: number, z: number) => {
            for (let i = 0; i < 2000; i++) {
                const dx = x - s.player.x;
                const dz = z - s.player.z;
                const d = Math.hypot(dx, dz);
                if (d < 0.08) break;
                yaw = Math.atan2(-dx, -dz);
                step({ moveZ: Math.min(0.6, d * 1.5 + 0.1) });
            }
            step({}, 15);
        };
        const look = (at: { x: number; y: number; z: number }) => {
            const dx = at.x - s.player.x;
            const dz = at.z - s.player.z;
            yaw = Math.atan2(-dx, -dz);
            pitch = Math.atan2(at.y - (s.player.y + EYE_HEIGHT), Math.hypot(dx, dz));
        };
        const p0 = { ...plank.pose.p };
        walkTo(p0.x, p0.z - 1.0);
        look(p0);
        step({}, 10);
        step({ grab: true });
        expect(s.physics.heldId).toBe(plank.id);
        // lift it, carry it 2 m north onto open ground, set it down and let go
        pitch = -0.2;
        step({}, 30);
        const from = { x: s.player.x, z: s.player.z };
        for (let i = 0; i < 600 && s.player.z > from.z - 2; i++) step({ moveZ: -0.4 });
        pitch = -0.9;
        step({}, 40);
        step({ grab: true });
        step({}, 90);
        expect(s.physics.heldId).toBe(-1);
        // stand over it and swing the hammer at it (it goes down into the ground)
        const lies = { ...plank.pose.p };
        look({ x: lies.x, y: lies.y + 0.05, z: lies.z });
        step({}, 5);
        expect(s.interactionIds(0).nail).toBe(1);
        step({ action: ACTION_NAIL });
        step({}, 10);
        const c = s.joints.graph.of(plank.id);
        expect(c.length).toBe(1);
        expect(c[0].b).toBe(GROUND);
        expect(c[0].nails.length).toBe(1);
    });

    it("timber does, by name: the yard's planks and beams, sawn planks and beams (Epic 6), logs, crates; the bucket doesn't", async () => {
        const { propBody } = await import('../../src/sim/lab-physics.ts');
        for (const name of [
            'plank',
            'extra-plank-4',
            'extra-plank-11',
            'extra-plank-20',
            'beam-0',
            'beam-14',
            'log',
            'extra-log-1',
            'crate-2'
        ])
            expect(propBody(name)?.opts.nailable, name).toBe(true);
        for (const name of ['bucket', 'sphere']) expect(propBody(name)?.opts.nailable, name).toBeFalsy();
    });
});
