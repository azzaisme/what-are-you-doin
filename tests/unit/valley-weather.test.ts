import { beforeAll, describe, expect, it } from 'vitest';

import type { LevelDef } from '../../src/levels/level.ts';
import {
    BRIDGE,
    BRIDGE_X,
    BUCKET_STUMP,
    CREEK_WATER_Y,
    YARD_Y,
    creekCenterZ,
    timberYardLevel
} from '../../src/levels/timber-yard.ts';
import {
    CHECKPOINTS,
    DITCH,
    ROUTE_YAW,
    SUMMIT_U,
    VALLEY_HAZARDS,
    VALLEY_WEATHER_ZONES,
    roadT,
    routeT,
    routeToWorld,
    routeU,
    valleyHeight,
    valleyLayout,
    valleyLevel,
    yardToWorld
} from '../../src/levels/valley.ts';
import { GuestSession, HostSession, listGames } from '../../src/net/session.ts';
import { MemoryHub } from '../../src/net/transport.ts';
import { neutralCommand } from '../../src/sim/commands.ts';
import type { PlayerCommand } from '../../src/sim/commands.ts';
import { HAZARD, PHASE, crossingFrame, packHazardNet, readHazardNet } from '../../src/sim/hazards.ts';
import { EYE_HEIGHT, LabSim } from '../../src/sim/lab-sim.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { W_PHASE, WEATHER, WeatherScheduler, weatherCovers, weatherFog } from '../../src/sim/weather.ts';
import { pose, quatFromYawPitchRoll, quatMul } from '../../src/voxels/math.ts';

beforeAll(() => initPhysics());

const S = (s: number) => Math.round(s * 60);
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
});

describe('weather along the Valley (#88): each comes with its counterplay', () => {
    it('one kind per area, in route order, the fog and mist never closing in nearer than the Low preset’s near world', () => {
        expect(VALLEY_WEATHER_ZONES.map((z) => z.kind)).toEqual([
            WEATHER.rain,
            WEATHER.mist,
            WEATHER.fog,
            WEATHER.snow
        ]);
        const low = valleyLevel.stream!.lowRadius!;
        for (const z of VALLEY_WEATHER_ZONES) {
            // (past the near world's edge the coarse far lattice shows: fog thick there hides its edge)
            expect(z.fogEnd!, z.name).toBeGreaterThan(low);
            const f = weatherFog({ zones: [z] }, 0, 1, { start: 18, end: valleyLevel.stream!.fog.end });
            expect(f.start).toBeLessThan(f.end);
        }
        // no weather over the summit, so the flower stays in sight
        const top = routeToWorld(SUMMIT_U, 0);
        for (const [n, z] of VALLEY_WEATHER_ZONES.entries()) {
            expect(z.contains(top.x, top.z), z.name).toBe(false);
            expect(weatherCovers(VALLEY_HAZARDS.weather, n, top.x, top.z)).toBe(false);
        }
    });

    it('rain on the forest road: the water rises and runs; a beam bridge over the culvert stays put, a plank in the water drifts off', () => {
        const s = valley();
        s.fpActive = true;
        s.step(cmd(0));
        const rain = zoneOf(WEATHER.rain);
        const t = roadT(DITCH.u);
        // the culvert's gap along the road, and its banks
        const fall = valleyLevel.rules!.fallY;
        const hAt = (u: number, tt: number) => valleyHeight(routeToWorld(u, tt).x, routeToWorld(u, tt).z);
        let a = NaN;
        let b = NaN;
        for (let u = DITCH.u - 6; u <= DITCH.u + 6; u += 0.02)
            if (hAt(u, t) < fall) {
                if (Number.isNaN(a)) a = u;
                b = u;
            }
        const rim = Math.max(hAt(a - 0.3, t), hAt(b + 0.3, t));
        const mid = routeToWorld((a + b) / 2, t);
        const beam = byName(s, 'beam-2');
        s.physics.place(beam.id, {
            p: { x: mid.x, y: rim + 0.2, z: mid.z },
            q: quatFromYawPitchRoll(ROUTE_YAW + Math.PI / 2, Math.PI / 2, 0)
        });
        // a plank in the culvert's water, off to the side of the road
        const plank = byName(s, 'extra-plank-5');
        const pIn = routeToWorld((a + b) / 2, t - 3);
        s.physics.place(
            plank.id,
            pose(pIn.x, CREEK_WATER_Y - 0.2, pIn.z, quatFromYawPitchRoll(ROUTE_YAW, Math.PI / 2, 0))
        );
        // a player walks onto the forest road
        const at = routeToWorld(20, roadT(20));
        s.placePlayer(at.x, at.z, ROUTE_YAW);
        runUntil(s, () => s.tick > 120, 200);
        const beamAt = { ...beam.pose.p };
        const plankT = routeT(plank.pose.p.x, plank.pose.p.z);
        const w = weatherTicks(rain);
        runUntil(s, () => s.hazards.weather!.phase === W_PHASE.tell, S(HAZARD.graceS) + w.wait);
        expect(s.hazards.weather!.zone).toBe(rain);
        expect(hazardTexts(s).at(-1)).toContain('Rain');
        let maxY = -Infinity;
        runUntil(
            s,
            () => {
                maxY = Math.max(maxY, s.hazards.waterY);
                return s.hazards.weather!.phase === W_PHASE.idle;
            },
            w.all
        );
        // the water rose and went back down
        expect(maxY).toBeCloseTo(CREEK_WATER_Y + VALLEY_WEATHER_ZONES[rain].riverRise!, 2);
        expect(s.hazards.waterY).toBeCloseTo(CREEK_WATER_Y, 6);
        // the bridge stood well clear of it and never moved
        expect(rim - maxY).toBeGreaterThan(1);
        expect(Math.hypot(beam.pose.p.x - beamAt.x, beam.pose.p.z - beamAt.z)).toBeLessThan(0.05);
        expect(Math.abs(beam.pose.p.y - beamAt.y)).toBeLessThan(0.05);
        // what was lying in the water was carried off downstream (+t)
        expect(routeT(plank.pose.p.x, plank.pose.p.z) - plankT).toBeGreaterThan(2);
        // and it comes once
        expect(s.hazards.weather!.phase).toBe(W_PHASE.idle);
        runUntil(s, () => false, S(30));
        expect(s.hazards.weather!.phase).toBe(W_PHASE.idle);
    }, 180_000);

    it('fog on the mountain road: the road’s edge posts and signs stay close enough to follow, and the view clears after', () => {
        const fog = zoneOf(WEATHER.fog);
        const z = VALLEY_WEATHER_ZONES[fog];
        const markers = valleyLayout(1)
            .pieces.filter((p) => /^(road-post|route-sign|flag-pole)$/.test(p.name))
            .map((p) => ({ u: routeU(p.pose.p.x, p.pose.p.z), t: routeT(p.pose.p.x, p.pose.p.z) }));
        // walking up the road through the fog: the next marker ahead is always well inside the fog's end
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
        expect(worst).toBeLessThan(z.fogEnd! * 0.5);
        // the fog comes, holds and goes: back to the level's own afterwards
        const base = { start: 18, end: valleyLevel.stream!.fog.end };
        const w = new WeatherScheduler(VALLEY_HAZARDS.weather!);
        const inFog = routeToWorld(150, roadT(150));
        const ends: number[] = [];
        for (let tick = 0; tick < S(200); tick++) {
            w.step({ tick, hz: 60, players: [inFog], canStart: true, rand: () => 0.5 });
            const k = weatherCovers(VALLEY_HAZARDS.weather, w.zone, inFog.x, inFog.z) ? w.strength : 0;
            ends.push(weatherFog(VALLEY_HAZARDS.weather, w.zone, k, base).end);
        }
        expect(Math.min(...ends)).toBeCloseTo(z.fogEnd!, 3);
        expect(ends[ends.length - 1]).toBe(base.end);
        expect(w.phase).toBe(W_PHASE.idle);
        expect(weatherFog(VALLEY_HAZARDS.weather, w.zone, w.strength, base)).toEqual(base);
    });

    /** Where player `slot` waits at the crevasse (side by side across the road, facing up it). */
    const SNOW_U = 167.2;
    const snowSpot = (slot: number) => routeToWorld(SNOW_U, roadT(SNOW_U) - 0.65 + slot * 1.3);

    /**
     * Player 1 at the crevasse in the snow holding a plank in front of them at chest height, across
     * their front (along t, the way the squall blows; the yard's gust test turned onto the route).
     */
    function carryInSnow(s: LabSim): number {
        const plank = byName(s, 'extra-plank-9');
        const at = snowSpot(0);
        s.placePlayer(at.x, at.z, ROUTE_YAW, 0);
        const y = s.players[0].y + EYE_HEIGHT - 0.45;
        const c = routeToWorld(SNOW_U + 1.1, roadT(SNOW_U) - 0.35);
        s.physics.place(plank.id, pose(c.x, y, c.z, quatFromYawPitchRoll(ROUTE_YAW, Math.PI / 2, 0)));
        s.physics.grabById(plank.id, { x: c.x, y, z: c.z }, 1.2, 0);
        return plank.id;
    }

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
            () => ({
                yaw: ROUTE_YAW
            })
        );
        expect(s.hazards.weather!.zone).toBe(snow);
        expect(hazardTexts(s).at(-1)).toContain('Snow');
    }

    function runSnow(s: LabSim, c: Partial<PlayerCommand>, c2?: Partial<PlayerCommand>): void {
        const z = VALLEY_WEATHER_ZONES[zoneOf(WEATHER.snow)];
        for (let i = 0; i < S(z.tellS + z.activeS * 0.5); i++) {
            s.step(cmd(s.tick, { yaw: ROUTE_YAW, ...c }), c2 ? cmd(s.tick, { yaw: ROUTE_YAW, ...c2 }) : undefined);
        }
    }

    it('the snow squall at the crevasse: a plank carried high in one pair of hands is torn away across the road', () => {
        const s = valley();
        s.fpActive = true;
        untilSnow(s);
        const id = carryInSnow(s);
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
        const id = carryInSnow(s);
        runSnow(s, { pitch: -1.05 });
        expect(s.physics.heldIdOf(0)).toBe(id);
        expect(s.hazards.lastWindForce).toBeLessThan(650);
    }, 120_000);

    it('counterplay: carried together, two grips hold it through the squall', () => {
        const s = valley();
        s.fpActive = true;
        s.setSlotActive(1, true);
        untilSnow(s, 2);
        const id = carryInSnow(s);
        // the second player takes the other end (0.8 m along it, the way they stand)
        const t = s.physics.bodies.get(id)!.body.translation();
        const b = snowSpot(1);
        s.placePlayer(b.x, b.z, ROUTE_YAW, 1);
        const along = { x: Math.SQRT1_2 * 0.8, z: Math.SQRT1_2 * 0.8 };
        s.physics.grabById(id, { x: t.x + along.x, y: t.y, z: t.z + along.z }, 1.2, 1);
        expect(s.physics.holders(id)).toBe(2);
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
});

describe('weather online: guests get it from the host', () => {
    it('the net state carries the weather’s zone and strength, bounded; an older host’s reads as none', () => {
        const net = { waterY: -0.3, flood: 0, gust: 0, gustDir: 0, gustSlot: -1, weatherZone: 2, weather: 0.625 };
        expect(readHazardNet(packHazardNet(net), CREEK_WATER_Y)).toEqual(net);
        // a host from before the weather (or a level without it): five fields, read as none
        const old = readHazardNet([-0.45, 0, 0, 0, -1], CREEK_WATER_Y);
        expect(old.weatherZone ?? -1).toBe(-1);
        expect(old.weather ?? 0).toBe(0);
        expect(packHazardNet(old)).toHaveLength(5);
        // and a level without weather sends none
        expect(new LabSim({ level: timberYardLevel }).hazards.net().weatherZone).toBeUndefined();
        const wild = readHazardNet([-0.45, 0, 0, 0, -1, 1e9, -5], CREEK_WATER_Y);
        expect(wild.weatherZone).toBeLessThan(64);
        expect(wild.weather).toBe(0);
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
});
