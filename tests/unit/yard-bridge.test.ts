import { beforeAll, describe, expect, it } from 'vitest';

import { BRIDGE, BRIDGE_X, YARD_Y, timberYardLevel } from '../../src/levels/timber-yard.ts';
import { ACTION_NAIL, neutralCommand } from '../../src/sim/commands.ts';
import type { PlayerCommand } from '../../src/sim/commands.ts';
import { HAZARD, PHASE } from '../../src/sim/hazards.ts';
import { GROUND } from '../../src/sim/joints/graph.ts';
import { EYE_HEIGHT, LabSim } from '../../src/sim/lab-sim.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { pose, quatFromYawPitchRoll, quatRotate, vec3 } from '../../src/voxels/math.ts';

beforeAll(() => initPhysics());

/** Beams go under the deck this far either side of the bridge's centre line (planks are 2.4 m). */
const LINE = 0.55;
const DECK_PITCH = 0.27;
let BEAM_STOP = 0.05;
export const setBeamStop = (v: number) => (BEAM_STOP = v);

/**
 * Each deck plank must come to rest within this of its spot (m): height over the beams' tops (one
 * riding on a neighbour is 5 cm or more out), and along the bridge (planks 0.2 m wide, 7 cm apart).
 */
export const PLANK_HEIGHT_TOL = 0.02;
export const PLANK_ALONG_TOL = 0.05;

/**
 * The whole yard crossing built by one player from player commands alone, nothing put in place:
 * walk to each beam and shoulder it onto the seats, nail their near ends, walk to the stacks and
 * carry planks over, nailing each across both beams, walk out on the deck to nail the beams' far
 * ends, finish the deck, then walk to the ute, get in, turn it round in the yard (a three-point
 * turn: the yard is too small to swing round), back it up the bridge's line and drive over.
 * `pullPlankNails` is the control: the same build, but just before the ute sets off every plank's
 * nails are pulled (the beams stay nailed down), so the very same deck is only laid on the beams.
 */
function buildAndCross(pullPlankNails = false) {
    const s = new LabSim({ level: timberYardLevel });
    const byName = (n: string) => s.entities.find((e) => e.name === n)!;
    let n = 0;
    let yaw = 0;
    let pitch = 0;
    const log: string[] = [];
    /** Where each deck plank came to rest against its spot (m): height over the deck plane, along z. */
    const landed: { id: number; dy: number; dz: number }[] = [];
    const phases: { tick: number; name: string }[] = [];
    const phase = (name: string) => phases.push({ tick: s.tick, name });
    const step = (c: Partial<PlayerCommand> = {}, k = 1) => {
        for (let i = 0; i < k; i++) {
            // a gust coming for what you carry (the windsock swings round): hold it down by your
            // knees until it has blown over (near the ground it catches a fifth of it); out over the
            // creek there is no ground under it, so first back off onto the bank
            if (s.hazards.gustPhase !== PHASE.idle && s.physics.heldId >= 0 && !c.grab && !c.action) {
                const back = s.player.z < BRIDGE.nearEdge + 2.4 ? 1 : 0;
                // world +z: forward is (-sin yaw, -cos yaw), right is (cos yaw, -sin yaw)
                s.step({
                    ...neutralCommand(n++),
                    yaw,
                    pitch: -1.1,
                    moveZ: -Math.cos(yaw) * back,
                    moveX: -Math.sin(yaw) * back
                });
                continue;
            }
            s.step({ ...neutralCommand(n++), yaw, pitch, ...c });
        }
    };
    // ---- the flood (Epic 8): a finished crossing sets it off. A player hears the siren and sees the
    // water; the test notes when each flood ends, and how far it moved what was on the crossing.
    const floods: { tell: number; end: number; moved: number }[] = [];
    let floodWas: number = PHASE.idle;
    let floodBefore = new Map<number, { x: number; y: number; z: number }>();
    const onCrossing = () => [...beams, ...landed.map((l) => s.entities.find((e) => e.id === l.id)!)];
    const rawStep = s.step.bind(s);
    s.step = ((...args: Parameters<LabSim['step']>) => {
        const px = s.player.x,
            py = s.player.y,
            pz = s.player.z,
            falls = s.progress.falls;
        const gw = s.hazards.gustPhase;
        rawStep(...args);
        if (process.env.GATE_DEBUG)
            for (const c of s.joints.graph.connections()) {
                const h = s.joints.health.states.get(c.id);
                const l = s.joints.stress.loads.get(c.id);
                if (!h || !l || h.util < 0.5) continue;
                const ps = (id: number) => {
                    const e = s.entities.find((x) => x.id === id);
                    if (!e) return 'g';
                    const q = e.pose.q;
                    return `${e.name}@y${e.pose.p.y.toFixed(4)} q(${q.x.toFixed(4)},${q.y.toFixed(4)},${q.z.toFixed(4)},${q.w.toFixed(4)})`;
                };
                log.push(`POSE ${ps(c.a)} ${ps(c.b)} ${ps(320)} ${ps(321)}`);
                log.push(
                    `STRAIN t ${(s.tick / 60).toFixed(2)} c${c.id} ${c.a}>${c.b} age ${s.tick - c.tick}: u ${h.util.toFixed(2)} raw ${h.raw.toFixed(2)} shear ${l.shear.toFixed(0)} pull ${l.pull.toFixed(0)} bearing ${l.bearing.toFixed(0)} moment ${l.moment.toFixed(0)} f (${l.fx.toFixed(0)},${l.fy.toFixed(0)},${l.fz.toFixed(0)}) held ${s.physics.heldId} player (${s.player.x.toFixed(2)},${s.player.y.toFixed(2)},${s.player.z.toFixed(2)})`
                );
            }
        if (process.env.GATE_DEBUG && gw === PHASE.idle && s.hazards.gustPhase !== PHASE.idle)
            log.push(
                `gust at ${(s.tick / 60).toFixed(1)} s holding ${s.physics.heldId} at (${s.player.x.toFixed(2)}, ${s.player.z.toFixed(2)})`
            );
        if (process.env.GATE_DEBUG && s.progress.falls > falls && log.length < 60)
            log.push(
                `fell at ${(s.tick / 60).toFixed(1)} s from (${px.toFixed(2)}, ${py.toFixed(2)}, ${pz.toFixed(2)}) holding ${s.physics.heldId} water ${s.hazards.net().waterY.toFixed(2)} gust ${s.hazards.gustPhase}`
            );
        const ph = s.hazards.floodPhase;
        if (floodWas === PHASE.idle && ph !== PHASE.idle) {
            floods.push({ tell: s.tick, end: -1, moved: 0 });
            floodBefore = new Map(onCrossing().map((e) => [e.id, { ...e.pose.p }]));
        }
        if (floodWas !== PHASE.idle && ph === PHASE.idle) {
            const f = floods[floods.length - 1];
            f.end = s.tick;
            for (const e of onCrossing()) {
                const a = floodBefore.get(e.id);
                if (a) f.moved = Math.max(f.moved, Math.hypot(e.pose.p.x - a.x, e.pose.p.y - a.y, e.pose.p.z - a.z));
            }
        }
        floodWas = ph;
    }) as LabSim['step'];
    const sec = (t: number) => Math.round(t * 60);
    /**
     * In the yard, before a trip onto the crossing that takes up to `trip` s: wait while the creek is
     * up, and if the next flood could come (after the last one's cooldown) before you are back, wait
     * for it to come and go.
     */
    const F = HAZARD.flood;
    const waitForSafe = (trip: number) => {
        const t0 = s.tick;
        waitInner(trip);
        if (process.env.GATE_DEBUG)
            log.push(
                `waited ${((s.tick - t0) / 60).toFixed(0)} s from ${(t0 / 60).toFixed(0)} s (${floods.length} floods, phase ${s.hazards.floodPhase})`
            );
    };
    const waitInner = (trip: number) => {
        const tooLate = () => {
            const last = floods[floods.length - 1];
            if (!last || floods.length >= F.max) return false;
            // the siren is due at the earliest this long after the last flood, and the water rises
            // after its tell
            const danger = last.end + sec(F.cooldownS + F.holdToTrigger + F.delayS + F.tellS - 5);
            return s.tick + sec(trip) > danger;
        };
        for (let k = 0; k < sec(300) && (s.hazards.floodPhase !== PHASE.idle || tooLate()); k += 30) {
            if (tooLate() && s.hazards.floodPhase === PHASE.idle && floods.length < F.max) {
                const before = floods.length;
                for (let t = 0; t < sec(200) && floods.length === before; t += 30) step({}, 30);
            }
            step({}, 30);
        }
    };
    const ease = (to: number, k: number, set: (v: number) => void, from: number) => {
        for (let i = 1; i <= k; i++) {
            set(from + ((to - from) * i) / k);
            step();
        }
    };
    /**
     * Walks to within 2 cm of a point, whichever way you face (you strafe: what you hold keeps its
     * line): along x first, then z, or z first with `zFirst`.
     */
    const walkAxis = (axis: 'x' | 'z', to: number) => {
        for (let i = 0; i < 1200; i++) {
            const d = axis === 'x' ? to - s.player.x : to - s.player.z;
            if (Math.abs(d) <= 0.02) break;
            const wx = axis === 'x' ? d : 0;
            const wz = axis === 'z' ? d : 0;
            // forward is (-sin yaw, -cos yaw), right is (cos yaw, -sin yaw)
            const f = -Math.sin(yaw) * wx - Math.cos(yaw) * wz;
            const r = Math.cos(yaw) * wx - Math.sin(yaw) * wz;
            // (with some pace even close in: stepping up onto a plank wants it)
            const k = Math.min(1, Math.max(0.3, 0.6 * Math.min(1, Math.abs(d) * 3)) / Math.max(1e-6, Math.hypot(f, r)));
            step({ moveX: r * k, moveZ: f * k });
        }
    };
    const walkTo = (x: number, z: number, zFirst = false) => {
        if (zFirst) walkAxis('z', z);
        walkAxis('x', x);
        if (!zFirst || Math.abs(s.player.z - z) > 0.02) walkAxis('z', z);
        step({}, 20);
    };
    const look = (at: { x: number; y: number; z: number }) => {
        const dx = at.x - s.player.x;
        const dy = at.y - (s.player.y + EYE_HEIGHT);
        const dz = at.z - s.player.z;
        yaw = Math.atan2(-dx, -dz);
        pitch = Math.atan2(dy, Math.hypot(dx, dz));
    };
    /**
     * Steps up to a spot (not past `stopZ`: the end of the deck laid so far) until it is within 33
     * degrees of straight down from the eye (the hammer takes 35), whatever its height, looks at it and swings the hammer;
     * returns whether a nail went in.
     */
    const nail = (at: { x: number; y: number; z: number }, what: string, stopZ = -Infinity) => {
        const before = s.joints.graph.nailCount;
        const flat = () => Math.hypot(at.x - s.player.x, at.z - s.player.z);
        const near = () => 0.65 * (s.player.y + EYE_HEIGHT - at.y);
        if (flat() > near()) {
            const k = Math.max(0, 1 - (0.9 * near()) / flat());
            walkTo(s.player.x + (at.x - s.player.x) * k, Math.max(stopZ, s.player.z + (at.z - s.player.z) * k));
        }
        look(at);
        step({}, 4);
        for (let t = 0; t < 30 && s.interactionIds(0).nail !== 1; t++) step();
        const code = s.interactionIds(0).nail;
        step({ action: ACTION_NAIL });
        const ok = s.joints.graph.nailCount > before;
        if (!ok)
            log.push(
                `${what}: no nail (code ${code}) from (${s.player.x.toFixed(2)}, ${s.player.y.toFixed(2)}, ${s.player.z.toFixed(2)}) at (${at.x.toFixed(2)}, ${at.y.toFixed(2)}, ${at.z.toFixed(2)}), ${((Math.atan2(Math.hypot(at.x - s.player.x, at.z - s.player.z), s.player.y + EYE_HEIGHT - at.y) * 180) / Math.PI).toFixed(0)} deg ${JSON.stringify(s.nailPreview(0))}`
            );
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
        // walk round to its end, face along it
        walkTo(beam.pose.p.x + 2.4, beam.pose.p.z);
        ease(Math.PI / 2, 30, (v) => (yaw = v), yaw);
        step({}, 20);
        // at its top face, 15 cm in from its end
        pitch = -Math.atan2(s.player.y + EYE_HEIGHT - (beam.pose.p.y + 0.075), s.player.x - (beam.pose.p.x + 1.45));
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
    // the beams span the gap: the flood comes. Back off the crossing into the yard and wait it out:
    // the beams are nailed down at their near ends
    yaw = 0;
    pitch = 0;
    walkTo(s.player.x, BRIDGE.nearEdge + 3.5, true);
    for (let k = 0; k < sec(120) && !(floods.length >= 1 && s.hazards.floodPhase === PHASE.idle); k++) step();
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
    /** Planks taken from the stacks, and placed (taken in hand: a missed grab does not count). */
    let taken = 0;
    let placed = 0;
    /** A held plank turns with you: turn by its skew so it lies square across the beams. */
    const straighten = (p: (typeof s.entities)[number]) => {
        quatRotate(p.pose.q, 1, 0, 0, axis);
        const skew = Math.atan2(-axis.z, axis.x);
        const wrapped = Math.atan2(Math.sin(skew), Math.cos(skew));
        // either end along +x will do
        const turn = Math.abs(wrapped) > Math.PI / 2 ? wrapped - Math.sign(wrapped) * Math.PI : wrapped;
        if (Math.abs(turn) > 0.01) ease(yaw - turn, 20, (v) => (yaw = v), yaw);
    };
    const layPlank = (z: number) => {
        const p = stack[taken++];
        phase(`plank ${taken}`);
        // back up the ramp along the bridge's line, then along the stacks to stand beside it,
        // facing -z; look at its middle and take it
        yaw = 0;
        walkTo(s.player.z < BRIDGE.nearEdge + 3 ? BRIDGE_X : s.player.x, p.pose.p.z + 0.9, true);
        walkTo(p.pose.p.x, p.pose.p.z + 0.9);
        waitForSafe(90);
        look({ x: p.pose.p.x, y: p.pose.p.y + 0.05, z: p.pose.p.z });
        step({}, 4);
        step({ grab: true });
        if (s.physics.heldId !== p.id) {
            log.push(
                `plank ${taken}: grab missed (${p.name} at ${p.pose.p.x.toFixed(2)}, ${p.pose.p.y.toFixed(2)}, ${p.pose.p.z.toFixed(2)}; player ${s.player.x.toFixed(2)}, ${s.player.y.toFixed(2)}, ${s.player.z.toFixed(2)}; held ${s.physics.heldId})`
            );
            return;
        }
        placed++;
        yaw = 0;
        ease(-0.3, 20, (v) => (pitch = v), pitch);
        straighten(p);
        step({}, 30);
        // carry it over: along the yard to the bridge's line (clear of the stacks: it is held high
        // over them), then down the ramp to where it goes down
        const ahead = s.player.z - p.pose.p.z;
        walkTo(BRIDGE_X, z + ahead);
        // the deck plane: the beams' tops plus half a plank
        const restY = (onBeam(beams[0], z).y + onBeam(beams[1], z).y) / 2 + 0.05;
        for (let attempt = 0; attempt < 3; attempt++) {
            // square it up again (a gust, held low, can leave it askew in your hands), lower it
            if (s.physics.heldId === p.id) straighten(p);
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
            if (Math.abs(p.pose.p.z - z) <= PLANK_ALONG_TOL && Math.abs(p.pose.p.y - restY) <= PLANK_HEIGHT_TOL) break;
            log.push(
                `plank ${taken}: landed at z ${p.pose.p.z.toFixed(2)} y ${p.pose.p.y.toFixed(2)} (wanted ${z.toFixed(2)}, ${restY.toFixed(2)})`
            );
            if (attempt === 2) break; // leave it where it lies (and fail)
            look({ x: p.pose.p.x, y: p.pose.p.y + 0.05, z: p.pose.p.z });
            step({}, 4);
            step({ grab: true });
            if (s.physics.heldId !== p.id) break;
            yaw = 0;
            ease(-0.3, 20, (v) => (pitch = v), pitch);
            straighten(p);
            step({}, 20);
        }
        landed.push({ id: p.id, dy: p.pose.p.y - restY, dz: p.pose.p.z - z });
        // up the deck's middle to just short of it (clear of its edge: you are 0.3 m round): both
        // beam lines are then within the hammer's 35 degrees, without touching the loose plank
        yaw = 0;
        pitch = 0;
        walkTo(BRIDGE_X, Math.max(p.pose.p.z + 0.45, s.player.z - 1.5), true);
        let held = 0;
        for (const beam of beams) {
            const at = onBeam(beam, p.pose.p.z);
            if (nail({ x: at.x, y: p.pose.p.y + 0.05, z: p.pose.p.z }, `plank ${taken} over ${beam.name}`)) held++;
            if (process.env.GATE_DEBUG)
                log.push(
                    `CONNS ${[...s.joints.graph.connections()].map((c) => `${c.id}:${c.a}>${c.b} n${c.nails.length}`).join(' ')} events ${s.events
                        .slice(-3)
                        .map((e) => e.kind + '@' + (e.tick / 60).toFixed(1))
                        .join(',')}`
                );
        }
        if (process.env.GATE_DEBUG)
            log.push(
                `plank ${taken} done at ${(s.tick / 60).toFixed(0)} s: z ${p.pose.p.z.toFixed(2)} y ${p.pose.p.y.toFixed(2)} (wanted ${z.toFixed(2)}), ${held} nails`
            );
    };
    for (const z of deck.slice(0, -1)) layPlank(z);
    phase('far ends');
    walkTo(BRIDGE_X, BRIDGE.nearEdge + 3.5, true);
    waitForSafe(60);
    // ---- 3. out on the deck: nail both beams' far ends into the far capstone
    walkTo(BRIDGE_X, deck[deck.length - 2] + 0.5);
    for (let b = 0; b < 2; b++) nail(onBeam(beams[b], farNailZ), `beam ${b} far end`, deck[deck.length - 2]);
    walkTo(BRIDGE_X, deck[deck.length - 2] + 1.2);
    layPlank(deck[deck.length - 1]);
    phase('to the ute');
    // ---- 4. back to the yard, along past the stacks to the ute's driver's door (its right side)
    const ute = s.ute;
    const uteYaw = () => {
        const q = ute.pose.q;
        return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
    };
    const wrap = (a: number) => a - Math.round(a / (2 * Math.PI)) * 2 * Math.PI;
    const u0 = { ...ute.pose.p };
    const side = { x: -Math.cos(uteYaw()), z: Math.sin(uteYaw()) };
    const door = { x: u0.x + side.x * 2.2, z: u0.z + side.z * 2.2 };
    walkTo(BRIDGE_X, 6.6, true);
    walkTo(door.x, door.z);
    // look at the door and get in
    yaw = Math.atan2(side.x, side.z);
    pitch = -Math.atan2(s.player.y + EYE_HEIGHT - (u0.y + 0.6), 2.2 - 0.8);
    step({}, 5);
    step({ grab: true });
    if (s.driver !== 0) log.push('could not get in the ute');
    yaw = 0;
    pitch = 0;
    if (pullPlankNails) for (const c of [...s.joints.graph.connections()]) if (c.b !== GROUND) s.joints.remove(c.id);
    // the deck as it lies before the ute comes
    const before = new Map(landed.map((l) => [l.id, { ...s.entities.find((e) => e.id === l.id)!.pose.p }]));

    // no flood while driving over (the turn in the yard and the crossing take about a minute)
    waitForSafe(90);
    phase('drive');
    /** Drives (moveZ > 0) or reverses at a crawl with this steer for up to `ticks`, until `done`. */
    const drive = (dir: 1 | -1, steerOf: () => number, done: () => boolean, ticks: number, speed = 1.2) => {
        for (let k = 0; k < ticks && !done(); k++) {
            const v = s.vehicle!.speed() * dir;
            const throttle = Math.max(0, Math.min(1, (speed - v) * 0.8 + 0.15));
            const steer = Math.max(-1, Math.min(1, steerOf()));
            s.step({ ...neutralCommand(n++), moveZ: dir * throttle, moveX: steer, jump: v > speed + 0.5 });
        }
    };
    const stop = () => {
        for (let k = 0; k < 120 && Math.abs(s.vehicle!.speed()) > 0.05; k++)
            s.step({ ...neutralCommand(n++), jump: true });
    };
    /** Steer (forward) towards a point: positive yaw error steers with moveX < 0. */
    const towards = (x: number, z: number) => () =>
        -3 * wrap(Math.atan2(x - ute.pose.p.x, z - ute.pose.p.z) - uteYaw());
    // along the yard south of the stack that is left, to the bridge's side of the yard
    drive(1, towards(-2.2, 4.7), () => ute.pose.p.x > -2.4, 60 * 20);
    stop();
    // three-point turn: forward on right lock, back on left lock (both turn it the same way) until it
    // faces the bridge (yaw pi: towards -z)
    for (let leg = 0; leg < 12 && Math.abs(wrap(uteYaw() - Math.PI)) > 0.06; leg++) {
        const from = { ...ute.pose.p };
        const dir = leg % 2 === 0 ? 1 : -1;
        const left = () => wrap(Math.PI - uteYaw());
        drive(
            dir,
            () => (left() > 0.15 ? -dir : -dir * left() * 6),
            () => Math.hypot(ute.pose.p.x - from.x, ute.pose.p.z - from.z) > 1.5 || Math.abs(left()) < 0.04,
            60 * 6,
            0.8
        );
        stop();
    }
    // back up the bridge's line to give it a straight run (reversing: the tail goes where you steer
    // the other way)
    drive(
        -1,
        () => {
            const tx = BRIDGE_X;
            const tz = ute.pose.p.z + 2;
            const back = wrap(uteYaw() + Math.PI);
            return 3 * wrap(Math.atan2(tx - ute.pose.p.x, tz - ute.pose.p.z) - back);
        },
        () => ute.pose.p.z > 8.5,
        60 * 15,
        0.8
    );
    stop();
    // the start line: on the bridge's line, facing it
    const startLine = BRIDGE.nearEdge + 5;
    let atStart: { x: number; yaw: number } | null = null;
    const target = BRIDGE.farEdge - 3;
    let minY = Infinity;
    for (let k = 0; k < 60 * 25 && ute.pose.p.z > target; k++) {
        const dy = wrap(uteYaw() - Math.PI);
        const steer = Math.max(-1, Math.min(1, 4 * (BRIDGE_X - ute.pose.p.x) + 3 * dy));
        s.step({ ...neutralCommand(n++, Math.PI), moveZ: 0.25, moveX: steer });
        const u = ute.pose.p;
        if (!atStart && u.z < startLine) atStart = { x: u.x - BRIDGE_X, yaw: dy };
        if (u.z < BRIDGE.nearFace && u.z > BRIDGE.farFace) minY = Math.min(minY, u.y);
    }
    // how far each plank was shoved by the ute going over
    const shift = landed.map((l) => {
        const a = before.get(l.id)!;
        const b = s.entities.find((e) => e.id === l.id)!.pose.p;
        return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    });
    return { s, log, deck, placed, target, minY, beams, phases, landed, shift, atStart, u0, floods };
}

/** A nailed deck barely moves under the ute; the same planks only laid are shoved about (m). */
export const NAILED_SHIFT_MAX = 0.03;
export const LOOSE_SHIFT_MIN = 0.1;

function report(name: string, r: ReturnType<typeof buildAndCross>) {
    const g = r.s.joints.graph;
    let anchors = 0;
    let deckJoints = 0;
    for (const c of g.connections()) {
        if (c.b === -1) anchors++;
        else deckJoints++;
    }
    const worst = (f: (l: (typeof r.landed)[number]) => number) => Math.max(...r.landed.map((l) => Math.abs(f(l))));
    console.log(
        `${name}: ${r.placed} planks (landed within ${(worst((l) => l.dy) * 100).toFixed(1)} cm of the deck plane, ${(worst((l) => l.dz) * 100).toFixed(1)} cm along), ${anchors} anchors, ${deckJoints} deck joints, ${g.nailCount} nails; ute from (${r.u0.x.toFixed(1)}, ${r.u0.z.toFixed(1)}) crossed the start line ${r.atStart ? `${(r.atStart.x * 100).toFixed(1)} cm off the line, ${r.atStart.yaw.toFixed(3)} rad askew` : 'never'}, reached z ${r.s.ute.pose.p.z.toFixed(2)} (target ${r.target.toFixed(2)}), lowest over the gap ${(r.minY - YARD_Y).toFixed(2)} m above the yard; planks shifted up to ${(Math.max(...r.shift) * 100).toFixed(1)} cm under it`
    );
    console.log(
        `   floods: ${r.floods.map((f) => `siren at ${(f.tell / 60).toFixed(0)} s, over at ${(f.end / 60).toFixed(0)} s, the crossing moved up to ${(f.moved * 100).toFixed(1)} cm`).join('; ')}; ${r.s.hazards.floodMoved} pieces washed away, ${r.s.hazards.gustCount} gusts`
    );
    for (const l of r.log) console.log('  ', l);
    if (process.env.GATE_DEBUG)
        console.log('   phases', r.phases.map((ph) => `${ph.name}@${(ph.tick / 60).toFixed(0)}`).join(' '));
    for (const e of r.s.events)
        if (e.kind === 'fell')
            console.log('   FELL at tick', e.tick, r.phases.filter((ph) => ph.tick <= e.tick).pop()?.name);
    return { anchors, deckJoints };
}

describe('the yard crossing, built by a player and driven over (Epic 5 gate)', () => {
    it('from inputs alone: beams, a nailed plank deck, both ends anchored; the ute drives from its spawn, bank to bank', () => {
        const r = buildAndCross();
        const { anchors, deckJoints } = report('player-built bridge', r);
        expect(r.log.filter((l) => l.includes('ute'))).toEqual([]);
        expect(r.placed).toBe(r.deck.length);
        // every plank came to rest flat on both beams, on its spot
        expect(r.landed.length).toBe(r.deck.length);
        for (const l of r.landed) {
            expect(Math.abs(l.dy)).toBeLessThanOrEqual(PLANK_HEIGHT_TOL);
            expect(Math.abs(l.dz)).toBeLessThanOrEqual(PLANK_ALONG_TOL);
        }
        // both beams anchored at both ends: each end has its own anchor, into its own bank
        const g = r.s.joints.graph;
        expect(anchors).toBe(4);
        for (const beam of r.beams) {
            const ends = g.of(beam.id).filter((c) => c.b === GROUND);
            expect(ends.length).toBe(2);
            expect(ends.filter((c) => c.anchorB.z > BRIDGE.nearFace - 0.1).length).toBe(1);
            expect(ends.filter((c) => c.anchorB.z < BRIDGE.farFace + 0.1).length).toBe(1);
        }
        // every deck plank nailed to both beams
        expect(deckJoints).toBe(2 * r.deck.length);
        for (const l of r.landed)
            for (const beam of r.beams) expect(g.find(l.id, beam.id), `plank ${l.id} to ${beam.name}`).toBeDefined();
        // driven from where it was parked, turned round in the yard, onto the bridge's line
        expect(r.atStart).not.toBeNull();
        expect(Math.abs(r.atStart!.x)).toBeLessThan(0.1);
        expect(Math.abs(r.atStart!.yaw)).toBeLessThan(0.05);
        expect(r.s.ute.pose.p.z).toBeLessThan(r.target);
        expect(r.minY).toBeGreaterThan(YARD_Y);
        // both floods came while it was being built, and moved nothing nailed down: the beams
        // (nailed at their near ends) through the first, the half-built deck through the second
        expect(r.floods.length).toBe(2);
        for (const f of r.floods) expect(f.moved).toBeLessThan(NAILED_SHIFT_MAX);
        expect(r.s.hazards.floodMoved).toBe(0);
        // the nailed deck held its shape under the ute
        expect(Math.max(...r.shift)).toBeLessThan(NAILED_SHIFT_MAX);
        expect(r.s.progress.falls).toBe(0);
    }, 300_000);

    it('the same deck with its plank nails pulled before the ute sets off: the ute going over shoves the planks about', () => {
        const r = buildAndCross(true);
        const { anchors, deckJoints } = report('same deck, plank nails pulled', r);
        expect(anchors).toBe(4);
        expect(deckJoints).toBe(0);
        expect(r.atStart).not.toBeNull();
        expect(Math.max(...r.shift)).toBeGreaterThan(LOOSE_SHIFT_MIN);
    }, 300_000);
});

describe('walking onto beams laid anywhere on the seats', () => {
    /**
     * Before the deck lips, a beam whose end stopped a few centimetres short of the capstone's back
     * edge left a ledge narrower than the character's step width between two rises (10 cm cap, then
     * 15 cm of beam): the walker crawled there for seconds (Epic 9 measured 322 ticks under 0.3 m/s).
     * The lip now runs at beam-top height right behind the seat, so whatever the offset there is one
     * level surface (or a small dip) to walk across.
     */
    it('beams 0, 5, 10 and 15 cm off the seat edge (and where a playthrough laid them): under 60 slow ticks at a walk', async () => {
        const { BRIDGE_SEAT } = await import('../../src/levels/timber-yard.ts');
        const { quatMul } = await import('../../src/voxels/math.ts');
        const flat = quatMul(quatFromYawPitchRoll(Math.PI / 2, 0, 0), quatFromYawPitchRoll(0, Math.PI / 2, 0));
        const lipFront = BRIDGE.nearFace + BRIDGE_SEAT;
        const layouts: { name: string; beams: [number, number][] }[] = [0, 0.05, 0.1, 0.15].map((off) => ({
            name: `${off * 100} cm off the lip`,
            beams: [
                [BRIDGE_X - 0.17, lipFront - off - 1.6],
                [BRIDGE_X + 0.17, lipFront - off - 1.6]
            ]
        }));
        // where the yard's building playthrough laid them when Epic 9 found the crawl
        layouts.push({
            name: 'playthrough',
            beams: [
                [-1.088, -1.904],
                [-0.751, -1.921]
            ]
        });
        for (const { name, beams } of layouts) {
            const s = new LabSim({ level: timberYardLevel });
            ['beam-0', 'beam-1'].forEach((nm, i) =>
                s.physics.place(
                    s.entities.find((e) => e.name === nm)!.id,
                    pose(beams[i][0], YARD_Y + 0.3, beams[i][1], flat)
                )
            );
            let n = 0;
            for (; n < 90; n++) s.step(neutralCommand(n));
            s.fpActive = true;
            s.placePlayer((beams[0][0] + beams[1][0]) / 2, BRIDGE.nearEdge + 2.5, 0);
            for (let k = 0; k < 20; k++) s.step(neutralCommand(n++));
            let slow = 0;
            let t = 0;
            for (; t < 60 * 15 && s.player.z > BRIDGE.zc; t++) {
                const z = s.player.z;
                // the playthrough's walk: half stick
                s.step({ ...neutralCommand(n++, 0), moveZ: 0.5 });
                if (t > 10 && (z - s.player.z) * 60 < 0.3) slow++;
            }
            console.log(`walking onto beams ${name}: mid-gap after ${t} ticks, ${slow} under 0.3 m/s`);
            expect(s.player.z, name).toBeLessThanOrEqual(BRIDGE.zc);
            expect(slow, name).toBeLessThan(60);
            expect(s.progress.falls, name).toBe(0);
        }
    }, 120_000);
});
