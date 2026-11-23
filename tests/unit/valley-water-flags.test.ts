import { beforeAll, describe, expect, it } from 'vitest';

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
import { pose, quatFromYawPitchRoll } from '../../src/voxels/math.ts';

import { Player } from './play.ts';

beforeAll(() => initPhysics());

/**
 * The Valley's flags want water in the bucket (FLAG_LITRES): a thrown bucket lands with its water
 * gone, so throwing it over a crossing no longer completes the stage. Players act by input (the
 * Player helper); levels are set up by placing things (where the run is, beams across a gap).
 */

const hAt = (u: number, t: number) => {
    const w = routeToWorld(u, t);
    return valleyHeight(w.x, w.z);
};

/**
 * The gaps along the road at a crossing: runs of ground well below its rims (the crevasse's bed is
 * at the fall line itself, so "below the fall line" would miss its edges).
 */
function gapsAt(cu: number): [number, number][] {
    const t = roadT(cu);
    const rims = Math.min(hAt(cu - 6, t), hAt(cu + 6, t));
    const gaps: [number, number][] = [];
    let start = NaN;
    for (let u = cu - 6; u <= cu + 6; u += 0.02) {
        const low = hAt(u, t) < Math.min(rims, valleyLevel.rules!.fallY + 1) - 0.5;
        if (low && Number.isNaN(start)) start = u;
        if (!low && !Number.isNaN(start)) {
            gaps.push([start, u]);
            start = NaN;
        }
    }
    if (cu === GORGE.u) {
        const [a, b] = gaps.pop()!;
        gaps.push([a, GORGE.u - GORGE.pierHalfU], [GORGE.u + GORGE.pierHalfU, b]);
    }
    return gaps;
}

/** Two beams side by side over each gap of a crossing, along the road (the bridge, placed). */
function bridge(s: LabSim, cu: number, names: string[]): void {
    const t = roadT(cu);
    let n = 0;
    for (const [a, b] of gapsAt(cu)) {
        const rim = Math.max(hAt(a - 0.3, t), hAt(b + 0.3, t));
        for (const dt of [-0.11, 0.11]) {
            const w = routeToWorld((a + b) / 2, t + dt);
            const name = names[n++];
            const e = s.entities.find((x) => x.name === name)!;
            s.physics.place(e.id, {
                p: { x: w.x, y: rim + 0.2, z: w.z },
                q: quatFromYawPitchRoll(ROUTE_YAW + Math.PI / 2, Math.PI / 2, 0)
            });
        }
    }
    for (let i = 0; i < 120; i++) s.step(neutralCommand(s.tick));
}

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
        pl.step({}, 4);
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

describe('the bucket passes hand to hand only between beavers standing close', () => {
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

    it('rim → a beaver on the pier → the far rim: the one on the pier can’t take it (measured: before, all 10 L got over)', () => {
        const s = at(3);
        const [a, b, c] = crew(s, 3);
        stand(a, 81.85, 0);
        stand(b, 84.75, 0, false, 3.97);
        stand(c, 88.15, 0, false);
        expect(s.players[1].y, 'on the pier').toBeGreaterThan(3.85);
        const bw = routeToWorld(80.8, 0);
        s.physics.place(s.bucket.id, pose(bw.x, 3.85, bw.z));
        a.step({}, 30);
        expect(take(a)).toBe(true);
        const f = routeToWorld(90, 0);
        a.lookAt(f.x, s.player.y + EYE_HEIGHT, f.z, 20);
        a.pitch = -0.2;
        a.step({}, 60);
        expect(take(b), 'the beaver on the pier takes it').toBe(false);
        expect(hints(s)).toContain(HANDOVER_TEXT);
        expect(take(c), 'the far rim reaches it').toBe(false);
        expect(holds(s, 0)).toBe(true);
        expect(s.progress.step).toBe(3);
    }, 60_000);

    for (const [name, cu, stage] of [
        ['the culvert', DITCH.u, 2],
        ['the crevasse', CREVASSE.u, 5]
    ] as const)
        it(`${name}: handed over from the very rim edge to the very far edge, it can’t be reached`, () => {
            const s = at(stage);
            const [a, b] = crew(s, 2);
            const [g0, g1] = [gapsAt(cu)[0][0], gapsAt(cu).at(-1)![1]];
            const t = roadT(cu);
            stand(a, g0 - 0.25, t);
            stand(b, g1 + 0.25, t, false);
            const bw = routeToWorld(g0 - 1.2, t);
            s.physics.place(s.bucket.id, pose(bw.x, valleyHeight(bw.x, bw.z) + 0.05, bw.z));
            a.step({}, 30);
            expect(take(a)).toBe(true);
            const f = routeToWorld(g1 + 3, t);
            a.lookAt(f.x, s.player.y + EYE_HEIGHT, f.z, 20);
            a.pitch = -0.1;
            a.step({}, 60);
            expect(take(b)).toBe(false);
        }, 60_000);

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
        expect(take(g)).toBe(false);
        g.step({}, 20);
        expect(holds(host, 0)).toBe(true);
        expect(gs.hud[1]?.held).toBe(-1);
        expect(gs.events.some((e) => e.text === HANDOVER_TEXT)).toBe(true);
        gs.leave();
        hs.stop();
    }, 120_000);
});
