/**
 * Joint loads and calibrated breaking (Epic 5, #49 #50). Every threshold here comes from the
 * physical numbers in graph.ts (EN 1995-1-1 for an 8 mm spike in C24) and is tested from both
 * sides: a load just under it holds, a load just over it breaks, and never without a creak first.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';

import { BRIDGE, BRIDGE_X } from '../../src/levels/timber-yard.ts';
import { neutralCommand } from '../../src/sim/commands.ts';
import { BREAK, JointHealth, capacity, utilization } from '../../src/sim/joints/breaking.ts';
import { GROUND, NAIL } from '../../src/sim/joints/graph.ts';
import type { Connection } from '../../src/sim/joints/graph.ts';
import { JointSystem } from '../../src/sim/joints/joints.ts';
import { FRICTION } from '../../src/sim/joints/stress.ts';
import type { JointLoad } from '../../src/sim/joints/stress.ts';
import { CHARACTER, PhysicsWorld, initPhysics } from '../../src/sim/physics/world.ts';
import { pose, quatFromYawPitchRoll } from '../../src/voxels/math.ts';

import { LINES, driveOver, hammerAt, shortBridge, yardBridge } from './bridge-helpers.ts';

beforeAll(() => initPhysics());

const TIP = 2.7;

/**
 * A 3.2 m beam on a 1 m stone block (its edge at x = 0), 2.8 m of it sticking out past the edge,
 * nailed `nails` times near its back end (the first nail at x = -0.3, the rest `spread` along).
 */
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
    return { pw, pb, js, c: [...js.graph.connections()][0] };
}

/**
 * Statics of the cantilever: it tips on the block's edge (x = 0), and the nails at the anchor,
 * `a` behind the edge, hold its back end down. About the anchor M = W (x_com - x_a) + P (x_tip -
 * x_a); the edge bears N = M / a and the nails pull T = N - (W + P).
 */
function prying(W: number, xcom: number, P: number, xa: number): number {
    const a = -xa;
    const M = W * (xcom - xa) + P * (TIP - xa);
    return M / a - (W + P);
}

/** The tip load at which the nails' withdrawal reaches `T` (inverse of prying). */
function tipLoadFor(T: number, W: number, xcom: number, xa: number): number {
    // T + W + P = (W (xcom - xa) + P (TIP - xa)) / a  =>  P (TIP - xa - a) / a = T + W - W (xcom - xa) / a
    const a = -xa;
    return (T + W - (W * (xcom - xa)) / a) / ((TIP - xa - a) / a);
}

describe('joint loads (#49)', () => {
    it('a beam cantilevered off a stone block: the nails read the prying of statics, the faces the rest', () => {
        // (the bands are those #115 set for its springs: 2 % on the force, 3 % on what the nails carry)
        for (const load of [0, 200, 400]) {
            const { pw, pb, js, c } = cantilever(4, 0.25);
            let F = 0;
            let T = 0;
            let Mn = 0;
            let n = 0;
            for (let i = 0; i < 120; i++) {
                const t = pb.body.translation();
                pb.body.applyImpulseAtPoint({ x: 0, y: -load / 60, z: 0 }, { x: TIP, y: t.y, z: 0 }, true);
                pw.step();
                js.update(i);
                const l = js.stress.loads.get(c.id);
                if (i >= 60 && l) {
                    F += Math.hypot(l.fx, l.fy, l.fz);
                    T += l.pull;
                    Mn += l.moment;
                    n++;
                }
            }
            const W = pb.body.mass() * 9.81;
            const expectT = prying(W, pb.body.worldCom().x, load, c.anchorB.x);
            console.log(
                `cantilever, tip load ${load} N: joint force ${(F / n).toFixed(0)} N (statics ${(W + load).toFixed(0)}), nail withdrawal ${(T / n).toFixed(0)} N (statics ${expectT.toFixed(0)}), nail moment ${(Mn / n).toFixed(1)} N m`
            );
            expect(js.graph.size).toBe(1);
            expect(Math.abs(F / n - (W + load)) / (W + load)).toBeLessThan(0.02);
            expect(Math.abs(T / n - expectT) / expectT).toBeLessThan(0.03);
            // the moment across the nails is the faces' and the prying's: none is left on the nails
            expect(Mn / n).toBeLessThan(0.05 * capacity(c).moment);
        }
    });

    it('a pin: a beam hung on one spike through its middle into a stone pier carries its load in shear, no moment', () => {
        // (replaces #115's stone stiffness test: a spike into stone is a pin, read against statics)
        const pw = new PhysicsWorld();
        pw.addTerrain(() => -5, -20, 20, -20, 20, 20);
        pw.createCharacter(0, -5, 10, 0);
        // the pier's face at z = 0; the beam stands off it, face to face, long axis along x
        pw.addStatic(RAPIER.ColliderDesc.cuboid(0.5, 1.5, 0.5).setTranslation(0, 1.5, -0.5));
        const pb = pw.addDynamic(1, { type: 'box', hx: 1.6, hy: 0.1, hz: 0.075 }, pose(0, 2, 0.076), {
            density: 380,
            nailable: true
        });
        pb.body.setGravityScale(0, true);
        pw.step();
        const js = new JointSystem(pw);
        const eye = { x: 0, y: 2, z: 1.2 };
        js.nail(eye, 0, 0, 0, 0);
        pb.body.setGravityScale(1, true);
        expect(js.graph.size).toBe(1);
        const c = [...js.graph.connections()][0];
        const load = 300;
        let S = 0;
        let M = 0;
        let T = 0;
        let n = 0;
        for (let i = 0; i < 120; i++) {
            // the load hangs at the spike (from the beam's centre)
            pb.body.applyImpulse({ x: 0, y: -load / 60, z: 0 }, true);
            pw.step();
            js.update(i);
            const l = js.stress.loads.get(c.id);
            if (i >= 60 && l) {
                // across the spike: its shear, and what the face's friction took off it
                S += l.shear + FRICTION * l.bearing;
                M += l.moment;
                T += l.pull;
                n++;
            }
        }
        const W = pb.body.mass() * 9.81;
        // the load hangs 7.6 cm out from the face: it tips the beam's top edge, 10 cm above the
        // spike, off the face, so the spike is pried out by (W + P) x 0.076 / 0.1
        const expectT = ((W + load) * 0.076) / 0.1;
        console.log(
            `pin: across the spike ${(S / n).toFixed(0)} N (statics ${(W + load).toFixed(0)}), withdrawal ${(T / n).toFixed(0)} N (statics ${expectT.toFixed(0)}), moment ${(M / n).toFixed(2)} N m`
        );
        expect(js.graph.size).toBe(1);
        expect(S / n / (W + load)).toBeGreaterThan(0.9);
        expect(S / n / (W + load)).toBeLessThan(1.1);
        expect(T / n / expectT).toBeGreaterThan(0.9);
        expect(T / n / expectT).toBeLessThan(1.1);
        expect(M / n).toBeLessThan(0.02 * capacity(c).moment);
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
        const at = (...xs: number[]): Connection => ({ ...base, nails: xs.map((x) => ({ x, y: 0, z: 0 })) });
        expect(capacity(at(0)).shear).toBe(NAIL.strength);
        expect(capacity(at(0)).pull).toBe(NAIL.withdrawal);
        expect(capacity(at(0, 0.08)).shear).toBe(2 * NAIL.strength);
        expect(capacity(at(0, 0.08)).pull).toBe(2 * NAIL.withdrawal);
        expect(capacity(at(0, 0.08)).moment).toBeGreaterThan(2 * capacity(at(0)).moment);
        expect(capacity(at(0, 0.3)).moment).toBeGreaterThan(capacity(at(0, 0.08)).moment);
        // EN 1995-1-1 8.3.3: shear and withdrawal combine as squares
        const two = at(0, 0.08);
        const load = (shear: number, pull: number): JointLoad => ({
            force: Math.hypot(shear, pull),
            shear,
            pull,
            bearing: 0,
            moment: 0,
            fx: 0,
            fy: 0,
            fz: 0
        });
        expect(utilization(two, load(0.6 * 8000, 0.8 * 4000))).toBeCloseTo(1, 9);
        // bearing is the pieces', not the nails'
        expect(utilization(two, { ...load(0, 0), bearing: 1e5 })).toBe(0);
        // fatigue wears capacity down: the same load rates higher
        const fresh = utilization(two, load(1000, 500));
        expect(utilization({ ...two, fatigue: 1 }, load(1000, 500))).toBeCloseTo(fresh / (1 - BREAK.fatigueLoss), 6);
    });
});

describe('calibrated breaking (#49)', () => {
    /**
     * Runs a cantilever with a tip load (N), coming on over the first second (a load put on all at
     * once would overshoot to twice its weight), for up to `seconds`; the ticks of its first creak
     * and break.
     */
    const run = (nails: number, spread: number, load: number, seconds = 6) => {
        const { pw, pb, js, c } = cantilever(nails, spread);
        let creak = -1;
        let broke = -1;
        let peak = 0;
        let u = 0;
        for (let i = 0; i < 60 * seconds && broke < 0; i++) {
            const t = pb.body.translation();
            const P = load * Math.min(1, i / 60);
            pb.body.applyImpulseAtPoint({ x: 0, y: -P / 60, z: 0 }, { x: TIP, y: t.y, z: 0 }, true);
            pw.step();
            const ev = js.update(i);
            if (creak < 0 && ev.some((e) => e.kind === 'creak' || e.kind === 'groan')) creak = i;
            if (ev.some((e) => e.kind === 'break')) broke = i;
            peak = Math.max(peak, js.health.states.get(c.id)?.util ?? 0);
            // the load's own utilization once it is on (its mean over a second, fatigue taken out)
            if (i >= 90 && i < 150)
                u += ((js.health.states.get(c.id)?.util ?? 0) * (1 - BREAK.fatigueLoss * c.fatigue)) / 60;
        }
        return { creak, broke, peak, u, fatigue: c.fatigue, W: pb.body.mass() * 9.81, xcom: 1.2, xa: c.anchorB.x };
    };

    it('one spike holds the beam off the block, and lets go past its withdrawal limit, after a creak', () => {
        // self weight alone: T = 1.4 kN of the spike's 2.0 kN (EN 1995 8.3.2)
        const self = run(1, 0, 0, 3);
        const P = (u: number) => tipLoadFor(u * NAIL.withdrawal, self.W, self.xcom, self.xa);
        // either side of its limit: tip loads that pry it out by 0.85 and 1.15 of what it holds
        const under = run(1, 0, P(0.85), 2);
        const over = run(1, 0, P(1.15), 3);
        console.log(
            `one spike: self weight peak ${self.peak.toFixed(2)}; tip load at its limit ${P(1).toFixed(0)} N; at 0.85 peak ${under.peak.toFixed(2)}, held; at 1.15 creak at ${(over.creak / 60).toFixed(2)} s, broke at ${(over.broke / 60).toFixed(2)} s`
        );
        expect(self.broke).toBe(-1);
        expect(self.peak).toBeGreaterThan(0.6);
        expect(self.peak).toBeLessThan(0.8);
        expect(under.broke).toBe(-1);
        expect(under.peak).toBeLessThan(1);
        expect(over.broke).toBeGreaterThan(0);
        expect(over.creak).toBeGreaterThanOrEqual(0);
        expect((over.broke - over.creak) / 60).toBeGreaterThanOrEqual(BREAK.tell - 1e-9);
    });

    it('fatigue: a load held past the fatigue threshold wears the joint until it goes, when the law says; one under it never wears', () => {
        // the law alone, on a steady load u: worn, it rates u / (1 - loss f), and df/dt = (that -
        // fatigueFrom) x rate; it goes when that reaches 1, after the tell
        const c: Connection = {
            id: 9,
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
            tick: 0
        };
        const steady = (u: number) => {
            const h = new JointHealth();
            const cc = { ...c, fatigue: 0 };
            const load = new Map([
                [9, { force: 0, shear: 0, pull: u * NAIL.withdrawal, bearing: 0, moment: 0, fx: 0, fy: 0, fz: 0 }]
            ]);
            for (let t = 1; t < 60 * 60; t++)
                if (h.update([cc], load, t).some((e) => e.kind === 'break')) return { t: t / 60, f: cc.fatigue };
            return { t: -1, f: cc.fatigue };
        };
        for (const u of [0.6, 0.75, 0.9]) {
            let f = 0;
            let t = 0;
            for (; u / (1 - BREAK.fatigueLoss * f) < 1; t += 1e-4)
                f += (u / (1 - BREAK.fatigueLoss * f) - BREAK.fatigueFrom) * BREAK.fatigueRate * 1e-4;
            const law = t + BREAK.tell;
            const got = steady(u);
            console.log(`steady u = ${u}: broke after ${got.t.toFixed(2)} s (the law: ${law.toFixed(2)} s)`);
            expect(got.t / law).toBeGreaterThan(0.97);
            expect(got.t / law).toBeLessThan(1.03);
        }
        const under = steady(0.98 * BREAK.fatigueFrom);
        expect(under.t).toBe(-1);
        expect(under.f).toBe(0);

        // on a real cantilever: 0.75 of what two spikes withdraw wears them out within seconds,
        // with a creak first; 0.45 never wears
        const self = run(2, 0.1, 0, 1);
        const P = (k: number) => tipLoadFor(k * 2 * NAIL.withdrawal, self.W, self.xcom, self.xa);
        const near = run(2, 0.1, P(0.75), 30);
        const light = run(2, 0.1, P(0.9 * BREAK.fatigueFrom), 30);
        console.log(
            `cantilever on two spikes at u = ${near.u.toFixed(2)}: first creak ${(near.creak / 60).toFixed(1)} s, broke after ${(near.broke / 60).toFixed(1)} s; at u = ${light.u.toFixed(2)}: fatigue ${light.fatigue.toFixed(3)} after 30 s`
        );
        expect(near.broke / 60).toBeGreaterThan(2);
        expect(near.creak).toBeLessThan(near.broke - BREAK.tell * 60 + 1);
        expect(light.broke).toBe(-1);
        expect(light.fatigue).toBe(0);
    });

    it('a new joint is not broken by the snap of taking hold; a blow cracks it, it creaks, and it goes after the tell', () => {
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
        const shear = (s: number) =>
            new Map([[7, { force: s, shear: s, pull: 0, bearing: 0, moment: 0, fx: 0, fy: 0, fz: 0 }]]);
        expect(h.update([c], shear(1e6), 101)).toEqual([]);
        // one blow past the impact limit alone does nothing; two in a row crack it
        const blow = shear(NAIL.strength * (BREAK.impact + 0.1));
        const kinds: string[][] = [];
        const at = (load: Map<number, JointLoad>, t: number) => kinds.push(h.update([c], load, t).map((e) => e.kind));
        at(blow, 200);
        at(shear(0), 201);
        at(blow, 202);
        expect(kinds.flat()).not.toContain('break');
        // the second blow in a row cracks it (it creaks, at the latest now)
        at(blow, 203);
        const creaked = 200 + kinds.findIndex((k) => k.includes('creak'));
        expect(creaked).toBeGreaterThanOrEqual(200);
        expect(creaked).toBeLessThanOrEqual(203);
        // cracked: it goes once the tell is over, under no load at all
        const tellTicks = Math.round(BREAK.tell * 60);
        let broke = -1;
        for (let t = 204; t < 300 && broke < 0; t++)
            if (h.update([c], shear(0), t).some((e) => e.kind === 'break')) broke = t;
        expect(broke).toBe(creaked + tellTicks);
    });
});

describe('the yard bridge (Epic 5 gate)', () => {
    const trackMax = (s: ReturnType<typeof yardBridge>['s'], max: Map<number, number>) => {
        for (const [id, st] of s.joints.health.states) max.set(id, Math.max(max.get(id) ?? 0, st.util));
    };

    it('properly built (both ends seated and nailed, two nails each): carries the ute with a wide margin', () => {
        const { s, beams } = yardBridge([1, -1], 2);
        expect(s.joints.graph.size).toBe(4);
        const max = new Map<number, number>();
        const e0 = s.events.length;
        const r = driveOver(s, () => trackMax(s, max));
        const peak = Math.max(...max.values());
        console.log(
            `proper bridge under the ute: peak utilization ${peak.toFixed(2)}, joints ${s.joints.graph.size}/4`
        );
        expect(r.reached).toBe(true);
        expect(s.joints.graph.size).toBe(4);
        // the seats carry the ute (bearing); the nails only keep the beams in place
        expect(peak).toBeLessThan(0.5 * BREAK.creak);
        expect(s.events.slice(e0).filter((e) => e.kind === 'creak' || e.kind === 'break')).toEqual([]);
        for (const b of beams) expect(Math.abs(b.pose.p.z - (beams[0].pose.p.z + b.pose.p.z) / 2)).toBeLessThan(0.1);
        expect(s.physics.stats.linClamps + s.physics.stats.angClamps).toBe(0);
    }, 60_000);

    it('four beavers standing on the properly built bridge: no creak', () => {
        const { s, beams } = yardBridge([1, -1], 2);
        // two patches of deck, three planks each, a third and two thirds of the way across, each
        // plank nailed to both beams
        const mid = [1, 2].map((k) => BRIDGE.nearFace - (k * BRIDGE.gap) / 3);
        const planks = [
            'plank',
            'extra-plank-0',
            'extra-plank-1',
            'extra-plank-2',
            'extra-plank-3',
            'extra-plank-4'
        ].map((n) => s.entities.find((e) => e.name === n)!);
        const top = Math.max(...beams.map((b) => b.pose.p.y)) + 0.075;
        const plankZ = planks.map((_, k) => mid[k < 3 ? 0 : 1] + ((k % 3) - 1) * 0.22);
        planks.forEach((p, k) =>
            s.physics.place(p.id, pose(BRIDGE_X, top + 0.06, plankZ[k], quatFromYawPitchRoll(0, Math.PI / 2, 0)))
        );
        for (let k = 0; k < 40; k++) s.step(neutralCommand(s.tick + 1));
        for (const z of plankZ) for (const x of LINES) hammerAt(s.joints, { x, y: top + 0.1, z }, s.tick);
        expect(s.joints.graph.size).toBe(4 + 2 * planks.length);
        s.fpActive = true;
        s.step(neutralCommand(s.tick + 1));
        // what the beams hold the planks up with (linear: a mean over jitter is the mean load)
        const deckBearing = () =>
            [...s.joints.graph.connections()]
                .filter((c) => c.b !== GROUND)
                .reduce((n, c) => n + (s.joints.stress.loads.get(c.id)?.fy ?? 0), 0);
        // (each averaged over a second: the planks jitter by 10 % step to step)
        let before = 0;
        for (let k = 0; k < 60; k++) {
            s.step(neutralCommand(s.tick + 1));
            before += deckBearing() / 60;
        }
        for (let i = 1; i < 4; i++) s.setSlotActive(i, true);
        // one beaver at each end of each patch
        const spots = [0, 1, 2, 3].map((i) => ({ x: BRIDGE_X + (i % 2 ? 0.6 : -0.6), z: mid[i >> 1] }));
        spots.forEach((p, i) => {
            s.placePlayer(BRIDGE_X, BRIDGE.nearEdge + 1, 0, i);
            const pl = s.players[i];
            pl.x = p.x;
            pl.z = p.z;
            // on the deck (groundY sees only the fixed ground)
            pl.y = top + 0.12;
            s.physics.placeCharacter(pl.x, pl.y, pl.z, i);
        });
        const max = new Map<number, number>();
        const e0 = s.events.length;
        let after = 0;
        for (let k = 0; k < 180; k++) {
            const c = neutralCommand(s.tick + 1);
            s.step(c, c, [c, c]);
            trackMax(s, max);
            if (k >= 120) after += deckBearing() / 60;
        }
        const peak = Math.max(...max.values());
        // their weight is on the deck: the beams hold the planks up by four beavers more
        const added = after - before;
        const onBridge = s.players.slice(0, 4).filter((p) => p.z < BRIDGE.nearFace && p.z > BRIDGE.farFace).length;
        console.log(
            `four beavers on the bridge (${onBridge} still on it after 3 s): the beams hold the deck up by ${added.toFixed(0)} N more (their weight ${(4 * CHARACTER.mass * 9.81).toFixed(0)} N); peak utilization ${peak.toFixed(2)}`
        );
        expect(onBridge).toBe(4);
        expect(added / (4 * CHARACTER.mass * 9.81)).toBeGreaterThan(0.9);
        expect(added / (4 * CHARACTER.mass * 9.81)).toBeLessThan(1.1);
        expect(s.joints.graph.size).toBe(4 + 2 * planks.length);
        expect(peak).toBeLessThan(BREAK.creak);
        expect(s.events.slice(e0).filter((e) => e.kind === 'creak' || e.kind === 'break')).toEqual([]);
    }, 60_000);

    it('underbuilt (beams laid short of the far seat, nailed into the near lip): creaks, then gives way under the ute, the same way every run', () => {
        const run = () => {
            const { s } = shortBridge(4);
            const e0 = s.events.length;
            let peak = 0;
            driveOver(s, () => {
                for (const st of s.joints.health.states.values()) peak = Math.max(peak, st.util);
            });
            const evs = s.events.slice(e0).filter((e) => e.kind === 'creak' || e.kind === 'break');
            return {
                kinds: evs.map((e) => e.kind),
                ticks: evs.map((e) => e.tick),
                peak,
                left: s.joints.graph.size,
                clamps: s.physics.stats.linClamps + s.physics.stats.angClamps
            };
        };
        const a = run();
        const firstBreak = a.ticks[a.kinds.indexOf('break')];
        console.log(
            `underbuilt bridge: peak utilization ${a.peak.toFixed(2)}; events ${a.kinds.map((k, i) => `${k}@${a.ticks[i]}`).join(', ')}; first creak to first break ${((firstBreak - a.ticks[0]) / 60).toFixed(2)} s`
        );
        expect(a.kinds[0]).toBe('creak');
        expect(a.kinds.filter((k) => k === 'break').length).toBe(2);
        expect((firstBreak - a.ticks[0]) / 60).toBeGreaterThanOrEqual(BREAK.tell - 1e-9);
        expect(a.left).toBe(0);
        expect(a.clamps).toBe(0);
        const b = run();
        expect(b).toEqual(a);
    }, 60_000);
});

describe('breaks and strain online (#50, #53)', () => {
    it('guests see the joints strain, hear the creak and lose the nails when they break', async () => {
        const { GuestSession, HostSession, listGames } = await import('../../src/net/session.ts');
        const { MemoryHub } = await import('../../src/net/transport.ts');
        const { LabSim } = await import('../../src/sim/lab-sim.ts');
        const { timberYardLevel } = await import('../../src/levels/timber-yard.ts');
        const { s } = shortBridge(4);
        const hub = new MemoryHub();
        const hs = await HostSession.start(hub.transport('host'), s, 'yard', 'brk1');
        const ad = listGames(hub.channel('lobby', 'watcher'))[0];
        const guests = [];
        for (let k = 0; k < 3; k++)
            guests.push(await GuestSession.join(hub.transport(`g${k}`), new LabSim({ level: timberYardLevel }), ad));
        hs.afterStep((slot) => s.interactionIds(slot));
        // nails reach guests once the host publishes
        for (let k = 0; k < 3; k++) {
            s.step(neutralCommand(s.tick + 1));
            hs.afterStep((slot) => s.interactionIds(slot));
        }
        const nails = [...s.joints.graph.connections()].reduce((n, c) => n + c.nails.length, 0);
        for (const g of guests) expect(g.nails.length).toBe(nails);
        let maxStrain = 0;
        const kinds = new Set<string>();
        driveOver(s, () => {
            hs.afterStep((slot) => s.interactionIds(slot));
            for (const g of guests) {
                for (const m of g.nails) maxStrain = Math.max(maxStrain, m.strain);
                for (const e of g.events) kinds.add(e.kind);
            }
        });
        for (let k = 0; k < 6; k++) {
            s.step(neutralCommand(s.tick + 1));
            hs.afterStep((slot) => s.interactionIds(slot));
        }
        console.log(`guests saw strain up to ${maxStrain}, events ${[...kinds].join(', ')}`);
        expect(s.joints.graph.size).toBe(0);
        expect(maxStrain).toBeGreaterThan(0);
        expect(kinds.has('creak')).toBe(true);
        expect(kinds.has('break')).toBe(true);
        for (const g of guests) expect(g.nails.length).toBe(0);
        hs.stop();
    }, 60_000);
});
