/**
 * The grab law's heavy case (Epic 5, #52): a body heavier than one beaver's grip (GRAB.maxForce /
 * g, about 66 kg) used to get the full cap straight up and nothing else. Now the vertical spring
 * caps the lift (no more than holds the grip where it should be) and what the cap leaves over pulls
 * along. Under that weight the law is exactly what it was: checked against a frozen copy of it.
 */
import { describe, expect, it } from 'vitest';

import { GRAB, grabForce } from '../../src/sim/physics/grab.ts';
import type { GrabForceInput, GrabForceResult } from '../../src/sim/physics/grab.ts';

const G = 9.81;
const HEAVY = GRAB.maxForce / G; // ~66.3 kg

/** The grab law as it was before #52 (epics-5-10 at 3ce2f95), frozen for comparison. */
function before(i: GrabForceInput, out: GrabForceResult, maxForce: number = GRAB.maxForce): GrabForceResult {
    const w = 2 * Math.PI * GRAB.frequency;
    const k = w * w;
    const c = 2 * GRAB.damping * w;
    const ex = i.target.x - i.anchor.x;
    const ey = i.target.y - i.anchor.y;
    const ez = i.target.z - i.anchor.z;
    const vx = i.targetVelocity.x - i.anchorVelocity.x;
    const vy = i.targetVelocity.y - i.anchorVelocity.y;
    const vz = i.targetVelocity.z - i.anchorVelocity.z;
    const msx = Math.min(i.mass, i.springMass?.x ?? i.mass);
    const msy = Math.min(i.mass, i.springMass?.y ?? i.mass);
    const msz = Math.min(i.mass, i.springMass?.z ?? i.mass);
    const sx = msx * (k * ex + c * vx);
    const sy = msy * (k * ey + c * vy);
    const sz = msz * (k * ez + c * vz);
    const g = i.mass * i.gravity;
    let fx = sx;
    let fy = sy + g;
    let fz = sz;
    const mag = Math.hypot(fx, fy, fz);
    out.requested = mag;
    out.saturated = mag > maxForce;
    if (out.saturated) {
        if (g >= maxForce) {
            fx = 0;
            fy = maxForce;
            fz = 0;
        } else {
            const ss = sx * sx + sy * sy + sz * sz;
            const gs = g * sy;
            const s =
                ss > 0
                    ? Math.max(
                          0,
                          Math.min(1, (-gs + Math.sqrt(Math.max(0, gs * gs - ss * (g * g - maxForce * maxForce)))) / ss)
                      )
                    : 0;
            fx = s * sx;
            fy = g + s * sy;
            fz = s * sz;
        }
    }
    if (!Number.isFinite(fx + fy + fz)) fx = fy = fz = 0;
    out.fx = fx;
    out.fy = fy;
    out.fz = fz;
    out.error = Math.hypot(ex, ey, ez);
    return out;
}

const res = (): GrabForceResult => ({ fx: 0, fy: 0, fz: 0, requested: 0, error: 0, saturated: false });
const zero = { x: 0, y: 0, z: 0 };
/** A grip `e` (m) short of its target, at rest, for a body of `mass` (spring mass `ms`, per axis). */
const input = (mass: number, e: { x: number; y: number; z: number }, ms = mass): GrabForceInput => ({
    mass,
    springMass: { x: ms, y: ms, z: ms },
    gravity: G,
    anchor: zero,
    anchorVelocity: zero,
    target: e,
    targetVelocity: zero
});

/** A small deterministic generator (the same draws every run). */
function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

describe('the grab law for bodies heavier than one grip (#52)', () => {
    it('under one grip’s weight it is exactly what it was, over 20 000 random grips', () => {
        const r = rng(52);
        const u = (a: number) => (r() * 2 - 1) * a;
        let n = 0;
        for (let k = 0; k < 20_000; k++) {
            const mass = 0.5 + r() * (HEAVY - 0.6);
            const i: GrabForceInput = {
                mass,
                springMass: { x: mass * (0.2 + 0.8 * r()), y: mass * (0.2 + 0.8 * r()), z: mass * (0.2 + 0.8 * r()) },
                gravity: G,
                anchor: { x: u(2), y: u(2), z: u(2) },
                anchorVelocity: { x: u(4), y: u(4), z: u(4) },
                target: { x: u(2), y: u(2), z: u(2) },
                targetVelocity: { x: u(4), y: u(4), z: u(4) }
            };
            const a = grabForce(i, res());
            const b = before(i, res());
            expect([a.fx, a.fy, a.fz, a.saturated]).toEqual([b.fx, b.fy, b.fz, b.saturated]);
            if (a.saturated) n++;
        }
        expect(n).toBeGreaterThan(1000); // (the capped branch, where the two laws could differ, is exercised)
    });

    it('over it, with the grip below where it should be, the lift is the whole cap, straight up, as before', () => {
        // a whole log (113 kg) held alone, the grip 20 cm short of its hold point, below it
        const a = grabForce(input(113, { x: 0.05, y: 0.2, z: 0 }, 113), res());
        const b = before(input(113, { x: 0.05, y: 0.2, z: 0 }, 113), res());
        expect(a.fy).toBeCloseTo(GRAB.maxForce, 6);
        expect(Math.hypot(a.fx, a.fz)).toBeCloseTo(0, 6);
        expect([a.fx, a.fy, a.fz]).toEqual([b.fx, b.fy, b.fz]);
        expect(a.saturated).toBe(true);
    });

    it('over it, with the grip at or above where it should be, the spring caps the lift and the rest pulls along', () => {
        // one end of the log lifted (its far end on the ground): the grip is held up by the spring
        // and the cap's remainder, not 650 N regardless. The spring mass at a log's end is about a
        // quarter of its mass.
        const ms = 113 / 4;
        const w = 2 * Math.PI * GRAB.frequency;
        const k = w * w;
        const g = 113 * G;
        // 6 cm above its hold point, nothing along: not capped, so both laws lift the same (the
        // weight less what the spring takes back)
        const up = grabForce(input(113, { x: 0, y: -0.06, z: 0 }, ms), res());
        expect(up.saturated).toBe(false);
        expect(up.fy).toBeCloseTo(g + ms * k * -0.06, 6);
        expect(up.fy).toBe(before(input(113, { x: 0, y: -0.06, z: 0 }, ms), res()).fy);
        // and a long way above: it pushes down, never more than the cap
        const high = grabForce(input(113, { x: 0, y: -1, z: 0 }, ms), res());
        expect(high.fy).toBeCloseTo(-GRAB.maxForce, 6);
        // the case that tipped logs over: the same 6 cm above, but 30 cm behind its hold point too,
        // so the pull along saturates the grip. The old law then lifted with the whole cap anyway
        // (650 N up against the 423 N that holds the grip where it should be: the end kept rising
        // until the log stood on its far end) and pulled nothing along. Now the lift stays the
        // spring's, and the rest of the cap pulls it along.
        const e = { x: 0.3, y: -0.06, z: 0 };
        const now = grabForce(input(113, e, ms), res());
        const was = before(input(113, e, ms), res());
        expect(was.saturated).toBe(true);
        expect([was.fx, was.fy]).toEqual([0, GRAB.maxForce]);
        expect(now.saturated).toBe(true);
        expect(now.fy).toBeCloseTo(g + ms * k * -0.06, 6);
        const room = Math.sqrt(GRAB.maxForce ** 2 - now.fy ** 2);
        expect(now.fx).toBeGreaterThan(0);
        expect(now.fx).toBeCloseTo(Math.min(room, ms * k * 0.3), 6);
        expect(Math.hypot(now.fx, now.fy, now.fz)).toBeLessThanOrEqual(GRAB.maxForce + 1e-9);
        // never more than the cap, whatever the grip does
        const r = rng(75);
        for (let n = 0; n < 5000; n++) {
            const mass = HEAVY + 0.1 + r() * 300;
            const e = { x: (r() * 2 - 1) * 2, y: (r() * 2 - 1) * 2, z: (r() * 2 - 1) * 2 };
            const f = grabForce(input(mass, e, mass * (0.2 + 0.8 * r())), res());
            expect(Math.hypot(f.fx, f.fy, f.fz)).toBeLessThanOrEqual(GRAB.maxForce * (1 + 1e-9));
        }
    });
});
