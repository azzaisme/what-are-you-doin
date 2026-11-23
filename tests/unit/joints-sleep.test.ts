/**
 * Jointed pieces that sleep (Epic 5, #49): a still structure sleeps once its joints' loads are
 * steady, keeps what they carried, and wakes and reloads when something comes onto it, read from
 * its first step awake.
 * Also: which joint springs are the plain EN 1995 values and which are held to what a 60 Hz step
 * can follow.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';

import { BRIDGE, BRIDGE_X } from '../../src/levels/timber-yard.ts';
import { neutralCommand } from '../../src/sim/commands.ts';
import { BREAK } from '../../src/sim/joints/breaking.ts';
import { GROUND, NAIL, angularStiffness, linearStiffness, twistStiffness } from '../../src/sim/joints/graph.ts';
import { JointSystem } from '../../src/sim/joints/joints.ts';
import type { LabSim } from '../../src/sim/lab-sim.ts';
import { PhysicsWorld, initPhysics } from '../../src/sim/physics/world.ts';
import { pose, quatFromYawPitchRoll } from '../../src/voxels/math.ts';

import { LINES, driveOver, hammerAt, yardBridge } from './bridge-helpers.ts';

beforeAll(() => initPhysics());

const asleep = (s: LabSim, ids: number[]) => ids.every((id) => s.physics.bodies.get(id)!.body.isSleeping());

/** Steps until all these pieces sleep (or a time limit); how many steps it took (-1: never). */
function untilAsleep(s: LabSim, ids: number[], max = 60 * 20): number {
    for (let k = 0; k < max; k++) {
        if (asleep(s, ids)) return k;
        s.step(neutralCommand(s.tick + 1));
    }
    return -1;
}

/** The yard bridge with three deck planks nailed across both beams, a third of the way over. */
function deckedBridge() {
    const b = yardBridge([1, -1], 2);
    const { s, beams } = b;
    const z0 = BRIDGE.nearFace - BRIDGE.gap / 3;
    const planks = ['plank', 'extra-plank-0', 'extra-plank-1'].map((n) => s.entities.find((e) => e.name === n)!);
    const top = Math.max(...beams.map((x) => x.pose.p.y)) + 0.075;
    const zs = planks.map((_, k) => z0 + (k - 1) * 0.22);
    planks.forEach((p, k) =>
        s.physics.place(p.id, pose(BRIDGE_X, top + 0.06, zs[k], quatFromYawPitchRoll(0, Math.PI / 2, 0)))
    );
    for (let k = 0; k < 40; k++) s.step(neutralCommand(s.tick + 1));
    for (const z of zs) for (const x of LINES) hammerAt(s.joints, { x, y: top + 0.1, z }, s.tick);
    expect(s.joints.graph.size).toBe(4 + 2 * planks.length);
    return { ...b, planks, top, z0 };
}

const peakOf = (s: LabSim) => Math.max(0, ...[...s.joints.health.states.values()].map((h) => h.util));

describe('jointed pieces that sleep (#49)', () => {
    it('a sleeping bridge wakes for the ute and carries it as an awake one does', () => {
        const awake = yardBridge([1, -1], 2);
        let refPeak = 0;
        driveOver(awake.s, () => (refPeak = Math.max(refPeak, peakOf(awake.s))));

        const { s, beams } = yardBridge([1, -1], 2);
        const slept = untilAsleep(
            s,
            beams.map((b) => b.id)
        );
        expect(slept).toBeGreaterThanOrEqual(0);
        let peak = 0;
        let wokeAt = -1;
        const r = driveOver(s, (k) => {
            peak = Math.max(peak, peakOf(s));
            if (
                wokeAt < 0 &&
                !asleep(
                    s,
                    beams.map((b) => b.id)
                )
            )
                wokeAt = k;
        });
        console.log(
            `asleep after ${(slept / 60).toFixed(1)} s; woke for the ute; peak utilization ${peak.toFixed(2)} (the same bridge kept awake: ${refPeak.toFixed(2)})`
        );
        expect(r.reached).toBe(true);
        expect(wokeAt).toBeGreaterThanOrEqual(0);
        expect(Math.abs(peak - refPeak)).toBeLessThan(0.05);
        expect(s.joints.graph.size).toBe(4);
    }, 60_000);

    it('a sleeping beam wakes for a beaver stepping onto it, and its joints are read again', () => {
        const { s, beams } = yardBridge([1, -1], 2);
        const ids = beams.map((b) => b.id);
        const held = () =>
            [...s.joints.graph.connections()].reduce((n, c) => n + (s.joints.stress.loads.get(c.id)?.fy ?? 0), 0);
        s.fpActive = true;
        s.step(neutralCommand(s.tick + 1));
        expect(untilAsleep(s, ids)).toBeGreaterThanOrEqual(0);
        // stood on beam 0, a third of the way over, straight onto it from above
        const beam = beams[0];
        const z = BRIDGE.nearFace - BRIDGE.gap / 3;
        const sleeping = asleep(s, ids);
        s.player.x = beam.pose.p.x;
        s.player.z = z;
        s.player.y = beam.pose.p.y + 0.08;
        s.physics.placeCharacter(s.player.x, s.player.y, s.player.z, 0);
        let woke = false;
        let on = 0;
        for (let k = 0; k < 60; k++) {
            s.step(neutralCommand(s.tick + 1));
            woke ||= !s.physics.bodies.get(beam.id)!.body.isSleeping();
            if (s.physics.rigs[0].standing === beam.id) on++;
        }
        console.log(
            `a beaver onto a sleeping beam (asleep before: ${sleeping}): woke ${woke}, stood on it ${on} of 60 steps; the joints read ${held().toFixed(0)} N up`
        );
        expect(sleeping).toBe(true);
        expect(woke).toBe(true);
        expect(on).toBeGreaterThan(30);
        // its weight on the beam is read: the beam's joints and seat contacts were measured awake
        expect(s.joints.stress.loads.size).toBe(4);
    }, 60_000);

    it('a load that grows slowly on a joint near its limit keeps it awake: it creaks, then breaks after the tell', () => {
        // a beam cantilevered off a stone block on one spike, its tip load growing over 20 s
        const pw = new PhysicsWorld();
        pw.addTerrain(() => -5, -20, 20, -20, 20, 20);
        pw.createCharacter(0, -5, 10, 0);
        pw.addStatic(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5).setTranslation(-0.5, 0.5, 0));
        const pb = pw.addDynamic(1, { type: 'box', hx: 1.6, hy: 0.075, hz: 0.1 }, pose(1.2, 1.076, 0), {
            density: 380,
            nailable: true
        });
        pb.body.setGravityScale(0, true);
        pw.step();
        const js = new JointSystem(pw);
        hammerAt(js, { x: -0.3, y: 1.15, z: 0 }, 0);
        pb.body.setGravityScale(1, true);
        let creak = -1;
        let broke = -1;
        let slept = 0;
        for (let i = 0; i < 60 * 30 && broke < 0; i++) {
            const t = pb.body.translation();
            const P = 150 * Math.min(1, i / (60 * 20));
            pb.body.applyImpulseAtPoint({ x: 0, y: -P / 60, z: 0 }, { x: 2.7, y: t.y, z: 0 }, true);
            pw.step();
            if (pb.body.isSleeping()) slept++;
            const ev = js.update(i);
            if (creak < 0 && ev.some((e) => e.kind === 'creak' || e.kind === 'groan')) creak = i;
            if (ev.some((e) => e.kind === 'break')) broke = i;
        }
        console.log(
            `a slowly growing tip load on one spike: creak at ${(creak / 60).toFixed(1)} s, break at ${(broke / 60).toFixed(1)} s, ${slept} steps asleep`
        );
        expect(creak).toBeGreaterThan(0);
        expect(broke).toBeGreaterThan(creak);
        expect((broke - creak) / 60).toBeGreaterThanOrEqual(BREAK.tell - 1e-9);
    });

    it('a log dropped onto a sleeping bridge is read from its first step awake, as on an awake one', () => {
        // (the meter reads a woken piece from its first step: nothing a landing does is skipped. On
        // beams seated at both ends the seats take a dropped log, not the nails: statics give the
        // nails next to nothing, asleep first or not)
        const drop = (sleepFirst: boolean) => {
            const { s, beams } = yardBridge([1, -1], 2);
            if (sleepFirst)
                expect(
                    untilAsleep(
                        s,
                        beams.map((b) => b.id)
                    )
                ).toBeGreaterThanOrEqual(0);
            else for (const b of beams) s.physics.bodies.get(b.id)!.body.wakeUp();
            const log = s.entities.find((e) => e.name === 'log')!;
            s.physics.place(
                log.id,
                pose(BRIDGE_X, beams[0].pose.p.y + 1.5, BRIDGE.zc, quatFromYawPitchRoll(Math.PI / 2, 0, Math.PI / 2))
            );
            const e0 = s.events.length;
            let peak = 0;
            let landed = -1;
            for (let k = 0; k < 120; k++) {
                s.step(neutralCommand(s.tick + 1));
                peak = Math.max(peak, peakOf(s));
                if (
                    landed < 0 &&
                    !asleep(
                        s,
                        beams.map((b) => b.id)
                    )
                )
                    landed = k;
            }
            const evs = s.events.slice(e0).filter((e) => e.kind === 'creak' || e.kind === 'break').length;
            return { peak, evs, left: s.joints.graph.size };
        };
        const awake = drop(false);
        const slept = drop(true);
        console.log(
            `a log dropped 1.5 m onto the bridge: peak ${awake.peak.toFixed(3)} awake, ${slept.peak.toFixed(3)} asleep first`
        );
        expect(Math.abs(slept.peak - awake.peak)).toBeLessThan(0.05);
        expect(slept.evs).toBe(awake.evs);
        expect(slept.left).toBe(awake.left);
    }, 60_000);
});

describe('joint springs (#49)', () => {
    it('timber to timber they are the EN 1995 values as they stand; only an anchor on stone is held to what the step can follow', () => {
        const { s } = deckedBridge();
        const js: JointSystem = s.joints;
        let anchors = 0;
        for (const c of js.graph.connections()) {
            const k = js.springs(c.id)!;
            expect(k.linear).toBe(c.stiffness * linearStiffness(c));
            if (c.b === GROUND) {
                anchors++;
                expect(k.twist).toBeLessThanOrEqual(twistStiffness(c));
                expect(Math.min(k.tipY, k.tipZ)).toBeLessThan(angularStiffness(c));
            } else {
                expect(k.twist).toBe(twistStiffness(c));
                expect(k.tipY).toBe(angularStiffness(c));
                expect(k.tipZ).toBe(angularStiffness(c));
            }
        }
        expect(anchors).toBe(4);
        // (the bedding, for the record: E_90,mean x I / t = NAIL.bedding)
        expect(NAIL.bedding).toBeGreaterThan(1e5);
    }, 60_000);
});
