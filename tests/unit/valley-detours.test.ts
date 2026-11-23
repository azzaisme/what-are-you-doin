import { beforeAll, describe, expect, it } from 'vitest';

import { nearestPath, pathLength } from '../../src/levels/side-paths.ts';
import {
    CHECKPOINTS,
    CREVASSE,
    DETOURS,
    DETOUR_PATHS,
    ROUTE_YAW,
    SIDE_PATHS,
    VALLEY_STAGES,
    roadT,
    routeT,
    routeToWorld,
    routeU,
    valleyHeight,
    valleyHeightUngraded,
    valleyLayout,
    valleyLevel
} from '../../src/levels/valley.ts';
import { GuestSession, HostSession, listGames } from '../../src/net/session.ts';
import { MemoryHub } from '../../src/net/transport.ts';
import { neutralCommand } from '../../src/sim/commands.ts';
import type { PlayerCommand } from '../../src/sim/commands.ts';
import { EYE_HEIGHT, LabSim } from '../../src/sim/lab-sim.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { pose, quatFromYawPitchRoll } from '../../src/voxels/math.ts';

import { Player } from './play.ts';
import { bridge, hAt } from './valley-play.ts';

beforeAll(() => initPhysics());

/**
 * The Valley's foot detours (Epic 9, #87): stepping stones over Shallow Creek, a fallen trunk over
 * the culvert, boulders in the crevasse. Beavers can walk them; the bucket can't go over them (a
 * beaver standing on a detour's piece can't hold it, and nobody can take hold of it lying on one),
 * so building the crossing stays the way to get it over. Players act by input (the Player helper);
 * set-up places things (where players stand, the bucket waiting, a bridge already built).
 */

const CREEK = { stage: 1, t: DETOURS.creek.t, near: -2.5, far: 3.0 };
const CULVERT = { stage: 2, t: DETOURS.culvert.t, near: 36.6, far: 41.9 };
const CRACK = { stage: 5, t: DETOURS.crevasse.t, near: 168.8, far: 172.2 };
const FAR_BANK = { creek: 2.6, culvert: 40.75, crevasse: 171.8 };

/** A Valley run at stage `stage` (0-based), hazards off, with `players` beavers in first person. */
function run(stage: number, players = 1): LabSim {
    const s = new LabSim({ level: valleyLevel, hazards: false });
    s.step(neutralCommand(0));
    s.fpActive = true;
    s.progress.step = stage;
    for (let i = 1; i < players; i++) s.setSlotActive(i, true);
    return s;
}

/** Players 1 and 2 by input, stepping together (each one's helper keeps the other still). */
function pair(s: LabSim): [Player, Player] {
    const a: Player = new Player(s, 0, (c) => s.step(c, neutralCommand(0, b.yaw, b.pitch)));
    const b: Player = new Player(s, 1, (c) => s.step(neutralCommand(0, a.yaw, a.pitch), c));
    return [a, b];
}

/** Puts a player at a route-frame spot facing up the route (+u) or back down it. */
function stand(pl: Player, u: number, t: number, up = true): void {
    const w = routeToWorld(u, t);
    pl.s.placePlayer(w.x, w.z, up ? ROUTE_YAW : ROUTE_YAW + Math.PI, pl.slot);
    pl.yaw = pl.p.yaw;
    pl.pitch = 0;
    pl.step({}, 20);
}

/** Puts a player on top of whatever is at a spot (a stone, a beam): placePlayer finds the terrain. */
function standOn(pl: Player, u: number, t: number, top: number, up = true): void {
    stand(pl, u, t, up);
    const p = pl.p;
    p.y = top + 0.05;
    p.vy = 0;
    pl.s.physics.placeCharacter(p.x, p.y, p.z, pl.slot);
    pl.step({}, 30);
}

/** The bucket put down (full, as it is at a stage start) on the ground at a spot. */
function putBucket(s: LabSim, u: number, t: number): void {
    const w = routeToWorld(u, t);
    s.physics.place(s.bucket.id, pose(w.x, hAt(u, t) + 0.05, w.z));
    for (let i = 0; i < 30; i++) s.step(neutralCommand(s.tick));
}

/** A quick look at the bucket and a grab (before a bucket left on a piece goes back); whether held. */
function grabNow(pl: Player): boolean {
    const b = pl.s.bucket.pose.p;
    pl.lookAt(b.x, b.y + 0.15, b.z, 3);
    pl.step({ grab: true });
    pl.step();
    return pl.s.physics.heldIdOf(pl.slot) === pl.s.bucket.id;
}

/**
 * Takes hold of a bucket another beaver holds (it sways in their hands): aims at it and clicks,
 * aiming again each try, up to `tries` times; whether held.
 */
function takeFromHands(pl: Player, tries = 12): boolean {
    const s = pl.s;
    const b0 = s.bucket.pose.p;
    pl.lookAt(b0.x, b0.y + 0.15, b0.z);
    for (let k = 0; k < tries && !holds(s, pl.slot); k++) {
        const b = s.bucket.pose.p;
        const p = pl.p;
        pl.yaw = Math.atan2(-(b.x - p.x), -(b.z - p.z));
        pl.pitch = Math.atan2(b.y + 0.15 - (p.y + EYE_HEIGHT), Math.hypot(b.x - p.x, b.z - p.z));
        pl.step({ grab: true });
        pl.step({}, 4);
    }
    return holds(s, pl.slot);
}

/** Sets the held bucket down where it hangs (lowered until it rests); ticks it took. */
function setDownHere(pl: Player): number {
    pl.step({ grab: true });
    let n = 1;
    for (; n < 150 && pl.s.physics.heldIdOf(pl.slot) >= 0; n++) pl.step();
    return n;
}

const holds = (s: LabSim, slot: number) => s.physics.heldIdOf(slot) === s.bucket.id;
const bucketU = (s: LabSim) => routeU(s.bucket.pose.p.x, s.bucket.pose.p.z);
const texts = (s: LabSim, kind: string) => s.events.filter((e) => e.kind === kind).map((e) => e.text);
/** The bucket has gone back to where the stage's spare waits (it may roll a little off its spot). */
function backAtStart(s: LabSim, stage: number): boolean {
    const b = VALLEY_STAGES[stage].bucket;
    const p = s.bucket.pose.p;
    return s.progress.recoveries > 0 && Math.hypot(p.x - b.x, p.z - b.z) < 4;
}

/** Player looks up the route along the detour's line (to carry or hold the bucket over it). */
function faceAcross(pl: Player, t: number, pitch = 0): void {
    const w = routeToWorld(routeU(pl.p.x, pl.p.z) + 5, t);
    pl.lookAt(w.x, pl.p.y + EYE_HEIGHT, w.z, 20);
    pl.pitch = pitch;
    pl.step({}, 30);
}

/** Walks along the detour's line (t) to `u`, at `speed`; ticks the bucket was held on a piece. */
function walkAlong(pl: Player, t: number, to: number, speed = 0.6, sprint = false, jump = -1): number {
    let onPiece = 0;
    let worst = 0;
    const w = routeToWorld(to, t);
    for (let i = 0; i < 900; i++) {
        const dx = w.x - pl.p.x;
        const dz = w.z - pl.p.z;
        if (Math.hypot(dx, dz) < 0.3) break;
        pl.yaw = Math.atan2(-dx, -dz);
        const u = routeU(pl.p.x, pl.p.z);
        pl.step({ moveZ: speed, sprint, jump: jump >= 0 && u > jump && u < jump + 0.4 });
        onPiece = holds(pl.s, pl.slot) && pl.s.detourUnder(pl.p) ? onPiece + 1 : 0;
        worst = Math.max(worst, onPiece);
    }
    pl.step({}, 30);
    return worst;
}

describe('the foot detours: where they are', () => {
    const tagged = valleyLayout(1).pieces.filter((p) => p.detour);

    it('three detours, each over a crossing, their pieces tagged with what players call them', () => {
        const count = (w: string) => tagged.filter((p) => p.detour === w).length;
        expect(count('stepping stones')).toBe(DETOURS.creek.stones.length);
        expect(count('fallen trunk')).toBe(1);
        expect(count('boulders')).toBe(DETOURS.crevasse.boulders.length);
        expect(tagged.length).toBe(DETOURS.creek.stones.length + 1 + DETOURS.crevasse.boulders.length);
        for (const p of tagged) {
            const u = routeU(p.pose.p.x, p.pose.p.z);
            const t = routeT(p.pose.p.x, p.pose.p.z);
            // on its own detour's line, over its channel (the ground under it well below the banks)
            const path = DETOUR_PATHS.find((d) => nearestPath([d], u, t, 0.4));
            expect(path, `${p.detour} at ${u.toFixed(1)}, ${t.toFixed(1)}`).toBeDefined();
            expect(p.collide).toBe(true);
        }
        // the sim knows each piece by its tag: standing on one, a beaver is on "stepping stones" etc.
        const s = run(1);
        for (const p of tagged) {
            const top = p.shape.type === 'box' ? p.pose.p.y + p.shape.hy : NaN;
            expect(s.detourUnder({ x: p.pose.p.x, y: top, z: p.pose.p.z, grounded: true })).toBe(p.detour);
            expect(s.detourUnder({ x: p.pose.p.x, y: top, z: p.pose.p.z, grounded: false })).toBeNull();
        }
        // and on the banks, nothing
        for (const [u, t] of [
            [CREEK.near, CREEK.t],
            [CREEK.far, CREEK.t],
            [CRACK.near, CRACK.t],
            [CRACK.far, CRACK.t]
        ]) {
            const w = routeToWorld(u, t);
            expect(s.detourUnder({ x: w.x, y: hAt(u, t), z: w.z, grounded: true })).toBeNull();
        }
    });

    it('clear of the road works: the logging and lookout tracks, the closure (barrier u 22, sign u 10.5)', () => {
        for (const d of DETOUR_PATHS) {
            const side = d.name === 'crevasse-boulders' ? 1 : -1;
            for (const [u, t] of d.points) {
                // on its own side of the road: the logging track and the lookout track are on the other
                expect(Math.sign(t - roadT(u)) || side, `${d.name} at ${u}`).toBe(side);
                expect(nearestPath(SIDE_PATHS, u, t, 3), `${d.name} at ${u} near a side path`).toBeNull();
                expect(Math.abs(u - 22), `${d.name}: the barrier`).toBeGreaterThan(4);
                expect(Math.abs(u - 10.5), `${d.name}: the sign`).toBeGreaterThan(4);
            }
            // each leaves the road and comes back to it
            const [u0, t0] = d.points[0];
            const [u1, t1] = d.points[d.points.length - 1];
            // (within the road's verge: measured 4.2 m at most, where the trunk's path comes back)
            expect(Math.abs(t0 - roadT(u0))).toBeLessThan(4.5);
            expect(Math.abs(t1 - roadT(u1))).toBeLessThan(4.5);
        }
    });

    it('graded like the side paths on the banks (gentle along, level across), and no tree or rock on them', () => {
        // (over the channel the pieces are the path: the banks' stretches are checked)
        // (and the beaver's width either side of them: the across check reaches 0.6 m out)
        const channel = {
            'creek-stones': [-3.2, 3.8],
            'culvert-trunk': [36.2, 42.6],
            'crevasse-boulders': [168, 173.1]
        };
        let graded = 0;
        let worst = { v: 0, where: '' };
        for (const d of DETOUR_PATHS) {
            const [c0, c1] = channel[d.name as keyof typeof channel];
            for (let n = 0; n + 1 < d.points.length; n++) {
                const [au, at] = d.points[n];
                const [bu, bt] = d.points[n + 1];
                const len = Math.hypot(bu - au, bt - at);
                const xu = -(bt - at) / len;
                const xt = (bu - au) / len;
                let prev = NaN;
                for (let k = 0; k <= Math.ceil(len / 0.25); k++) {
                    const u = au + ((bu - au) * k) / Math.ceil(len / 0.25);
                    const t = at + ((bt - at) * k) / Math.ceil(len / 0.25);
                    if (u > c0 && u < c1) {
                        prev = NaN;
                        continue;
                    }
                    const y = hAt(u, t);
                    const where = `${d.name} at ${u.toFixed(1)}, ${t.toFixed(1)}`;
                    if (!Number.isNaN(prev)) expect(Math.abs(y - prev), where).toBeLessThan(0.12);
                    prev = y;
                    const across = (h: (x: number, z: number) => number) => {
                        const a = routeToWorld(u + xu * 0.6, t + xt * 0.6);
                        const b = routeToWorld(u - xu * 0.6, t - xt * 0.6);
                        return Math.abs(h(a.x, a.z) - h(b.x, b.z));
                    };
                    if (across(valleyHeight) > worst.v) worst = { v: across(valleyHeight), where };
                    if (across(valleyHeightUngraded) > 0.08) graded++;
                }
            }
        }
        // level across, over the beaver's width (1.2 m): measured 0.108 m at worst, at the trunk
        // path's corner by the trunk (about 5 degrees: the side paths' 0.06 is along their stretches)
        expect(worst.v, worst.where).toBeLessThan(0.12);
        // (measured: the hillsides needed it in places)
        expect(graded).toBeGreaterThan(0);
        for (const tr of valleyLayout(1).trees) {
            const hit = nearestPath(DETOUR_PATHS, routeU(tr.x, tr.z), routeT(tr.x, tr.z), 2);
            expect(hit, `tree at ${routeU(tr.x, tr.z).toFixed(1)}, ${routeT(tr.x, tr.z).toFixed(1)}`).toBeNull();
        }
        // rocks clear of the path's width (a Timber Yard rock lies beside the creek path's start)
        for (const rk of valleyLayout(1).rocks) {
            const hit = nearestPath(DETOUR_PATHS, routeU(rk.x, rk.z), routeT(rk.x, rk.z), 4);
            const where = `rock at ${routeU(rk.x, rk.z).toFixed(1)}, ${routeT(rk.x, rk.z).toFixed(1)}`;
            if (hit) expect(hit.d - Math.max(rk.rx, rk.rz), where).toBeGreaterThan(hit.path.halfWidth);
        }
    });
});

describe('the foot detours: on foot', () => {
    for (const d of DETOUR_PATHS)
        it(`a beaver walks ${d.name} end to end by input, without falling in`, () => {
            const s = run(0);
            const pl = new Player(s);
            const [u0, t0] = d.points[0];
            stand(pl, u0, t0);
            for (const [u, t] of d.points.slice(1)) {
                const w = routeToWorld(u, t);
                expect(pl.walkTo(w.x, w.z, 0.35, 1500, 0.7), `${d.name}: to ${u}, ${t}`).toBe(true);
            }
            expect(s.progress.falls).toBe(0);
            const [u1, t1] = d.points[d.points.length - 1];
            expect(Math.hypot(routeU(s.player.x, s.player.z) - u1, routeT(s.player.x, s.player.z) - t1)).toBeLessThan(
                0.5
            );
            expect(pathLength(d)).toBeGreaterThan(8);
        }, 120_000);

    it('online: a guest walks the stepping stones, and host and guest agree where they are', async () => {
        const hub = new MemoryHub();
        const host = run(0);
        const hs = await HostSession.start(hub.transport('host'), host, 'valley', 'detr');
        const ad = listGames(hub.channel('lobby', 'watcher'))[0];
        let clock = 0;
        const gsim = new LabSim({ level: valleyLevel, hazards: false });
        const gs = await GuestSession.join(hub.transport('guest'), gsim, ad, { now: () => clock });
        const send = (c: PlayerCommand) => {
            gs.sendInput(c);
            host.step(neutralCommand(host.tick, host.player.yaw), hs.commandFor(1), [
                hs.commandFor(2),
                hs.commandFor(3)
            ]);
            hs.afterStep((slot) => host.interactionIds(slot));
            clock += 1000 / 60;
        };
        const g = new Player(host, 1, send);
        g.step({}, 10);
        expect(host.isSlotActive(1)).toBe(true);
        const d = DETOUR_PATHS.find((p) => p.name === 'creek-stones')!;
        stand(g, d.points[0][0], d.points[0][1]);
        let worst = 0;
        const out = pose();
        const anim = new Float64Array(10);
        const avatar = gsim.entities.find((e) => e.name === 'player2')!;
        for (const [u, t] of d.points.slice(1)) {
            const w = routeToWorld(u, t);
            expect(g.walkTo(w.x, w.z, 0.35, 1500, 0.7), `guest to ${u}, ${t}`).toBe(true);
            // where the guest's snapshots show the guest's beaver, against the host's
            expect(gsim.ring.sample(avatar.slot, gsim.ring.newestTick / 60, out, anim)).toBe(true);
            const p = host.players[1];
            worst = Math.max(worst, Math.hypot(out.p.x - p.x, out.p.z - p.z));
        }
        expect(host.progress.falls).toBe(0);
        expect(routeU(host.players[1].x, host.players[1].z)).toBeGreaterThan(5);
        expect(worst, 'host and guest agree where the guest is').toBeLessThan(0.3);
        gs.leave();
        hs.stop();
    }, 180_000);

    for (const which of ['creek', 'culvert', 'crevasse'] as const)
        it(`the ute can't take the ${which} detour: driven at it, it never reaches the far bank`, () => {
            const s = run(0);
            const d = { creek: CREEK, culvert: CULVERT, crevasse: CRACK }[which];
            const from = d.near - 3;
            const a = routeToWorld(from, d.t);
            const b = routeToWorld(from + 1, d.t);
            const yaw0 = Math.atan2(b.x - a.x, b.z - a.z);
            s.physics.place(s.ute.id, pose(a.x, hAt(from, d.t) + 0.6, a.z, quatFromYawPitchRoll(yaw0, 0, 0)));
            const pl = new Player(s);
            pl.step({}, 60);
            // in at the driver's door (its right side, local -x)
            const u0 = s.ute.pose.p;
            const sx = -Math.cos(yaw0);
            const sz = Math.sin(yaw0);
            s.placePlayer(u0.x + sx * 2.2, u0.z + sz * 2.2, 0);
            pl.yaw = Math.atan2(sx, sz);
            pl.pitch = -Math.atan2(s.player.y + EYE_HEIGHT - (u0.y + 0.6), 1.4);
            pl.step({}, 20);
            pl.step({ grab: true });
            expect(s.driver).toBe(0);
            let farthest = -Infinity;
            for (let i = 0; i < 60 * 10; i++) {
                pl.step({ moveZ: 0.5 });
                const p = s.ute.pose.p;
                const u = routeU(p.x, p.z);
                // only counts on top: on its wheels at the banks' height, not down in the channel
                if (p.y > hAt(FAR_BANK[which] + 0.5, d.t) - 0.6) farthest = Math.max(farthest, u);
            }
            expect(farthest, `the ute's farthest up the detour, on top`).toBeLessThan(FAR_BANK[which]);
        }, 120_000);
});

describe('the bucket can’t go over a detour (each way of trying, by input)', () => {
    it('carried onto the stepping stones, it drops where the beaver stands, and goes back to the start', () => {
        const s = run(CREEK.stage);
        const pl = new Player(s);
        putBucket(s, CREEK.near - 1, CREEK.t);
        stand(pl, CREEK.near - 2.1, CREEK.t);
        expect(pl.grabBucket()).toBe(true);
        faceAcross(pl, CREEK.t);
        const held = walkAlong(pl, CREEK.t, DETOURS.creek.stones[1]);
        expect(held, 'ticks held standing on a stone').toBeLessThanOrEqual(1);
        expect(holds(s, 0)).toBe(false);
        expect(s.detourUnder(s.player)).toBe('stepping stones');
        expect(texts(s, 'hint')).toEqual([
            "The bucket's too awkward for the stepping stones: build the crossing to get it over."
        ]);
        pl.step({}, 200);
        expect(backAtStart(s, CREEK.stage)).toBe(true);
        expect(s.progress.step).toBe(CREEK.stage);
    }, 60_000);

    it('carried with a running jump onto the stones, it drops as the beaver lands', () => {
        const s = run(CREEK.stage);
        const pl = new Player(s);
        putBucket(s, CREEK.near - 3, CREEK.t);
        stand(pl, CREEK.near - 4.1, CREEK.t);
        expect(pl.grabBucket()).toBe(true);
        faceAcross(pl, CREEK.t);
        let held = walkAlong(pl, CREEK.t, CREEK.near + 0.3, 1, true, CREEK.near);
        held = Math.max(held, walkAlong(pl, CREEK.t, FAR_BANK.creek + 1, 1, true));
        expect(held, 'ticks held standing on a stone').toBeLessThanOrEqual(1);
        pl.step({}, 200);
        // wherever the jump landed, the bucket didn't get over
        expect(bucketU(s)).toBeLessThan(FAR_BANK.creek);
        expect(s.progress.step).toBe(CREEK.stage);
    }, 60_000);

    it('alone: set down on a stone from the bank, it can’t be taken up again, from a stone or the bank', () => {
        const s = run(CREEK.stage);
        const pl = new Player(s);
        putBucket(s, CREEK.near - 1, CREEK.t);
        // at the bank's edge, holding it out over the first stone, looking down at it
        stand(pl, CREEK.near - 2.1, CREEK.t);
        expect(pl.grabBucket()).toBe(true);
        faceAcross(pl, CREEK.t);
        walkAlong(pl, CREEK.t, -1.65);
        faceAcross(pl, CREEK.t, -0.2);
        setDownHere(pl);
        expect(holds(s, 0)).toBe(false);
        expect(s.bucketOnDetour()).toBe('stepping stones');
        // reach back for it from the bank: refused
        expect(grabNow(pl)).toBe(false);
        expect(texts(s, 'hint')[0]).toContain('stepping stones');
        pl.step({}, 60);
        // back at the start, with the reason
        expect(backAtStart(s, CREEK.stage)).toBe(true);
        expect(texts(s, 'recovered').at(-1)).toContain("can't be carried on the stepping stones");
        expect(s.progress.step).toBe(CREEK.stage);
    }, 60_000);

    it('alone, from a stone: reaching for it lying on the next stone is refused', () => {
        const s = run(CREEK.stage);
        const pl = new Player(s);
        const [, s1, s2] = DETOURS.creek.stones;
        standOn(pl, s1, CREEK.t, DETOURS.creek.tops[1]);
        expect(s.detourUnder(s.player)).toBe('stepping stones');
        const w = routeToWorld(s2, CREEK.t);
        s.physics.place(s.bucket.id, pose(w.x, DETOURS.creek.tops[2] + 0.02, w.z));
        pl.step({}, 2);
        expect(s.bucketOnDetour()).toBe('stepping stones');
        expect(grabNow(pl)).toBe(false);
        expect(texts(s, 'hint')[0]).toContain('stepping stones');
    }, 60_000);

    it('passed from the bank to a beaver on a stone: the beaver on the stone can’t take it', () => {
        const s = run(CREEK.stage, 2);
        const [a, b] = pair(s);
        putBucket(s, CREEK.near - 1, CREEK.t);
        stand(a, CREEK.near - 2.1, CREEK.t);
        standOn(b, DETOURS.creek.stones[0], CREEK.t, DETOURS.creek.tops[0], false);
        expect(a.grabBucket()).toBe(true);
        faceAcross(a, CREEK.t, -0.3);
        a.step({}, 40);
        expect(takeFromHands(b)).toBe(false);
        expect(texts(s, 'hint')[0]).toContain('stepping stones');
        expect(holds(s, 0)).toBe(true);
        // and a beaver on the bank is no help to one on the stones: the far bank is out of reach
        expect(s.progress.step).toBe(CREEK.stage);
    }, 60_000);

    it('passed across the boulders: set down on one from the near rim, the far rim can’t take it', () => {
        // (measured before the rule's second half: the far rim's beaver took it, 2.7 m from the eye)
        const s = run(CRACK.stage, 2);
        const [a, b] = pair(s);
        putBucket(s, CRACK.near - 1, CRACK.t);
        stand(a, CRACK.near, CRACK.t);
        stand(b, CRACK.far - 0.1, CRACK.t, false);
        expect(a.grabBucket()).toBe(true);
        faceAcross(a, CRACK.t, -0.9);
        setDownHere(a);
        expect(s.bucketOnDetour()).toBe('boulders');
        expect(grabNow(b)).toBe(false);
        b.step({}, 60);
        expect(backAtStart(s, CRACK.stage)).toBe(true);
        expect(texts(s, 'recovered').at(-1)).toContain("can't be carried on the boulders");
        expect(s.progress.step).toBe(CRACK.stage);
    }, 60_000);

    it('two carriers: the one who steps onto a stone lets go, and the one on the bank can go no further', () => {
        const s = run(CREEK.stage, 2);
        const [a, b] = pair(s);
        putBucket(s, CREEK.near - 1, CREEK.t);
        stand(a, CREEK.near - 2.1, CREEK.t + 0.4);
        stand(b, CREEK.near - 2.1, CREEK.t - 0.4);
        expect(a.grabBucket()).toBe(true);
        a.step({}, 40);
        expect(takeFromHands(b)).toBe(true);
        expect(s.physics.holders(s.bucket.id)).toBe(2);
        faceAcross(b, CREEK.t);
        walkAlong(b, CREEK.t - 0.1, DETOURS.creek.stones[0]);
        expect(holds(s, 1)).toBe(false);
        expect(s.detourUnder(s.players[1])).toBe('stepping stones');
        faceAcross(a, CREEK.t);
        const held = walkAlong(a, CREEK.t + 0.1, DETOURS.creek.stones[0] - 0.05);
        expect(held).toBeLessThanOrEqual(1);
        expect(holds(s, 0)).toBe(false);
        a.step({}, 200);
        expect(bucketU(s)).toBeLessThan(FAR_BANK.creek);
        expect(s.progress.step).toBe(CREEK.stage);
    }, 60_000);

    it('dragged along the fallen trunk: it drops at the trunk’s end and goes back to the start', () => {
        const s = run(CULVERT.stage);
        const pl = new Player(s);
        putBucket(s, CULVERT.near - 1, CULVERT.t);
        stand(pl, CULVERT.near - 2.1, CULVERT.t);
        expect(pl.grabBucket()).toBe(true);
        faceAcross(pl, CULVERT.t, -0.6);
        const held = walkAlong(pl, CULVERT.t, DETOURS.culvert.to);
        expect(held).toBeLessThanOrEqual(1);
        expect(texts(s, 'hint')[0]).toContain('fallen trunk');
        pl.step({}, 200);
        expect(backAtStart(s, CULVERT.stage)).toBe(true);
        expect(s.progress.step).toBe(CULVERT.stage);
    }, 60_000);

    it('online: a guest on a stone can’t take it from the host on the bank; both see it stay', async () => {
        const hub = new MemoryHub();
        const host = run(CREEK.stage);
        const hs = await HostSession.start(hub.transport('host'), host, 'valley', 'detp');
        const ad = listGames(hub.channel('lobby', 'watcher'))[0];
        let clock = 0;
        const gsim = new LabSim({ level: valleyLevel, hazards: false });
        const gs = await GuestSession.join(hub.transport('guest'), gsim, ad, { now: () => clock });
        let hostCmd = neutralCommand(0, host.player.yaw);
        let guestCmd = neutralCommand(0, host.players[1].yaw);
        const tick = () => {
            gs.sendInput(guestCmd);
            host.step(hostCmd, hs.commandFor(1), [hs.commandFor(2), hs.commandFor(3)]);
            hs.afterStep((slot) => host.interactionIds(slot));
            clock += 1000 / 60;
        };
        const a: Player = new Player(host, 0, (c) => {
            hostCmd = c;
            tick();
        });
        const g: Player = new Player(host, 1, (c) => {
            guestCmd = c;
            hostCmd = neutralCommand(0, a.yaw, a.pitch);
            tick();
        });
        g.step({}, 10);
        expect(host.isSlotActive(1)).toBe(true);
        putBucket(host, CREEK.near - 1, CREEK.t);
        stand(a, CREEK.near - 2.1, CREEK.t);
        standOn(g, DETOURS.creek.stones[0], CREEK.t, DETOURS.creek.tops[0], false);
        expect(a.grabBucket()).toBe(true);
        faceAcross(a, CREEK.t, -0.3);
        a.step({}, 40);
        guestCmd = neutralCommand(0, g.yaw, g.pitch);
        expect(takeFromHands(g)).toBe(false);
        g.step({}, 30);
        expect(holds(host, 0)).toBe(true);
        expect(holds(host, 1)).toBe(false);
        // the guest is told the same: holding nothing, and why
        expect(gs.hud[1]?.held).toBe(-1);
        expect(gs.events.some((e) => e.text.includes('stepping stones'))).toBe(true);
        // and its snapshots show the bucket where the host has it
        const out = pose();
        expect(gsim.ring.sample(gsim.bucket.slot, gsim.ring.newestTick / 60, out, new Float64Array(10))).toBe(true);
        const p = host.bucket.pose.p;
        expect(Math.hypot(out.p.x - p.x, out.p.y - p.y, out.p.z - p.z)).toBeLessThan(0.3);
        gs.leave();
        hs.stop();
    }, 180_000);
});

describe('building over the detours is building', () => {
    it('control: over the built crevasse crossing, the same pass works and the flag counts it', () => {
        const s = run(CRACK.stage, 2);
        bridge(s, CREVASSE.u, ['beam-9', 'beam-10']);
        const [a, b] = pair(s);
        const t = roadT(CREVASSE.u);
        const beam = s.entities.find((e) => e.name === 'beam-9')!.pose.p;
        putBucket(s, CREVASSE.u - 2.6, t);
        stand(a, CREVASSE.u - 1.6, t);
        standOn(b, CREVASSE.u + 0.2, t, beam.y + 0.1, false);
        expect(a.grabBucket()).toBe(true);
        faceAcross(a, t, -0.3);
        // (the bucket comes up into A's hands first)
        a.step({}, 40);
        expect(takeFromHands(b), 'the beaver on the bridge takes it').toBe(true);
        a.step({ grab: true });
        a.step({}, 10);
        expect(holds(s, 1)).toBe(true);
        const flag = routeToWorld(CHECKPOINTS[CRACK.stage].u, CHECKPOINTS[CRACK.stage].t);
        b.lookAt(flag.x, s.players[1].y + EYE_HEIGHT, flag.z, 20);
        expect(b.walkTo(flag.x, flag.z, 0.5, 2400, 0.6)).toBe(true);
        b.step({ grab: true });
        b.step({}, 150);
        expect(s.progress.step).toBe(CRACK.stage + 1);
        expect(s.progress.falls).toBe(0);
    }, 120_000);

    it('a beaver on a plank laid over the stepping stones holds the bucket (feet on the plank)', () => {
        const s = run(CREEK.stage);
        const pl = new Player(s);
        const [, s1, s2] = DETOURS.creek.stones;
        const plank = s.entities.find((e) => e.name === 'extra-plank-0')!;
        const w = routeToWorld((s1 + s2) / 2, CREEK.t);
        const top = Math.max(DETOURS.creek.tops[1], DETOURS.creek.tops[2]);
        s.physics.place(plank.id, pose(w.x, top + 0.08, w.z, quatFromYawPitchRoll(ROUTE_YAW + Math.PI / 2, 0, 0)));
        pl.step({}, 60);
        const pp = plank.pose.p;
        standOn(pl, (s1 + s2) / 2 + 0.3, CREEK.t, pp.y + 0.05);
        expect(s.detourUnder(s.player), 'on the plank, not the stones').toBeNull();
        const b = routeToWorld((s1 + s2) / 2 - 0.4, CREEK.t);
        s.physics.place(s.bucket.id, pose(b.x, pp.y + 0.1, b.z));
        pl.step({}, 30);
        expect(s.bucketOnDetour(), 'the bucket on the plank is not on the stones').toBeNull();
        expect(pl.grabBucket()).toBe(true);
        pl.step({}, 60);
        expect(holds(s, 0)).toBe(true);
    }, 60_000);
});

/**
 * Timber is not the bucket: planks and beams can be carried over the detours (so a crossing can be
 * built from either side). Measured: both a plank (2.4 m) and a beam (3.2 m) get over all three.
 */
describe('timber over the detours (measured)', () => {
    for (const which of ['creek', 'culvert', 'crevasse'] as const)
        for (const [name, what] of [
            ['extra-plank-0', 'a plank'],
            ['beam-0', 'a beam']
        ] as const)
            it(`${what}, carried over the ${which} detour by one beaver`, () => {
                const d = { creek: CREEK, culvert: CULVERT, crevasse: CRACK }[which];
                const s = run(d.stage);
                const pl = new Player(s);
                const e = s.entities.find((x) => x.name === name)!;
                const w = routeToWorld(d.near - 1, d.t);
                s.physics.place(
                    e.id,
                    pose(w.x, hAt(d.near - 1, d.t) + 0.15, w.z, quatFromYawPitchRoll(ROUTE_YAW, 0, 0))
                );
                stand(pl, d.near - 2.1, d.t);
                pl.step({}, 30);
                pl.lookAt(e.pose.p.x, e.pose.p.y, e.pose.p.z);
                pl.step({ grab: true });
                pl.step({}, 30);
                expect(s.physics.heldIdOf(0)).toBe(e.id);
                faceAcross(pl, d.t);
                walkAlong(pl, d.t, FAR_BANK[which] + 1.2, 0.5);
                const u = routeU(e.pose.p.x, e.pose.p.z);
                // (measured: planks and beams both get over every detour, the beaver walking on)
                expect(s.physics.heldIdOf(0), `${what} still held`).toBe(e.id);
                expect(u, `${what} on the far bank`).toBeGreaterThan(FAR_BANK[which]);
                expect(s.progress.falls).toBe(0);
            }, 60_000);
});

describe('players are told', () => {
    it('each detour stage’s objective says its detour is for feet only', () => {
        expect(VALLEY_STAGES[CREEK.stage].objective).toContain('stepping stones are feet only');
        expect(VALLEY_STAGES[CULVERT.stage].objective).toContain('fallen trunk is feet only');
        expect(VALLEY_STAGES[CRACK.stage].objective).toContain('boulders are feet only');
        expect(VALLEY_STAGES[CRACK.stage].objective).toContain('the bucket goes over the bridge');
    });
});
