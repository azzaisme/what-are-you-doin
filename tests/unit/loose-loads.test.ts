/**
 * Loose loads on a nailed bridge (Epic 5, #49): a log, a plank or the bucket lying on the bridge
 * weighs what it weighs. Rapier's reported contact impulses also hold its penetration correction,
 * which the nailed deck's quiver keeps busy: read as they are, a still log weighed 1.3 x and the
 * anchors carried 26 % too much. The meter scales a loose piece's contacts to its own momentum.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { BRIDGE, BRIDGE_X } from '../../src/levels/timber-yard.ts';
import { neutralCommand } from '../../src/sim/commands.ts';
import { GROUND } from '../../src/sim/joints/graph.ts';
import type { LabSim } from '../../src/sim/lab-sim.ts';
import { GRAVITY, initPhysics } from '../../src/sim/physics/world.ts';
import { pose, quatFromYawPitchRoll } from '../../src/voxels/math.ts';

import { LINES, hammerAt, yardBridge } from './bridge-helpers.ts';

beforeAll(() => initPhysics());

const run = (s: LabSim, k: number) => {
    for (let i = 0; i < k; i++) s.step(neutralCommand(s.tick + 1));
};
const byName = (s: LabSim, n: string) => s.entities.find((e) => e.name === n)!;
const massOf = (s: LabSim, id: number) => s.physics.bodies.get(id)!.body.mass();

/**
 * The yard bridge (nailed at both ends), a deck plank nailed across it mid-span, and `load` laid
 * on it: what the four anchors hold up, averaged over a second once it has settled, against the
 * weight of everything on them.
 */
function weigh(load: 'log' | 'plank' | 'bucket' | 'none', rescale = true) {
    const { s, beams } = yardBridge([1, -1], 2);
    s.joints.stress.rescaleLoose = rescale;
    const top = Math.max(...beams.map((b) => b.pose.p.y)) + 0.075;
    const zc = BRIDGE.zc;
    const deck = byName(s, 'extra-plank-0');
    s.physics.place(deck.id, pose(BRIDGE_X, top + 0.06, zc, quatFromYawPitchRoll(0, Math.PI / 2, 0)));
    run(s, 40);
    for (const x of LINES) hammerAt(s.joints, { x, y: top + 0.1, z: zc }, s.tick);
    expect(s.joints.graph.size).toBe(6);
    const pieces = [...beams.map((b) => b.id), deck.id];
    let loose = -1;
    // laid on the deck between the beams (a log or a plank across it, along the beams)
    if (load === 'log') {
        loose = byName(s, 'log').id;
        s.physics.place(loose, pose(BRIDGE_X, top + 0.4, zc + 0.6, quatFromYawPitchRoll(0, 0, 0)));
    } else if (load === 'plank') {
        loose = byName(s, 'extra-plank-1').id;
        s.physics.place(loose, pose(BRIDGE_X, top + 0.25, zc + 0.4, quatFromYawPitchRoll(0, Math.PI / 2, 0)));
    } else if (load === 'bucket') {
        loose = s.bucket.id;
        s.physics.place(loose, pose(BRIDGE_X, top + 0.25, zc, quatFromYawPitchRoll(0, 0, 0)));
    }
    run(s, 120);
    let held = 0;
    const anchors = [...s.joints.graph.connections()].filter((c) => c.b === GROUND);
    for (let k = 0; k < 60; k++) {
        run(s, 1);
        for (const c of anchors) held += (s.joints.stress.loads.get(c.id)?.fy ?? 0) / 60;
    }
    const weight = [...pieces, ...(loose >= 0 ? [loose] : [])].reduce((w, id) => w + massOf(s, id) * GRAVITY, 0);
    const looseW = loose >= 0 ? massOf(s, loose) * GRAVITY : 0;
    // the load still lies on the bridge (not rolled off)
    if (loose >= 0) {
        const p = s.physics.bodies.get(loose)!.body.translation();
        expect(p.y).toBeGreaterThan(top);
    }
    return { held, weight, looseW, err: (held - weight) / weight };
}

describe('loose loads on a nailed bridge (#49)', () => {
    it('a log, a plank and the bucket lying on it: the anchors hold their weight, to 5 %', () => {
        const rows: string[] = [];
        for (const load of ['none', 'log', 'plank', 'bucket'] as const) {
            const w = weigh(load);
            rows.push(
                `${load}: anchors hold ${w.held.toFixed(0)} N of ${w.weight.toFixed(0)} N (${(100 * w.err).toFixed(1)} %; the load ${w.looseW.toFixed(0)} N)`
            );
            expect(Math.abs(w.err)).toBeLessThan(0.05);
        }
        console.log(rows.join('\n'));
    }, 120_000);

    it('it hides no impact: a log dropped 1.5 m onto the deck mid-span peaks as it did unscaled', () => {
        const drop = (rescale: boolean) => {
            const { s, beams } = yardBridge([1, -1], 2);
            s.joints.stress.rescaleLoose = rescale;
            const top = Math.max(...beams.map((b) => b.pose.p.y)) + 0.075;
            const log = byName(s, 'log');
            // across both beams, mid-span: far from every nail, so its contacts are the ones scaled
            s.physics.place(log.id, pose(BRIDGE_X, top + 1.5, BRIDGE.zc, quatFromYawPitchRoll(0, 0, 0)));
            let peak = 0;
            let force = 0;
            for (let k = 0; k < 120; k++) {
                run(s, 1);
                for (const c of s.joints.graph.connections()) {
                    peak = Math.max(peak, s.joints.health.states.get(c.id)?.util ?? 0);
                    force = Math.max(force, s.joints.stress.loads.get(c.id)?.force ?? 0);
                }
            }
            return { peak, force };
        };
        const on = drop(true);
        const off = drop(false);
        console.log(
            `log dropped 1.5 m mid-span: peak utilization ${on.peak.toFixed(3)} (unscaled ${off.peak.toFixed(3)}), largest joint force ${on.force.toFixed(0)} N (unscaled ${off.force.toFixed(0)} N)`
        );
        expect(on.peak).toBeGreaterThan(0);
        expect(Math.abs(on.peak - off.peak) / off.peak).toBeLessThan(0.05);
        expect(Math.abs(on.force - off.force) / off.force).toBeLessThan(0.05);
    }, 60_000);

    it('without the rescale the log reads heavy: it is what the test above catches', () => {
        const w = weigh('log', false);
        console.log(
            `log, contacts as reported: anchors hold ${w.held.toFixed(0)} N of ${w.weight.toFixed(0)} N (${(100 * w.err).toFixed(1)} %)`
        );
        expect(w.err).toBeGreaterThan(0.05);
    }, 60_000);
});
