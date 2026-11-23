import { beforeAll, describe, expect, it } from 'vitest';

import { BRIDGE, BRIDGE_X, YARD_Y } from '../../src/levels/timber-yard.ts';
import {
    CLOSURE_AT,
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
import { CLOSURE, CLOSURE_OPEN, CLOSURE_TELL, SIGN_SWING } from '../../src/sim/hazard-road.ts';
import { HAZARD } from '../../src/sim/hazards.ts';
import { EYE_HEIGHT, LabSim } from '../../src/sim/lab-sim.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { ANIM_MAX } from '../../src/sim/snapshots.ts';
import { pose, quatFromYawPitchRoll, quatMul, quatRotate } from '../../src/voxels/math.ts';

beforeAll(() => initPhysics());

const S = (s: number) => Math.round(s * 60);
const texts = (s: LabSim) => s.events.filter((e) => e.kind === 'hazard').map((e) => e.text);
const yawOf = (q: { x: number; y: number; z: number; w: number }) =>
    Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
const at = (u: number, t: number) => routeToWorld(u, t);
const roadAt = (u: number) => at(u, roadT(u));

/** The Valley past its quiet start, player 0 on foot. */
function valley(level = valleyLevel): LabSim {
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
    /** Walks (or runs) to (x, z), facing the way it goes; calls `each` every tick. */
    const walkTo = (x: number, z: number, sprint = false, each?: () => void, near = 0.3) => {
        for (let i = 0; i < 60 * 60; i++) {
            const dx = x - me().x;
            const dz = z - me().z;
            if (Math.hypot(dx, dz) < near) return;
            v.yaw = Math.atan2(-dx, -dz);
            v.pitch = 0;
            step({ moveZ: 1, sprint });
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
function closed(level = valleyLevel): LabSim {
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

/** Player `slot` walks up to the barrier at local x = lx (from its -u face) and takes hold of it. */
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

    it('the ute at its top road speed: the tell still lands at least 2.5 s before the junction', () => {
        // the Valley's road has no straight run-up to the junction at u = 11 (the creek is just
        // before it, crossed on foot), so this puts the same closure's junction up the forest road
        // beyond the culvert, and drives the ute at it at top speed, by input
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
        // the barrier is still there, so the sign still says so
        expect(s.hazards.road!.blocking(s.physics, s.closure.barrier.id)).toBe(true);
        expect(s.closure.sign.anim[SIGN_SWING]).toBe(1);
        expect(texts(s)).not.toContain(CLOSURE_OPEN);
        expect(s.hazards.busy).toBe(false);
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
    }, 300_000);

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
        // out to the side the near end points to (the verge beyond is open), until it is clear
        const out = at(CLOSURE_AT.barrierU + 1, roadT(CLOSURE_AT.barrierU) - 9.5);
        try {
            p.walkTo(out.x, out.z, false, () => {
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
        const target = (dt: number) => at(CLOSURE_AT.barrierU + 1.3, roadT(CLOSURE_AT.barrierU) + dt);
        for (let i = 0; i < 60 * 30 && s.hazards.road!.blocking(s.physics, s.closure.barrier.id); i++) {
            const g = target(-9);
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
        const early = new LabSim({ level: valleyLevel });
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
        const out = at(CLOSURE_AT.barrierU + 1, roadT(CLOSURE_AT.barrierU) - 9.5);
        try {
            p.walkTo(out.x, out.z, false, () => {
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

    it('the same commands give the same closure (deterministic)', () => {
        const run = () => {
            const s = closed();
            const p = takeHold(s, 0, -2.3);
            const out = at(CLOSURE_AT.barrierU + 1, roadT(CLOSURE_AT.barrierU) - 9.5);
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
        const run = (ticks: number) => {
            for (let i = 0; i < ticks; i++) {
                gs.sendInput({ ...neutralCommand(host.tick), ...guestCmd });
                host.step(neutralCommand(host.tick), hs.commandFor(1), [hs.commandFor(2), hs.commandFor(3)]);
                hs.afterStep((slot) => host.interactionIds(slot));
                clock += 1000 / 60;
            }
        };
        run(10);
        // the host's player steps onto the bridge, in the tell's window
        const w = at(0, 0);
        host.placePlayer(w.x, w.z, 0);
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
        // the guest (slot 1 on the host) walks up to it and takes hold through its own commands
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
});
