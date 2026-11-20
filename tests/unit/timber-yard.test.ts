import { beforeAll, describe, expect, it } from 'vitest';

import { BRIDGE, BRIDGE_X, BUCKET_STUMP, CREEK_WATER_Y, YARD_GOAL, YARD_Y, creekCenterZ, timberYardLevel, yardHeight } from '../../src/levels/timber-yard.ts';
import { neutralCommand } from '../../src/sim/commands.ts';
import type { PlayerCommand } from '../../src/sim/commands.ts';
import { EYE_HEIGHT, LabSim } from '../../src/sim/lab-sim.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { pose, quatFromYawPitchRoll, quatMul } from '../../src/voxels/math.ts';
import { VoxelWorld } from '../../src/voxels/world.ts';

beforeAll(() => initPhysics());

const cmd = (n: number, c: Partial<PlayerCommand> = {}): PlayerCommand => ({ ...neutralCommand(n), ...c });
const yard = () => new LabSim({ level: timberYardLevel });
const byName = (s: LabSim, n: string) => s.entities.find((e) => e.name === n)!;

/** Lays both beams flat across the gap, side by side, long axis along Z. */
function bridgeBeams(s: LabSim): void {
    const flatAlongZ = quatMul(quatFromYawPitchRoll(Math.PI / 2, 0, 0), quatFromYawPitchRoll(0, Math.PI / 2, 0));
    ['beam-0', 'beam-1'].forEach((n, i) => s.physics.place(byName(s, n).id, pose(BRIDGE_X - 0.105 + i * 0.21, YARD_Y + 0.12, BRIDGE.zc, flatAlongZ)));
}

describe('level 1: the timber yard', () => {
    it('builds a static voxel world with the creek, the bridge abutments and the yard', () => {
        const w = new VoxelWorld();
        const r = timberYardLevel.build(w, 1);
        expect(r.columns).toBeGreaterThan(300_000);
        expect(r.trees).toBeGreaterThan(30);
        const l = timberYardLevel.layout(1);
        for (const name of ['abutment-near', 'abutment-far', 'shed-roof', 'saw-bench', 'stump', 'flag', 'flower-centre']) expect(l.pieces.some((p) => p.name === name)).toBe(true);
        // nothing grows on the road, in the creek or in the yard
        for (const t of l.trees) expect(Math.abs(t.z - creekCenterZ(t.x))).toBeGreaterThan(2);
    }, 60_000); // the full static build takes ~10 s at 5 cm

    it('the gap is spannable by a 3.2 m beam but too wide to step or jump', () => {
        expect(BRIDGE.gap).toBeGreaterThan(2.3);
        expect(BRIDGE.gap).toBeLessThan(3.2 - 0.4); // at least 20 cm bearing on each abutment
        // the creek is deep below the banks
        expect(YARD_Y - CREEK_WATER_Y).toBeGreaterThan(0.7);
        expect(yardHeight(BRIDGE_X, BRIDGE.zc)).toBeLessThan(CREEK_WATER_Y - 0.4);
    });

    it('starts with every prop at rest: the plank stack and the log pile hold, nothing is lost', () => {
        const s = yard();
        for (let n = 0; n < 360; n++) s.step(cmd(n));
        expect(s.physics.stats.activeBodies).toBe(0);
        expect(s.physics.stats.recovered).toBe(0);
        expect(byName(s, 'extra-plank-4').pose.p.y).toBeGreaterThan(YARD_Y + 0.5); // top of the stack
        expect(byName(s, 'extra-log-1').pose.p.y).toBeGreaterThan(YARD_Y + 0.5); // on top of the pile
        const b = s.bucket.pose.p;
        expect(Math.hypot(b.x - BUCKET_STUMP.x, b.z - BUCKET_STUMP.z)).toBeLessThan(0.1);
        expect(b.y).toBeGreaterThan(BUCKET_STUMP.top - 0.03);
        expect(s.sphere.visible).toBe(false); // not part of this level
    });

    it('falling into the creek puts you back on the bank; you cannot climb out on your own', () => {
        const s = yard();
        s.step(cmd(0));
        s.fpActive = true;
        s.placePlayer(BRIDGE_X + 5, 2.5, 0);
        for (let n = 0; n < 30; n++) s.step(cmd(n));
        for (let n = 0; n < 240 && s.progress.falls === 0; n++) s.step(cmd(100 + n, { moveZ: 1 }));
        expect(s.progress.falls).toBe(1);
        expect(s.events.at(-1)?.kind).toBe('fell');
        expect(s.player.y).toBeGreaterThan(YARD_Y - 0.1);
        expect(timberYardLevel.rules!.isSafe(s.player.x, s.player.z)).toBe(true);
    });

    it('two beams laid across the gap carry you to the far bank', () => {
        const s = yard();
        bridgeBeams(s);
        for (let n = 0; n < 120; n++) s.step(cmd(n));
        s.fpActive = true;
        s.placePlayer(BRIDGE_X, 1.4, 0);
        for (let n = 0; n < 300; n++) s.step(cmd(200 + n, { moveZ: 1 }));
        expect(s.player.z).toBeLessThan(YARD_GOAL.maxZ);
        expect(s.progress.falls).toBe(0);
    });

    it('a beam can be lifted alone (36 kg), the log cannot (113 kg)', () => {
        const s = yard();
        for (let n = 0; n < 60; n++) s.step(cmd(n));
        const beam = byName(s, 'beam-1');
        s.fpActive = true;
        s.placePlayer(beam.pose.p.x, beam.pose.p.z + 1.3, 0);
        const pitch = -Math.atan2(s.player.y + EYE_HEIGHT - beam.pose.p.y, 1.3);
        for (let n = 0; n < 5; n++) s.step(cmd(100 + n, { pitch }));
        s.step(cmd(110, { grab: true, pitch }));
        expect(s.physics.heldId).toBe(beam.id);
        const y0 = beam.pose.p.y;
        for (let n = 0; n < 120; n++) s.step(cmd(111 + n, { pitch: -0.1 }));
        expect(beam.pose.p.y).toBeGreaterThan(y0 + 0.4);
    });

    it('the objective: the bucket resting by the far-bank flag completes it, once', () => {
        const s = yard();
        s.step(cmd(0));
        s.physics.place(s.bucket.id, pose((YARD_GOAL.minX + YARD_GOAL.maxX) / 2, yardHeight(BRIDGE_X, -7) + 0.3, -7));
        for (let n = 0; n < 120; n++) s.step(cmd(n));
        expect(s.progress.goalReached).toBe(true);
        expect(s.events.filter((e) => e.kind === 'goal').length).toBe(1);
        for (let n = 0; n < 120; n++) s.step(cmd(200 + n));
        expect(s.events.filter((e) => e.kind === 'goal').length).toBe(1);
    });

    it('a bucket dropped in the creek comes back to its stump', () => {
        const s = yard();
        s.step(cmd(0));
        s.physics.place(s.bucket.id, pose(BRIDGE_X + 3, CREEK_WATER_Y + 0.5, creekCenterZ(BRIDGE_X + 3)));
        for (let n = 0; n < 240; n++) s.step(cmd(n));
        expect(s.progress.recoveries).toBe(1);
        expect(Math.hypot(s.bucket.pose.p.x - BUCKET_STUMP.x, s.bucket.pose.p.z - BUCKET_STUMP.z)).toBeLessThan(0.2);
        expect(s.progress.goalReached).toBe(false);
    });
});
