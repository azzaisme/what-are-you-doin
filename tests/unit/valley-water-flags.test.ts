import { beforeAll, describe, expect, it } from 'vitest';

import { BEAVER_LEAN } from '../../src/assets/beaver.ts';
import { eventSounds } from '../../src/audio/game-audio.ts';
import {
    CHECKPOINTS,
    CREVASSE,
    DITCH,
    FLAG_LITRES,
    GORGE,
    ROUTE_YAW,
    SPARE_LITRES,
    VALLEY_STAGES,
    WALL,
    roadT,
    routeT,
    routeToWorld,
    routeU,
    valleyHeight,
    valleyLevel
} from '../../src/levels/valley.ts';
import { GuestSession, HostSession, listGames } from '../../src/net/session.ts';
import { MemoryHub } from '../../src/net/transport.ts';
import { neutralCommand } from '../../src/sim/commands.ts';
import type { PlayerCommand } from '../../src/sim/commands.ts';
import { EYE_HEIGHT, HANDOVER_REACH, HANDOVER_TEXT, HEAVY_JUMP_TEXT, LabSim } from '../../src/sim/lab-sim.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { pose } from '../../src/voxels/math.ts';

import { Player } from './play.ts';
import { bridge, gapsAt } from './valley-play.ts';

beforeAll(() => initPhysics());

/**
 * The Valley's flags want water in the bucket (FLAG_LITRES): a thrown bucket lands with its water
 * gone, so throwing it over a crossing no longer completes the stage. Players act by input (the
 * Player helper); levels are set up by placing things (where the run is, beams across a gap).
 */

/**
 * A Valley run at stage `step` (0-based), player 1 in first person, the bucket (still full) waiting
 * at that stage's start.
 */
function at(step: number): LabSim {
    const s = new LabSim({ level: valleyLevel, hazards: false });
    s.step(neutralCommand(0));
    s.fpActive = true;
    s.progress.step = step;
    if (step > 1) {
        const b = VALLEY_STAGES[step].bucket;
        s.physics.place(s.bucket.id, pose(b.x, b.y + 0.02, b.z));
        for (let i = 0; i < 30; i++) s.step(neutralCommand(s.tick));
    }
    return s;
}

/** Drops the bucket into a crossing's channel: it is lost and comes back at the stage start. */
function loseBucket(s: LabSim, cu: number): void {
    const before = s.progress.recoveries;
    const c = routeToWorld(cu, roadT(cu) + 6);
    s.physics.place(s.bucket.id, pose(c.x, -0.6, c.z));
    for (let i = 0; i < 400 && s.progress.recoveries === before; i++) s.step(neutralCommand(s.tick));
    expect(s.progress.recoveries).toBe(before + 1);
    for (let i = 0; i < 60; i++) s.step(neutralCommand(s.tick));
}

/** Player 1 picks up the bucket where it is (standing a metre short of it, down the road). */
function pickUpBucket(s: LabSim): Player {
    const b = s.bucket.pose.p;
    const u = routeU(b.x, b.z);
    const w = routeToWorld(u - 1.1, routeT(b.x, b.z));
    s.placePlayer(w.x, w.z, ROUTE_YAW);
    const pl = new Player(s);
    pl.yaw = ROUTE_YAW;
    pl.step({}, 20);
    expect(pl.grabBucket()).toBe(true);
    const ahead = routeToWorld(u + 4, roadT(u + 4));
    pl.lookAt(ahead.x, s.player.y + EYE_HEIGHT, ahead.z, 30);
    pl.step({}, 30);
    return pl;
}

/**
 * Walks along the road with the bucket to `u`, keeping to the road's middle line; over a crossing
 * (`cu`, within 3 m of it) straight along the bridge, which lies along the road there.
 */
function walkRoad(pl: Player, from: number, to: number, cu = NaN): void {
    const lane = (u: number) => (Math.abs(u - cu) < 3 ? roadT(cu) : roadT(u));
    for (let u = from; u < to; u += 1) {
        const next = Math.min(u + 1, to);
        const w = routeToWorld(next, lane(next));
        const ok = pl.walkTo(w.x, w.z, 0.3, 1200, 0.6);
        expect(ok, `walking up the road to u ${next.toFixed(1)}`).toBe(true);
    }
}

/** Sets the bucket down where the player stands it, and waits for the flag to judge it. */
function setDown(pl: Player): void {
    pl.step({ grab: true });
    pl.step({}, 150);
}

/** Pours the held bucket out (until under `keep` litres). */
function pourTo(pl: Player, keep: number): void {
    pl.togglePour();
    for (let i = 0; i < 1500 && pl.s.water.volume > keep; i++) pl.step();
    pl.togglePour();
    pl.step({}, 20);
}

/**
 * The throw cheat at a crossing: player 1 stands on the near rim with the (emptied or spare) bucket
 * and throws it over; player 2, waiting on the far side, picks it up and sets it down at the flag.
 * Returns the litres it landed with and whether it went over.
 */
function throwOver(s: LabSim, pl: Player, cu: number, stage: number): { over: boolean; litres: number } {
    const near = gapsAt(cu)[0][0];
    const far = gapsAt(cu).at(-1)![1];
    const t = roadT(cu);
    walkRoad(pl, routeU(s.player.x, s.player.z), near - 0.6);
    const aim = routeToWorld(far + 4, t);
    pl.lookAt(aim.x, s.player.y + EYE_HEIGHT, aim.z, 30);
    pl.pitch = 0.6;
    pl.step({}, 20);
    pl.step({ throw: true });
    pl.step({}, 240);
    const b = s.bucket.pose.p;
    const over = routeU(b.x, b.z) > far && b.y > -0.2;
    const litres = s.water.volume;
    if (over) {
        // player 2 brings it to the flag
        s.setSlotActive(1, true);
        // (walking round it until it can be picked up: it may lie tipped on the slope)
        const p2 = new Player(s, 1);
        let got = false;
        for (const [du, dt] of [
            [-1.1, 0],
            [1.1, 0],
            [0, -1.1],
            [0, 1.1]
        ]) {
            const bb = s.bucket.pose.p;
            const w = routeToWorld(routeU(bb.x, bb.z) + du, routeT(bb.x, bb.z) + dt);
            s.placePlayer(w.x, w.z, ROUTE_YAW, 1);
            p2.yaw = ROUTE_YAW;
            p2.step({}, 20);
            if ((got = p2.grabBucket())) break;
        }
        expect(got, 'player 2 picks up the thrown bucket').toBe(true);
        const g = CHECKPOINTS[stage];
        const flag = routeToWorld(g.u, g.t);
        expect(p2.walkTo(flag.x, flag.z, 0.5, 2400, 0.7)).toBe(true);
        setDown(p2);
    }
    return { over, litres };
}

const dryText = (s: LabSim) => s.events.filter((e) => e.kind === 'water').map((e) => e.text);

describe('the Valley’s flags want water in the bucket (an existing cheat closed)', () => {
    it('every flag past the yard wants 1 L; the spare waits with 3 L where there is no water nearby', () => {
        expect(VALLEY_STAGES[0].minLitres).toBeUndefined();
        for (const st of VALLEY_STAGES.slice(1, 6)) expect(st.minLitres, st.name).toBe(FLAG_LITRES);
        expect(VALLEY_STAGES.filter((st) => st.spareLitres).map((st) => st.name)).toEqual([
            'Forest Road',
            'Gorge',
            'Mountain Approach'
        ]);
        expect(SPARE_LITRES).toBeGreaterThan(FLAG_LITRES);
    });

    it('Shallow Creek: the bucket emptied and thrown over lands across, but the flag does not count it', () => {
        const s = at(1);
        // the bucket waits on its stump; take it down the road to the creek
        const pl = pickUpBucket(s);
        pourTo(pl, 0.01);
        const creek = routeToWorld(-3.2, roadT(-3.2));
        expect(pl.walkTo(creek.x, creek.z, 0.4, 2400, 0.7)).toBe(true);
        const aim = routeToWorld(8, 0);
        pl.lookAt(aim.x, s.player.y + EYE_HEIGHT, aim.z, 30);
        pl.pitch = 0.6;
        pl.step({}, 20);
        pl.step({ throw: true });
        pl.step({}, 240);
        const b = s.bucket.pose.p;
        expect(routeU(b.x, b.z), 'it went over the creek').toBeGreaterThan(2.5);
        expect(s.water.volume).toBeLessThan(FLAG_LITRES);
        // player 2 on the far bank brings it to the flag: it is not enough
        s.setSlotActive(1, true);
        // (walking round it until it can be picked up: it may lie tipped on the slope)
        const p2 = new Player(s, 1);
        let got = false;
        for (const [du, dt] of [
            [-1.1, 0],
            [1.1, 0],
            [0, -1.1],
            [0, 1.1]
        ]) {
            const bb = s.bucket.pose.p;
            const w = routeToWorld(routeU(bb.x, bb.z) + du, routeT(bb.x, bb.z) + dt);
            s.placePlayer(w.x, w.z, ROUTE_YAW, 1);
            p2.yaw = ROUTE_YAW;
            p2.step({}, 20);
            if ((got = p2.grabBucket())) break;
        }
        expect(got, 'player 2 picks up the thrown bucket').toBe(true);
        const flag = routeToWorld(CHECKPOINTS[1].u, CHECKPOINTS[1].t);
        expect(p2.walkTo(flag.x, flag.z, 0.5, 2400, 0.7)).toBe(true);
        setDown(p2);
        expect(s.progress.step).toBe(1);
        expect(dryText(s).some((t) => t.includes('needs at least 1 L'))).toBe(true);
    }, 180_000);

    it('the culvert: lost, the spare comes back with 3 L; thrown over it lands nearly empty and does not count', () => {
        const s = at(2);
        loseBucket(s, DITCH.u);
        expect(s.water.volume).toBe(SPARE_LITRES);
        expect(s.events.some((e) => e.text.includes(`A spare bucket (${SPARE_LITRES} L)`))).toBe(true);
        const pl = pickUpBucket(s);
        const r = throwOver(s, pl, DITCH.u, 2);
        expect(r.over, 'it went over the culvert').toBe(true);
        expect(r.litres).toBeLessThan(FLAG_LITRES);
        expect(s.progress.step).toBe(2);
    }, 240_000);

    it('the culvert: the 3 L spare carried over the built crossing completes the stage', () => {
        const s = at(2);
        loseBucket(s, DITCH.u);
        bridge(s, DITCH.u, ['beam-2', 'beam-3']);
        const pl = pickUpBucket(s);
        // (the spare, with its 3 L, in the beaver's hands before the walk)
        expect(s.water.volume).toBeCloseTo(SPARE_LITRES, 1);
        walkRoad(pl, routeU(s.player.x, s.player.z), CHECKPOINTS[2].u, DITCH.u);
        setDown(pl);
        expect(s.water.volume).toBeGreaterThan(FLAG_LITRES);
        expect(s.progress.step).toBe(3);
        expect(s.progress.falls).toBe(0);
    }, 240_000);

    it('the gorge: the empty bucket thrown from the rim gets over; the 1 L flag does not count it', () => {
        const s = at(3);
        const pl = pickUpBucket(s);
        pourTo(pl, 0.01);
        const r = throwOver(s, pl, GORGE.u, 3);
        // (measured: it does get over the gorge in one throw, pier and all)
        expect(r.over).toBe(true);
        expect(r.litres).toBeLessThan(FLAG_LITRES);
        expect(s.progress.step).toBe(3);
    }, 240_000);

    it('the gorge: lost, the 3 L spare carried over the built spans (to the pier and on) completes the stage', () => {
        const s = at(3);
        loseBucket(s, GORGE.u);
        expect(s.water.volume).toBe(SPARE_LITRES);
        bridge(s, GORGE.u, ['beam-5', 'beam-6', 'beam-7', 'beam-8']);
        const pl = pickUpBucket(s);
        walkRoad(pl, routeU(s.player.x, s.player.z), CHECKPOINTS[3].u, GORGE.u);
        setDown(pl);
        expect(s.water.volume).toBeGreaterThan(FLAG_LITRES);
        expect(s.progress.step).toBe(4);
        expect(s.progress.falls).toBe(0);
    }, 240_000);

    it('the crevasse: emptied and thrown over, it does not count; carried over the built crossing, it does', () => {
        const a = at(5);
        let pl = pickUpBucket(a);
        pourTo(pl, 0.01);
        const r = throwOver(a, pl, CREVASSE.u, 5);
        expect(r.over).toBe(true);
        expect(r.litres).toBeLessThan(FLAG_LITRES);
        expect(a.progress.step).toBe(5);

        const b = at(5);
        bridge(b, CREVASSE.u, ['beam-9', 'beam-10']);
        pl = pickUpBucket(b);
        walkRoad(pl, routeU(b.player.x, b.player.z), CHECKPOINTS[5].u, CREVASSE.u);
        setDown(pl);
        expect(b.water.volume).toBeGreaterThan(FLAG_LITRES);
        expect(b.progress.step).toBe(6);
        expect(b.progress.falls).toBe(0);
    }, 300_000);

    it('Old Industrial Works, alone by input: set on a crate, lifted from the top of the wall, it keeps its water', () => {
        // (the stage's own building, placed: a 1-then-2 crate stair against the wall, and one crate
        // beside it to set the bucket on; the lower yard is 1.5 m below the upper one)
        const s = at(4);
        const crate = (n: number, u: number, t: number, level: number) => {
            const w = routeToWorld(u, t);
            const e = s.entities.find((x) => x.name === `crate-${n}`)!;
            s.physics.place(e.id, pose(w.x, WALL.low + 0.26 + level * 0.5, w.z));
        };
        const su = WALL.u - 0.42;
        crate(0, su - 0.5, 0, 0);
        crate(1, su, 0, 0);
        crate(2, su, 0, 1);
        crate(3, su, 1, 0);
        for (let i = 0; i < 60; i++) s.step(neutralCommand(s.tick));
        // the bucket, full, in the lower yard by the crates
        const bw = routeToWorld(su - 1, 1);
        s.physics.place(s.bucket.id, pose(bw.x, WALL.low + 0.02, bw.z));
        const st = routeToWorld(su - 2.1, 1);
        s.placePlayer(st.x, st.z, ROUTE_YAW);
        const pl = new Player(s);
        pl.yaw = ROUTE_YAW;
        pl.step({}, 40);
        expect(pl.grabBucket()).toBe(true);
        // set down on the crate by the wall (lowered from the hands until it rests)
        const cw = routeToWorld(su, 1);
        pl.lookAt(cw.x, WALL.low + 1, cw.z, 20);
        const by = routeToWorld(su - 0.95, 1);
        pl.walkTo(by.x, by.z, 0.15, 600, 0.3);
        pl.lookAt(cw.x, WALL.low + 1, cw.z, 20);
        pl.step({}, 40);
        pl.step({ grab: true });
        for (let i = 0; i < 150 && s.physics.heldIdOf(0) >= 0; i++) pl.step();
        pl.step({}, 30);
        expect(s.bucket.pose.p.y, 'on the crate').toBeGreaterThan(WALL.low + 0.45);
        // up the stair without it, hopping each step, and onto the wall's coping
        for (const [u, y] of [
            [su - 0.5, WALL.low + 0.5],
            [su, WALL.low + 1],
            [WALL.u + 0.3, WALL.high]
        ] as const) {
            const w = routeToWorld(u, 0);
            for (
                let i = 0;
                i < 200 &&
                !(Math.abs(routeU(s.player.x, s.player.z) - u) < 0.15 && s.player.y > y - 0.05 && s.player.grounded);
                i++
            ) {
                const dx = w.x - s.player.x;
                const dz = w.z - s.player.z;
                pl.yaw = Math.atan2(-dx, -dz);
                pl.step({
                    moveZ: Math.min(0.6, Math.hypot(dx, dz) * 2),
                    jump: s.player.grounded && s.player.y < y - 0.2 && i % 10 === 0
                });
            }
            pl.step({}, 20);
        }
        expect(s.player.y, 'on top of the wall').toBeGreaterThan(WALL.high);
        // from the edge, reach down for it and lift it up
        const edge = routeToWorld(WALL.u + 0.2, 0.8);
        pl.walkTo(edge.x, edge.z, 0.15, 600, 0.3);
        expect(pl.grabBucket(), 'reached from the top of the wall').toBe(true);
        pl.step({}, 60);
        const flag = routeToWorld(CHECKPOINTS[4].u, CHECKPOINTS[4].t);
        pl.lookAt(flag.x, s.player.y + EYE_HEIGHT, flag.z, 30);
        expect(pl.walkTo(flag.x, flag.z, 0.5, 2400, 0.5)).toBe(true);
        setDown(pl);
        // (measured: all 10 L of it)
        expect(s.water.volume).toBeGreaterThan(9);
        expect(s.progress.step).toBe(5);
        expect(s.progress.falls).toBe(0);
    }, 120_000);
});

// ---- the bucket can't jump a crossing, nor be refilled across one early, nor be relayed over the pier

const S_UP = ROUTE_YAW;
const holds = (s: LabSim, slot: number) => s.physics.heldIdOf(slot) === s.bucket.id;
const hints = (s: LabSim) => s.events.filter((e) => e.kind === 'hint').map((e) => e.text);

/** Puts player `slot` at a route-frame spot (on top of a piece at `y`, if given), facing up or down the road. */
function stand(pl: Player, u: number, t: number, up = true, y?: number): void {
    const w = routeToWorld(u, t);
    pl.s.placePlayer(w.x, w.z, up ? S_UP : S_UP + Math.PI, pl.slot);
    if (y !== undefined) {
        pl.p.y = y;
        pl.s.physics.placeCharacter(w.x, y, w.z, pl.slot);
    }
    pl.yaw = pl.p.yaw;
    pl.pitch = 0;
    pl.step({}, 30);
}

/** Players stepping together, each one's helper keeping the others still. */
function crew(s: LabSim, n: number): Player[] {
    for (let i = 1; i < n; i++) s.setSlotActive(i, true);
    const pls: Player[] = [];
    const send = (slot: number) => (c: PlayerCommand) => {
        const cs = pls.map((p) => neutralCommand(0, p.yaw, p.pitch));
        cs[slot] = c;
        s.step(cs[0], cs[1], cs.slice(2));
    };
    for (let i = 0; i < n; i++) pls.push(new Player(s, i, send(i)));
    return pls;
}

/** Takes hold of the bucket (aiming again each try, as it sways in another's hands); whether held. */
function take(pl: Player, tries = 12): boolean {
    const s = pl.s;
    const b0 = s.bucket.pose.p;
    pl.lookAt(b0.x, b0.y + 0.15, b0.z);
    for (let k = 0; k < tries && !holds(s, pl.slot); k++) {
        const b = s.bucket.pose.p;
        const p = pl.p;
        pl.yaw = Math.atan2(-(b.x - p.x), -(b.z - p.z));
        pl.pitch = Math.atan2(b.y + 0.15 - (p.y + EYE_HEIGHT), Math.hypot(b.x - p.x, b.z - p.z));
        pl.step({ grab: true });
        // (a second press would let go: wait for this one to take, a few ticks)
        for (let w = 0; w < 6 && !holds(s, pl.slot); w++) pl.step();
    }
    return holds(s, pl.slot);
}

/** A sprint along the road at a crossing, jumping at each gap's near edge; how it went. */
function sprintJump(pl: Player, cu: number): { over: boolean; maxRise: number; heldAirborne: number } {
    const s = pl.s;
    const g = gapsAt(cu);
    const t = roadT(cu);
    const far = g[g.length - 1][1];
    const rim = valleyHeight(routeToWorld(g[0][0] - 0.5, t).x, routeToWorld(g[0][0] - 0.5, t).z);
    let maxRise = 0;
    let heldAirborne = 0;
    for (let i = 0; i < 60 * 5; i++) {
        const u = routeU(pl.p.x, pl.p.z);
        const w = routeToWorld(u + 3, t);
        pl.yaw = Math.atan2(-(w.x - pl.p.x), -(w.z - pl.p.z));
        const edge = g.some(([a]) => u > a - 0.35 && u < a);
        pl.step({ moveZ: u > far + 2 ? 0 : 1, sprint: true, jump: edge });
        maxRise = Math.max(maxRise, pl.p.y - rim);
        if (holds(s, pl.slot) && !pl.p.grounded && pl.p.vy > 0.5) heldAirborne++;
    }
    return { over: routeU(pl.p.x, pl.p.z) > far && pl.p.y > rim - 1, maxRise, heldAirborne };
}

describe('beavers can jump the crossings; the bucket can’t (no jumping while holding it)', () => {
    for (const [name, cu, stage] of [
        ['the culvert', DITCH.u, 2],
        ['the gorge (by the pier)', GORGE.u, 3],
        ['the crevasse', CREVASSE.u, 5]
    ] as const)
        it(`${name}: a beaver sprint-jumps it with no bridge; holding the bucket, the jump is refused`, () => {
            // (measured before the rule: with the full bucket it got over with 0.05 to 1.09 L)
            const a = at(stage);
            const [p1] = crew(a, 1);
            stand(p1, gapsAt(cu)[0][0] - 4, roadT(cu));
            const free = sprintJump(p1, cu);
            expect(free.over, 'the beaver alone gets over').toBe(true);
            expect(a.progress.falls).toBe(0);

            const b = at(stage);
            const [p2] = crew(b, 1);
            const g0 = gapsAt(cu)[0][0];
            const w = routeToWorld(g0 - 3, roadT(cu));
            b.physics.place(b.bucket.id, pose(w.x, valleyHeight(w.x, w.z) + 0.05, w.z));
            stand(p2, g0 - 4.1, roadT(cu));
            expect(p2.grabBucket()).toBe(true);
            const r = sprintJump(p2, cu);
            expect(r.heldAirborne, 'ticks rising off the ground holding the bucket').toBe(0);
            const bu = routeU(b.bucket.pose.p.x, b.bucket.pose.p.z);
            expect(bu, 'the bucket did not get over').toBeLessThan(gapsAt(cu).at(-1)![1]);
            expect(b.progress.step).toBe(stage);
            // told once, however many presses
            expect(hints(b).filter((t) => t === HEAVY_JUMP_TEXT)).toHaveLength(1);
        }, 120_000);

    it('co-carriers can’t jump with it either; let go, and the jump works again', () => {
        const s = at(2);
        const [a, b] = crew(s, 2);
        const t = roadT(20);
        const w = routeToWorld(21, t);
        s.physics.place(s.bucket.id, pose(w.x, valleyHeight(w.x, w.z) + 0.05, w.z));
        stand(a, 20, t - 0.35);
        stand(b, 20, t + 0.35);
        expect(a.grabBucket()).toBe(true);
        a.step({}, 40);
        expect(take(b)).toBe(true);
        expect(s.physics.holders(s.bucket.id)).toBe(2);
        const y0 = s.players[1].y;
        let rise = 0;
        for (let i = 0; i < 40; i++) {
            b.step({ jump: i % 10 === 0 });
            rise = Math.max(rise, s.players[1].y - y0);
        }
        expect(rise, 'the co-carrier stays on the ground').toBeLessThan(0.05);
        expect(hints(s)).toEqual([HEAVY_JUMP_TEXT]);
        // let go: a jump again
        b.step({ grab: true });
        b.step({}, 20);
        expect(holds(s, 1)).toBe(false);
        const y1 = s.players[1].y;
        rise = 0;
        b.step({ jump: true });
        for (let i = 0; i < 30; i++) {
            b.step();
            rise = Math.max(rise, s.players[1].y - y1);
        }
        expect(rise).toBeGreaterThan(0.5);
    }, 60_000);

    it('a refused jump is seen and heard: a dip in the body and a knock, not only the toast', () => {
        const run = (press: boolean) => {
            const s = at(2);
            const [p1] = crew(s, 1);
            const t = roadT(20);
            const w = routeToWorld(21, t);
            s.physics.place(s.bucket.id, pose(w.x, valleyHeight(w.x, w.z) + 0.05, w.z));
            stand(p1, 19.9, t);
            expect(p1.grabBucket()).toBe(true);
            p1.step({}, 60);
            const lean: number[] = [];
            p1.step({ jump: press });
            for (let i = 0; i < 30; i++) {
                p1.step();
                lean.push(s.avatars[0].anim[BEAVER_LEAN]);
            }
            return { lean, s };
        };
        const still = run(false);
        const pressed = run(true);
        const dip = Math.max(...pressed.lean.map((v, i) => Math.abs(v - still.lean[i])));
        // the body dips forward (the landing overlay, small), and the guest sees it: it is the avatar's
        // own animation channel, sent in the snapshots like the rest of the body
        expect(dip, 'the dip in the body’s lean').toBeGreaterThan(0.05);
        expect(hints(pressed.s)).toEqual([HEAVY_JUMP_TEXT]);
        // the toast's event sounds a knock
        expect(eventSounds('hint', HEAVY_JUMP_TEXT).map((x) => x.name)).toEqual(['thud']);
    }, 60_000);

    it('no taking hold of the bucket in mid-air: on the way up or the way down, refused; on the ground, fine', () => {
        // (measured before: jumped empty-handed and grabbed on the first airborne tick, it went over
        // the culvert and the crevasse)
        for (const when of ['rising', 'falling']) {
            const s = at(2);
            const [p1] = crew(s, 1);
            const t = roadT(20);
            const w = routeToWorld(20.9, t);
            s.physics.place(s.bucket.id, pose(w.x, valleyHeight(w.x, w.z) + 0.05, w.z));
            stand(p1, 19.9, t);
            const b = s.bucket.pose.p;
            p1.lookAt(b.x, b.y + 0.15, b.z);
            p1.step({ jump: true });
            if (when === 'falling') while (s.player.vy > -0.5) p1.step();
            expect(s.player.grounded, `${when}: in the air`).toBe(false);
            const bb = s.bucket.pose.p;
            p1.yaw = Math.atan2(-(bb.x - s.player.x), -(bb.z - s.player.z));
            p1.pitch = Math.atan2(
                bb.y + 0.15 - (s.player.y + EYE_HEIGHT),
                Math.hypot(bb.x - s.player.x, bb.z - s.player.z)
            );
            p1.step();
            expect(s.player.grounded, `${when}: still in the air`).toBe(false);
            expect(s.interaction(0).target, `${when}: aimed at it`).toBe('bucket');
            p1.step({ grab: true });
            p1.step({}, 3);
            expect(holds(s, 0), `${when}: not taken`).toBe(false);
            expect(hints(s)).toEqual([HEAVY_JUMP_TEXT]);
            // landed, the same grab takes it
            p1.step({}, 60);
            expect(p1.grabBucket()).toBe(true);
        }
    }, 60_000);

    it('online: a guest holding the bucket can’t jump, and is told so', async () => {
        const hub = new MemoryHub();
        const host = at(2);
        const hs = await HostSession.start(hub.transport('host'), host, 'valley', 'hvyj');
        const ad = listGames(hub.channel('lobby', 'watcher'))[0];
        let clock = 0;
        const gs = await GuestSession.join(
            hub.transport('guest'),
            new LabSim({ level: valleyLevel, hazards: false }),
            ad,
            {
                now: () => clock
            }
        );
        const g: Player = new Player(host, 1, (c) => {
            gs.sendInput(c);
            host.step(neutralCommand(host.tick, host.player.yaw), hs.commandFor(1), [
                hs.commandFor(2),
                hs.commandFor(3)
            ]);
            hs.afterStep((slot) => host.interactionIds(slot));
            clock += 1000 / 60;
        });
        g.step({}, 10);
        expect(host.isSlotActive(1)).toBe(true);
        const t = roadT(20);
        const w = routeToWorld(21, t);
        host.physics.place(host.bucket.id, pose(w.x, valleyHeight(w.x, w.z) + 0.05, w.z));
        stand(g, 19.9, t);
        expect(g.grabBucket()).toBe(true);
        g.step({}, 20);
        const y0 = host.players[1].y;
        let rise = 0;
        for (let i = 0; i < 60; i++) {
            g.step({ jump: i % 15 < 2 });
            rise = Math.max(rise, host.players[1].y - y0);
        }
        expect(rise).toBeLessThan(0.05);
        expect(holds(host, 1)).toBe(true);
        expect(gs.events.some((e) => e.text === HEAVY_JUMP_TEXT)).toBe(true);
        gs.leave();
        hs.stop();
    }, 120_000);
});

/** The thrown-over bucket, picked up across by player 2 and held under a source's tap for a while. */
function refillAcross(s: LabSim, cu: number, stage: number, source: number): { litres: number; said: string[] } {
    const pl = pickUpBucket(s);
    pourTo(pl, 0.01);
    const near = gapsAt(cu)[0][0];
    const far = gapsAt(cu).at(-1)![1];
    walkRoad(pl, routeU(s.player.x, s.player.z), near - 0.6);
    const aim = routeToWorld(far + 4, roadT(cu));
    pl.lookAt(aim.x, s.player.y + EYE_HEIGHT, aim.z, 30);
    pl.pitch = 0.6;
    pl.step({}, 20);
    pl.step({ throw: true });
    pl.step({}, 240);
    expect(routeU(s.bucket.pose.p.x, s.bucket.pose.p.z), 'thrown over').toBeGreaterThan(far);
    // player 2 (who jumped over: beavers can) picks it up and takes it to the source
    s.setSlotActive(1, true);
    const p2 = new Player(s, 1);
    let got = false;
    for (const [du, dt] of [
        [-1.1, 0],
        [1.1, 0],
        [0, -1.1],
        [0, 1.1]
    ]) {
        const bb = s.bucket.pose.p;
        const w = routeToWorld(routeU(bb.x, bb.z) + du, routeT(bb.x, bb.z) + dt);
        s.placePlayer(w.x, w.z, ROUTE_YAW, 1);
        p2.yaw = ROUTE_YAW;
        p2.step({}, 20);
        if ((got = p2.grabBucket())) break;
    }
    expect(got).toBe(true);
    const d = s.water.sources[source].def;
    const by = { x: d.x + 1.6, z: d.z };
    expect(p2.walkTo(by.x, by.z, 0.4, 2400, 0.6)).toBe(true);
    p2.lookAt(d.x, d.y + 0.6, d.z, 20);
    p2.holdOver(d.x, d.z, d.y + 0.55, 600);
    const litres = s.water.volume;
    // and to the flag with it
    const g = CHECKPOINTS[stage];
    const flag = routeToWorld(g.u, g.t);
    expect(p2.walkTo(flag.x, flag.z, 0.5, 2400, 0.7)).toBe(true);
    setDown(p2);
    return { litres, said: s.events.filter((e) => e.kind === 'water').map((e) => e.text) };
}

describe('the sources past a crossing stay shut until its stage is done', () => {
    it('the Gorge: thrown over dry, it can’t be filled at the works tank (shut until the Gorge is done)', () => {
        const s = at(3);
        const r = refillAcross(s, GORGE.u, 3, 1);
        expect(r.litres).toBeLessThan(FLAG_LITRES);
        expect(r.said).toContain('The works water tank is shut until the Gorge stage is done.');
        expect(s.progress.step).toBe(3);
    }, 240_000);

    it('the crevasse: thrown over dry, it can’t be filled at the spring butt (shut until Mountain Approach is done)', () => {
        const s = at(5);
        const r = refillAcross(s, CREVASSE.u, 5, 2);
        expect(r.litres).toBeLessThan(FLAG_LITRES);
        expect(r.said).toContain('The mountain spring butt is shut until the Mountain Approach stage is done.');
        expect(s.progress.step).toBe(5);
    }, 240_000);

    it('each opens at its stage: the stage, a reset and a checkpoint all set it right', () => {
        const s = at(3);
        const [tank, spring] = s.water.sources.slice(1).map((x) => x.def);
        expect(tank.opensAt).toBe(4);
        expect(spring.opensAt).toBe(6);
        expect(VALLEY_STAGES[4].name).toBe('Old Industrial Works');
        expect(VALLEY_STAGES[6].name).toBe('Flower Summit');
        // the bucket held under the tank: shut at the Gorge, open once the Works stage has begun
        const fill = (step: number) => {
            s.progress.step = step;
            s.physics.place(s.bucket.id, pose(tank.x, tank.y + 0.25, tank.z));
            const v0 = s.water.volume;
            for (let i = 0; i < 30; i++) s.step(neutralCommand(s.tick));
            return s.water.volume - v0;
        };
        // (half a litre in it, so a refill shows)
        s.water.bucketLost(0.5);
        expect(fill(3)).toBe(0);
        expect(fill(4)).toBeGreaterThan(0.1);
        // a reset starts the run again at the yard: shut again, and said again
        s.reset();
        const before = s.events.length;
        s.physics.place(s.bucket.id, pose(tank.x, tank.y + 0.25, tank.z));
        for (let i = 0; i < 30; i++) s.step(neutralCommand(s.tick));
        expect(s.progress.step).toBe(0);
        expect(s.events.slice(before).some((e) => e.text.startsWith('The works water tank is shut'))).toBe(true);
    }, 60_000);
});

describe('told, online too', () => {
    it('a guest sees the same shut-tap message as the host', async () => {
        const hub = new MemoryHub();
        const host = at(3);
        const hs = await HostSession.start(hub.transport('host'), host, 'valley', 'shut');
        const ad = listGames(hub.channel('lobby', 'watcher'))[0];
        let clock = 0;
        const gs = await GuestSession.join(
            hub.transport('guest'),
            new LabSim({ level: valleyLevel, hazards: false }),
            ad,
            {
                now: () => clock
            }
        );
        const tick = () => {
            gs.sendInput(neutralCommand(host.tick));
            host.step(neutralCommand(host.tick, host.player.yaw), hs.commandFor(1), [
                hs.commandFor(2),
                hs.commandFor(3)
            ]);
            hs.afterStep((slot) => host.interactionIds(slot));
            clock += 1000 / 60;
        };
        for (let i = 0; i < 10; i++) tick();
        const tank = host.water.sources[1].def;
        host.physics.place(host.bucket.id, pose(tank.x, tank.y + 0.25, tank.z));
        for (let i = 0; i < 30; i++) tick();
        const text = 'The works water tank is shut until the Gorge stage is done.';
        expect(host.events.some((e) => e.text === text)).toBe(true);
        expect(gs.events.some((e) => e.text === text)).toBe(true);
        gs.leave();
        hs.stop();
    }, 60_000);

    it('the Works objective says how: set the bucket on a crate and lift it from the top', () => {
        expect(VALLEY_STAGES[4].objective).toContain('set the bucket on one and lift it up from the top');
    });
});

/**
 * Walks a beaver's placement towards a gap (dir +1 up the road, -1 down it) in 3 cm steps, standing
 * still 150 ticks at each, and leaves it at the farthest spot it stays standing on top (`top`):
 * the stable extreme edge. Returns its u.
 */
function edgeU(pl: Player, from: number, dir: number, t: number, top: number, up = dir > 0): number {
    const holds = (u: number) => {
        stand(pl, u, t, up, top + 0.15);
        pl.step({}, 150);
        return pl.p.grounded && pl.p.y > top - 0.2;
    };
    let best = from;
    for (let u = from; Math.abs(u - from) < 3 && holds(u); u += 0.03 * dir) best = u;
    // back where it last held (stepping back further if it doesn't hold the second time)
    while (!holds(best)) best -= 0.03 * dir;
    // (where it is placed: it settles a few centimetres further out)
    return best;
}

/** Puts a beaver back at a found edge (after the other's search: a perch slowly slips over thousands of ticks). */
function atEdge(pl: Player, u: number, t: number, top: number, up: boolean): void {
    stand(pl, u, t, up, top + 0.15);
    pl.step({}, 30);
    expect(pl.p.y, 'standing on top at the edge').toBeGreaterThan(top - 0.2);
}

/** Holds the bucket out over the gap: looking up (or down) the road, a little below level. */
function holdOut(pl: Player, ticks: number): void {
    const f = routeToWorld(
        routeU(pl.p.x, pl.p.z) + (Math.cos(pl.yaw - ROUTE_YAW) > 0 ? 4 : -4),
        routeT(pl.p.x, pl.p.z)
    );
    pl.lookAt(f.x, pl.p.y + EYE_HEIGHT, f.z, 20);
    pl.pitch = -0.15;
    pl.step({}, ticks);
}

/** The bucket placed as close to a gap's near edge as it stays resting on the rim (5 cm steps back). */
function restAtEdge(s: LabSim, g0: number, t: number, top: number): void {
    for (let d = 0; d < 1.5; d += 0.05) {
        const w = routeToWorld(g0 - d, t);
        s.physics.place(s.bucket.id, pose(w.x, top + 0.05, w.z));
        for (let i = 0; i < 90; i++) s.step(neutralCommand(s.tick));
        const p = s.bucket.pose.p;
        if (p.y > top - 0.2 && Math.abs(routeU(p.x, p.z) - (g0 - d)) < 0.3) return;
    }
}

/** Sets the held bucket down where it hangs (lowered until it rests). */
function setDownHere(pl: Player): void {
    pl.step({ grab: true });
    for (let n = 0; n < 150 && pl.s.physics.heldIdOf(pl.slot) >= 0; n++) pl.step();
    pl.step({}, 20);
}

/**
 * A running jump up the road along `t`, taking off at the gap's near edge `edge`, and stopping once
 * landed between `lo` and `hi`; whether it landed there.
 */
function jumpOnto(pl: Player, edge: number, t: number, lo: number, hi: number): boolean {
    for (let i = 0; i < 60 * 6; i++) {
        const u = routeU(pl.p.x, pl.p.z);
        if (pl.p.grounded && u > lo && u < hi) {
            pl.step({}, 40);
            break;
        }
        const w = routeToWorld(u + 3, t);
        pl.yaw = Math.atan2(-(w.x - pl.p.x), -(w.z - pl.p.z));
        pl.step({ moveZ: 1, sprint: true, jump: u > edge - 0.35 && u < edge });
    }
    const u = routeU(pl.p.x, pl.p.z);
    return pl.p.grounded && u > lo - 0.3 && u < hi + 0.3 && pl.p.y > WALL.low - 0.3;
}

const feetApart = (s: LabSim, i: number, j: number) =>
    Math.hypot(s.players[i].x - s.players[j].x, s.players[i].z - s.players[j].z);

describe('the bucket passes hand to hand only between beavers standing close, with ground between', () => {
    it('side by side, a hand-over works', () => {
        const s = at(2);
        const [a, b] = crew(s, 2);
        const t = roadT(20);
        const w = routeToWorld(21, t);
        s.physics.place(s.bucket.id, pose(w.x, valleyHeight(w.x, w.z) + 0.05, w.z));
        stand(a, 20, t - 0.4);
        stand(b, 21.6, t + 0.4, false);
        expect(Math.hypot(s.players[1].x - s.player.x, s.players[1].z - s.player.z)).toBeLessThan(HANDOVER_REACH);
        expect(a.grabBucket()).toBe(true);
        a.step({}, 40);
        expect(take(b)).toBe(true);
        a.step({ grab: true });
        a.step({}, 20);
        expect(holds(s, 1)).toBe(true);
        expect(hints(s)).toEqual([]);
    }, 60_000);

    it('gorge, rim cap → a beaver on the pier, at the stable edges (feet 1.7 m apart): the gap refuses it', () => {
        // (measured before the gap rule: the auditor handed it rim → pier → far rim, 10 L, and won)
        const s = at(3);
        const [a, b] = crew(s, 2);
        const near = edgeU(a, 81.6, 1, 0, WALL.low);
        const pier = edgeU(b, 85, -1, 0, WALL.low, false);
        atEdge(a, near, 0, WALL.low, true);
        atEdge(b, pier, 0, WALL.low, false);
        // (settled where the auditor measured them: near cap 82.41, pier 84.14)
        expect(routeU(s.player.x, s.player.z), 'the rim cap’s edge').toBeGreaterThan(82.3);
        expect(routeU(s.players[1].x, s.players[1].z), 'the pier’s edge').toBeLessThan(84.25);
        const bw = routeToWorld(near - 1, 0);
        s.physics.place(s.bucket.id, pose(bw.x, WALL.low + 0.05, bw.z));
        expect(take(a)).toBe(true);
        holdOut(a, 90);
        expect(feetApart(s, 0, 1), 'inside the 1.9 m reach').toBeLessThan(HANDOVER_REACH);
        expect(take(b), 'the beaver on the pier takes it').toBe(false);
        expect(hints(s)).toContain(HANDOVER_TEXT);
        expect(holds(s, 0)).toBe(true);
    }, 120_000);

    it('gorge, pier → the far rim cap, at the stable edges: the gap refuses it', () => {
        const s = at(3);
        const [b, c] = crew(s, 2);
        const pier = edgeU(b, 85, 1, 0, WALL.low);
        const far = edgeU(c, 88.4, -1, 0, WALL.low, false);
        // (the beaver on the pier 10 cm back from its very edge: turning there with the bucket, it
        // slips off; the feet are still well inside the reach)
        atEdge(b, pier - 0.1, 0, WALL.low, true);
        atEdge(c, far, 0, WALL.low, false);
        // (settled near where the auditor measured them: pier 85.86, far cap 87.59)
        expect(routeU(s.player.x, s.player.z)).toBeGreaterThan(85.65);
        expect(routeU(s.players[1].x, s.players[1].z)).toBeLessThan(87.7);
        // the bucket on the pier beside the beaver there (as if it had got there somehow)
        const bw = routeToWorld(pier - 0.6, 0.5);
        s.physics.place(s.bucket.id, pose(bw.x, WALL.low + 0.15, bw.z));
        b.step({}, 30);
        expect(take(b)).toBe(true);
        holdOut(b, 90);
        expect(feetApart(s, 0, 1)).toBeLessThan(HANDOVER_REACH);
        expect(take(c)).toBe(false);
        expect(holds(s, 0)).toBe(true);
    }, 120_000);

    for (const [name, cu, stage] of [
        ['the culvert', DITCH.u, 2],
        ['the crevasse', CREVASSE.u, 5]
    ] as const)
        it(`${name}: from the stable edge of one rim to the other's, it can’t be handed over`, () => {
            const s = at(stage);
            const [a, b] = crew(s, 2);
            const [g0, g1] = [gapsAt(cu)[0][0], gapsAt(cu).at(-1)![1]];
            const t = roadT(cu);
            const top0 = valleyHeight(routeToWorld(g0 - 1, t).x, routeToWorld(g0 - 1, t).z);
            const top1 = valleyHeight(routeToWorld(g1 + 1, t).x, routeToWorld(g1 + 1, t).z);
            const e0 = edgeU(a, g0 - 1, 1, t, top0);
            const e1 = edgeU(b, g1 + 1, -1, t, top1, false);
            atEdge(a, e0, t, top0, true);
            atEdge(b, e1, t, top1, false);
            const bw = routeToWorld(routeU(s.player.x, s.player.z) - 1, t);
            s.physics.place(s.bucket.id, pose(bw.x, valleyHeight(bw.x, bw.z) + 0.05, bw.z));
            a.step({}, 30);
            expect(take(a)).toBe(true);
            holdOut(a, 90);
            // (over the 1.9 m reach here: this one is refused by distance; the crate stacks test
            // the ground check where the feet are close)
            expect(feetApart(s, 0, 1)).toBeGreaterThan(HANDOVER_REACH);
            expect(take(b)).toBe(false);
            expect(holds(s, 0)).toBe(true);
        }, 120_000);

    it('along a built span it passes: rim → a beaver on the beams → the far rim', () => {
        const s = at(2);
        bridge(s, DITCH.u, ['beam-2', 'beam-3']);
        const [a, b, c] = crew(s, 3);
        const [g0, g1] = [gapsAt(DITCH.u)[0][0], gapsAt(DITCH.u).at(-1)![1]];
        const t = roadT(DITCH.u);
        const beam = s.entities.find((e) => e.name === 'beam-2')!.pose.p;
        stand(a, g0 - 0.3, t);
        stand(b, (g0 + g1) / 2, t, false, beam.y + 0.12);
        stand(c, g1 + 0.3, t, false);
        expect(s.players[1].y, 'on the beams').toBeGreaterThan(beam.y);
        const bw = routeToWorld(g0 - 1.3, t);
        s.physics.place(s.bucket.id, pose(bw.x, valleyHeight(bw.x, bw.z) + 0.05, bw.z));
        a.step({}, 30);
        expect(take(a)).toBe(true);
        holdOut(a, 90);
        expect(take(b), 'the beaver on the beams takes it').toBe(true);
        a.step({ grab: true });
        a.step({}, 20);
        holdOut(b, 90);
        expect(take(c), 'and hands it on to the far rim').toBe(true);
        expect(hints(s)).toEqual([]);
    }, 120_000);

    it('set down and reached for across a gap (beavers getting there by real jumps): refused at both gorge gaps', () => {
        // (measured before: set down at the near rim, taken from the pier, set down at its far edge,
        // taken from the far rim, the Gorge done with 9.95 L and no bridge)
        const s = at(3);
        const [a, b, c] = crew(s, 3);
        const t = 0.8;
        // A sets it down on the near rim's edge (standing back from it until the bucket stays on top)
        let onRim = NaN;
        for (let back = 0.6; back < 2 && !(onRim > 81.7); back += 0.1) {
            stand(a, 82.2 - back - 0.9, t);
            const bw = routeToWorld(82.2 - back - 1.7, t);
            s.physics.place(s.bucket.id, pose(bw.x, WALL.low + 0.05, bw.z));
            a.step({}, 20);
            expect(take(a)).toBe(true);
            holdOut(a, 30);
            const to = routeToWorld(82.2 - back, t);
            a.walkTo(to.x, to.z, 0.08, 600, 0.25);
            a.pitch = -0.6;
            a.step({}, 40);
            setDownHere(a);
            a.step({}, 120);
            const p = s.bucket.pose.p;
            onRim = p.y > WALL.low - 0.2 ? routeU(p.x, p.z) : NaN;
        }
        expect(holds(s, 0)).toBe(false);
        expect(onRim, 'resting at the near rim’s edge').toBeGreaterThan(81.7);
        // B jumps onto the pier, comes to its near edge and turns back to it
        // (its run beside A's line: A stands at the rim)
        stand(b, 77, -0.6);
        expect(jumpOnto(b, gapsAt(GORGE.u)[0][0], -0.6, 84.4, 85.6), 'B on the pier, by a jump').toBe(true);
        // (to the pier's near edge, on the bucket's line: where the auditor took it, u 84.30)
        expect(b.walkTo(routeToWorld(84.4, t).x, routeToWorld(84.4, t).z, 0.15, 900, 0.25)).toBe(true);
        expect(routeU(s.players[1].x, s.players[1].z)).toBeLessThan(84.5);
        expect(s.players[1].y, 'still on the pier').toBeGreaterThan(WALL.low);
        const bb = s.bucket.pose.p;
        b.lookAt(bb.x, bb.y + 0.15, bb.z);
        expect(
            s.interaction(1).target,
            `within reach of the pier (bucket u ${routeU(bb.x, bb.z).toFixed(2)}, beaver u ${routeU(s.players[1].x, s.players[1].z).toFixed(2)})`
        ).toBe('bucket');
        expect(take(b), 'taken from the pier').toBe(false);
        expect(hints(s)).toContain(HANDOVER_TEXT);
        // the far gap: the bucket on the pier's far edge (as if it had got there), C jumped to the far rim
        const pw = routeToWorld(85.5, -0.4);
        s.physics.place(s.bucket.id, pose(pw.x, WALL.low + 0.15, pw.z));
        b.step({}, 30);
        // C jumps the gorge (pier and on), then walks back to the far rim's edge, clear of the old
        // trestle's remains that hang off that rim on the other side of the road's line
        stand(c, 77, 0);
        expect(sprintJump(c, GORGE.u).over, 'C over the gorge, by jumps').toBe(true);
        // (back onto the cap with a little hop, empty-handed: walking, its edge stops a beaver)
        const w0 = routeToWorld(89.2, -0.6);
        c.walkTo(w0.x, w0.z, 0.15, 900, 0.5);
        const w1 = routeToWorld(87.9, -0.6);
        for (let i = 0; i < 240 && routeU(s.players[2].x, s.players[2].z) > 88.05; i++) {
            c.yaw = Math.atan2(-(w1.x - s.players[2].x), -(w1.z - s.players[2].z));
            const u = routeU(s.players[2].x, s.players[2].z);
            c.step({ moveZ: 0.5, jump: u < 88.7 && s.players[2].grounded });
        }
        c.step({}, 60);
        expect(routeU(s.players[2].x, s.players[2].z), 'C at the far rim’s edge').toBeLessThan(88);
        expect(s.players[2].y, 'on top').toBeGreaterThan(WALL.low - 0.1);
        const pb = s.bucket.pose.p;
        c.lookAt(pb.x, pb.y + 0.15, pb.z);
        expect(s.interaction(2).target, 'within reach of the far rim').toBe('bucket');
        expect(take(c), 'taken from the far rim').toBe(false);
        expect(s.progress.step).toBe(3);
    }, 180_000);

    for (const [name, cu, stage] of [
        ['the culvert', DITCH.u, 2],
        ['the crevasse', CREVASSE.u, 5]
    ] as const)
        it(`${name}: set down at the rim's very edge, it can't be taken from the far rim`, () => {
            const s = at(stage);
            const [, b] = crew(s, 2);
            const [g0, g1] = [gapsAt(cu)[0][0], gapsAt(cu).at(-1)![1]];
            const t = roadT(cu);
            const top0 = valleyHeight(routeToWorld(g0 - 1, t).x, routeToWorld(g0 - 1, t).z);
            const top1 = valleyHeight(routeToWorld(g1 + 1, t).x, routeToWorld(g1 + 1, t).z);
            // as close to the gap as it stays resting on the rim
            restAtEdge(s, g0, t, top0);
            expect(s.bucket.pose.p.y, 'resting on the rim').toBeGreaterThan(top0 - 0.2);
            const e1 = edgeU(b, g1 + 1, -1, t, top1, false);
            atEdge(b, e1, t, top1, false);
            const reach = Math.hypot(
                s.bucket.pose.p.x - s.players[1].x,
                s.bucket.pose.p.y - (s.players[1].y + EYE_HEIGHT),
                s.bucket.pose.p.z - s.players[1].z
            );
            expect(take(b)).toBe(false);
            // (measured: about 3 m from the far edge's eye: out of reach before any rule)
            expect(reach).toBeGreaterThan(2.6);
        }, 120_000);

    it('ordinary set-downs and pick-ups still work: at each crossing’s rim edge, and on a built bridge', () => {
        for (const [cu, stage] of [
            [DITCH.u, 2],
            [GORGE.u, 3],
            [CREVASSE.u, 5]
        ] as const) {
            const s = at(stage);
            const [a] = crew(s, 1);
            const g0 = gapsAt(cu)[0][0];
            const t = roadT(cu);
            const top0 = valleyHeight(routeToWorld(g0 - 1, t).x, routeToWorld(g0 - 1, t).z);
            const e0 = edgeU(a, g0 - 1, 1, t, top0);
            atEdge(a, e0, t, top0, true);
            const bw = routeToWorld(routeU(s.player.x, s.player.z) - 0.9, t + 0.3);
            s.physics.place(s.bucket.id, pose(bw.x, valleyHeight(bw.x, bw.z) + 0.05, bw.z));
            a.step({}, 30);
            expect(take(a), `picked up at the rim's edge (${cu})`).toBe(true);
            a.pitch = -0.5;
            a.step({}, 30);
            setDownHere(a);
            expect(holds(s, 0)).toBe(false);
            expect(take(a), `and again (${cu})`).toBe(true);
            expect(hints(s)).toEqual([]);
        }
        // on the built culvert bridge: set down on the beams, picked up there by another beaver
        const s = at(2);
        bridge(s, DITCH.u, ['beam-2', 'beam-3']);
        const [a, b] = crew(s, 2);
        const [g0, g1] = [gapsAt(DITCH.u)[0][0], gapsAt(DITCH.u).at(-1)![1]];
        const t = roadT(DITCH.u);
        const beam = s.entities.find((e) => e.name === 'beam-2')!.pose.p;
        stand(a, (g0 + g1) / 2 - 0.3, t, true, beam.y + 0.12);
        const bw = routeToWorld((g0 + g1) / 2 + 0.3, t);
        s.physics.place(s.bucket.id, pose(bw.x, beam.y + 0.2, bw.z));
        a.step({}, 40);
        expect(take(a), 'picked up on the beams').toBe(true);
        a.pitch = -0.6;
        a.step({}, 30);
        setDownHere(a);
        expect(holds(s, 0)).toBe(false);
        stand(b, g1 + 0.3, t, false);
        expect(take(b), 'and from the far rim, beside the beams it rests on').toBe(true);
        expect(hints(s)).toEqual([]);
    }, 240_000);

    it('outside the gorge too: within 1.9 m but with nothing to stand on between, refused (two crate stacks)', () => {
        // (two beavers on two stacks of two crates in the works' lower yard, 1.5 m apart: the yard
        // floor is 1 m under their feet between them)
        const s = at(4);
        const [a, b] = crew(s, 2);
        const crate = (n: number, u: number, level: number) => {
            const w = routeToWorld(u, -6);
            const e = s.entities.find((x) => x.name === `crate-${n}`)!;
            s.physics.place(e.id, pose(w.x, WALL.low + 0.26 + level * 0.5, w.z));
        };
        crate(0, 110, 0);
        crate(1, 110, 1);
        crate(2, 111.5, 0);
        crate(3, 111.5, 1);
        for (let i = 0; i < 60; i++) s.step(neutralCommand(s.tick));
        stand(a, 110, -6, true, WALL.low + 1.05);
        stand(b, 111.5, -6, false, WALL.low + 1.05);
        expect(s.player.y, 'A on its stack').toBeGreaterThan(WALL.low + 0.95);
        expect(s.players[1].y, 'B on its stack').toBeGreaterThan(WALL.low + 0.95);
        // A reaches down for the bucket beside its stack (a step down is ground) ...
        const bw = routeToWorld(110, -5.3);
        s.physics.place(s.bucket.id, pose(bw.x, WALL.low + 0.05, bw.z));
        a.step({}, 30);
        expect(take(a), 'reached down beside its own stack').toBe(true);
        holdOut(a, 40);
        // ... but can't hand it to B on the other stack
        expect(feetApart(s, 0, 1)).toBeLessThan(HANDOVER_REACH);
        expect(take(b)).toBe(false);
        expect(hints(s)).toContain(HANDOVER_TEXT);
    }, 120_000);

    it('online: a guest on the culvert’s far rim can’t take it out of the host’s hands either', async () => {
        const hub = new MemoryHub();
        const host = at(2);
        const hs = await HostSession.start(hub.transport('host'), host, 'valley', 'hndo');
        const ad = listGames(hub.channel('lobby', 'watcher'))[0];
        let clock = 0;
        const gs = await GuestSession.join(
            hub.transport('guest'),
            new LabSim({ level: valleyLevel, hazards: false }),
            ad,
            {
                now: () => clock
            }
        );
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
            guestCmd = neutralCommand(0, g.yaw, g.pitch);
            tick();
        });
        const g: Player = new Player(host, 1, (c) => {
            guestCmd = c;
            hostCmd = neutralCommand(0, a.yaw, a.pitch);
            tick();
        });
        g.step({}, 10);
        expect(host.isSlotActive(1)).toBe(true);
        const [g0, g1] = [gapsAt(DITCH.u)[0][0], gapsAt(DITCH.u).at(-1)![1]];
        const t = roadT(DITCH.u);
        stand(a, g0 - 0.25, t);
        stand(g, g1 + 0.25, t, false);
        const bw = routeToWorld(g0 - 1.2, t);
        host.physics.place(host.bucket.id, pose(bw.x, valleyHeight(bw.x, bw.z) + 0.05, bw.z));
        a.step({}, 30);
        expect(take(a)).toBe(true);
        const f = routeToWorld(g1 + 3, t);
        a.lookAt(f.x, host.player.y + EYE_HEIGHT, f.z, 20);
        a.pitch = -0.1;
        a.step({}, 60);
        expect(feetApart(host, 0, 1)).toBeGreaterThan(HANDOVER_REACH);
        expect(take(g)).toBe(false);
        g.step({}, 20);
        expect(holds(host, 0)).toBe(true);
        expect(gs.hud[1]?.held).toBe(-1);
        expect(gs.events.some((e) => e.text === HANDOVER_TEXT)).toBe(true);
        gs.leave();
        hs.stop();
    }, 120_000);
});
