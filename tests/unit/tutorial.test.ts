import { beforeAll, describe, expect, it } from 'vitest';

import { dataHeight, parseLevelData } from '../../src/levels/data.ts';
import { tutorialLevel } from '../../src/levels/index.ts';
import { TUTORIAL_DATA } from '../../src/levels/tutorial.ts';
import { neutralCommand } from '../../src/sim/commands.ts';
import type { PlayerCommand } from '../../src/sim/commands.ts';
import { EYE_HEIGHT, LabSim } from '../../src/sim/lab-sim.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { pose, quatFromYawPitchRoll, quatMul } from '../../src/voxels/math.ts';
import { VoxelWorld } from '../../src/voxels/world.ts';

beforeAll(() => initPhysics());

const cmd = (n: number, c: Partial<PlayerCommand> = {}): PlayerCommand => ({ ...neutralCommand(n), ...c });
const height = dataHeight(TUTORIAL_DATA);

function fresh(): LabSim {
    const s = new LabSim({ level: tutorialLevel });
    s.step(cmd(0));
    s.fpActive = true;
    s.placePlayer(TUTORIAL_DATA.spawn.x, TUTORIAL_DATA.spawn.z, 0);
    for (let n = 1; n < 20; n++) s.step(cmd(n));
    return s;
}

describe('tutorial level', () => {
    it('is valid level data that builds, with no beaver or ute', () => {
        // valid, and normalizing is stable (parse fills in defaults once)
        const once = parseLevelData(JSON.parse(JSON.stringify(TUTORIAL_DATA)));
        expect(parseLevelData(JSON.parse(JSON.stringify(once)))).toEqual(once);
        expect(once.steps).toHaveLength(8);
        expect(once.pieces).toHaveLength(TUTORIAL_DATA.pieces.length);
        const r = tutorialLevel.build(new VoxelWorld(), 1);
        expect(r.columns).toBeGreaterThan(300_000);
        const s = fresh();
        expect(s.beaver.visible).toBe(false);
        expect(s.ute.visible).toBe(false);
        expect(s.stepText).toContain('Look around');
    }, 60_000);

    it('the log cannot be walked over, only jumped', () => {
        const s = fresh();
        s.placePlayer(0, 4.6, 0);
        for (let n = 0; n < 120; n++) s.step(cmd(100 + n, { moveZ: 1 }));
        expect(s.player.z).toBeGreaterThan(3); // stopped by the log at z = 3
        for (let n = 0; n < 60; n++) s.step(cmd(300 + n, { moveZ: 1, jump: n === 0 }));
        expect(s.player.z).toBeLessThan(2.6);
    });

    it('goes through every step in order, announcing each, and completes', () => {
        const s = fresh();
        const step = () => s.progress.step;
        let n = 1000;
        const run = (k: number, c: Partial<PlayerCommand> = {}) => {
            for (let i = 0; i < k; i++) s.step(cmd(n++, c));
        };
        // 1 look
        for (let i = 0; i < 40; i++) s.step(cmd(n++, { yaw: i * 0.05 }));
        expect(step()).toBe(1);
        // 2 walk to the sign
        s.placePlayer(0, 5.5, 0);
        run(5);
        expect(step()).toBe(2);
        // 3 jump
        run(30, { jump: true });
        expect(step()).toBe(3);
        // 4 grab the crate (aim at it)
        const cube = s.cube.pose.p;
        s.placePlayer(cube.x, cube.z + 1.4, 0);
        const pitch = -Math.atan2(s.player.y + EYE_HEIGHT - cube.y, 1.4);
        run(3, { pitch });
        s.step(cmd(n++, { pitch, grab: true }));
        run(2, { pitch: 0 });
        expect(step()).toBe(4);
        // 5 the crate on the pad
        s.physics.release(0);
        s.physics.place(s.cube.id, pose(-2.35, height(-2.35, -0.75) + 0.6, -0.75));
        run(90);
        expect(step()).toBe(5);
        // 6 the ball in the bin
        s.physics.place(s.sphere.id, pose(-2.3, height(-2.3, -5.8) + 0.8, -5.8));
        run(150);
        expect(step()).toBe(6);
        // 7 across the ditch
        s.placePlayer(0, -12.5, 0);
        run(5);
        expect(step()).toBe(7);
        // 8 the bucket to the flag
        s.physics.place(s.bucket.id, pose(0.8, height(0.8, -16.5) + 0.3, -16.5));
        run(90);
        expect(step()).toBe(8);
        expect(s.events.at(-1)?.text).toContain('Tutorial complete');
        expect(s.events.filter((e) => e.kind === 'step').length).toBe(7);
        expect(s.stepText).toBe('');
    });

    it('a plank laid across the ditch carries you over it', () => {
        const s = fresh();
        const along = quatMul(quatFromYawPitchRoll(Math.PI / 2, 0, 0), quatFromYawPitchRoll(0, Math.PI / 2, 0));
        s.physics.place(s.plank.id, pose(0, 0.36, -10, along));
        run(s, 60);
        s.placePlayer(0, -8, 0);
        run(s, 240, { moveZ: 1 });
        expect(s.player.z).toBeLessThan(-12);
        expect(s.progress.falls).toBe(0);
    });
});

function run(s: LabSim, k: number, c: Partial<PlayerCommand> = {}): void {
    for (let i = 0; i < k; i++) s.step(cmd(5000 + i, c));
}
