import { beforeAll, describe, expect, it } from 'vitest';

import { BRIDGE, BRIDGE_X, YARD_Y, timberYardLevel } from '../../src/levels/timber-yard.ts';
import { ACTION_NAIL, neutralCommand } from '../../src/sim/commands.ts';
import type { PlayerCommand } from '../../src/sim/commands.ts';
import { EYE_HEIGHT, LabSim } from '../../src/sim/lab-sim.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { pose, quatFromYawPitchRoll, quatRotate, vec3 } from '../../src/voxels/math.ts';

beforeAll(() => initPhysics());

/** Beams go under the deck this far either side of the bridge's centre line (planks are 2.4 m). */
const LINE = 0.55;
const DECK_PITCH = 0.25;
let BEAM_STOP = 0.05;
export const setBeamStop = (v: number) => (BEAM_STOP = v);

/**
 * The whole yard crossing built by one player with player commands: shoulder both beams onto the
 * seats, nail their near ends, carry planks from both stacks and nail each across both beams, walk
 * out on the deck to nail the beams' far ends, finish the deck, then drive the ute over it.
 * (As in the yard's other playthroughs, the player is put down beside a stack before taking a
 * piece; everything after that is commands.)
 */
function buildAndCross() {
    const s = new LabSim({ level: timberYardLevel });
    const byName = (n: string) => s.entities.find((e) => e.name === n)!;
    let n = 0;
    let yaw = 0;
    let pitch = 0;
    const log: string[] = [];
    const phases: { tick: number; name: string }[] = [];
    const phase = (name: string) => phases.push({ tick: s.tick, name });
    const step = (c: Partial<PlayerCommand> = {}, k = 1) => {
        for (let i = 0; i < k; i++) s.step({ ...neutralCommand(n++), yaw, pitch, ...c });
    };
    const ease = (to: number, k: number, set: (v: number) => void, from: number) => {
        for (let i = 1; i <= k; i++) {
            set(from + ((to - from) * i) / k);
            step();
        }
    };
    /** Walks (facing -z, yaw 0) to within 2 cm of a point: x first, then z. */
    const walkTo = (x: number, z: number) => {
        for (let i = 0; i < 1200 && Math.abs(s.player.x - x) > 0.02; i++) {
            const d = x - s.player.x;
            // yaw 0: +moveX walks towards +x
            step({ moveX: Math.max(-0.5, Math.min(0.5, d * 3)) });
        }
        for (let i = 0; i < 1200 && Math.abs(s.player.z - z) > 0.02; i++) {
            const d = s.player.z - z;
            // yaw 0: +moveZ walks towards -z
            step({ moveZ: Math.max(-0.5, Math.min(0.5, d * 3)) });
        }
        step({}, 20);
    };
    const look = (at: { x: number; y: number; z: number }) => {
        const dx = at.x - s.player.x;
        const dy = at.y - (s.player.y + EYE_HEIGHT);
        const dz = at.z - s.player.z;
        yaw = Math.atan2(-dx, -dz);
        pitch = Math.atan2(dy, Math.hypot(dx, dz));
    };
    /** Looks at a spot and swings the hammer; returns whether a nail went in. */
    const nail = (at: { x: number; y: number; z: number }, what: string) => {
        const before = s.joints.graph.nailCount;
        look(at);
        step({}, 4);
        for (let t = 0; t < 30 && s.interactionIds(0).nail !== 1; t++) step();
        const code = s.interactionIds(0).nail;
        step({ action: ACTION_NAIL });
        const ok = s.joints.graph.nailCount > before;
        if (!ok) log.push(`${what}: no nail (code ${code}) ${JSON.stringify(s.nailPreview(0))}`);
        yaw = 0;
        pitch = 0;
        step({}, 4);
        return ok;
    };
    /** The top of a beam's centre line at z (beams lie roughly along z; laid by hand, a little skewed). */
    const axis = vec3();
    const onBeam = (beam: (typeof s.entities)[number], z: number) => {
        quatRotate(beam.pose.q, 1, 0, 0, axis);
        const t = Math.abs(axis.z) > 1e-3 ? (z - beam.pose.p.z) / axis.z : 0;
        return { x: beam.pose.p.x + axis.x * t, y: beam.pose.p.y + axis.y * t + 0.075, z };
    };
    step({}, 60);
    s.fpActive = true;

    // ---- 1. both beams onto the seats, under the deck lines; nail each near end twice
    const beams = [byName('beam-0'), byName('beam-1')];
    const lines = [BRIDGE_X - LINE, BRIDGE_X + LINE];
    for (let b = 0; b < 2; b++) {
        const beam = beams[b];
        phase(`beam ${b}`);
        yaw = Math.PI / 2;
        s.placePlayer(beam.pose.p.x + 2.4, beam.pose.p.z, yaw);
        step({}, 20);
        pitch = -Math.atan2(s.player.y + EYE_HEIGHT - beam.pose.p.y, s.player.x - (beam.pose.p.x + 1.45));
        step({}, 5);
        step({ grab: true });
        if (s.physics.heldId !== beam.id) log.push(`beam ${b}: grab missed`);
        ease(-0.25, 40, (v) => (pitch = v), pitch);
        step({}, 30);
        ease(0, 120, (v) => (yaw = v), yaw);
        walkTo(lines[b], BRIDGE.nearEdge + BEAM_STOP);
        ease(-0.7, 40, (v) => (pitch = v), pitch);
        step({}, 30);
        step({ grab: true });
        pitch = 0;
        step({}, 120);
        // into the capstone, well back from the beam's end
        const end = beam.pose.p.z + 1.6;
        for (const dz of [0.07, 0.14]) nail(onBeam(beam, end - dz), `beam ${b} near end`);
    }
    const beamMid = (beams[0].pose.p.z + beams[1].pose.p.z) / 2;
    const beamNear = beamMid + 1.6;
    const beamFar = beamMid - 1.6;
    log.push(
        `beams at z ${beams.map((b) => b.pose.p.z.toFixed(2)).join(', ')}, x ${beams.map((b) => b.pose.p.x.toFixed(2)).join(', ')}`
    );

    // ---- 2. the deck: planks from the stacks, top first, each nailed to both beams
    const stack = [
        ...[11, 10, 9, 8, 7, 6, 5].map((k) => byName(`extra-plank-${k}`)),
        ...[4, 3, 2, 1, 0].map((k) => byName(`extra-plank-${k}`)),
        byName('plank')
    ];
    const deck: number[] = [];
    for (let z = beamNear - 0.12; z >= beamFar + 0.12; z -= DECK_PITCH) deck.push(z);
    // the last plank waits until the far ends are nailed (it covers them)
    const farNailZ = Math.min(BRIDGE.farFace - 0.06, beamFar + 0.16);
    let placed = 0;
    const layPlank = (z: number) => {
        const p = stack[placed++];
        phase(`plank ${placed}`);
        // beside its stack, facing -z, look at its middle and take it
        s.placePlayer(p.pose.p.x, p.pose.p.z + 0.9, 0);
        yaw = 0;
        step({}, 20);
        look({ x: p.pose.p.x, y: p.pose.p.y + 0.05, z: p.pose.p.z });
        step({}, 4);
        step({ grab: true });
        if (s.physics.heldId !== p.id) {
            log.push(`plank ${placed}: grab missed`);
            return;
        }
        yaw = 0;
        ease(-0.3, 20, (v) => (pitch = v), pitch);
        step({}, 30);
        // carry it over: out onto the ramp, then along to where it goes down
        const ahead = s.player.z - p.pose.p.z;
        walkTo(s.player.x, Math.max(BRIDGE.nearEdge + 1.6, s.player.z > 2 ? 1.6 : s.player.z));
        walkTo(BRIDGE_X, z + ahead);
        const restY = onBeam(beams[0], z).y + 0.05;
        for (let attempt = 0; attempt < 3; attempt++) {
            ease(-0.8, 30, (v) => (pitch = v), pitch);
            step({}, 30);
            // lowered just above the beams: shuffle until it hangs over its spot, then let go
            for (let t = 0; t < 8 && Math.abs(p.pose.p.z - z) > 0.03; t++) {
                walkTo(s.player.x + (BRIDGE_X - p.pose.p.x), s.player.z + (z - p.pose.p.z));
                step({}, 20);
            }
            step({ grab: true });
            pitch = 0;
            step({}, 60);
            // landed flat on the beams, where it should be? if not, pick it up again
            if (Math.abs(p.pose.p.z - z) < 0.06 && Math.abs(p.pose.p.y - restY) < 0.03) break;
            log.push(
                `plank ${placed}: landed at z ${p.pose.p.z.toFixed(2)} y ${p.pose.p.y.toFixed(2)} (wanted ${z.toFixed(2)}, ${restY.toFixed(2)}): again`
            );
            look({ x: p.pose.p.x, y: p.pose.p.y + 0.05, z: p.pose.p.z });
            step({}, 4);
            step({ grab: true });
            if (s.physics.heldId !== p.id) break;
            yaw = 0;
            ease(-0.3, 20, (v) => (pitch = v), pitch);
            step({}, 20);
        }
        for (const beam of beams) {
            const at = onBeam(beam, p.pose.p.z);
            nail({ x: at.x, y: p.pose.p.y + 0.05, z: p.pose.p.z }, `plank ${placed} over ${beam.name}`);
        }
    };
    for (const z of deck.slice(0, -1)) layPlank(z);
    phase('far ends');
    // ---- 3. out on the deck: nail both beams' far ends into the far capstone
    walkTo(BRIDGE_X, deck[deck.length - 2] + 0.5);
    for (let b = 0; b < 2; b++) nail(onBeam(beams[b], farNailZ), `beam ${b} far end`);
    walkTo(BRIDGE_X, deck[deck.length - 2] + 1.2);
    layPlank(deck[deck.length - 1]);
    phase('back');
    // ---- 4. back to the yard and drive the ute over
    walkTo(BRIDGE_X, BRIDGE.nearEdge + 4);
    walkTo(BRIDGE_X + 2.2, BRIDGE.nearEdge + 4);
    const v = s.vehicle!;
    s.physics.place(v.id, pose(BRIDGE_X, YARD_Y + 0.25, BRIDGE.nearEdge + 5, quatFromYawPitchRoll(Math.PI, 0, 0)));
    step({}, 60);
    s.takeDriverSeat(0);
    const target = BRIDGE.farEdge - 3;
    let minY = Infinity;
    for (let k = 0; k < 60 * 25 && s.ute.pose.p.z > target; k++) {
        const q = s.ute.pose.q;
        const uy = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
        let dy = uy - Math.PI;
        dy -= Math.round(dy / (2 * Math.PI)) * 2 * Math.PI;
        const steer = Math.max(-1, Math.min(1, 4 * (BRIDGE_X - s.ute.pose.p.x) + 3 * dy));
        s.step({ ...neutralCommand(n++, Math.PI), moveZ: 0.25, moveX: steer });
        const u = s.ute.pose.p;
        if (u.z < BRIDGE.nearFace && u.z > BRIDGE.farFace) minY = Math.min(minY, u.y);
    }
    return { s, log, deck, placed, target, minY, beams, phases };
}

describe('the yard crossing, built by a player and driven over (Epic 5 gate)', () => {
    it('beams, a nailed plank deck, both ends anchored: the ute drives from bank to bank', () => {
        const r = buildAndCross();
        const g = r.s.joints.graph;
        let anchors = 0;
        let deckJoints = 0;
        for (const c of g.connections()) {
            if (c.b === -1) anchors++;
            else deckJoints++;
        }
        console.log(
            `player-built bridge: ${r.placed} planks, ${anchors} anchors, ${deckJoints} deck joints, ${g.nailCount} nails; ute reached z ${r.s.ute.pose.p.z.toFixed(2)} (target ${r.target.toFixed(2)}), lowest over the gap ${(r.minY - YARD_Y).toFixed(2)} m above the yard`
        );
        for (const l of r.log) console.log('  ', l);
        for (const e of r.s.events)
            if (e.kind === 'fell')
                console.log('   FELL at tick', e.tick, r.phases.filter((ph) => ph.tick <= e.tick).pop()?.name);
        expect(r.placed).toBe(r.deck.length);
        // both beams anchored at both ends
        expect(anchors).toBe(4);
        // every plank nailed to both beams
        expect(deckJoints).toBe(2 * r.deck.length);
        expect(r.s.ute.pose.p.z).toBeLessThan(r.target);
        expect(r.minY).toBeGreaterThan(YARD_Y);
        expect(r.s.progress.falls).toBe(0);
    }, 300_000);
});
