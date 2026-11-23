/**
 * The goose (Epic 8, #78): carry the bucket near its patch and it honks, rears up, and comes for
 * the bucket. Everything a player does here goes through player commands; setup only says where a
 * player starts.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { BRIDGE_X, BUCKET_STUMP, GOOSE_PATCH, timberYardLevel } from '../../src/levels/timber-yard.ts';
import { valleyLevel, worldToYard, yardToWorld } from '../../src/levels/valley.ts';
import { GuestSession, HostSession, listGames } from '../../src/net/session.ts';
import { MemoryHub } from '../../src/net/transport.ts';
import { neutralCommand } from '../../src/sim/commands.ts';
import type { PlayerCommand } from '../../src/sim/commands.ts';
import {
    GOOSE,
    GOOSE_BORED,
    GOOSE_DECOY,
    GOOSE_NECK,
    GOOSE_PECK,
    GOOSE_PHASE,
    GOOSE_TELL,
    GOOSE_WINGS
} from '../../src/sim/hazard-goose.ts';
import { HAZARD } from '../../src/sim/hazards.ts';
import { EYE_HEIGHT, LabSim } from '../../src/sim/lab-sim.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { ANIM_MAX } from '../../src/sim/snapshots.ts';
import { pose } from '../../src/voxels/math.ts';

import { Player } from './play.ts';

beforeAll(() => initPhysics());

const S = (s: number) => Math.round(s * 60);
const ends = (s: LabSim) => s.hazards.outcomes.map((o) => `${o.hazard}: ${o.what}`);
const texts = (s: LabSim) => s.events.filter((e) => e.kind === 'hazard').map((e) => e.text);

/** The Timber Yard's frame in the level (the Valley has the yard turned into its route). */
const yardFrame = (level: typeof timberYardLevel) =>
    level === timberYardLevel ? (x: number, z: number) => ({ x, z }) : yardToWorld;

/** The level past its quiet start, player 1 by the stump holding the bucket (not yet near the goose). */
function holding(level = timberYardLevel): { s: LabSim; pl: Player } {
    const s = new LabSim({ level });
    s.runTo(S(HAZARD.graceS) + 10);
    s.fpActive = true;
    const at = yardFrame(level)(BUCKET_STUMP.x, BUCKET_STUMP.z + 1);
    s.placePlayer(at.x, at.z, 0);
    const pl = new Player(s);
    pl.step({}, 20);
    expect(pl.grabBucket()).toBe(true);
    return { s, pl };
}

/** Walks up towards the goose's patch with the bucket until it honks; returns the tick of the honk. */
function provoke(s: LabSim, pl: Player): number {
    const g = s.hazards.goose!;
    const patch = { x: g.x, z: g.z };
    for (let i = 0; i < S(10) && g.tellTick < 0; i++) {
        const dx = patch.x - pl.p.x;
        const dz = patch.z - pl.p.z;
        pl.yaw = Math.atan2(-dx, -dz);
        pl.step({ moveZ: 1 });
    }
    expect(g.tellTick).toBeGreaterThan(0);
    expect(texts(s)).toContain(GOOSE_TELL);
    return g.tellTick;
}

/** Steps until the goose is home and idle again (or `max` ticks). */
function untilHome(pl: Player, max = S(30)): void {
    const g = pl.s.hazards.goose!;
    for (let i = 0; i < max && g.phase !== GOOSE_PHASE.idle; i++) pl.step();
}

describe('the goose (#78): it honks, rears up and comes for the carried bucket', () => {
    it('the tell: a honk, then the goose rears up and stands still 2 s; walking at it, the peck comes at least 2 s after the honk, knocks the bucket loose, and the goose waddles home', () => {
        const { s, pl } = holding();
        const g = s.hazards.goose!;
        const tell = provoke(s, pl);
        // the tell: it rears up where it stands
        const at = { x: g.x, z: g.z };
        pl.step({}, S(1.5));
        expect(g.phase).toBe(GOOSE_PHASE.tell);
        expect(Math.hypot(g.x - at.x, g.z - at.z)).toBeLessThan(1e-9);
        expect(s.goose.anim[GOOSE_NECK]).toBe(1);
        expect(s.goose.anim[GOOSE_WINGS]).toBe(1);
        // walk straight at it, the bucket held out: the worst case
        for (let i = 0; i < S(10) && g.peckTick < 0; i++) {
            pl.yaw = Math.atan2(-(g.x - pl.p.x), -(g.z - pl.p.z));
            pl.step({ moveZ: 1 });
        }
        expect(g.peckTick).toBeGreaterThan(0);
        const lead = (g.peckTick - tell) / 60;
        console.log(`the goose: honk to peck, walking at it: ${lead.toFixed(2)} s`);
        expect(lead).toBeGreaterThanOrEqual(GOOSE.tellS);
        expect(texts(s)).toContain(GOOSE_PECK);
        // knocked out of their hands
        expect(s.physics.heldIdOf(0)).toBe(-1);
        pl.step({}, S(2));
        console.log(`the goose: the bucket kept ${s.water.volume.toFixed(2)} L of 10`);
        // home again, and over
        untilHome(pl);
        expect(g.phase).toBe(GOOSE_PHASE.idle);
        expect(Math.hypot(g.x - GOOSE_PATCH.x, g.z - GOOSE_PATCH.z)).toBeLessThanOrEqual(GOOSE.home);
        expect(s.hazards.busy).toBe(false);
        expect(Math.abs(s.water.imbalance)).toBeLessThan(1e-9);
        // the playtest log's account (#70)
        expect(ends(s)).toEqual(['goose: pecked the bucket loose']);
    }, 120_000);

    it('counterplay: put the bucket down; it loses interest, honks once and goes home; no peck', () => {
        const { s, pl } = holding();
        const g = s.hazards.goose!;
        provoke(s, pl);
        pl.step({}, S(GOOSE.tellS) + 10);
        expect(g.phase).toBe(GOOSE_PHASE.chase);
        // set it down (grab again: it is lowered and let go), and step back
        pl.step({ grab: true });
        for (let i = 0; i < S(2) && s.physics.heldIdOf(0) >= 0; i++) pl.step();
        expect(s.physics.heldIdOf(0)).toBe(-1);
        pl.step({ moveZ: -1 }, 20);
        expect(g.phase).toBe(GOOSE_PHASE.home);
        expect(texts(s)).toContain(GOOSE_BORED);
        untilHome(pl);
        expect(g.peckTick).toBe(-1);
        expect(texts(s)).not.toContain(GOOSE_PECK);
        expect(s.hazards.busy).toBe(false);
        expect(ends(s)).toEqual(['goose: the bucket put down']);
    }, 120_000);

    it('counterplay: dodge it: run off with the bucket; it gives up at the edge of its territory; no peck', () => {
        const { s, pl } = holding();
        const g = s.hazards.goose!;
        provoke(s, pl);
        // run off, south-west across the yard, away from the creek
        const away = { x: BUCKET_STUMP.x - 6, z: BUCKET_STUMP.z + 9 };
        for (let i = 0; i < S(12); i++) {
            pl.yaw = Math.atan2(-(away.x - pl.p.x), -(away.z - pl.p.z));
            pl.step({ moveZ: Math.hypot(away.x - pl.p.x, away.z - pl.p.z) > 0.5 ? 1 : 0, sprint: true });
        }
        expect(g.peckTick).toBe(-1);
        expect(s.physics.heldIdOf(0)).toBe(s.bucket.id);
        expect(texts(s)).toContain(GOOSE_BORED);
        untilHome(pl);
        expect(g.phase).toBe(GOOSE_PHASE.idle);
        expect(ends(s)).toEqual(['goose: outrun']);
    }, 120_000);

    it('carrying the bucket, a beaver outruns it, alone and two carrying it together: measured by input', () => {
        for (const n of [1, 2]) {
            const s = new LabSim({ level: timberYardLevel });
            s.runTo(S(HAZARD.graceS) + 10);
            s.fpActive = true;
            if (n === 2) s.setSlotActive(1, true);
            s.placePlayer(BUCKET_STUMP.x, BUCKET_STUMP.z + 1, 0, 0);
            if (n === 2) s.placePlayer(BUCKET_STUMP.x + 1, BUCKET_STUMP.z, 0, 1);
            const a = new Player(s, 0);
            a.step({}, 20);
            expect(a.grabBucket()).toBe(true);
            if (n === 2) expect(new Player(s, 1).grabBucket()).toBe(true);
            const g = s.hazards.goose!;
            /** Every carrier heads for (x, z); returns player 1's speed over the last second. */
            const go = (x: number, z: number, c: Partial<PlayerCommand>, k: number) => {
                const xs: { x: number; z: number }[] = [];
                for (let i = 0; i < k; i++) {
                    const yaw = (p: { x: number; z: number }) => Math.atan2(-(x - p.x), -(z - p.z));
                    s.step(
                        { ...neutralCommand(s.tick, yaw(s.players[0]), -0.3), ...c },
                        n === 2 ? { ...neutralCommand(s.tick, yaw(s.players[1]), -0.3), ...c } : undefined
                    );
                    xs.push({ x: s.players[0].x, z: s.players[0].z });
                }
                const e = xs.length - 1;
                return e < 60 ? 0 : Math.hypot(xs[e].x - xs[e - 60].x, xs[e].z - xs[e - 60].z);
            };
            // up to the goose until it honks, then run for it, west along the open yard (z 5.8)
            for (let i = 0; i < S(10) && g.tellTick < 0; i++) go(GOOSE_PATCH.x, GOOSE_PATCH.z, { moveZ: 1 }, 1);
            expect(g.tellTick).toBeGreaterThan(0);
            go(-4, 5.8, { moveZ: 1, sprint: true }, 60);
            const speed = go(-4, 5.8, { moveZ: 1, sprint: true }, 61);
            console.log(`carrying the bucket (${n}), running: ${speed.toFixed(2)} m/s; the goose ${GOOSE.speed} m/s`);
            expect(speed).toBeGreaterThan(GOOSE.speed);
            // on to the end and wait there: it gives up
            go(-4, 5.8, { moveZ: 1, sprint: true }, S(2));
            go(-4, 5.8, {}, S(8));
            expect(g.peckTick, `${n} carrying`).toBe(-1);
            expect(g.phase === GOOSE_PHASE.home || g.phase === GOOSE_PHASE.idle).toBe(true);
            // still in hand (one of them: running together, a grip can slip on the way)
            expect(s.physics.holders(s.bucket.id)).toBeGreaterThan(0);
            expect(ends(s), `${n} carrying`).toEqual(['goose: outrun']);
        }
    }, 120_000);

    it('the worst peck: the bearer on the bank’s edge, the creek behind, the goose coming from the yard; nobody and nothing goes in', () => {
        const { s, pl } = holding();
        const g = s.hazards.goose!;
        // walk to the very edge of the bank, between the goose's patch and the water, and turn to it
        const edge = { x: GOOSE_PATCH.x, z: 0.85 };
        pl.walkTo(edge.x, edge.z, 0.2);
        pl.lookAt(GOOSE_PATCH.x, s.player.y + EYE_HEIGHT - 0.4, GOOSE_PATCH.z + 2, 10);
        expect(g.tellTick).toBeGreaterThan(0);
        const at = { x: pl.p.x, z: pl.p.z };
        for (let i = 0; i < S(10) && g.peckTick < 0; i++) pl.step();
        expect(g.peckTick).toBeGreaterThan(0);
        pl.step({}, S(3));
        // the bearer was not moved, did not fall in; the bucket did not go in
        expect(Math.hypot(pl.p.x - at.x, pl.p.z - at.z)).toBeLessThan(0.05);
        expect(s.events.some((e) => e.kind === 'fell' || e.kind === 'recovered')).toBe(false);
        expect(s.bucket.pose.p.y).toBeGreaterThan(timberYardLevel.water.y);
        expect(s.bucket.pose.p.z).toBeGreaterThan(0.5);
    }, 120_000);

    it('counterplay: distract it: while player 1 carries the bucket away, player 2 runs at the goose; it turns on them for 4 s, harmlessly, then goes home; no peck', () => {
        const { s, pl } = holding();
        s.setSlotActive(1, true);
        // player 2 stands on the yard, east of the stump
        s.placePlayer(BUCKET_STUMP.x + 3, BUCKET_STUMP.z + 1.5, 0, 1);
        const g = s.hazards.goose!;
        provoke(s, pl);
        const p2 = new Player(s, 1);
        const both = (c0: Partial<PlayerCommand>, c1: Partial<PlayerCommand>) =>
            s.step(
                { ...neutralCommand(s.tick, pl.yaw, pl.pitch), ...c0 },
                { ...neutralCommand(s.tick, p2.yaw, p2.pitch), ...c1 }
            );
        // player 1 walks off towards the bridge; player 2 runs at the goose
        const bridge = { x: BRIDGE_X + 1, z: 2.2 };
        let decoyTick = -1;
        for (let i = 0; i < S(12); i++) {
            pl.yaw = Math.atan2(-(bridge.x - pl.p.x), -(bridge.z - pl.p.z));
            p2.yaw = Math.atan2(-(g.x - p2.p.x), -(g.z - p2.p.z));
            const near = Math.hypot(g.x - p2.p.x, g.z - p2.p.z) < 1;
            both(
                { moveZ: Math.hypot(bridge.x - pl.p.x, bridge.z - pl.p.z) > 0.5 ? 1 : 0 },
                { moveZ: near ? 0 : 1, sprint: true }
            );
            if (decoyTick < 0 && g.phase === GOOSE_PHASE.distracted) decoyTick = s.tick;
        }
        expect(decoyTick).toBeGreaterThan(0);
        expect(texts(s)).toContain(GOOSE_DECOY);
        expect(g.peckTick).toBe(-1);
        expect(s.physics.heldIdOf(0)).toBe(s.bucket.id);
        untilHome(pl);
        expect(g.phase).toBe(GOOSE_PHASE.idle);
        expect(g.peckTick).toBe(-1);
        expect(ends(s)).toEqual(['goose: distracted']);
    }, 120_000);

    it('the budget: not in the quiet start, at most twice a run, a minute apart; a run reset puts it home and it comes again', () => {
        // in the quiet start: carrying the bucket right past it brings nothing
        const early = new LabSim({ level: timberYardLevel });
        early.runTo(60);
        early.fpActive = true;
        early.placePlayer(BUCKET_STUMP.x, BUCKET_STUMP.z + 1, 0);
        const e = new Player(early);
        e.step({}, 20);
        expect(e.grabBucket()).toBe(true);
        e.walkTo(GOOSE_PATCH.x - 2, GOOSE_PATCH.z + 1.5);
        expect(early.tick).toBeLessThan(S(HAZARD.graceS));
        expect(early.hazards.goose!.tellTick).toBe(-1);
        expect(early.goose.visible).toBe(true);

        const { s, pl } = holding();
        const g = s.hazards.goose!;
        provoke(s, pl);
        pl.step({ grab: true });
        untilHome(pl);
        expect(g.count).toBe(1);
        // back with the bucket at once: the cooldown holds it
        expect(pl.grabBucket()).toBe(true);
        pl.walkTo(GOOSE_PATCH.x - 2, GOOSE_PATCH.z + 1.5);
        pl.step({}, S(5));
        expect(g.count).toBe(1);
        expect(g.phase).toBe(GOOSE_PHASE.idle);
        // a minute on, it comes again; then never a third time
        pl.step({ grab: true });
        pl.step({}, S(GOOSE.cooldownS));
        expect(pl.grabBucket()).toBe(true);
        pl.step({ moveZ: 1 }, 5);
        for (let i = 0; i < S(3) && g.count < 2; i++) pl.step();
        expect(g.count).toBe(2);
        pl.step({ grab: true });
        untilHome(pl);
        pl.step({}, S(GOOSE.cooldownS) + S(HAZARD.safeS));
        expect(pl.grabBucket()).toBe(true);
        pl.step({}, S(3));
        expect(g.count).toBe(2);
        expect(g.phase).toBe(GOOSE_PHASE.idle);

        // a run reset: home, and it comes again
        s.reset();
        expect(g.count).toBe(0);
        expect(g.phase).toBe(GOOSE_PHASE.idle);
        expect(g.x).toBe(GOOSE_PATCH.x);
        expect(g.z).toBe(GOOSE_PATCH.z);
    }, 300_000);

    it('the same commands give the same goose (deterministic)', () => {
        const run = () => {
            const { s, pl } = holding();
            provoke(s, pl);
            const g = s.hazards.goose!;
            for (let i = 0; i < S(6); i++) {
                pl.yaw = Math.atan2(-(g.x - pl.p.x), -(g.z - pl.p.z)) + 0.3;
                pl.step({ moveZ: 1 });
            }
            const b = s.bucket.pose;
            return {
                tick: s.tick,
                g: [g.x, g.z, g.yaw, g.phase, g.peckTick],
                b: [b.p.x, b.p.y, b.p.z],
                w: s.water.volume
            };
        };
        expect(run()).toEqual(run());
    }, 120_000);

    it('in the Valley too: its patch on the Timber Yard bank by the bucket, and it never goes into the creek', () => {
        const { s, pl } = holding(valleyLevel);
        const g = s.hazards.goose!;
        const home = worldToYard(g.x, g.z);
        expect(home.x).toBeCloseTo(GOOSE_PATCH.x, 6);
        expect(home.z).toBeCloseTo(GOOSE_PATCH.z, 6);
        provoke(s, pl);
        // walk off towards the creek with it, over the bank's edge and along the water
        const target = yardToWorld(BRIDGE_X + 4, -0.5);
        let driest = Infinity;
        for (let i = 0; i < S(10); i++) {
            pl.yaw = Math.atan2(-(target.x - pl.p.x), -(target.z - pl.p.z));
            pl.step({ moveZ: Math.hypot(target.x - pl.p.x, target.z - pl.p.z) > 0.5 ? 1 : 0 });
            driest = Math.min(driest, worldToYard(g.x, g.z).z);
        }
        expect(driest).toBeGreaterThanOrEqual(0.8);
    }, 120_000);

    it('online: a guest carrying the bucket is chased and pecked; the guest sees the goose come and hears the honk', async () => {
        const hub = new MemoryHub();
        const host = new LabSim({ level: timberYardLevel });
        host.runTo(S(HAZARD.graceS) + 10);
        host.fpActive = true;
        const hs = await HostSession.start(hub.transport('host'), host, 'yard', 'goos');
        const ad = listGames(hub.channel('lobby', 'watcher'))[0];
        let clock = 0;
        const guestSim = new LabSim({ level: timberYardLevel });
        const gs = await GuestSession.join(hub.transport('guest'), guestSim, ad, { now: () => clock });
        const cmd: Partial<PlayerCommand> = {};
        const run = (ticks: number) => {
            for (let i = 0; i < ticks; i++) {
                gs.sendInput({ ...neutralCommand(host.tick), ...cmd });
                host.step(neutralCommand(host.tick), hs.commandFor(1), [hs.commandFor(2), hs.commandFor(3)]);
                hs.afterStep((slot) => host.interactionIds(slot));
                clock += 1000 / 60;
            }
        };
        run(10);
        // the guest (slot 1 on the host) by the stump picks up the bucket through its own commands
        host.placePlayer(BUCKET_STUMP.x, BUCKET_STUMP.z + 1, 0, 1);
        run(20);
        const b = host.bucket.pose.p;
        const me = () => host.players[1];
        cmd.yaw = Math.atan2(me().x - b.x, me().z - b.z);
        cmd.pitch = -Math.atan2(me().y + EYE_HEIGHT - (b.y + 0.2), Math.hypot(me().x - b.x, me().z - b.z));
        run(10);
        cmd.grab = true;
        run(1);
        cmd.grab = false;
        run(6);
        expect(host.physics.heldIdOf(1)).toBe(host.bucket.id);
        // and walks at the goose
        const g = host.hazards.goose!;
        for (let i = 0; i < S(12) && g.peckTick < 0; i++) {
            cmd.yaw = Math.atan2(me().x - g.x, me().z - g.z);
            cmd.pitch = 0;
            cmd.moveZ = 1;
            run(1);
        }
        cmd.moveZ = 0;
        expect(g.tellTick).toBeGreaterThan(0);
        expect(g.peckTick - g.tellTick).toBeGreaterThanOrEqual(S(GOOSE.tellS));
        expect(host.physics.heldIdOf(1)).toBe(-1);
        // (the events reach the guest a few ticks on)
        run(10);
        expect(gs.events.some((e) => e.kind === 'hazard' && e.text === GOOSE_TELL)).toBe(true);
        expect(gs.events.some((e) => e.kind === 'hazard' && e.text === GOOSE_PECK)).toBe(true);
        // the guest's copy of the goose is where the host's is
        while (host.tick % 3 !== 0) run(1);
        const anim = new Float64Array(ANIM_MAX);
        const out = pose();
        expect(guestSim.ring.sample(host.goose.slot, host.tick / 60, out, anim)).toBe(true);
        expect(Math.hypot(out.p.x - host.goose.pose.p.x, out.p.z - host.goose.pose.p.z)).toBeLessThan(0.05);
        expect(Math.hypot(out.p.x - GOOSE_PATCH.x, out.p.z - GOOSE_PATCH.z)).toBeGreaterThan(1);
        gs.leave();
        hs.stop();
    }, 120_000);
});
