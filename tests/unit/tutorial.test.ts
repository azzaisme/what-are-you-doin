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

/** Looks ahead (0.35 rad down, as you walk carrying something) over half a second. */
function lookAhead(p: Player): void {
    const p0 = p.pitch;
    for (let i = 1; i <= 30; i++) {
        p.pitch = p0 + ((-0.35 - p0) * i) / 30;
        p.step();
    }
}

describe('the long plank spans the ditch, laid by a player from the bank (3.8 m, the tutorial only)', () => {
    it('the ditch is 2.3 m between its lips: the 3.8 m plank laid centred has 0.75 m on each bank', () => {
        expect(LIP_NEAR - LIP_FAR).toBeCloseTo(2.3, 9);
        expect(height(0, LIP_NEAR + 0.01)).toBeCloseTo(height(0, LIP_NEAR + 1), 6);
        expect(height(0, LIP_NEAR - 0.1)).toBeLessThan(height(0, LIP_NEAR + 1) - 0.05);
        expect(LONG_PLANK_LENGTH / 2 - (LIP_NEAR - LIP_FAR) / 2).toBeCloseTo(0.75, 9);
    });

    // wherever you grab it (the end nearest you, a quarter along, the middle), wherever you look
    // (level to 1.2 rad down), walking slowly or at full speed (W), carried toward the ditch and let
    // go with your toes 0.4 to 1.0 m short of the lip, it lies on both banks: you carry it balanced,
    // low in front of you whatever you look at, its middle 2.2 m ahead (LONG_PLANK_CARRY_AHEAD)
    for (const [grab, behind] of [
        ['its near end', LONG_PLANK_HALF.x - 0.1],
        ['a quarter along', LONG_PLANK_HALF.x / 2],
        ['its middle', 0]
    ] as const)
        for (const short of [0.4, 0.7, 1.0])
            it(`grabbed by ${grab}, let go with your toes ${short} m short of the lip: 0.3 m or more on each bank, level and walkable, at any pitch and speed`, () => {
                let least = Infinity;
                for (let pitch = 0; pitch >= -1.2 - 1e-9; pitch -= 0.2)
                    for (const speed of [0.3, 1]) {
                        const { s, p } = takePlank(behind);
                        const p0 = p.pitch;
                        for (let i = 1; i <= 30; i++) {
                            p.pitch = p0 + ((pitch - p0) * i) / 30;
                            p.step();
                        }
                        const at = LIP_NEAR + short + BODY_RADIUS;
                        for (let i = 0; i < 900 && s.player.z > at; i++) p.step({ moveZ: speed });
                        p.step({}, 30);
                        const where = `pitch ${pitch.toFixed(1)}, speed ${speed}`;
                        expect(s.physics.heldId, where).toBe(plankOf(s).id);
                        const toes = s.player.z - BODY_RADIUS - LIP_NEAR;
                        p.step({ grab: true });
                        p.step({}, 120);
                        const b = bearing(s);
                        least = Math.min(least, b.near, b.far);
                        expect(b.near, `${where}: near bank (toes ${toes.toFixed(2)} m short)`).toBeGreaterThan(0.3);
                        expect(b.far, `${where}: far bank (toes ${toes.toFixed(2)} m short)`).toBeGreaterThan(0.3);
                        expect(b.tilt, where).toBeLessThan(0.03);
                        // walk over it
                        p.pitch = 0;
                        expect(p.walkTo(plankOf(s).pose.p.x, LIP_FAR - 1.5, 0.3, 900, 0.5), where).toBe(true);
                        expect(s.player.y, where).toBeGreaterThan(height(s.player.x, s.player.z) - 0.05);
                        expect(s.progress.falls, where).toBe(0);
                    }
                console.info(`grabbed by ${grab}, toes ${short} m short: at least ${least.toFixed(2)} m on a bank`);
            }, 120_000);

    /** From the bank: look at the plank, take it, back off, carry it to 0.7 m short and lay it. */
    function relay(s: LabSim, p: Player): { near: number; far: number; tilt: number } {
        const pk = plankOf(s).pose.p;
        p.lookAt(pk.x, pk.y + 0.05, pk.z, 30);
        p.step({ grab: true });
        p.step({}, 30);
        expect(s.physics.heldId).toBe(plankOf(s).id);
        p.lookAt(pk.x, height(0, LIP_NEAR + 1), LIP_FAR - 3, 30);
        for (let i = 0; i < 150; i++) p.step({ moveZ: -0.5 });
        p.step({}, 60);
        expect(plankOf(s).pose.p.y).toBeGreaterThan(height(0, LIP_NEAR + 1));
        for (let i = 0; i < 900 && s.player.z > LIP_NEAR + 0.7 + BODY_RADIUS; i++) p.step({ moveZ: 0.3 });
        p.step({}, 30);
        p.step({ grab: true });
        p.step({}, 120);
        return bearing(s);
    }

    it('let go with your toes at the lip (too far), it hangs off the near lip; you take it again and lay it', () => {
        const { s, p } = takePlank(0);
        for (let i = 0; i < 900 && s.player.z > LIP_NEAR + BODY_RADIUS; i++) p.step({ moveZ: 0.3 });
        p.step({}, 30);
        p.step({ grab: true });
        p.step({}, 180);
        const miss = bearing(s);
        console.info(`let go at the lip: ${miss.near.toFixed(2)} m on the near bank, tilted ${miss.tilt.toFixed(2)}`);
        expect(miss.near).toBeLessThan(0.3);
        const b = relay(s, p);
        console.info(`laid again: ${b.near.toFixed(2)} m on the near bank, ${b.far.toFixed(2)} m on the far bank`);
        expect(b.near).toBeGreaterThan(0.3);
        expect(b.far).toBeGreaterThan(0.3);
        expect(s.progress.falls).toBe(0);
    });

    it('carried across you and let go at the lip, it falls into the ditch (out of reach): it comes back where it was, with a toast, and you lay it from there', () => {
        const s = fresh();
        const p = new Player(s);
        const start = { ...plankOf(s).pose.p };
        // from its side, so it lies across you
        s.placePlayer(start.x + 1.2, start.z, 0);
        p.yaw = Math.PI / 2;
        p.step({}, 20);
        p.lookAt(start.x, start.y + 0.05, start.z, 20);
        p.step({ grab: true });
        expect(s.physics.heldId).toBe(plankOf(s).id);
        // turn to face the ditch (it turns with you: still across you) and walk to the lip
        p.lookAt(start.x, height(0, LIP_NEAR + 1), LIP_FAR, 40);
        for (let i = 0; i < 900 && s.player.z > LIP_NEAR + BODY_RADIUS; i++) p.step({ moveZ: 0.3 });
        p.step({}, 30);
        p.step({ grab: true });
        let lowest = Infinity;
        for (let i = 0; i < 60; i++) {
            p.step();
            lowest = Math.min(lowest, plankOf(s).pose.p.y);
        }
        console.info(`dropped across the ditch: down to y ${lowest.toFixed(2)}`);
        expect(lowest).toBeLessThan(height(0, LIP_NEAR + 1) - 0.6);
        // out of reach from the bank (the grab finds nothing)
        const pk = plankOf(s).pose.p;
        p.lookAt(pk.x, pk.y + 0.05, pk.z, 20);
        p.step({ grab: true });
        expect(s.physics.heldId).toBe(-1);
        // 1.5 s in the ditch: back where it was, and a toast says how to lay it
        p.step({}, 120);
        const back = plankOf(s).pose.p;
        expect(Math.hypot(back.x - start.x, back.z - start.z)).toBeLessThan(0.05);
        expect(s.events.some((e) => e.kind === 'recovered' && e.text.includes('a step before the edge'))).toBe(true);
        // walk round to its near end, take it, carry it to 0.7 m short and lay it
        p.pitch = 0;
        expect(p.walkTo(start.x, start.z + LONG_PLANK_HALF.x + 0.4, 0.15, 1200, 0.5)).toBe(true);
        p.yaw = 0;
        p.lookAt(start.x, start.y + 0.05, start.z, 20);
        p.step({ grab: true });
        expect(s.physics.heldId).toBe(plankOf(s).id);
        for (let i = 0; i < 900 && s.player.z > LIP_NEAR + 0.7 + BODY_RADIUS; i++) p.step({ moveZ: 0.3 });
        p.step({}, 30);
        p.step({ grab: true });
        p.step({}, 120);
        const b = bearing(s);
        console.info(
            `laid after it came back: ${b.near.toFixed(2)} m on the near bank, ${b.far.toFixed(2)} m on the far bank`
        );
        expect(b.near).toBeGreaterThan(0.3);
        expect(b.far).toBeGreaterThan(0.3);
        expect(s.progress.falls).toBe(0);
    });

    it('thrown by input from a step back from the edge, it lands across the ditch with 0.4 m or more on each bank', () => {
        const { s, p } = takePlank(0);
        lookAhead(p);
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

/** The player's body radius (m): your toes are this far ahead of where you stand. */
const BODY_RADIUS = 0.3;

/** How far back from the near lip the throw test stands (m). */
const THROW_BACK = 2.25;

function run(s: LabSim, k: number, c: Partial<PlayerCommand> = {}): void {
    for (let i = 0; i < k; i++) s.step(cmd(5000 + i, c));
}
