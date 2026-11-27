/**
 * Epic 5's gate (#53), offline: a properly built bridge holds a loaded ute, an underbuilt one fails
 * every time, over two layouts. The ute is boarded and driven by input; what is placed by setup
 * (the bridge, the ute on the bank, the load in its bed) is said where it is.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';

import { BEAM_HALF, PLANK_HALF } from '../../src/assets/props.ts';
import { UTE_WHEELBASE_HALF } from '../../src/assets/ute.ts';
import { BRIDGE, BRIDGE_X, YARD_Y, timberYardLevel } from '../../src/levels/timber-yard.ts';
import { neutralCommand } from '../../src/sim/commands.ts';
import type { PlayerCommand } from '../../src/sim/commands.ts';
import { BREAK } from '../../src/sim/joints/breaking.ts';
import { EYE_HEIGHT, LabSim } from '../../src/sim/lab-sim.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { pose, quatFromYawPitchRoll, quatRotate } from '../../src/voxels/math.ts';

import { FLAT_ALONG_Z, LINES, hammerAt } from './bridge-helpers.ts';

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
    it('the yard bridge (two beams, both ends seated, nailed to the gate’s plan): a log’s worth in the bed, boarded and driven over by input', () => {
        const s = gateBridge(VARIANTS[0]);
        const beams = ['beam-0', 'beam-1'].map((name) => s.entities.find((e) => e.name === name)!);
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

/**
 * The variations, fixed before any run: where the beams are laid (dx across the creek, dz along
 * it, metres), how hard the ute is driven, and how long after building it sets off (ticks). Every
 * one is run on every bridge; none is dropped or retried.
 *
 * The throttles come from the approach alone, the same on every bridge: the lowest that gets the
 * loaded ute onto the underbuilt span. Its beams tip on the bank's lip and lift their back ends
 * 22 cm; at throttle 0.3 a loaded ute meets that step at 1.0 m/s and cannot climb it, so 0.3 is not
 * used.
 */
const VARIANTS = [
    { name: 'as laid', dx: 0, dz: 0, throttle: 0.35, wait: 0 },
    { name: '2 cm east', dx: 0.02, dz: 0, throttle: 0.35, wait: 0 },
    { name: '2 cm west and 2 cm nearer, half a second later', dx: -0.02, dz: 0.02, throttle: 0.4, wait: 30 },
    { name: '2 cm further out', dx: 0, dz: -0.02, throttle: 0.45, wait: 0 },
    { name: '1 cm east and 1 cm nearer, 1.5 s later', dx: 0.01, dz: 0.01, throttle: 0.5, wait: 90 }
] as const;
type Variant = (typeof VARIANTS)[number];

/** Both yard beams laid across on the wheel lines, `v.dx`, `v.dz` off, settled. */
function laidBeams(v: Variant): { s: LabSim; beams: LabSim['entities'] } {
    const s = new LabSim({ level: timberYardLevel });
    const beams = ['beam-0', 'beam-1'].map((name) => s.entities.find((e) => e.name === name)!);
    beams.forEach((b, i) => s.physics.place(b.id, pose(LINES[i] + v.dx, YARD_Y + 0.3, BRIDGE.zc + v.dz, FLAT_ALONG_Z)));
    for (let k = 0; k < 60; k++) s.step(neutralCommand(s.tick + 1));
    return { s, beams };
}

const nailCount = (s: LabSim) => [...s.joints.graph.connections()].reduce((n, c) => n + c.nails.length, 0);

/**
 * The proper bridge: the gate's own nail plan (yard-bridge.test's build by input, fixed in part 2):
 * four nails across each near end, 7 and 15 cm in from the beam's end, 5 cm either side of its line;
 * two across each far end, at the first two of the gate's spots that hold.
 */
function gateBridge(v: Variant): LabSim {
    const { s, beams } = laidBeams(v);
    for (const b of beams) {
        const x = b.pose.p.x;
        const y = b.pose.p.y + 0.12;
        const end = b.pose.p.z + BEAM_HALF.x;
        for (const dz of [0.07, 0.15])
            for (const dx of [-0.05, 0.05]) hammerAt(s.joints, { x: x + dx, y, z: end - dz }, s.tick);
        const farNailZ = Math.min(BRIDGE.farFace - 0.06, b.pose.p.z - BEAM_HALF.x + 0.16);
        let got = 0;
        for (const [dx, dz] of [
            [-0.05, 0],
            [0.05, 0],
            [0, 0],
            [-0.05, -0.06],
            [0.05, -0.06],
            [0, -0.06]
        ]) {
            if (got === 2) break;
            const before = nailCount(s);
            hammerAt(s.joints, { x: x + dx, y, z: farNailZ + dz }, s.tick);
            if (nailCount(s) > before) got++;
        }
    }
    expect(nailCount(s)).toBe(12);
    return s;
}

/** Two nails per beam end, 8 cm apart (yardBridge's): reported, not asserted. */
function twoPerEnd(v: Variant): LabSim {
    const { s, beams } = laidBeams(v);
    for (let i = 0; i < 2; i++)
        for (const end of [1, -1])
            for (let k = 0; k < 2; k++) {
                const z = end > 0 ? BRIDGE.nearFace + 0.22 + 0.08 * k : BRIDGE.farFace - 0.22 - 0.08 * k;
                hammerAt(s.joints, { x: LINES[i] + v.dx, y: beams[i].pose.p.y + 0.12, z }, s.tick);
            }
    // (reported only, with the nails that went in: some of the 8 can glance off)
    return s;
}

/**
 * Underbuilt (as in breaking.test's): both beams run out from the bank over the creek, short of
 * the far seat, propped while four nails each go into the bank's lip, then let go. Laid `v.dx`,
 * `v.dz` off.
 */
function underBridge(v: Variant): LabSim {
    const s = new LabSim({ level: timberYardLevel });
    const beams = ['beam-0', 'beam-1'].map((name) => s.entities.find((e) => e.name === name)!);
    const back = BRIDGE.nearEdge + 1.1 + v.dz;
    const zc = back - BEAM_HALF.x;
    beams.forEach((b, i) =>
        s.physics.place(b.id, pose(LINES[i] + v.dx, YARD_Y + BEAM_HALF.y + 0.03, zc, FLAT_ALONG_Z))
    );
    const props = LINES.map((x) =>
        s.physics.addStatic(
            RAPIER.ColliderDesc.cuboid(0.15, 0.5, 0.15).setTranslation(
                x + v.dx,
                YARD_Y - 0.5,
                back - 2 * BEAM_HALF.x + 0.2
            )
        )
    );
    for (let k = 0; k < 60; k++) s.step(neutralCommand(s.tick + 1));
    for (let i = 0; i < 2; i++)
        for (let k = 0; k < 4; k++)
            hammerAt(
                s.joints,
                {
                    x: LINES[i] + v.dx + (k % 2 ? 0.05 : -0.05),
                    y: beams[i].pose.p.y + 0.12,
                    z: BRIDGE.nearEdge - 0.12 + 0.06 * (k >> 1)
                },
                s.tick
            );
    for (const c of props) s.physics.world.removeCollider(c, true);
    expect(nailCount(s)).toBe(8);
    return s;
}

/**
 * One run: the loaded ute boarded and driven over by input. `mounted`: its front axle got past the
 * near abutment's face, onto the span (the precondition for judging the bridge at all).
 */
function cross(s: LabSim, v: Variant) {
    const nails = nailCount(s);
    uteOnBank(s, true);
    for (let k = 0; k < v.wait; k++) s.step(neutralCommand(s.tick + 1));
    const e0 = s.events.length;
    const max = new Map<number, number>();
    const front = { x: 0, y: 0, z: 0 };
    let frontZ = Infinity;
    const r = boardAndDrive(s, v.throttle, () => {
        strained(s, max);
        quatRotate(s.ute.pose.q, 0, 0, UTE_WHEELBASE_HALF, front);
        frontZ = Math.min(frontZ, s.ute.pose.p.z + front.z);
    });
    const evs = s.events.slice(e0).filter((e) => e.kind === 'creak' || e.kind === 'break');
    const kinds = evs.map((e) => e.kind);
    const ticks = evs.map((e) => e.tick);
    const firstBreak = ticks[kinds.indexOf('break')];
    return {
        nails,
        mounted: frontZ < BRIDGE.nearFace - 0.1,
        reached: r.reached,
        peak: Math.max(0, ...max.values()),
        kinds,
        ticks,
        tell: kinds.includes('break') ? (firstBreak - ticks[0]) / 60 : NaN,
        joints: s.joints.graph.size,
        uteY: s.ute.pose.p.y,
        clamps: s.physics.stats.linClamps + s.physics.stats.angClamps
    };
}

type Run = ReturnType<typeof cross>;
const outcome = (r: Run) =>
    !r.mounted
        ? 'NOT ONTO THE SPAN'
        : r.reached
          ? `across${r.kinds.length ? `, ${r.kinds.join(' ')}` : ''}`
          : `gave way: ${r.kinds.map((k, i) => `${k}@${r.ticks[i]}`).join(' ')}, creak to break ${r.tell.toFixed(2)} s, the ute in the creek (y ${r.uteY.toFixed(2)})`;

describe('the gate: an underbuilt bridge fails every time, a proper one holds every time (#53)', () => {
    it('over the same five variations (stated up front), the loaded ute driven by input; all run, then judged', () => {
        const runs = VARIANTS.map((v) => ({
            v,
            gate: cross(gateBridge(v), v),
            two: cross(twoPerEnd(v), v),
            under: cross(underBridge(v), v)
        }));
        console.log(
            `five variations, loaded ute (peak utilization; creak at ${BREAK.creak}):\n` +
                runs
                    .map(
                        ({ v, gate, two, under }) =>
                            `  ${v.name} (throttle ${v.throttle}):\n` +
                            `    proper (the gate's plan, ${gate.nails} nails): peak ${gate.peak.toFixed(2)}, ${outcome(gate)}\n` +
                            `    two nails per end (reported, ${two.nails} nails): peak ${two.peak.toFixed(2)}, ${outcome(two)}\n` +
                            `    underbuilt (${under.nails} nails): peak ${under.peak.toFixed(2)}, ${outcome(under)}`
                    )
                    .join('\n')
        );
        for (const { v, gate, under } of runs) {
            // the precondition: onto the span (a stall at the entry is neither a pass nor a fail)
            expect(gate.mounted, `${v.name}: proper, onto the span`).toBe(true);
            expect(under.mounted, `${v.name}: underbuilt, onto the span`).toBe(true);
            // proper: across, no creak, nothing broken
            expect(gate.reached, v.name).toBe(true);
            expect(gate.kinds, v.name).toEqual([]);
            expect(gate.peak, v.name).toBeLessThan(BREAK.creak);
            expect(gate.joints, v.name).toBe(4);
            expect(gate.clamps, v.name).toBe(0);
            // underbuilt: it creaks first, gives way after the tell, and the ute goes into the creek
            expect(under.kinds[0], v.name).toBe('creak');
            expect(under.kinds, v.name).toContain('break');
            expect(under.tell, v.name).toBeGreaterThanOrEqual(BREAK.tell - 1e-9);
            expect(under.reached, v.name).toBe(false);
            expect(under.uteY, v.name).toBeLessThan(YARD_Y - 0.3);
            expect(under.clamps, v.name).toBe(0);
        }
    }, 900_000);
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
