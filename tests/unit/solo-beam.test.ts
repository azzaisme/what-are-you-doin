/**
 * Epic 5's solo rule (#52): no puzzle may need exactly two people. A lost stringer is replaced by
 * one beaver alone, by input: the sawmill set to beams at its lever, a whole log (which no beaver
 * can lift alone) loaded onto the log dolly and pushed into the sawmill's guide, the sawn 3.2 m
 * beam shouldered off the rack and seated across the creek beside the other stringer.
 *
 * Setup (placed, not played): the log lies on the ground east of the mill with the dolly beside
 * its end, the yard's beam-0 is already across the creek, and beam-1 is gone (lost). From there
 * on everything is player commands.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { DOLLY } from '../../src/assets/dolly.ts';
import { BEAM_HALF, LOG_RADIUS } from '../../src/assets/props.ts';
import { SAWMILL, sawmillToWorld } from '../../src/levels/forestry.ts';
import {
    BRIDGE,
    BRIDGE_X,
    YARD_FORESTRY,
    YARD_Y,
    timberYardLevel,
    yardSurfaceY
} from '../../src/levels/timber-yard.ts';
import { ACTION_DROP } from '../../src/sim/commands.ts';
import { LabSim } from '../../src/sim/lab-sim.ts';
import { GRAB } from '../../src/sim/physics/grab.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { SAW } from '../../src/sim/sawmill.ts';
import { pose, quatFromYawPitchRoll, quatMul, quatRotate } from '../../src/voxels/math.ts';

import { Player } from './play.ts';

beforeAll(() => initPhysics());

const SPOT = YARD_FORESTRY.sawmill!;
const G = SAWMILL.guide;
const GUIDE = sawmillToWorld(SPOT, (G.x0 + G.x1) / 2, 0, 0);
/** Facing west (-x). */
const FACE_WEST = Math.PI / 2;

describe('one beaver replaces a lost stringer (#52)', () => {
    it('sets the saw to beams, dollies a whole log into the guide, and seats the sawn beam on the bridge, all by input', () => {
        // (the hazards off, as in the sawmill's gate: a bridge laid across brings the flood, which
        // this test is not about)
        const s = new LabSim({ level: timberYardLevel, hazards: false });
        s.fpActive = true;
        const beam0 = s.entities.find((e) => e.name === 'beam-0')!;
        const beam1 = s.entities.find((e) => e.name === 'beam-1')!;
        // beam-0 already across the creek (west stringer); beam-1 lost
        // (its long axis, local x, turned to run across the creek along z; laid flat, as the bridge
        // tests lay their beams)
        const flatAlongZ = quatMul(quatFromYawPitchRoll(Math.PI / 2, 0, 0), quatFromYawPitchRoll(0, Math.PI / 2, 0));
        // (the far seat stands 10 cm higher than the near one: set it down a little above both and
        // let it settle onto them)
        s.physics.place(beam0.id, pose(BRIDGE_X - 0.12, YARD_Y + 0.24, BRIDGE.zc, flatAlongZ));
        s.physics.setEnabled(beam1.id, false);
        beam1.visible = false;
        // the log on the ground at the guide's mouth: its far end at P, just inside the rails, on the
        // guide's line, the log lying 20 degrees south of it (clear of the south rail's end); the
        // dolly on the line beside its near end, stop to the east (west of the low mound east of
        // the mill: loading wants level ground)
        const P = { x: 7.17, z: GUIDE.z };
        const th = (-20 * Math.PI) / 180;
        const at = (r: number, a: number) => ({ x: P.x + r * Math.cos(a), z: P.z + r * Math.sin(a) });
        const y = yardSurfaceY(P.x, P.z);
        const lc = at(1.0, th);
        s.physics.place(s.log.id, pose(lc.x, y + LOG_RADIUS + 0.01, lc.z, quatFromYawPitchRoll(-th, 0, 0)));
        s.physics.place(s.dolly.id, pose(P.x + 2.03 - 0.25, y + 0.005, P.z, quatFromYawPitchRoll(0, 0, 0)));
        const g = new Player(s);
        const lb = s.physics.bodies.get(s.log.id)!.body;
        const db = s.physics.bodies.get(s.dolly.id)!.body;
        const v = { x: 0, y: 0, z: 0 };
        const end = () => {
            const t = lb.translation();
            quatRotate(lb.rotation(), 0.9, 0, 0, v);
            return { x: t.x + v.x, y: t.y + v.y, z: t.z + v.z };
        };

        // ---- the saw's lever: beams
        const lever = sawmillToWorld(SPOT, SAWMILL.lever.x, SAWMILL.lever.y, SAWMILL.lever.z);
        s.placePlayer(lever.x + 0.4, lever.z - 0.9, 0);
        g.step({}, 60);
        g.lookAt(lever.x, lever.y, lever.z);
        g.step({ grab: true });
        g.step({}, 10);
        expect(s.sawmill!.mode).toBe('beam');

        // ---- to the log, round it to the south (clear of it and the dolly), to outside the circle
        // its end swings on
        const B = at(2.8, th / 2);
        expect(g.walkTo(B.x + 0.7, 7.9, 0.3)).toBe(true);
        expect(g.walkTo(B.x, B.z, 0.05)).toBe(true);
        g.step({}, 30);
        // take its near end, lift it, swing it round over the cradle, lower it in, let go
        const e = end();
        g.lookAt(e.x, e.y, e.z);
        g.step({ grab: true });
        expect(s.physics.heldIdOf(0)).toBe(s.log.id);
        const H = y + 0.75;
        g.lookAt(e.x, H, e.z, 40);
        g.step({}, 20);
        for (let k = 5; k >= 0; k--) {
            const q = at(1.9, (th * k) / 6);
            g.lookAt(q.x, H, q.z, 40);
            g.step({}, 20);
            expect(s.physics.heldIdOf(0)).toBe(s.log.id);
        }
        const over = at(1.9, 0);
        g.lookAt(over.x, y + DOLLY.deckTop + LOG_RADIUS + 0.08, over.z, 40);
        g.step({}, 20);
        g.step({ action: ACTION_DROP });
        g.step({}, 90);
        expect(s.physics.heldIdOf(0)).toBe(-1);

        // ---- behind the dolly, push it west into the guide (steering for the guide's line)
        expect(g.walkTo(db.translation().x + 1.4, P.z, 0.2)).toBe(true);
        g.lookAt(db.translation().x + 0.27, db.translation().y + DOLLY.deckTop + 0.15, db.translation().z);
        g.step({ grab: true });
        expect(s.physics.heldIdOf(0)).toBe(s.dolly.id);
        let ticks = 0;
        let peak = 0;
        while (lb.translation().x > GUIDE.x + 0.1 && ticks < 60 * 30) {
            // steering for a point well down the guide's line (its rails take the log's far end in)
            const aim = { x: GUIDE.x - 3, z: GUIDE.z };
            g.yaw = Math.atan2(-(aim.x - s.player.x), -(aim.z - s.player.z));
            g.step({ moveZ: 0.4 });
            ticks++;
            peak = Math.max(peak, s.physics.rig(0)!.grabForce);
            expect(s.physics.heldIdOf(0)).toBe(s.dolly.id);
        }
        // let go, step back out of the way
        g.step({ action: ACTION_DROP });
        g.yaw = FACE_WEST;
        g.step({ moveZ: -1 }, 40);
        const lt = lb.translation();
        console.log(
            `solo: the log pushed into the guide in ${(ticks / 60).toFixed(1)} s (pull peak ${peak.toFixed(0)} N, cap ${GRAB.maxForce} N); its middle at x ${lt.x.toFixed(2)} z ${lt.z.toFixed(2)} (guide's middle ${GUIDE.x.toFixed(2)}, ${GUIDE.z.toFixed(2)})`
        );
        // in the guide: between its rails, its middle by the guide's
        expect(Math.abs(lt.z - GUIDE.z)).toBeLessThan(G.halfZ - LOG_RADIUS);
        expect(Math.abs(lt.x - GUIDE.x)).toBeLessThan(SAWMILL.guideSlack);
        // ---- the saw takes it, and a beam comes out on the rack
        for (let k = 0; k < 240 && s.sawmill!.phase === 'ready'; k++) g.step();
        expect(s.sawmill!.stats.takenIds).toEqual([s.log.id]);
        for (let k = 0; k < SAW.cutTicks + 60; k++) g.step();
        const sawn = s.entities.filter((e) => e.name.startsWith('beam-') && e.visible && e.id >= 396);
        expect(sawn.length).toBe(1);
        const beam = sawn[0];
        const b = { ...beam.pose.p };
        console.log(`solo: a beam on the rack at ${b.x.toFixed(2)}, ${b.z.toFixed(2)}`);

        // ---- shoulder it by its west end (the east end is by the blade), turn to the creek: it
        // points out ahead; walk it to the bridge's line, out to the bank's edge, lower it across
        const turn = (yaw: number, ticks = 60) => {
            const y0 = g.yaw;
            let d = yaw - y0;
            d = Math.atan2(Math.sin(d), Math.cos(d));
            for (let i = 1; i <= ticks; i++) {
                g.yaw = y0 + (d * i) / ticks;
                g.step();
            }
        };
        const tilt = (pitch: number, ticks = 40) => {
            const p0 = g.pitch;
            for (let i = 1; i <= ticks; i++) {
                g.pitch = p0 + ((pitch - p0) * i) / ticks;
                g.step();
            }
        };
        expect(g.walkTo(b.x - 2.4, b.z - 1.0, 0.2)).toBe(true);
        expect(g.walkTo(b.x - 2.4, b.z, 0.1)).toBe(true);
        turn(-Math.PI / 2); // facing +x, at the beam's west end
        g.lookAt(b.x - BEAM_HALF.x + 0.15, b.y, b.z);
        g.step({ grab: true });
        expect(s.physics.heldIdOf(0)).toBe(beam.id);
        tilt(-0.25);
        g.step({}, 30);
        turn(0, 120); // facing south: the beam swings round and points out ahead
        const x = BRIDGE_X + 0.12;
        const bx = () => beam.pose.p.x;
        // carried in a little east of its line, clear of beam-0's end, then stepped across onto it
        const xIn = x + 0.15;
        for (let k = 0; k < 900 && Math.abs(bx() - xIn) > 0.04; k++) g.step({ moveX: bx() > xIn ? -0.3 : 0.3 });
        // out onto the near abutment (it reaches 0.86 m past the bank's edge, to the seat's face)
        // until the beam's middle is past the gap's by as much as lowering it will draw it back in
        const STAND = BRIDGE.nearFace + 0.35;
        const LEAD = -0.4;
        const bz = () => beam.pose.p.z;
        for (let k = 0; k < 1500 && bz() > BRIDGE.zc + LEAD && s.player.z > STAND; k++)
            g.step({
                moveZ: bz() > BRIDGE.zc + 0.5 ? 0.5 : 0.2,
                moveX: Math.max(-0.2, Math.min(0.2, (xIn - bx()) * 2))
            });
        g.step({}, 30);
        for (let k = 0; k < 60 && Math.abs(bx() - x) > 0.03; k++)
            g.step({ moveX: Math.max(-0.2, Math.min(0.2, (x - bx()) * 2)) });
        // square it up (it turns with you): its two ends on its line, not skewed towards beam-0
        const skew = () => {
            quatRotate(beam.pose.q, BEAM_HALF.x, 0, 0, v);
            // (+x end minus the -x end, per metre of z between them)
            return v.z !== 0 ? v.x / v.z : 0;
        };
        for (let k = 0; k < 60 && Math.abs(skew()) > 0.01; k++) {
            g.yaw -= 0.05 * skew();
            g.step({ moveX: Math.max(-0.1, Math.min(0.1, (x - bx()) * 2)) }, 3);
        }
        // lower it (looking down) until it is just over the seats, keeping it on its line
        for (let k = 0; k < 60 && beam.pose.p.y > YARD_Y + 0.12 + 0.04 && g.pitch > -1.5; k++) {
            g.pitch -= 0.03;
            // (looking down draws it in: step after it, as far as the bank's edge)
            const fwd = s.player.z > STAND ? Math.max(0, Math.min(0.3, (bz() - BRIDGE.zc) * 2)) : 0;
            g.yaw -= 0.05 * skew();
            g.step({ moveZ: fwd, moveX: Math.max(-0.1, Math.min(0.1, (x - bx()) * 2)) }, 5);
        }
        g.step({}, 30);
        g.step({ grab: true });
        g.step({}, 10);
        expect(s.physics.heldIdOf(0)).toBe(-1);
        // and back off the abutment (it was standing where the beam's end comes down)
        g.pitch = 0;
        g.step({ moveZ: -0.6 }, 60);
        g.step({}, 120);
        const laid = beam.pose.p;
        // its two ends (local x, ±BEAM_HALF.x), and how far each bears past its seat's face
        const endOf = (sx: number) => {
            quatRotate(beam.pose.q, sx * BEAM_HALF.x, 0, 0, v);
            return { x: laid.x + v.x, y: laid.y + v.y, z: laid.z + v.z };
        };
        const [e1, e2] = [endOf(1), endOf(-1)];
        const [near, far] = e1.z > e2.z ? [e1, e2] : [e2, e1];
        const nearBearing = near.z - BRIDGE.nearFace;
        const farBearing = BRIDGE.farFace - far.z;
        const dy = Math.abs(near.y - far.y);
        // beam-0's own ends, for comparison (the two seats need not stand at one height)
        const end0 = (sx: number) => {
            quatRotate(beam0.pose.q, sx * BEAM_HALF.x, 0, 0, v);
            return beam0.pose.p.y + v.y;
        };
        const dy0 = Math.abs(end0(1) - end0(-1));
        // the seats' tops, under the sawn beam's line
        const seatNear = s.physics.groundY(x, BRIDGE.nearFace + 0.2) ?? NaN;
        const seatFar = s.physics.groundY(x, BRIDGE.farFace - 0.2) ?? NaN;
        // a beam lying on both seats: its middle over their mean height (plus its half thickness),
        // its ends as far apart in height as the seats' tops
        const restY = (seatNear + seatFar) / 2 + BEAM_HALF.z;
        const restDy = Math.abs(seatFar - seatNear);
        const b0 = beam0.pose.p;
        console.log(
            'trace ends near',
            near.x.toFixed(2),
            near.y.toFixed(3),
            near.z.toFixed(2),
            'ground',
            s.physics.groundY(near.x, near.z)?.toFixed(3),
            '| far',
            far.x.toFixed(2),
            far.y.toFixed(3),
            far.z.toFixed(2),
            'ground',
            s.physics.groundY(far.x, far.z)?.toFixed(3),
            '| player',
            s.player.x.toFixed(2),
            s.player.y.toFixed(2),
            s.player.z.toFixed(2),
            'held',
            s.physics.heldIdOf(0)
        );
        console.log(
            `solo: the sawn beam seated at x ${laid.x.toFixed(2)} (its line ${x.toFixed(2)}), z ${laid.z.toFixed(2)} (the gap's middle ${BRIDGE.zc.toFixed(2)}), y ${laid.y.toFixed(3)} (resting on both seats: ${restY.toFixed(3)}); ends at x ${near.x.toFixed(2)} and ${far.x.toFixed(2)}; bearing ${nearBearing.toFixed(2)} m on the near seat, ${farBearing.toFixed(2)} m on the far; ends ${(dy * 100).toFixed(1)} cm apart in height (beam-0's ${(dy0 * 100).toFixed(1)} cm, the seats' ${(restDy * 100).toFixed(1)} cm); beam-0 at x ${b0.x.toFixed(2)} y ${b0.y.toFixed(3)} z ${b0.z.toFixed(2)}; falls ${s.progress.falls}`
        );
        // beam-0 is across, on its seats
        expect(Math.abs(b0.z - BRIDGE.zc)).toBeLessThan(0.1);
        expect(Math.abs(b0.y - restY)).toBeLessThan(0.03);
        expect(Math.abs(dy0 - restDy)).toBeLessThan(0.03);
        // the sawn beam across beside it: on its line, both ends bearing well onto their seats, lying
        // on them (not on its end, not on beam-0)
        expect(Math.abs(laid.x - x)).toBeLessThan(0.08);
        expect(Math.abs(near.x - x)).toBeLessThan(0.08);
        expect(Math.abs(far.x - x)).toBeLessThan(0.08);
        expect(laid.x - b0.x).toBeGreaterThan(0.2);
        expect(nearBearing).toBeGreaterThan(0.2);
        expect(farBearing).toBeGreaterThan(0.2);
        expect(Math.abs(laid.y - restY)).toBeLessThan(0.03);
        expect(Math.abs(dy - restDy)).toBeLessThan(0.03);
        expect(s.progress.falls).toBe(0);
    }, 240_000);
});
