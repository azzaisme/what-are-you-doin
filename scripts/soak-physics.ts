/**
 * Headless physics soak (Epic 2 gate): a scripted first-person player plays in the sandbox for N
 * simulated minutes at the fixed 60 Hz tick. It walks, sprints, jumps, summons and carries the
 * plank while turning, throws it, grabs and drops the crate, tries to lift the log, launches the
 * ragdoll, and runs the drop test; the second half adds 25 constantly moving stress bodies.
 *
 * Reports per-tick physics cost, ticks over the 16.7 ms budget (each would be a dropped tick at
 * 60 Hz on this CPU), held-prop speed and force, safety clamps, recoveries and grab breaks.
 * Usage: node scripts/soak-physics.ts [minutes=10]
 */
import os from 'node:os';

import { ACTION_DROP, ACTION_DROP_TEST, ACTION_NONE, ACTION_RAGDOLL, neutralCommand } from '../src/sim/commands.ts';
import type { PlayerCommand } from '../src/sim/commands.ts';
import { EYE_HEIGHT, LabSim } from '../src/sim/lab-sim.ts';
import { GRAB } from '../src/sim/physics/grab.ts';
import { initPhysics } from '../src/sim/physics/world.ts';

await initPhysics();
const minutes = Number(process.argv[2] ?? 10);
const TICKS = Math.round(minutes * 60 * 60);
const sim = new LabSim();
sim.step(neutralCommand(0));
sim.fpActive = true;
sim.placePlayer(0, 7, 0);

const tick: number[] = [];
const tickStress: number[] = [];
let maxHeldSpeed = 0;
let maxForce = 0;
let maxAnySpeed = 0;
let grabsTried = 0;
let grabsMade = 0;
let carries = 0;
let throws = 0;
let ragdolls = 0;
let nonFinite = 0;
let overBudget = 0;
let maxActive = 0;
let carryOn = false;

/** One 20 s routine, repeated, phase-shifted by the repetition count for variety. */
function routine(n: number): PlayerCommand {
    const rep = Math.floor(n / 1200);
    const t = n % 1200;
    const c: PlayerCommand = { ...neutralCommand(n), yaw: sim.player.yaw, pitch: sim.player.pitch, carry: carryOn };
    const wander = Math.sin(n * 0.004 + rep) * 2.2;
    if (t < 180) {
        // walk and look around, sprint, jump
        c.moveZ = 1;
        c.sprint = t > 90;
        c.yaw = wander;
        c.pitch = -0.1;
        c.jump = t === 120;
    } else if (t === 180) {
        carryOn = true; // G: plank into the hands
        c.carry = true;
        carries++;
    } else if (t < 600) {
        // carry it: walk, turn briskly, look up and down
        c.carry = true;
        c.moveZ = t % 240 < 160 ? 1 : 0;
        c.moveX = t % 300 < 60 ? 1 : 0;
        c.sprint = t % 400 > 250;
        c.yaw = wander + Math.sin(t * 0.03) * 1.1;
        c.pitch = Math.sin(t * 0.02) * 0.6;
        c.reach = t % 100 === 0 ? (t % 200 === 0 ? 0.4 : -0.4) : 0;
    } else if (t === 600) {
        c.carry = true;
        c.throw = true;
        c.pitch = 0.3;
        throws++;
    } else if (t === 601) {
        carryOn = false;
    } else if (t > 601 && t <= 700) {
        // walk up to the nearest prop, then look at it and grab it
        const target = [sim.cube, sim.bucket, sim.log, sim.sphere, sim.plank, sim.held].reduce((a, b) => (dist(b) < dist(a) ? b : a));
        const p = sim.player;
        const dx = target.pose.p.x - p.x;
        const dz = target.pose.p.z - p.z;
        c.yaw = Math.atan2(-dx, -dz);
        c.pitch = -Math.atan2(p.y + EYE_HEIGHT - target.pose.p.y, Math.hypot(dx, dz));
        c.moveZ = Math.hypot(dx, dz) > 1.3 ? 1 : 0;
        if (t === 700) {
            c.grab = true;
            grabsTried++;
        }
    } else if (t > 700 && t < 900) {
        c.pitch = 0.1 * Math.sin(t * 0.05);
        c.moveZ = t > 800 ? -1 : 0;
    } else if (t === 900) {
        c.action = ACTION_DROP;
    } else if (t === 950 && rep % 2 === 0) {
        c.action = ACTION_RAGDOLL;
        ragdolls++;
    } else if (t === 1000 && rep % 3 === 0) {
        c.action = ACTION_DROP_TEST;
    } else if (t > 1000) {
        // walk back towards the props so the next routine finds them
        const p = sim.player;
        c.yaw = Math.atan2(-(0.5 - p.x), -(4.5 - p.z));
        c.moveZ = Math.hypot(0.5 - p.x, 4.5 - p.z) > 2.5 ? 1 : 0;
    }
    if (c.action === ACTION_NONE && t === 701 && sim.physics.heldId >= 0) grabsMade++;
    return c;
}

function dist(e: { pose: { p: { x: number; z: number } } }): number {
    return Math.hypot(e.pose.p.x - sim.player.x, e.pose.p.z - sim.player.z);
}

const t0 = performance.now();
for (let n = 1; n <= TICKS; n++) {
    sim.stressCount = n > TICKS / 2 ? 25 : 0;
    sim.step(routine(n));
    const ms = sim.physicsMs;
    (n > TICKS / 2 ? tickStress : tick).push(ms);
    if (ms > 1000 / 60) overBudget++;
    const st = sim.physics.stats;
    maxActive = Math.max(maxActive, st.activeBodies);
    if (st.holding >= 0) {
        maxForce = Math.max(maxForce, st.grabForce);
        const b = sim.physics.bodies.get(st.holding)!.body.linvel();
        maxHeldSpeed = Math.max(maxHeldSpeed, Math.hypot(b.x, b.y, b.z));
    }
    if (n % 30 === 0) {
        for (const e of sim.entities) {
            if (!Number.isFinite(e.pose.p.x + e.pose.p.y + e.pose.p.z + e.pose.q.w)) nonFinite++;
        }
        for (const b of sim.physics.bodies.values()) {
            if (b.kind !== 'dynamic' || !b.enabled) continue;
            const v = b.body.linvel();
            maxAnySpeed = Math.max(maxAnySpeed, Math.hypot(v.x, v.y, v.z));
        }
    }
}
const wall = performance.now() - t0;

const pct = (a: number[], p: number) => {
    const s = [...a].sort((x, y) => x - y);
    return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(3);
};
const summary = (a: number[]) => ({ ticks: a.length, avg: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3), p50: pct(a, 0.5), p95: pct(a, 0.95), p99: pct(a, 0.99), max: pct(a, 1) });
const st = sim.physics.stats;
console.log(
    JSON.stringify(
        {
            cpu: `${os.cpus()[0].model} x${os.cpus().length}`,
            node: process.version,
            simulatedMinutes: minutes,
            wallSeconds: +(wall / 1000).toFixed(1),
            tickMs: { baseScene: summary(tick), with25StressBodies: summary(tickStress) },
            ticksOver16_7ms: overBudget,
            maxActiveBodies: maxActive,
            held: { maxSpeed: +maxHeldSpeed.toFixed(2), maxForceN: +maxForce.toFixed(1), forceCapN: GRAB.maxForce },
            maxDynamicSpeedSampled: +maxAnySpeed.toFixed(2),
            counts: { carries, throws, grabsTried, grabsMade, ragdolls, grabBreaks: st.grabBreaks, linClamps: st.linClamps, angClamps: st.angClamps, releaseClamps: st.releaseClamps, recovered: st.recovered, nonFinitePoses: nonFinite }
        },
        null,
        1
    )
);
