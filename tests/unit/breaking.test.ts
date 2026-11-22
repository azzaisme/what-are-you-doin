import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';

import { BREAK, JointHealth, capacity, utilization } from '../../src/sim/joints/breaking.ts';
import { GROUND, NAIL } from '../../src/sim/joints/graph.ts';
import type { Connection } from '../../src/sim/joints/graph.ts';
import { JointSystem } from '../../src/sim/joints/joints.ts';
import { leastNorm } from '../../src/sim/joints/stress.ts';
import { PhysicsWorld, initPhysics } from '../../src/sim/physics/world.ts';
import { pose } from '../../src/voxels/math.ts';

import { driveOver, hammerAt, yardBridge } from './bridge-helpers.ts';

beforeAll(() => initPhysics());

/** A 3.2 m beam lying on a 1 m stone block with 2.8 m sticking out past it, nailed `nails` times near its back end. */
function cantilever(nails: number, spread = 0.1) {
    const pw = new PhysicsWorld();
    pw.addTerrain(() => -5, -20, 20, -20, 20, 20);
    pw.createCharacter(0, -5, 10, 0);
    pw.addStatic(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5).setTranslation(-0.5, 0.5, 0));
    const pb = pw.addDynamic(1, { type: 'box', hx: 1.6, hy: 0.075, hz: 0.1 }, pose(1.2, 1.076, 0), {
        density: 380,
        nailable: true
    });
    // held still for the first step, so the query pipeline sees it before the hammer does
    pb.body.setGravityScale(0, true);
    pw.step();
    const js = new JointSystem(pw);
    for (let k = 0; k < nails; k++) hammerAt(js, { x: -0.3 + (k * spread) / Math.max(1, nails - 1), y: 1.15, z: 0 }, 0);
    pb.body.setGravityScale(1, true);
    return { pw, pb, js };
}

describe('joint loads (#49)', () => {
    it('least-norm solve: an exactly determined system comes back exactly; a redundant one splits evenly', () => {
        // x0 + x1 = 2 with equal weights: 1 and 1
        const x = leastNorm(new Float64Array([1, 1]), 1, 2, new Float64Array([1, 1]), new Float64Array([2]));
        expect(x[0]).toBeCloseTo(1, 6);
        expect(x[1]).toBeCloseTo(1, 6);
        // the cheaper unknown (higher weight) takes more
        const y = leastNorm(new Float64Array([1, 1]), 1, 2, new Float64Array([1, 9]), new Float64Array([10]));
        expect(y[1]).toBeCloseTo(9, 6);
    });

    it('a cantilevered beam: the measured joint load matches statics, with and without a tip load', () => {
        // (1000 N at the tip is past what four nails hold: that breaks it, see below)
        for (const load of [0, 200, 400]) {
            const { pw, pb, js } = cantilever(4, 0.25);
            let F = 0;
            let M = 0;
            let n = 0;
            for (let i = 0; i < 120; i++) {
                const t = pb.body.translation();
                pb.body.applyImpulseAtPoint({ x: 0, y: -load / 60, z: 0 }, { x: 2.7, y: t.y, z: 0 }, true);
                pw.step();
                js.update(i);
                const l = [...js.stress.loads.values()][0];
                if (i >= 60 && l) {
                    F += l.force;
                    M += l.moment;
                    n++;
                }
            }
            const c = [...js.graph.connections()][0];
            const W = pb.body.mass() * 9.81;
            // moment about the joint point: self weight at the centre of mass, the load at x = 2.7
            const arm = pb.body.worldCom().x - c.anchorB.x;
            const expectF = W + load;
            const expectM = W * arm + load * (2.7 - c.anchorB.x);
            console.log(
                `cantilever, tip load ${load} N: force ${(F / n).toFixed(1)} N (statics ${expectF.toFixed(1)}), moment ${(M / n).toFixed(1)} N m (statics ${expectM.toFixed(1)})`
            );
            expect(Math.abs(F / n - expectF) / expectF).toBeLessThan(0.02);
            expect(Math.abs(M / n - expectM) / expectM).toBeLessThan(0.03);
        }
    });

    it('capacity grows with nails and with how far apart they are', () => {
        const base = {
            id: 1,
            a: 1,
            b: GROUND,
            type: 'anchor' as const,
            anchorA: { x: 0, y: 0, z: 0 },
            anchorB: { x: 0, y: 0, z: 0 },
            rel: { x: 0, y: 0, z: 0, w: 1 },
            stiffness: 1,
            strength: 0,
            fatigue: 0,
            tick: 0
        };
        const one: Connection = { ...base, nails: [{ x: 0, y: 0, z: 0 }] };
        const two: Connection = {
            ...base,
            nails: [
                { x: 0, y: 0, z: 0 },
                { x: 0.08, y: 0, z: 0 }
            ]
        };
        const wide: Connection = {
            ...base,
            nails: [
                { x: 0, y: 0, z: 0 },
                { x: 0.3, y: 0, z: 0 }
            ]
        };
        expect(capacity(one).force).toBe(NAIL.strength);
        expect(capacity(two).force).toBe(2 * NAIL.strength);
        expect(capacity(two).moment).toBeGreaterThan(2 * capacity(one).moment);
        expect(capacity(wide).moment).toBeGreaterThan(capacity(two).moment);
        // fatigue wears capacity down: the same load rates higher
        const load = { force: 1000, moment: 100, fx: 0, fy: -1000, fz: 0 };
        const fresh = utilization(two, load);
        expect(utilization({ ...two, fatigue: 1 }, load)).toBeCloseTo(fresh / (1 - BREAK.fatigueLoss), 6);
    });
});

describe('calibrated breaking (#49)', () => {
    it('a beam cantilevered off a block on one nail tears loose under its own weight; four spread nails hold it', () => {
        const weak = cantilever(1);
        let broke = -1;
        for (let i = 0; i < 180 && broke < 0; i++) {
            weak.pw.step();
            if (weak.js.update(i).some((e) => e.kind === 'break')) broke = i;
        }
        console.log(`one nail: broke after ${broke} ticks`);
        expect(broke).toBeGreaterThan(0);
        expect(weak.js.graph.size).toBe(0);
        const strong = cantilever(4, 0.25);
        let maxU = 0;
        for (let i = 0; i < 180; i++) {
            strong.pw.step();
            strong.js.update(i);
            maxU = Math.max(
                maxU,
                strong.js.health.states.get([...strong.js.graph.connections()][0]?.id ?? -1)?.util ?? 0
            );
        }
        console.log(`four spread nails: max utilization ${maxU.toFixed(2)}`);
        expect(strong.js.graph.size).toBe(1);
        expect(maxU).toBeLessThan(1);
        expect(strong.pb.body.translation().y).toBeGreaterThan(1);
    });

    it('a load held near the limit wears the joint until it lets go; a lighter one holds for good', () => {
        const run = (load: number) => {
            const { pw, pb, js } = cantilever(4, 0.25);
            let broke = -1;
            for (let i = 0; i < 60 * 30 && broke < 0; i++) {
                const t = pb.body.translation();
                pb.body.applyImpulseAtPoint({ x: 0, y: -load / 60, z: 0 }, { x: 2.7, y: t.y, z: 0 }, true);
                pw.step();
                if (js.update(i).some((e) => e.kind === 'break')) broke = i;
            }
            return { broke, fatigue: [...js.graph.connections()][0]?.fatigue ?? 1 };
        };
        // four nails 25 cm apart hold M_cap = 16 kN x 0.165 m = 2640 N m; self weight takes ~460 of it
        const near = run(560);
        const light = run(150);
        console.log(
            `near the limit: broke after ${(near.broke / 60).toFixed(1)} s; light: fatigue ${light.fatigue.toFixed(3)} after 30 s`
        );
        expect(near.broke).toBeGreaterThan(60);
        expect(light.broke).toBe(-1);
        expect(light.fatigue).toBe(0);
    });

    it('a new joint is not broken by the snap of taking hold, and nothing breaks inside the step', () => {
        const h = new JointHealth();
        const c: Connection = {
            id: 7,
            a: 1,
            b: GROUND,
            type: 'anchor',
            anchorA: { x: 0, y: 0, z: 0 },
            anchorB: { x: 0, y: 0, z: 0 },
            rel: { x: 0, y: 0, z: 0, w: 1 },
            nails: [{ x: 0, y: 0, z: 0 }],
            stiffness: 1,
            strength: NAIL.strength,
            fatigue: 0,
            tick: 100
        };
        const huge = new Map([[7, { force: 1e6, moment: 0, fx: 0, fy: 0, fz: 0 }]]);
        expect(h.update([c], huge, 101)).toEqual([]);
        // one blow past the impact limit alone does not break it; two in a row do
        const blow = new Map([[7, { force: NAIL.strength * (BREAK.impact + 0.1), moment: 0, fx: 0, fy: 0, fz: 0 }]]);
        const calm = new Map([[7, { force: 0, moment: 0, fx: 0, fy: 0, fz: 0 }]]);
        expect(h.update([c], blow, 200).filter((e) => e.kind === 'break')).toEqual([]);
        h.update([c], calm, 201);
        expect(h.update([c], blow, 202).filter((e) => e.kind === 'break')).toEqual([]);
        expect(h.update([c], blow, 203).map((e) => e.kind)).toContain('break');
    });
});

describe('the yard bridge under the ute (Epic 5 gate)', () => {
    const trackMax = (s: ReturnType<typeof yardBridge>['s'], max: Map<number, number>) => {
        for (const [id, st] of s.joints.health.states) max.set(id, Math.max(max.get(id) ?? 0, st.util));
    };

    it('properly built (both ends, two nails each): carries the ute without a creak', () => {
        const { s, beams } = yardBridge([1, -1], 2);
        expect(s.joints.graph.size).toBe(4);
        const max = new Map<number, number>();
        const e0 = s.events.length;
        const r = driveOver(s, () => trackMax(s, max));
        const peak = Math.max(...max.values());
        console.log(`proper bridge: peak utilization ${peak.toFixed(2)}, joints ${s.joints.graph.size}/4`);
        expect(r.reached).toBe(true);
        expect(s.joints.graph.size).toBe(4);
        expect(peak).toBeLessThan(BREAK.creak);
        expect(s.events.slice(e0).filter((e) => e.kind === 'creak' || e.kind === 'break')).toEqual([]);
        for (const b of beams) expect(Math.abs(b.pose.p.z - (beams[0].pose.p.z + b.pose.p.z) / 2)).toBeLessThan(0.1);
        // no solver blowup
        expect(s.physics.stats.linClamps + s.physics.stats.angClamps).toBe(0);
    }, 60_000);

    it('underbuilt (nailed at the near end only): creaks first, then both joints give way, the same way every run', () => {
        const run = () => {
            const { s } = yardBridge([1], 2);
            const e0 = s.events.length;
            driveOver(s);
            return {
                kinds: s.events
                    .slice(e0)
                    .map((e) => e.kind)
                    .filter((k) => k === 'creak' || k === 'break'),
                ticks: s.events
                    .slice(e0)
                    .filter((e) => e.kind === 'break')
                    .map((e) => e.tick),
                left: s.joints.graph.size,
                clamps: s.physics.stats.linClamps + s.physics.stats.angClamps
            };
        };
        const a = run();
        console.log(`underbuilt bridge: events ${a.kinds.join(', ')} at ticks ${a.ticks.join(', ')}`);
        expect(a.kinds[0]).toBe('creak');
        expect(a.kinds.filter((k) => k === 'break').length).toBe(2);
        expect(a.left).toBe(0);
        expect(a.clamps).toBe(0);
        const b = run();
        expect(b).toEqual(a);
    }, 60_000);
});
