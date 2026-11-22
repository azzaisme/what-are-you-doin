import { beforeAll, describe, expect, it } from 'vitest';

import { SAW_MODE, TREE_CUT, TREE_STATE } from '../../src/assets/forestry.ts';
import { sfx } from '../../src/audio/sfx.ts';
import { MAX_PARTICLES, ParticleFX } from '../../src/fx/particles.ts';
import { WoodFX } from '../../src/fx/wood-fx.ts';
import { PINE_TRUNK_HEIGHT } from '../../src/levels/common.ts';
import { SAWMILL, STAND_CROWN_RADIUS, sawmillToWorld } from '../../src/levels/forestry.ts';
import { BRIDGE_X, YARD_FORESTRY, YARD_Y, timberYardLevel } from '../../src/levels/timber-yard.ts';
import { valleyLevel } from '../../src/levels/valley.ts';
import { GuestSession, HostSession, listGames } from '../../src/net/session.ts';
import { MemoryHub } from '../../src/net/transport.ts';
import { SIM_DT } from '../../src/sim/clock.ts';
import { neutralCommand } from '../../src/sim/commands.ts';
import type { PlayerCommand } from '../../src/sim/commands.ts';
import { WOOD } from '../../src/sim/forestry.ts';
import { createLabEntities } from '../../src/sim/lab-entities.ts';
import { EYE_HEIGHT, LabSim } from '../../src/sim/lab-sim.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { SAW } from '../../src/sim/sawmill.ts';
import { GRID_SIZE, cellIndexX, cellIndexZ } from '../../src/voxels/grid.ts';
import { pose, quatFromYawPitchRoll, quatMul, quatRotate } from '../../src/voxels/math.ts';
import type { Pose } from '../../src/voxels/math.ts';
import { M, voxelMaterial } from '../../src/voxels/palette.ts';
import { STATE_STRIDE } from '../../src/workers/protocol.ts';
import { VoxelService } from '../../src/workers/voxel-service.ts';

beforeAll(() => initPhysics());

const cmd = (n: number, c: Partial<PlayerCommand> = {}): PlayerCommand => ({ ...neutralCommand(n), ...c });
const byName = (s: LabSim, n: string) => s.entities.find((e) => e.name === n)!;
const SPOT = YARD_FORESTRY.sawmill!;

/** A yard sim with `players` in first person, settled. */
function yard(players = 1): LabSim {
    const s = new LabSim({ level: timberYardLevel });
    s.step(cmd(0));
    s.fpActive = true;
    if (players > 1) s.setPlayerCount(players);
    for (let n = 1; n < 30; n++) s.step(cmd(n), cmd(n));
    return s;
}

/** The yaw and pitch that look from player i's eye at a point. */
function lookAt(s: LabSim, i: number, x: number, y: number, z: number): { yaw: number; pitch: number } {
    const p = s.players[i];
    const dx = x - p.x;
    const dz = z - p.z;
    const dy = y - (p.y + EYE_HEIGHT);
    return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
}

/** Puts player i a distance from stand tree n, on a side (angle about +y, from +x towards +z). */
function standBy(s: LabSim, n: number, side: number, dist = 1.0, i = 0): void {
    const t = YARD_FORESTRY.trees[n];
    s.placePlayer(t.x + Math.cos(side) * dist, t.z + Math.sin(side) * dist, 0, i);
}

/** Chews (or chops, holding the axe) tree n from where player 0 stands until it falls; returns the presses. */
function cutDown(s: LabSim, n: number, from: { k: number }): number {
    const t = YARD_FORESTRY.trees[n];
    for (let k = 0; k < 10; k++) s.step(cmd(from.k++));
    const look = lookAt(s, 0, t.x, YARD_Y + 0.6, t.z);
    let presses = 0;
    for (let k = 0; k < 900 && s.forestry.treeState(n).phase === 'standing'; k++) {
        const grab = k % 30 === 0;
        if (grab) presses++;
        s.step(cmd(from.k++, { ...look, grab }));
    }
    return presses;
}

/** Puts a body in player 0's hands (a teleported player's grip would snap). */
function inHand(s: LabSim, id: number): void {
    const p = s.players[0];
    const at = pose(p.x - Math.sin(p.yaw) * 0.8, p.y + EYE_HEIGHT - 0.5, p.z - Math.cos(p.yaw) * 0.8);
    s.physics.place(id, at);
    s.physics.grabById(id, at.p, 0.9);
}

/** Horizontal heading of a log's long axis (+x), as a unit vector. */
function axisOf(p: Pose): { x: number; y: number; z: number } {
    const v = { x: 0, y: 0, z: 0 };
    quatRotate(p.q, 1, 0, 0, v);
    return v;
}

/** A pose lying in the sawmill's infeed guide, along it. */
function inGuide(dy = 0.05): Pose {
    const G = SAWMILL.guide;
    const w = sawmillToWorld(SPOT, (G.x0 + G.x1) / 2, SAWMILL.feedY + dy, 0);
    return pose(w.x, w.y, w.z, quatFromYawPitchRoll(SPOT.yaw, 0, 0));
}

describe('forestry: the logging stand', () => {
    it('stand trees are spaced so no felled trunk reaches a neighbour, clear of the scenery trees', () => {
        const trees = timberYardLevel.layout(1).trees;
        const stand = YARD_FORESTRY.trees;
        for (const a of stand) {
            for (const b of stand) if (a !== b) expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(3);
            // the scenery's crowns never reach into a stand tree's (clearing one never nibbles them)
            for (const t of trees)
                expect(Math.hypot(a.x - t.x, a.z - t.z)).toBeGreaterThan(STAND_CROWN_RADIUS + 1.2 * t.scale);
            // a trunk falling any way stays inside the play area's walls
            const A = timberYardLevel.playArea;
            expect(a.x).toBeLessThan(A.maxX - 2.6);
            expect(a.z).toBeLessThan(A.maxZ - 2.45);
        }
        // the trunk is taller than a scenery pine's, so the cut piece is a whole log
        expect(PINE_TRUNK_HEIGHT * 1.3).toBeLessThan(2.6);
        for (const name of ['saw-post', 'saw-beam', 'saw-rail', 'saw-rack'])
            expect(timberYardLevel.layout(1).pieces.some((p) => p.name === name)).toBe(true);
    });

    it('chewing a stand tree ten times fells it away from the chewer; the trunk becomes one log', () => {
        const s = yard();
        const from = { k: 100 };
        const tree = 1; // upright: no lean to pull it
        const t = YARD_FORESTRY.trees[tree];
        // stand west of the tree: it falls east
        standBy(s, tree, Math.PI);
        const marker = byName(s, `tree-${tree}`);
        expect(marker.visible).toBe(true);
        expect(s.interaction(0).target).toBe(null);
        const presses = cutDown(s, tree, from);
        expect(presses).toBe(10);
        expect(s.forestry.stats.bites).toBe(10);
        expect(s.events.some((e) => e.kind === 'wood' && e.text.includes('creaks'))).toBe(true);
        const timber = s.events.find((e) => e.text.startsWith('Timber!'));
        expect(timber?.text).toContain('east');
        // the marker says so in the snapshots (guests and the voxel worker read it)
        expect(marker.anim[TREE_STATE]).toBe(1);
        expect(marker.anim[TREE_CUT]).toBe(0);
        const log = s.forestry.logOf(tree)!;
        expect(log.name).toBe('felled-log-0');
        expect(log.visible).toBe(true);
        // the crown rides the falling trunk, then breaks off as it lands
        expect(byName(s, 'crown-0').visible).toBe(true);
        for (let k = 0; k < 120; k++) s.step(cmd(from.k++));
        expect(byName(s, 'crown-0').visible).toBe(false);
        expect(s.forestry.stats.felled).toBe(1);
        // lying on the ground east of the stump, along the fall
        const p = log.pose.p;
        expect(p.y).toBeLessThan(YARD_Y + 0.6);
        expect(p.x - t.x).toBeGreaterThan(0.8);
        expect(Math.abs(p.z - t.z)).toBeLessThan(0.4);
        // lying (its foot may rest on its own stump: up to ~15 degrees)
        expect(Math.abs(axisOf(log.pose).y)).toBeLessThan(0.3);
        expect(Math.abs(axisOf(log.pose).x)).toBeGreaterThan(0.9);
        // only a stump is left: a ray at chest height passes where the trunk stood
        expect(s.forestry.aimTree({ x: t.x - 1.5, y: YARD_Y + 1, z: t.z }, -Math.PI / 2, 0)).toBe(-1);
        const g = s.physics.groundY(t.x, t.z, YARD_Y + 3)!;
        expect(g).toBeLessThan(YARD_Y + 0.4);
        expect(g).toBeGreaterThan(YARD_Y + 0.2);
    });

    it('falls the predicted way, from every side, every time (within 15 degrees)', () => {
        const worst: number[] = [];
        for (let side = 0; side < 8; side++) {
            const s = yard();
            const from = { k: 100 };
            const tree = side % 6;
            const a = (side / 8) * Math.PI * 2;
            standBy(s, tree, a);
            cutDown(s, tree, from);
            const d = s.forestry.fallDirection(tree);
            // away from the chewer, give or take the tree's lean (an upright tree: exactly away)
            const lean = YARD_FORESTRY.trees[tree].lean;
            if (!lean) expect(d.x * Math.cos(a) + d.z * Math.sin(a)).toBeLessThan(-0.99);
            // just landed (it may roll in a gust later)
            for (let k = 0; k < 100; k++) s.step(cmd(from.k++));
            const t = YARD_FORESTRY.trees[tree];
            const p = s.forestry.logOf(tree)!.pose.p;
            const got = Math.atan2(p.z - t.z, p.x - t.x);
            const want = Math.atan2(d.z, d.x);
            const err = Math.abs(Math.atan2(Math.sin(got - want), Math.cos(got - want)));
            worst.push((err * 180) / Math.PI);
        }
        expect(Math.max(...worst)).toBeLessThan(15);
    }, 60_000);

    it("a tree's weight biases the fall: a leaning tree falls between the push and its lean", () => {
        // tree 0 leans 0.11 rad north (more than a cut's 0.07 push): chewed from the west, the push
        // is east, and it falls north-east (about 58 degrees from the push), as predicted
        const s = yard();
        const from = { k: 100 };
        standBy(s, 0, Math.PI);
        cutDown(s, 0, from);
        const d = s.forestry.fallDirection(0);
        const want = Math.atan2(d.z, d.x);
        expect(Math.abs(want - Math.atan2(-0.11, 0.07))).toBeLessThan(1e-6);
        expect((Math.abs(want) * 180) / Math.PI).toBeGreaterThan(45); // far from "away" (east, 0)
        expect(s.events.some((e) => e.text.includes('north-east'))).toBe(true);
        for (let k = 0; k < 100; k++) s.step(cmd(from.k++));
        const t = YARD_FORESTRY.trees[0];
        const p = s.forestry.logOf(0)!.pose.p;
        const got = Math.atan2(p.z - t.z, p.x - t.x);
        expect((Math.abs(Math.atan2(Math.sin(got - want), Math.cos(got - want))) * 180) / Math.PI).toBeLessThan(15);
        // chewed from the north (pushing it south), it still falls north: its weight wins
        const s2 = yard();
        const f2 = { k: 100 };
        standBy(s2, 0, -Math.PI / 2 + 0.7, 1.0);
        cutDown(s2, 0, f2);
        expect(s2.forestry.fallDirection(0).z).toBeLessThan(0);
        // an upright tree (1) falls exactly away from the cut
        const s3 = yard();
        standBy(s3, 1, 0);
        cutDown(s3, 1, { k: 100 });
        expect(s3.forestry.fallDirection(1).x).toBeCloseTo(-1, 6);
    });

    it('the same cuts give the same fall (deterministic)', () => {
        const run = () => {
            const s = yard();
            const from = { k: 100 };
            standBy(s, 4, 0.4);
            cutDown(s, 4, from);
            for (let k = 0; k < 200; k++) s.step(cmd(from.k++));
            return { ...s.forestry.logOf(4)!.pose.p };
        };
        expect(run()).toEqual(run());
    });

    it('two beavers chewing from one side fell it in half the time', () => {
        const s = yard(2);
        const tree = 0;
        const t = YARD_FORESTRY.trees[tree];
        standBy(s, tree, Math.PI * 0.4, 1.0, 0);
        standBy(s, tree, Math.PI * 0.6, 1.0, 1);
        for (let k = 0; k < 10; k++) s.step(cmd(k), cmd(k));
        const a = lookAt(s, 0, t.x, YARD_Y + 0.6, t.z);
        const b = lookAt(s, 1, t.x, YARD_Y + 0.6, t.z);
        let k = 0;
        for (; k < 900 && s.forestry.treeState(tree).phase === 'standing'; k++)
            s.step(cmd(k, { ...a, grab: k % 30 === 0 }), cmd(k, { ...b, grab: k % 30 === 0 }));
        expect(s.forestry.stats.bites).toBe(10);
        expect(k).toBeLessThan(5 * 30 + 2);
        // both stand south of it: it falls north
        expect(s.forestry.fallDirection(tree).z).toBeLessThan(-0.95);
    });

    it('spamming the bite button does not cut faster', () => {
        const s = yard();
        const tree = 1;
        const t = YARD_FORESTRY.trees[tree];
        standBy(s, tree, 0);
        for (let k = 0; k < 10; k++) s.step(cmd(k));
        const look = lookAt(s, 0, t.x, YARD_Y + 0.6, t.z);
        for (let k = 0; k < 60; k++) s.step(cmd(100 + k, { ...look, grab: true }));
        // 60 ticks of presses: a bite every WOOD.biteTicks
        expect(s.forestry.stats.bites).toBe(Math.ceil(60 / WOOD.biteTicks));
    });

    it('the axe chops a tree in four blows, and bucks a log into two short logs', () => {
        const s = yard();
        const axe = byName(s, 'axe');
        expect(axe.visible).toBe(true);
        const from = { k: 100 };
        // pick up the axe
        s.placePlayer(axe.pose.p.x + 1.1, axe.pose.p.z, Math.PI / 2);
        for (let k = 0; k < 20; k++) s.step(cmd(from.k++));
        const look = lookAt(s, 0, axe.pose.p.x, axe.pose.p.y, axe.pose.p.z);
        s.step(cmd(from.k++, { ...look, grab: true }));
        expect(s.physics.heldId).toBe(axe.id);
        // walk it to the tree; looking at the trunk, a grab is a blow (the axe stays in hand)
        const tree = 3;
        standBy(s, tree, Math.PI / 2, 1.1);
        inHand(s, axe.id);
        const blows = cutDown(s, tree, from);
        expect(blows).toBe(4);
        expect(s.forestry.stats.blows).toBe(4);
        expect(s.physics.heldId).toBe(axe.id);
        for (let k = 0; k < 300; k++) s.step(cmd(from.k++));
        // buck the log: three blows into it
        const log = s.forestry.logOf(tree)!;
        const lp = log.pose.p;
        s.placePlayer(lp.x + 1.0, lp.z + 0.4, 0);
        inHand(s, axe.id);
        for (let k = 0; k < 30; k++) s.step(cmd(from.k++));
        // (re-aim at the log before each blow: the held axe nudges it as it rolls)
        for (let k = 0; k < 120 && s.forestry.stats.bucked === 0; k++) {
            const at = lookAt(s, 0, lp.x, lp.y, lp.z);
            s.step(cmd(from.k++, { ...at, grab: k % 30 === 0 }));
        }
        expect(s.forestry.stats.bucked).toBe(1);
        expect(log.visible).toBe(false);
        const halves = s.entities.filter((e) => e.name.startsWith('short-log') && e.visible);
        expect(halves.length).toBe(2);
        // each half is light enough for one beaver (650 N): about 57 kg
        for (const h of halves) expect(s.physics.bodies.get(h.id)!.body.mass()).toBeLessThan(60);
    });
});

describe('the sawmill', () => {
    it('takes a log lying in the guide and makes three planks out of it, once', () => {
        const s = yard();
        const log = s.log;
        s.placePlayer(SPOT.x, SPOT.z + 3, 0);
        s.physics.place(log.id, inGuide());
        let k = 100;
        for (; k < 100 + SAW.settleTicks + 40 && s.sawmill!.phase === 'ready'; k++) s.step(cmd(k));
        expect(s.sawmill!.phase).toBe('cutting');
        expect(s.sawmill!.stats.taken).toBe(1);
        // the interlock: the log is out of the world (nobody can grab it again)
        expect(s.physics.bodies.get(log.id)!.enabled).toBe(false);
        const sawn = () => s.entities.filter((e) => e.name.startsWith('extra-plank-') && e.visible).length;
        const before = sawn();
        expect(before).toBe(5); // the yard's own stack
        for (let n = 0; n < SAW.cutTicks + 30; n++) s.step(cmd(k++));
        expect(s.sawmill!.phase).toBe('ready');
        expect(sawn() - before).toBe(3);
        expect(s.sawmill!.stats.planks).toBe(3);
        // and never again: nothing more comes out
        for (let n = 0; n < 600; n++) s.step(cmd(k++));
        expect(s.sawmill!.stats.taken).toBe(1);
        expect(s.sawmill!.stats.planks).toBe(3);
        expect(sawn() - before).toBe(3);
        // the planks lie on the rack, at rest, clear of each other
        const rackX = SPOT.x + SAWMILL.outfeed.x;
        const planks = s.entities.filter(
            (e) => e.name.startsWith('extra-plank-') && e.visible && Math.abs(e.pose.p.x - rackX) < 1.5
        );
        expect(planks.length).toBe(3);
        for (const p of planks) expect(Math.abs(p.pose.p.y - (YARD_Y + 0.15))).toBeLessThan(0.08);
        // the pile's log comes back later (a reusable resource)
        for (let n = 0; n < WOOD.respawnTicks; n++) s.step(cmd(k++));
        expect(s.physics.bodies.get(log.id)!.enabled).toBe(true);
        expect(log.visible).toBe(true);
    });

    it('its lever switches it to beams: a whole log makes one 3.2 m beam, a short log still a plank', () => {
        const s = yard();
        const L = SAWMILL.lever;
        const lever = sawmillToWorld(SPOT, L.x, L.y + 0.12, L.z);
        // stand in front of the near post and grab the lever
        s.placePlayer(lever.x + 0.2, lever.z - 1.2, 0);
        let k = 100;
        for (let n = 0; n < 20; n++) s.step(cmd(k++));
        const look = lookAt(s, 0, lever.x, lever.y, lever.z);
        s.step(cmd(k++, look));
        expect(s.interaction(0).target).toBe('sawmill');
        s.step(cmd(k++, { ...look, grab: true }));
        expect(s.sawmill!.mode).toBe('beam');
        expect(s.physics.heldId).toBe(-1);
        expect(s.sawmill!.entity.anim[SAW_MODE]).toBe(1);
        // a log in the guide: one beam
        s.placePlayer(SPOT.x, SPOT.z + 3, 0);
        s.physics.place(s.log.id, inGuide());
        for (let n = 0; n < SAW.settleTicks + SAW.cutTicks + 60; n++) s.step(cmd(k++));
        const beams = s.entities.filter((e) => e.name.startsWith('beam-') && e.visible && e.id >= 396);
        expect(beams.map((b) => b.name)).toEqual(['beam-12']);
        expect(s.sawmill!.stats.planks).toBe(1);
        const b = beams[0].pose.p;
        expect(Math.abs(b.y - (YARD_Y + 0.1 + 0.075))).toBeLessThan(0.05);
        // a short log: still a plank (too short for a beam)
        const short = byName(s, 'short-log-0');
        s.physics.setEnabled(short.id, true);
        s.physics.place(short.id, inGuide());
        for (let n = 0; n < SAW.settleTicks + SAW.cutTicks + 60; n++) s.step(cmd(k++));
        expect(s.entities.filter((e) => e.name.startsWith('extra-plank-') && e.visible && e.id >= 380).length).toBe(1);
        // and back to planks
        s.placePlayer(lever.x + 0.2, lever.z - 1.2, 0);
        for (let n = 0; n < 20; n++) s.step(cmd(k++));
        s.step(cmd(k++, { ...lookAt(s, 0, lever.x, lever.y, lever.z), grab: true }));
        expect(s.sawmill!.mode).toBe('planks');
    });

    it('a second log waits in the guide until the first is sawn', () => {
        const s = yard();
        s.placePlayer(SPOT.x, SPOT.z + 3, 0);
        s.physics.place(s.log.id, inGuide());
        let k = 100;
        for (; k < 200 && s.sawmill!.phase === 'ready'; k++) s.step(cmd(k));
        const second = byName(s, 'extra-log-0');
        s.physics.place(second.id, inGuide(0.1));
        for (let n = 0; n < 120; n++) s.step(cmd(k++));
        expect(s.sawmill!.stats.taken).toBe(1);
        expect(s.physics.bodies.get(second.id)!.enabled).toBe(true);
        for (let n = 0; n < SAW.cutTicks + SAW.settleTicks + 60; n++) s.step(cmd(k++));
        expect(s.sawmill!.stats.taken).toBe(2);
        expect(s.sawmill!.stats.takenIds).toEqual([s.log.id, second.id]);
    });

    it('a plank, a log across the guide or a log being held is not taken', () => {
        const s = yard();
        s.placePlayer(SPOT.x + 2, SPOT.z + 1.6, 0);
        s.physics.place(s.plank.id, inGuide());
        let k = 100;
        for (let n = 0; n < 120; n++) s.step(cmd(k++));
        expect(s.sawmill!.stats.taken).toBe(0);
        s.physics.setEnabled(s.plank.id, false);
        const across = inGuide(0.1);
        quatMul(quatFromYawPitchRoll(Math.PI / 2, 0, 0), across.q, across.q);
        s.physics.place(s.log.id, across);
        for (let n = 0; n < 120; n++) s.step(cmd(k++));
        expect(s.sawmill!.stats.taken).toBe(0);
    });

    it('safety: the blade stops while a player stands at it, and carries on when they leave', () => {
        const s = yard();
        s.placePlayer(SPOT.x, SPOT.z + 3, 0);
        s.physics.place(s.log.id, inGuide());
        let k = 100;
        for (; k < 200 && s.sawmill!.phase === 'ready'; k++) s.step(cmd(k));
        for (let n = 0; n < 60; n++) s.step(cmd(k++));
        const p0 = s.sawmill!.progress;
        // walk into the blade guard
        s.placePlayer(SPOT.x - 0.3, SPOT.z + 0.75, 0);
        for (let n = 0; n < 120; n++) s.step(cmd(k++));
        expect(s.sawmill!.stopped).toBe('guard');
        const p1 = s.sawmill!.progress;
        expect(p1 - p0).toBeLessThan(0.02);
        expect(s.events.some((e) => e.text.startsWith('Safety stop'))).toBe(true);
        s.placePlayer(SPOT.x, SPOT.z + 3, 0);
        for (let n = 0; n < SAW.cutTicks; n++) s.step(cmd(k++));
        expect(s.sawmill!.stats.planks).toBe(3);
    });

    it('safety: planks only come out where the rack is clear, and the machine waits otherwise', () => {
        const s = yard();
        s.placePlayer(SPOT.x, SPOT.z + 3, 0);
        // a plank from the yard's stack lying across each lane of the rack
        const O = SAWMILL.outfeed;
        const crates = ['extra-plank-0', 'extra-plank-1', 'extra-plank-2', 'extra-plank-3'].map((n) => byName(s, n));
        s.physics.place(s.log.id, inGuide());
        let k = 100;
        for (; k < 200 && s.sawmill!.phase === 'ready'; k++) s.step(cmd(k));
        // across the lanes (along z) on the end bars of the rack, two layers
        crates.forEach((c, i) => {
            const w = sawmillToWorld(SPOT, O.bars[(i % 2) * 2], O.barTop + 0.08 + (i >> 1) * 0.11, 0);
            s.physics.place(c.id, pose(w.x, w.y, w.z, quatFromYawPitchRoll(SPOT.yaw + Math.PI / 2, Math.PI / 2, 0)));
        });
        for (let n = 0; n < SAW.cutTicks + 120; n++) s.step(cmd(k++));
        expect(s.sawmill!.stopped).toBe('outfeed');
        expect(s.sawmill!.stats.planks).toBe(0);
        // clear the rack: out come the planks
        for (const c of crates) s.physics.setEnabled(c.id, false);
        for (let n = 0; n < 30; n++) s.step(cmd(k++));
        expect(s.sawmill!.stats.planks).toBe(3);
        expect(s.sawmill!.phase).toBe('ready');
    });
});

describe('resources come back', () => {
    it('a stump does not regrow while its log still lies by it (regrowth after sawing: the gate test)', () => {
        const s = yard();
        const from = { k: 100 };
        standBy(s, 5, Math.PI);
        cutDown(s, 5, from);
        // the chewer steps back
        s.step(cmd(from.k++));
        for (let k = 0; k < 60; k++) s.step(cmd(from.k++, { yaw: Math.PI / 2, moveZ: 1 }));
        for (let k = 0; k < WOOD.regrowTicks + 600; k++) s.step(cmd(from.k++));
        expect(s.forestry.treeState(5).phase).toBe('down');
        expect(s.forestry.stats.regrown).toBe(0);
    }, 60_000);

    it('a felled log lost in the creek goes back to its pool', () => {
        const s = yard();
        const from = { k: 100 };
        standBy(s, 0, Math.PI);
        cutDown(s, 0, from);
        for (let k = 0; k < 200; k++) s.step(cmd(from.k++));
        const log = s.forestry.logOf(0)!;
        s.physics.place(log.id, pose(BRIDGE_X + 4, -0.4, -2, quatFromYawPitchRoll(0, 0, 0)));
        for (let k = 0; k < WOOD.lostTicks + 120; k++) s.step(cmd(from.k++));
        expect(s.physics.bodies.get(log.id)!.enabled).toBe(false);
        expect(s.forestry.stats.returned).toBe(1);
    });
});

describe('voxels: a felled tree leaves the static world, a regrown one comes back', () => {
    it('the voxel worker follows the stand markers in the snapshots', () => {
        const svc = new VoxelService();
        svc.build(1, 'yard');
        const w = svc.world;
        const drawable = createLabEntities().entities.filter((e) => e.asset.parts.length > 0);
        const states = new Float64Array(drawable.length * STATE_STRIDE);
        const tree = 2;
        const t = YARD_FORESTRY.trees[tree];
        const g = YARD_FORESTRY.ground(t.x, t.z);
        const m = drawable.findIndex((e) => e.name === `tree-${tree}`);
        const o = m * STATE_STRIDE;
        states[o] = 1;
        states[o + 1] = t.x;
        states[o + 2] = g;
        states[o + 3] = t.z;
        states[o + 7] = 1;
        const at = (y: number) =>
            voxelMaterial(w.staticAt(cellIndexX(t.x), Math.floor(y / GRID_SIZE), cellIndexZ(t.z)));
        // every cell above the stump within 1.2 m of the trunk (the neighbours' crowns reach 1.5 m
        // into the 3 m between trees)
        const crown = () => {
            let n = 0;
            let h = 0;
            const r = Math.ceil(1.2 / GRID_SIZE);
            const i0 = cellIndexX(t.x);
            const k0 = cellIndexZ(t.z);
            for (let j = Math.floor((g + 0.45) / GRID_SIZE); j < Math.ceil((g + 6) / GRID_SIZE); j++)
                for (let k = k0 - r; k <= k0 + r; k++)
                    for (let i = i0 - r; i <= i0 + r; i++) {
                        if (Math.hypot(i - i0, k - k0) > r) continue;
                        const v = w.staticAt(i, j, k);
                        if (v === 0) continue;
                        n++;
                        h = (h * 31 + v * 7 + i * 3 + j * 5 + k) % 1_000_000_007;
                    }
            return { n, h };
        };
        const before = crown();
        expect(at(g + 0.7)).toBe(M.Bark);
        expect(before.n).toBeGreaterThan(200);
        let f = 0;
        svc.frame(f++, 0, 'coverage50', false, states);
        expect(crown()).toEqual(before); // standing: nothing changes
        states[o + 8 + TREE_STATE] = 1;
        const r = svc.frame(f++, 0.1, 'coverage50', false, states);
        expect(crown().n).toBe(0);
        expect(at(g + 0.7)).toBe(0);
        expect([M.LogBark, M.LogEnd]).toContain(at(g + 0.2));
        expect(r.units.some((u) => u.mode === 'static')).toBe(true);
        // the ground under it is untouched
        expect(at(g - 0.03)).not.toBe(0);
        states[o + 8 + TREE_STATE] = 0;
        svc.frame(f++, 0.2, 'coverage50', false, states);
        expect(crown()).toEqual(before);
        expect(at(g + 0.7)).toBe(M.Bark);
    }, 60_000);
});

describe('wood effects', () => {
    it('chips fly at every bite, needles burst when the crown breaks off, sawdust while it saws (and their sounds)', () => {
        const heard: string[] = [];
        const held: number[] = [];
        sfx.setSink({
            play: (n) => heard.push(n),
            hold: (_k, n, _at, o) => {
                expect(n).toBe('saw');
                held.push(o?.pitch ?? 1);
            }
        });
        const s = yard();
        const fx = new ParticleFX(timberYardLevel, []);
        const f = s.forestry.ents;
        fx.wood = new WoodFX({ chips: f.chips.slot, needles: f.needles.slot, sawmill: f.sawmill.slot }, SPOT);
        const run = (c: Partial<PlayerCommand>, n: number, from: { k: number }) => {
            for (let i = 0; i < n; i++) {
                s.step(cmd(from.k++, c));
                fx.update(s.tick * SIM_DT, s.ring);
            }
        };
        const from = { k: 100 };
        const t = YARD_FORESTRY.trees[1];
        standBy(s, 1, Math.PI);
        run({}, 10, from);
        const look = lookAt(s, 0, t.x, YARD_Y + 0.6, t.z);
        for (let b = 0; b < 10; b++) {
            run({ ...look, grab: true }, 1, from);
            run(look, 29, from);
        }
        expect(fx.spawned.chips).toBe(10);
        expect(heard.filter((n) => n === 'chop')).toHaveLength(10);
        run({}, 200, from);
        expect(fx.spawned.needles).toBe(1);
        expect(heard.filter((n) => n === 'thud')).toHaveLength(1);
        expect(held).toHaveLength(0); // the saw only runs with a log in it
        // sawdust: a log in the guide
        s.placePlayer(SPOT.x, SPOT.z + 3, 0);
        s.physics.place(s.log.id, inGuide());
        run({}, SAW.settleTicks + 10 + 120, from);
        expect(fx.spawned.sawdust).toBeGreaterThan(5);
        expect(fx.count).toBeLessThanOrEqual(MAX_PARTICLES);
        // the motor is held on every frame it cuts, rising a little through the cut
        expect(held.length).toBeGreaterThan(60);
        expect(held[held.length - 1]).toBeGreaterThan(held[0]);
        // and let go once the planks are out (it fades by itself)
        const n = held.length;
        run({}, SAW.cutTicks + 120, from);
        expect(s.sawmill!.running).toBe(false);
        const after = held.length;
        run({}, 60, from);
        expect(held.length).toBe(after);
        expect(after).toBeGreaterThanOrEqual(n);
        sfx.setSink(null);
    });
});

describe('the Valley: the yard’s stand and sawmill', () => {
    it('a stand tree falls there by chewing, and the sawmill is there with its lever', () => {
        const s = new LabSim({ level: valleyLevel });
        let k = 0;
        const step = (c: Partial<PlayerCommand> = {}, n = 1) => {
            for (let i = 0; i < n; i++) s.step(cmd(k++, c));
        };
        step({}, 30);
        s.fpActive = true;
        const def = valleyLevel.forestry!;
        expect(def.trees.length).toBe(6);
        const t = def.trees[1];
        s.placePlayer(t.x - 1, t.z, 0);
        step({}, 20);
        const look = lookAt(s, 0, t.x, def.ground(t.x, t.z) + 0.6, t.z);
        for (let i = 0; i < 400 && s.forestry.treeState(1).phase === 'standing'; i++)
            step({ ...look, grab: i % 30 === 0 });
        expect(s.forestry.treeState(1).phase).toBe('down');
        // the sawmill stands where the yard's does, turned with the yard
        const saw = def.sawmill!;
        expect(s.sawmill!.entity.visible).toBe(true);
        const L = SAWMILL.lever;
        const lever = sawmillToWorld(saw, L.x, L.y + 0.12, L.z);
        const out = sawmillToWorld(saw, L.x, L.y + 0.12, L.z - 1.2);
        s.placePlayer(out.x, out.z, 0);
        step({}, 20);
        step({ ...lookAt(s, 0, lever.x, lever.y, lever.z), grab: true });
        expect(s.sawmill!.mode).toBe('beam');
    }, 60_000);
});

describe('online: a guest logs too', () => {
    it("a guest's grab presses chew a tree on the host; the guest sees the cut and the felled tree", async () => {
        const hub = new MemoryHub();
        const host = new LabSim({ level: timberYardLevel });
        host.step(cmd(0));
        host.fpActive = true;
        const hs = await HostSession.start(hub.transport('host'), host, 'yard', 'wood');
        let clock = 0;
        const guestSim = new LabSim({ level: timberYardLevel });
        const gs = await GuestSession.join(
            hub.transport('guest'),
            guestSim,
            listGames(hub.channel('lobby', 'w'))[0],
            () => clock
        );
        expect(gs.slot).toBe(1);
        const tree = 5;
        const t = YARD_FORESTRY.trees[tree];
        host.placePlayer(t.x - 1, t.z, 0, 1);
        let n = 0;
        const tick = (c: Partial<PlayerCommand>) => {
            gs.sendInput(cmd(n, c));
            host.step(cmd(n), hs.commandFor(1), [hs.commandFor(2), hs.commandFor(3)]);
            hs.afterStep((slot) => host.interactionIds(slot));
            clock += 1000 / 60;
            n++;
        };
        for (let i = 0; i < 10; i++) tick({});
        const look = lookAt(host, 1, t.x, YARD_Y + 0.6, t.z);
        for (let i = 0; i < 12; i++) tick(look);
        // the host tells the guest what its grab would do: chew this tree
        const marker = byName(guestSim, `tree-${tree}`);
        expect(gs.hud[1]?.target).toBe(marker.id);
        for (let i = 0; i < 600 && host.forestry.treeState(tree).phase === 'standing'; i++)
            tick({ ...look, grab: i % 30 === 0 });
        expect(host.forestry.treeState(tree).phase).toBe('down');
        for (let i = 0; i < 9; i++) tick({});
        // the guest's snapshots say so (the voxel worker and the prompt read the marker there)
        const out = pose();
        const anim = new Float64Array(10);
        expect(guestSim.ring.sample(marker.slot, guestSim.ring.newestTick / 60, out, anim)).toBe(true);
        expect(anim[TREE_STATE]).toBe(1);
        gs.leave();
        hs.stop();
    });
});
