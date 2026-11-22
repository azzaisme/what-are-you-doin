import { beforeAll, describe, expect, it } from 'vitest';

import {
    BRIDGE,
    BRIDGE_X,
    BUCKET_STUMP,
    CREEK_WATER_Y,
    FLOOD_PEAK_Y,
    YARD_GOAL,
    YARD_Y,
    creekCenterZ,
    creekHalfWidth,
    timberYardLevel
} from '../../src/levels/timber-yard.ts';
import { GuestSession, HostSession, listGames } from '../../src/net/session.ts';
import { MemoryHub } from '../../src/net/transport.ts';
import { neutralCommand } from '../../src/sim/commands.ts';
import type { PlayerCommand } from '../../src/sim/commands.ts';
import { HAZARD, PHASE, gustExposure, packHazardNet, readHazardNet } from '../../src/sim/hazards.ts';
import { EYE_HEIGHT, LabSim } from '../../src/sim/lab-sim.ts';
import { applyFlood, shapeSamples, shapeVolume } from '../../src/sim/physics/water.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { pose, quatFromYawPitchRoll, quatMul } from '../../src/voxels/math.ts';

beforeAll(() => initPhysics());

const yard = () => new LabSim({ level: timberYardLevel });
const byName = (s: LabSim, n: string) => s.entities.find((e) => e.name === n)!;
const cmd = (n: number, c: Partial<PlayerCommand> = {}): PlayerCommand => ({ ...neutralCommand(n), ...c });
const flood = HAZARD.flood;
const S = (s: number) => Math.round(s * 60);
/** Ticks from the trigger to the water being back to normal. */
const FLOOD_TICKS = S(
    flood.holdToTrigger + flood.delayS + flood.delayJitterS + flood.tellS + flood.riseS + flood.holdS + flood.fallS
);
/** Ticks from a finished bridge to the siren, at the longest (seeded) delay. */
const TO_SIREN = S(flood.holdToTrigger + flood.delayS + flood.delayJitterS) + 5;
const hazardTexts = (s: LabSim) => s.events.filter((e) => e.kind === 'hazard').map((e) => e.text);
/** Steps (no input) until `done`, at most `max` ticks; returns the ticks taken. */
function runUntil(s: LabSim, done: () => boolean, max: number): number {
    let n = 0;
    while (n < max && !done()) {
        s.runTo(s.tick + 1);
        n++;
    }
    return n;
}

/** Both beams flat across the gap, side by side, long axis along Z. */
function bridgeBeams(s: LabSim): void {
    const flatAlongZ = quatMul(quatFromYawPitchRoll(Math.PI / 2, 0, 0), quatFromYawPitchRoll(0, Math.PI / 2, 0));
    ['beam-0', 'beam-1'].forEach((n, i) =>
        s.physics.place(byName(s, n).id, pose(BRIDGE_X - 0.105 + i * 0.21, YARD_Y + 0.12, BRIDGE.zc, flatAlongZ))
    );
}

/** A beam still lies across the crossing, on both abutments. */
function across(s: LabSim, name: string): boolean {
    const b = byName(s, name).pose.p;
    return Math.abs(b.x - BRIDGE_X) < BRIDGE.halfWidth && Math.abs(b.z - BRIDGE.zc) < 0.4 && b.y > YARD_Y;
}

describe('hazard director: the rising river (#72)', () => {
    it('the floodwater floats timber: sample points fill the shape, and a sunk beam is pushed up harder than it weighs', () => {
        const beam = { type: 'box' as const, hx: 1.6, hy: 0.1, hz: 0.075 };
        const smp = shapeSamples(beam);
        expect(smp.pts.length / 3).toBeGreaterThanOrEqual(9);
        expect((smp.vol * smp.pts.length) / 3).toBeCloseTo(shapeVolume(beam), 6);
        for (let i = 0; i < smp.pts.length; i += 3) expect(Math.abs(smp.pts[i])).toBeLessThan(1.6);
        // a real beam held under the flood: one tick of the water lifts it by more than gravity pulls
        const s = yard();
        const b = s.physics.bodies.get(byName(s, 'beam-0').id)!.body;
        s.physics.place(byName(s, 'beam-0').id, pose(BRIDGE_X, -0.6, BRIDGE.zc));
        const dt = 1 / 60;
        const area = timberYardLevel.water;
        applyFlood(s.physics, area, { y: 0.3, vx: 0, vz: 0, strength: 1 }, timberYardLevel.terrainHeight, dt);
        const lift = b.linvel().y / dt; // m/s^2 the water gave it
        expect(lift).toBeGreaterThan(9.81);
        // ~ (water density / beam density) * g: 1000 / 380 * 9.81 = 25.8 m/s^2
        expect(lift).toBeGreaterThan(20);
        expect(lift).toBeLessThan(30);
        // the bucket is hollow (70 kg/m^3 overall) and floats too: so a bucket in the flood counts as
        // lost (it would drift away) and comes back at its start
        const bk = s.physics.bodies.get(s.bucket.id)!.body;
        s.physics.place(s.bucket.id, pose(BRIDGE_X + 3, -0.8, BRIDGE.zc));
        applyFlood(s.physics, area, { y: 0.3, vx: 0, vz: 0, strength: 1 }, timberYardLevel.terrainHeight, dt);
        expect(bk.linvel().y / dt).toBeGreaterThan(9.81);
    });

    it('finishing the bridge sets off the flood: siren, rise to the peak, timber washed off and left downstream', () => {
        const s = yard();
        s.runTo(S(HAZARD.graceS) + 10);
        expect(hazardTexts(s)).toHaveLength(0);
        bridgeBeams(s);
        runUntil(s, () => s.hazards.floodPhase === PHASE.tell, TO_SIREN);
        expect(s.hazards.floodPhase).toBe(PHASE.tell);
        expect(hazardTexts(s)[0]).toContain('siren');
        // the gauge marks go under during the tell, then the water surges to the peak
        s.runTo(s.tick + S(flood.tellS) - 10);
        expect(s.hazards.waterY).toBeGreaterThan(CREEK_WATER_Y + 0.05);
        s.runTo(s.tick + S(flood.riseS) + 20);
        expect(s.hazards.floodPhase).toBe(PHASE.active);
        expect(s.hazards.waterY).toBeCloseTo(FLOOD_PEAK_Y, 2);
        s.runTo(s.tick + S(flood.holdS) - 30);
        // nobody weighed it down: both beams floated off the abutments
        expect(across(s, 'beam-0')).toBe(false);
        expect(across(s, 'beam-1')).toBe(false);
        s.runTo(s.tick + S(flood.fallS) + 60);
        expect(s.hazards.floodPhase).toBe(PHASE.idle);
        expect(s.hazards.waterY).toBeCloseTo(CREEK_WATER_Y, 6);
        // the water left them on the near bank downstream: the run is not lost
        expect(hazardTexts(s).some((t) => t.includes('left'))).toBe(true);
        s.runTo(s.tick + 120);
        for (const n of ['beam-0', 'beam-1']) {
            const p = byName(s, n).pose.p;
            expect(p.x).toBeGreaterThan(BRIDGE_X + 4);
            expect(p.z - creekCenterZ(p.x)).toBeGreaterThan(creekHalfWidth(p.x));
            expect(p.y).toBeGreaterThan(YARD_Y - 0.1);
        }
    }, 60_000);

    it('counterplay: a player standing on each beam weighs the bridge down and it stays', () => {
        const s = yard();
        s.runTo(S(HAZARD.graceS) + 10);
        bridgeBeams(s);
        s.runTo(s.tick + 30);
        s.fpActive = true;
        s.setSlotActive(1, true);
        // one on each beam, either side of mid-span (the weight goes into what is under your feet)
        for (const [i, dx, dz] of [
            [0, -0.105, 0.5],
            [1, 0.105, -0.5]
        ] as const) {
            s.placePlayer(BRIDGE_X + dx, BRIDGE.zc + dz, 0, i);
            s.physics.placeCharacter(BRIDGE_X + dx, YARD_Y + 0.45, BRIDGE.zc + dz, i);
        }
        let n = 0;
        for (let i = 0; i < FLOOD_TICKS - 30; i++) s.step(cmd(n++), cmd(n));
        expect(hazardTexts(s)[0]).toContain('siren');
        expect(s.hazards.floodCount).toBe(1);
        expect(across(s, 'beam-0')).toBe(true);
        expect(across(s, 'beam-1')).toBe(true);
        expect(s.progress.falls).toBe(0);
    }, 60_000);

    it('counterplay: holding the beams keeps them on the abutments', () => {
        const s = yard();
        s.runTo(S(HAZARD.graceS) + 10);
        bridgeBeams(s);
        runUntil(s, () => s.hazards.floodPhase === PHASE.tell, TO_SIREN);
        expect(s.hazards.floodPhase).toBe(PHASE.tell);
        s.fpActive = true;
        s.setSlotActive(1, true);
        // at the siren, two players on the near bank each take a beam by its near end
        for (const [i, name] of [
            [0, 'beam-0'],
            [1, 'beam-1']
        ] as const) {
            const b = byName(s, name).pose.p;
            s.placePlayer(b.x, BRIDGE.nearEdge + 0.9, 0, i);
            s.physics.grabById(byName(s, name).id, { x: b.x, y: b.y, z: BRIDGE.nearFace - 0.3 }, 1.6, i);
        }
        let n = 0;
        // looking down at the beam end, so the hold point stays where the beam lies
        const look = (i: number) =>
            -Math.atan2(s.players[i].y + EYE_HEIGHT - (YARD_Y + 0.15), s.players[i].z - (BRIDGE.nearFace - 0.3));
        for (let i = 0; i < FLOOD_TICKS; i++) s.step(cmd(n++, { pitch: look(0) }), cmd(n, { pitch: look(1) }));
        expect(s.hazards.floodCount).toBe(1);
        // nothing left on the bank downstream: the flood took nothing
        expect(s.hazards.floodMoved).toBe(0);
        for (const name of ['beam-0', 'beam-1']) {
            const b = byName(s, name).pose.p;
            expect(Math.abs(b.x - BRIDGE_X)).toBeLessThan(BRIDGE.halfWidth);
            expect(b.y).toBeGreaterThan(CREEK_WATER_Y + 0.3);
        }
    }, 60_000);

    it('the budget: no flood in the first seconds, and none once the bucket is across', () => {
        const s = yard();
        bridgeBeams(s);
        s.runTo(S(HAZARD.graceS) - 30);
        expect(s.hazards.floodCount).toBe(0);
        // the bucket already over: the bridge being finished no longer matters
        const t = yard();
        t.runTo(S(HAZARD.graceS) + 10);
        t.physics.place(t.bucket.id, pose(BRIDGE_X, 0.7, -7));
        bridgeBeams(t);
        t.runTo(t.tick + 600);
        expect(t.hazards.floodCount).toBe(0);
    }, 60_000);

    it('the budget: a second flood only after the cooldown, and never a third', () => {
        const s = yard();
        s.runTo(S(HAZARD.graceS) + 10);
        const sirens: number[] = [];
        const ends: number[] = [];
        let prev = PHASE.idle as number;
        // keep rebuilding the bridge whenever it is gone, for six minutes
        for (let i = 0; i < S(360); i++) {
            if (s.hazards.floodPhase === PHASE.idle && !across(s, 'beam-0') && !across(s, 'beam-1')) bridgeBeams(s);
            s.runTo(s.tick + 1);
            const ph = s.hazards.floodPhase;
            if (ph === PHASE.tell && prev === PHASE.idle) sirens.push(s.tick);
            if (ph === PHASE.idle && prev !== PHASE.idle) ends.push(s.tick);
            prev = ph;
        }
        expect(sirens).toHaveLength(flood.max);
        expect(s.hazards.floodCount).toBe(2);
        expect(sirens[1] - ends[0]).toBeGreaterThanOrEqual(S(flood.cooldownS));
    }, 120_000);
});

describe('hazard director: the gust aimed at the carried plank (#73)', () => {
    /** Player 1 by the creek holding a plank in front of them, looking at the creek (-z). */
    function carrying(s: LabSim, slot = 0): number {
        const plank = byName(s, 'plank');
        const x = 4 + slot * 0.6;
        const z = creekCenterZ(4) + creekHalfWidth(4) + 2.2;
        s.placePlayer(x, z, 0, slot);
        const y = s.players[slot].y + EYE_HEIGHT - 0.45;
        s.physics.place(plank.id, pose(4.3, y, z - 1.1, quatFromYawPitchRoll(0, Math.PI / 2, 0)));
        s.physics.grabById(plank.id, { x: 4.3, y, z: z - 1.1 }, 1.2, slot);
        return plank.id;
    }

    function run(s: LabSim, ticks: number, c: Partial<PlayerCommand> = {}, c2?: Partial<PlayerCommand>) {
        for (let i = 0; i < ticks; i++) s.step(cmd(s.tick, c), c2 ? cmd(s.tick, c2) : undefined);
    }

    const G = HAZARD.gust;
    /** Carrying until the gust's warning (the seeded carry time is at most this). */
    const TO_GUST = S(G.carryS + G.carryJitterS) + 5;
    function untilGust(s: LabSim, c: Partial<PlayerCommand> = {}, c2?: Partial<PlayerCommand>): void {
        for (let i = 0; i < TO_GUST && s.hazards.gustPhase !== PHASE.tell; i++) run(s, 1, c, c2);
    }

    it('carried at chest height near the water: a warning, then a gust tears it away towards the creek', () => {
        const s = yard();
        s.runTo(S(HAZARD.graceS) + 10);
        s.fpActive = true;
        s.runTo(s.tick + 2);
        const id = carrying(s);
        untilGust(s);
        expect(s.hazards.gustPhase).toBe(PHASE.tell);
        expect(hazardTexts(s)[0]).toContain('gust');
        expect(s.physics.heldIdOf(0)).toBe(id);
        // the windsock swings round to the gust during the warning
        run(s, S(G.tellS));
        expect(s.hazards.gustPhase).toBe(PHASE.active);
        const before = byName(s, 'plank').pose.p.z;
        run(s, S(G.blowS) + 30);
        expect(s.physics.heldIdOf(0)).toBe(-1);
        // into the creek, close to the bank (not flung over it)
        const p = byName(s, 'plank').pose.p;
        expect(p.z).toBeLessThan(before - 1);
        expect(Math.abs(p.z - creekCenterZ(p.x))).toBeLessThan(creekHalfWidth(p.x));
        expect(p.y).toBeLessThan(CREEK_WATER_Y);
        expect(s.hazards.lastGustForce).toBeGreaterThan(650);
        expect(hazardTexts(s).some((t) => t.includes('tore'))).toBe(true);
    }, 60_000);

    it('counterplay: lowered to the knees, the gust only tugs; one grip holds it', () => {
        const s = yard();
        s.runTo(S(HAZARD.graceS) + 10);
        s.fpActive = true;
        s.runTo(s.tick + 2);
        const id = carrying(s);
        untilGust(s, { pitch: -0.2 });
        expect(s.hazards.gustPhase).toBe(PHASE.tell);
        // the warning: look down and the plank comes down with your hands
        run(s, S(G.tellS) + S(G.blowS) + 30, { pitch: -1.05 });
        expect(s.hazards.gustCount).toBe(1);
        expect(s.physics.heldIdOf(0)).toBe(id);
        expect(s.hazards.lastGustForce).toBeLessThan(650);
        expect(gustExposure(1.4)).toBe(1);
        expect(gustExposure(0.5)).toBeLessThan(0.4);
    }, 60_000);

    it('counterplay: carried together, two grips hold it', () => {
        const s = yard();
        s.runTo(S(HAZARD.graceS) + 10);
        s.fpActive = true;
        s.setSlotActive(1, true);
        s.runTo(s.tick + 2);
        const id = carrying(s, 0);
        // the second player takes the other end
        const t = s.physics.bodies.get(id)!.body.translation();
        s.placePlayer(5.3, s.players[0].z, 0, 1);
        s.physics.grabById(id, { x: t.x + 0.8, y: t.y, z: t.z }, 1.2, 1);
        expect(s.physics.holders(id)).toBe(2);
        untilGust(s, {}, {});
        run(s, S(G.tellS) + S(G.blowS) + 40, {}, {});
        expect(s.hazards.gustCount).toBe(1);
        expect(s.physics.holders(id)).toBe(2);
        expect(s.hazards.lastGustForce).toBeGreaterThan(650);
    }, 60_000);

    it('counterplay: put down, it is left alone', () => {
        const s = yard();
        s.runTo(S(HAZARD.graceS) + 10);
        s.fpActive = true;
        s.runTo(s.tick + 2);
        carrying(s);
        untilGust(s);
        expect(s.hazards.gustPhase).toBe(PHASE.tell);
        s.physics.release(0);
        run(s, 90);
        const rest = { ...byName(s, 'plank').pose.p };
        run(s, S(G.tellS) + S(G.blowS));
        const now = byName(s, 'plank').pose.p;
        expect(Math.hypot(now.x - rest.x, now.z - rest.z)).toBeLessThan(0.05);
    }, 60_000);

    it('the budget: at most three gusts, each after its cooldown', () => {
        const s = yard();
        s.runTo(S(HAZARD.graceS) + 10);
        s.fpActive = true;
        s.runTo(s.tick + 2);
        const tells: number[] = [];
        let prev = PHASE.idle as number;
        for (let i = 0; i < S(240); i++) {
            // whenever the plank is not in hand (torn away), pick it up again by the creek
            if (s.hazards.gustPhase === PHASE.idle && s.physics.heldIdOf(0) < 0) carrying(s);
            run(s, 1);
            const ph = s.hazards.gustPhase;
            if (ph === PHASE.tell && prev === PHASE.idle) tells.push(s.tick);
            prev = ph;
        }
        expect(tells).toHaveLength(G.max);
        for (let k = 1; k < tells.length; k++) expect(tells[k] - tells[k - 1]).toBeGreaterThanOrEqual(S(G.cooldownS));
    }, 120_000);

    it('the budget: no gust while fewer than three planks are out of the creek', () => {
        const s = yard();
        s.runTo(S(HAZARD.graceS) + 10);
        s.fpActive = true;
        // four of the five other planks are already lost in the creek: two planks left
        ['extra-plank-0', 'extra-plank-1', 'extra-plank-2', 'extra-plank-3'].forEach((n, k) =>
            s.physics.place(byName(s, n).id, pose(-8 + k * 3, CREEK_WATER_Y - 0.4, creekCenterZ(-8 + k * 3)))
        );
        s.runTo(s.tick + 60);
        carrying(s);
        run(s, TO_GUST + S(5));
        expect(s.hazards.gustCount).toBe(0);
    }, 60_000);

    it('the budget: a quiet spell after a hazard, and nothing at all after the goal', () => {
        // a flood ends; carrying a plank by the creek straight after brings no gust for 15 s
        const s = yard();
        s.runTo(S(HAZARD.graceS) + 10);
        bridgeBeams(s);
        runUntil(s, () => s.hazards.floodPhase === PHASE.tell, TO_SIREN);
        runUntil(s, () => s.hazards.floodPhase === PHASE.idle, FLOOD_TICKS);
        const ended = s.tick;
        s.fpActive = true;
        s.runTo(s.tick + 2);
        carrying(s);
        for (let i = 0; i < S(30) && s.hazards.gustPhase === PHASE.idle; i++) run(s, 1);
        expect(s.hazards.gustPhase).toBe(PHASE.tell);
        // (counted from the flood's last tick)
        expect(s.tick - ended).toBeGreaterThanOrEqual(S(HAZARD.safeS) - 1);
        // the bucket delivered: neither a finished bridge nor a carried plank brings anything
        const g = yard();
        g.physics.place(g.bucket.id, pose(BRIDGE_X, 0.9, -7.3));
        g.runTo(S(HAZARD.graceS) + 10);
        expect(g.progress.goalReached).toBe(true);
        bridgeBeams(g);
        g.fpActive = true;
        g.runTo(g.tick + 2);
        carrying(g);
        run(g, S(30));
        expect(g.hazards.floodCount + g.hazards.gustCount).toBe(0);
    }, 120_000);

    it('no gust in the yard, away from the water', () => {
        const s = yard();
        s.runTo(S(HAZARD.graceS) + 10);
        s.fpActive = true;
        s.runTo(s.tick + 2);
        const plank = byName(s, 'plank');
        s.placePlayer(-4.6, 8, 0, 0);
        s.physics.grabById(plank.id, plank.pose.p, 1.2, 0);
        run(s, 600);
        expect(s.hazards.gustCount).toBe(0);
    }, 60_000);
});

describe('hazard director: determinism and the network', () => {
    /** A seeded run: the bridge finished, then a plank carried by the creek until a gust. */
    function seeded(seed: number) {
        const s = new LabSim({ level: timberYardLevel, hazardSeed: seed });
        s.runTo(S(HAZARD.graceS) + 10);
        bridgeBeams(s);
        runUntil(s, () => s.hazards.floodPhase === PHASE.tell, TO_SIREN);
        const siren = s.tick;
        runUntil(s, () => s.hazards.floodPhase === PHASE.idle, FLOOD_TICKS);
        s.fpActive = true;
        s.runTo(s.tick + 2);
        const plank = byName(s, 'plank');
        const z = creekCenterZ(4) + creekHalfWidth(4) + 2.2;
        s.placePlayer(4, z, 0, 0);
        const y = s.players[0].y + EYE_HEIGHT - 0.45;
        s.physics.place(plank.id, pose(4.3, y, z - 1.1, quatFromYawPitchRoll(0, Math.PI / 2, 0)));
        s.physics.grabById(plank.id, { x: 4.3, y, z: z - 1.1 }, 1.2, 0);
        const carryFrom = s.tick;
        runUntil(s, () => s.hazards.gustPhase === PHASE.tell, S(30));
        return {
            siren,
            gustAfter: s.tick - carryFrom,
            gustDir: Math.round(Math.atan2(s.hazards.gustDirZ, s.hazards.gustDirX) * 1000) / 1000,
            ev: hazardTexts(s).join('|'),
            beam: { ...byName(s, 'beam-0').pose.p }
        };
    }

    it('the same seed and commands give the same hazards (a flood and a gust) and the same world', () => {
        const a = seeded(11);
        expect(a.gustAfter).toBeGreaterThan(0);
        expect(seeded(11)).toEqual(a);
    }, 120_000);

    it('another seed gives other hazards: the siren’s delay, the gust’s timing and its direction change', () => {
        const runs = [3, 11, 29, 42].map(seeded);
        const keys = new Set(runs.map((r) => `${r.siren}/${r.gustAfter}/${r.gustDir}`));
        expect(keys.size).toBe(runs.length);
        expect(new Set(runs.map((r) => r.gustDir)).size).toBeGreaterThan(1);
        expect(new Set(runs.map((r) => r.siren)).size).toBeGreaterThan(1);
    }, 120_000);

    it('guests read the host’s hazard state, bounded', () => {
        const h = { waterY: 0.412, flood: 2, gust: 1, gustDir: -1.57, gustSlot: 1 };
        expect(readHazardNet(packHazardNet(h), CREEK_WATER_Y)).toEqual(h);
        const junk = readHazardNet(['x', 99, -4, null, 'y'], CREEK_WATER_Y);
        expect(junk.flood).toBe(3);
        expect(junk.gust).toBe(0);
        expect(junk.waterY).toBe(CREEK_WATER_Y);
        expect(readHazardNet([1e9], 0).waterY).toBe(3);
    });
});

describe('hazard director: online, through real host and guest sessions', () => {
    async function online(seed: number) {
        const hub = new MemoryHub();
        const host = new LabSim({ level: timberYardLevel, hazardSeed: seed });
        host.runTo(S(HAZARD.graceS) + 10);
        host.fpActive = true;
        const hs = await HostSession.start(hub.transport('host'), host, 'yard', 'hzrd');
        const ad = listGames(hub.channel('lobby', 'watcher'))[0];
        let clock = 0;
        const guestSim = new LabSim({ level: timberYardLevel });
        const gs = await GuestSession.join(hub.transport('guest'), guestSim, ad, () => clock);
        const run = (ticks: number, c: Partial<PlayerCommand> = {}) => {
            for (let i = 0; i < ticks; i++) {
                gs.sendInput(cmd(host.tick));
                host.step(cmd(host.tick, c), hs.commandFor(1), [hs.commandFor(2), hs.commandFor(3)]);
                hs.afterStep((slot) => host.interactionIds(slot));
                clock += 1000 / 60;
            }
        };
        return { host, hs, gs, guestSim, run };
    }

    it('the host’s flood reaches the guest: seed, siren toast, phases and the water height', async () => {
        const { host, hs, gs, guestSim, run } = await online(77);
        run(6);
        expect(gs.hazardSeed).toBe(77);
        bridgeBeams(host);
        for (let i = 0; i < S(20) && gs.hazard.flood !== PHASE.tell; i++) run(1);
        expect(gs.hazard.flood).toBe(PHASE.tell);
        expect(gs.events.some((e) => e.kind === 'hazard' && e.text.includes('siren'))).toBe(true);
        for (let i = 0; i < S(30) && gs.hazard.waterY < FLOOD_PEAK_Y - 0.01; i++) run(1);
        // snapshots go out every third tick: the guest's water is the host's at most that old
        run(3);
        expect(gs.hazard.flood).toBe(PHASE.active);
        expect(Math.abs(gs.hazard.waterY - host.hazards.waterY)).toBeLessThan(0.002);
        // the guest runs no director of its own: everything it shows comes from the host
        expect(guestSim.hazards.floodCount).toBe(0);
        gs.leave();
        hs.stop();
    }, 60_000);

    it('the host’s gust reaches the guest: phase, target, and the windsock swinging round in the snapshots', async () => {
        const { host, hs, gs, guestSim, run } = await online(5);
        run(6);
        // player 1 (the host) carries a plank by the creek
        const plank = byName(host, 'plank');
        const z = creekCenterZ(4) + creekHalfWidth(4) + 2.2;
        host.placePlayer(4, z, 0, 0);
        const y = host.players[0].y + EYE_HEIGHT - 0.45;
        host.physics.place(plank.id, pose(4.3, y, z - 1.1, quatFromYawPitchRoll(0, Math.PI / 2, 0)));
        host.physics.grabById(plank.id, { x: 4.3, y, z: z - 1.1 }, 1.2, 0);
        for (let i = 0; i < S(5) && gs.hazard.gust !== PHASE.tell; i++) run(1);
        expect(gs.hazard.gust).toBe(PHASE.tell);
        expect(gs.hazard.gustSlot).toBe(0);
        expect(Math.abs(gs.hazard.gustDir - Math.atan2(host.hazards.gustDirZ, host.hazards.gustDirX))).toBeLessThan(
            0.01
        );
        // well into the warning, on a snapshot tick: the guest's windsock (from the host's snapshot)
        // points where the host's does, downwind into the gust
        run(60);
        while (host.tick % 3 !== 0) run(1);
        const ws = guestSim.windsock;
        const out = pose();
        expect(guestSim.ring.sample(ws.slot, host.tick / 60, out, new Float64Array(6))).toBe(true);
        const yawOf = (q: { x: number; y: number; z: number; w: number }) =>
            Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
        expect(Math.abs(yawOf(out.q) - yawOf(host.windsock.pose.q))).toBeLessThan(0.02);
        // the sock's +X points downwind: along the gust (a rotation of -a about Y)
        const d = yawOf(host.windsock.pose.q) + gs.hazard.gustDir;
        expect(Math.abs(Math.atan2(Math.sin(d), Math.cos(d)))).toBeLessThan(0.3);
        expect(guestSim.hazards.gustPhase).toBe(PHASE.idle);
        gs.leave();
        hs.stop();
    }, 60_000);
});

describe('hazard director: the level stays winnable', () => {
    it('after the flood washes the bridge away: fetch both beams from downstream, rebuild, carry the bucket over (player inputs only)', () => {
        const s = yard();
        s.runTo(S(HAZARD.graceS) + 10);
        bridgeBeams(s);
        runUntil(s, () => s.hazards.floodPhase === PHASE.tell, TO_SIREN);
        runUntil(s, () => s.hazards.floodPhase === PHASE.idle, FLOOD_TICKS);
        expect(s.hazards.floodMoved).toBe(2);
        s.runTo(s.tick + 60);
        s.fpActive = true;
        let yaw = 0;
        let pitch = 0;
        const step = (c: Partial<PlayerCommand> = {}, k = 1) => {
            for (let i = 0; i < k; i++) s.step(cmd(s.tick, { yaw, pitch, ...c }));
        };
        const ease = (to: number, k: number, set: (v: number) => void, from: number) => {
            for (let i = 1; i <= k; i++) {
                set(from + ((to - from) * i) / k);
                step();
            }
        };
        /** Walks (full stick, no sprint) facing the way it goes. */
        const walkTo = (x: number, z: number) => {
            for (let i = 0; i < 1800; i++) {
                const dx = x - s.player.x;
                const dz = z - s.player.z;
                if (Math.hypot(dx, dz) < 0.25) break;
                yaw = Math.atan2(-dx, -dz);
                step({ moveZ: Math.min(1, Math.hypot(dx, dz) * 2 + 0.2) });
            }
        };
        s.placePlayer(1.2, 6.2, 0);
        step({}, 10);
        for (const [name, x] of [
            ['beam-0', BRIDGE_X - 0.12],
            ['beam-1', BRIDGE_X + 0.12]
        ] as const) {
            const beam = byName(s, name);
            const b = { ...beam.pose.p };
            // walk round the stump to 2.4 m off the beam's +x end, face it (-x) and shoulder it by that end
            walkTo(3, 3);
            walkTo(b.x + 2.4, b.z);
            yaw = Math.PI / 2;
            // line up with the beam: a little sideways step (facing -x, right is -z)
            for (let i = 0; i < 120 && Math.abs(s.player.z - beam.pose.p.z) > 0.02; i++)
                step({ moveX: Math.max(-0.4, Math.min(0.4, (s.player.z - beam.pose.p.z) * 4)) });
            step({}, 20);
            pitch = -Math.atan2(s.player.y + EYE_HEIGHT - beam.pose.p.y, s.player.x - (beam.pose.p.x + 1.45));
            step({}, 5);
            step({ grab: true });
            expect(s.physics.heldId).toBe(beam.id);
            ease(-0.25, 40, (v) => (pitch = v), pitch);
            // carry it back along the bank, nose first (forward is -x)
            for (let i = 0; i < 1800 && s.player.x > x + 0.03; i++)
                step({ moveZ: Math.min(1, (s.player.x - x) * 2 + 0.1), moveX: (s.player.z - 2.5) * 0.8 });
            step({}, 20);
            // turn to the creek: the beam swings out over the gap
            ease(0, 120, (v) => (yaw = v), yaw);
            for (let i = 0; i < 900 && s.player.z > BRIDGE.nearEdge + 0.4; i++) step({ moveZ: 0.5 });
            step({}, 30);
            ease(-0.7, 40, (v) => (pitch = v), pitch);
            step({}, 30);
            step({ grab: true });
            step({}, 120);
            expect(s.physics.heldId).toBe(-1);
            expect(across(s, name)).toBe(true);
        }
        // the bucket from its stump, over the rebuilt bridge at a walk
        const bucket = byName(s, 'bucket');
        walkTo(BUCKET_STUMP.x, BUCKET_STUMP.z + 1);
        yaw = 0;
        step({}, 10);
        pitch = -Math.atan2(s.player.y + EYE_HEIGHT - bucket.pose.p.y, s.player.z - bucket.pose.p.z);
        step({}, 3);
        step({ grab: true });
        expect(s.physics.heldId).toBe(bucket.id);
        pitch = 0;
        for (let i = 0; i < 900 && Math.abs(s.player.x - BRIDGE_X) > 0.05; i++)
            step({ moveX: (s.player.x > BRIDGE_X ? -1 : 1) * Math.min(1, Math.abs(s.player.x - BRIDGE_X) * 2 + 0.1) });
        for (let i = 0; i < 900 && s.player.z > (YARD_GOAL.minZ + YARD_GOAL.maxZ) / 2; i++) step({ moveZ: 1 });
        step({ grab: true });
        // set down by the flag: it counts once it has come to rest there
        for (let i = 0; i < 300 && !s.progress.goalReached; i++) step();
        expect(s.progress.falls).toBe(0);
        expect(s.progress.goalReached).toBe(true);
    }, 120_000);
});
