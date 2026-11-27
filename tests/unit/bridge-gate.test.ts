/**
 * Epic 5's gate (#53), offline: a properly built bridge holds a loaded ute, an underbuilt one fails
 * every time, over two layouts. The ute is boarded and driven by input; what is placed by setup
 * (the bridge, the ute on the bank, the load in its bed) is said where it is.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';

import { PLANK_HALF } from '../../src/assets/props.ts';
import { BRIDGE, BRIDGE_X, YARD_Y, timberYardLevel } from '../../src/levels/timber-yard.ts';
import { neutralCommand } from '../../src/sim/commands.ts';
import type { PlayerCommand } from '../../src/sim/commands.ts';
import { BREAK } from '../../src/sim/joints/breaking.ts';
import { EYE_HEIGHT, LabSim } from '../../src/sim/lab-sim.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { pose, quatFromYawPitchRoll, quatRotate } from '../../src/voxels/math.ts';

import { FLAT_ALONG_Z, LINES, hammerAt, yardBridge } from './bridge-helpers.ts';

beforeAll(() => initPhysics());

/**
 * The ute's run-up to the bridge (m from the bank's edge). Loaded, it needs the speed: the
 * underbuilt bridge's beams tip on the bank's lip and lift their back ends 22 cm off the bank, and
 * from 3.2 m back a loaded ute meets that step at 1.0 m/s and cannot climb it (empty, at 1.15 m/s,
 * it does).
 */
const RUN_UP = 6;

const yawOf = (q: { x: number; y: number; z: number; w: number }) =>
    Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));

/**
 * Setup: the ute on the yard bank RUN_UP from the bridge, facing it; with `load`, a log's worth of
 * timber in its bed (the two halves of a bucked log, 1 m each, side by side along the bed).
 * Returns the load's ids and mass.
 */
function uteOnBank(s: LabSim, load: boolean): { ids: number[]; mass: number } {
    const v = s.vehicle!;
    const q = quatFromYawPitchRoll(Math.PI, 0, 0);
    s.physics.place(v.id, pose(BRIDGE_X, YARD_Y + 0.25, BRIDGE.nearEdge + RUN_UP, q));
    for (let k = 0; k < 60; k++) s.step(neutralCommand(s.tick + 1));
    const ids: number[] = [];
    let mass = 0;
    if (load) {
        const u = s.ute.pose;
        const local = { x: 0, y: 0, z: 0 };
        for (const [n, x] of [
            [0, -0.3],
            [1, 0.3]
        ]) {
            const e = s.forestry.ents.short[n];
            // (a bucked log's half: its body waits out of the world until a log is bucked)
            s.physics.setEnabled(e.id, true);
            quatRotate(u.q, x, 1.2, -1.0, local);
            // its long axis (local x) along the bed (the ute's z)
            const along = quatFromYawPitchRoll(yawOf(u.q) + Math.PI / 2, 0, 0);
            s.physics.place(e.id, pose(u.p.x + local.x, u.p.y + local.y, u.p.z + local.z, along));
            ids.push(e.id);
        }
        for (let k = 0; k < 60; k++) s.step(neutralCommand(s.tick + 1));
        // (its mass, once the world has stepped with it in)
        for (const id of ids) mass += s.physics.bodies.get(id)!.body.mass();
    }
    return { ids, mass };
}

/**
 * By input: a beaver walks up to the ute's driver's door (placed 2.2 m off it: setup), looks at
 * it, grabs to get in, and drives it over the bridge at `throttle`, steering for the bridge's
 * centre line, until it is 2.5 m past the far bank (or 20 s). `every` runs each driven tick.
 */
function boardAndDrive(s: LabSim, throttle: number, every: (k: number) => void = () => undefined) {
    let yaw = 0;
    let pitch = 0;
    const step = (c: Partial<PlayerCommand> = {}, k = 1) => {
        for (let i = 0; i < k; i++) s.step({ ...neutralCommand(s.tick + 1, yaw, pitch), ...c });
    };
    s.fpActive = true;
    const u = s.ute.pose;
    const uy = yawOf(u.q);
    // the driver's door: the ute's right (local -x)
    const sideX = -Math.cos(uy);
    const sideZ = Math.sin(uy);
    s.placePlayer(u.p.x + sideX * 2.2, u.p.z + sideZ * 2.2, 0);
    step({}, 20);
    yaw = Math.atan2(sideX, sideZ);
    pitch = -Math.atan2(s.player.y + EYE_HEIGHT - (u.p.y + 0.6), 2.2 - 0.8);
    step({}, 5);
    step({ grab: true });
    expect(s.driver).toBe(0);
    step({}, 10);
    const target = BRIDGE.farEdge - 2.5;
    let k = 0;
    for (; k < 60 * 20 && s.ute.pose.p.z > target; k++) {
        let dy = yawOf(s.ute.pose.q) - Math.PI;
        dy -= Math.round(dy / (2 * Math.PI)) * 2 * Math.PI;
        const steer = Math.max(-1, Math.min(1, 4 * (BRIDGE_X - s.ute.pose.p.x) + 3 * dy));
        yaw = Math.PI;
        pitch = 0;
        step({ moveZ: throttle, moveX: steer });
        every(k);
    }
    return { reached: s.ute.pose.p.z <= target, seconds: k / 60 };
}

const strained = (s: LabSim, max: Map<number, number>) => {
    for (const [id, st] of s.joints.health.states) max.set(id, Math.max(max.get(id) ?? 0, st.util));
};

describe('the gate: a properly built bridge holds a loaded ute (#53)', () => {
    it('the yard bridge (two beams, both ends seated and nailed): a log’s worth in the bed, boarded and driven over by input', () => {
        const { s, beams } = yardBridge([1, -1], 2);
        const load = uteOnBank(s, true);
        expect(load.mass).toBeGreaterThan(100);
        const max = new Map<number, number>();
        const e0 = s.events.length;
        const r = boardAndDrive(s, 0.35, () => strained(s, max));
        const peak = Math.max(...max.values());
        // the load came across with it, still in the bed
        const inBed = load.ids.filter((id) => {
            const p = s.physics.bodies.get(id)!.body.translation();
            const u = s.ute.pose.p;
            return Math.hypot(p.x - u.x, p.z - u.z) < 1.6 && p.y > u.y + 0.7;
        }).length;
        console.log(
            `loaded ute (${(s.vehicle!.pb.body.mass() + load.mass).toFixed(0)} kg: ${load.mass.toFixed(0)} kg in the bed) over the proper yard bridge: ${r.reached ? 'across' : 'not across'} in ${r.seconds.toFixed(1)} s; peak utilization ${peak.toFixed(2)} (creak at ${BREAK.creak}); joints ${s.joints.graph.size}/4; ${inBed}/2 halves still in the bed`
        );
        expect(r.reached).toBe(true);
        expect(inBed).toBe(2);
        expect(s.joints.graph.size).toBe(4);
        expect(peak).toBeLessThan(BREAK.creak);
        expect(s.events.slice(e0).filter((e) => e.kind === 'creak' || e.kind === 'break')).toEqual([]);
        for (const b of beams) expect(Math.abs(b.pose.p.z - BRIDGE.zc)).toBeLessThan(0.1);
        expect(s.physics.stats.linClamps + s.physics.stats.angClamps).toBe(0);
    }, 120_000);
});

/** The yard's own beams out of the world: they lie across the ute's run-up. */
function clearBeams(s: LabSim): void {
    for (const name of ['beam-0', 'beam-1']) {
        const e = s.entities.find((x) => x.name === name)!;
        s.physics.setEnabled(e.id, false);
        e.visible = false;
    }
}

/**
 * The second layout: planks, too short (2.4 m) to cross the 2.6 m gap alone, on a stone pier in the
 * middle of the creek (placed: a 0.6 m wide block, its top 5 cm above the near seat). Per wheel
 * line, two planks butted on the pier, each seated on the pier and on a bank, nailed twice at each.
 * Without the pier, the same planks, nailed twice at their banks: two cantilevers with a gap.
 */
function pierBridge(withPier: boolean): { s: LabSim; planks: LabSim['entities'] } {
    const s = new LabSim({ level: timberYardLevel });
    clearBeams(s);
    const nearTop = s.physics.groundY(BRIDGE_X, BRIDGE.nearFace + 0.3) ?? YARD_Y + 0.1;
    const pierTop = nearTop + 0.05;
    if (withPier)
        s.physics.addStatic(
            RAPIER.ColliderDesc.cuboid(1.1, 1.0, 0.3).setTranslation(BRIDGE_X, pierTop - 1.0, BRIDGE.zc)
        );
    const planks = ['plank', 'extra-plank-0', 'extra-plank-1', 'extra-plank-2'].map((n) =>
        s.entities.find((e) => e.name === n)!
    );
    // per line: the near plank from the pier's middle out over the near bank, the far one over the far bank
    planks.forEach((p, k) => {
        const line = LINES[k >> 1];
        const near = k % 2 === 0;
        const z = BRIDGE.zc + (near ? 1 : -1) * PLANK_HALF.x;
        s.physics.place(p.id, pose(line, pierTop + 0.25, z, FLAT_ALONG_Z));
    });
    // (without the pier, propped while they are nailed, as a builder would hold them, then let go)
    const props = withPier
        ? []
        : planks.map((p, k) =>
              s.physics.addStatic(
                  RAPIER.ColliderDesc.cuboid(0.15, 0.5, 0.15).setTranslation(
                      LINES[k >> 1],
                      pierTop - 0.5,
                      BRIDGE.zc + (k % 2 === 0 ? 0.5 : -0.5)
                  )
              )
          );
    for (let k = 0; k < 90; k++) s.step(neutralCommand(s.tick + 1));
    planks.forEach((p, k) => {
        const line = LINES[k >> 1];
        const near = k % 2 === 0;
        // where it bears on its bank: in from its bank end, the first place its underside (local +z:
        // FLAT_ALONG_Z turns it downwards) touches the ground
        // (FLAT_ALONG_Z turns its local +x to world -z: the near plank's bank end is at local -x)
        const dir = near ? 1 : -1;
        const v = { x: 0, y: 0, z: 0 };
        let bank = NaN;
        for (let d = 0.05; d < 1.2 && Number.isNaN(bank); d += 0.05) {
            quatRotate(p.pose.q, -dir * (PLANK_HALF.x - d), 0, PLANK_HALF.z, v);
            const at = { x: p.pose.p.x + v.x, y: p.pose.p.y + v.y, z: p.pose.p.z + v.z };
            if (Math.abs((s.physics.groundY(at.x, at.z, at.y + 0.2) ?? -9) - at.y) < 0.03) bank = at.z;
        }
        expect(Number.isNaN(bank)).toBe(false);
        const zs = withPier ? [bank, BRIDGE.zc + (near ? 0.15 : -0.15)] : [bank];
        for (const z of zs)
            for (const dz of [-0.04, 0.04]) {
                hammerAt(s.joints, { x: line, y: p.pose.p.y + 0.1, z: z + dz }, s.tick);
            }
    });
    for (const c of props) s.physics.world.removeCollider(c, true);
    return { s, planks };
}

describe('the gate, a second layout: short timber on a pier (#53)', () => {
    it('planks butted on a stone pier in mid-creek carry the loaded ute; without the pier, the same planks fail under it', () => {
        const run = (withPier: boolean) => {
            const { s, planks } = pierBridge(withPier);
            const joints = s.joints.graph.size;
            const nails = [...s.joints.graph.connections()].reduce((n, c) => n + c.nails.length, 0);
            uteOnBank(s, true);
            const e0 = s.events.length;
            const max = new Map<number, number>();
            const r = boardAndDrive(s, 0.4, () => strained(s, max));
            const evs = s.events.slice(e0).filter((e) => e.kind === 'creak' || e.kind === 'break');
            return {
                joints,
                nails,
                left: s.joints.graph.size,
                reached: r.reached,
                peak: Math.max(0, ...max.values()),
                kinds: evs.map((e) => e.kind),
                ticks: evs.map((e) => e.tick),
                uteY: s.ute.pose.p.y,
                planksY: planks.map((p) => +p.pose.p.y.toFixed(2)),
                clamps: s.physics.stats.linClamps + s.physics.stats.angClamps
            };
        };
        const pier = run(true);
        const none = run(false);
        for (const [name, r] of [
            ['on the pier', pier],
            ['without it', none]
        ] as const)
            console.log(
                `planks ${name}: ${r.joints} joints, ${r.nails} nails (${r.left} joints left), ute ${r.reached ? 'across' : `not across (y ${r.uteY.toFixed(2)})`}; peak ${r.peak.toFixed(2)}; ${r.kinds.map((k, i) => `${k}@${r.ticks[i]}`).join(' ') || 'no creak'}; planks at y ${r.planksY.join(' ')}`
            );
        // on the pier: across, no creak, nothing broken (each plank anchored to its bank and to the
        // pier: 8 joints, two nails each)
        expect(pier.joints).toBe(8);
        expect(pier.nails).toBe(16);
        expect(pier.reached).toBe(true);
        expect(pier.kinds).toEqual([]);
        expect(pier.left).toBe(8);
        expect(pier.clamps).toBe(0);
        // without: the same planks anchored to their banks only (a nail may glance off the lip's
        // edge), propped while nailed; under the ute they give way, after a creak, and it does not
        // get across
        expect(none.joints).toBe(4);
        expect(none.nails).toBeGreaterThanOrEqual(6);
        expect(none.reached).toBe(false);
        expect(none.kinds[0]).toBe('creak');
        expect(none.kinds).toContain('break');
        expect(none.clamps).toBe(0);
    }, 300_000);
});
