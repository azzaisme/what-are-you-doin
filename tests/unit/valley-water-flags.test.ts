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
    roadT,
    routeT,
    routeToWorld,
    routeU,
    valleyHeight,
    valleyLevel
} from '../../src/levels/valley.ts';
import { neutralCommand } from '../../src/sim/commands.ts';
import { EYE_HEIGHT, LabSim } from '../../src/sim/lab-sim.ts';
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
});
