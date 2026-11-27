import { beforeAll, describe, expect, it } from 'vitest';

import type { LevelDef } from '../../src/levels/level.ts';
import {
    CREVASSE,
    DITCH,
    GORGE,
    ROUTE_YAW,
    VALLEY_STAGES,
    roadT,
    routeToWorld,
    routeU,
    valleyLevel
} from '../../src/levels/valley.ts';
import { neutralCommand } from '../../src/sim/commands.ts';
import { LabSim } from '../../src/sim/lab-sim.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { pose, quatFromYawPitchRoll } from '../../src/voxels/math.ts';

import { Player } from './play.ts';
import { bridge, gapsAt, hAt } from './valley-play.ts';

beforeAll(() => initPhysics());

/**
 * A bucket that falls into a Valley gap's bed comes back (#152). The level-wide `lostY` sits at the
 * creek's water, and the culvert's, gorge's and crevasse's beds are well above it, so a bucket
 * lying down in one used to stay there for good. Now a free bucket down in a crossing's gap, well
 * below its rims, for 1.5 s goes back to the stage start like one that fell in the creek. Players act
 * by input (the Player helper); set-up places things (where players stand, the bucket, a bridge).
 */

/** The crossings with a raised bed: the stage that crosses each, and where along the road. */
const GAPS = [
    { name: 'culvert', stage: 2, u: DITCH.u, area: 'Forest Road' },
    { name: 'gorge', stage: 3, u: GORGE.u, area: 'Gorge' },
    { name: 'crevasse', stage: 5, u: CREVASSE.u, area: 'Mountain Approach' }
] as const;

function run(stage: number, level: LevelDef = valleyLevel): LabSim {
    const s = new LabSim({ level, hazards: false });
    s.step(neutralCommand(0));
    s.fpActive = true;
    s.progress.step = stage;
    return s;
}

function stand(pl: Player, u: number, t: number): void {
    const w = routeToWorld(u, t);
    pl.s.placePlayer(w.x, w.z, ROUTE_YAW, pl.slot);
    pl.yaw = pl.p.yaw;
    pl.pitch = 0;
    pl.step({}, 20);
}

function putBucket(s: LabSim, u: number, t: number, y = hAt(u, t) + 0.05): void {
    const w = routeToWorld(u, t);
    s.physics.place(s.bucket.id, pose(w.x, y, w.z));
    for (let i = 0; i < 30; i++) s.step(neutralCommand(s.tick));
}

/** How far behind the ute's middle its tray is (along its length). */
const TRAY_BACK = 1.0;

const texts = (s: LabSim) => s.events.filter((e) => e.kind === 'recovered').map((e) => e.text);
const bucketAtStart = (s: LabSim, stage: number) => {
    const b = VALLEY_STAGES[stage].bucket;
    const p = s.bucket.pose.p;
    return Math.hypot(p.x - b.x, p.z - b.z) < 4;
};

/**
 * By input: a beaver carries the bucket from the near rim to the gap's edge on the road, faces
 * across, looks down into the gap and tosses it in (the throw key). Then nobody acts; returns the
 * lowest the bucket got and the tick it was recovered (or NaN within `ticks`).
 */
function tossIntoGap(s: LabSim, cu: number, ticks = 300): { lowest: number; recoveredAfter: number } {
    const t = roadT(cu);
    const [[a]] = gapsAt(cu);
    const pl = new Player(s);
    putBucket(s, a - 1.1, t);
    stand(pl, a - 2.2, t);
    expect(pl.grabBucket(), 'picked up on the near rim').toBe(true);
    pl.yaw = ROUTE_YAW;
    pl.pitch = 0;
    for (let i = 0; i < 400 && routeU(pl.p.x, pl.p.z) < a - 0.5; i++) pl.step({ moveZ: 0.4 });
    pl.step({}, 20);
    expect(s.physics.heldIdOf(0), 'still held at the edge').toBe(s.bucket.id);
    pl.pitch = -1.2;
    pl.step({}, 20);
    pl.step({ throw: true });
    const t0 = s.tick;
    let lowest = Infinity;
    for (let i = 0; i < ticks && s.progress.recoveries === 0; i++) {
        lowest = Math.min(lowest, s.bucket.pose.p.y);
        pl.step();
    }
    expect(s.progress.falls, 'the beaver stayed up on the rim').toBe(0);
    return { lowest, recoveredAfter: s.progress.recoveries ? s.tick - t0 : NaN };
}

/** The lower of a crossing's two rims, on the road (just outside its first and last gap). */
function rimsAt(cu: number): number {
    const t = roadT(cu);
    const gaps = gapsAt(cu);
    return Math.min(hAt(gaps[0][0] - 0.6, t), hAt(gaps[gaps.length - 1][1] + 0.6, t));
}

describe('a bucket down in a gap’s bed comes back (#152)', () => {
    for (const g of GAPS)
        it(`the ${g.name}: tossed in by input, it goes back to the ${g.area} start with that stage's spare`, () => {
            const s = run(g.stage);
            const { lowest, recoveredAfter } = tossIntoGap(s, g.u);
            // it went down into the bed, well below the rims, and came back within 3 s of the toss
            // (1.5 s of it lying there, plus the fall)
            expect(lowest, `down in the ${g.name}'s bed`).toBeLessThan(rimsAt(g.u) - 0.5);
            // (the culvert's and gorge's beds lie below lostY, so those were already recovered; the
            // crevasse's bed, 9.5 m down, sits at the creek's lost line, -0.20 to -0.35 m against
            // -0.30, so a bucket there stayed: the mutation test below)
            expect(recoveredAfter).toBeGreaterThan(90);
            expect(recoveredAfter).toBeLessThan(180);
            for (let i = 0; i < 10; i++) s.step(neutralCommand(s.tick));
            expect(s.progress.recoveries).toBe(1);
            expect(bucketAtStart(s, g.stage)).toBe(true);
            const spare = VALLEY_STAGES[g.stage].spareLitres;
            expect(texts(s)).toEqual([
                spare
                    ? `The bucket fell in. A spare bucket (${spare} L) is waiting at the ${g.area} start.`
                    : `The bucket fell in. A spare (empty) one is waiting at the ${g.area} start.`
            ]);
            expect(s.water.volume).toBeCloseTo(spare ?? 0, 6);
        }, 60_000);

    it('mutation: without the gap check (the old rule, lostY alone), the bucket lies in the crevasse bed for good', () => {
        const old: LevelDef = { ...valleyLevel, rules: { ...valleyLevel.rules!, lostAt: undefined } };
        const s = run(5, old);
        const { lowest, recoveredAfter } = tossIntoGap(s, CREVASSE.u, 600);
        expect(lowest).toBeLessThan(rimsAt(CREVASSE.u) - 0.5);
        expect(recoveredAfter).toBeNaN();
    }, 60_000);
});

describe('what is not down in a gap stays where it is (#152 controls)', () => {
    it('the line itself, inside every gap: lost 0.6 m below the lower rim, not 0.3 m below (a headwall or deck there stays)', () => {
        // straight from the level's rule, across each gap on the road (0.3 m in from where the ground
        // drops, the banks' slope aside), so a retuned
        // crossing (Epic 5's culvert headwalls sit 0.25 m below the road) can't slip under the line
        const lostAt = valleyLevel.rules!.lostAt!;
        for (const g of GAPS) {
            const t = roadT(g.u);
            const rim = rimsAt(g.u);
            for (const [a, b] of gapsAt(g.u))
                for (let u = a + 0.3; u < b - 0.25; u += 0.2) {
                    const w = routeToWorld(u, t);
                    expect(lostAt(w.x, rim - 0.6, w.z), `${g.name} u ${u.toFixed(2)}, 0.6 m down`).toBe(true);
                    expect(lostAt(w.x, rim - 0.3, w.z), `${g.name} u ${u.toFixed(2)}, 0.3 m down`).toBe(false);
                }
            // and nowhere on the rims, however low
            for (const u of [gapsAt(g.u)[0][0] - 0.7, gapsAt(g.u).at(-1)![1] + 0.7]) {
                const w = routeToWorld(u, t);
                expect(lostAt(w.x, rim - 3, w.z), `${g.name} rim at u ${u.toFixed(2)}`).toBe(false);
            }
        }
    });

    /** Steps `n` ticks with nobody acting; whether the bucket was recovered meanwhile. */
    const idle = (s: LabSim, n = 300) => {
        for (let i = 0; i < n; i++) s.step(neutralCommand(s.tick));
        return s.progress.recoveries;
    };

    for (const g of GAPS)
        it(`the ${g.name}: a bucket on either rim, by the edge, is never recovered`, () => {
            const t = roadT(g.u);
            const gaps = gapsAt(g.u);
            for (const u of [gaps[0][0] - 0.6, gaps[gaps.length - 1][1] + 0.6]) {
                const s = run(g.stage);
                putBucket(s, u, t);
                expect(idle(s), `at u ${u.toFixed(2)}`).toBe(0);
            }
        }, 60_000);

    it('the crevasse: a bucket resting on a built bridge over it (two beams) is never recovered', () => {
        const s = run(5);
        bridge(s, CREVASSE.u, ['beam-9', 'beam-10']);
        const beam = s.entities.find((e) => e.name === 'beam-9')!.pose.p;
        const w = routeToWorld(CREVASSE.u, roadT(CREVASSE.u));
        s.physics.place(s.bucket.id, pose(w.x, beam.y + 0.25, w.z));
        expect(idle(s)).toBe(0);
        expect(s.bucket.pose.p.y, 'still up on the beams').toBeGreaterThan(beam.y);
    }, 60_000);

    it('the gorge: a bucket on the old stone pier is never recovered', () => {
        const s = run(3);
        const t = roadT(GORGE.u);
        putBucket(s, GORGE.u, t, hAt(GORGE.u, t) + 0.05);
        expect(idle(s)).toBe(0);
    }, 60_000);

    it('the culvert: a bucket on a ute-carrying bridge (a four-beam deck, the ute parked on it) is never recovered', () => {
        const s = run(2);
        const t = roadT(DITCH.u);
        const [a, b] = gapsAt(DITCH.u)[0];
        const rim = Math.max(hAt(a - 0.3, t), hAt(b + 0.3, t));
        // a deck for the ute: four beams side by side, 0.3 m apart, across the gap
        ['beam-3', 'beam-4', 'beam-5', 'beam-6'].forEach((name, k) => {
            const w = routeToWorld((a + b) / 2, t + (k - 1.5) * 0.3);
            const e = s.entities.find((x) => x.name === name)!;
            s.physics.place(e.id, {
                p: { x: w.x, y: rim + 0.2, z: w.z },
                q: quatFromYawPitchRoll(ROUTE_YAW + Math.PI / 2, Math.PI / 2, 0)
            });
        });
        for (let i = 0; i < 120; i++) s.step(neutralCommand(s.tick));
        const deck = Math.max(
            ...['beam-3', 'beam-4', 'beam-5', 'beam-6'].map((n) => s.entities.find((x) => x.name === n)!.pose.p.y)
        );
        // the ute parked on the deck over the gap, the bucket set in its tray (being carried across)
        const uw = routeToWorld((a + b) / 2, t);
        s.physics.place(s.ute.id, pose(uw.x, deck + 0.8, uw.z, quatFromYawPitchRoll(ROUTE_YAW, 0, 0)));
        for (let i = 0; i < 120; i++) s.step(neutralCommand(s.tick));
        const bw = routeToWorld((a + b) / 2 - TRAY_BACK, t);
        s.physics.place(s.bucket.id, pose(bw.x, s.ute.pose.p.y + 0.6, bw.z));
        expect(idle(s)).toBe(0);
        const bk = s.bucket.pose.p;
        expect(bk.y, 'still up on the bridge, in the tray').toBeGreaterThan(rim - 0.5);
        expect(Math.abs(routeU(bk.x, bk.z) - (a + b) / 2), 'over the gap').toBeLessThan(1.6);
        expect(s.ute.pose.p.y, 'the ute still on the deck').toBeGreaterThan(rim - 0.5);
    }, 60_000);
});
