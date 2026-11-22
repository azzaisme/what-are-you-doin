/**
 * Epic 7 gate, played: everything a player does here goes through player commands (look, walk,
 * grab, pour, let go). Setup only says where a player starts.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { BUCKET_LITRES } from '../../src/assets/props.ts';
import { BUCKET_STUMP, YARD_GOAL, timberYardLevel } from '../../src/levels/timber-yard.ts';
import { SUMMIT_U, VALLEY_STAGES, roadT, routeToWorld, valleyHeight, valleyLevel } from '../../src/levels/valley.ts';
import { GuestSession, HostSession, listGames } from '../../src/net/session.ts';
import { MemoryHub } from '../../src/net/transport.ts';
import { ACTION_DROP, neutralCommand } from '../../src/sim/commands.ts';
import type { PlayerCommand } from '../../src/sim/commands.ts';
import { EYE_HEIGHT, LabSim } from '../../src/sim/lab-sim.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { WATER } from '../../src/sim/water.ts';
import { pose } from '../../src/voxels/math.ts';

import { Player } from './play.ts';

beforeAll(() => initPhysics());

const yard = () => new LabSim({ level: timberYardLevel });

/** Player 1 in first person, standing a metre south of the bucket's stump, holding the bucket. */
function pickUp(s: LabSim): Player {
    s.step(neutralCommand(0));
    s.fpActive = true;
    s.placePlayer(BUCKET_STUMP.x, BUCKET_STUMP.z + 1, 0);
    const pl = new Player(s);
    pl.step({}, 20);
    expect(pl.grabBucket()).toBe(true);
    pl.lookAt(BUCKET_STUMP.x, s.player.y + EYE_HEIGHT, BUCKET_STUMP.z - 3, 30);
    pl.step({}, 60);
    return pl;
}

/** Walks round to the east of the stump (the butt stands west of it) and faces the tap. */
function toTap(pl: Player): void {
    pl.walkTo(BUCKET_STUMP.x + 2.2, BUCKET_STUMP.z + 1.5);
    pl.walkTo(BUCKET_STUMP.x + 1.5, BUCKET_STUMP.z);
    pl.lookAt(BUCKET_STUMP.x, pl.s.player.y + EYE_HEIGHT - 0.6, BUCKET_STUMP.z, 30);
}

/** Pours the held bucket out until (nearly) empty, then stops. */
function pourOut(pl: Player): void {
    pl.togglePour();
    for (let i = 0; i < 900 && pl.s.water.volume > 0.3; i++) pl.step();
    pl.step({}, 60);
    pl.togglePour();
    pl.step({}, 90);
}

describe('refilling, played (#63)', () => {
    it('pour it out, hold it under the yard tap: it fills from the butt, to full, once per fill', () => {
        const s = yard();
        const pl = pickUp(s);
        const butt = s.water.sources[0];
        // pour it away on the yard
        pl.walkTo(BUCKET_STUMP.x - 3, BUCKET_STUMP.z + 2);
        pourOut(pl);
        const before = s.water.volume;
        expect(before).toBeLessThan(0.3);
        expect(butt.litres).toBe(40);
        // somewhere else it stays empty
        pl.step({}, 120);
        expect(s.water.volume).toBeCloseTo(before, 6);
        // back to the stump: hold it under the tap
        toTap(pl);
        pl.holdOver(
            BUCKET_STUMP.x,
            BUCKET_STUMP.z,
            BUCKET_STUMP.top + 0.5,
            1200,
            () => s.water.volume >= WATER.capacity - 1e-9
        );
        expect(s.physics.heldIdOf(0)).toBe(s.bucket.id);
        expect(s.water.volume).toBeCloseTo(WATER.capacity, 6);
        expect(butt.litres).toBeCloseTo(40 - (WATER.capacity - before), 6);
        // the fill was announced once, and holding it there full takes nothing more
        pl.step({}, 2);
        expect(s.events.filter((e) => e.text.startsWith('Filled up'))).toHaveLength(1);
        const left = butt.litres;
        pl.holdOver(BUCKET_STUMP.x, BUCKET_STUMP.z, BUCKET_STUMP.top + 0.5, 120);
        expect(butt.litres).toBe(left);
        expect(Math.abs(s.water.imbalance)).toBeLessThan(1e-9);
    }, 120_000);

    it('the butt keeps a bucketful in reserve while the goal is open (top-ups are recorded)', () => {
        const s = yard();
        const pl = pickUp(s);
        const butt = s.water.sources[0];
        // five pour-and-refill rounds: the fifth would need more than the 40 L the butt holds
        for (let k = 0; k < 5; k++) {
            pl.walkTo(BUCKET_STUMP.x - 3, BUCKET_STUMP.z + 2);
            pourOut(pl);
            toTap(pl);
            pl.holdOver(
                BUCKET_STUMP.x,
                BUCKET_STUMP.z,
                BUCKET_STUMP.top + 0.5,
                1200,
                () => s.water.volume >= WATER.capacity - 1e-9
            );
            expect(s.water.volume).toBeCloseTo(WATER.capacity, 6);
            expect(Math.abs(s.water.imbalance)).toBeLessThan(1e-9);
        }
        expect(s.water.toppedUp).toBeGreaterThan(0);
        expect(butt.litres).toBeGreaterThanOrEqual(0);
        expect(s.progress.goalReached).toBe(false);
    }, 300_000);

    it('the Valley’s works tank and summit-road butt each refill a bucket held under their tap', () => {
        const s = new LabSim({ level: valleyLevel });
        s.step(neutralCommand(0));
        s.fpActive = true;
        for (const src of s.water.sources.slice(1)) {
            const d = src.def;
            // start beside the butt with the bucket at your feet (where that stage's spare waits)
            s.physics.place(s.bucket.id, pose(d.x + 1.2, valleyHeight(d.x + 1.2, d.z) + 0.05, d.z));
            s.placePlayer(d.x + 2.2, d.z, Math.PI / 2);
            const pl = new Player(s);
            pl.yaw = s.player.yaw;
            pl.step({}, 30);
            expect(pl.grabBucket()).toBe(true);
            pl.lookAt(d.x - 2, s.player.y + EYE_HEIGHT, d.z, 30);
            pl.step({}, 30);
            pourOut(pl);
            // on the sloping road a little stays in the bottom
            expect(s.water.volume).toBeLessThan(2);
            const left = src.litres;
            pl.holdOver(d.x, d.z, d.y + 0.55, 1200, () => s.water.volume >= WATER.capacity - 1e-9);
            expect(s.water.volume, d.name).toBeCloseTo(WATER.capacity, 6);
            expect(src.litres).toBeLessThan(left);
            // set it down and let go before the next butt
            pl.step({ grab: true });
            pl.step({}, 150);
        }
        expect(Math.abs(s.water.imbalance)).toBeLessThan(1e-9);
    }, 300_000);
});

describe('setting it down (#61)', () => {
    it('let go (click) and the bucket is lowered to the ground and keeps its water; Q drops it and it splashes', () => {
        const run = (letGo: Partial<PlayerCommand>) => {
            const s = yard();
            const pl = pickUp(s);
            pl.walkTo(BUCKET_STUMP.x - 3, BUCKET_STUMP.z + 2);
            pl.step(letGo);
            pl.step({}, 180);
            const q = s.bucket.pose.q;
            const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
            return { s, volume: s.water.volume, upY };
        };
        const gentle = run({ grab: true });
        const dropped = run({ action: ACTION_DROP });
        console.log(
            'set down keeps',
            gentle.volume.toFixed(2),
            'L; dropped from the hands keeps',
            dropped.volume.toFixed(2),
            'L'
        );
        expect(gentle.s.physics.heldIdOf(0)).toBe(-1);
        expect(gentle.upY).toBeGreaterThan(0.95);
        expect(gentle.volume).toBeGreaterThan(9.8);
        expect(dropped.volume).toBeLessThan(gentle.volume);
    }, 120_000);
});

describe('never unwinnable (#63, #64)', () => {
    it('lose five buckets in the creek: every spare fills under the tap, and the yard can still be won', () => {
        const s = yard();
        s.step(neutralCommand(0));
        let n = 1;
        for (let k = 0; k < 5; k++) {
            // lost: it goes over the bank into the creek
            const at = s.progress.recoveries;
            s.physics.place(s.bucket.id, pose(BUCKET_STUMP.x - 8, -0.1, -2.2));
            for (let i = 0; i < 600 && s.progress.recoveries === at; i++) s.step(neutralCommand(n++));
            expect(s.progress.recoveries).toBe(at + 1);
            // the spare is back on its stump, under the tap, and fills
            for (let i = 0; i < 300; i++) s.step(neutralCommand(n++));
            expect(s.water.volume).toBeCloseTo(WATER.capacity, 6);
            expect(Math.abs(s.water.imbalance)).toBeLessThan(1e-9);
        }
        // the sixth bucket still makes it
        s.physics.place(s.bucket.id, pose((YARD_GOAL.minX + YARD_GOAL.maxX) / 2, 0.8, -7));
        for (let i = 0; i < 180; i++) s.step(neutralCommand(n++));
        expect(s.progress.goalReached).toBe(true);
    }, 120_000);
});

describe('the flower, played (#64)', () => {
    it('carry the bucket up the summit road, pour it in the ring of stones: the valley is won, once', () => {
        const s = new LabSim({ level: valleyLevel });
        s.step(neutralCommand(0));
        // stages 1-6 (their own tests play them): the bucket rests at each checkpoint in turn
        let n = 1;
        for (let k = 0; k < VALLEY_STAGES.length - 1; k++) {
            const g = VALLEY_STAGES[k].goal;
            const x = (g.minX + g.maxX) / 2;
            const z = (g.minZ + g.maxZ) / 2;
            s.physics.place(s.bucket.id, pose(x, valleyHeight(x, z) + 0.05, z));
            for (let i = 0; i < 60; i++) s.step(neutralCommand(n++));
        }
        expect(s.progress.step).toBe(VALLEY_STAGES.length - 1);
        // the flower stage starts at the summit road, the bucket at your feet (the stage's spot)
        const st = VALLEY_STAGES[VALLEY_STAGES.length - 1];
        s.physics.place(s.bucket.id, pose(st.bucket.x, st.bucket.y + 0.02, st.bucket.z));
        s.fpActive = true;
        const start = routeToWorld(174, roadT(174));
        s.placePlayer(start.x, start.z, 0);
        const pl = new Player(s);
        pl.step({}, 30);
        for (let i = 0; i < 400 && s.water.volume < WATER.capacity - 1e-6; i++) pl.step();
        expect(pl.grabBucket()).toBe(true);
        // up the road to the ring of stones, then face the flower
        for (let u = 178; u <= 196; u += 3)
            expect(pl.walkTo(routeToWorld(u, roadT(u)).x, routeToWorld(u, roadT(u)).z, 0.6)).toBe(true);
        const stand = routeToWorld(SUMMIT_U - 2.4, 0);
        expect(pl.walkTo(stand.x, stand.z, 0.3)).toBe(true);
        const f = st.flower!;
        pl.lookAt(f.x, s.player.y + EYE_HEIGHT - 0.3, f.z, 40);
        pl.step({}, 60);
        const carried = s.water.volume;
        console.log('carried to the flower', carried.toFixed(2), 'L');
        expect(carried).toBeGreaterThan(8);
        expect(s.progress.goalReached).toBe(false);
        // pour
        pl.togglePour();
        for (let i = 0; i < 900 && !s.progress.goalReached; i++) pl.step();
        expect(s.progress.goalReached).toBe(true);
        expect(s.water.poured).toBeGreaterThan(WATER.minDelivery);
        const goals = () => s.events.filter((e) => e.kind === 'goal');
        expect(goals()).toHaveLength(1);
        expect(goals()[0].text).toContain('The flower drank');
        pl.togglePour();
        pl.step({}, 60);
        // back down to the butt for more, and pour again: welcome, but no second win
        const butt = s.water.sources[2].def;
        expect(pl.walkTo(butt.x + 0.9, butt.z + 0.9, 0.4)).toBe(true);
        pl.holdOver(butt.x, butt.z, butt.y + 0.55, 1200, () => s.water.volume >= WATER.capacity - 1e-9);
        expect(s.water.volume).toBeCloseTo(WATER.capacity, 6);
        for (let u = 178; u <= 196; u += 3) pl.walkTo(routeToWorld(u, roadT(u)).x, routeToWorld(u, roadT(u)).z, 0.6);
        pl.walkTo(stand.x, stand.z, 0.3);
        pl.lookAt(f.x, s.player.y + EYE_HEIGHT - 0.3, f.z, 40);
        const first = s.water.poured;
        pl.togglePour();
        pl.step({}, 600);
        expect(s.water.poured).toBeGreaterThan(first + 1);
        expect(goals()).toHaveLength(1);
        expect(Math.abs(s.water.imbalance)).toBeLessThan(1e-9);
    }, 600_000);
});

describe('online, played (#61)', () => {
    it('a guest picks up and pours the bucket: the host drains it, and the guest’s own snapshots show it', async () => {
        const hub = new MemoryHub();
        const host = yard();
        host.step(neutralCommand(0));
        host.fpActive = true;
        const hs = await HostSession.start(hub.transport('host'), host, 'yard', 'pour');
        let clock = 0;
        const guestSim = yard();
        const gs = await GuestSession.join(
            hub.transport('guest'),
            guestSim,
            listGames(hub.channel('lobby', 'w'))[0],
            () => clock
        );
        expect(gs.slot).toBe(1);
        // the guest's player starts a metre south of the stump (setup); from here on it is guest input
        host.placePlayer(BUCKET_STUMP.x, BUCKET_STUMP.z + 1, 0, 1);
        const guest = new Player(host, 1, (c) => {
            gs.sendInput(c);
            host.step(neutralCommand(0, host.player.yaw, host.player.pitch), hs.commandFor(1), [
                hs.commandFor(2),
                hs.commandFor(3)
            ]);
            hs.afterStep(() => ({ held: -1, target: -1, shared: false }));
            clock += 1000 / 60;
        });
        guest.step({}, 20);
        expect(guest.grabBucket()).toBe(true);
        guest.lookAt(BUCKET_STUMP.x - 2, host.players[1].y + EYE_HEIGHT, BUCKET_STUMP.z + 1, 30);
        guest.step({}, 60);
        guest.togglePour();
        expect(host.pouring[1]).toBe(true);
        guest.step({}, 120);
        guest.togglePour();
        guest.step({}, 60);
        const v = host.water.volume;
        expect(v).toBeLessThan(8);
        // the HUD value and the bucket's water drawn on the guest both come from the host
        expect(gs.water.volume).toBeCloseTo(v, 1);
        const anim = new Float64Array(10);
        expect(guestSim.ring.sample(guestSim.bucket.slot, guestSim.ring.newestTick / 60, pose(), anim)).toBe(true);
        expect(anim[BUCKET_LITRES]).toBeCloseTo(v, 1);
        gs.leave();
        hs.stop();
    }, 60_000);
});
