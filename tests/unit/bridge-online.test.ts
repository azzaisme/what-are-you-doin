/**
 * Epic 5's gate online (#53): the joint graph reaches every client. With 1 to 4 clients (the host
 * and 0 to 3 guests), guests build the yard bridge by input (aim, F) and a guest drives the loaded
 * ute over it; a guest joins late; and on an underbuilt bridge the breaks reach every client.
 *
 * Every update a guest receives, its nail marks and their strain must equal the host's exactly as
 * the wire carries them: nail heads in millimetres in their piece's frame (int16, the codec's
 * quantisation), entity indices and strain levels (0-2) exact. That is checked against the host's
 * own marks put through the same encode and decode, so the only difference allowed is the codec's.
 *
 * Placed by setup, as said where: the beams laid on the seats before nailing, where each beaver
 * stands to nail, the ute on the bank and its load, and where the driver stands at its door.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';

import { BEAM_HALF } from '../../src/assets/props.ts';
import { BRIDGE, BRIDGE_X, YARD_Y, timberYardLevel } from '../../src/levels/timber-yard.ts';
import { GuestSession, HostSession, listGames } from '../../src/net/session.ts';
import { MemoryHub } from '../../src/net/transport.ts';
import { ACTION_NAIL, neutralCommand } from '../../src/sim/commands.ts';
import type { PlayerCommand } from '../../src/sim/commands.ts';
import { decodeNails, encodeNails, nailMarks } from '../../src/sim/joints/wire.ts';
import type { NailMark } from '../../src/sim/joints/wire.ts';
import { EYE_HEIGHT, LabSim, MAX_PLAYERS } from '../../src/sim/lab-sim.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { pose, quatFromYawPitchRoll, quatRotate } from '../../src/voxels/math.ts';

import { FLAT_ALONG_Z, LINES, hammerAt } from './bridge-helpers.ts';

beforeAll(() => initPhysics());

const yawOf = (q: { x: number; y: number; z: number; w: number }) =>
    Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));

/** The host and its guests (slots 1-3), stepped together; every update checked. */
class Online {
    readonly hub = new MemoryHub();
    readonly s = new LabSim({ level: timberYardLevel });
    hs!: HostSession;
    readonly guests: GuestSession[] = [];
    /** Each client's command this tick (0: the host's own beaver), by slot. */
    readonly cmd: Partial<PlayerCommand>[] = Array.from({ length: MAX_PLAYERS }, () => ({}));
    /** Updates compared, per guest (and in all). */
    compared = 0;
    private readonly seen = new Map<GuestSession, number>();

    async start(): Promise<this> {
        this.s.step(neutralCommand(0));
        this.s.fpActive = true;
        this.hs = await HostSession.start(this.hub.transport('host'), this.s, 'yard', 'gate');
        return this;
    }

    async join(): Promise<GuestSession> {
        const ad = listGames(this.hub.channel('lobby', `watcher-${this.guests.length}`))[0];
        const g = await GuestSession.join(
            this.hub.transport(`guest-${this.guests.length}`),
            new LabSim({ level: timberYardLevel }),
            ad
        );
        this.guests.push(g);
        this.seen.set(g, g.received);
        return g;
    }

    /** One tick: guests send their commands, the host steps and publishes, every new update is checked. */
    tick(): void {
        const n = this.s.tick + 1;
        const full = (slot: number): PlayerCommand => ({ ...neutralCommand(n), ...this.cmd[slot] });
        for (const g of this.guests) g.sendInput(full(g.slot));
        const c: (PlayerCommand | undefined)[] = [];
        for (let slot = 1; slot < MAX_PLAYERS; slot++) c[slot] = this.hs.commandFor(slot);
        this.s.step(full(0), c[1], c.slice(2));
        // edge-triggered requests are one tick long
        for (const x of this.cmd) {
            delete x.grab;
            delete x.action;
        }
        this.hs.afterStep((slot) => this.s.interactionIds(slot));
        this.check();
    }

    run(k: number, each?: () => void): void {
        for (let i = 0; i < k; i++) {
            each?.();
            this.tick();
        }
    }

    /** What every guest must show: the host's marks as the wire carries them. */
    expected(): NailMark[] {
        const s = this.s;
        const index = new Map(s.entities.map((e, i) => [e.id, i]));
        const marks = nailMarks(
            s.joints.graph,
            (id) => index.get(id) ?? -1,
            (c) => s.joints.strainLevel(c)
        );
        const wire = decodeNails(encodeNails(marks), s.entities.length)!;
        wire.forEach((m, i) => (m.strain = marks[i].strain));
        return wire;
    }

    /** Each guest that has a new update since the last tick: its marks against the host's. */
    private check(): void {
        let want: NailMark[] | null = null;
        for (const g of this.guests) {
            if (g.received === this.seen.get(g)) continue;
            this.seen.set(g, g.received);
            want ??= this.expected();
            expect(g.nails, `guest in slot ${g.slot}, host tick ${this.s.tick}`).toEqual(want);
            this.compared++;
        }
    }

    /** Player `slot` looks from its eye at `at` (yaw, pitch). */
    look(slot: number, at: { x: number; y: number; z: number }) {
        const p = this.s.players[slot];
        const dx = at.x - p.x;
        const dz = at.z - p.z;
        return {
            yaw: Math.atan2(-dx, -dz),
            pitch: -Math.atan2(p.y + EYE_HEIGHT - at.y, Math.hypot(dx, dz))
        };
    }
}

/**
 * Where a beaver stands to nail a spot: on the abutment beside the beam, on its inner side (towards
 * the bridge's centre line), level with the spot. The hammer drives only within 35 degrees of
 * straight down from the eye: from the bank, a spot half a metre out over the abutment glances off.
 */
const BESIDE = 0.35;

/**
 * The proper bridge's nail spots: two per beam end, side by side across the beam's top (on its line
 * and 8 cm inside it: nails want 8 cm between them), 22 cm in from the seat's face, where the beam bears on its seat.
 */
function nailSpots(s: LabSim): { x: number; y: number; z: number; near: boolean }[] {
    const beams = ['beam-0', 'beam-1'].map((name) => s.entities.find((e) => e.name === name)!);
    const out: { x: number; y: number; z: number; near: boolean }[] = [];
    for (let i = 0; i < 2; i++)
        for (const near of [true, false])
            for (const dx of [0, 0.08]) {
                const z = near ? BRIDGE.nearFace + 0.22 : BRIDGE.farFace - 0.22;
                // (towards the bridge's centre line: a beam laid by hand bears on its seat along its
                // inner half; on its outer edge the hammer finds a gap)
                const inner = LINES[i] < BRIDGE_X ? 1 : -1;
                out.push({ x: LINES[i] + inner * dx, y: beams[i].pose.p.y + BEAM_HALF.y, z, near });
            }
    return out;
}

/**
 * Player `slot` drives a nail at `spot` by input: put beside the spot on its bank (setup: stood
 * 10 cm aside, at the bank's edge), turns to look at it, presses F.
 */
function nailBy(o: Online, slot: number, spot: { x: number; y: number; z: number; near: boolean }): void {
    const s = o.s;
    const side = spot.x < BRIDGE_X ? 1 : -1;
    const px = spot.x + side * BESIDE;
    s.placePlayer(px, spot.z, spot.near ? 0 : Math.PI, slot);
    // (placePlayer casts from just above the terrain, here the creek bed, below the abutment:
    // stood on the abutment's top by hand)
    const p = s.players[slot];
    p.y = (s.physics.groundY(px, spot.z, YARD_Y + 2) ?? p.y) + 0.05;
    s.physics.placeCharacter(p.x, p.y, p.z, slot);
    o.run(20);
    const { yaw, pitch } = o.look(slot, spot);
    o.cmd[slot] = { yaw, pitch };
    o.run(6);
    o.cmd[slot] = { yaw, pitch, action: ACTION_NAIL };
    o.run(1);
    o.cmd[slot] = { yaw, pitch };
    o.run(6);
    // and off the bridge again, out of the next builder's way (setup: back on the yard)
    o.cmd[slot] = {};
    s.placePlayer(BRIDGE_X + 2 + slot, BRIDGE.nearEdge + 3, 0, slot);
    o.run(6);
}

/** Setup: both yard beams laid on the wheel lines across the creek, settled (not yet nailed). */
function layBeams(o: Online): void {
    const s = o.s;
    const beams = ['beam-0', 'beam-1'].map((name) => s.entities.find((e) => e.name === name)!);
    beams.forEach((b, i) => s.physics.place(b.id, pose(LINES[i], YARD_Y + 0.3, BRIDGE.zc, FLAT_ALONG_Z)));
    o.run(60);
}

/**
 * Setup: the ute on the bank 6 m from the bridge facing it, a log's worth (two halves of a bucked
 * log) in its bed.
 */
function loadedUte(o: Online): void {
    const s = o.s;
    const v = s.vehicle!;
    s.physics.place(v.id, pose(BRIDGE_X, YARD_Y + 0.25, BRIDGE.nearEdge + 6, quatFromYawPitchRoll(Math.PI, 0, 0)));
    o.run(60);
    const u = s.ute.pose;
    const local = { x: 0, y: 0, z: 0 };
    [-0.3, 0.3].forEach((x, n) => {
        const e = s.forestry.ents.short[n];
        s.physics.setEnabled(e.id, true);
        quatRotate(u.q, x, 1.2, -1.0, local);
        s.physics.place(
            e.id,
            pose(
                u.p.x + local.x,
                u.p.y + local.y,
                u.p.z + local.z,
                quatFromYawPitchRoll(yawOf(u.q) + Math.PI / 2, 0, 0)
            )
        );
    });
    o.run(60);
}

/**
 * Player `slot` gets in by input (stood 2.2 m off the driver's door: setup; looks at it, grabs) and
 * drives the ute over the bridge, steering for its centre line. Returns whether it got across.
 */
function driveBy(o: Online, slot: number, every: () => void = () => undefined): boolean {
    const s = o.s;
    const u = s.ute.pose;
    const uy = yawOf(u.q);
    const sideX = -Math.cos(uy);
    const sideZ = Math.sin(uy);
    s.placePlayer(u.p.x + sideX * 2.2, u.p.z + sideZ * 2.2, 0, slot);
    o.run(20);
    const yaw = Math.atan2(sideX, sideZ);
    const pitch = -Math.atan2(s.players[slot].y + EYE_HEIGHT - (u.p.y + 0.6), 2.2 - 0.8);
    o.cmd[slot] = { yaw, pitch };
    o.run(5);
    o.cmd[slot] = { yaw, pitch, grab: true };
    o.run(1);
    o.cmd[slot] = { yaw, pitch };
    o.run(10);
    expect(s.driver).toBe(slot);
    const target = BRIDGE.farEdge - 2.5;
    for (let k = 0; k < 60 * 20 && s.ute.pose.p.z > target; k++) {
        let dy = yawOf(s.ute.pose.q) - Math.PI;
        dy -= Math.round(dy / (2 * Math.PI)) * 2 * Math.PI;
        const steer = Math.max(-1, Math.min(1, 4 * (BRIDGE_X - s.ute.pose.p.x) + 3 * dy));
        o.cmd[slot] = { yaw: Math.PI, pitch: 0, moveZ: 0.4, moveX: steer };
        o.tick();
        every();
    }
    o.cmd[slot] = {};
    return s.ute.pose.p.z <= target;
}

describe('the gate online: 1 to 4 clients (#53)', () => {
    for (const clients of [1, 2, 3, 4])
        it(`${clients} client${clients > 1 ? 's' : ''}: ${clients > 1 ? 'guests build the bridge by input, a guest drives the loaded ute over it' : 'the host builds the bridge and drives the loaded ute over it'}${clients > 2 ? ', a guest joins late' : ''}; every update matches the host`, async () => {
            const o = await new Online().start();
            // the guests: all but the last at the start; with 3 or more clients, the last joins late
            const early = clients > 2 ? clients - 2 : clients - 1;
            for (let k = 0; k < early; k++) await o.join();
            for (const g of o.guests) expect(g.slot).toBeGreaterThan(0);
            // the host's own beaver out of the way, on the yard
            o.s.placePlayer(BRIDGE_X + 4, BRIDGE.nearEdge + 4, 0, 0);
            layBeams(o);
            // the eight nails, taken in turn by the guests (or the host, alone)
            const builders = o.guests.length ? o.guests.map((g) => g.slot) : [0];
            const spots = nailSpots(o.s);
            spots.forEach((spot, k) => nailBy(o, builders[k % builders.length], spot));
            const nails = [...o.s.joints.graph.connections()].reduce((n, c) => n + c.nails.length, 0);
            expect(o.s.joints.graph.size).toBe(4);
            expect(nails).toBe(8);
            // a guest joins late: it gets the whole graph with its first update
            let late: GuestSession | null = null;
            if (clients > 2) {
                late = await o.join();
                o.run(6);
                expect(late.received).toBeGreaterThan(0);
                expect(late.nails.length).toBe(8);
            }
            loadedUte(o);
            const driver = o.guests.length ? o.guests[0].slot : 0;
            const across = driveBy(o, driver);
            o.run(30);
            console.log(
                `${clients} client(s): ${nails} nails driven by ${builders.length > 1 || builders[0] ? `guests in slots ${builders.join(', ')}` : 'the host'}; ${late ? `a guest joined late (slot ${late.slot}); ` : ''}the loaded ute driven by ${driver ? `the guest in slot ${driver}` : 'the host'}: ${across ? 'across' : 'NOT across'}; ${o.compared} updates compared, every one equal`
            );
            expect(across).toBe(true);
            expect(o.s.joints.graph.size).toBe(4);
            if (clients > 1) expect(o.compared).toBeGreaterThan(100 * o.guests.length);
            o.hs.stop();
        }, 300_000);

    for (const clients of [1, 2, 3, 4])
        it(`${clients} client${clients > 1 ? 's' : ''}: the underbuilt bridge gives way under the loaded ute${clients > 1 ? ' (a guest driving)' : ''}; every client sees the strain and loses the nails in the same update as the host`, async () => {
            const o = await new Online().start();
            for (let k = 0; k < clients - 1; k++) await o.join();
            o.s.placePlayer(BRIDGE_X + 4, BRIDGE.nearEdge + 4, 0, 0);
            layShort(o);
            const nails = [...o.s.joints.graph.connections()].reduce((n, c) => n + c.nails.length, 0);
            expect(nails).toBe(8);
            loadedUte(o);
            // the strain each guest was shown, at its highest, and the host's breaks
            let shown = 0;
            const e0 = o.s.events.length;
            const driver = o.guests.length ? o.guests[0].slot : 0;
            const across = driveBy(o, driver, () => {
                for (const g of o.guests) for (const m of g.nails) shown = Math.max(shown, m.strain);
            });
            o.run(60);
            const breaks = o.s.events.slice(e0).filter((e) => e.kind === 'break').length;
            const left = [...o.s.joints.graph.connections()].reduce((n, c) => n + c.nails.length, 0);
            console.log(
                `${clients} client(s), underbuilt: ${breaks} breaks, ${left} of ${nails} nails left; the ute ${across ? 'ACROSS' : 'not across'}; guests shown strain up to ${shown}; ${o.compared} updates compared, every one equal`
            );
            expect(breaks).toBeGreaterThanOrEqual(1);
            expect(left).toBeLessThan(nails);
            expect(across).toBe(false);
            for (const g of o.guests) expect(g.nails.length).toBe(left);
            if (clients > 1) {
                // the guests saw it creak (the strain a joint is under, from the host) before it went
                expect(shown).toBeGreaterThanOrEqual(1);
                expect(o.compared).toBeGreaterThan(50 * o.guests.length);
            }
            o.hs.stop();
        }, 300_000);
});

/**
 * Setup (as breaking.test's shortBridge): both beams run out from the bank over the creek, short of
 * the far seat, propped while the host's hammer drives four nails each into the bank's lip, then
 * let go.
 */
function layShort(o: Online): void {
    const s = o.s;
    const beams = ['beam-0', 'beam-1'].map((name) => s.entities.find((e) => e.name === name)!);
    const back = BRIDGE.nearEdge + 1.1;
    const zc = back - BEAM_HALF.x;
    beams.forEach((b, i) => s.physics.place(b.id, pose(LINES[i], YARD_Y + BEAM_HALF.y + 0.03, zc, FLAT_ALONG_Z)));
    const props = LINES.map((x) =>
        s.physics.addStatic(
            RAPIER.ColliderDesc.cuboid(0.15, 0.5, 0.15).setTranslation(x, YARD_Y - 0.5, back - 2 * BEAM_HALF.x + 0.2)
        )
    );
    o.run(60);
    for (let i = 0; i < 2; i++)
        for (let k = 0; k < 4; k++)
            hammerAt(
                s.joints,
                {
                    x: LINES[i] + (k % 2 ? 0.05 : -0.05),
                    y: beams[i].pose.p.y + 0.12,
                    z: BRIDGE.nearEdge - 0.12 + 0.06 * (k >> 1)
                },
                s.tick
            );
    for (const c of props) s.physics.world.removeCollider(c, true);
}
