/**
 * Epic 6's gate, played through player commands only: no prop is placed by hand, nobody is
 * teleported. Players walk, look, chew, chop, grab, carry, lower and let go.
 *
 * - Two beavers: chew a tree down, carry its log into the sawmill's guide together, it makes
 *   planks; one shoulders the yard's two beams across the creek, the other carries the sawn planks
 *   off the rack and lays them across the beams, and a player walks over the bridge. Then the
 *   stump regrows (its log was sawn).
 * - Solo: pick up the axe, chop a tree down, buck the log, carry a half into the guide.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { SAW_CUTTING, SAW_PROGRESS, SAW_STATE } from '../../src/assets/forestry.ts';
import { SAWMILL, sawmillToWorld } from '../../src/levels/forestry.ts';
import { BRIDGE, BRIDGE_X, YARD_FORESTRY, YARD_Y, timberYardLevel } from '../../src/levels/timber-yard.ts';
import { GuestSession, HostSession, listGames } from '../../src/net/session.ts';
import { MemoryHub } from '../../src/net/transport.ts';
import { neutralCommand } from '../../src/sim/commands.ts';
import type { PlayerCommand } from '../../src/sim/commands.ts';
import { EYE_HEIGHT, LabSim } from '../../src/sim/lab-sim.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { SAW } from '../../src/sim/sawmill.ts';
import { ANIM_MAX } from '../../src/sim/snapshots.ts';
import { GRID_SIZE, cellIndexX, cellIndexZ } from '../../src/voxels/grid.ts';
import { pose } from '../../src/voxels/math.ts';
import { M, voxelMaterial } from '../../src/voxels/palette.ts';
import { STATE_STRIDE } from '../../src/workers/protocol.ts';
import { VoxelService, trackedEntityOrder } from '../../src/workers/voxel-service.ts';

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

    /** Online: player 1 is a guest on another device, its input going through the sessions. */
    hs: HostSession | null = null;
    gs: GuestSession | null = null;
    guestSim: LabSim | null = null;

    constructor(players: number) {
        this.s = new LabSim({ level: timberYardLevel });
        this.s.step(neutralCommand(0));
        this.s.fpActive = true;
        if (players > 1) this.s.setPlayerCount(players);
        this.yaw = this.s.players.map((p) => p.yaw);
        this.pitch = this.s.players.map(() => 0);
        this.step({}, {}, 30);
    }

    /** A host with one guest joined over an in-memory transport (the guest is player 1). */
    static async online(): Promise<Play> {
        const g = new Play(1);
        const hub = new MemoryHub();
        g.hs = await HostSession.start(hub.transport('host'), g.s, 'yard', 'saw1');
        g.guestSim = new LabSim({ level: timberYardLevel });
        let clock = 0;
        g.clock = () => (clock += 1000 / 60);
        g.gs = await GuestSession.join(
            hub.transport('guest'),
            g.guestSim,
            listGames(hub.channel('lobby', 'w'))[0],
            () => clock
        );
        expect(g.gs.slot).toBe(1);
        g.yaw[1] = g.s.players[1].yaw;
        g.step({}, {}, 30);
        return g;
    }

    private clock: () => number = () => 0;

    /** Steps with player 0's and player 1's commands (each gets its kept look unless given). */
    step(a: Cmd = {}, b: Cmd = {}, k = 1): void {
        for (let i = 0; i < k; i++) {
            const c0 = { ...neutralCommand(this.n), yaw: this.yaw[0], pitch: this.pitch[0], ...a };
            const c1 = { ...neutralCommand(this.n), yaw: this.yaw[1], pitch: this.pitch[1], ...b };
            this.yaw[0] = c0.yaw;
            this.pitch[0] = c0.pitch;
            this.yaw[1] = c1.yaw;
            this.pitch[1] = c1.pitch;
            if (this.gs && this.hs) {
                // the guest's device sends its input; the host steps with what arrived
                this.gs.sendInput(c1);
                this.s.step(c0, this.hs.commandFor(1), [this.hs.commandFor(2), this.hs.commandFor(3)]);
                this.hs.afterStep((slot) => this.s.interactionIds(slot));
                this.clock();
            } else this.s.step(c0, c1);
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
    // square it up along the guide: the beaver at the end that has swung south steps back
    const swing = () => {
        const q = log.pose.q;
        const ax = 1 - 2 * (q.y * q.y + q.z * q.z);
        const az = 2 * (q.x * q.z - q.w * q.y);
        // the east-pointing end's angle from east (positive: swung south)
        return ax < 0 ? Math.atan2(-az, -ax) : Math.atan2(az, ax);
    };
    const squared = () => Math.max(-0.2, Math.min(0.2, swing() * 1.5));
    for (let k = 0; k < 180 && Math.abs(swing()) > 0.03; k++) {
        const c = squared();
        // player 0 holds the west end, player 1 the east end; forward is south
        g.step({ moveZ: keep() + c }, { moveZ: keep() - c });
    }
    // lower it into the guide (lowering the look draws it in: step after it), let go, step
    // out of the blade guard
    const p0 = g.pitch[0];
    const p1 = g.pitch[1];
    for (let k = 1; k <= 60; k++) {
        g.pitch[0] = p0 + ((-0.75 - p0) * k) / 60;
        g.pitch[1] = p1 + ((-0.75 - p1) * k) / 60;
        g.step({ moveZ: keep() }, { moveZ: keep() });
    }
    for (let k = 0; k < 120 && Math.abs(lp.z - GUIDE.z) > 0.06; k++) g.step({ moveZ: keep() }, { moveZ: keep() });
    expect(Math.abs(lp.z - GUIDE.z)).toBeLessThan(0.15);
    g.step({ grab: true }, { grab: true });
    expect(s.physics.holders(log.id)).toBe(0);
    g.step({ moveZ: -0.6 }, { moveZ: -0.6 }, 90);
    return minY - y0;
}

describe('the gate, by player input only', () => {
    it('two beavers fell a tree, carry its log into the sawmill, the sawn planks deck the bridge, a player walks over', () => {
        const g = new Play(2);
        const s = g.s;
        // ---- fell tree 2 (it leans west, towards the mill): both chew from its east side
        const tree = 2;
        const t = YARD_FORESTRY.trees[tree];
        g.walkTo(0, t.x + 1.0, t.z - 0.4);
        g.walkTo(1, t.x + 1.0, t.z + 0.4);
        const chew = (i: number) => g.lookAt(i, t.x + (t.lean?.x ?? 0) * 0.6, YARD_Y + 0.6, t.z);
        const c0 = chew(0);
        const c1 = chew(1);
        for (let k = 0; k < 600 && s.forestry.treeState(tree).phase === 'standing'; k++)
            g.step({ ...c0, grab: k % 30 === 0 }, { ...c1, grab: k % 30 === 0 });
        expect(s.forestry.treeState(tree).phase).toBe('down');
        expect(s.forestry.fallDirection(tree).x).toBeLessThan(-0.95);
        g.step({}, {}, 300);
        const log = s.forestry.logOf(tree)!;
        expect(log.visible).toBe(true);

        const lift = carryIntoGuide(g, log);
        expect(lift).toBeGreaterThan(0.3);
        for (let k = 0; k < 240 && s.sawmill!.phase === 'ready'; k++) g.step();
        expect(s.sawmill!.stats.takenIds).toEqual([log.id]);
        // the stump has not regrown yet (too soon)
        expect(s.forestry.treeState(tree).phase).toBe('down');
        for (let k = 0; k < SAW.cutTicks + 30; k++) g.step();
        expect(s.sawmill!.stats.planks).toBe(3);
        const planks = s.entities.filter((e) => e.name.startsWith('extra-plank-') && e.visible && e.id >= 380);
        expect(planks.length).toBe(3);

        // ---- the bridge: player 0 shoulders the yard's two beams across the creek (by an end)
        for (const [name, x] of [
            ['beam-0', BRIDGE_X - 0.12],
            ['beam-1', BRIDGE_X + 0.12]
        ] as const) {
            const beam = g.entity(name);
            const b = beam.pose.p;
            g.walkTo(0, b.x + 2.4, b.z + 1.0);
            g.walkTo(0, b.x + 2.4, b.z);
            g.turn(0, Math.PI / 2); // facing -x, at the beam's +x end
            expect(g.grabAt(0, b.x + 1.45, b.y, b.z)).toBe(beam.id);
            g.tilt(0, -0.25, 40);
            g.one(0, {}, 30);
            // turn to the creek: the beam turns with you and points out over the gap
            g.turn(0, 0, 120);
            // (the yard bridge test's moves: across to the line, then straight to the bank)
            const p0 = s.players[0];
            // (steering by the beam itself: it is held a little to one side)
            const bx = () => beam.pose.p.x;
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
        expect(s.progress.falls).toBe(0);

        // ---- player 1 carries each sawn plank off the rack, walks out along the beams with it and
        // lays it across them (the far one first, so it never steps over one it has laid)
        const deckZ = [BRIDGE.farFace + 0.6, BRIDGE.zc, BRIDGE.nearFace - 0.6];
        planks.forEach((plank, n) => {
            const p = plank.pose.p;
            // from the rack's north side, facing south, take it by its middle
            g.walkTo(1, p.x, SPOT.z - 1.6);
            g.turn(1, Math.PI);
            expect(g.grabAt(1, p.x, p.y, p.z)).toBe(plank.id);
            g.tilt(1, -0.2, 30);
            // turn round to face the creek (yaw 0 faces north, -z); the plank stays across the view
            g.turn(1, 0, 90);
            g.shuffleTo(1, BRIDGE_X, BRIDGE.nearEdge + 2.0);
            // out along the beams until the plank is over its spot, then set it down
            const p1 = s.players[1];
            for (let k = 0; k < 900 && plank.pose.p.z > deckZ[n] + 0.05; k++) {
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
        });
        const decked = planks.filter((p) => p.pose.p.z < BRIDGE.nearFace && p.pose.p.z > BRIDGE.farFace);
        expect(decked.length).toBe(3);

        // ---- player 0 walks over the bridge, over the planks, to the far bank
        g.walkTo(0, BRIDGE_X, BRIDGE.nearEdge + 1.2);
        g.turn(0, 0);
        let topY = 0;
        for (let k = 0; k < 600 && s.players[0].z > BRIDGE.farEdge - 1; k++) {
            g.one(0, { moveZ: 0.8 });
            if (s.players[0].z < BRIDGE.nearFace && s.players[0].z > BRIDGE.farFace)
                topY = Math.max(topY, s.players[0].y);
        }
        expect(s.progress.falls).toBe(0);
        expect(s.players[0].z).toBeLessThan(BRIDGE.farEdge - 0.5);
        // stepped up onto the planks (plank top is 0.1 above the beams)
        expect(topY).toBeGreaterThan(YARD_Y + 0.25);
        for (const p of planks) expect(p.pose.p.y).toBeGreaterThan(YARD_Y + 0.15);

        // ---- its log was sawn, so the stump has regrown meanwhile (it waits WOOD.regrowTicks)
        expect(s.forestry.treeState(tree).phase).toBe('standing');
        expect(s.forestry.stats.regrown).toBe(1);
    }, 240_000);

    it('solo: pick up the axe, chop a tree down, buck the log, carry a half into the sawmill', () => {
        const g = new Play(1);
        const s = g.s;
        const axe = g.entity('axe');
        const a = axe.pose.p;
        g.walkTo(0, a.x + 1.1, a.z);
        expect(g.grabAt(0, a.x, a.y, a.z)).toBe(axe.id);
        // chop tree 4 from its east side: it falls west, towards the mill
        const tree = 4;
        const t = YARD_FORESTRY.trees[tree];
        g.walkTo(0, t.x + 2.2, t.z + 0.6);
        g.walkTo(0, t.x + 1.1, t.z);
        expect(s.physics.heldIdOf(0)).toBe(axe.id);
        const look = g.lookAt(0, t.x, YARD_Y + 0.6, t.z);
        for (let k = 0; k < 600 && s.forestry.treeState(tree).phase === 'standing'; k++)
            g.one(0, { ...look, grab: k % 30 === 0 });
        expect(s.forestry.treeState(tree).phase).toBe('down');
        expect(s.forestry.stats.blows).toBe(4);
        expect(s.physics.heldIdOf(0)).toBe(axe.id);
        g.step({}, {}, 200);
        const log = s.forestry.logOf(tree)!;
        const lp = log.pose.p;
        expect(lp.x).toBeLessThan(t.x - 0.8);
        // buck it: three blows, aimed at it each time
        g.walkTo(0, lp.x + 0.4, lp.z + 1.1);
        for (let k = 0; k < 150 && s.forestry.stats.bucked === 0; k++)
            g.one(0, { ...g.lookAt(0, lp.x, lp.y, lp.z), grab: k % 30 === 0 });
        expect(s.forestry.stats.bucked).toBe(1);
        // put the axe down (drop), take the west half (nearest the mill) by its east end
        g.one(0, { action: 4 });
        g.one(0, {}, 30);
        const halves = s.entities.filter((e) => e.name.startsWith('short-log') && e.visible);
        expect(halves.length).toBe(2);
        const half = halves.reduce((m, h) => (m.pose.p.x < h.pose.p.x ? m : h));
        const hp = half.pose.p;
        // from its north side, facing it, take it by its middle and lift it
        const side = sideOf(half.pose);
        const far = side.at(0, -2.0);
        g.walkTo(0, far.x, far.z);
        const near = side.at(0, -1.05);
        g.walkTo(0, near.x, near.z);
        g.turn(0, side.faceYaw);
        expect(g.grabAt(0, hp.x, hp.y, hp.z)).toBe(half.id);
        const y0 = hp.y;
        g.tilt(0, -0.1, 20);
        g.one(0, {}, 40);
        expect(hp.y).toBeGreaterThan(y0 + 0.3);
        // forward (south) onto the guide's line, then sideways (west: its right) into the guide
        const keep = () => Math.max(-0.12, Math.min(0.12, (GUIDE.z - hp.z) * 0.6));
        for (let k = 0; k < 900 && hp.z < GUIDE.z - 0.04; k++) g.one(0, { moveZ: 0.35 });
        g.one(0, {}, 40);
        for (let k = 0; k < 900 && hp.x > GUIDE.x + 0.04; k++) g.one(0, { moveX: 0.35, moveZ: keep() });
        for (let k = 0; k < 120 && Math.abs(hp.z - GUIDE.z) > 0.06; k++) g.one(0, { moveZ: keep() });
        expect(Math.abs(hp.x - GUIDE.x)).toBeLessThan(0.5);
        expect(Math.abs(hp.z - GUIDE.z)).toBeLessThan(0.3);
        // lower it in (stepping after it: lowering the look draws it in)
        const p0 = g.pitch[0];
        for (let k = 1; k <= 60; k++) g.one(0, { pitch: p0 + ((-0.75 - p0) * k) / 60, moveZ: keep() });
        g.one(0, { grab: true });
        expect(s.physics.heldIdOf(0)).toBe(-1);
        // step back out of the blade guard
        g.one(0, { moveZ: -0.6 }, 90);
        for (let k = 0; k < 300 && s.sawmill!.phase === 'ready'; k++) g.step();
        expect(s.sawmill!.stats.takenIds).toEqual([half.id]);
        g.step({}, {}, SAW.cutTicks + 30);
        expect(s.sawmill!.stats.planks).toBe(1);
        // a whole log is too heavy for one beaver, a half is not
        expect(s.physics.bodies.get(s.log.id)!.body.mass() * 9.81).toBeGreaterThan(650);
        expect(s.physics.bodies.get(half.id)!.body.mass() * 9.81).toBeLessThan(650);
    }, 120_000);

    it('the same commands from two players give the same world (deterministic, interleaved)', () => {
        const run = () => {
            const g = new Play(2);
            const t = YARD_FORESTRY.trees[3];
            g.walkTo(0, t.x - 1.0, t.z + 0.4);
            g.walkTo(1, t.x - 1.0, t.z - 0.4);
            const a = g.lookAt(0, t.x, YARD_Y + 0.6, t.z);
            const b = g.lookAt(1, t.x, YARD_Y + 0.6, t.z);
            // interleaved bites (player 1 a beat behind), walking in between
            for (let k = 0; k < 600 && g.s.forestry.treeState(3).phase === 'standing'; k++)
                g.step({ ...a, grab: k % 30 === 0 }, { ...b, grab: k % 30 === 15 });
            g.step({ moveX: 0.5 }, { moveX: -0.5 }, 200);
            return g.s.entities.map((e) => [e.visible, e.pose.p.x, e.pose.p.y, e.pose.p.z, e.pose.q.w]);
        };
        expect(run()).toEqual(run());
    }, 60_000);
});

describe('online: a guest logs and saws with the host', () => {
    it('the guest takes the axe, chops a tree, carries its log with the host, the saw runs, then bucks a log; its own voxel world shows the stump', async () => {
        const g = await Play.online();
        const s = g.s;
        const gsim = g.guestSim!;
        // ---- the guest (player 1) picks up the axe and chops tree 2 down from its east side
        const axe = g.entity('axe');
        const a = axe.pose.p;
        g.walkTo(1, a.x + 1.1, a.z);
        expect(g.grabAt(1, a.x, a.y, a.z)).toBe(axe.id);
        const tree = 2;
        const t = YARD_FORESTRY.trees[tree];
        g.walkTo(1, t.x + 2.2, t.z - 0.6);
        g.walkTo(1, t.x + 1.1, t.z);
        expect(s.physics.heldIdOf(1)).toBe(axe.id);
        const chop = g.lookAt(1, t.x + (t.lean?.x ?? 0) * 0.6, YARD_Y + 0.6, t.z);
        for (let k = 0; k < 600 && s.forestry.treeState(tree).phase === 'standing'; k++)
            g.one(1, { ...chop, grab: k % 30 === 0 });
        expect(s.forestry.treeState(tree).phase).toBe('down');
        expect(s.forestry.stats.blows).toBe(4);
        // put the axe down (drop: a guest may)
        g.one(1, { action: 4 });
        expect(s.physics.heldIdOf(1)).toBe(-1);
        g.step({}, {}, 300);
        // the guest's device heard "Timber!" (the host's events travel in its state)
        expect(g.gs!.events.some((e) => e.text.startsWith('Timber!'))).toBe(true);
        const log = s.forestry.logOf(tree)!;

        // ---- host and guest carry it into the sawmill together
        expect(carryIntoGuide(g, log)).toBeGreaterThan(0.3);
        let sawSeen = false;
        let progressSeen = 0;
        const sp = pose();
        const sa = new Float64Array(ANIM_MAX);
        const mill = gsim.forestry.ents.sawmill;
        for (let k = 0; k < SAW.settleTicks + SAW.cutTicks + 120 && s.sawmill!.stats.planks < 3; k++) {
            g.step();
            // what the guest's device sees of the machine (its snapshots)
            if (gsim.ring.sample(mill.slot, gsim.ring.newestTick / 60, sp, sa)) {
                if (Math.round(sa[SAW_STATE]) === SAW_CUTTING) sawSeen = true;
                progressSeen = Math.max(progressSeen, sa[SAW_PROGRESS]);
            }
        }
        expect(s.sawmill!.stats.takenIds).toEqual([log.id]);
        expect(s.sawmill!.stats.planks).toBe(3);
        expect(sawSeen).toBe(true);
        expect(progressSeen).toBeGreaterThan(0.9);
        g.step({}, {}, 12);
        const visible = (name: string) => {
            const e = gsim.entities.find((x) => x.name === name)!;
            return gsim.ring.sample(e.slot, gsim.ring.newestTick / 60, sp, sa);
        };
        expect(['extra-plank-12', 'extra-plank-13', 'extra-plank-14'].every(visible)).toBe(true);

        // ---- the guest's own voxel world, fed from its snapshots: tree 2 is a stump there
        expect(s.forestry.treeState(tree).phase).toBe('down');
        const svc = new VoxelService();
        svc.build(1, 'yard');
        const slots = trackedEntityOrder(gsim);
        const states = new Float64Array(slots.length * STATE_STRIDE);
        slots.forEach((slot, n) => {
            const o = n * STATE_STRIDE;
            const vis = gsim.ring.sample(slot, gsim.ring.newestTick / 60, sp, sa);
            states.set([vis ? 1 : 0, sp.p.x, sp.p.y, sp.p.z, sp.q.x, sp.q.y, sp.q.z, sp.q.w], o);
            for (let c = 0; c < ANIM_MAX; c++) states[o + 8 + c] = sa[c];
        });
        svc.frame(1, gsim.ring.newestTick / 60, 'coverage50', false, states);
        const gy = YARD_FORESTRY.ground(t.x, t.z);
        const at = (y: number) =>
            voxelMaterial(svc.world.staticAt(cellIndexX(t.x), Math.floor(y / GRID_SIZE), cellIndexZ(t.z)));
        expect(at(gy + 0.7)).toBe(0);
        expect([M.LogBark, M.LogEnd]).toContain(at(gy + 0.2));
        // and a tree still standing is still there
        const t1 = YARD_FORESTRY.trees[1];
        expect(
            voxelMaterial(
                svc.world.staticAt(
                    cellIndexX(t1.x),
                    Math.floor((YARD_FORESTRY.ground(t1.x, t1.z) + 0.7) / GRID_SIZE),
                    cellIndexZ(t1.z)
                )
            )
        ).toBe(M.Bark);
        // ---- the guest takes the axe again and bucks a log on the pile
        const a2 = axe.pose.p;
        g.walkTo(1, a2.x + 1.1, a2.z + 0.3);
        expect(g.grabAt(1, a2.x, a2.y, a2.z)).toBe(axe.id);
        const pile = s.log.pose.p;
        g.walkTo(1, pile.x - 1.1, pile.z + 0.5);
        for (let k = 0; k < 200 && s.forestry.stats.bucked === 0; k++)
            g.one(1, { ...g.lookAt(1, pile.x, pile.y, pile.z), grab: k % 30 === 0 });
        expect(s.forestry.stats.bucked).toBe(1);
        g.step({}, {}, 12);
        expect(visible('short-log-0') && visible('short-log-1')).toBe(true);

        g.gs!.leave();
        g.hs!.stop();
    }, 240_000);
});
