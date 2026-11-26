/**
 * Ropes (Epic 5, #52; for Epic 8's #75): taut-only lines with a known tension, a breaking load,
 * and a length a winch can change.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';

import { SIM_DT } from '../../src/sim/clock.ts';
import { GROUND } from '../../src/sim/joints/graph.ts';
import { JointSystem } from '../../src/sim/joints/joints.ts';
import { ROPE, RopeSystem } from '../../src/sim/joints/rope.ts';
import { GRAVITY, PhysicsWorld, initPhysics } from '../../src/sim/physics/world.ts';
import { pose } from '../../src/voxels/math.ts';

import { hammerAt } from './bridge-helpers.ts';

beforeAll(() => initPhysics());

const O = { x: 0, y: 0, z: 0 };

function world(): PhysicsWorld {
    const pw = new PhysicsWorld();
    pw.addTerrain(() => -5, -20, 20, -20, 20, 20);
    pw.createCharacter(0, -5, 10, 0);
    return pw;
}

/** A block of `mass` kg (0.4 m cube) hanging from a fixed point 2 m above it. */
function hang(mass: number) {
    const pw = world();
    const box = pw.addDynamic(1, { type: 'box', hx: 0.2, hy: 0.2, hz: 0.2 }, pose(0, 3, 0), {
        density: mass / 0.064
    });
    const ropes = new RopeSystem(pw);
    const id = ropes.tie(1, { x: 0, y: 0.2, z: 0 }, GROUND, { x: 0, y: 5.2, z: 0 });
    return { pw, box, ropes, id };
}

describe('ropes (#52, #75)', () => {
    it('a hanging block: the rope carries its weight, stretched EA / L', () => {
        const { pw, box, ropes, id } = hang(100);
        expect(ropes.get(id)!.length).toBeCloseTo(2, 6);
        let sum = 0;
        let y0 = 0;
        for (let i = 0; i < 300; i++) {
            pw.step();
            if (i === 239) y0 = box.body.translation().y;
            if (i >= 240) sum += ropes.tension(id) / 60;
        }
        const W = box.body.mass() * GRAVITY;
        const stretch = ropes.span(id) - 2;
        console.log(
            `100 kg on a 2 m rope: tension ${sum.toFixed(1)} N (weight ${W.toFixed(1)} N), stretch ${(stretch * 1000).toFixed(1)} mm (W L / EA ${((W * 2 * 1000) / ROPE.EA).toFixed(1)} mm)`
        );
        expect(Math.abs(sum - W) / W).toBeLessThan(0.01);
        expect(stretch).toBeCloseTo((W * 2) / ROPE.EA, 3);
        // still: it does not bob (its velocity after a step holds that step's gravity, which the
        // rope's next pull takes out, so read where it is)
        expect(Math.abs(box.body.translation().y - y0)).toBeLessThan(5e-4);
    });

    it('slack, it pulls nothing: a block on the ground with a long rope rests there', () => {
        const pw = world();
        pw.addStatic(RAPIER.ColliderDesc.cuboid(2, 0.5, 2).setTranslation(0, 0.5, 0));
        const box = pw.addDynamic(1, { type: 'box', hx: 0.2, hy: 0.2, hz: 0.2 }, pose(0, 1.2, 0), { density: 500 });
        const ropes = new RopeSystem(pw);
        const id = ropes.tie(1, O, GROUND, { x: 0, y: 3, z: 0 }, 5);
        for (let i = 0; i < 120; i++) pw.step();
        expect(ropes.tension(id)).toBe(0);
        expect(box.body.translation().y).toBeCloseTo(1.2, 2);
    });

    it('past its breaking load it snaps, once, and lets go', () => {
        // 1.2 t hanging: 11.8 kN, past 10 kN
        const { pw, box, ropes, id } = hang(1200);
        const events = [];
        for (let i = 0; i < 120; i++) {
            pw.step();
            events.push(...ropes.events());
        }
        expect(events.length).toBe(1);
        expect(events[0]).toMatchObject({ kind: 'snap', id });
        expect(ropes.get(id)).toBeUndefined();
        expect(box.body.translation().y).toBeLessThan(2);
    });

    it('a rope on a body that leaves the world (the sawmill takes it) is dropped, with a loose event', () => {
        const { pw, box, ropes, id } = hang(50);
        for (let i = 0; i < 30; i++) pw.step();
        expect(ropes.tension(id)).toBeGreaterThan(0);
        // out of the world, as the sawmill takes a log (its body disabled, not removed)
        pw.setEnabled(1, false);
        pw.step();
        expect(ropes.get(id)).toBeUndefined();
        expect(ropes.events()).toEqual([expect.objectContaining({ kind: 'loose', id })]);
        // and nothing more is pulled on it
        for (let i = 0; i < 30; i++) pw.step();
        expect(ropes.size).toBe(0);
        // a body out of the world cannot be tied
        expect(ropes.tie(1, O, GROUND, { x: 0, y: 6, z: 0 })).toBe(-1);
        void box;
    });

    it('each rope’s events are its owner’s: one owner reading its own leaves the others’ queued', () => {
        const pw = world();
        const mk = (n: number, x: number) =>
            pw.addDynamic(n, { type: 'box', hx: 0.2, hy: 0.2, hz: 0.2 }, pose(x, 3, 0), { density: 1200 / 0.064 });
        mk(1, -3);
        mk(2, 3);
        const ropes = new RopeSystem(pw);
        // two 1.2 t blocks: both ropes snap
        const w = ropes.tie(1, { x: 0, y: 0.2, z: 0 }, GROUND, { x: -3, y: 5.2, z: 0 }, undefined, 'winch');
        const h = ropes.tie(2, { x: 0, y: 0.2, z: 0 }, GROUND, { x: 3, y: 5.2, z: 0 }, undefined, 'hazard');
        expect(ropes.get(w)!.owner).toBe('winch');
        for (let i = 0; i < 60; i++) pw.step();
        expect(ropes.size).toBe(0);
        const winch = ropes.events('winch');
        expect(winch).toEqual([expect.objectContaining({ kind: 'snap', id: w, owner: 'winch' })]);
        // the hazard's is still there for the hazard, and only once
        expect(ropes.events('winch')).toEqual([]);
        expect(ropes.events('hazard')).toEqual([expect.objectContaining({ kind: 'snap', id: h, owner: 'hazard' })]);
        expect(ropes.events()).toEqual([]);
    });

    it('wound in, it draws two loose blocks together, equal and opposite (no launch)', () => {
        const pw = world();
        pw.world.gravity = { x: 0, y: 0, z: 0 };
        const a = pw.addDynamic(1, { type: 'box', hx: 0.2, hy: 0.2, hz: 0.2 }, pose(-2, 3, 0), { density: 500 });
        const b = pw.addDynamic(2, { type: 'box', hx: 0.2, hy: 0.2, hz: 0.2 }, pose(2, 3, 0), { density: 1500 });
        // (no air drag, and kept awake: the world puts slow props to sleep, losing their momentum)
        for (const x of [a, b]) x.body.setLinearDamping(0);
        const ropes = new RopeSystem(pw);
        const id = ropes.tie(1, { x: 0.2, y: 0, z: 0 }, 2, { x: -0.2, y: 0, z: 0 });
        expect(ropes.get(id)!.length).toBeCloseTo(3.6, 6);
        let fastest = 0;
        // wind in at 0.25 m/s for 8 s: 2 m
        for (let i = 0; i < 480; i++) {
            ropes.setLength(id, ropes.get(id)!.length - 0.25 * SIM_DT);
            for (const x of [a, b]) x.body.wakeUp();
            pw.step();
            fastest = Math.max(fastest, Math.abs(a.body.linvel().x), Math.abs(b.body.linvel().x));
        }
        const pa = a.body.mass() * a.body.linvel().x;
        const pb = b.body.mass() * b.body.linvel().x;
        const gap = b.body.translation().x - a.body.translation().x - 0.4;
        console.log(
            `wound 2 m in: gap ${gap.toFixed(3)} m (rope ${ropes.get(id)!.length.toFixed(3)} m), momenta ${pa.toFixed(2)} / ${pb.toFixed(2)} kg m/s, fastest ${fastest.toFixed(2)} m/s`
        );
        // the rope only pulls: drawn in, they coast on together (nothing here stops them)
        expect(gap).toBeLessThan(ropes.get(id)!.length + 0.05);
        expect(Math.abs(pa + pb)).toBeLessThan(1e-3);
        // moved by the winding, not flung: about its rate, shared by mass
        expect(fastest).toBeLessThan(0.5);
    });

    it("tied to a nailed beam, its pull is a load the beam's joint carries", () => {
        // a beam cantilevered off a stone block on one spike (as breaking.test.ts), its tip tied
        // down to a ground stake below: the nails (with their seat) carries the rope's pull as well
        // as the beam. Run with and without the rope: what the joint carries grows by the tension
        const run = (tie: boolean) => {
            const pw = world();
            pw.addStatic(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5).setTranslation(-0.5, 0.5, 0));
            const pb = pw.addDynamic(1, { type: 'box', hx: 1.6, hy: 0.075, hz: 0.1 }, pose(1.2, 1.076, 0), {
                density: 380,
                nailable: true
            });
            pb.body.setGravityScale(0, true);
            pw.step();
            const js = new JointSystem(pw);
            // four nails over 25 cm (one spike creaks at the beam alone)
            for (let k = 0; k < 4; k++) hammerAt(js, { x: -0.3 + (k * 0.25) / 3, y: 1.15, z: 0 }, 0);
            pb.body.setGravityScale(1, true);
            const ropes = new RopeSystem(pw);
            const id = tie ? ropes.tie(1, { x: 1.5, y: 0, z: 0 }, GROUND, { x: 2.7, y: -4, z: 0 }) : -1;
            if (tie) ropes.setLength(id, ropes.span(id) - 0.03);
            const c = [...js.graph.connections()][0];
            let T = 0;
            let fy = 0;
            for (let i = 0; i < 240; i++) {
                pw.step();
                const ev = js.update(i).filter((e) => e.kind === 'break');
                expect(ev).toEqual([]);
                if (i >= 180) {
                    T += ropes.tension(id) / 60;
                    fy += js.stress.loads.get(c.id)!.fy / 60;
                }
            }
            return { T, fy };
        };
        const bare = run(false);
        const tied = run(true);
        console.log(
            `rope pulling the cantilever's tip down: tension ${tied.T.toFixed(1)} N; the joint holds the beam up with ${bare.fy.toFixed(1)} N, ${tied.fy.toFixed(1)} N tied (${(tied.fy - bare.fy).toFixed(1)} N more)`
        );
        expect(tied.T).toBeGreaterThan(50);
        expect(Math.abs(tied.fy - bare.fy - tied.T) / tied.T).toBeLessThan(0.05);
    });
});
