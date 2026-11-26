/**
 * The hand winch (Epic 5, #52: a solo aid): one beaver hauls a whole log, which no beaver can lift
 * alone, by input alone, with the rope's tension doing the work.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { LOG_RADIUS } from '../../src/assets/props.ts';
import { YARD_WINCH, timberYardLevel, yardSurfaceY } from '../../src/levels/timber-yard.ts';
import { ACTION_DROP } from '../../src/sim/commands.ts';
import { GROUND } from '../../src/sim/joints/graph.ts';
import { ROPE } from '../../src/sim/joints/rope.ts';
import { EYE_HEIGHT, LabSim } from '../../src/sim/lab-sim.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { WINCH, WINCH_PULL, decodeWinchRope, encodeWinchRope } from '../../src/sim/winch.ts';
import { pose, quatFromYawPitchRoll } from '../../src/voxels/math.ts';

import { Player } from './play.ts';

beforeAll(() => initPhysics());

const DRUM = { x: YARD_WINCH.x, y: YARD_WINCH.y + WINCH.drumHeight, z: YARD_WINCH.z };

/** The yard with a whole log lying along x on the rope's line, its near end `far` m east of the drum. */
function yardWithLog(far: number, players = 1) {
    const s = new LabSim({ level: timberYardLevel });
    if (players > 1) s.setPlayerCount(players);
    const log = s.entities.find((e) => e.name === 'log')!;
    const lx = DRUM.x + far + 1;
    const lz = DRUM.z;
    s.physics.place(log.id, pose(lx, yardSurfaceY(lx, lz) + 0.25, lz, quatFromYawPitchRoll(0, 0, 0)));
    s.fpActive = true;
    // standing at the crank (north of the winch), facing it
    s.placePlayer(DRUM.x, DRUM.z + 1.1, 0);
    const g = new Player(s);
    g.step({}, 90);
    return { s, g, log, body: s.physics.bodies.get(log.id)!.body };
}

/** Takes the hook, hooks the log 10 cm from its near end, and goes back to the crank (by input). */
function hookAndCrank(s: LabSim, g: Player, body: ReturnType<typeof yardWithLog>['body'], logId: number) {
    const end = () => ({ x: body.translation().x - 0.9, y: body.translation().y, z: body.translation().z });
    g.lookAt(DRUM.x, DRUM.y, DRUM.z);
    g.step({ grab: true });
    expect(g.walkTo(end().x - 0.9, end().z + 0.6, 0.25)).toBe(true);
    g.lookAt(end().x, end().y, end().z);
    g.step({ grab: true });
    expect(s.winch!.hooked).toBe(logId);
    expect(g.walkTo(DRUM.x, DRUM.z + 1.1, 0.25)).toBe(true);
    g.lookAt(DRUM.x, DRUM.y, DRUM.z);
    g.step({ grab: true });
    expect(s.winch!.cranking).toBe(0);
    return end;
}

describe('the hand winch (#52)', () => {
    it('one beaver hooks a whole log 8 m off and winds it in by input alone; it never lifts the log or flings it', () => {
        const { s, g, log, body } = yardWithLog(8);
        expect(body.mass()).toBeGreaterThan(100); // (113 kg: past one beaver's 650 N grip)
        // take the hook at the winch
        g.lookAt(DRUM.x, DRUM.y, DRUM.z);
        g.step({ grab: true });
        expect(s.winch!.carrying).toBe(0);
        // walk out to the log's near (west) end, hook it there
        const end = () => ({ x: body.translation().x - 0.9, y: body.translation().y, z: body.translation().z });
        expect(g.walkTo(end().x - 0.9, end().z + 0.6, 0.25)).toBe(true);
        g.lookAt(end().x, end().y, end().z);
        g.step({ grab: true });
        expect(s.winch!.hooked).toBe(log.id);
        // back to the winch, and crank
        expect(g.walkTo(DRUM.x, DRUM.z + 1.1, 0.25)).toBe(true);
        g.lookAt(DRUM.x, DRUM.y, DRUM.z);
        g.step({ grab: true });
        expect(s.winch!.cranking).toBe(0);
        const p0 = { ...body.translation() };
        // (its height over the ground beneath it: the run crosses a low mound)
        const clearance = () => body.translation().y - yardSurfaceY(body.translation().x, body.translation().z);
        const c0 = clearance();
        const start = s.tick;
        let peak = 0;
        let fastest = 0;
        let highest = 0;
        const player0 = { x: s.player.x, z: s.player.z };
        // wind until its near end is within a metre of the drum (or a minute is up)
        const near = () => Math.hypot(end().x - DRUM.x, end().z - DRUM.z);
        while (near() > 1.0 && s.tick - start < 60 * 60) {
            g.step();
            peak = Math.max(peak, s.winch!.tension);
            const v = body.linvel();
            fastest = Math.max(fastest, Math.hypot(v.x, v.y, v.z));
            highest = Math.max(highest, clearance() - c0);
        }
        const seconds = (s.tick - start) / 60;
        const hauled = Math.hypot(body.translation().x - p0.x, body.translation().z - p0.z);
        const moved = Math.hypot(s.player.x - player0.x, s.player.z - player0.z);
        console.log(
            `winch: a ${body.mass().toFixed(0)} kg log hauled ${hauled.toFixed(2)} m in ${seconds.toFixed(1)} s (cranking at ${WINCH.windSpeed} m/s); peak tension ${peak.toFixed(0)} N (the gearing's limit ${WINCH_PULL} N, the rope's strength ${ROPE.strength} N); fastest ${fastest.toFixed(2)} m/s, lifted at most ${(highest * 100).toFixed(1)} cm off the ground; the cranking beaver moved ${(moved * 100).toFixed(1)} cm`
        );
        expect(near()).toBeLessThanOrEqual(1.0);
        expect(hauled).toBeGreaterThan(6.5);
        // the rope did it: wound at the crank's pace, never faster
        expect(seconds).toBeGreaterThanOrEqual(hauled / WINCH.windSpeed - 1);
        expect(fastest).toBeLessThan(2 * WINCH.windSpeed + 0.3);
        // dragged along the ground, not lifted
        expect(highest).toBeLessThan(0.15);
        // a log weighing 1.1 kN drags with under the winch's pull; the rope never near its strength
        expect(peak).toBeLessThan(WINCH_PULL);
        expect(s.events.filter((e) => e.text.startsWith('Snap!'))).toEqual([]);
        // the crank is let go: the ratchet holds what it has wound
        g.step({ grab: true });
        expect(s.winch!.cranking).toBe(-1);
        const held = s.winch!.length;
        g.step({}, 120);
        expect(s.winch!.length).toBe(held);
    }, 120_000);

    it('against what will not come, winding stalls at the gearing’s pull: the ratchet clicks, the rope holds', () => {
        const { s, g, log, body } = yardWithLog(3);
        hookAndCrank(s, g, body, log.id);
        // then the log is staked down (a stand-in for a snag): it will not come
        body.setBodyType(2 /* fixed */, true);
        const clicks0 = s.winchClicks;
        let peak = 0;
        for (let k = 0; k < 60 * 20; k++) {
            g.step();
            peak = Math.max(peak, s.winch!.tension);
        }
        const r = s.ropes.get([...s.ropes.ropes()][0].id)!;
        console.log(
            `winch against a staked log: tension up to ${peak.toFixed(0)} N (the gearing's ${WINCH_PULL} N), ${s.winchClicks - clicks0} ratchet clicks, the rope ${s.ropes.size ? 'whole' : 'snapped'}`
        );
        expect(r.b).toBe(GROUND);
        expect(s.winchClicks - clicks0).toBeGreaterThan(5);
        expect(peak).toBeLessThan(WINCH_PULL * 1.15);
        expect(peak).toBeLessThan(ROPE.strength);
        expect(s.ropes.size).toBe(1);
    }, 120_000);

    it('a beaver standing on the hauled log is not carried: the log is wound out from under it', () => {
        const { s, g, log, body } = yardWithLog(6, 2);
        const end = hookAndCrank(s, g, body, log.id);
        // a second beaver stands on the log's middle (placed there: placePlayer finds the ground)
        const t = body.translation();
        s.placePlayer(t.x, t.z, Math.PI / 2, 1);
        const rider = s.players[1];
        rider.y = t.y + LOG_RADIUS + 0.02;
        s.physics.placeCharacter(rider.x, rider.y, rider.z, 1);
        g.step({}, 10);
        const r0 = { x: rider.x, y: rider.y, z: rider.z };
        expect(r0.y).toBeGreaterThan(yardSurfaceY(r0.x, r0.z) + 0.3); // (on the log, not the ground)
        const l0 = { ...body.translation() };
        let highest = 0;
        for (let k = 0; k < 60 * 12; k++) {
            g.step();
            highest = Math.max(highest, rider.y - r0.y);
        }
        const logMoved = Math.hypot(body.translation().x - l0.x, body.translation().z - l0.z);
        const riderMoved = Math.hypot(rider.x - r0.x, rider.z - r0.z);
        console.log(
            `winch with a rider: the log wound ${logMoved.toFixed(2)} m in 12 s; the beaver on it moved ${riderMoved.toFixed(2)} m, rose at most ${(highest * 100).toFixed(1)} cm, now ${(rider.y - yardSurfaceY(rider.x, rider.z)).toFixed(2)} m over the ground; near end ${Math.hypot(end().x - DRUM.x, end().z - DRUM.z).toFixed(2)} m from the drum`
        );
        expect(logMoved).toBeGreaterThan(2.5);
        expect(riderMoved).toBeLessThan(0.5 * logMoved);
        expect(highest).toBeLessThan(0.2); // (not flung)
    }, 120_000);

    it('past the rope’s strength it snaps: the hook is lost, the crank stops, nothing is yanked to the drum', () => {
        const { s, g, log, body } = yardWithLog(4);
        hookAndCrank(s, g, body, log.id);
        g.step({}, 60);
        // something far stronger than a beaver hauls the log the other way (a stand-in for a ute),
        // pulling harder each second: past 10 kN the rope parts
        let pull = 0;
        let peak = 0;
        let snapped = -1;
        for (let k = 0; k < 60 * 8 && snapped < 0; k++) {
            pull += 4000 / 60;
            body.applyImpulse({ x: pull / 60, y: 0, z: 0 }, true);
            g.step();
            peak = Math.max(peak, s.winch!.tension);
            if (s.events.some((e) => e.text.startsWith('Snap!'))) snapped = k;
        }
        expect(snapped).toBeGreaterThanOrEqual(0);
        // after it parts, the log is not whipped back towards the drum
        let towards = 0;
        for (let k = 0; k < 60; k++) {
            g.step();
            towards = Math.max(towards, -body.linvel().x);
        }
        console.log(
            `winch, overloaded: the rope parted at ${(snapped / 60).toFixed(2)} s, peak tension ${peak.toFixed(0)} N (strength ${ROPE.strength} N); the log's speed back towards the drum after, at most ${towards.toFixed(2)} m/s`
        );
        expect(peak).toBeGreaterThan(WINCH_PULL);
        expect(peak).toBeLessThan(ROPE.strength * 1.2);
        expect(s.winch!.hooked).toBe(-1);
        expect(s.winch!.cranking).toBe(-1);
        expect(s.ropes.size).toBe(0);
        // (no recoil: a rope's stored stretch let go at once would send it back at metres a second)
        expect(towards).toBeLessThan(0.05);
    }, 120_000);

    it('the rope goes to guests as a few numbers, only what it is hooked to; malformed is nothing', () => {
        const idx = (id: number) => (id === 40 ? 7 : -1);
        expect(encodeWinchRope(null, idx)).toEqual([]);
        expect(encodeWinchRope({ from: DRUM, body: -1, local: { x: 0, y: 0, z: 0 }, player: 2 }, idx)).toEqual([1, 2]);
        const hooked = encodeWinchRope(
            { from: DRUM, body: 40, local: { x: -0.904, y: 0.2, z: 0.013 }, player: -1 },
            idx
        );
        expect(hooked).toEqual([2, 7, -90, 20, 1]);
        expect(decodeWinchRope(hooked, 10, 4)).toEqual({ index: 7, local: { x: -0.9, y: 0.2, z: 0.01 } });
        expect(decodeWinchRope([1, 2], 10, 4)).toEqual({ hand: 2 });
        for (const bad of [
            [],
            null,
            'x',
            [1, 9],
            [2, 12, 0, 0, 0],
            [2, 1, 0, 0],
            [2, 1, 0, 1e6, 0],
            [3],
            [2, 1, NaN, 0, 0]
        ])
            expect(decodeWinchRope(bad, 10, 4)).toBeNull();
    });

    it('its hook never goes into the bucket (it crosses only over what is built, #132)', () => {
        const { s, g } = yardWithLog(8);
        const b = s.physics.bodies.get(s.bucket.id)!.body;
        // the bucket set down a couple of metres east of the winch, off the log's line
        const bx = DRUM.x + 2;
        const bz = DRUM.z + 0.8;
        s.physics.place(s.bucket.id, pose(bx, yardSurfaceY(bx, bz) + 0.02, bz, quatFromYawPitchRoll(0, 0, 0)));
        g.lookAt(DRUM.x, DRUM.y, DRUM.z);
        g.step({ grab: true });
        expect(s.winch!.carrying).toBe(0);
        expect(g.walkTo(bx - 1, bz, 0.25)).toBe(true);
        g.step({}, 30);
        const t = b.translation();
        g.lookAt(t.x, t.y + 0.15, t.z);
        const eye = { x: s.player.x, y: s.player.y + EYE_HEIGHT, z: s.player.z };
        expect(s.physics.viewHit(eye, g.yaw, g.pitch, 0)?.pb.id).toBe(s.bucket.id);
        g.step({ grab: true });
        // nothing hooked: the beaver still has the hook, and no rope is tied
        expect(s.winch!.hooked).toBe(-1);
        expect(s.winch!.carrying).toBe(0);
        expect(s.ropes.size).toBe(0);
    }, 60_000);

    it('a hooked log taken out of the world (the sawmill takes it) frees the rope: the winch lets go', () => {
        const { s, g, log, body } = yardWithLog(6);
        hookAndCrank(s, g, body, log.id);
        g.step({}, 120);
        expect(s.winch!.tension).toBeGreaterThan(0);
        const n0 = s.events.length;
        // what the sawmill does to a log it takes: out of the world
        s.physics.setEnabled(log.id, false);
        g.step({}, 5);
        expect(s.ropes.size).toBe(0);
        expect(s.winch!.hooked).toBe(-1);
        expect(s.winch!.cranking).toBe(-1);
        expect(s.winch!.tension).toBe(0);
        const said = s.events.slice(n0).map((e) => e.text);
        expect(said).toContain('The winch rope comes free: what it held is gone.');
        expect(said.some((t) => t.startsWith('Snap!'))).toBe(false);
        // and its hook can be taken again
        g.lookAt(DRUM.x, DRUM.y, DRUM.z);
        g.step({ grab: true });
        expect(s.winch!.carrying).toBe(0);
    }, 120_000);

    it('Q at the drum lets the rope run back only with empty hands; holding something, Q drops that', () => {
        const { s, g, log, body } = yardWithLog(6);
        hookAndCrank(s, g, body, log.id);
        g.step({ grab: true }); // stop cranking
        expect(s.winch!.cranking).toBe(-1);
        // pick up the plank lying by the winch (placed), still facing the drum
        const plank = s.plank;
        s.physics.place(plank.id, pose(DRUM.x + 0.5, YARD_WINCH.y + 0.06, DRUM.z + 0.5, quatFromYawPitchRoll(0, 0, 0)));
        g.step({}, 30);
        g.lookAt(DRUM.x + 0.5, YARD_WINCH.y + 0.06, DRUM.z + 0.5);
        g.step({ grab: true });
        expect(s.physics.heldIdOf(0)).toBe(plank.id);
        g.lookAt(DRUM.x, DRUM.y, DRUM.z);
        g.step({ action: ACTION_DROP });
        // the plank is dropped, the rope still hooked
        expect(s.physics.heldIdOf(0)).toBe(-1);
        expect(s.winch!.hooked).toBe(log.id);
        // empty-handed, at the drum: now it runs back
        g.lookAt(DRUM.x, DRUM.y, DRUM.z);
        g.step({ action: ACTION_DROP });
        expect(s.winch!.hooked).toBe(-1);
        expect(s.ropes.size).toBe(0);
    }, 120_000);
});
