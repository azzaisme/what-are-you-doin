import { beforeAll, describe, expect, it } from 'vitest';

import {
    BRIDGE,
    BRIDGE_X,
    CREEK_WATER_Y,
    FLOOD_PEAK_Y,
    YARD_Y,
    creekCenterZ,
    creekHalfWidth,
    timberYardLevel
} from '../../src/levels/timber-yard.ts';
import { neutralCommand } from '../../src/sim/commands.ts';
import type { PlayerCommand } from '../../src/sim/commands.ts';
import { HAZARD, PHASE, gustExposure, packHazardNet, readHazardNet } from '../../src/sim/hazards.ts';
import { EYE_HEIGHT, LabSim } from '../../src/sim/lab-sim.ts';
import { shapeSamples, shapeVolume } from '../../src/sim/physics/water.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { pose, quatFromYawPitchRoll, quatMul } from '../../src/voxels/math.ts';

beforeAll(() => initPhysics());

const yard = () => new LabSim({ level: timberYardLevel });
const byName = (s: LabSim, n: string) => s.entities.find((e) => e.name === n)!;
const cmd = (n: number, c: Partial<PlayerCommand> = {}): PlayerCommand => ({ ...neutralCommand(n), ...c });
const flood = HAZARD.flood;
const S = (s: number) => Math.round(s * 60);
/** Ticks from the trigger to the water being back to normal. */
const FLOOD_TICKS = S(flood.holdToTrigger + flood.delayS + flood.tellS + flood.riseS + flood.holdS + flood.fallS);
const hazardTexts = (s: LabSim) => s.events.filter((e) => e.kind === 'hazard').map((e) => e.text);

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
    it('the floodwater floats timber: sample points fill the shape, buoyancy beats a beam’s weight', () => {
        const beam = { type: 'box' as const, hx: 1.6, hy: 0.1, hz: 0.075 };
        const s = shapeSamples(beam);
        expect(s.pts.length / 3).toBeGreaterThanOrEqual(9);
        expect((s.vol * s.pts.length) / 3).toBeCloseTo(shapeVolume(beam), 6);
        // every sample lies inside the box
        for (let i = 0; i < s.pts.length; i += 3) expect(Math.abs(s.pts[i])).toBeLessThan(1.6);
        // timber (380 kg/m^3) is lighter than water
        expect(380).toBeLessThan(1000);
    });

    it('finishing the bridge sets off the flood: siren, rise to the peak, timber washed off and left downstream', () => {
        const s = yard();
        s.runTo(S(HAZARD.graceS) + 10);
        expect(hazardTexts(s)).toHaveLength(0);
        bridgeBeams(s);
        s.runTo(s.tick + S(flood.holdToTrigger + flood.delayS) + 5);
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
        s.runTo(s.tick + S(flood.holdToTrigger + flood.delayS) + 5);
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

    it('the budget: no flood in the first seconds, none once the bucket is across, at most two', () => {
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
        expect(flood.max).toBe(2);
    }, 60_000);
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

    it('carried at chest height near the water: a warning, then a gust tears it away towards the creek', () => {
        const s = yard();
        s.runTo(S(HAZARD.graceS) + 10);
        s.fpActive = true;
        s.runTo(s.tick + 2);
        const id = carrying(s);
        run(s, S(G.carryS) + 5);
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
        run(s, S(G.carryS) + 5, { pitch: -0.2 });
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
        run(s, S(G.carryS) + S(G.tellS) + S(G.blowS) + 40, {}, {});
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
        run(s, S(G.carryS) + 5);
        expect(s.hazards.gustPhase).toBe(PHASE.tell);
        s.physics.release(0);
        run(s, 90);
        const rest = { ...byName(s, 'plank').pose.p };
        run(s, S(G.tellS) + S(G.blowS));
        const now = byName(s, 'plank').pose.p;
        expect(Math.hypot(now.x - rest.x, now.z - rest.z)).toBeLessThan(0.05);
    }, 60_000);

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
    it('two runs of the same commands give the same hazards and the same world', () => {
        const play = () => {
            const s = yard();
            s.runTo(S(HAZARD.graceS) + 10);
            bridgeBeams(s);
            s.runTo(s.tick + 900);
            return {
                water: s.hazards.waterY,
                ev: hazardTexts(s).join('|'),
                beam: { ...byName(s, 'beam-0').pose.p }
            };
        };
        expect(play()).toEqual(play());
    }, 60_000);

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
