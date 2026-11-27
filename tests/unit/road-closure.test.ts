import type { Collider } from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';

import { UTE_TRACK_HALF } from '../../src/assets/ute.ts';
import { BRIDGE, BRIDGE_X, YARD_Y } from '../../src/levels/timber-yard.ts';
import {
    CLOSURE_AT,
    closurePostSpots,
    ROUTE_YAW,
    SIDE_PATHS,
    VALLEY_ROAD_CLOSURE as R,
    roadT,
    routeT,
    routeToWorld,
    routeU,
    valleyHeight,
    valleyLevel,
    yardToWorld
} from '../../src/levels/valley.ts';
import { GuestSession, HostSession, listGames } from '../../src/net/session.ts';
import { MemoryHub } from '../../src/net/transport.ts';
import { neutralCommand } from '../../src/sim/commands.ts';
import type { PlayerCommand } from '../../src/sim/commands.ts';
import {
    CLOSURE,
    CLOSURE_OPEN,
    CLOSURE_SHUT,
    CLOSURE_TELL,
    RoadClosure,
    SIGN_SWING,
    quickest
} from '../../src/sim/hazard-road.ts';
import { HAZARD } from '../../src/sim/hazards.ts';
import { EYE_HEIGHT, LabSim } from '../../src/sim/lab-sim.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { ANIM_MAX } from '../../src/sim/snapshots.ts';
import { WEATHER } from '../../src/sim/weather.ts';
import { pose, quatFromYawPitchRoll, quatMul, quatRotate } from '../../src/voxels/math.ts';

beforeAll(() => initPhysics());

const S = (s: number) => Math.round(s * 60);
const texts = (s: LabSim) => s.events.filter((e) => e.kind === 'hazard').map((e) => e.text);
const yawOf = (q: { x: number; y: number; z: number; w: number }) =>
    Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
const at = (u: number, t: number) => routeToWorld(u, t);
const roadAt = (u: number) => at(u, roadT(u));

/**
 * The Valley with only the closure among its hazards (its flood and weather share the director's
 * budget: crossing the creek on the test's beams finishes the bridge and brings the flood first;
 * that interplay has its own test below, on the full Valley).
 */
const CLOSURE_ONLY = { ...valleyLevel, hazards: { seed: 1, roadClosure: R } };

/** The Valley past its quiet start, player 0 on foot. */
function valley(level = CLOSURE_ONLY): LabSim {
    const s = new LabSim({ level });
    s.runTo(S(HAZARD.graceS) + 10);
    s.fpActive = true;
    s.runTo(s.tick + 2);
    return s;
}

/** Two beams across Shallow Creek where the road crosses it (the yard's bridge, turned with it). */
function bridge(s: LabSim): void {
    const flatAlongZ = quatMul(quatFromYawPitchRoll(Math.PI / 2, 0, 0), quatFromYawPitchRoll(0, Math.PI / 2, 0));
    const q = quatMul(quatFromYawPitchRoll(ROUTE_YAW, 0, 0), flatAlongZ);
    ['beam-0', 'beam-1'].forEach((n, i) => {
        const w = yardToWorld(BRIDGE_X - 0.105 + i * 0.21, BRIDGE.zc);
        s.physics.place(s.entities.find((e) => e.name === n)!.id, pose(w.x, YARD_Y + 0.12, w.z, q));
    });
}

/**
 * A bridge for the ute over Shallow Creek where the road crosses it: two beams under its wheel
 * tracks, nailed down at both ends (as ute.test.ts builds it in the Timber Yard, turned with it).
 */
function uteBridge(s: LabSim): void {
    const flatAlongZ = quatMul(quatFromYawPitchRoll(Math.PI / 2, 0, 0), quatFromYawPitchRoll(0, Math.PI / 2, 0));
    const q = quatMul(quatFromYawPitchRoll(ROUTE_YAW, 0, 0), flatAlongZ);
    const beams = ['beam-0', 'beam-1'].map((n) => s.entities.find((e) => e.name === n)!);
    const lineX = (i: number) => BRIDGE_X + (i === 0 ? -1 : 1) * UTE_TRACK_HALF;
    beams.forEach((b, i) => {
        const w = yardToWorld(lineX(i), BRIDGE.zc);
        s.physics.place(b.id, pose(w.x, YARD_Y + 0.3, w.z, q));
    });
    inputs(s).step({}, 60);
    beams.forEach((b, i) => {
        for (const end of [-1, 1]) {
            // a hammer blow through each beam end into its capstone, from 0.9 m above, 0.3 m back
            const z = BRIDGE.zc + end * (BRIDGE.gap / 2 + 0.13);
            const a = yardToWorld(lineX(i), z);
            const e = yardToWorld(lineX(i), z + 0.3);
            const target = { x: a.x, y: b.pose.p.y + 0.12, z: a.z };
            const eye = { x: e.x, y: target.y + 0.9, z: e.z };
            const yaw = Math.atan2(-(target.x - eye.x), -(target.z - eye.z));
            const pitch = Math.atan2(target.y - eye.y, Math.hypot(target.x - eye.x, target.z - eye.z));
            expect(s.joints.nail(eye, yaw, pitch, 0, s.tick).refusal).toBe('none');
        }
    });
}

/** Player inputs: look, walk (facing the way it goes), get in the ute, drive. */
function inputs(s: LabSim, slot = 0) {
    const v = { yaw: 0, pitch: 0 };
    const step = (c: Partial<PlayerCommand> = {}, k = 1, other?: Partial<PlayerCommand>) => {
        for (let i = 0; i < k; i++) {
            const mine = { ...neutralCommand(s.tick), yaw: v.yaw, pitch: v.pitch, ...c };
            if (slot === 0) s.step(mine, other ? { ...neutralCommand(s.tick), ...other } : undefined);
            else s.step({ ...neutralCommand(s.tick), ...other }, mine);
        }
    };
    const me = () => s.players[slot];
    /** Walks (or runs) to (x, z), facing the way it goes, the stick pushed `stick` of the way; calls `each` every tick. */
    const walkTo = (x: number, z: number, sprint = false, each?: () => void, near = 0.3, stick = 1) => {
        for (let i = 0; i < 60 * 120; i++) {
            const dx = x - me().x;
            const dz = z - me().z;
            if (Math.hypot(dx, dz) < near) return;
            v.yaw = Math.atan2(-dx, -dz);
            v.pitch = 0;
            step({ moveZ: stick, sprint });
            each?.();
        }
        throw new Error(`could not walk to ${x.toFixed(1)}, ${z.toFixed(1)}`);
    };
    /** Looks at a point. */
    const look = (x: number, y: number, z: number) => {
        const dx = me().x - x;
        const dz = me().z - z;
        v.yaw = Math.atan2(dx, dz);
        v.pitch = -Math.atan2(me().y + EYE_HEIGHT - y, Math.hypot(dx, dz));
    };
    return { v, step, walkTo, look, me };
}

/** From the yard side, over the beams and up the road towards the junction, by input. */
function walkUpTheRoad(s: LabSim, sprint: boolean, until: number) {
    const p = inputs(s);
    const start = at(-5, 0);
    s.placePlayer(start.x, start.z, 0);
    p.step({}, 20);
    let tell = -1;
    let junction = -1;
    let tellU = NaN;
    const watch = () => {
        const u = routeU(s.player.x, s.player.z);
        if (tell < 0 && texts(s).includes(CLOSURE_TELL)) {
            tell = s.tick;
            tellU = u;
        }
        if (junction < 0 && u >= CLOSURE_AT.junction) junction = s.tick;
    };
    for (const u of [-2, 0, 2.5]) {
        const w = at(u, 0);
        p.walkTo(w.x, w.z, sprint, watch);
    }
    for (let u = 4; u <= until; u += 2) {
        const w = roadAt(u);
        p.walkTo(w.x, w.z, sprint, watch);
    }
    return { p, tell, junction, tellU };
}

/** The closure brought on: player 0 crosses the creek on the beams, in the tell's window. */
function closed(level = CLOSURE_ONLY): LabSim {
    const s = valley(level);
    bridge(s);
    const p = inputs(s);
    const start = at(-5, 0);
    s.placePlayer(start.x, start.z, 0);
    p.step({}, 20);
    for (const u of [-2, 0, 2.5]) {
        const w = at(u, 0);
        p.walkTo(w.x, w.z);
    }
    expect(texts(s)).toContain(CLOSURE_TELL);
    return s;
}

/** A point beside the barrier (local x along it, z out from its face), at its ground. */
function byBarrier(s: LabSim, lx: number, lz: number): { x: number; z: number } {
    const b = s.closure.barrier.pose;
    const c = quatRotate(b.q, lx, 0, lz, { x: 0, y: 0, z: 0 });
    return { x: b.p.x + c.x, z: b.p.z + c.z };
}

/**
 * Player `slot` comes to the barrier at local x = lx (from its -u face) and takes hold of it, by
 * input: walking there (`walk`, the default for player 1), or set down beside it (setup); the look
 * and the grab are commands either way.
 */
function takeHold(s: LabSim, slot: number, lx: number, walk = slot === 0) {
    const p = inputs(s, slot);
    const stand = byBarrier(s, lx, 1.3);
    // walk round in front of it (the -u side) if need be, then up to it
    if (walk) p.walkTo(stand.x, stand.z);
    else s.placePlayer(stand.x, stand.z, 0, slot);
    p.step({}, 10);
    const grip = byBarrier(s, lx, 0);
    p.look(grip.x, s.closure.barrier.pose.p.y + 0.3, grip.z);
    p.step({}, 3);
    p.step({ grab: true });
    p.step({}, 2);
    return p;
}

/**
 * Drags what player `slot` holds (the barrier) to (x, z) as a player pulls something heavy: facing
 * it, looking down at it, stepping backwards and sideways towards (x, z), by input. `each` runs
 * every tick.
 */
function dragTo(s: LabSim, p: ReturnType<typeof inputs>, x: number, z: number, each?: () => void, near = 0.3): void {
    for (let i = 0; i < 60 * 30; i++) {
        const me = p.me();
        const dx = x - me.x;
        const dz = z - me.z;
        const l = Math.hypot(dx, dz);
        if (l < near) return;
        const b = s.closure.barrier.pose.p;
        p.v.yaw = Math.atan2(me.x - b.x, me.z - b.z);
        p.v.pitch = -0.5;
        // the way to go in the view's frame (forward is (-sin yaw, -cos yaw))
        const fx = -Math.sin(p.v.yaw);
        const fz = -Math.cos(p.v.yaw);
        p.step({ moveZ: (dx * fx + dz * fz) / l, moveX: (dx * -fz + dz * fx) / l });
        each?.();
    }
    throw new Error(`could not drag it to ${x.toFixed(1)}, ${z.toFixed(1)}`);
}

/** The ute put on the road at u, facing up it, with player 0 in the driver's seat. */
function inTheUte(s: LabSim, u: number, speed = 0, from?: [number, number], towards?: [number, number]) {
    const p = inputs(s);
    const a = from ? at(from[0], from[1]) : roadAt(u);
    const b = towards ? at(towards[0], towards[1]) : roadAt(u + 1);
    const yaw = Math.atan2(b.x - a.x, b.z - a.z);
    s.physics.place(s.ute.id, pose(a.x, valleyHeight(a.x, a.z) + 0.3, a.z, quatFromYawPitchRoll(yaw, 0, 0)));
    p.step({}, 40);
    const u0 = s.ute.pose.p;
    const sx = -Math.cos(yaw);
    const sz = Math.sin(yaw);
    s.placePlayer(u0.x + sx * 2.2, u0.z + sz * 2.2, 0);
    p.step({}, 20);
    p.v.yaw = Math.atan2(sx, sz);
    p.v.pitch = -Math.atan2(s.player.y + EYE_HEIGHT - (u0.y + 0.6), 1.4);
    p.step({}, 5);
    p.step({ grab: true });
    expect(s.driver).toBe(0);
    if (speed > 0) {
        // already going (a run-up the test cannot give it on this stretch)
        const q = s.ute.pose.q;
        const fwd = { x: Math.sin(yawOf(q)), z: Math.cos(yawOf(q)) };
        s.physics.place(
            s.ute.id,
            { p: { ...s.ute.pose.p }, q: { ...q } },
            { x: fwd.x * speed, y: 0, z: fwd.z * speed }
        );
    }
    /** Drives (full throttle unless given) through the route points, `each` every tick. */
    const drive = (points: [number, number][], throttle = 1, each?: () => boolean | void, near = 1.6) => {
        for (const [pu, pt] of points) {
            const w = at(pu, pt);
            for (let i = 0; i < 60 * 40; i++) {
                const q = s.ute.pose.q;
                const pp = s.ute.pose.p;
                if (Math.hypot(w.x - pp.x, w.z - pp.z) < near) break;
                const e = Math.atan2(w.x - pp.x, w.z - pp.z) - yawOf(q);
                const err = Math.atan2(Math.sin(e), Math.cos(e));
                p.step({ moveZ: throttle, moveX: Math.max(-1, Math.min(1, -2.5 * err)) });
                if (each?.()) return;
            }
        }
    };
    return { p, drive };
}

const roadPoints = (u0: number, u1: number, du = 3): [number, number][] => {
    const out: [number, number][] = [];
    for (let u = u0; u <= u1; u += du) out.push([u, roadT(u)]);
    return out;
};

/** The logging track's line across the fence (t from the road's centre at the fence). */
function trackAtFence(): { at: number; half: number } {
    const track = SIDE_PATHS.find((q) => q.name === 'logging-track')!;
    const tp = track.points;
    const j = tp.findIndex((q) => q[0] > CLOSURE_AT.barrierU);
    const f = (CLOSURE_AT.barrierU - tp[j - 1][0]) / (tp[j][0] - tp[j - 1][0]);
    return { at: tp[j - 1][1] + f * (tp[j][1] - tp[j - 1][1]) - roadT(CLOSURE_AT.barrierU), half: track.halfWidth };
}

/**
 * Drives the ute (player 0 in it) at the fence line by input: set down 3 m short of it, at `off`
 * (+ `k` across) from the road's centre on `side`, and driven flat out for 5 s through the line at
 * `off`. Returns how far up the route it got, or NaN when there is no room to set it down there
 * (in a pine's branches: set down inside them, it is thrown out).
 */
function fenceRun(s: LabSim, p: ReturnType<typeof inputs>, side: number, off: number, k: number): number {
    const u0 = CLOSURE_AT.barrierU - 3;
    const ta = roadT(u0) + side * (off + k);
    const tg = roadT(CLOSURE_AT.barrierU) + side * off;
    const lineT = (u: number) => ta + ((tg - ta) * (u - u0)) / 3;
    const a = at(u0, ta);
    const b = at(u0 + 1, lineT(u0 + 1));
    s.physics.place(
        s.ute.id,
        pose(a.x, valleyHeight(a.x, a.z) + 0.4, a.z, quatFromYawPitchRoll(Math.atan2(b.x - a.x, b.z - a.z), 0, 0))
    );
    p.step({}, 30);
    const set = s.ute.pose.p;
    if (Math.hypot(set.x - a.x, set.z - a.z) > 0.3) return NaN;
    let furthest = -99;
    for (let i = 0; i < S(5); i++) {
        const pp = s.ute.pose.p;
        const u = routeU(pp.x, pp.z);
        const c = at(u + 3, lineT(u + 3));
        const e = Math.atan2(c.x - pp.x, c.z - pp.z) - yawOf(s.ute.pose.q);
        const err = Math.atan2(Math.sin(e), Math.cos(e));
        p.step({ moveZ: 1, moveX: Math.max(-1, Math.min(1, -2.5 * err)) });
        furthest = Math.max(furthest, routeU(s.ute.pose.p.x, s.ute.pose.p.z));
    }
    return furthest;
}

/**
 * The whole fence line, both sides, from the barrier's ends out past where the ute can climb to (23 m
 * out: the test below): straight at it every 0.2 m, and at an angle (1.5 m across over the last
 * 3 m, both ways) every 0.4 m. Through
 * (past the line) anywhere but the logging track is listed in `through`.
 */
function scanFence(s: LabSim, p: ReturnType<typeof inputs>, sides = [-1, 1], from = 3, to = 24.6) {
    const tr = trackAtFence();
    const through: string[] = [];
    let furthest = -99;
    let track = -99;
    let runs = 0;
    let blocked = 0;
    for (const side of sides)
        for (let i = 0; from + i * 0.2 <= to + 1e-6; i++) {
            const off = from + i * 0.2;
            for (const k of i % 2 === 0 ? [0, -1.5, 1.5] : [0]) {
                const got = fenceRun(s, p, side, off, k);
                if (Number.isNaN(got)) {
                    blocked++;
                    continue;
                }
                runs++;
                if (side > 0 && Math.abs(off - tr.at) < tr.half + 1.2) track = Math.max(track, got);
                else {
                    furthest = Math.max(furthest, got);
                    if (got >= CLOSURE_AT.barrierU)
                        through.push(`${side < 0 ? 'left' : 'right'} ${off.toFixed(1)} m out (${k})`);
                }
            }
        }
    return { through, furthest, track, runs, blocked };
}

describe('the road closure (#77): the sign swaps and a barrier closes the forest road', () => {
    it('the tell lands at least 2.5 s before the junction, at a run and at a walk; the sign swings over, the barrier stands across the road', () => {
        for (const sprint of [true, false]) {
            const s = valley();
            bridge(s);
            const r = walkUpTheRoad(s, sprint, 12);
            expect(r.tell, sprint ? 'run' : 'walk').toBeGreaterThan(0);
            expect(r.junction).toBeGreaterThan(r.tell);
            const lead = (r.junction - r.tell) / 60;
            expect(lead, `${sprint ? 'run' : 'walk'}: ${lead.toFixed(2)} s`).toBeGreaterThanOrEqual(2.5);
            if (sprint) expect(lead).toBeLessThan(3.2);
            // where it came: on the bridge, a run's 2.5 s (and the window) from the junction
            expect(CLOSURE_AT.junction - r.tellU).toBeGreaterThanOrEqual(CLOSURE.leadS * CLOSURE.runSpeed - 0.2);
            expect(s.hazards.road!.count).toBe(1);
            // the barrier stands across the road at u = 22; the sign shows the closed face
            const b = s.closure.barrier.pose.p;
            expect(s.closure.barrier.visible).toBe(true);
            expect(Math.abs(routeU(b.x, b.z) - CLOSURE_AT.barrierU)).toBeLessThan(0.1);
            expect(Math.abs(routeT(b.x, b.z) - roadT(CLOSURE_AT.barrierU))).toBeLessThan(0.1);
            expect(s.closure.sign.anim[SIGN_SWING]).toBe(1);
            expect(s.hazards.road!.pinned).toBe(true);
        }
    }, 300_000);

    it('the ute on the real layout: driven by input from the yard over the creek (a nailed beam bridge) and up the road, the tell lands at least 2.5 s before the junction', () => {
        for (const back of [-12, -16]) {
            const s = valley();
            uteBridge(s);
            // in the ute on the yard's side, lined up with the crossing, facing it
            const d = inTheUte(s, 0, 0, [back, 0], [back + 1, 0]);
            void d;
            const p = inputs(s);
            let tell = -1;
            let tellSpeed = 0;
            let junction = -1;
            let fastest = 0;
            // its acceleration along the road (how fast it closes on the junction, over 0.25 s,
            // as the trigger reckons it): the trigger assumes more than it ever makes
            const alongs: number[] = [];
            let hardest = 0;
            // once told, it holds until the ute is past (the driver alone brought it on)
            let heldAfterTell = true;
            // flat out: over the beams on the crossing's line, then up the road (round the
            // checkpoint flag in the middle of it at u = 7.2), to the junction
            for (let k = 0; k < S(30) && junction < 0; k++) {
                const pp = s.ute.pose.p;
                const u = routeU(pp.x, pp.z);
                const c = u < 1.5 ? at(u + 3, 0) : u < 9 ? at(u + 5, roadT(u + 5) + 1.5) : roadAt(u + 4);
                const e = Math.atan2(c.x - pp.x, c.z - pp.z) - yawOf(s.ute.pose.q);
                const err = Math.atan2(Math.sin(e), Math.cos(e));
                p.step({ moveZ: 1, moveX: Math.max(-1, Math.min(1, -2.5 * err)) });
                const v = Math.abs(s.vehicle!.speed());
                fastest = Math.max(fastest, v);
                alongs.push(routeU(s.ute.pose.p.x, s.ute.pose.p.z));
                const n = alongs.length;
                if (n > 30) {
                    const now = (alongs[n - 1] - alongs[n - 16]) / 0.25;
                    const then = (alongs[n - 16] - alongs[n - 31]) / 0.25;
                    hardest = Math.max(hardest, (now - then) / 0.25);
                }
                if (tell < 0 && texts(s).includes(CLOSURE_TELL)) {
                    tell = s.tick;
                    tellSpeed = v;
                }
                if (tell > 0 && !s.hazards.road!.busy) heldAfterTell = false;
                if (routeU(s.ute.pose.p.x, s.ute.pose.p.z) >= CLOSURE_AT.junction) junction = s.tick;
            }
            expect(tell, `from u ${back}`).toBeGreaterThan(0);
            expect(junction, `from u ${back}: reached the junction`).toBeGreaterThan(tell);
            const lead = (junction - tell) / 60;
            console.log(
                `the ute from u ${back}: the tell at ${tellSpeed.toFixed(2)} m/s, ${lead.toFixed(2)} s before the junction (fastest ${fastest.toFixed(1)} m/s, hardest acceleration ${hardest.toFixed(2)} m/s²)`
            );
            // measured 3.6-3.7: under 4, and the trigger assumes more (5)
            expect(hardest, 'its peak acceleration along the road').toBeLessThan(4);
            expect(CLOSURE.uteAccel).toBeGreaterThan(4.6);
            expect(lead, `from u ${back}: lead ${lead.toFixed(2)} s`).toBeGreaterThanOrEqual(2.5);
            expect(s.hazards.road!.count).toBe(1);
            // the closure the driver brought on holds while they drive at it, and says so once:
            // the ute still behind the closed stretch at the tell doesn't end it there and then
            expect(heldAfterTell, `from u ${back}: still on after the tell`).toBe(true);
            expect(texts(s).filter((t) => t === CLOSURE_TELL || t === CLOSURE_SHUT)).toEqual([CLOSURE_TELL]);
        }
        // the trigger's own bound: from a standstill the ute could not get there faster than this
        expect(quickest(25, 0)).toBeGreaterThan(CLOSURE.leadS);
        expect(quickest(25, 10)).toBeCloseTo(CLOSURE.leadS, 5);
    }, 300_000);

    it('extra (not the real layout, set speed): the ute set going at 10 m/s, its top speed, on a junction moved up the forest road; the tell still lands at least 2.5 s before it', () => {
        // the Valley's road has no straight run-up to the junction at u = 11 (the ute crosses the
        // creek just before it, and from the yard reaches about 7.8 m/s by input: the test above),
        // so this puts the same closure's junction up the forest road beyond the culvert and SETS
        // the ute going at its top speed (inTheUte's speed: not reached by input), then drives it
        // on by input at full throttle
        const level = {
            ...valleyLevel,
            hazards: { seed: 1, roadClosure: { ...R, junction: 80, rejoin: 84, from: 41 } }
        };
        const s = valley(level);
        const d = inTheUte(s, 44, 10);
        let tell = -1;
        let tellSpeed = 0;
        let junction = -1;
        d.drive(roadPoints(47, 83.5), 1, () => {
            const u = routeU(s.ute.pose.p.x, s.ute.pose.p.z);
            if (tell < 0 && texts(s).includes(CLOSURE_TELL)) {
                tell = s.tick;
                tellSpeed = Math.abs(s.vehicle!.speed());
            }
            if (junction < 0 && u >= 80) junction = s.tick;
            return junction > 0;
        });
        const up = s.ute.pose.p;
        expect(tell).toBeGreaterThan(0);
        expect(
            junction,
            `ute at u ${routeU(up.x, up.z).toFixed(1)} t ${(routeT(up.x, up.z) - roadT(routeU(up.x, up.z))).toFixed(1)} y ${up.y.toFixed(2)} speed ${s.vehicle!.speed().toFixed(1)} tick ${s.tick}`
        ).toBeGreaterThan(tell);
        expect(tellSpeed, 'at the tell, near top speed').toBeGreaterThan(8.5);
        const lead = (junction - tell) / 60;
        expect(lead, `lead ${lead.toFixed(2)} s`).toBeGreaterThanOrEqual(2.5);
    }, 300_000);

    it('counterplay: walk the old logging track; the closure ends when everyone is past, and the sign stays closed (the barrier still stands)', () => {
        const s = closed();
        const p = inputs(s);
        const track = SIDE_PATHS.find((q) => q.name === 'logging-track')!;
        for (const u of [4, 7, 10]) {
            const w = roadAt(u);
            p.walkTo(w.x, w.z);
        }
        expect(s.hazards.road!.busy).toBe(true);
        for (const [u, t] of track.points) {
            const w = at(u, t);
            p.walkTo(w.x, w.z, false, undefined, 0.6);
        }
        const beyond = roadAt(CLOSURE_AT.rejoin + 1.5);
        p.walkTo(beyond.x, beyond.z);
        p.step({}, 5);
        expect(s.hazards.road!.busy).toBe(false);
        // from the tell to the road beyond by the track, at a walk: well inside CLOSURE.stopS
        const walked = (s.hazards.outcomes[0].tick - s.events.find((e) => e.text === CLOSURE_TELL)!.tick) / 60;
        console.log(`the track on foot, from the tell: ${walked.toFixed(1)} s`);
        expect(walked).toBeLessThan(CLOSURE.stopS / 2);
        // the barrier is still there, so the sign still says so
        expect(s.hazards.road!.blocking(s.physics, s.closure.barrier.id)).toBe(true);
        expect(s.closure.sign.anim[SIGN_SWING]).toBe(1);
        expect(texts(s)).not.toContain(CLOSURE_OPEN);
        expect(s.hazards.busy).toBe(false);
        // the playtest log's account (#70)
        expect(s.hazards.outcomes.map((o) => `${o.hazard}: ${o.what}`)).toEqual([
            'road closure: took the track on foot'
        ]);
    }, 300_000);

    it('counterplay: drive the ute round the logging track', () => {
        const s = closed();
        const track = SIDE_PATHS.find((q) => q.name === 'logging-track')!;
        // in the ute at the track's mouth (as Epic 9's own loop test puts it), facing along it
        const d = inTheUte(s, 0, 0, track.points[0], track.points[1]);
        d.drive([...track.points.slice(1), [CLOSURE_AT.rejoin + 3, roadT(CLOSURE_AT.rejoin + 3)]], 0.35);
        expect(routeU(s.ute.pose.p.x, s.ute.pose.p.z)).toBeGreaterThan(CLOSURE_AT.rejoin);
        inputs(s).step({}, 5);
        expect(s.hazards.road!.busy).toBe(false);
        expect(s.closure.sign.anim[SIGN_SWING]).toBe(1);
        expect(s.hazards.outcomes.map((o) => o.what)).toEqual(['drove the ute round the track']);
    }, 300_000);

    it('counterplay on foot: a beaver squeezes round either end of the barrier (or between the old fence posts); with the ute left in the yard that ends it, and the sign stays closed', () => {
        const ways: [string, number][] = [
            ['round the left end (between it and the fence line)', -3.5],
            ['round the right end (between it and the log dump)', 3.3],
            ['between two fence posts', -8.1]
        ];
        for (const [how, off] of ways) {
            const s = closed();
            const p = inputs(s);
            for (const [u, t] of [
                [16, 0],
                [20, off],
                [24, off],
                [28, 0],
                [CLOSURE_AT.rejoin + 1.5, 0]
            ] as [number, number][]) {
                const w = at(u, roadT(u) + t);
                p.walkTo(w.x, w.z, false, undefined, 0.5);
            }
            expect(routeU(s.player.x, s.player.z), how).toBeGreaterThan(CLOSURE_AT.rejoin);
            p.step({}, 5);
            expect(s.hazards.road!.busy, how).toBe(false);
            expect(s.hazards.road!.blocking(s.physics, s.closure.barrier.id)).toBe(true);
            expect(s.closure.sign.anim[SIGN_SWING]).toBe(1);
            expect(
                s.hazards.outcomes.map((o) => o.what),
                how
            ).toEqual(['squeezed past on foot']);
        }
    }, 300_000);

    it('the ute cannot get round either end: driven round each end from the road, by input, it stops short', () => {
        // round each end from the road, by input
        for (const side of [-1, 1]) {
            const s = closed();
            const d = inTheUte(s, 15);
            let furthest = -99;
            let k = 0;
            d.drive(
                [
                    [18, roadT(18)],
                    [20, roadT(20) + side * 4.5],
                    [24, roadT(24) + side * 4.5],
                    [27, roadT(27)]
                ],
                0.5,
                () => {
                    furthest = Math.max(furthest, routeU(s.ute.pose.p.x, s.ute.pose.p.z));
                    return ++k > S(25);
                }
            );
            expect(furthest, `round the ${side < 0 ? 'left' : 'right'} end`).toBeLessThan(CLOSURE_AT.barrierU - 1);
        }
    }, 600_000);

    it('the fence line holds the ute everywhere but the logging track: driven at it by input every 0.2 m, straight and at an angle', () => {
        const s = closed();
        inTheUte(s, 12);
        const p = inputs(s);
        const r = scanFence(s, p);
        console.log(
            `the fence line: ${r.runs} drives (${r.blocked} starts in a pine's branches), the furthest off the track u ${r.furthest.toFixed(2)} (the line at ${CLOSURE_AT.barrierU})`
        );
        for (const miss of r.through) expect.fail(`the ute got through: ${miss}`);
        expect(r.track, 'along the logging track').toBeGreaterThan(30);
        expect(r.furthest).toBeLessThan(CLOSURE_AT.barrierU);
    }, 600_000);

    it('every fence post counts: take any one out and the ute gets through there (driven at the line by input)', () => {
        const spots = closurePostSpots();
        expect(spots).toHaveLength(15);
        for (const post of spots) {
            const s = closed();
            inTheUte(s, 12);
            // take this post out of the world (its collider: the rail has none)
            const w = at(CLOSURE_AT.barrierU, roadT(CLOSURE_AT.barrierU) + post.side * post.a);
            const gone: Collider[] = [];
            s.physics.world.colliders.forEach((c) => {
                const tr = c.translation();
                if (c.parent() === null && Math.hypot(tr.x - w.x, tr.z - w.z) < 0.05) gone.push(c);
            });
            expect(gone, `the post ${(post.side * post.a).toFixed(2)} m out`).toHaveLength(1);
            s.physics.world.removeCollider(gone[0], false);
            // the same scan as above (on the same 0.2 m and 0.4 m steps), round where it stood
            const from = Math.max(3, 3 + Math.floor((post.a - 2.6 - 3) / 0.4) * 0.4);
            const r = scanFence(s, inputs(s), [post.side], from, post.a + 2.6);
            expect(r.through.length, `without the post ${(post.side * post.a).toFixed(2)} m out`).toBeGreaterThan(0);
        }
    }, 900_000);

    it('the valley sides: the ute can climb them, a long way round; measured against the logging track by input', () => {
        // the logging track, at the careful pace the ute keeps on it: from its mouth to the road beyond
        const t0 = closed();
        const track = SIDE_PATHS.find((q) => q.name === 'logging-track')!;
        const d = inTheUte(t0, 0, 0, track.points[0], track.points[1]);
        const from = t0.tick;
        d.drive([...track.points.slice(1), [CLOSURE_AT.rejoin + 3, roadT(CLOSURE_AT.rejoin + 3)]], 0.35);
        expect(routeU(t0.ute.pose.p.x, t0.ute.pose.p.z)).toBeGreaterThan(CLOSURE_AT.rejoin);
        const trackS = (t0.tick - from) / 60;

        // up the sides: set down on the floor 10.5 m out before the line, driven flat out up the
        // side (straight out, and a little up or down the route) for 20 s, then along the side, up
        // the route past the line, for 20 s
        const s = closed();
        inTheUte(s, 12);
        const p = inputs(s);
        let highest = 0;
        let highestS = 0;
        let drives = 0;
        const round: number[] = [];
        for (const side of [-1, 1])
            for (const u0 of [14, 16, 18, 20, 21])
                for (const ang of [0, 0.4, -0.4]) {
                    const t = roadT(u0) + side * 10.5;
                    const dirU = Math.sin(ang);
                    const dirT = side * Math.cos(ang);
                    const a = at(u0, t);
                    const b = at(u0 + dirU, t + dirT);
                    s.physics.place(
                        s.ute.id,
                        pose(
                            a.x,
                            valleyHeight(a.x, a.z) + 0.4,
                            a.z,
                            quatFromYawPitchRoll(Math.atan2(b.x - a.x, b.z - a.z), 0, 0)
                        )
                    );
                    p.step({}, 30);
                    if (Math.hypot(s.ute.pose.p.x - a.x, s.ute.pose.p.z - a.z) > 0.3) continue;
                    drives++;
                    const start = s.tick;
                    const out = () => {
                        const q = s.ute.pose.p;
                        return side * (routeT(q.x, q.z) - roadT(routeU(q.x, q.z)));
                    };
                    const along = () => routeU(s.ute.pose.p.x, s.ute.pose.p.z);
                    const drive = (du: number, dt: number, ticks: number, stop?: () => boolean) => {
                        for (let i = 0; i < ticks && !stop?.(); i++) {
                            const pp = s.ute.pose.p;
                            const c = at(along() + du * 3, routeT(pp.x, pp.z) + dt * 3);
                            const e = Math.atan2(c.x - pp.x, c.z - pp.z) - yawOf(s.ute.pose.q);
                            const err = Math.atan2(Math.sin(e), Math.cos(e));
                            p.step({ moveZ: 1, moveX: Math.max(-1, Math.min(1, -2.5 * err)) });
                            if (out() > highest) {
                                highest = out();
                                highestS = (s.tick - start) / 60;
                            }
                        }
                    };
                    drive(dirU, dirT, S(20));
                    drive(1, 0, S(20), () => along() > CLOSURE_AT.barrierU + 2);
                    if (along() > CLOSURE_AT.barrierU + 2) round.push((s.tick - start) / 60);
                }
        console.log(
            `the logging track: ${trackS.toFixed(1)} s from its mouth to the road beyond; up the valley sides: ${drives} drives, the highest ${highest.toFixed(1)} m out (after ${highestS.toFixed(1)} s), ${round.length} got round past the line${round.length ? ` (fastest ${Math.min(...round).toFixed(1)} s)` : ''}`
        );
        expect(drives).toBeGreaterThan(20);
        // a long way round: any way round by the side takes longer than the whole track
        for (const r of round) expect(r).toBeGreaterThan(trackS);
    }, 900_000);

    it('the barrier is pinned: the ute at full throttle into it for 3 s stops; nothing moves, nothing flies', () => {
        const s = closed();
        const b0 = { ...s.closure.barrier.pose.p };
        const d = inTheUte(s, 15);
        let contact = -1;
        let fastest = 0;
        let bad = false;
        d.drive(roadPoints(17, 30, 2), 1, () => {
            const pp = s.ute.pose.p;
            if (contact < 0 && routeU(pp.x, pp.z) > CLOSURE_AT.barrierU - 3.2) contact = s.tick;
            for (const [, b] of s.physics.bodies) {
                const v = b.body.linvel();
                const sp = Math.hypot(v.x, v.y, v.z);
                if (!Number.isFinite(sp)) bad = true;
                fastest = Math.max(fastest, sp);
            }
            return contact > 0 && s.tick - contact >= S(3);
        });
        expect(contact).toBeGreaterThan(0);
        expect(bad).toBe(false);
        expect(fastest).toBeLessThan(15);
        const b1 = s.closure.barrier.pose.p;
        expect(Math.hypot(b1.x - b0.x, b1.y - b0.y, b1.z - b0.z)).toBeLessThan(0.1);
        expect(Math.abs(s.vehicle!.speed())).toBeLessThan(0.5);
        expect(routeU(s.ute.pose.p.x, s.ute.pose.p.z)).toBeLessThan(CLOSURE_AT.barrierU);
        expect(s.hazards.road!.pinned).toBe(true);
    }, 300_000);

    it('counterplay: take hold of the barrier and drag it off the road; the sign clunks back, the road is open', () => {
        const s = closed();
        const p = takeHold(s, 0, -2.3);
        expect(s.interaction().holding).toBe('barrier');
        expect(s.hazards.road!.pinned).toBe(false);
        // back down the road and out to the side the near end points to (clear of the fence line), until it is clear
        const out = at(CLOSURE_AT.barrierU - 2.5, roadT(CLOSURE_AT.barrierU) - 10.5);
        // (straight back down the road first: across, it stands in the old fence line)
        const back1 = at(CLOSURE_AT.barrierU - 2.5, roadT(CLOSURE_AT.barrierU) - 2.3);
        try {
            dragTo(s, p, back1.x, back1.z);
            dragTo(s, p, out.x, out.z, () => {
                if (!s.hazards.road!.blocking(s.physics, s.closure.barrier.id)) throw new Error('clear');
            });
        } catch (e) {
            if ((e as Error).message !== 'clear') throw e;
        }
        expect(s.hazards.road!.blocking(s.physics, s.closure.barrier.id)).toBe(false);
        p.step({ grab: true }, 1);
        p.step({}, S(CLOSURE.swingS) + 5);
        expect(s.hazards.road!.busy).toBe(false);
        expect(s.closure.sign.anim[SIGN_SWING]).toBe(0);
        expect(texts(s).filter((t) => t === CLOSURE_OPEN)).toHaveLength(1);
        expect(s.hazards.outcomes.map((o) => o.what)).toEqual(['barrier shifted off the road']);
        // and the road beyond is walkable straight up
        const beyond = roadAt(CLOSURE_AT.barrierU + 3);
        const from = roadAt(CLOSURE_AT.barrierU - 3);
        s.placePlayer(from.x, from.z, 0);
        p.step({}, 10);
        p.walkTo(beyond.x, beyond.z);
    }, 300_000);

    it('counterplay: two players carry it off together; a second player’s grab (a guest’s, on the host) frees the pin', () => {
        const s = closed();
        s.setSlotActive(1, true);
        // player 2 (slot 1: how a guest's commands reach the host) takes hold first
        takeHold(s, 1, -1.6);
        expect(s.hazards.road!.pinned).toBe(false);
        takeHold(s, 0, -2.5, false);
        expect(s.physics.holders(s.closure.barrier.id)).toBe(2);
        const p0 = inputs(s, 0);
        const p1 = inputs(s, 1);
        const target = (dt: number) => at(CLOSURE_AT.barrierU - 2.5, roadT(CLOSURE_AT.barrierU) + dt);
        for (let i = 0; i < 60 * 30 && s.hazards.road!.blocking(s.physics, s.closure.barrier.id); i++) {
            const g = target(-8);
            const c0 = s.players[0];
            const c1 = s.players[1];
            p0.v.yaw = Math.atan2(-(g.x - c0.x), -(g.z - c0.z));
            p1.v.yaw = Math.atan2(-(g.x - c1.x), -(g.z - c1.z));
            s.step(
                { ...neutralCommand(s.tick), yaw: p0.v.yaw, pitch: -0.2, moveZ: 1 },
                { ...neutralCommand(s.tick), yaw: p1.v.yaw, pitch: -0.2, moveZ: 1 }
            );
        }
        const bc = s.closure.barrier.pose.p;
        const where = (x: number, z: number) =>
            `${routeU(x, z).toFixed(1)}/${(routeT(x, z) - roadT(routeU(x, z))).toFixed(1)}`;
        expect(
            s.hazards.road!.blocking(s.physics, s.closure.barrier.id),
            `barrier ${where(bc.x, bc.z)} p0 ${where(s.players[0].x, s.players[0].z)} p1 ${where(s.players[1].x, s.players[1].z)} holders ${s.physics.holders(s.closure.barrier.id)}`
        ).toBe(false);
        p0.step({}, S(CLOSURE.swingS) + 5);
        expect(s.hazards.road!.busy).toBe(false);
        expect(s.closure.sign.anim[SIGN_SWING]).toBe(0);
    }, 300_000);

    it('the budget: not in the quiet start, once a run; a run reset puts the sign and the barrier back, and it comes again', () => {
        // in the quiet start: crossing in the window brings nothing, and nothing comes later
        const early = new LabSim({ level: CLOSURE_ONLY });
        early.runTo(60);
        early.fpActive = true;
        early.runTo(62);
        bridge(early);
        const e = inputs(early);
        const start = at(-5, 0);
        early.placePlayer(start.x, start.z, 0);
        e.step({}, 20);
        for (const u of [-2, 0, 2.5, 5]) {
            const w = at(u, roadT(u));
            e.walkTo(w.x, w.z);
        }
        expect(early.tick).toBeLessThan(S(HAZARD.graceS));
        early.runTo(S(HAZARD.graceS) + S(5));
        expect(early.hazards.road!.count).toBe(0);
        expect(early.closure.barrier.visible).toBe(false);

        // once a run: cleared, then crossing the window again brings no second
        const s = closed();
        const p = takeHold(s, 0, -2.3);
        const out = at(CLOSURE_AT.barrierU - 2.5, roadT(CLOSURE_AT.barrierU) - 10.5);
        // (straight back down the road first: across, it stands in the old fence line)
        const back1 = at(CLOSURE_AT.barrierU - 2.5, roadT(CLOSURE_AT.barrierU) - 2.3);
        try {
            dragTo(s, p, back1.x, back1.z);
            dragTo(s, p, out.x, out.z, () => {
                if (!s.hazards.road!.blocking(s.physics, s.closure.barrier.id)) throw new Error('clear');
            });
        } catch (err) {
            if ((err as Error).message !== 'clear') throw err;
        }
        p.step({ grab: true });
        p.step({}, S(HAZARD.safeS) + 10);
        const back = at(-1, 0);
        s.placePlayer(back.x, back.z, 0);
        p.step({}, 10);
        for (const u of [0, 2.5, 6]) {
            const w = at(u, roadT(u));
            p.walkTo(w.x, w.z);
        }
        expect(s.hazards.road!.count).toBe(1);
        expect(texts(s).filter((t) => t === CLOSURE_TELL)).toHaveLength(1);

        // a run reset: the barrier hidden again, the sign open, and the closure comes again
        s.reset();
        expect(s.closure.barrier.visible).toBe(false);
        expect(s.closure.sign.anim[SIGN_SWING]).toBe(0);
        expect(s.hazards.road!.count).toBe(0);
        s.runTo(S(HAZARD.graceS) + 10);
        s.fpActive = true;
        bridge(s);
        const again = inputs(s);
        s.placePlayer(start.x, start.z, 0);
        again.step({}, 20);
        for (const u of [-2, 0, 2.5]) {
            const w = at(u, 0);
            again.walkTo(w.x, w.z);
        }
        expect(s.hazards.road!.count).toBe(1);
        expect(s.closure.barrier.visible).toBe(true);
    }, 300_000);

    it('an empty ute left on the closed road does not hold it: park it there, walk round by the track, and the next weather comes', () => {
        // the closure-only Valley with a short spell of weather beyond the closed stretch: it comes
        // only once the closure is over and its quiet spell out
        const beyond = (x: number, z: number) => routeU(x, z) > CLOSURE_AT.rejoin + 1;
        const level = {
            ...CLOSURE_ONLY,
            hazards: {
                ...CLOSURE_ONLY.hazards,
                weather: {
                    zones: [
                        {
                            name: 'test shower',
                            kind: WEATHER.rain,
                            contains: beyond,
                            tellS: 2,
                            activeS: 4,
                            clearS: 2,
                            delayS: 0,
                            delayJitterS: 0,
                            tell: 'test shower',
                            clear: 'test shower over'
                        }
                    ]
                }
            }
        };
        const s = closed(level);
        // into the ute (set beside it on the road at u 12), drive it on to u 15, stop, get out
        const d = inTheUte(s, 12);
        d.drive(roadPoints(13, 15, 1), 0.4);
        const p = inputs(s);
        for (let i = 0; i < S(5) && Math.abs(s.vehicle!.speed()) > 0.05; i++) p.step({ jump: true });
        p.step({ jump: true }, 20);
        p.step({ grab: true });
        p.step({}, 20);
        expect(s.driver).toBe(-1);
        const parked = routeU(s.ute.pose.p.x, s.ute.pose.p.z);
        expect(parked).toBeGreaterThan(R.from);
        expect(parked).toBeLessThan(CLOSURE_AT.barrierU);
        expect(s.hazards.road!.busy).toBe(true);
        // on foot back to the track's mouth, along it, and out onto the road beyond
        const track = SIDE_PATHS.find((q) => q.name === 'logging-track')!;
        for (const [u, t] of track.points) {
            const w = at(u, t);
            p.walkTo(w.x, w.z, false, undefined, 0.6);
        }
        const out = roadAt(CLOSURE_AT.rejoin + 3);
        p.walkTo(out.x, out.z);
        p.step({}, 5);
        // the ute still stands on the closed road, empty: the closure is over all the same
        expect(routeU(s.ute.pose.p.x, s.ute.pose.p.z)).toBeCloseTo(parked, 0);
        expect(s.hazards.road!.busy).toBe(false);
        // the playtest log's account says where the ute was left
        expect(s.hazards.outcomes.map((o) => o.what)).toEqual([
            'took the track on foot; left the ute on the closed road'
        ]);
        // and the next hazard comes once the quiet spell is out
        const w = s.hazards.weather!;
        for (let i = 0; i < S(HAZARD.safeS + 5) && !w.hazardBusy; i++) p.step();
        expect(w.hazardBusy).toBe(true);
        expect(texts(s)).toContain('test shower');
    }, 300_000);

    it('never came: a player who brings it on and stays where they are (on the crossing) never holds it; 10 s on it is over, "never came"', () => {
        const s = valley();
        bridge(s);
        const p = inputs(s);
        const start = at(-5, 0);
        s.placePlayer(start.x, start.z, 0);
        p.step({}, 20);
        for (const u of [-2, 0]) {
            const w = at(u, 0);
            p.walkTo(w.x, w.z);
        }
        expect(texts(s)).toContain(CLOSURE_TELL);
        const tell = s.events.find((e) => e.text === CLOSURE_TELL)!.tick;
        // stood on the crossing, short of the closed stretch
        expect(routeU(s.player.x, s.player.z)).toBeLessThan(R.from);
        while (s.hazards.road!.busy && s.tick - tell < S(CLOSURE.goneS + 5)) p.step();
        expect(s.hazards.road!.busy).toBe(false);
        expect(routeU(s.player.x, s.player.z)).toBeLessThan(R.from);
        expect((s.tick - tell) / 60).toBeCloseTo(CLOSURE.goneS, 1);
        expect(s.hazards.outcomes.map((o) => `${o.hazard}: ${o.what}`)).toEqual(['road closure: never came']);
    }, 300_000);

    it('stopped in the closure: a player standing just inside the closed stretch holds it CLOSURE.stopS from their last step along the road, then it is over', () => {
        const s = closed();
        const tell = s.events.find((e) => e.text === CLOSURE_TELL)!.tick;
        const p = inputs(s);
        // they stopped here (closed() walks them in and stops)
        const stopped = s.tick;
        expect(routeU(s.player.x, s.player.z)).toBeGreaterThanOrEqual(R.from);
        expect(routeU(s.player.x, s.player.z)).toBeLessThan(R.from + 1.5);
        while (s.hazards.road!.busy && s.tick - tell < S(CLOSURE.stopS + 10)) p.step();
        expect(s.hazards.road!.busy).toBe(false);
        // CLOSURE.stopS after their last 0.5 m along, to the tick (that was before they stood still)
        const last = s.hazards.road!.lastProgress;
        expect(last).toBeGreaterThanOrEqual(tell);
        expect(last).toBeLessThanOrEqual(stopped);
        expect((s.tick - last) / 60).toBeCloseTo(CLOSURE.stopS, 1);
        // still standing there, the barrier still across the road, the sign still closed
        expect(routeU(s.player.x, s.player.z)).toBeGreaterThanOrEqual(R.from);
        expect(s.hazards.road!.blocking(s.physics, s.closure.barrier.id)).toBe(true);
        expect(s.closure.sign.anim[SIGN_SWING]).toBe(1);
        expect(s.hazards.outcomes.map((o) => `${o.hazard}: ${o.what}`)).toEqual([
            'road closure: stopped in the closure'
        ]);
    }, 300_000);

    it('a slow walk round the track (the stick at 0.3) takes over CLOSURE.stopS and still ends as "took the track on foot", not cut off', () => {
        const s = closed();
        const tell = s.events.find((e) => e.text === CLOSURE_TELL)!.tick;
        const p = inputs(s);
        const track = SIDE_PATHS.find((q) => q.name === 'logging-track')!;
        for (const [u, t] of track.points) {
            const w = at(u, t);
            p.walkTo(w.x, w.z, false, undefined, 0.6, 0.3);
        }
        const beyond = roadAt(CLOSURE_AT.rejoin + 1.5);
        p.walkTo(beyond.x, beyond.z, false, undefined, 0.3, 0.3);
        p.step({}, 5);
        expect(s.hazards.road!.busy).toBe(false);
        const o = s.hazards.outcomes[0];
        // it took longer than the cap from the tell: the cap runs from the last progress, not the tell
        expect((o.tick - tell) / 60).toBeGreaterThan(CLOSURE.stopS);
        expect(s.hazards.outcomes.map((x) => x.what)).toEqual(['took the track on foot']);
    }, 300_000);

    it('stopped in the closure waits while someone has hold of the barrier: held past CLOSURE.stopS it stays on; let go, it ends', () => {
        const s = closed();
        const tell = s.events.find((e) => e.text === CLOSURE_TELL)!.tick;
        const p = takeHold(s, 0, -2.5);
        expect(s.physics.holders(s.closure.barrier.id)).toBe(1);
        // (standing still, holding it, from here: past CLOSURE.stopS since the tell and since they stopped)
        const held = s.tick;
        while (s.tick - held < S(CLOSURE.stopS + 3)) p.step();
        expect(s.tick - tell).toBeGreaterThan(S(CLOSURE.stopS));
        expect(s.physics.holders(s.closure.barrier.id)).toBe(1);
        expect(s.hazards.road!.busy).toBe(true);
        // let go (grab again): over at once, stopped in it
        p.step({ grab: true });
        p.step({}, 2);
        expect(s.physics.holders(s.closure.barrier.id)).toBe(0);
        expect(s.hazards.road!.busy).toBe(false);
        expect(s.hazards.outcomes.map((o) => o.what)).toEqual(['stopped in the closure']);
    }, 300_000);

    it('turned back: a player who brought it on and goes back across the creek stops holding it; with nobody in the closed stretch for 10 s it is over', () => {
        const s = closed();
        const p = inputs(s);
        expect(routeU(s.player.x, s.player.z)).toBeGreaterThanOrEqual(R.from);
        // back over the creek's beams into the yard, and wait there (from the tick they leave the
        // closed stretch)
        let back = -1;
        const leaving = () => {
            if (back < 0 && routeU(s.player.x, s.player.z) < R.from) back = s.tick;
        };
        for (const u of [0, -2, -6]) {
            const w = at(u, 0);
            p.walkTo(w.x, w.z, false, leaving);
        }
        expect(routeU(s.player.x, s.player.z)).toBeLessThan(R.from);
        expect(s.hazards.road!.busy, 'still on when they reach the yard').toBe(true);
        while (s.hazards.road!.busy && s.tick - back < S(CLOSURE.goneS + 5)) p.step();
        const took = (s.tick - back) / 60;
        // it ended CLOSURE.goneS after they left the stretch, to the tick
        expect(s.hazards.road!.busy).toBe(false);
        expect(took).toBeCloseTo(CLOSURE.goneS, 1);
        // the barrier stays across the road, and the sign says so
        expect(s.hazards.road!.blocking(s.physics, s.closure.barrier.id)).toBe(true);
        expect(s.closure.sign.anim[SIGN_SWING]).toBe(1);
        expect(s.hazards.outcomes.map((o) => `${o.hazard}: ${o.what}`)).toEqual(['road closure: turned back']);
    }, 300_000);

    it('a player who stays behind (across the creek) does not hold it: the other walks the track, and it is over', () => {
        const s = closed();
        // player 2 joins, in the yard across the creek, and stays there
        s.setSlotActive(1, true);
        const yard = at(-6, 0);
        s.placePlayer(yard.x, yard.z, 0, 1);
        const p = inputs(s);
        p.step({}, 30);
        const behind = s.players[1];
        expect(routeU(behind.x, behind.z)).toBeLessThan(R.from);
        const track = SIDE_PATHS.find((q) => q.name === 'logging-track')!;
        for (const [u, t] of track.points) {
            const w = at(u, t);
            p.walkTo(w.x, w.z, false, undefined, 0.6);
        }
        expect(s.hazards.road!.busy).toBe(true);
        const beyond = roadAt(CLOSURE_AT.rejoin + 1.5);
        p.walkTo(beyond.x, beyond.z);
        p.step({}, 5);
        expect(routeU(s.players[1].x, s.players[1].z)).toBeLessThan(R.from);
        expect(s.hazards.road!.busy).toBe(false);
        expect(s.hazards.outcomes.map((o) => o.what)).toEqual(['took the track on foot']);
    }, 300_000);

    it('an empty ute rolling at the junction brings nobody: no tell (and the same roll with a driver brings it)', () => {
        // An empty ute only moves when something shoves it, or when the handbrake prank lets it
        // roll, so this one plays the closure's own step: the same roll along the road at 8 m/s,
        // empty and driven, from u = -20 to the junction
        const roll = (driven: boolean) => {
            const s = valley();
            const road = new RoadClosure(R);
            const said: string[] = [];
            for (let k = 0, u = -20; u < CLOSURE_AT.junction; k++, u += 8 / 60) {
                const w = roadAt(u);
                road.step(
                    {
                        tick: s.tick + k,
                        physics: s.physics,
                        entities: s.closure,
                        walkers: [],
                        ute: { x: w.x, z: w.z, speed: 8, driven },
                        say: (t) => said.push(t)
                    },
                    true
                );
            }
            return said;
        };
        expect(roll(true)).toEqual([CLOSURE_TELL]);
        expect(roll(false)).toEqual([]);
    }, 300_000);

    it('the budget: not while the weather is on, nor in the quiet spell after it; then it comes', () => {
        // the closure-only Valley with a short spell of weather over the whole map, from the moment
        // the quiet start is over
        const level = {
            ...CLOSURE_ONLY,
            hazards: {
                ...CLOSURE_ONLY.hazards,
                weather: {
                    zones: [
                        {
                            name: 'test shower',
                            kind: WEATHER.rain,
                            contains: () => true,
                            tellS: 2,
                            activeS: 6,
                            clearS: 2,
                            delayS: 0,
                            delayJitterS: 0,
                            tell: 'test shower',
                            clear: 'test shower over'
                        }
                    ]
                }
            }
        };
        const s = valley(level);
        const w = s.hazards.weather!;
        expect(w.hazardBusy).toBe(true);
        bridge(s);
        const p = inputs(s);
        /** From the yard side over the beams into the tell's window (set down short of it first). */
        const cross = () => {
            const start = at(-5, 0);
            s.placePlayer(start.x, start.z, 0);
            p.step({}, 20);
            for (const u of [-2, 0, 2.5]) {
                const g = at(u, 0);
                p.walkTo(g.x, g.z);
            }
        };
        // while the weather is on: nothing
        cross();
        expect(w.hazardBusy).toBe(true);
        expect(s.hazards.road!.count).toBe(0);
        // the weather over: in its quiet spell, nothing
        for (let i = 0; i < S(20) && w.hazardBusy; i++) p.step();
        expect(w.hazardBusy).toBe(false);
        const over = s.tick;
        cross();
        expect(s.tick - over).toBeLessThan(S(HAZARD.safeS));
        expect(s.hazards.road!.count).toBe(0);
        expect(texts(s)).not.toContain(CLOSURE_TELL);
        // once the quiet spell is out: it comes
        p.step({}, Math.max(0, over + S(HAZARD.safeS) - s.tick) + 1);
        cross();
        expect(s.hazards.road!.count).toBe(1);
        expect(texts(s)).toContain(CLOSURE_TELL);
        expect(s.hazards.outcomes.map((o) => `${o.hazard}: ${o.what}`)).toEqual([
            'weather: test shower: came and cleared'
        ]);
    }, 300_000);

    it('the barrier dragged back across the road: the sign clunks closed again, with its toast', () => {
        const s = closed();
        const p = takeHold(s, 0, -2.3);
        // just clear of the road (back down it, then out to the side), and wait there, holding it
        const out = at(CLOSURE_AT.barrierU - 2.5, roadT(CLOSURE_AT.barrierU) - 10.5);
        const back1 = at(CLOSURE_AT.barrierU - 2.5, roadT(CLOSURE_AT.barrierU) - 2.3);
        dragTo(s, p, back1.x, back1.z);
        try {
            dragTo(s, p, out.x, out.z, () => {
                if (!s.hazards.road!.blocking(s.physics, s.closure.barrier.id)) throw new Error('clear');
            });
        } catch (e) {
            if ((e as Error).message !== 'clear') throw e;
        }
        p.step({}, S(CLOSURE.swingS) + 5);
        expect(s.interaction().holding).toBe('barrier');
        expect(s.closure.sign.anim[SIGN_SWING]).toBe(0);
        expect(texts(s).filter((t) => t === CLOSURE_OPEN)).toHaveLength(1);
        // let go, take hold of its end nearer the road, and pull it back across to the far side
        p.step({ grab: true });
        p.step({}, 30);
        const tOf = (lx: number) => {
            const w = byBarrier(s, lx, 0);
            return Math.abs(routeT(w.x, w.z) - roadT(routeU(w.x, w.z)));
        };
        const q = takeHold(s, 0, tOf(-2.3) < tOf(2.3) ? -2.3 : 2.3);
        expect(s.interaction().holding).toBe('barrier');
        const across = at(CLOSURE_AT.barrierU - 2.5, roadT(CLOSURE_AT.barrierU) + 1.5);
        dragTo(s, q, across.x, across.z);
        q.step({}, 10);
        const bb = s.closure.barrier.pose.p;
        const ww = (x: number, z: number) =>
            `${routeU(x, z).toFixed(1)}/${(routeT(x, z) - roadT(routeU(x, z))).toFixed(1)}`;
        expect(
            s.hazards.road!.blocking(s.physics, s.closure.barrier.id),
            `holding ${s.interaction().holding} barrier ${ww(bb.x, bb.z)} yaw ${yawOf(s.closure.barrier.pose.q).toFixed(2)} player ${ww(s.player.x, s.player.z)}`
        ).toBe(true);
        q.step({}, S(CLOSURE.swingS) + 5);
        expect(s.closure.sign.anim[SIGN_SWING]).toBe(1);
        expect(texts(s).filter((t) => t === CLOSURE_SHUT)).toHaveLength(1);
        expect(texts(s).filter((t) => t === CLOSURE_TELL)).toHaveLength(1);
    }, 300_000);

    it('the same commands give the same closure (deterministic)', () => {
        const run = () => {
            const s = closed();
            const p = takeHold(s, 0, -2.3);
            const out = at(CLOSURE_AT.barrierU - 2.5, roadT(CLOSURE_AT.barrierU) - 10.5);
            for (let i = 0; i < 240; i++) {
                const dx = out.x - s.player.x;
                const dz = out.z - s.player.z;
                p.v.yaw = Math.atan2(-dx, -dz);
                p.step({ moveZ: 1 });
            }
            const b = s.closure.barrier.pose;
            return {
                tick: s.tick,
                b: [b.p.x, b.p.y, b.p.z, b.q.x, b.q.y, b.q.z, b.q.w],
                swing: s.closure.sign.anim[SIGN_SWING]
            };
        };
        expect(run()).toEqual(run());
    }, 300_000);

    it('online: the guest gets the tell, sees the sign swing and the barrier across the road, and its grab frees the pin', async () => {
        const hub = new MemoryHub();
        const host = valley();
        bridge(host);
        const hs = await HostSession.start(hub.transport('host'), host, 'valley', 'road');
        const ad = listGames(hub.channel('lobby', 'watcher'))[0];
        let clock = 0;
        const guestSim = new LabSim({ level: valleyLevel });
        const gs = await GuestSession.join(hub.transport('guest'), guestSim, ad, { now: () => clock });
        const guestCmd: Partial<PlayerCommand> = {};
        const hostCmd: Partial<PlayerCommand> = {};
        const run = (ticks: number) => {
            for (let i = 0; i < ticks; i++) {
                gs.sendInput({ ...neutralCommand(host.tick), ...guestCmd });
                host.step({ ...neutralCommand(host.tick), ...hostCmd }, hs.commandFor(1), [
                    hs.commandFor(2),
                    hs.commandFor(3)
                ]);
                hs.afterStep((slot) => host.interactionIds(slot));
                clock += 1000 / 60;
            }
        };
        run(10);
        // the host's player, set down on the yard side, walks up onto the bridge by its commands,
        // into the tell's window
        const start = at(-5, 0);
        host.placePlayer(start.x, start.z, 0);
        run(20);
        const onto = at(2.5, 0);
        for (let i = 0; i < S(10) && host.hazards.road!.count === 0; i++) {
            const me = host.players[0];
            hostCmd.yaw = Math.atan2(-(onto.x - me.x), -(onto.z - me.z));
            hostCmd.moveZ = 1;
            run(1);
        }
        hostCmd.moveZ = 0;
        run(S(2));
        expect(host.hazards.road!.count).toBe(1);
        expect(gs.events.some((e) => e.kind === 'hazard' && e.text === CLOSURE_TELL)).toBe(true);
        // the guest's copies: the sign swung over, the barrier where the host has it
        while (host.tick % 3 !== 0) run(1);
        const anim = new Float64Array(ANIM_MAX);
        const out = pose();
        expect(guestSim.ring.sample(host.closure.sign.slot, host.tick / 60, out, anim)).toBe(true);
        expect(anim[SIGN_SWING]).toBeCloseTo(1, 2);
        expect(guestSim.ring.sample(host.closure.barrier.slot, host.tick / 60, out, anim)).toBe(true);
        const hb = host.closure.barrier.pose.p;
        expect(Math.hypot(out.p.x - hb.x, out.p.z - hb.z)).toBeLessThan(0.05);
        expect(Math.abs(routeU(out.p.x, out.p.z) - CLOSURE_AT.barrierU)).toBeLessThan(0.1);
        // the guest (slot 1 on the host), set down beside it, looks at it and takes hold through its
        // own commands
        expect(host.hazards.road!.pinned).toBe(true);
        const stand = byBarrier(host, -1.6, 1.3);
        host.placePlayer(stand.x, stand.z, 0, 1);
        run(10);
        const grip = byBarrier(host, -1.6, 0);
        const g = host.players[1];
        guestCmd.yaw = Math.atan2(g.x - grip.x, g.z - grip.z);
        guestCmd.pitch = -Math.atan2(g.y + EYE_HEIGHT - (hb.y + 0.3), Math.hypot(g.x - grip.x, g.z - grip.z));
        run(6);
        guestCmd.grab = true;
        run(1);
        guestCmd.grab = false;
        run(6);
        expect(host.physics.holders(host.closure.barrier.id)).toBe(1);
        expect(host.hazards.road!.pinned).toBe(false);
        gs.leave();
        hs.stop();
    }, 300_000);

    it('on the full Valley it waits its turn: crossing while the flood is coming brings no closure; after the flood and its quiet spell it comes; no rain while it runs', () => {
        const s = valley(valleyLevel);
        bridge(s);
        const r = walkUpTheRoad(s, false, 5);
        // the finished bridge brought the flood first (pending, then its siren): no closure as
        // they crossed
        expect(s.hazards.busy).toBe(true);
        expect(r.tell).toBe(-1);
        expect(s.hazards.road!.count).toBe(0);
        // wait the flood and its quiet spell out
        const p = inputs(s);
        for (let i = 0; i < S(120) && s.hazards.busy; i++) p.step();
        expect(s.hazards.busy).toBe(false);
        expect(s.hazards.floodCount).toBe(1);
        p.step({}, S(HAZARD.safeS) + 5);
        // the next one in the window brings it: set down on the crossing, in the window, standing
        // (the trigger takes anyone on foot in the window, whichever way they face)
        const w = at(-0.5, 0);
        s.placePlayer(w.x, w.z, 0);
        p.step({}, 3);
        expect(s.hazards.road!.count).toBe(1);
        expect(texts(s)).toContain(CLOSURE_TELL);
        // set down up on the forest road (the rain's area) and wait there: while the closure runs,
        // no rain
        const fr = roadAt(13);
        s.placePlayer(fr.x, fr.z, 0);
        for (let i = 0; i < S(40); i++) {
            p.step();
            expect(s.hazards.weather!.busy && s.hazards.road!.busy).toBe(false);
        }
        expect(s.hazards.road!.busy).toBe(true);
    }, 300_000);
});
