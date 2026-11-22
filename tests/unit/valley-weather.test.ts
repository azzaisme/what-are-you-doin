import { beforeAll, describe, expect, it } from 'vitest';

import type { LevelDef } from '../../src/levels/level.ts';
import {
    BRIDGE,
    BRIDGE_X,
    BUCKET_STUMP,
    CREEK_WATER_Y,
    YARD_Y,
    creekCenterZ,
    creekHalfWidth,
    roadCenterX,
    timberYardLevel,
    yardHeight
} from '../../src/levels/timber-yard.ts';
import {
    CHECKPOINTS,
    ROUTE_YAW,
    SUMMIT_U,
    VALLEY_HAZARDS,
    VALLEY_WEATHER_ZONES,
    roadT,
    routeT,
    routeToWorld,
    routeU,
    valleyLayout,
    valleyLevel,
    yardToWorld
} from '../../src/levels/valley.ts';
import { viewDistance } from '../../src/levels/view-distance.ts';
import { GuestSession, HostSession, listGames } from '../../src/net/session.ts';
import { MemoryHub } from '../../src/net/transport.ts';
import { SIM_HZ } from '../../src/sim/clock.ts';
import { neutralCommand } from '../../src/sim/commands.ts';
import type { PlayerCommand } from '../../src/sim/commands.ts';
import { HAZARD, PHASE, crossingFrame, packHazardNet, readHazardNet } from '../../src/sim/hazards.ts';
import { EYE_HEIGHT, LabSim } from '../../src/sim/lab-sim.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { W_PHASE, WEATHER, WeatherScheduler, fogOpacity, weatherCovers, weatherFog } from '../../src/sim/weather.ts';
import { pose, quatFromYawPitchRoll, quatMul } from '../../src/voxels/math.ts';

beforeAll(() => initPhysics());

const S = (s: number) => Math.round(s * SIM_HZ);
const cmd = (n: number, c: Partial<PlayerCommand> = {}): PlayerCommand => ({ ...neutralCommand(n), ...c });
const byName = (s: LabSim, n: string) => s.entities.find((e) => e.name === n)!;
const hazardTexts = (s: LabSim) => s.events.filter((e) => e.kind === 'hazard').map((e) => e.text);
const valley = () => new LabSim({ level: valleyLevel });
const zoneOf = (kind: number) => VALLEY_WEATHER_ZONES.findIndex((z) => z.kind === kind);
const flood = HAZARD.flood;
const FLOOD_TICKS = S(
    flood.holdToTrigger + flood.delayS + flood.delayJitterS + flood.tellS + flood.riseS + flood.holdS + flood.fallS
);
const TO_SIREN = S(flood.holdToTrigger + flood.delayS + flood.delayJitterS) + 5;
/** Longest a zone's weather waits after the first player gets there, then all of it, in ticks. */
const weatherTicks = (n: number) => {
    const z = VALLEY_WEATHER_ZONES[n];
    return { wait: S(z.delayS + z.delayJitterS) + 5, all: S(z.tellS + z.activeS + z.clearS) + 5 };
};

function runUntil(s: LabSim, done: () => boolean, max: number, c: () => Partial<PlayerCommand> = () => ({})): number {
    let n = 0;
    while (n < max && !done()) {
        s.step(cmd(s.tick, c()));
        n++;
    }
    return n;
}

/** The Valley's world in the Timber Yard's own frame (x along the creek, z towards the yard). */
const toYard = (p: { x: number; z: number }) => ({
    x: routeT(p.x, p.z) + BRIDGE_X,
    z: creekCenterZ(BRIDGE_X) - routeU(p.x, p.z)
});
const ROUTE_Q = quatFromYawPitchRoll(ROUTE_YAW, 0, 0);
/** A yard-frame pose in the Valley. */
const yardPose = (x: number, y: number, z: number, q: { x: number; y: number; z: number; w: number }) => {
    const w = yardToWorld(x, z);
    const out = pose(w.x, y, w.z);
    quatMul(ROUTE_Q, q, out.q);
    return out;
};

const RAIN = () => zoneOf(WEATHER.rain);

/**
 * Carriers pick up beam-2 at the log dump by its road-side end (by input: look at it, grab, lift),
 * turn up the road and walk 12 m along it. `send` steps the simulation with one command per
 * player slot (undefined: that slot's neutral command). Returns where the beam was dropped (m
 * walked; -1 never) and how many still hold it at the end.
 */
function carryUpTheRoad(
    s: LabSim,
    slots: number[],
    send: (cmds: (Partial<PlayerCommand> | undefined)[]) => void
): { dropAt: number; holders: number; beam: { x: number; y: number; z: number }; dropU: number } {
    const beam = byName(s, 'beam-2');
    const b0 = beam.pose.p;
    const bu = routeU(b0.x, b0.z);
    const bt = routeT(b0.x, b0.z);
    const offs = slots.length > 1 ? [-0.35, 0.35] : [0];
    const along = ROUTE_YAW - Math.PI / 2; // facing +t, along the beam
    const look = slots.map(() => ({ yaw: along, pitch: 0 }));
    slots.forEach((slot, i) => {
        const at = routeToWorld(bu + offs[i], bt - 1.6 - 1.7);
        s.placePlayer(at.x, at.z, along, slot);
    });
    const step = (extra: Partial<PlayerCommand>[] = [], k = 1) => {
        for (let n = 0; n < k; n++) {
            const cmds: (Partial<PlayerCommand> | undefined)[] = [];
            slots.forEach((slot, i) => (cmds[slot] = { ...look[i], ...(extra[i] ?? {}) }));
            send(cmds);
        }
    };
    const ease = (to: (i: number) => { yaw?: number; pitch?: number }, k: number) => {
        const from = look.map((l) => ({ ...l }));
        for (let n = 1; n <= k; n++) {
            look.forEach((l, i) => {
                const t = to(i);
                if (t.yaw !== undefined) l.yaw = from[i].yaw + ((t.yaw - from[i].yaw) * n) / k;
                if (t.pitch !== undefined) l.pitch = from[i].pitch + ((t.pitch - from[i].pitch) * n) / k;
            });
            step();
        }
    };
    step([], 20);
    // look at the top face near the end, each at their own spot on it
    slots.forEach((slot, i) => {
        const e = routeToWorld(bu + offs[i] * 0.15, bt - 1.6 + 0.25 + i * 0.2);
        const p = s.players[slot];
        look[i].yaw = Math.atan2(-(e.x - p.x), -(e.z - p.z));
        look[i].pitch = -Math.atan2(p.y + EYE_HEIGHT - (beam.pose.p.y + 0.07), Math.hypot(e.x - p.x, e.z - p.z));
    });
    step([], 10);
    step(slots.map(() => ({ grab: true })));
    expect(s.physics.holders(beam.id), 'picked up by each carrier').toBe(slots.length);
    ease(() => ({ yaw: along }), 20);
    ease(() => ({ pitch: -0.25 }), 40);
    // turn up the road (+u)
    ease(() => ({ yaw: ROUTE_YAW }), 90);
    expect(s.physics.holders(beam.id), 'still held, facing up the road').toBe(slots.length);
    const lead = slots[0];
    const u0 = routeU(s.players[lead].x, s.players[lead].z);
    let dropAt = -1;
    let dropU = NaN;
    for (let n = 0; n < 900 && routeU(s.players[lead].x, s.players[lead].z) < u0 + 12; n++) {
        step(
            slots.map((slot) => {
                const p = s.players[slot];
                const u = routeU(p.x, p.z);
                return { moveZ: 1, moveX: Math.max(-1, Math.min(1, (routeT(p.x, p.z) - roadT(u)) * 0.8)) };
            })
        );
        if (dropAt < 0 && s.physics.holders(beam.id) < slots.length) {
            const p = s.players[lead];
            dropAt = routeU(p.x, p.z) - u0;
            dropU = routeU(p.x, p.z);
        }
    }
    return { dropAt, holders: s.physics.holders(beam.id), beam: { ...beam.pose.p }, dropU };
}

describe('the Valley’s flood at Shallow Creek (the Timber Yard’s, turned with the yard)', () => {
    it('the crossing’s frame lines up with the creek: a bridge across it counts, one along the bank does not', () => {
        const c = VALLEY_HAZARDS.flood!.crossing;
        // the yard's crossing, in the turned frame
        const near = crossingFrame(c, yardToWorld(BRIDGE_X, BRIDGE.nearFace));
        const far = crossingFrame(c, yardToWorld(BRIDGE_X, BRIDGE.farFace));
        expect(near.x).toBeCloseTo(c.x, 6);
        expect(far.x).toBeCloseTo(c.x, 6);
        expect(c.z0 - c.z1).toBeCloseTo(BRIDGE.nearFace - BRIDGE.farFace, 6);
        const s = valley();
        s.step(cmd(0));
        const flat = quatMul(quatFromYawPitchRoll(Math.PI / 2, 0, 0), quatFromYawPitchRoll(0, Math.PI / 2, 0));
        const along = quatFromYawPitchRoll(0, Math.PI / 2, 0);
        s.physics.place(byName(s, 'beam-0').id, yardPose(BRIDGE_X - 0.105, YARD_Y + 0.35, BRIDGE.zc, flat));
        // (the other beam along the creek, on the near bank: not across)
        s.physics.place(byName(s, 'beam-1').id, yardPose(BRIDGE_X + 3, YARD_Y + 0.2, BRIDGE.nearEdge + 1, along));
        for (let n = 0; n < 90; n++) s.step(cmd(s.tick, { yaw: ROUTE_YAW }));
        expect(s.hazards.crossingSpanned(s.physics, VALLEY_HAZARDS.flood!)).toBe(1);
    }, 60_000);

    it('after the flood washes the bridge away: fetch both beams from downstream, rebuild, carry the bucket over (player inputs only)', () => {
        const s = valley();
        // the Timber Yard stage is done: the run is at Shallow Creek, the bucket on its stump
        s.progress.step = 1;
        s.runTo(S(HAZARD.graceS) + 10);
        const flat = quatMul(quatFromYawPitchRoll(Math.PI / 2, 0, 0), quatFromYawPitchRoll(0, Math.PI / 2, 0));
        ['beam-0', 'beam-1'].forEach((n, i) =>
            s.physics.place(byName(s, n).id, yardPose(BRIDGE_X - 0.105 + i * 0.21, YARD_Y + 0.35, BRIDGE.zc, flat))
        );
        runUntil(s, () => s.hazards.floodPhase === PHASE.tell, TO_SIREN);
        expect(hazardTexts(s)[0]).toContain('siren');
        runUntil(s, () => s.hazards.floodPhase === PHASE.idle, FLOOD_TICKS);
        expect(s.hazards.floodMoved).toBe(2);
        s.runTo(s.tick + 60);
        // both beams really were carried off: left downstream on the near bank, out of the creek
        for (const n of ['beam-0', 'beam-1']) {
            const p = byName(s, n).pose.p;
            const y = toYard(p);
            expect(y.x, n).toBeGreaterThan(BRIDGE_X + 4);
            expect(y.z - creekCenterZ(y.x), n).toBeGreaterThan(creekHalfWidth(y.x));
            expect(p.y, n).toBeGreaterThan(YARD_Y - 0.1);
        }
        s.fpActive = true;
        // the yard test's moves (tests/unit/hazards.test.ts), in the yard's frame
        let yaw = 0;
        let pitch = 0;
        const me = () => toYard(s.player);
        const step = (c: Partial<PlayerCommand> = {}, k = 1) => {
            for (let i = 0; i < k; i++) s.step(cmd(s.tick, { yaw: yaw + ROUTE_YAW, pitch, ...c }));
        };
        const ease = (to: number, k: number, set: (v: number) => void, from: number) => {
            for (let i = 1; i <= k; i++) {
                set(from + ((to - from) * i) / k);
                step();
            }
        };
        const walkTo = (x: number, z: number) => {
            for (let i = 0; i < 1800; i++) {
                const p = me();
                const dx = x - p.x;
                const dz = z - p.z;
                if (Math.hypot(dx, dz) < 0.25) break;
                yaw = Math.atan2(-dx, -dz);
                step({ moveZ: Math.min(1, Math.hypot(dx, dz) * 2 + 0.2) });
            }
        };
        const at = (name: string) => {
            const p = byName(s, name).pose.p;
            return { ...toYard(p), y: p.y };
        };
        /** A beam's long axis, in the yard's frame (x along +t, z along -u). */
        const yardAxis = (id: number) => {
            const q = s.physics.bodies.get(id)!.body.rotation();
            const ax = { x: 1 - 2 * (q.y * q.y + q.z * q.z), z: 2 * (q.x * q.z - q.w * q.y) };
            return { x: (ax.x + ax.z) * Math.SQRT1_2, z: -(ax.x - ax.z) * Math.SQRT1_2 };
        };
        const across = (name: string) => {
            const b = at(name);
            return Math.abs(b.x - BRIDGE_X) < BRIDGE.halfWidth && Math.abs(b.z - BRIDGE.zc) < 0.4 && b.y > YARD_Y;
        };
        const start = yardToWorld(1.2, 6.2);
        s.placePlayer(start.x, start.z, ROUTE_YAW);
        step({}, 10);
        for (const [name, x] of [
            ['beam-0', BRIDGE_X - 0.12],
            ['beam-1', BRIDGE_X + 0.12]
        ] as const) {
            const beam = byName(s, name);
            const b = at(name);
            walkTo(3, 3);
            walkTo(b.x + 2.4, b.z);
            yaw = Math.PI / 2;
            for (let i = 0; i < 120 && Math.abs(me().z - at(name).z) > 0.02; i++)
                step({ moveX: Math.max(-0.4, Math.min(0.4, (me().z - at(name).z) * 4)) });
            step({}, 20);
            // aim at the top face near its +x end, along the beam as it lies (the flood can leave it
            // a few degrees askew)
            const endAt = (d: number) => {
                const { x: yx, z: yz } = yardAxis(beam.id);
                const k = yx < 0 ? -1 : 1;
                const c = at(name);
                return { x: c.x + k * yx * d, z: c.z + k * yz * d, y: c.y + 0.07 };
            };
            const e = endAt(1.35);
            yaw = Math.atan2(-(e.x - me().x), -(e.z - me().z));
            step({}, 10);
            pitch = -Math.atan2(s.player.y + EYE_HEIGHT - e.y, Math.hypot(e.x - me().x, e.z - me().z));
            step({}, 5);
            step({ grab: true });
            expect(s.physics.heldId, `${name} picked up`).toBe(beam.id);
            ease(-0.25, 40, (v) => (pitch = v), pitch);
            for (let i = 0; i < 1800 && me().x > x + 0.03; i++)
                step({ moveZ: Math.min(1, (me().x - x) * 2 + 0.1), moveX: (me().z - 2.5) * 0.8 });
            step({}, 20);
            ease(0, 120, (v) => (yaw = v), yaw);
            // square it up with the creek: turn until the beam points straight across (-z)
            for (let n = 0; n < 3; n++) {
                const a = yardAxis(beam.id);
                const k = a.z > 0 ? -1 : 1;
                const off = Math.atan2(-k * a.x, -k * a.z);
                ease(yaw - off, 30, (v) => (yaw = v), yaw);
                step({}, 10);
            }
            // out over the creek until the beam's middle is over it (by eye: where it was gripped
            // along it varies), up to the bank's edge
            // (straight across, -z, whichever way the squaring left them facing)
            for (let i = 0; i < 900 && at(name).z > BRIDGE.zc + 0.05 && me().z > BRIDGE.nearEdge + 0.1; i++)
                step({ moveZ: 0.5 * Math.cos(yaw), moveX: 0.5 * Math.sin(yaw) });
            // at the edge and not out far enough: push it out with the wheel (a longer hold)
            for (let i = 0; i < 40 && at(name).z > BRIDGE.zc + 0.05; i++) step({ reach: 0.05 });
            step({}, 30);
            ease(-0.7, 40, (v) => (pitch = v), pitch);
            step({}, 30);
            step({ grab: true });
            step({}, 120);
            expect(s.physics.heldId).toBe(-1);
            expect(across(name), `${name} across: ${JSON.stringify(at(name))}, player ${JSON.stringify(me())}`).toBe(
                true
            );
        }
        // the bucket from its stump, over the rebuilt bridge to the far bank's flag
        const bucket = byName(s, 'bucket');
        walkTo(BUCKET_STUMP.x, BUCKET_STUMP.z + 1);
        yaw = 0;
        step({}, 10);
        pitch = -Math.atan2(s.player.y + EYE_HEIGHT - bucket.pose.p.y, me().z - toYard(bucket.pose.p).z);
        step({}, 3);
        step({ grab: true });
        expect(s.physics.heldId).toBe(bucket.id);
        pitch = 0;
        for (let i = 0; i < 900 && Math.abs(me().x - BRIDGE_X) > 0.05; i++)
            step({ moveX: (me().x > BRIDGE_X ? -1 : 1) * Math.min(1, Math.abs(me().x - BRIDGE_X) * 2 + 0.1) });
        const goalZ = toYard(routeToWorld(CHECKPOINTS[1].u, CHECKPOINTS[1].t)).z;
        for (let i = 0; i < 900 && me().z > goalZ; i++) step({ moveZ: 1 });
        step({ grab: true });
        for (let i = 0; i < 300 && s.progress.step < 2; i++) step();
        expect(s.progress.falls).toBe(0);
        expect(s.progress.step).toBe(2);
    }, 180_000);
    /** Both beams across the abutments in the Valley (dropped onto the caps). */
    function bridgeValley(s: LabSim): void {
        const flat = quatMul(quatFromYawPitchRoll(Math.PI / 2, 0, 0), quatFromYawPitchRoll(0, Math.PI / 2, 0));
        ['beam-0', 'beam-1'].forEach((n, i) =>
            s.physics.place(byName(s, n).id, yardPose(BRIDGE_X - 0.105 + i * 0.21, YARD_Y + 0.35, BRIDGE.zc, flat))
        );
    }

    it('the flood keeps to the creek’s channel: what lies in the Timber Yard (its ground is under the peak) never moves', () => {
        const s = valley();
        s.runTo(S(HAZARD.graceS) + 10);
        const inYard = s.entities.filter((e) => {
            const pb = s.physics.bodies.get(e.id);
            if (!pb || pb.kind !== 'dynamic' || e.name.startsWith('beam-0') || e.name === 'beam-1') return false;
            const y = toYard(e.pose.p);
            // lying on the yard's ground (0.4 m, under the flood's 0.6 m peak), off the creek
            return (
                Math.abs(y.x) < 20 &&
                y.z - creekCenterZ(y.x) > creekHalfWidth(y.x) + 0.5 &&
                e.pose.p.y < VALLEY_HAZARDS.flood!.peakY + 0.2
            );
        });
        expect(inYard.length).toBeGreaterThan(3);
        const before = inYard.map((e) => ({ ...e.pose.p }));
        bridgeValley(s);
        runUntil(s, () => s.hazards.floodPhase === PHASE.tell, TO_SIREN);
        let peak = -Infinity;
        runUntil(
            s,
            () => {
                peak = Math.max(peak, s.hazards.waterY);
                return s.hazards.floodPhase === PHASE.idle;
            },
            FLOOD_TICKS
        );
        expect(peak).toBeCloseTo(VALLEY_HAZARDS.flood!.peakY, 2);
        inYard.forEach((e, i) =>
            expect(Math.hypot(e.pose.p.x - before[i].x, e.pose.p.z - before[i].z), e.name).toBeLessThan(0.05)
        );
        // the drawn surface stops under the banks
        expect(valleyLevel.water.drawMaxY!).toBeLessThan(YARD_Y);
    }, 120_000);

    it('in the channel it is as strong as before: it floats the bridge off as soon as it did over the whole map', () => {
        /** Ticks from the siren until both beams are off the abutments. */
        const offAfter = (level: LevelDef) => {
            const s = new LabSim({ level });
            s.runTo(S(HAZARD.graceS) + 10);
            bridgeValley(s);
            runUntil(s, () => s.hazards.floodPhase === PHASE.tell, TO_SIREN);
            const on = (n: string) => {
                const b = byName(s, n).pose.p;
                const y = toYard(b);
                return Math.abs(y.x - BRIDGE_X) < BRIDGE.halfWidth && Math.abs(y.z - BRIDGE.zc) < 0.4 && b.y > YARD_Y;
            };
            return runUntil(s, () => !on('beam-0') && !on('beam-1'), FLOOD_TICKS);
        };
        const channel = offAfter(valleyLevel);
        const everywhere = offAfter({
            ...valleyLevel,
            hazards: { ...VALLEY_HAZARDS, flood: { ...VALLEY_HAZARDS.flood!, channel: undefined } }
        });
        expect(channel).toBeLessThan(FLOOD_TICKS);
        expect(Math.abs(channel - everywhere)).toBeLessThanOrEqual(Math.max(30, everywhere * 0.1));
    }, 120_000);
});

describe('weather along the Valley (#88): each comes with its counterplay', () => {
    it('one kind per area, in route order, and none over the summit (the flower stays in sight)', () => {
        expect(VALLEY_WEATHER_ZONES.map((z) => z.kind)).toEqual([
            WEATHER.rain,
            WEATHER.mist,
            WEATHER.fog,
            WEATHER.snow
        ]);
        const top = routeToWorld(SUMMIT_U, 0);
        for (const [n, z] of VALLEY_WEATHER_ZONES.entries()) {
            expect(z.contains(top.x, top.z), z.name).toBe(false);
            expect(weatherCovers(VALLEY_HAZARDS.weather, n, top.x, top.z)).toBe(false);
        }
    });

    it('no seam at the near world’s edge: a veil fogs it out fully on both presets; rain and snow never show it more than clear weather does', () => {
        const stream = valleyLevel.stream!;
        for (const preset of ['low', 'high'] as const) {
            const v = viewDistance(stream, preset);
            const base = { start: v.fogStart, end: stream.fog.end };
            const clear = fogOpacity(base, v.radius);
            for (const [n, z] of VALLEY_WEATHER_ZONES.entries()) {
                const f = weatherFog(VALLEY_HAZARDS.weather, n, 1, base, v.radius);
                expect(f.start, `${z.name} ${preset}`).toBeLessThan(f.end);
                const edge = fogOpacity(f, v.radius);
                if (z.veil)
                    expect(edge, `${z.name} on ${preset}: fog at the ${v.radius} m edge`).toBeGreaterThanOrEqual(0.95);
                else expect(edge, `${z.name} on ${preset}`).toBeGreaterThanOrEqual(clear);
            }
        }
        // the veils are the mist and the fog bank
        expect(VALLEY_WEATHER_ZONES.filter((z) => z.veil).map((z) => z.kind)).toEqual([WEATHER.mist, WEATHER.fog]);
    });

    it('the gorge mist is atmosphere, not a hazard: it comes during another hazard, says nothing and holds up nothing', () => {
        const mist = zoneOf(WEATHER.mist);
        expect(VALLEY_WEATHER_ZONES[mist].atmosphere).toBe(true);
        const w = new WeatherScheduler(VALLEY_HAZARDS.weather!);
        const gorge = routeToWorld(80, roadT(80));
        const said: string[] = [];
        // the director's budget says no all the way through
        for (let tick = 0; tick < S(80); tick++) {
            const m = w.step({ tick, hz: SIM_HZ, players: [gorge], canStart: false, rand: () => 0.5 });
            if (m) said.push(m);
            if (w.busy) expect(w.hazardBusy).toBe(false);
        }
        expect(said).toEqual([]);
        expect(w.phase).toBe(W_PHASE.idle);
    });

    // ---- rain: wet timber slips

    /** A Valley sim with the rain on the forest road at full strength (it came on its own). */
    function inTheRain(players = 1): LabSim {
        const s = valley();
        s.fpActive = true;
        if (players > 1) s.setSlotActive(1, true);
        const road = routeToWorld(20, roadT(20));
        for (let i = 0; i < players; i++) s.placePlayer(road.x, road.z + i, ROUTE_YAW, i);
        runUntil(
            s,
            () => s.hazards.weather!.zone === RAIN() && s.hazards.weather!.strength > 0.99,
            S(HAZARD.graceS) + weatherTicks(RAIN()).wait + S(20)
        );
        expect(s.hazards.weather!.zone).toBe(RAIN());
        expect(hazardTexts(s).at(-1)).toContain('Wet timber slips: carry heavy pieces together');
        return s;
    }

    const hostSend = (s: LabSim) => (c: (Partial<PlayerCommand> | undefined)[]) =>
        s.step(cmd(s.tick, c[0] ?? {}), c[1] ? cmd(s.tick, c[1]) : undefined);

    it('rain on the forest road: wet timber slips; a heavy beam carried alone slips out on the way up the road', () => {
        const s = inTheRain();
        const r = carryUpTheRoad(s, [0], hostSend(s));
        expect(s.physics.gripScale[0]).toBeCloseTo(1 - HAZARD.wetGrip, 3);
        expect(r.dropAt, 'it slipped').toBeGreaterThan(0);
        expect(r.dropAt).toBeLessThan(12);
        expect(r.holders).toBe(0);
        // where: on the forest road, in the rain, and it fell there (not flung)
        const dropped = routeToWorld(r.dropU, roadT(r.dropU));
        expect(VALLEY_WEATHER_ZONES[RAIN()].contains(dropped.x, dropped.z)).toBe(true);
        expect(Math.abs(routeU(r.beam.x, r.beam.z) - r.dropU)).toBeLessThan(4);
    }, 180_000);

    it('counterplay: carried together, two beavers hold it all the way in the rain', () => {
        const s = inTheRain(2);
        const r = carryUpTheRoad(s, [0, 1], hostSend(s));
        expect(r.dropAt).toBe(-1);
        expect(r.holders).toBe(2);
    }, 180_000);

    it('the control: the same carry alone without rain holds all the way (the rain made it slip)', () => {
        const s = valley();
        s.fpActive = true;
        s.step(cmd(0));
        const r = carryUpTheRoad(s, [0], hostSend(s));
        // (over before the rain can come: no weather yet)
        expect(s.hazards.weather!.busy).toBe(false);
        expect(s.physics.gripScale[0] ?? 1).toBe(1);
        expect(r.dropAt).toBe(-1);
        expect(r.holders).toBe(1);
    }, 180_000);

    // ---- fog

    it('fog on the mountain road, a layout check: the edge posts and signs are close together along the stretch', () => {
        const z = VALLEY_WEATHER_ZONES[zoneOf(WEATHER.fog)];
        const markers = valleyLayout(1)
            .pieces.filter((p) => /^(road-post|route-sign|flag-pole)$/.test(p.name))
            .map((p) => ({ u: routeU(p.pose.p.x, p.pose.p.z), t: routeT(p.pose.p.x, p.pose.p.z) }));
        let worst = 0;
        for (let u = 0; u < SUMMIT_U; u += 0.5) {
            const r = routeToWorld(u, roadT(u));
            if (!z.contains(r.x, r.z)) continue;
            const ahead = markers
                .filter((m) => m.u > u)
                .map((m) => Math.hypot(m.u - u, m.t - roadT(u)))
                .sort((a, b) => a - b)[0];
            worst = Math.max(worst, ahead);
        }
        expect(worst).toBeGreaterThan(0);
        // well inside the fog's end on the Low preset
        expect(worst).toBeLessThan(valleyLevel.stream!.lowRadius! * 0.5);
    });

    it('counterplay, played: in the fog a beaver walks the stretch by input, steering only by the edge posts they can see, and stays on the road', () => {
        const s = valley();
        s.fpActive = true;
        const fog = zoneOf(WEATHER.fog);
        const start = routeToWorld(138.5, roadT(138.5));
        s.placePlayer(start.x, start.z, ROUTE_YAW);
        s.step(cmd(s.tick, { yaw: ROUTE_YAW }));
        expect(s.hazards.startWeatherNow(s, fog)).toBe(true);
        // what can be seen: as far as the fog's end on the Low preset (the nearest it closes in)
        const v = viewDistance(valleyLevel.stream!, 'low');
        const seeing = weatherFog(
            VALLEY_HAZARDS.weather,
            fog,
            1,
            { start: v.fogStart, end: valleyLevel.stream!.fog.end },
            v.radius
        ).end;
        expect(seeing).toBeLessThanOrEqual(v.radius);
        const posts = valleyLayout(1)
            .pieces.filter((p) => p.name === 'road-post')
            .map((p) => ({ x: p.pose.p.x, z: p.pose.p.z }));
        let yaw = ROUTE_YAW;
        let worstOff = 0;
        let steered = 0;
        for (let n = 0; n < 2400 && routeU(s.player.x, s.player.z) < 166; n++) {
            const p = s.player;
            const fx = -Math.sin(yaw);
            const fz = -Math.cos(yaw);
            // the nearest edge post ahead (within 60 degrees of the view) that the fog lets you see
            const seen = posts
                .map((q) => ({ q, dx: q.x - p.x, dz: q.z - p.z }))
                .map((o) => ({ ...o, d: Math.hypot(o.dx, o.dz) }))
                .filter((o) => o.d > 2 && o.d <= seeing && (o.dx * fx + o.dz * fz) / o.d > 0.5)
                .sort((a, b) => a.d - b.d)[0];
            if (seen) {
                // the posts mark the road's right-hand edge: aim 2.6 m to the left of the next one
                const lx = seen.dz / seen.d;
                const lz = -seen.dx / seen.d;
                const tx = seen.q.x + lx * 2.6;
                const tz = seen.q.z + lz * 2.6;
                yaw = Math.atan2(-(tx - p.x), -(tz - p.z));
                steered++;
            }
            s.step(cmd(s.tick, { yaw, moveZ: 1 }));
            const u = routeU(s.player.x, s.player.z);
            worstOff = Math.max(worstOff, Math.abs(routeT(s.player.x, s.player.z) - roadT(u)));
        }
        expect(s.hazards.weather!.zone).toBe(fog);
        expect(routeU(s.player.x, s.player.z)).toBeGreaterThanOrEqual(166);
        expect(steered).toBeGreaterThan(100);
        expect(s.progress.falls).toBe(0);
        expect(s.progress.recoveries).toBe(0);
        // on the road all the way (the posts stand 2.6 m out from its middle)
        expect(worstOff).toBeLessThan(2.2);
    }, 180_000);

    it('the fog comes, holds and goes: back to the level’s own afterwards', () => {
        const z = VALLEY_WEATHER_ZONES[zoneOf(WEATHER.fog)];
        const v = viewDistance(valleyLevel.stream!, 'low');
        const base = { start: v.fogStart, end: valleyLevel.stream!.fog.end };
        const w = new WeatherScheduler(VALLEY_HAZARDS.weather!);
        const inFog = routeToWorld(150, roadT(150));
        const ends: number[] = [];
        for (let tick = 0; tick < S(200); tick++) {
            w.step({ tick, hz: SIM_HZ, players: [inFog], canStart: true, rand: () => 0.5 });
            const k = weatherCovers(VALLEY_HAZARDS.weather, w.zone, inFog.x, inFog.z) ? w.strength : 0;
            ends.push(weatherFog(VALLEY_HAZARDS.weather, w.zone, k, base, v.radius).end);
        }
        expect(Math.min(...ends)).toBeCloseTo(Math.min(z.fogEnd!, v.radius), 3);
        expect(ends[ends.length - 1]).toBe(base.end);
        expect(w.phase).toBe(W_PHASE.idle);
        expect(weatherFog(VALLEY_HAZARDS.weather, w.zone, w.strength, base, v.radius)).toEqual(base);
    });

    // ---- snow

    /** Where player `slot` waits at the crevasse (side by side across the road, facing up it). */
    const SNOW_U = 167.2;
    const snowT = (slot: number) => roadT(SNOW_U) - 0.65 + slot * 1.3;
    const snowSpot = (slot: number) => routeToWorld(SNOW_U, snowT(slot));

    /** Runs a Valley sim until the snow is gathering, players waiting at the crevasse. */
    function untilSnow(s: LabSim, players = 1): void {
        const snow = zoneOf(WEATHER.snow);
        for (let i = 0; i < players; i++) {
            const a = snowSpot(i);
            s.placePlayer(a.x, a.z, ROUTE_YAW, i);
        }
        const w = weatherTicks(snow);
        runUntil(
            s,
            () => s.hazards.weather!.phase === W_PHASE.tell,
            S(HAZARD.graceS) + w.wait,
            () => ({ yaw: ROUTE_YAW })
        );
        expect(s.hazards.weather!.zone).toBe(snow);
        expect(hazardTexts(s).at(-1)).toContain('Snow');
    }

    /**
     * A plank laid on the ground in front of the players, across them (along t, the way the squall
     * blows); each player in `slots` looks at it in front of them, picks it up and lifts it (input).
     */
    function pickUpInSnow(s: LabSim, slots: number[]): number {
        const plank = byName(s, 'extra-plank-9');
        const mid = slots.reduce((a, slot) => a + snowT(slot), 0) / slots.length;
        const c = routeToWorld(SNOW_U + 1.0, mid);
        const g = valleyLevel.terrainHeight(c.x, c.z);
        s.physics.place(plank.id, pose(c.x, g + 0.12, c.z, quatFromYawPitchRoll(ROUTE_YAW, Math.PI / 2, 0)));
        const look = slots.map(() => ({ yaw: ROUTE_YAW, pitch: 0 }));
        const step = (extra: Partial<PlayerCommand> = {}, k = 1) => {
            for (let n = 0; n < k; n++) {
                const c1 = slots.includes(0) ? cmd(s.tick, { ...look[slots.indexOf(0)], ...extra }) : cmd(s.tick);
                const c2 = slots.includes(1) ? cmd(s.tick, { ...look[slots.indexOf(1)], ...extra }) : undefined;
                s.step(c1, c2);
            }
        };
        step({}, 40);
        slots.forEach((slot, i) => {
            const pl = plank.pose.p;
            const e = routeToWorld(SNOW_U + 1.0, snowT(slot) + (slots.length > 1 ? 0 : 0));
            const p = s.players[slot];
            look[i].yaw = Math.atan2(-(e.x - p.x), -(e.z - p.z));
            look[i].pitch = -Math.atan2(p.y + EYE_HEIGHT - (pl.y + 0.05), Math.hypot(e.x - p.x, e.z - p.z));
        });
        step({}, 10);
        step({ grab: true });
        expect(s.physics.holders(plank.id), 'picked up by each player').toBe(slots.length);
        // face up the road again and lift it to the chest
        for (let n = 1; n <= 40; n++) {
            look.forEach((l) => {
                l.yaw += (ROUTE_YAW - l.yaw) / (41 - n);
                l.pitch += (0 - l.pitch) / (41 - n);
            });
            step();
        }
        expect(s.physics.holders(plank.id)).toBe(slots.length);
        return plank.id;
    }

    function runSnow(s: LabSim, c: Partial<PlayerCommand>, c2?: Partial<PlayerCommand>): void {
        const z = VALLEY_WEATHER_ZONES[zoneOf(WEATHER.snow)];
        for (let i = 0; i < S(z.tellS + z.activeS * 0.5); i++)
            s.step(cmd(s.tick, { yaw: ROUTE_YAW, ...c }), c2 ? cmd(s.tick, { yaw: ROUTE_YAW, ...c2 }) : undefined);
    }

    it('the snow squall at the crevasse: a plank carried high in one pair of hands is torn away across the road', () => {
        const s = valley();
        s.fpActive = true;
        untilSnow(s);
        const id = pickUpInSnow(s, [0]);
        const p0 = s.physics.bodies.get(id)!.body.translation();
        const t0 = routeT(p0.x, p0.z);
        runSnow(s, {});
        expect(s.physics.heldIdOf(0)).toBe(-1);
        expect(s.hazards.lastWindForce).toBeGreaterThan(650);
        expect(hazardTexts(s).some((t) => t.includes('squall tore'))).toBe(true);
        // blown downwind (+t)
        const p = s.physics.bodies.get(id)!.body.translation();
        expect(routeT(p.x, p.z) - t0).toBeGreaterThan(0.5);
    }, 120_000);

    it('counterplay: carried low, one grip holds it through the squall', () => {
        const s = valley();
        s.fpActive = true;
        untilSnow(s);
        const id = pickUpInSnow(s, [0]);
        runSnow(s, { pitch: -1.05 });
        expect(s.physics.heldIdOf(0)).toBe(id);
        expect(s.hazards.lastWindForce).toBeLessThan(650);
    }, 120_000);

    it('counterplay: carried together (both pick it up by input), two grips hold it through the squall', () => {
        const s = valley();
        s.fpActive = true;
        s.setSlotActive(1, true);
        untilSnow(s, 2);
        const id = pickUpInSnow(s, [0, 1]);
        runSnow(s, {}, {});
        expect(s.physics.holders(id)).toBe(2);
        expect(s.hazards.lastWindForce).toBeGreaterThan(650);
    }, 120_000);
});

describe('weather and the one-hazard-at-a-time budget', () => {
    it('a finished bridge at Shallow Creek waits out the rain (and its quiet spell); the rain waits out a flood', () => {
        // rain first: a player on the forest road while the bridge is finished behind them
        const s = valley();
        s.fpActive = true;
        s.progress.step = 1;
        s.step(cmd(0));
        const rain = zoneOf(WEATHER.rain);
        const road = routeToWorld(20, roadT(20));
        s.placePlayer(road.x, road.z, ROUTE_YAW);
        runUntil(s, () => s.hazards.weather!.phase === W_PHASE.tell, S(HAZARD.graceS) + weatherTicks(rain).wait);
        expect(s.hazards.weather!.busy).toBe(true);
        const flat = quatMul(quatFromYawPitchRoll(Math.PI / 2, 0, 0), quatFromYawPitchRoll(0, Math.PI / 2, 0));
        ['beam-0', 'beam-1'].forEach((n, i) =>
            s.physics.place(byName(s, n).id, yardPose(BRIDGE_X - 0.105 + i * 0.21, YARD_Y + 0.35, BRIDGE.zc, flat))
        );
        let floodDuringWeather = false;
        runUntil(
            s,
            () => {
                if (s.hazards.weather!.busy && (s.hazards.floodPhase !== PHASE.idle || s.hazards.busy))
                    floodDuringWeather = true;
                return !s.hazards.weather!.busy;
            },
            weatherTicks(rain).all
        );
        expect(floodDuringWeather).toBe(false);
        const clearTick = s.tick;
        // the quiet spell, then the bridge brings the flood
        runUntil(s, () => s.hazards.floodPhase === PHASE.tell, S(HAZARD.safeS) + TO_SIREN + 10);
        expect(s.hazards.floodPhase).toBe(PHASE.tell);
        expect(s.tick - clearTick).toBeGreaterThanOrEqual(S(HAZARD.safeS) - 1);

        // flood first: the rain's area reached during the flood waits for it
        const f = valley();
        f.fpActive = true;
        f.progress.step = 1;
        f.runTo(S(HAZARD.graceS) + 10);
        ['beam-0', 'beam-1'].forEach((n, i) =>
            f.physics.place(byName(f, n).id, yardPose(BRIDGE_X - 0.105 + i * 0.21, YARD_Y + 0.35, BRIDGE.zc, flat))
        );
        runUntil(f, () => f.hazards.floodPhase === PHASE.tell, TO_SIREN);
        const p2 = routeToWorld(20, roadT(20));
        f.placePlayer(p2.x, p2.z, ROUTE_YAW);
        let rainDuringFlood = false;
        runUntil(
            f,
            () => {
                if (f.hazards.floodPhase !== PHASE.idle && f.hazards.weather!.busy) rainDuringFlood = true;
                return f.hazards.floodPhase === PHASE.idle;
            },
            FLOOD_TICKS
        );
        expect(rainDuringFlood).toBe(false);
        const floodEnd = f.tick;
        runUntil(f, () => f.hazards.weather!.busy, S(HAZARD.safeS) + weatherTicks(rain).wait + 10);
        expect(f.hazards.weather!.zone).toBe(rain);
        expect(f.tick - floodEnd).toBeGreaterThanOrEqual(S(HAZARD.safeS) - 1);
    }, 240_000);

    it('and with the aimed gust (a Timber Yard with weather over it): neither starts while the other runs', () => {
        const over: LevelDef = {
            ...timberYardLevel,
            hazards: {
                ...timberYardLevel.hazards!,
                weather: {
                    zones: [
                        {
                            ...VALLEY_WEATHER_ZONES[zoneOf(WEATHER.snow)],
                            contains: () => true,
                            delayS: 0,
                            delayJitterS: 0
                        }
                    ]
                }
            }
        };
        const s = new LabSim({ level: over });
        s.fpActive = true;
        // the weather comes straight after the grace period
        runUntil(s, () => s.hazards.weather!.busy, S(HAZARD.graceS) + 10);
        expect(s.hazards.weather!.busy).toBe(true);
        // a plank carried by the creek all through it brings no gust
        s.fpActive = true;
        const plank = byName(s, 'plank');
        const z = creekCenterZ(4) + 1.0 + 2.2;
        s.placePlayer(4, z, 0);
        const y = s.players[0].y + EYE_HEIGHT - 0.45;
        s.physics.place(plank.id, pose(4.3, y, z - 1.1, quatFromYawPitchRoll(0, Math.PI / 2, 0)));
        s.physics.grabById(plank.id, { x: 4.3, y, z: z - 1.1 }, 1.2, 0);
        let gustDuringWeather = false;
        runUntil(
            s,
            () => {
                if (s.hazards.gustPhase !== PHASE.idle) gustDuringWeather = true;
                return !s.hazards.weather!.busy;
            },
            S(120),
            () => ({ pitch: -1.05 })
        );
        expect(gustDuringWeather).toBe(false);
        expect(s.hazards.gustCount).toBe(0);
    }, 120_000);

    it('and with the handbrake prank (the same yard, the fog bank over it): each waits for the other and its quiet spell', () => {
        const H = HAZARD.handbrake;
        const mist = {
            ...VALLEY_WEATHER_ZONES[zoneOf(WEATHER.fog)],
            contains: () => true,
            delayS: 0,
            delayJitterS: 0
        };
        const misty = (z: Partial<typeof mist> = {}): LevelDef => ({
            ...timberYardLevel,
            hazards: { ...timberYardLevel.hazards!, weather: { zones: [{ ...mist, ...z }] } }
        });
        /** The ute on the far bank's road where it climbs, nose downhill (the prank tests' spot). */
        const parkOnRoad = (s: LabSim, z = -13.5) => {
            const x = roadCenterX(z);
            s.physics.place(s.vehicle!.id, pose(x, yardHeight(x, z) + 0.3, z, quatFromYawPitchRoll(0, 0, 0)));
        };
        const both = (s: LabSim) => s.hazards.weather!.busy && s.hazards.brakePhase !== PHASE.idle;

        // the weather first: the ute parked on the slope while the fog is down waits for it
        const a = new LabSim({ level: misty() });
        a.fpActive = true;
        runUntil(a, () => a.hazards.weather!.busy, S(HAZARD.graceS) + 10);
        expect(a.hazards.weather!.busy).toBe(true);
        parkOnRoad(a);
        let clear = -1;
        let overlap = false;
        runUntil(
            a,
            () => {
                overlap ||= both(a);
                if (clear < 0 && !a.hazards.weather!.busy) clear = a.tick;
                return a.hazards.brakePhase === PHASE.tell;
            },
            S(mist.tellS + mist.activeS + mist.clearS + HAZARD.safeS + H.parkedS + 10)
        );
        expect(overlap).toBe(false);
        expect(a.hazards.brakePhase).toBe(PHASE.tell);
        expect(a.tick - clear).toBeGreaterThanOrEqual(S(HAZARD.safeS) - 1);

        // the prank first: parked from the start, it goes at the end of the grace period; the fog
        // (due straight away) waits for it and its quiet spell
        const b = new LabSim({ level: misty() });
        b.fpActive = true;
        parkOnRoad(b);
        runUntil(b, () => b.hazards.brakePhase !== PHASE.idle, S(HAZARD.graceS + H.parkedS) + 10);
        expect(b.hazards.brakePhase).toBe(PHASE.tell);
        expect(b.hazards.weather!.busy).toBe(false);
        let over = -1;
        overlap = false;
        runUntil(
            b,
            () => {
                overlap ||= both(b);
                if (over < 0 && b.hazards.brakePhase === PHASE.idle) over = b.tick;
                return b.hazards.weather!.busy;
            },
            S(H.tellS + H.offS + HAZARD.safeS + 10)
        );
        expect(overlap).toBe(false);
        expect(b.hazards.weather!.busy).toBe(true);
        expect(b.tick - over).toBeGreaterThanOrEqual(S(HAZARD.safeS) - 1);
    }, 120_000);
});

describe('weather online: guests get it from the host', () => {
    it('the net state carries the weather’s zone and strength, bounded; an older host’s reads as none', () => {
        const net = {
            waterY: -0.3,
            flood: 0,
            gust: 0,
            gustDir: 0,
            gustSlot: -1,
            brake: 2,
            weatherZone: 2,
            weather: 0.625
        };
        const packed = packHazardNet(net);
        // appended after the handbrake prank's phase (index 5): the weather's zone + 1, its strength
        expect(packed.slice(5)).toEqual([2, 3, 0.625]);
        expect(readHazardNet(packed, CREEK_WATER_Y)).toEqual(net);
        // a host from before the weather (or a level without it): six fields, read as none
        const old = readHazardNet([-0.45, 0, 0, 0, -1, 1], CREEK_WATER_Y);
        expect(old.brake).toBe(1);
        expect(old.weatherZone ?? -1).toBe(-1);
        expect(old.weather ?? 0).toBe(0);
        expect(packHazardNet(old)).toHaveLength(6);
        // and a level without weather sends none
        expect(new LabSim({ level: timberYardLevel }).hazards.net().weatherZone).toBeUndefined();
        // a host from before the prank too: five fields, read as no prank and no weather
        const older = readHazardNet([-0.45, 2, 0, 0.5, 1], CREEK_WATER_Y);
        expect(older).toEqual({ waterY: -0.45, flood: 2, gust: 0, gustDir: 0.5, gustSlot: 1, brake: 0 });
        // out of range: clamped
        const wild = readHazardNet([-0.45, 0, 0, 0, -1, 0, 1e9, -5], CREEK_WATER_Y);
        expect(wild.weatherZone).toBe(63);
        expect(wild.weather).toBe(0);
        expect(readHazardNet([-0.45, 0, 0, 0, -1, 0, -7, 9], CREEK_WATER_Y)).toMatchObject({
            weatherZone: -1,
            weather: 1
        });
    });

    it('the host’s rain reaches the guest: its zone, its strength and the water height', async () => {
        const hub = new MemoryHub();
        const host = valley();
        const road = routeToWorld(20, roadT(20));
        host.placePlayer(road.x, road.z, ROUTE_YAW);
        host.fpActive = true;
        const hs = await HostSession.start(hub.transport('host'), host, 'valley', 'wthr');
        const ad = listGames(hub.channel('lobby', 'watcher'))[0];
        let clock = 0;
        const gs = await GuestSession.join(hub.transport('guest'), valley(), ad, { now: () => clock });
        const run = () => {
            gs.sendInput(cmd(host.tick));
            host.step(cmd(host.tick, { yaw: ROUTE_YAW }), hs.commandFor(1), [hs.commandFor(2), hs.commandFor(3)]);
            hs.afterStep((slot) => host.interactionIds(slot));
            clock += 1000 / 60;
        };
        const rain = zoneOf(WEATHER.rain);
        expect(gs.hazard.weatherZone ?? -1).toBe(-1);
        for (let i = 0; i < S(HAZARD.graceS) + weatherTicks(rain).wait && !host.hazards.weather!.busy; i++) run();
        // well into the rain
        for (let i = 0; i < S(VALLEY_WEATHER_ZONES[rain].tellS + 8); i++) run();
        run();
        run();
        run();
        expect(host.hazards.weather!.zone).toBe(rain);
        expect(gs.hazard.weatherZone).toBe(rain);
        expect(gs.hazard.weather ?? 0).toBeGreaterThan(0.35);
        expect(Math.abs((gs.hazard.weather ?? 0) - host.hazards.weather!.strength)).toBeLessThan(0.05);
        expect(Math.abs(gs.hazard.waterY - host.hazards.waterY)).toBeLessThan(0.002);
        expect(gs.hazard.waterY).toBeGreaterThan(CREEK_WATER_Y + 0.1);
        expect(gs.events.some((e) => e.kind === 'hazard' && e.text.includes('Rain'))).toBe(true);
        gs.leave();
        hs.stop();
    }, 120_000);
    it('a guest’s carry slips in the rain: the host decides their grip as it does everyone’s', async () => {
        const hub = new MemoryHub();
        const host = valley();
        const road = routeToWorld(20, roadT(20));
        host.placePlayer(road.x, road.z, ROUTE_YAW);
        host.fpActive = true;
        const hs = await HostSession.start(hub.transport('host'), host, 'valley', 'wetg');
        const ad = listGames(hub.channel('lobby', 'watcher'))[0];
        let clock = 0;
        const gs = await GuestSession.join(hub.transport('guest'), valley(), ad, { now: () => clock });
        const send = (c: (Partial<PlayerCommand> | undefined)[]) => {
            gs.sendInput(cmd(host.tick, c[1] ?? {}));
            host.step(cmd(host.tick, c[0] ?? { yaw: ROUTE_YAW }), hs.commandFor(1), [
                hs.commandFor(2),
                hs.commandFor(3)
            ]);
            hs.afterStep((slot) => host.interactionIds(slot));
            clock += 1000 / 60;
        };
        expect(host.isSlotActive(1)).toBe(true);
        // the guest waits on the forest road for the rain
        const g0 = routeToWorld(21, roadT(21));
        host.placePlayer(g0.x, g0.z, ROUTE_YAW, 1);
        const rain = zoneOf(WEATHER.rain);
        for (
            let i = 0;
            i < S(HAZARD.graceS) + weatherTicks(rain).wait + S(20) &&
            !(host.hazards.weather!.zone === rain && host.hazards.weather!.strength > 0.99);
            i++
        )
            send([]);
        expect(host.hazards.weather!.strength).toBeGreaterThan(0.99);
        // the guest alone carries the heavy beam up the road
        const r = carryUpTheRoad(host, [1], send);
        expect(host.physics.gripScale[1]).toBeCloseTo(1 - HAZARD.wetGrip, 3);
        expect(r.dropAt).toBeGreaterThan(0);
        expect(host.physics.heldIdOf(1)).toBe(-1);
        gs.leave();
        hs.stop();
    }, 180_000);
});
