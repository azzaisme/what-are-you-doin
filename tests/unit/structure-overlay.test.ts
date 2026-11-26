/**
 * The structural debug overlay (Epic 5, #51): lines from what the joints carry and the contacts
 * the stress meter reads. Recording contacts for it changes nothing the simulation does.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { bandOf, FORCE_SCALE, structureLines } from '../../src/debug/structure-overlay.ts';
import { neutralCommand } from '../../src/sim/commands.ts';
import type { LabSim } from '../../src/sim/lab-sim.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { pose, quatFromYawPitchRoll } from '../../src/voxels/math.ts';

import { yardBridge } from './bridge-helpers.ts';

beforeAll(() => initPhysics());

const run = (s: LabSim, k: number) => {
    for (let i = 0; i < k; i++) s.step(neutralCommand(s.tick + 1));
};

describe('structural debug overlay (#51)', () => {
    it('bands follow the creak and groan levels', () => {
        expect([0, 0.54, 0.55, 0.79, 0.8, 0.99, 1, 3].map(bandOf)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
    });

    it('draws a cross per joint, its force, and its contacts, joint or free; recording them changes nothing', () => {
        const off = yardBridge([1, -1], 2);
        const on = yardBridge([1, -1], 2);
        on.s.joints.stress.debugContacts = [];
        expect(off.s.joints.stress.debugContacts).toBeNull();
        run(off.s, 30);
        run(on.s, 30);
        // the same simulation, recorded or not
        for (const [a, b] of off.beams.map((x, i) => [x, on.beams[i]])) expect(b.pose.p).toEqual(a.pose.p);
        for (const c of on.s.joints.graph.connections())
            expect(on.s.joints.stress.loads.get(c.id)).toEqual(off.s.joints.stress.loads.get(c.id));

        const contacts = on.s.joints.stress.debugContacts!;
        const L = structureLines(on.s.joints, contacts);
        const n = on.s.joints.graph.size;
        expect(n).toBe(4);
        // a cross is 3 segments (6 points, 18 numbers); a calm bridge is all in band 0
        expect(L.bands[0].length).toBe(18 * n);
        expect(L.bands.slice(1).every((b) => b.length === 0)).toBe(true);
        // one force line per joint, as long as its load
        expect(L.forces.length).toBe(6 * n);
        const conns = [...on.s.joints.graph.connections()];
        conns.forEach((c, k) => {
            const l = on.s.joints.stress.loads.get(c.id)!;
            const f = L.forces.slice(6 * k, 6 * k + 6);
            const len = Math.hypot(f[3] - f[0], f[4] - f[1], f[5] - f[2]);
            expect(len).toBeCloseTo(Math.hypot(l.fx, l.fy, l.fz) * FORCE_SCALE, 6);
        });
        // the beams rest on their seats at the nailed ends: those contacts belong to the joints
        // (within NAIL.faceReach of them), and together they carry the beams' weight
        const mass = on.beams.reduce((m, b) => m + on.s.physics.bodies.get(b.id)!.body.mass(), 0);
        const up = contacts.filter((c) => c.folded).reduce((sum, c) => sum + c.fy, 0);
        expect(up).toBeGreaterThan(0.5 * mass * 9.81);
        expect(up).toBeLessThan(1.5 * mass * 9.81);
        expect(L.folded.length).toBeGreaterThan(0);
        // a log laid across mid-span, far from any nail: free contacts, pressing the beams down
        const log = on.s.entities.find((e) => e.name === 'log')!;
        const mid = on.beams.map((b) => b.pose.p);
        on.s.physics.place(
            log.id,
            pose((mid[0].x + mid[1].x) / 2, mid[0].y + 0.3, (mid[0].z + mid[1].z) / 2, quatFromYawPitchRoll(0, 0, 0)) // its axis (x) across both beams
        );
        run(on.s, 90);
        // (averaged over half a second: a single step's contacts swing as the log settles)
        let down = 0;
        let nFree = 0;
        for (let k = 0; k < 30; k++) {
            run(on.s, 1);
            const free = on.s.joints.stress.debugContacts!.filter((c) => !c.folded);
            nFree = Math.max(nFree, free.length);
            down += free.reduce((sum, c) => sum + c.fy, 0) / 30;
        }
        const logW = on.s.physics.bodies.get(log.id)!.body.mass() * 9.81;
        console.log(
            `overlay: ${n} joints; seats (folded into joints) carry ${up.toFixed(0)} N of the beams' ${(mass * 9.81).toFixed(0)} N; a log across mid-span: ${nFree} free contacts, ${(-down).toFixed(0)} N down of its ${logW.toFixed(0)} N`
        );
        expect(structureLines(on.s.joints, on.s.joints.stress.debugContacts!).free.length).toBeGreaterThan(0);
        // (it draws the contacts as the meter reads them: a loose piece's scaled to its own
        // momentum, so the log presses with its weight)
        expect(Math.abs(-down - logW) / logW).toBeLessThan(0.05);
        // switched off again: nothing recorded
        on.s.joints.stress.debugContacts = null;
        run(on.s, 2);
        expect(on.s.joints.stress.debugContacts).toBeNull();
    }, 60_000);
});
