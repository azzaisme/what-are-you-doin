import { beforeAll, describe, expect, it } from 'vitest';

import { TREE_CUT, TREE_STATE } from '../../src/assets/forestry.ts';
import { PINE_TRUNK_HEIGHT } from '../../src/levels/common.ts';
import { SAWMILL, STAND_CROWN_RADIUS, sawmillToWorld } from '../../src/levels/forestry.ts';
import { BRIDGE, BRIDGE_X, YARD_FORESTRY, YARD_Y, timberYardLevel } from '../../src/levels/timber-yard.ts';
import { neutralCommand } from '../../src/sim/commands.ts';
import type { PlayerCommand } from '../../src/sim/commands.ts';
import { WOOD } from '../../src/sim/forestry.ts';
import { EYE_HEIGHT, LabSim } from '../../src/sim/lab-sim.ts';
import { SAW } from '../../src/sim/sawmill.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { pose, quatFromYawPitchRoll, quatMul, quatRotate } from '../../src/voxels/math.ts';
import type { Pose } from '../../src/voxels/math.ts';

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
        const tree = 2;
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
        expect(Math.abs(axisOf(log.pose).y)).toBeLessThan(0.2);
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
            // away from the chewer
            expect(d.x * Math.cos(a) + d.z * Math.sin(a)).toBeLessThan(-0.99);
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

describe('the gate: a tree becomes planks in a bridge', () => {
    it('two beavers fell a tree, carry its log to the sawmill, it makes planks, and the planks deck the bridge', () => {
        const s = yard(2);
        let k = 100;
        const both = (a: Partial<PlayerCommand>, b: Partial<PlayerCommand>, n = 1) => {
            for (let i = 0; i < n; i++) {
                s.step(cmd(k, a), cmd(k, b));
                k++;
            }
        };
        // fell tree 2 from its east side: it falls west, towards the mill
        const tree = 2;
        const t = YARD_FORESTRY.trees[tree];
        standBy(s, tree, -0.4, 1.0, 0);
        standBy(s, tree, 0.4, 1.0, 1);
        both({}, {}, 10);
        const ca = lookAt(s, 0, t.x, YARD_Y + 0.6, t.z);
        const cb = lookAt(s, 1, t.x, YARD_Y + 0.6, t.z);
        for (let i = 0; i < 600 && s.forestry.treeState(tree).phase === 'standing'; i++)
            both({ ...ca, grab: i % 30 === 0 }, { ...cb, grab: i % 30 === 0 });
        expect(s.forestry.treeState(tree).phase).toBe('down');
        both({}, {}, 300);
        const log = s.forestry.logOf(tree)!;
        expect(Math.abs(axisOf(log.pose).x)).toBeGreaterThan(0.9);
        // one at each end, facing it along its length (player 0 the west end, player 1 the east)
        const lp = log.pose.p;
        s.placePlayer(lp.x - 1.4, lp.z, -Math.PI / 2, 0);
        s.placePlayer(lp.x + 1.4, lp.z, Math.PI / 2, 1);
        both({}, {}, 20);
        const a = lookAt(s, 0, lp.x - 0.7, lp.y, lp.z);
        const b = lookAt(s, 1, lp.x + 0.7, lp.y, lp.z);
        both({ ...a, grab: true }, { ...b, grab: true });
        expect(s.physics.holders(log.id)).toBe(2);
        const y0 = lp.y;
        // lift, then walk it to the infeed guide: west (player 0 backs up, player 1 follows), then
        // across to the guide's line
        // lift: each hold point about 0.7 m above where the log lay (the co-op test's way)
        const up = (i: number) =>
            Math.asin(
                Math.max(-1, Math.min(1, (y0 + 0.7 - (s.players[i].y + EYE_HEIGHT)) / s.physics.rig(i)!.holdDist))
            );
        const la = { yaw: a.yaw, pitch: up(0) };
        const lb = { yaw: b.yaw, pitch: up(1) };
        both(la, lb, 60);
        expect(log.pose.p.y).toBeGreaterThan(y0 + 0.25);
        // carry it 2.5 m west together, slowly (player 0 backs up, player 1 follows)
        const x0 = log.pose.p.x;
        let minY = Infinity;
        for (let i = 0; i < 900 && log.pose.p.x > x0 - 2.5; i++) {
            both({ ...la, moveZ: -0.3 }, { ...lb, moveZ: 0.3 });
            minY = Math.min(minY, log.pose.p.y);
        }
        expect(s.physics.holders(log.id)).toBe(2);
        expect(x0 - log.pose.p.x).toBeGreaterThan(2.4);
        // carried, not dragged: off the ground all the way (low: 113 kg is near two beavers' limit)
        expect(minY).toBeGreaterThan(y0 + 0.05);
        both({ grab: true }, { grab: true });
        expect(s.physics.holders(log.id)).toBe(0);
        // the rest of the way to the mill is more of the same: lay it in the infeed guide
        s.placePlayer(SPOT.x + 3, SPOT.z + 2.5, 0, 0);
        s.placePlayer(SPOT.x + 4, SPOT.z + 2.5, 0, 1);
        s.physics.place(log.id, inGuide());
        for (let i = 0; i < 120 && s.sawmill!.phase === 'ready'; i++) both({}, {});
        expect(s.sawmill!.stats.takenIds).toEqual([log.id]);
        for (let i = 0; i < SAW.cutTicks + 60; i++) both({}, {});
        const planks = s.entities.filter(
            (e) => e.name.startsWith('extra-plank-') && e.visible && Math.abs(e.pose.p.z - SPOT.z) < 1
        );
        expect(planks.length).toBe(3);
        expect(s.sawmill!.stats.planks).toBe(3);
        // the bridge: the yard's two beams side by side across the creek as stringers, decked with
        // the three sawn planks laid along them (placed: building it by hand is the bridge tests' job)
        const flatAlongZ = quatMul(quatFromYawPitchRoll(Math.PI / 2, 0, 0), quatFromYawPitchRoll(0, Math.PI / 2, 0));
        ['beam-0', 'beam-1'].forEach((n, i) =>
            s.physics.place(byName(s, n).id, pose(BRIDGE_X - 0.11 + i * 0.22, YARD_Y + 0.2, BRIDGE.zc, flatAlongZ))
        );
        both({}, {}, 12);
        both({}, {}, 48);
        // two along the beams, one across them at mid-span on top
        const flat = quatFromYawPitchRoll(0, Math.PI / 2, 0);
        planks.forEach((p, i) =>
            s.physics.place(
                p.id,
                i < 2
                    ? pose(BRIDGE_X - 0.11 + i * 0.22, YARD_Y + 0.3, BRIDGE.zc, { ...flatAlongZ })
                    : pose(BRIDGE_X, YARD_Y + 0.42, BRIDGE.zc, { ...flat })
            )
        );
        both({}, {}, 120);
        const deckY = YARD_Y + 0.2;
        for (const p of planks) expect(p.pose.p.y).toBeGreaterThan(deckY);
        // walk across on the planks
        s.placePlayer(BRIDGE_X, BRIDGE.nearEdge + 1.2, 0, 0);
        s.placePlayer(BRIDGE_X - 8, 8, 0, 1);
        both({}, {}, 20);
        let onDeck = 0;
        for (let i = 0; i < 400 && s.players[0].z > BRIDGE.farEdge - 1; i++) {
            both({ moveZ: 0.6 }, {});
            if (s.players[0].z < BRIDGE.nearFace && s.players[0].z > BRIDGE.farFace && s.players[0].y > deckY + 0.05)
                onDeck++;
        }
        expect(s.progress.falls).toBe(0);
        expect(onDeck).toBeGreaterThan(30);
        expect(s.players[0].z).toBeLessThan(BRIDGE.farEdge - 0.5);
        for (const p of planks) expect(p.pose.p.y).toBeGreaterThan(deckY);
    }, 60_000);

    it('solo: one beaver fells a tree with the axe, bucks the log and carries a half to the sawmill', () => {
        const s = yard();
        let k = 100;
        const step = (c: Partial<PlayerCommand> = {}, n = 1) => {
            for (let i = 0; i < n; i++) s.step(cmd(k++, c));
        };
        // pick up the axe where it lies by the infeed
        const axe = byName(s, 'axe');
        s.placePlayer(axe.pose.p.x + 1.1, axe.pose.p.z, Math.PI / 2);
        step({}, 20);
        step({ ...lookAt(s, 0, axe.pose.p.x, axe.pose.p.y, axe.pose.p.z), grab: true });
        expect(s.physics.heldId).toBe(axe.id);
        // chop tree 4 from its east side: it falls west, towards the mill
        const tree = 4;
        const t = YARD_FORESTRY.trees[tree];
        standBy(s, tree, 0, 1.1);
        inHand(s, axe.id);
        const from = { k };
        expect(cutDown(s, tree, from)).toBe(4);
        k = from.k;
        step({}, 200);
        const log = s.forestry.logOf(tree)!;
        expect(log.pose.p.x).toBeLessThan(t.x - 0.8);
        // buck it: three blows, aimed at it each time
        const lp = log.pose.p;
        s.placePlayer(lp.x + 0.4, lp.z + 1.0, 0);
        inHand(s, axe.id);
        step({}, 20);
        for (let i = 0; i < 150 && s.forestry.stats.bucked === 0; i++)
            step({ ...lookAt(s, 0, lp.x, lp.y, lp.z), grab: i % 30 === 0 });
        expect(s.forestry.stats.bucked).toBe(1);
        // put the axe down, take the west half (nearest the mill) by its east end
        step({ action: 4 });
        step({}, 30);
        const halves = s.entities.filter((e) => e.name.startsWith('short-log') && e.visible);
        const half = halves.reduce((a, b) => (a.pose.p.x < b.pose.p.x ? a : b));
        const hp = half.pose.p;
        s.placePlayer(hp.x + 1.3, hp.z, Math.PI / 2);
        step({}, 20);
        const a = lookAt(s, 0, hp.x + 0.25, hp.y, hp.z);
        step({ ...a, grab: true });
        expect(s.physics.heldId).toBe(half.id);
        const y0 = hp.y;
        step({ yaw: a.yaw, pitch: 0 }, 60);
        expect(half.pose.p.y).toBeGreaterThan(y0 + 0.3);
        // sideways (south: facing west, that is right) onto the guide's line, then west into it
        const guide = inGuide().p;
        for (let i = 0; i < 300 && s.players[0].z > guide.z; i++) step({ yaw: a.yaw, pitch: 0, moveX: 0.25 });
        step({ yaw: a.yaw, pitch: 0 }, 40);
        for (let i = 0; i < 600 && half.pose.p.x > guide.x; i++) step({ yaw: a.yaw, pitch: 0, moveZ: 0.4 });
        expect(Math.abs(half.pose.p.z - guide.z)).toBeLessThan(0.3);
        step({ yaw: a.yaw, pitch: -0.5 }, 30);
        step({ yaw: a.yaw, grab: true });
        expect(s.physics.heldId).toBe(-1);
        s.placePlayer(SPOT.x + 2, SPOT.z + 2.5, 0);
        // (it may roll against a rail first)
        for (let i = 0; i < 300 && s.sawmill!.phase === 'ready'; i++) step();
        expect(s.sawmill!.stats.takenIds).toEqual([half.id]);
        step({}, SAW.cutTicks + 30);
        expect(s.sawmill!.stats.planks).toBe(1);
        // a whole log is too heavy for one beaver to lift
        expect(s.physics.bodies.get(s.log.id)!.body.mass() * 9.81).toBeGreaterThan(650);
        expect(s.physics.bodies.get(half.id)!.body.mass() * 9.81).toBeLessThan(650);
    }, 60_000);
});

describe('resources come back', () => {
    it('a stump regrows into a tree once its log has gone, and can be felled again', () => {
        const s = yard();
        const from = { k: 100 };
        standBy(s, 5, Math.PI);
        cutDown(s, 5, from);
        for (let k = 0; k < 240; k++) s.step(cmd(from.k++));
        const log = s.forestry.logOf(5)!;
        // still lying by the stump: no regrowth
        for (let k = 0; k < WOOD.regrowTicks; k++) s.step(cmd(from.k++));
        expect(s.forestry.treeState(5).phase).toBe('down');
        // carted off (here: taken by the mill), and the chewer steps back
        s.forestry.take(log.id);
        s.placePlayer(YARD_FORESTRY.trees[5].x - 3, YARD_FORESTRY.trees[5].z, 0);
        for (let k = 0; k < 5; k++) s.step(cmd(from.k++));
        expect(s.forestry.treeState(5).phase).toBe('standing');
        expect(s.forestry.stats.regrown).toBe(1);
        expect(byName(s, 'tree-5').anim[TREE_STATE]).toBe(0);
        // the slot is free: it fells again into the same pool
        standBy(s, 5, Math.PI);
        cutDown(s, 5, from);
        expect(s.forestry.treeState(5).phase).toBe('down');
        expect(s.forestry.stats.felled).toBe(2);
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
