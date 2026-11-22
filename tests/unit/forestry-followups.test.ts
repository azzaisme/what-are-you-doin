/**
 * Epic 6 follow-ups, played through player commands only (no prop placed by hand, nobody
 * teleported):
 *
 * - Beams: pull the sawmill's lever, two beavers carry two whole logs in, the sawn beams become
 *   the bridge's stringers (the yard's own beams untouched), decked, walked over.
 * - Determinism: a recorded two-beaver script (fell, carry, saw, regrow) replayed open loop gives
 *   the same sawmill, trees and props.
 *
 * The helpers are copies of forestry-gate.test.ts's (kept apart while Epic 9 retunes that file's
 * carry for the beaver body); fold them together once both have landed.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { SAWMILL, sawmillToWorld } from '../../src/levels/forestry.ts';
import { BRIDGE, BRIDGE_X, YARD_FORESTRY, YARD_Y, timberYardLevel } from '../../src/levels/timber-yard.ts';
import { neutralCommand } from '../../src/sim/commands.ts';
import type { PlayerCommand } from '../../src/sim/commands.ts';
import { EYE_HEIGHT, LabSim } from '../../src/sim/lab-sim.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { SAW } from '../../src/sim/sawmill.ts';

beforeAll(() => initPhysics());

const SPOT = YARD_FORESTRY.sawmill!;
const G = SAWMILL.guide;
const GUIDE = sawmillToWorld(SPOT, (G.x0 + G.x1) / 2, 0, 0);

type Cmd = Partial<PlayerCommand>;

/**
 * A lying log's frame: points along it (from its middle, `d` m along its axis, which is turned to
 * point east) and out to its north side (`o` m, negative: north), and the yaw that faces it from
 * the north.
 */
function sideOf(p: { p: { x: number; z: number }; q: { x: number; y: number; z: number; w: number } }) {
    const q = p.q;
    let ax = 1 - 2 * (q.y * q.y + q.z * q.z);
    let az = 2 * (q.x * q.z - q.w * q.y);
    const len = Math.hypot(ax, az) || 1;
    ax /= len;
    az /= len;
    if (ax < 0) {
        ax = -ax;
        az = -az;
    }
    // the perpendicular pointing south (+z)
    const nx = -az;
    const nz = ax;
    return {
        at: (d: number, o: number) => ({ x: p.p.x + ax * d + nx * o, z: p.p.z + az * d + nz * o }),
        /** Facing south (towards +z: from the north side, at the log). */
        faceYaw: Math.atan2(-nx, -nz)
    };
}

/** A sim driven by per-player commands, with walking and looking helpers. */
class Play {
    readonly s: LabSim;
    private n = 0;
    /** Each player's look (kept between steps, as a mouse would). */
    readonly yaw: number[];
    readonly pitch: number[];

    constructor(players: number) {
        // the hazards are off, as in forestry-gate.test.ts: the beams laid across the creek would
        // set off the flood while the deck goes on
        this.s = new LabSim({ level: timberYardLevel, hazards: false });
        this.s.step(neutralCommand(0));
        this.s.fpActive = true;
        if (players > 1) this.s.setPlayerCount(players);
        this.yaw = this.s.players.map((p) => p.yaw);
        this.pitch = this.s.players.map(() => 0);
        this.step({}, {}, 30);
    }

    /** When set, every step's two commands are recorded here (to replay them elsewhere). */
    script: [PlayerCommand, PlayerCommand][] | null = null;

    /** Steps with player 0's and player 1's commands (each gets its kept look unless given). */
    step(a: Cmd = {}, b: Cmd = {}, k = 1): void {
        for (let i = 0; i < k; i++) {
            const c0 = { ...neutralCommand(this.n), yaw: this.yaw[0], pitch: this.pitch[0], ...a };
            const c1 = { ...neutralCommand(this.n), yaw: this.yaw[1], pitch: this.pitch[1], ...b };
            this.yaw[0] = c0.yaw;
            this.pitch[0] = c0.pitch;
            this.yaw[1] = c1.yaw;
            this.pitch[1] = c1.pitch;
            this.script?.push([c0, c1]);
            this.s.step(c0, c1);
            this.n++;
        }
    }

    /** Player i's command slot (the other idles). */
    one(i: number, c: Cmd, k = 1): void {
        if (i === 0) this.step(c, {}, k);
        else this.step({}, c, k);
    }

    /** Turns player i smoothly to a yaw (a held prop turns with them). */
    turn(i: number, yaw: number, ticks = 40): void {
        const from = this.yaw[i];
        let d = yaw - from;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        for (let k = 1; k <= ticks; k++) this.one(i, { yaw: from + (d * k) / ticks });
    }

    /** Eases player i's pitch. */
    tilt(i: number, pitch: number, ticks = 30): void {
        const from = this.pitch[i];
        for (let k = 1; k <= ticks; k++) this.one(i, { pitch: from + ((pitch - from) * k) / ticks });
    }

    /** Walks player i to (x, z) facing where they go, then stops. */
    walkTo(i: number, x: number, z: number, speed = 0.6): void {
        const p = this.s.players[i];
        for (let k = 0; k < 2000; k++) {
            const dx = x - p.x;
            const dz = z - p.z;
            const d = Math.hypot(dx, dz);
            if (d < 0.08) break;
            this.one(i, { yaw: Math.atan2(-dx, -dz), moveZ: Math.min(speed, d * 1.5 + 0.1) });
        }
        this.one(i, {}, 15);
    }

    /** Walks player i without turning: strafes and steps in their own frame to (x, z). */
    shuffleTo(i: number, x: number, z: number, speed = 0.4): void {
        const p = this.s.players[i];
        for (let k = 0; k < 2000; k++) {
            const dx = x - p.x;
            const dz = z - p.z;
            const d = Math.hypot(dx, dz);
            if (d < 0.06) break;
            const yaw = this.yaw[i];
            // world direction to (forward, right): forward = (-sin, -cos), right = (cos, -sin)
            const f = (-Math.sin(yaw) * dx - Math.cos(yaw) * dz) / d;
            const r = (Math.cos(yaw) * dx - Math.sin(yaw) * dz) / d;
            const v = Math.min(speed, d * 1.5 + 0.08);
            this.one(i, { moveZ: f * v, moveX: r * v });
        }
        this.one(i, {}, 15);
    }

    /** The look from player i's eye at a point. */
    lookAt(i: number, x: number, y: number, z: number): { yaw: number; pitch: number } {
        const p = this.s.players[i];
        const dx = x - p.x;
        const dz = z - p.z;
        return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(y - (p.y + EYE_HEIGHT), Math.hypot(dx, dz)) };
    }

    /** Player i looks at a point (eased) and presses grab; returns what they then hold. */
    grabAt(i: number, x: number, y: number, z: number): number {
        const l = this.lookAt(i, x, y, z);
        this.turn(i, l.yaw, 20);
        this.tilt(i, l.pitch, 15);
        this.one(i, { grab: true });
        return this.s.physics.heldIdOf(i);
    }

    entity(name: string) {
        return this.s.entities.find((e) => e.name === name)!;
    }
}

/**
 * The look that lowers what player i holds by `drop` m at its hold distance, whatever the body's eye
 * height (a beaver's eye is 1.22 m up, a person's was 1.86 m).
 */
function lowerBy(g: Play, i: number, drop: number): number {
    const d = g.s.physics.rig(i)!.holdDist;
    return Math.asin(Math.max(-1, Math.min(1, Math.sin(g.pitch[i]) - drop / d)));
}

/**
 * Two players (0 and 1) carry a lying log into the sawmill's guide together, by input only: round
 * to its north side, take it either side of its middle, lift, forward to the guide's line, sideways
 * into the guide, square it up, lower, let go, step back. Returns the lowest height it was carried
 * at above where it lay.
 */
function carryIntoGuide(
    g: Play,
    log: {
        id: number;
        pose: { p: { x: number; y: number; z: number }; q: { x: number; y: number; z: number; w: number } };
    }
): number {
    const s = g.s;
    const lp = log.pose.p;
    // ---- wait until it lies still (a log still rolling would be gone from where they reach)
    const body = s.physics.bodies.get(log.id)!.body;
    for (let k = 0; k < 900; k++) {
        const v = body.linvel();
        const w = body.angvel();
        if (Math.hypot(v.x, v.y, v.z) < 0.01 && Math.hypot(w.x, w.y, w.z) < 0.03) break;
        g.step();
    }
    // ---- both come round to its north side (away from the mill) and take it either side of
    // its middle, facing it
    const side = sideOf(log.pose);
    for (const [i, d] of [
        [0, -0.65],
        [1, 0.65]
    ] as const) {
        const f = side.at(d, -2.0);
        g.walkTo(i, f.x, f.z);
        const n = side.at(d, -1.05);
        g.walkTo(i, n.x, n.z);
    }
    g.turn(0, side.faceYaw);
    g.turn(1, side.faceYaw);
    const grip0 = sideOf(log.pose).at(-0.65, 0);
    expect(g.grabAt(0, grip0.x, lp.y, grip0.z)).toBe(log.id);
    const grip1 = sideOf(log.pose).at(0.65, 0);
    expect(g.grabAt(1, grip1.x, lp.y, grip1.z)).toBe(log.id);
    expect(s.physics.holders(log.id)).toBe(2);
    // lift: each hold point about 0.7 m above where it lay
    const y0 = lp.y;
    const up = (i: number) =>
        Math.asin(Math.max(-1, Math.min(1, (y0 + 0.7 - (s.players[i].y + EYE_HEIGHT)) / s.physics.rig(i)!.holdDist)));
    g.yaw[0] = g.yaw[1] = side.faceYaw;
    g.pitch[0] = up(0);
    g.pitch[1] = up(1);
    g.step({}, {}, 60);
    // the beaver at the end that has swung south steps back until the log lies east-west: a felled
    // log can lie well askew, and carried askew its two carriers end up far apart along the way
    const swing = () => {
        const q = log.pose.q;
        const ax = 1 - 2 * (q.y * q.y + q.z * q.z);
        const az = 2 * (q.x * q.z - q.w * q.y);
        // the east-pointing end's angle from east (positive: swung south)
        return ax < 0 ? Math.atan2(-az, -ax) : Math.atan2(az, ax);
    };
    const squared = () => Math.max(-0.2, Math.min(0.2, swing() * 1.5));
    for (let k = 0; k < 480 && Math.abs(swing()) > 0.05; k++) {
        const c = Math.max(-0.08, Math.min(0.08, swing()));
        // player 0 holds the west end, player 1 the east end; forward is south
        g.step({ moveZ: c }, { moveZ: -c });
    }
    g.step({}, {}, 30);
    // forward (south) to the guide's line, let it settle, then sideways (west: their right)
    // into the guide from its open east end
    let minY = Infinity;
    for (let k = 0; k < 900 && lp.z < GUIDE.z - 0.04; k++) {
        g.step({ moveZ: 0.35 }, { moveZ: 0.35 });
        minY = Math.min(minY, lp.y);
    }
    g.step({}, {}, 60);
    // (gently keeping it on the line: forward is south)
    const keep = () => Math.max(-0.12, Math.min(0.12, (GUIDE.z - lp.z) * 0.6));
    for (let k = 0; k < 900 && lp.x > GUIDE.x + 0.04; k++) {
        g.step({ moveX: 0.35, moveZ: keep() }, { moveX: 0.35, moveZ: keep() });
        minY = Math.min(minY, lp.y);
    }
    for (let k = 0; k < 120 && Math.abs(lp.z - GUIDE.z) > 0.08; k++) g.step({ moveZ: keep() }, { moveZ: keep() });
    expect(s.physics.holders(log.id)).toBe(2);
    // carried at a sensible height all the way
    expect(minY).toBeGreaterThan(y0 + 0.3);
    expect(Math.abs(lp.x - GUIDE.x)).toBeLessThan(0.5);
    expect(Math.abs(lp.z - GUIDE.z)).toBeLessThan(0.3);
    // square it up along the guide
    for (let k = 0; k < 180 && Math.abs(swing()) > 0.03; k++) {
        const c = squared();
        // player 0 holds the west end, player 1 the east end; forward is south
        g.step({ moveZ: keep() + c }, { moveZ: keep() - c });
    }
    // lower it into the guide (lowering the look draws it in: step after it), let go, step
    // out of the blade guard
    const p0 = g.pitch[0];
    const p1 = g.pitch[1];
    const t0 = lowerBy(g, 0, 0.2);
    const t1 = lowerBy(g, 1, 0.2);
    for (let k = 1; k <= 60; k++) {
        g.pitch[0] = p0 + ((t0 - p0) * k) / 60;
        g.pitch[1] = p1 + ((t1 - p1) * k) / 60;
        g.step({ moveZ: keep() }, { moveZ: keep() });
    }
    for (let k = 0; k < 120 && Math.abs(lp.z - GUIDE.z) > 0.06; k++) g.step({ moveZ: keep() }, { moveZ: keep() });
    expect(Math.abs(lp.z - GUIDE.z)).toBeLessThan(0.15);
    g.step({ grab: true }, { grab: true });
    expect(s.physics.holders(log.id)).toBe(0);
    g.step({ moveZ: -0.6 }, { moveZ: -0.6 }, 90);
    return minY - y0;
}

/**
 * Player 0 shoulders a lying beam (along x) across the creek by one end (`end` +1: its east end,
 * standing east of it; -1: its west end) and lays it at `x` on the bridge line, by input only.
 * With `route` it first carries it across to `route.x`, north along that line to `route.z`, and
 * only then steps across to `x`.
 */
function shoulderBeam(
    g: Play,
    beam: {
        id: number;
        pose: { p: { x: number; y: number; z: number }; q: { x: number; y: number; z: number; w: number } };
    },
    x: number,
    end: 1 | -1,
    route?: { x: number; z: number }
): void {
    const s = g.s;
    const b = beam.pose.p;
    // along it (it may lie a little skewed, more so once brushed past): its axis, pointing east
    // (the yard's beams, taken by their east end, keep the yard bridge test's moves: along x)
    const axis = () => {
        const q = beam.pose.q;
        const sx = 1 - 2 * (q.y * q.y + q.z * q.z);
        const sz = 2 * (q.x * q.z - q.w * q.y);
        const n = Math.sign(sx) / Math.hypot(sx, sz);
        return end > 0 ? { x: 1, z: 0 } : { x: sx * n, z: sz * n };
    };
    let a = axis();
    g.walkTo(0, b.x + a.x * end * 2.4, b.z + a.z * end * 2.4 + 1.0);
    a = axis();
    g.walkTo(0, b.x + a.x * end * 2.4, b.z + a.z * end * 2.4);
    a = axis();
    g.turn(0, (end * Math.PI) / 2); // facing along it, at that end
    expect(g.grabAt(0, b.x + a.x * end * 1.45, b.y, b.z + a.z * end * 1.45)).toBe(beam.id);
    g.tilt(0, -0.25, 40);
    g.one(0, {}, 30);
    // turn to the creek: the beam turns with you and points out over the gap
    g.turn(0, 0, 120);
    const p0 = s.players[0];
    // (steering by the beam itself: it is held a little to one side)
    const bx = () => beam.pose.p.x;
    if (route) {
        // first across to its own line, then north along it
        for (let k = 0; k < 900 && Math.abs(bx() - route.x) > 0.04; k++)
            g.one(0, { moveX: bx() > route.x ? -0.3 : 0.3 });
        for (let k = 0; k < 1200 && p0.z > route.z; k++)
            g.one(0, { moveZ: 0.5, moveX: Math.max(-0.2, Math.min(0.2, (route.x - bx()) * 2)) });
        g.one(0, {}, 30);
    }
    // (the yard bridge test's moves: across to the line, then straight to the bank)
    for (let k = 0; k < 900 && Math.abs(bx() - x) > 0.04; k++) g.one(0, { moveX: bx() > x ? -0.3 : 0.3 });
    for (let k = 0; k < 900 && p0.z > BRIDGE.nearEdge + 0.4; k++)
        g.one(0, { moveZ: 0.5, moveX: Math.max(-0.2, Math.min(0.2, (x - bx()) * 2)) });
    g.one(0, {}, 30);
    for (let k = 0; k < 60 && Math.abs(bx() - x) > 0.03; k++)
        g.one(0, { moveX: Math.max(-0.2, Math.min(0.2, (x - bx()) * 2)) });
    g.tilt(0, -0.7, 40);
    g.one(0, {}, 30);
    g.one(0, { grab: true });
    g.one(0, {}, 120);
    expect(s.physics.heldIdOf(0)).toBe(-1);
    expect(Math.abs(beam.pose.p.z - BRIDGE.zc)).toBeLessThan(0.3);
    expect(Math.abs(beam.pose.p.y - (YARD_Y + 0.12))).toBeLessThan(0.25);
    g.walkTo(0, x + 1.5, BRIDGE.nearEdge + 2.5);
}

/**
 * Player 1 carries a plank (lying along x) from where it lies, out along the beams, and lays it
 * across them at `deckZ`: takes it by its middle from its north side (at `pickZ`), steps `aside`
 * along it (if given), turns to the creek, goes to the bridge's end (by way of `via`, if given),
 * walks out, sets it down, backs off.
 */
function layPlank(
    g: Play,
    plank: { id: number; pose: { p: { x: number; y: number; z: number } } },
    deckZ: number,
    pickZ: number,
    via?: { x: number; z: number },
    aside?: number
): void {
    const s = g.s;
    const p = plank.pose.p;
    // from its north side, facing south, take it by its middle
    g.walkTo(1, p.x, pickZ);
    g.turn(1, Math.PI);
    expect(g.grabAt(1, p.x, p.y, p.z)).toBe(plank.id);
    g.tilt(1, -0.2, 30);
    // (first, still facing it, step `aside` m along it: room to turn)
    if (aside) g.shuffleTo(1, s.players[1].x + aside, s.players[1].z);
    // turn round to face the creek (yaw 0 faces north, -z); the plank stays across the view
    g.turn(1, 0, 90);
    if (via) g.shuffleTo(1, via.x, via.z);
    g.shuffleTo(1, BRIDGE_X, BRIDGE.nearEdge + 2.0);
    // out along the beams until the plank is over its spot, then set it down
    const p1 = s.players[1];
    for (let k = 0; k < 900 && plank.pose.p.z > deckZ + 0.05; k++) {
        const dx = Math.max(-0.2, Math.min(0.2, (BRIDGE_X - p1.x) * 2));
        // (onto the beams at a walk: the step up from the bank wants some pace)
        g.one(1, { moveZ: p1.z > BRIDGE.nearFace ? 0.8 : 0.3, moveX: dx });
    }
    g.one(1, {}, 20);
    g.tilt(1, -0.6, 40);
    g.one(1, {}, 30);
    g.one(1, { grab: true });
    g.one(1, {}, 90);
    expect(s.physics.heldIdOf(1)).toBe(-1);
    // it lies across the beams over the gap
    expect(plank.pose.p.y).toBeGreaterThan(YARD_Y + 0.15);
    expect(Math.abs(plank.pose.p.x - BRIDGE_X)).toBeLessThan(0.6);
    // back to the bank (backing up along the beams), then out of the way
    for (let k = 0; k < 900 && p1.z < BRIDGE.nearEdge + 0.8; k++) g.one(1, { moveZ: -0.3 });
    g.walkTo(1, BRIDGE_X + 3, BRIDGE.nearEdge + 3);
}

/** Player 0 walks over the bridge's deck to the far bank, without falling in. */
function walkOver(g: Play, planks: { pose: { p: { y: number } } }[]): void {
    const s = g.s;
    // (player 1 first stands back further, off player 0's way to the bridge end: walked into, a
    // player is shoved)
    g.walkTo(1, BRIDGE_X + 3, BRIDGE.nearEdge + 5.5);
    g.walkTo(0, BRIDGE_X, BRIDGE.nearEdge + 1.2);
    g.turn(0, 0);
    let topY = 0;
    for (let k = 0; k < 600 && s.players[0].z > BRIDGE.farEdge - 1; k++) {
        g.one(0, { moveZ: 0.8 });
        if (s.players[0].z < BRIDGE.nearFace && s.players[0].z > BRIDGE.farFace) topY = Math.max(topY, s.players[0].y);
    }
    expect(s.progress.falls).toBe(0);
    expect(s.players[0].z).toBeLessThan(BRIDGE.farEdge - 0.5);
    // stepped up onto the planks (plank top is 0.1 above the beams)
    expect(topY).toBeGreaterThan(YARD_Y + 0.25);
    for (const p of planks) expect(p.pose.p.y).toBeGreaterThan(YARD_Y + 0.15);
}

describe('beams by player input', () => {
    it('beams by input: switch the lever, carry two whole logs in, the sawn beams are the bridge stringers', () => {
        const g = new Play(2);
        const s = g.s;
        // ---- player 0 walks to the sawmill's lever and pulls it (grab while looking at it)
        const L = SAWMILL.lever;
        const lever = sawmillToWorld(SPOT, L.x, L.y + 0.12, L.z);
        g.walkTo(0, lever.x + 0.2, lever.z - 1.2);
        expect(s.sawmill!.mode).toBe('planks');
        g.grabAt(0, lever.x, lever.y, lever.z);
        expect(s.physics.heldIdOf(0)).toBe(-1);
        expect(s.sawmill!.mode).toBe('beam');
        expect(s.events.some((e) => e.text.startsWith('The sawmill is set to beams'))).toBe(true);
        g.walkTo(0, lever.x + 0.2, lever.z - 3);

        // ---- fell two trees (each falls west, towards the mill), carry each whole log in
        const beams: ReturnType<Play['entity']>[] = [];
        for (const tree of [2, 4]) {
            const t = YARD_FORESTRY.trees[tree];
            // round the tree (coming from the mill, west of it) to its east side
            for (const [i, dz] of [
                [0, -1],
                [1, 1]
            ] as const) {
                g.walkTo(i, t.x - 1.2, t.z + dz * 1.4);
                g.walkTo(i, t.x + 1.0, t.z + dz * 1.4);
                g.walkTo(i, t.x + 1.0, t.z + dz * 0.4);
            }
            const chew = (i: number) => g.lookAt(i, t.x + (t.lean?.x ?? 0) * 0.6, YARD_Y + 0.6, t.z);
            const c0 = chew(0);
            const c1 = chew(1);
            for (let k = 0; k < 600 && s.forestry.treeState(tree).phase === 'standing'; k++)
                g.step({ ...c0, grab: k % 30 === 0 }, { ...c1, grab: k % 30 === 0 });
            expect(s.forestry.treeState(tree).phase).toBe('down');
            expect(s.forestry.fallDirection(tree).x).toBeLessThan(-0.9);
            g.step({}, {}, 300);
            const log = s.forestry.logOf(tree)!;
            carryIntoGuide(g, log);
            for (let k = 0; k < 240 && s.sawmill!.phase === 'ready'; k++) g.step();
            expect(s.sawmill!.stats.takenIds.at(-1)).toBe(log.id);
            for (let k = 0; k < SAW.cutTicks + 30; k++) g.step();
            // a whole log in beam mode: one beam, no planks
            const out = s.entities.filter((e) => e.name.startsWith('beam-') && e.visible && e.id >= 396);
            expect(out.length).toBe(beams.length + 1);
            beams.push(out.find((b) => !beams.includes(b))!);
            // (stats.planks counts every piece out; none of the sawn planks is showing)
            expect(s.sawmill!.stats.planks).toBe(beams.length);
            expect(s.entities.some((e) => e.name.startsWith('extra-plank-') && e.visible && e.id >= 380)).toBe(false);
        }
        expect(beams.map((b) => b.name)).toEqual(['beam-12', 'beam-13']);
        expect(s.sawmill!.stats.taken).toBe(2);
        // the yard's own beams have not moved
        const yardBeams = ['beam-0', 'beam-1'].map((n) => ({ ...g.entity(n).pose.p }));

        // ---- player 0 shoulders the two sawn beams across the creek, each by its west end (the
        // mill is east of the rack), north on a line clear of the yard's beams, then across
        // (the second may lie partly on the first, on the rack's upper layer: the top one first)
        const [top, under] = [...beams].sort((a, b) => b.pose.p.y - a.pose.p.y);
        // (north between the yard's beams, whose east end is at x -0.6, and the creek's warning
        // sign east of the bridge end, whose board a beaver's beam would hit: x 0.28 to 0.92)
        const route = { x: -0.15, z: BRIDGE.nearEdge + 0.5 };
        shoulderBeam(g, top, BRIDGE_X - 0.12, -1, route);
        shoulderBeam(g, under, BRIDGE_X + 0.12, -1, route);
        expect(s.progress.falls).toBe(0);
        // both under the deck (a plank is 2.4 m long), side by side
        for (const b of beams) expect(Math.abs(b.pose.p.x - BRIDGE_X)).toBeLessThan(0.6);
        expect(Math.abs(beams[0].pose.p.x - beams[1].pose.p.x)).toBeGreaterThan(0.15);

        // ---- player 1 decks them with three planks off the yard's stack (top first), round the
        // west end of the yard's beams
        // (player 0 stands well clear of the planks' way first: walked into, a player is shoved)
        g.walkTo(0, 3, 6);
        const stack = ['extra-plank-4', 'extra-plank-3', 'extra-plank-2'].map((n) => g.entity(n));
        const deckZ = [BRIDGE.farFace + 0.6, BRIDGE.zc, BRIDGE.nearFace - 0.6];
        stack.forEach((plank, n) => {
            // (back from the bridge round the yard's beams' east end, south of them)
            g.walkTo(1, 0, 4.7);
            // (each taken to the west, clear of the yard's beams' west end, before turning north)
            const x = plank.pose.p.x - 1.5;
            layPlank(g, plank, deckZ[n], plank.pose.p.z - 1.6, { x, z: BRIDGE.nearEdge + 2.0 }, -1.5);
        });
        const decked = stack.filter((p) => p.pose.p.z < BRIDGE.nearFace && p.pose.p.z > BRIDGE.farFace);
        expect(decked.length).toBe(3);

        // ---- player 0 walks over: the sawn beams carry the deck
        walkOver(g, stack);
        for (const b of beams) {
            expect(Math.abs(b.pose.p.z - BRIDGE.zc)).toBeLessThan(0.3);
            expect(b.pose.p.y).toBeGreaterThan(YARD_Y);
        }
        // and the yard's beams were never used
        ['beam-0', 'beam-1'].forEach((n, i) => {
            const p = g.entity(n).pose.p;
            expect(Math.hypot(p.x - yardBeams[i].x, p.z - yardBeams[i].z)).toBeLessThan(0.05);
        });
    }, 300_000);
});

/**
 * Everything sawing and regrowth decide, for comparing two runs: the sawmill (phase, mode, its
 * counts and which logs it took), every stand tree's state and cut, the forestry counts, and every
 * entity's visibility, pose and animation channels (props, sawn pieces, markers, the saw itself).
 */
function woodState(s: LabSim): unknown {
    const m = s.sawmill!;
    return {
        sawmill: { phase: m.phase, mode: m.mode, stats: { ...m.stats, takenIds: [...m.stats.takenIds] } },
        trees: YARD_FORESTRY.trees.map((_, n) => s.forestry.treeState(n)),
        forestry: { ...s.forestry.stats },
        entities: s.entities.map((e) => [
            e.name,
            e.visible,
            e.pose.p.x,
            e.pose.p.y,
            e.pose.p.z,
            e.pose.q.x,
            e.pose.q.y,
            e.pose.q.z,
            e.pose.q.w,
            ...e.anim
        ])
    };
}

describe('determinism: sawing and regrowth', () => {
    it('one command script, run twice, gives the same sawmill, the same regrowth and the same prop poses', () => {
        // ---- run 1: two beavers fell tree 2, carry the log in, it is sawn into planks, the stump
        // regrows; every command is recorded, with the steps at which to compare
        const g = new Play(2);
        const s = g.s;
        g.script = [];
        const marks: number[] = [];
        const want: unknown[] = [];
        const mark = () => {
            marks.push(g.script!.length);
            want.push(woodState(s));
        };
        const tree = 2;
        const t = YARD_FORESTRY.trees[tree];
        g.walkTo(0, t.x + 1.0, t.z - 0.4);
        g.walkTo(1, t.x + 1.0, t.z + 0.4);
        const c0 = g.lookAt(0, t.x + (t.lean?.x ?? 0) * 0.6, YARD_Y + 0.6, t.z);
        const c1 = g.lookAt(1, t.x + (t.lean?.x ?? 0) * 0.6, YARD_Y + 0.6, t.z);
        for (let k = 0; k < 600 && s.forestry.treeState(tree).phase === 'standing'; k++)
            g.step({ ...c0, grab: k % 30 === 0 }, { ...c1, grab: k % 30 === 0 });
        g.step({}, {}, 300);
        mark(); // felled and lying
        const log = s.forestry.logOf(tree)!;
        carryIntoGuide(g, log);
        for (let k = 0; k < 240 && s.sawmill!.phase === 'ready'; k++) g.step();
        expect(s.sawmill!.stats.takenIds).toEqual([log.id]);
        mark(); // taken by the sawmill
        for (let k = 0; k < SAW.cutTicks / 2; k++) g.step();
        mark(); // half sawn
        for (let k = 0; k < SAW.cutTicks / 2 + 30; k++) g.step();
        expect(s.sawmill!.stats.planks).toBe(3);
        mark(); // the planks on the rack
        // the players walk off; the stump regrows
        g.step({ moveX: 0.5 }, { moveX: 0.5 }, 120);
        for (let k = 0; k < 4000 && s.forestry.treeState(tree).phase === 'down'; k++) g.step();
        expect(s.forestry.treeState(tree).phase).toBe('standing');
        expect(s.forestry.stats.regrown).toBe(1);
        g.step({}, {}, 60);
        mark(); // regrown

        // ---- run 2: a fresh sim (set up as run 1's: two players, the same 30 idle steps) fed the
        // recorded commands, open loop (nothing steers it back on course). Run 3, the check that
        // the comparison can fail: the same, but player 1 sidesteps for 10 ticks during the carry
        const replay = (alter: (k: number, b: PlayerCommand) => PlayerCommand): unknown[] => {
            const r = new Play(2).s;
            const got: unknown[] = [];
            let m = 0;
            g.script!.forEach(([a, b], k) => {
                r.step(a, alter(k, b));
                while (m < marks.length && marks[m] === k + 1) {
                    got.push(woodState(r));
                    m++;
                }
            });
            return got;
        };
        const got = replay((_k, b) => b);
        expect(got.length).toBe(want.length);
        for (let k = 0; k < want.length; k++) expect(got[k]).toEqual(want[k]);
        const k0 = marks[0] + 300; // carrying the log
        const altered = replay((k, b) => (k >= k0 && k < k0 + 10 ? { ...b, moveX: 1 } : b));
        expect(altered.length).toBe(want.length);
        expect(altered[1]).not.toEqual(want[1]); // the sawmill takes the log
        expect(altered.at(-1)).not.toEqual(want.at(-1));
    }, 300_000);
});
