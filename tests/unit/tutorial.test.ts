import { beforeAll, describe, expect, it } from 'vitest';

import { LONG_PLANK_HALF, LONG_PLANK_LENGTH } from '../../src/assets/props.ts';
import { dataHeight, parseLevelData } from '../../src/levels/data.ts';
import { tutorialLevel } from '../../src/levels/index.ts';
import { TUTORIAL_DATA } from '../../src/levels/tutorial.ts';
import { neutralCommand } from '../../src/sim/commands.ts';
import type { PlayerCommand } from '../../src/sim/commands.ts';
import { EYE_HEIGHT, LabSim } from '../../src/sim/lab-sim.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { pose, quatFromYawPitchRoll, quatMul, quatRotate, vec3 } from '../../src/voxels/math.ts';
import { VoxelWorld } from '../../src/voxels/world.ts';

import { Player } from './play.ts';

beforeAll(() => initPhysics());

const cmd = (n: number, c: Partial<PlayerCommand> = {}): PlayerCommand => ({ ...neutralCommand(n), ...c });
const height = dataHeight(TUTORIAL_DATA);
/** The tutorial's plank: the 3.8 m long plank (planks elsewhere are 2.4 m). */
const plankOf = (s: LabSim) => s.entities.find((e) => e.name === 'long-plank')!;

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
        s.physics.place(plankOf(s).id, pose(0, 0.36, -10, along));
        run(s, 60);
        s.placePlayer(0, -8, 0);
        run(s, 240, { moveZ: 1 });
        expect(s.player.z).toBeLessThan(-12);
        expect(s.progress.falls).toBe(0);
    });
});

/** The ditch's lips (z): where the banks start to drop, 1.15 m either side of its line. */
const DITCH = TUTORIAL_DATA.features.find((f) => f.type === 'ditch')!;
const LIP_NEAR = (DITCH as { z1: number }).z1 + (DITCH as { width: number }).width / 2 + 0.25;
const LIP_FAR = (DITCH as { z1: number }).z1 - (DITCH as { width: number }).width / 2 - 0.25;

/** How much of the plank rests on each bank past its lip (m), and how level it lies. */
function bearing(s: LabSim): { near: number; far: number; tilt: number } {
    const v = quatRotate(plankOf(s).pose.q, LONG_PLANK_HALF.x, 0, 0, vec3());
    const a = plankOf(s).pose.p;
    const zs = [a.z + v.z, a.z - v.z];
    return { near: Math.max(...zs) - LIP_NEAR, far: LIP_FAR - Math.min(...zs), tilt: Math.abs(v.y) };
}

/** One player from the plank's near end: looks at it `behind` m short of its middle and grabs it. */
function takePlank(behind: number): { s: LabSim; p: Player } {
    const s = fresh();
    const p = new Player(s);
    const pk = plankOf(s).pose.p;
    // the plank lies along the lane, pointing across the ditch: stand 0.4 m off its near end
    s.placePlayer(pk.x, pk.z + LONG_PLANK_HALF.x + 0.4, 0);
    p.yaw = 0;
    p.step({}, 20);
    p.lookAt(pk.x, pk.y + 0.05, pk.z + behind, 20);
    p.step({ grab: true });
    expect(s.physics.heldId).toBe(plankOf(s).id);
    p.step({}, 30);
    return { s, p };
}

describe('the long plank spans the ditch, laid by a player from the bank (3.8 m, the tutorial only)', () => {
    it('the ditch is 2.3 m between its lips: the 3.8 m plank laid centred has 0.75 m on each bank', () => {
        expect(LIP_NEAR - LIP_FAR).toBeCloseTo(2.3, 9);
        expect(height(0, LIP_NEAR + 0.01)).toBeCloseTo(height(0, LIP_NEAR + 1), 6);
        expect(height(0, LIP_NEAR - 0.1)).toBeLessThan(height(0, LIP_NEAR + 1) - 0.05);
        expect(LONG_PLANK_LENGTH / 2 - (LIP_NEAR - LIP_FAR) / 2).toBeCloseTo(0.75, 9);
    });

    it('carried by input (gripped by its middle) to the edge and let go, it lies on both banks with 0.4 m or more on each, and carries you over', () => {
        const { s, p } = takePlank(0);
        // walk it forward until your toes are at the lip, let go
        for (let i = 0; i < 600 && s.player.z > LIP_NEAR + 0.1; i++) p.step({ moveZ: 0.3 });
        p.step({}, 30);
        expect(s.physics.heldId).toBe(plankOf(s).id);
        p.step({ grab: true });
        p.step({}, 120);
        const b = bearing(s);
        console.info(`laid by hand: ${b.near.toFixed(2)} m on the near bank, ${b.far.toFixed(2)} m on the far bank`);
        expect(b.near).toBeGreaterThan(0.4);
        expect(b.far).toBeGreaterThan(0.4);
        expect(b.tilt).toBeLessThan(0.03);
        // walk over it
        expect(p.walkTo(plankOf(s).pose.p.x, LIP_FAR - 1.5, 0.3, 900, 0.5)).toBe(true);
        expect(s.player.z).toBeLessThan(LIP_FAR - 1);
        expect(s.player.y).toBeGreaterThan(height(s.player.x, s.player.z) - 0.05);
        expect(s.progress.falls).toBe(0);
    });

    it('thrown by input from a step back from the edge, it lands across the ditch with 0.4 m or more on each bank', () => {
        const { s, p } = takePlank(0);
        for (let i = 0; i < 600 && s.player.z > LIP_NEAR + THROW_BACK; i++) p.step({ moveZ: 0.3 });
        const p0 = p.pitch;
        for (let i = 1; i <= 30; i++) {
            p.pitch = p0 * (1 - i / 30);
            p.step();
        }
        p.step({}, 30);
        p.step({ throw: true });
        p.step({}, 180);
        const b = bearing(s);
        console.info(`thrown: ${b.near.toFixed(2)} m on the near bank, ${b.far.toFixed(2)} m on the far bank`);
        expect(b.near).toBeGreaterThan(0.4);
        expect(b.far).toBeGreaterThan(0.4);
        expect(b.tilt).toBeLessThan(0.03);
    });

    it('the plank starts lying flat on the near bank, its far end short of the ditch', () => {
        const s = fresh();
        const pk = plankOf(s).pose.p;
        expect(pk.z - LONG_PLANK_HALF.x).toBeGreaterThan(LIP_NEAR);
        expect(bearing(s).tilt).toBeLessThan(0.01);
        expect(Math.abs(pk.y - (height(pk.x, pk.z) + LONG_PLANK_HALF.z))).toBeLessThan(0.02);
        // the standard 2.4 m plank is not in the tutorial
        expect(s.plank.visible).toBe(false);
    });
});

/** How far back from the near lip the throw test stands (m). */
const THROW_BACK = 1.25;

function run(s: LabSim, k: number, c: Partial<PlayerCommand> = {}): void {
    for (let i = 0; i < k; i++) s.step(cmd(5000 + i, c));
}
