/**
 * The log dolly (Epic 5, #52: a solo aid): one end of a whole log in its cradle, against its stop,
 * the other end dragging, one beaver tows it by input. Towed, not carried: the grip only pulls along
 * the ground, with one beaver's 650 N, and lets go when that is not enough.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { DOLLY } from '../../src/assets/dolly.ts';
import { LOG_RADIUS } from '../../src/assets/props.ts';
import { YARD_WINCH, timberYardLevel, yardSurfaceY } from '../../src/levels/timber-yard.ts';
import { ACTION_DROP } from '../../src/sim/commands.ts';
import { LabSim } from '../../src/sim/lab-sim.ts';
import { GRAB } from '../../src/sim/physics/grab.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { WINCH } from '../../src/sim/winch.ts';
import { pose, quatFromYawPitchRoll, quatRotate } from '../../src/voxels/math.ts';

import { Player } from './play.ts';

beforeAll(() => initPhysics());

/** The run: west along z = 11 from x = 5.8, open flat yard (clear of the winch and the sign post). */
const RUN = { x: 5.8, z: 11.0 };
/** Facing west (-x), behind the dolly, to walk forwards pushing it. */
const FACE_WEST = Math.PI / 2;

/**
 * The yard with the dolly at the start of the run, its stop to the east (behind); with `log`, the
 * log's east end in its cradle against the stop, the rest ahead to the west, its west end on the
 * ground (placed: loading is not by input).
 */
function yardWithDolly(log: boolean, players = 1) {
    const s = new LabSim({ level: timberYardLevel });
    if (players > 1) s.setPlayerCount(players);
    const y = yardSurfaceY(RUN.x, RUN.z);
    s.physics.place(s.dolly.id, pose(RUN.x, y + 0.005, RUN.z, quatFromYawPitchRoll(0, 0, 0)));
    const lb = s.physics.bodies.get(s.log.id)!.body;
    if (log) {
        // the stop's inner face is 0.25 m east of the dolly's middle
        const lx = RUN.x + 0.25 - 1.0 - 0.01;
        s.physics.place(
            s.log.id,
            pose(lx, y + DOLLY.deckTop + LOG_RADIUS + 0.02, RUN.z, quatFromYawPitchRoll(0, 0, 0))
        );
    } else s.physics.place(s.log.id, pose(-6, y + 0.25, 6, quatFromYawPitchRoll(0, 0, 0)));
    s.fpActive = true;
    // standing east of the dolly, behind it, facing west
    s.placePlayer(RUN.x + 1.4, RUN.z, FACE_WEST);
    const g = new Player(s);
    g.step({}, 120);
    return { s, g, db: s.physics.bodies.get(s.dolly.id)!.body, lb };
}

/** Takes the dolly by its stop (by input). */
function takeDolly(s: LabSim, g: Player, db: ReturnType<typeof yardWithDolly>['db']) {
    const t = db.translation();
    g.lookAt(t.x + 0.27, t.y + DOLLY.deckTop + 0.15, t.z);
    g.step({ grab: true });
    expect(s.physics.heldIdOf(0)).toBe(s.dolly.id);
}

describe('the log dolly (#52)', () => {
    it('one beaver loads a whole log onto it and pushes it 10 m, all by input: end against the stop, the other dragging', () => {
        // the log on the ground, its far (west) end at P, lying 25 degrees south of the run; the dolly
        // beside its near end, on the run (west along z = 8.3, between the sawmill and the log pile,
        // open yard for 12 m), stop to the east
        const s = new LabSim({ level: timberYardLevel });
        const P = { x: 3.22, z: 8.3 };
        const th = (-25 * Math.PI) / 180;
        const at = (r: number, a: number) => ({ x: P.x + r * Math.cos(a), z: P.z + r * Math.sin(a) });
        const y = yardSurfaceY(P.x, P.z);
        const lc = at(1.0, th);
        s.physics.place(s.log.id, pose(lc.x, y + LOG_RADIUS + 0.01, lc.z, quatFromYawPitchRoll(-th, 0, 0)));
        // (its stop's inner face 3 cm beyond the log's end: 2.03 m from P)
        s.physics.place(s.dolly.id, pose(P.x + 2.03 - 0.25, y + 0.005, P.z, quatFromYawPitchRoll(0, 0, 0)));
        s.fpActive = true;
        const B = at(2.8, th / 2);
        s.placePlayer(B.x, B.z, 0);
        const g = new Player(s);
        g.step({}, 90);
        const lb = s.physics.bodies.get(s.log.id)!.body;
        const db = s.physics.bodies.get(s.dolly.id)!.body;
        expect(lb.mass()).toBeGreaterThan(100);
        const v = { x: 0, y: 0, z: 0 };
        const end = () => {
            const t = lb.translation();
            quatRotate(lb.rotation(), 0.9, 0, 0, v);
            return { x: t.x + v.x, y: t.y + v.y, z: t.z + v.z };
        };
        // take its near end, lift it (the far end stays on the ground) and swing it round over the
        // cradle, lower it in, let go
        const e = end();
        g.lookAt(e.x, e.y, e.z);
        g.step({ grab: true });
        expect(s.physics.heldIdOf(0)).toBe(s.log.id);
        const H = y + 0.75;
        g.lookAt(e.x, H, e.z, 40);
        g.step({}, 20);
        let lifted = end().y - y - LOG_RADIUS;
        for (let k = 5; k >= 0; k--) {
            const q = at(1.9, (th * k) / 6);
            g.lookAt(q.x, H, q.z, 40);
            g.step({}, 20);
            lifted = Math.min(lifted, end().y - y - LOG_RADIUS);
            expect(s.physics.heldIdOf(0)).toBe(s.log.id);
        }
        const over = at(1.9, 0);
        g.lookAt(over.x, y + DOLLY.deckTop + LOG_RADIUS + 0.08, over.z, 40);
        g.step({}, 20);
        g.step({ action: ACTION_DROP });
        g.step({}, 90);
        expect(s.physics.heldIdOf(0)).toBe(-1);
        // in the cradle: its end centred between the chocks, on the deck, by the stop
        const inDolly = () => {
            const d = db.translation();
            const q = db.rotation();
            const p = end();
            quatRotate({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, p.x - d.x, p.y - d.y, p.z - d.z, v);
            return { ...v };
        };
        const c = inDolly();
        console.log(
            `dolly, loaded by input: the log's end lifted at least ${(lifted * 100).toFixed(0)} cm off the ground while swung; lies in the dolly at (${c.x.toFixed(2)}, ${c.y.toFixed(2)}, ${c.z.toFixed(2)}) (stop face x 0.25; on the deck y ${(DOLLY.deckTop + LOG_RADIUS).toFixed(2)}; chocks z ±0.27)`
        );
        // (on the deck: the log slopes down to its dragging end and rests on the deck's back edge,
        // so where this measures, 0.4 m nearer its end, it sits a few cm higher)
        expect(Math.abs(c.z)).toBeLessThan(0.05);
        expect(Math.abs(c.y - (DOLLY.deckTop + LOG_RADIUS))).toBeLessThan(0.08);
        expect(c.x + 0.1).toBeLessThan(0.26);
        expect(c.x + 0.1).toBeGreaterThan(0);
        // then round behind the dolly, take it by the stop, and push it west along the run
        expect(g.walkTo(db.translation().x + 1.4, P.z, 0.2)).toBe(true);
        g.lookAt(db.translation().x + 0.27, db.translation().y + DOLLY.deckTop + 0.15, db.translation().z);
        g.step({ grab: true });
        expect(s.physics.heldIdOf(0)).toBe(s.dolly.id);
        g.yaw = FACE_WEST;
        const l0 = { ...lb.translation() };
        let ticks = 0;
        let held = 0;
        let sum = 0;
        let peak = 0;
        let highest = 0;
        let fastest = 0;
        let offLine = 0;
        while (lb.translation().x > l0.x - 10 && ticks < 60 * 60) {
            // steering as a wheelbarrow is steered: walking on towards the log's middle, ahead
            const t = lb.translation();
            g.yaw = Math.atan2(-(t.x - s.player.x), -(t.z - s.player.z));
            g.step({ moveZ: 0.5 });
            ticks++;
            if (s.physics.heldIdOf(0) === s.dolly.id) {
                held++;
                const f = s.physics.rig(0)!.grabForce;
                sum += f;
                peak = Math.max(peak, f);
            }
            highest = Math.max(highest, db.translation().y - yardSurfaceY(db.translation().x, db.translation().z));
            fastest = Math.max(fastest, Math.hypot(lb.linvel().x, lb.linvel().z));
            offLine = Math.max(offLine, Math.abs(lb.translation().z - P.z));
        }
        const moved = l0.x - lb.translation().x;
        const c1 = inDolly();
        console.log(
            `dolly: the ${lb.mass().toFixed(0)} kg log pushed ${moved.toFixed(2)} m in ${(ticks / 60).toFixed(1)} s by one beaver; held ${held} of ${ticks} ticks; pull mean ${(sum / Math.max(1, held)).toFixed(0)} N, peak ${peak.toFixed(0)} N (cap ${GRAB.maxForce} N); the dolly at most ${(highest * 100).toFixed(1)} cm off the ground; the log's end still in it at (${c1.x.toFixed(2)}, ${c1.y.toFixed(2)}, ${c1.z.toFixed(2)}), its end face ${((0.25 - c1.x - 0.1) * 100).toFixed(0)} cm short of the stop; fastest ${fastest.toFixed(2)} m/s; at most ${offLine.toFixed(2)} m off the run`
        );
        expect(moved).toBeGreaterThanOrEqual(10);
        expect(held).toBe(ticks);
        expect(peak).toBeLessThanOrEqual(GRAB.maxForce + 1);
        // still in the cradle: between the chocks, on the deck, its end face (0.1 m on from where
        // this measures) no further back than the stop. The cradle's grip carries it (about 470 N
        // of friction against the dragging end's 390 N); the stop is there for when it slips
        expect(Math.abs(c1.z)).toBeLessThan(0.08);
        expect(Math.abs(c1.y - (DOLLY.deckTop + LOG_RADIUS))).toBeLessThan(0.08);
        expect(c1.x + 0.1).toBeLessThan(0.26);
        expect(c1.x + 0.1).toBeGreaterThan(-0.1);
        expect(highest).toBeLessThan(0.05);
    }, 120_000);

    it('a beaver standing on the towed log is left behind', () => {
        const { s, g, db, lb } = yardWithDolly(true, 2);
        // a second beaver stands on the log (over its dragging half, ahead)
        const t = lb.translation();
        s.placePlayer(t.x - 0.5, t.z, 0, 1);
        const rider = s.players[1];
        rider.y = t.y + LOG_RADIUS + 0.02;
        s.physics.placeCharacter(rider.x, rider.y, rider.z, 1);
        g.step({}, 10);
        const r0 = { x: rider.x, y: rider.y, z: rider.z };
        expect(r0.y).toBeGreaterThan(yardSurfaceY(r0.x, r0.z) + 0.3);
        takeDolly(s, g, db);
        const l0 = { ...lb.translation() };
        let highest = 0;
        for (let k = 0; k < 60 * 6; k++) {
            g.step({ moveZ: 0.5 });
            highest = Math.max(highest, rider.y - r0.y);
        }
        const logMoved = Math.hypot(lb.translation().x - l0.x, lb.translation().z - l0.z);
        const riderMoved = Math.hypot(rider.x - r0.x, rider.z - r0.z);
        console.log(
            `dolly with a rider: the log towed ${logMoved.toFixed(2)} m; the beaver on it moved ${riderMoved.toFixed(2)} m, rose at most ${(highest * 100).toFixed(1)} cm`
        );
        expect(logMoved).toBeGreaterThan(2);
        expect(riderMoved).toBeLessThan(0.5 * logMoved);
        expect(highest).toBeLessThan(0.2);
    }, 120_000);

    it('a towing grip pulls along the ground only, with at most 650 N: past that it lets go', () => {
        // empty, looking up as if to lift: it stays on the ground
        {
            const { s, g, db } = yardWithDolly(false);
            const y0 = db.translation().y;
            takeDolly(s, g, db);
            g.pitch = 0.6;
            let highest = 0;
            for (let k = 0; k < 120; k++) {
                g.step();
                highest = Math.max(highest, db.translation().y - y0);
            }
            console.log(`dolly, looked up at: rose ${(highest * 100).toFixed(2)} cm`);
            expect(s.physics.heldIdOf(0)).toBe(s.dolly.id);
            expect(highest).toBeLessThan(0.01);
        }
        // loaded with a log staked down (a snag): pushing on, the pull stops at the cap and nothing
        // moves (no shoving through); stepping aside (the chocks hold the dolly to the log), more
        // than 650 N would be needed, and the grip lets go
        const { s, g, db, lb } = yardWithDolly(true);
        lb.setBodyType(2 /* fixed */, true);
        const d0 = { ...db.translation() };
        takeDolly(s, g, db);
        let peak = 0;
        for (let k = 0; k < 180; k++) {
            g.step({ moveZ: 0.5 });
            peak = Math.max(peak, s.physics.rig(0)!.grabForce);
        }
        const pushed = Math.hypot(db.translation().x - d0.x, db.translation().z - d0.z);
        expect(s.physics.heldIdOf(0)).toBe(s.dolly.id);
        let ticks = 0;
        while (s.physics.heldIdOf(0) === s.dolly.id && ticks < 60 * 5) {
            g.step({ moveX: 1 });
            peak = Math.max(peak, s.physics.rig(0)!.grabForce);
            ticks++;
        }
        const moved = Math.hypot(db.translation().x - d0.x, db.translation().z - d0.z);
        console.log(
            `dolly against a staked log: pushing 3 s, it moved ${(pushed * 100).toFixed(1)} cm; stepping aside, the grip let go after ${(ticks / 60).toFixed(2)} s; the pull peaked at ${peak.toFixed(1)} N (cap ${GRAB.maxForce} N); the dolly moved ${(moved * 100).toFixed(1)} cm in all`
        );
        expect(pushed).toBeLessThan(0.03);
        expect(s.physics.heldIdOf(0)).toBe(-1);
        expect(peak).toBeGreaterThan(GRAB.maxForce - 1);
        expect(peak).toBeLessThanOrEqual(GRAB.maxForce + 1);
        expect(moved).toBeLessThan(0.1);
    }, 120_000);

    it('with the winch: hauled on the dolly, a log drags with about half the rope’s tension', () => {
        const drum = { x: YARD_WINCH.x, y: YARD_WINCH.y + WINCH.drumHeight, z: YARD_WINCH.z };
        const haul = (onDolly: boolean) => {
            const s = new LabSim({ level: timberYardLevel });
            const lb = s.physics.bodies.get(s.log.id)!.body;
            const db = s.physics.bodies.get(s.dolly.id)!.body;
            // the log on the rope's line, its near (west) end 6 m from the drum; on the dolly, that
            // end in the cradle against the stop ahead of it (towards the drum: the rope pulls the
            // log, and the log pushes the dolly along by its stop), the far end dragging
            const lx = drum.x + 7;
            const y = yardSurfaceY(lx, drum.z);
            if (onDolly) {
                const dx = lx - 1.0 - 0.01 + 0.25;
                s.physics.place(s.dolly.id, pose(dx, y + 0.005, drum.z, quatFromYawPitchRoll(Math.PI, 0, 0)));
                s.physics.place(
                    s.log.id,
                    pose(lx, y + DOLLY.deckTop + LOG_RADIUS + 0.02, drum.z, quatFromYawPitchRoll(0, 0, 0))
                );
            } else s.physics.place(s.log.id, pose(lx, y + LOG_RADIUS + 0.02, drum.z, quatFromYawPitchRoll(0, 0, 0)));
            s.fpActive = true;
            s.placePlayer(drum.x, drum.z + 1.1, 0);
            const g = new Player(s);
            g.step({}, 120);
            // take the hook, hook the log's near end, crank (by input)
            g.lookAt(drum.x, drum.y, drum.z);
            g.step({ grab: true });
            // (from the north side, on the log's top just behind the stop: the hook goes into the log)
            const end = () => ({ x: lb.translation().x - 0.7, y: lb.translation().y, z: lb.translation().z });
            expect(g.walkTo(end().x, end().z + 1.0, 0.25)).toBe(true);
            g.lookAt(end().x, end().y + 0.1, end().z);
            g.step({ grab: true });
            expect(s.winch!.hooked).toBe(s.log.id);
            expect(g.walkTo(drum.x, drum.z + 1.1, 0.25)).toBe(true);
            g.lookAt(drum.x, drum.y, drum.z);
            g.step({ grab: true });
            expect(s.winch!.cranking).toBe(0);
            // 16 s of winding (4 m at the crank's pace); the tension measured over the last 12 s
            const x0 = lb.translation().x;
            const d0 = db.translation().x;
            let sum = 0;
            let n = 0;
            let peak = 0;
            for (let k = 0; k < 60 * 16; k++) {
                g.step();
                if (k >= 60 * 4) {
                    sum += s.winch!.tension;
                    n++;
                    peak = Math.max(peak, s.winch!.tension);
                }
            }
            return {
                mean: sum / n,
                peak,
                moved: x0 - lb.translation().x,
                dollyMoved: d0 - db.translation().x,
                lead: lb.translation().x - db.translation().x
            };
        };
        const bare = haul(false);
        const dolly = haul(true);
        console.log(
            `winch drag: the log alone, tension mean ${bare.mean.toFixed(0)} N (peak ${bare.peak.toFixed(0)} N), hauled ${bare.moved.toFixed(2)} m; on the dolly, mean ${dolly.mean.toFixed(0)} N (peak ${dolly.peak.toFixed(0)} N), hauled ${dolly.moved.toFixed(2)} m, the dolly with it ${dolly.dollyMoved.toFixed(2)} m (the log's middle ${dolly.lead.toFixed(2)} m behind its own); ${((1 - dolly.mean / bare.mean) * 100).toFixed(0)}% less`
        );
        expect(bare.moved).toBeGreaterThan(3);
        expect(dolly.moved).toBeGreaterThan(3);
        // the dolly came along under the log
        expect(Math.abs(dolly.dollyMoved - dolly.moved)).toBeLessThan(0.3);
        expect(dolly.mean).toBeLessThan(0.75 * bare.mean);
    }, 120_000);
});
