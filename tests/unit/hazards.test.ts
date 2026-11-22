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
    roadCenterX,
    timberYardLevel,
    yardHeight
} from '../../src/levels/timber-yard.ts';
import { GuestSession, HostSession, listGames } from '../../src/net/session.ts';
import { MemoryHub } from '../../src/net/transport.ts';
import { neutralCommand } from '../../src/sim/commands.ts';
import type { PlayerCommand } from '../../src/sim/commands.ts';
import { HAZARD, PHASE, gustExposure, packHazardNet, readHazardNet } from '../../src/sim/hazards.ts';
import { EYE_HEIGHT, LabSim } from '../../src/sim/lab-sim.ts';
import { applyFlood, shapeSamples, shapeVolume } from '../../src/sim/physics/water.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import {
    composePose,
    pose,
    quatFromAxisAngle,
    quatFromYawPitchRoll,
    quatIdentity,
    quatMul
} from '../../src/voxels/math.ts';

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
            s.step(cmd(0), cmd(0));
            // held where it is taken (the bank's ramp puts you higher: a fixed reach would lift it)
            const grip = { x: b.x, y: b.y, z: BRIDGE.nearFace - 0.3 };
            const p = s.players[i];
            const reach = Math.hypot(grip.x - p.x, grip.y - (p.y + EYE_HEIGHT), grip.z - p.z);
            s.physics.grabById(byName(s, name).id, grip, reach, i);
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
        // all but two planks are already lost in the creek (with the deck planks stacked by the
        // bridge, extra-plank-5 to 11): two planks left
        [0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 11]
            .map((k) => `extra-plank-${k}`)
            .forEach((n, k) =>
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

    it('one hazard at a time: a plank carried by the creek all through a flood brings no gust, and a finished bridge waits out a gust', () => {
        const both = (s: LabSim) => s.hazards.floodPhase !== PHASE.idle && s.hazards.gustPhase !== PHASE.idle;
        // the flood first: carry a plank by the water from the siren to the end of the flood
        const s = yard();
        s.runTo(S(HAZARD.graceS) + 10);
        bridgeBeams(s);
        runUntil(s, () => s.hazards.floodPhase === PHASE.tell, TO_SIREN);
        s.fpActive = true;
        carrying(s);
        let carried = 0;
        for (let i = 0; i < FLOOD_TICKS && s.hazards.floodPhase !== PHASE.idle; i++) {
            run(s, 1);
            expect(both(s)).toBe(false);
            if (s.physics.heldIdOf(0) >= 0) carried++;
        }
        expect(s.hazards.floodPhase).toBe(PHASE.idle);
        expect(carried).toBeGreaterThan(S(G.carryS + G.carryJitterS)); // long enough to bring a gust
        expect(s.hazards.gustCount).toBe(0);
        // the gust first: the bridge finished during its warning sets nothing off until it is over
        const g = yard();
        g.runTo(S(HAZARD.graceS) + 10);
        g.fpActive = true;
        g.runTo(g.tick + 2);
        carrying(g);
        untilGust(g);
        expect(g.hazards.gustPhase).toBe(PHASE.tell);
        bridgeBeams(g);
        let gustOver = -1;
        for (let i = 0; i < S(G.tellS + G.blowS + HAZARD.safeS + 20) && g.hazards.floodPhase === PHASE.idle; i++) {
            run(g, 1);
            expect(both(g)).toBe(false);
            if (gustOver < 0 && g.hazards.gustPhase === PHASE.idle) gustOver = g.tick;
        }
        expect(g.hazards.floodPhase).toBe(PHASE.tell);
        expect(gustOver).toBeGreaterThan(0);
        // the siren comes only after the quiet spell that follows the gust
        expect(g.tick - gustOver).toBeGreaterThanOrEqual(S(HAZARD.safeS) - 1);
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

describe('hazard director: the handbrake prank (#75)', () => {
    const H = HAZARD.handbrake;
    /** The ute set on the far bank's road where it climbs (about 10 degrees), nose downhill (+z). */
    function parkOnRoad(s: LabSim, z = -13.5): void {
        const x = roadCenterX(z);
        s.physics.place(s.vehicle!.id, pose(x, yardHeight(x, z) + 0.3, z, quatFromYawPitchRoll(0, 0, 0)));
    }
    const settle = () => S(HAZARD.graceS) - 60;
    /** Lays a prop in the ute's own frame (x left, y up from the ground under it, z forward). */
    function placeByUte(s: LabSim, name: string, lx: number, ly: number, lz: number, q = quatIdentity()): void {
        const at = composePose(s.ute.pose, pose(lx, ly, lz, q), pose());
        s.physics.place(byName(s, name).id, at);
    }
    /** Player inputs (look, move, grab, brake) against a running clock. */
    function driver(s: LabSim) {
        const v = { yaw: 0, pitch: 0 };
        const step = (c: Partial<PlayerCommand> = {}, k = 1) => {
            for (let i = 0; i < k; i++) s.step(cmd(s.tick, { yaw: v.yaw, pitch: v.pitch, ...c }));
        };
        /** Stands at the driver's door (the ute's right, local -x) looking at it. */
        const toDoor = () => {
            const u = s.ute.pose;
            const q = u.q;
            const uy = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
            const sideX = -Math.cos(uy);
            const sideZ = Math.sin(uy);
            s.placePlayer(u.p.x + sideX * 2.2, u.p.z + sideZ * 2.2, 0);
            step({}, 20);
            v.yaw = Math.atan2(sideX, sideZ);
            v.pitch = -Math.atan2(s.player.y + EYE_HEIGHT - (s.ute.pose.p.y + 0.6), 2.2 - 0.8);
            step({}, 5);
        };
        return { v, step, toDoor };
    }
    const upY = (s: LabSim) => 1 - 2 * (s.ute.pose.q.x ** 2 + s.ute.pose.q.z ** 2);
    const busy = (s: LabSim) =>
        [s.hazards.floodPhase, s.hazards.gustPhase, s.hazards.brakePhase].filter((p) => p !== PHASE.idle).length;
    /** A plank carried at chest height by the creek (as the gust tests do). */
    function carryByCreek(s: LabSim): void {
        const plank = byName(s, 'plank');
        const z = creekCenterZ(4) + creekHalfWidth(4) + 2.2;
        s.placePlayer(4, z, 0, 0);
        const y = s.players[0].y + EYE_HEIGHT - 0.45;
        s.physics.place(plank.id, pose(4.3, y, z - 1.1, quatFromYawPitchRoll(0, Math.PI / 2, 0)));
        s.physics.grabById(plank.id, { x: 4.3, y, z: z - 1.1 }, 1.2, 0);
    }

    it('driven onto the slope and parked: a ratchet warning, then the handbrake lets go and it rolls downhill', () => {
        const s = yard();
        // the ute set at the gentle foot of the far bank's road, facing up it (-z)
        const zFoot = -9;
        const x = roadCenterX(zFoot);
        s.physics.place(s.vehicle!.id, pose(x, yardHeight(x, zFoot) + 0.3, zFoot, quatFromYawPitchRoll(Math.PI, 0, 0)));
        s.runTo(90);
        s.fpActive = true;
        const d = driver(s);
        // get in (look at the door, grab), drive slowly up onto the slope, brake to a stop, get out
        d.toDoor();
        d.step({ grab: true });
        expect(s.driver).toBe(0);
        for (let i = 0; i < 900 && s.ute.pose.p.z > -13.5; i++) d.step({ moveZ: 0.5 });
        expect(s.ute.pose.p.z).toBeLessThanOrEqual(-13.5);
        for (let i = 0; i < 300 && Math.abs(s.vehicle!.speed()) > 0.03; i++) d.step({ jump: true });
        d.step({ jump: true }, 30);
        d.step({ grab: true });
        expect(s.driver).toBe(-1);
        // parked on the slope (steeper than the prank's 3.5 degrees), with the handbrake on
        expect(upY(s)).toBeLessThan(Math.cos(timberYardLevel.hazards!.handbrake!.slope));
        const parkedAt = s.tick;
        const z0 = s.ute.pose.p.z;
        for (let i = 0; i < S(HAZARD.graceS + H.parkedS + 5) && s.hazards.brakePhase === PHASE.idle; i++) d.step();
        expect(s.hazards.brakePhase).toBe(PHASE.tell);
        // not before it stood parked for its time (and the quiet start was over)
        expect(s.tick - parkedAt).toBeGreaterThanOrEqual(S(H.parkedS));
        expect(s.tick).toBeGreaterThanOrEqual(S(HAZARD.graceS));
        expect(hazardTexts(s)[0]).toContain('handbrake');
        // the handbrake held it until now
        expect(Math.abs(s.ute.pose.p.z - z0)).toBeLessThan(0.02);
        d.step({}, S(H.tellS) + S(3));
        expect(s.hazards.handbrakeOff).toBe(true);
        // rolled several metres down the road towards the creek (+z)
        expect(s.ute.pose.p.z - z0).toBeGreaterThan(3);
        // after a while it catches again by itself
        d.step({}, S(H.offS));
        expect(s.hazards.brakePhase).toBe(PHASE.idle);
        expect(hazardTexts(s).some((t) => t.includes('caught'))).toBe(true);
    }, 120_000);

    it('parked with its handbrake on, on the prank slope, it holds: under 2 cm in 30 s', () => {
        // no prank for this one: the director off, so only the brake holds it
        const s = new LabSim({ level: timberYardLevel, hazards: false });
        parkOnRoad(s);
        s.runTo(120);
        expect(upY(s)).toBeLessThan(Math.cos(timberYardLevel.hazards!.handbrake!.slope));
        const p0 = { ...s.ute.pose.p };
        s.runTo(s.tick + S(30));
        const p1 = s.ute.pose.p;
        expect(Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z)).toBeLessThan(0.02);
    }, 60_000);

    it('two beavers pushing a parked, braked ute on flat ground move it, and it holds again once they stop', () => {
        const s = new LabSim({ level: timberYardLevel, hazards: false });
        s.runTo(90);
        s.fpActive = true;
        s.setSlotActive(1, true);
        const u = s.ute.pose;
        // side by side behind its tailgate, facing it (forward is (-sin yaw, -cos yaw))
        const spots = [-0.4, 0.4].map((lx) => composePose(u, pose(lx, 0, -1.84 - 1.2), pose()).p);
        spots.forEach((p, i) => s.placePlayer(p.x, p.z, 0, i));
        const yaws = spots.map((p) => Math.atan2(-(u.p.x - p.x), -(u.p.z - p.z)));
        const both = (moveZ: number, k: number) => {
            for (let i = 0; i < k; i++)
                s.step(cmd(s.tick, { yaw: yaws[0], moveZ }), cmd(s.tick, { yaw: yaws[1], moveZ }));
        };
        both(0, 30);
        expect(s.vehicle!.parkLocked).toBe(true);
        const p0 = { ...s.ute.pose.p };
        both(1, 180);
        expect(Math.hypot(s.ute.pose.p.x - p0.x, s.ute.pose.p.z - p0.z)).toBeGreaterThan(1);
        // they step back and stand: it holds again, locked
        both(-1, 60);
        both(0, 60);
        const p1 = { ...s.ute.pose.p };
        both(0, S(5));
        expect(s.vehicle!.parkLocked).toBe(true);
        expect(Math.hypot(s.ute.pose.p.x - p1.x, s.ute.pose.p.z - p1.z)).toBeLessThan(0.02);
    }, 60_000);

    it('a slow, steady push still moves a parked ute (the parking lock lets go; the brake resists)', () => {
        const s = new LabSim({ level: timberYardLevel, hazards: false });
        s.runTo(120);
        expect(s.vehicle!.parkLocked).toBe(true);
        const b = s.vehicle!.pb.body;
        const p0 = { ...s.ute.pose.p };
        // 3.5 m/s^2 (about 2.7 kN): a lock that swallowed every push under 0.1 m/s a tick held it still
        for (let i = 0; i < 120; i++) {
            b.applyImpulse({ x: (b.mass() * 3.5) / 60, y: 0, z: 0 }, true);
            s.step(cmd(s.tick));
        }
        expect(Math.hypot(s.ute.pose.p.x - p0.x, s.ute.pose.p.z - p0.z)).toBeGreaterThan(0.02);
    }, 60_000);

    it('counterplay: parked on the flat yard, nothing happens', () => {
        const s = yard();
        s.runTo(S(HAZARD.graceS + H.parkedS + 20));
        expect(s.hazards.brakeCount).toBe(0);
    }, 60_000);

    it('counterplay: get in at the warning (look at the door, grab), and the driver’s brake holds it', () => {
        const s = yard();
        parkOnRoad(s);
        s.runTo(settle());
        s.fpActive = true;
        const d = driver(s);
        d.toDoor();
        for (let i = 0; i < S(30) && s.hazards.brakePhase === PHASE.idle; i++) d.step();
        expect(s.hazards.brakePhase).toBe(PHASE.tell);
        const z0 = s.ute.pose.p.z;
        d.step({ grab: true });
        expect(s.driver).toBe(0);
        d.step({ jump: true }, S(H.tellS + 4));
        expect(s.hazards.brakePhase).toBe(PHASE.idle);
        expect(s.hazards.handbrakeOff).toBe(false);
        expect(Math.abs(s.ute.pose.p.z - z0)).toBeLessThan(0.5);
        expect(hazardTexts(s).some((t) => t.includes('back on'))).toBe(true);
    }, 60_000);

    /**
     * Parked on the slope with `chock` set against the downhill (front) wheels: how far it goes in the
     * 5 s after the handbrake lets go. Held: under 5 cm; free: it rolls more than 3 m.
     */
    function chocked(chock: (s: LabSim) => void): { moved: number; held: boolean; texts: string[] } {
        const s = yard();
        parkOnRoad(s);
        s.runTo(settle() - 60);
        chock(s);
        s.runTo(settle());
        const z0 = s.ute.pose.p.z;
        runUntil(s, () => s.hazards.brakePhase === PHASE.active, S(30));
        expect(s.hazards.brakePhase).toBe(PHASE.active);
        s.runTo(s.tick + S(5));
        return { moved: s.ute.pose.p.z - z0, held: s.hazards.chocked, texts: hazardTexts(s) };
    }
    // the front tyres' downhill faces are 1.49 m ahead of the ute's centre (wheelbase 1.15 + 0.34)
    const TYRE = 1.15 + 0.34;

    it('counterplay: a cube against a downhill front wheel chocks it; the handbrake lets go, the ute stays', () => {
        // 0.52 m: too tall to fit under the bumper (0.45 m up, 0.35 m past the tyre), it stands at it
        const r = chocked((s) => placeByUte(s, 'cube', 0.68, 0.28, 1.84 + 0.28));
        expect(r.held).toBe(true);
        expect(Math.abs(r.moved)).toBeLessThan(0.05);
        expect(r.texts.some((t) => t.includes('chock holds'))).toBe(true);
    }, 60_000);

    it('counterplay: a beam on edge across the front tyres chocks it', () => {
        // 0.2 m tall (on edge), 0.15 m deep, across both front wheels, just ahead of the tyres
        const r = chocked((s) => placeByUte(s, 'beam-0', 0, 0.12, TYRE + 0.1));
        expect(r.held).toBe(true);
        expect(Math.abs(r.moved)).toBeLessThan(0.05);
    }, 60_000);

    it('a chock pulled out during the prank: the ute rolls away', () => {
        const s = yard();
        parkOnRoad(s);
        s.runTo(settle() - 60);
        placeByUte(s, 'cube', 0.68, 0.28, 1.84 + 0.28);
        runUntil(s, () => s.hazards.brakePhase === PHASE.active, S(30));
        s.runTo(s.tick + S(1));
        expect(s.hazards.chocked).toBe(true);
        const z0 = s.ute.pose.p.z;
        // someone takes the cube away
        s.physics.place(byName(s, 'cube').id, pose(-8.4, YARD_Y + 0.26, 7.6));
        s.runTo(s.tick + S(4));
        expect(s.hazards.chocked).toBe(false);
        expect(s.hazards.handbrakeOff).toBe(true);
        expect(s.ute.pose.p.z - z0).toBeGreaterThan(3);
    }, 60_000);

    it('a plank lying flat is no chock: the wheels roll over it', () => {
        // 0.1 m tall: a step a wheel climbs
        const flat = quatFromAxisAngle(1, 0, 0, Math.PI / 2);
        const r = chocked((s) => placeByUte(s, 'plank', 0, 0.07, TYRE + 0.12, flat));
        expect(r.held).toBe(false);
        expect(r.moved).toBeGreaterThan(3);
    }, 60_000);

    it('the budget: at most two pranks, the second at least 60 s after the first ends', () => {
        const s = yard();
        parkOnRoad(s);
        s.runTo(settle());
        s.fpActive = true;
        const d = driver(s);
        const ends: number[] = [];
        const starts: number[] = [];
        for (let k = 0; k < 2; k++) {
            for (let i = 0; i < S(H.cooldownS + 30) && s.hazards.brakePhase === PHASE.idle; i++) d.step();
            expect(s.hazards.brakePhase).toBe(PHASE.tell);
            starts.push(s.tick);
            // get in at the warning, hold the brake, get out again: it stays parked on the slope
            d.toDoor();
            d.step({ grab: true });
            expect(s.driver).toBe(0);
            ends.push(s.tick);
            d.step({ jump: true }, 60);
            d.step({ grab: true });
            expect(s.driver).toBe(-1);
        }
        expect(starts[1] - ends[0]).toBeGreaterThanOrEqual(S(H.cooldownS));
        expect(s.hazards.brakeCount).toBe(2);
        // parked on the slope for another three minutes: no third
        d.step({}, S(180));
        expect(s.hazards.brakeCount).toBe(2);
        expect(s.hazards.brakePhase).toBe(PHASE.idle);
    }, 180_000);

    it('one hazard at a time: no flood or gust during a prank, and no prank during a flood or a gust', () => {
        // the prank first: the bridge is finished and a plank carried by the creek during it
        const a = yard();
        parkOnRoad(a);
        runUntil(a, () => a.hazards.brakePhase === PHASE.tell, S(HAZARD.graceS + H.parkedS + 5));
        expect(a.hazards.brakePhase).toBe(PHASE.tell);
        bridgeBeams(a);
        a.fpActive = true;
        carryByCreek(a);
        let prankOver = -1;
        const next = () => a.hazards.gustPhase !== PHASE.idle || a.hazards.floodPhase !== PHASE.idle;
        for (let i = 0; i < S(H.tellS + H.offS + HAZARD.safeS + 30) && !next(); i++) {
            a.step(cmd(a.tick));
            expect(busy(a)).toBeLessThanOrEqual(1);
            if (a.hazards.brakePhase !== PHASE.idle) {
                expect(a.hazards.floodPhase).toBe(PHASE.idle);
                expect(a.hazards.gustPhase).toBe(PHASE.idle);
            } else if (prankOver < 0) prankOver = a.tick;
        }
        // the next hazard (the finished bridge's flood, or the carried plank's gust) only after the
        // prank and its quiet spell
        expect(prankOver).toBeGreaterThan(0);
        expect(next()).toBe(true);
        expect(a.tick - prankOver).toBeGreaterThanOrEqual(S(HAZARD.safeS) - 1);

        // a flood first: the ute parked on the slope at the siren waits for the flood and its quiet
        const b = yard();
        b.runTo(S(HAZARD.graceS) + 10);
        bridgeBeams(b);
        runUntil(b, () => b.hazards.floodPhase === PHASE.tell, TO_SIREN);
        parkOnRoad(b);
        let floodOver = -1;
        for (
            let i = 0;
            i < FLOOD_TICKS + S(HAZARD.safeS + H.parkedS + 10) && b.hazards.brakePhase === PHASE.idle;
            i++
        ) {
            b.step(cmd(b.tick));
            expect(busy(b)).toBeLessThanOrEqual(1);
            if (floodOver < 0 && b.hazards.floodPhase === PHASE.idle) floodOver = b.tick;
        }
        expect(b.hazards.brakePhase).toBe(PHASE.tell);
        expect(b.tick - floodOver).toBeGreaterThanOrEqual(S(HAZARD.safeS) - 1);

        // a gust first: parked during the gust's warning, the prank waits for it and its quiet
        const c = yard();
        c.runTo(S(HAZARD.graceS) + 10);
        c.fpActive = true;
        c.runTo(c.tick + 2);
        carryByCreek(c);
        runUntil(c, () => c.hazards.gustPhase === PHASE.tell, S(5));
        expect(c.hazards.gustPhase).toBe(PHASE.tell);
        parkOnRoad(c);
        let gustOver = -1;
        for (let i = 0; i < S(HAZARD.safeS + H.parkedS + 20) && c.hazards.brakePhase === PHASE.idle; i++) {
            c.step(cmd(c.tick));
            expect(busy(c)).toBeLessThanOrEqual(1);
            if (gustOver < 0 && c.hazards.gustPhase === PHASE.idle) gustOver = c.tick;
        }
        expect(c.hazards.brakePhase).toBe(PHASE.tell);
        expect(c.tick - gustOver).toBeGreaterThanOrEqual(S(HAZARD.safeS) - 1);
    }, 240_000);
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
        const h = { waterY: 0.412, flood: 2, gust: 1, gustDir: -1.57, gustSlot: 1, brake: 2 };
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
        const gs = await GuestSession.join(hub.transport('guest'), guestSim, ad, { now: () => clock });
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
        const { host, hs, gs, run } = await online(77);
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
        gs.leave();
        hs.stop();
    }, 60_000);

    it('the handbrake prank reaches the guest: the toast, the brake phase, and the ute rolling in the snapshots', async () => {
        const { host, hs, gs, guestSim, run } = await online(9);
        const z = -13.5;
        const x = roadCenterX(z);
        host.physics.place(host.vehicle!.id, pose(x, yardHeight(x, z) + 0.3, z, quatFromYawPitchRoll(0, 0, 0)));
        for (let i = 0; i < S(HAZARD.handbrake.parkedS + 5) && gs.hazard.brake !== PHASE.tell; i++) run(1);
        expect(gs.hazard.brake).toBe(PHASE.tell);
        expect(gs.events.some((e) => e.kind === 'hazard' && e.text.includes('handbrake'))).toBe(true);
        for (let i = 0; i < S(HAZARD.handbrake.tellS + 1) && gs.hazard.brake !== PHASE.active; i++) run(1);
        expect(gs.hazard.brake).toBe(PHASE.active);
        expect(gs.events.some((e) => e.kind === 'hazard' && e.text.includes('rolling'))).toBe(true);
        // where the guest draws the ute (from the host's snapshots), at the let-go and 3 s later
        const uteAt = () => {
            while (host.tick % 3 !== 0) run(1);
            const out = pose();
            expect(guestSim.ring.sample(guestSim.ute.slot, host.tick / 60, out, new Float64Array(6))).toBe(true);
            return { guest: out.p.z, host: host.ute.pose.p.z };
        };
        const a = uteAt();
        run(S(3));
        const b = uteAt();
        expect(b.guest - a.guest).toBeGreaterThan(2);
        expect(Math.abs(b.guest - b.host)).toBeLessThan(0.05);
        gs.leave();
        hs.stop();
    }, 60_000);
});

describe('hazard director: the level stays winnable', () => {
    it('after the flood washes the bridge away: fetch both beams from downstream, rebuild, carry the bucket over (placed setup: the player is put at the start, then plays by input)', () => {
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
            // (aim at the top face near the end: the bank is uneven, the end may sit low)
            pitch = -Math.atan2(s.player.y + EYE_HEIGHT - (beam.pose.p.y + 0.07), s.player.x - (beam.pose.p.x + 1.35));
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
            // up the ramp onto the lip behind the seat, so the beam reaches the far seat
            for (let i = 0; i < 900 && s.player.z > BRIDGE.nearEdge + 0.05; i++) step({ moveZ: 0.5 });
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
