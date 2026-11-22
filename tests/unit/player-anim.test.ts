import { describe, expect, it } from 'vitest';

import { REACH_RISE } from '../../src/assets/beaver.ts';
import { BODY } from '../../src/assets/player-body.ts';
import { SIM_DT } from '../../src/sim/clock.ts';
import { PlayerAnimator, SHOULDER_HEIGHT } from '../../src/sim/player-anim.ts';
import type { AnimInput, AnimOutput } from '../../src/sim/player-anim.ts';

const noEvents = () => ({ grabbed: false, missed: false, thrown: false, dropped: false });
const base = (over: Partial<AnimInput> = {}): AnimInput => ({
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    grounded: true,
    vy: 0,
    walkAmount: 0,
    walkPhase: 0,
    held: null,
    events: noEvents(),
    ...over
});
const out = (): AnimOutput => ({ raise: 0, reach: 0, spread: 0, lean: 0, headPitch: 0 });
/** A thing held 1.2 m in front (forward is -Z at yaw 0) at the given height above the feet. */
const heldAt = (y: number, mass = 5, halfWidth = 0.15, strain = 0.1) => ({ x: 0, y, z: -1.2, mass, halfWidth, strain });

function run(a: PlayerAnimator, frames: (n: number) => AnimInput, ticks: number, track?: (o: AnimOutput) => void) {
    const o = out();
    for (let n = 0; n < ticks; n++) {
        a.step(frames(n), SIM_DT, o);
        track?.(o);
    }
    return o;
}

describe('player animation (grab, carry, throw)', () => {
    it('aims the arms at the grip: higher grips raise them higher, and they settle', () => {
        const low = run(new PlayerAnimator(), () => base({ held: heldAt(SHOULDER_HEIGHT - 0.4) }), 120);
        const level = run(new PlayerAnimator(), () => base({ held: heldAt(SHOULDER_HEIGHT) }), 120);
        const high = run(new PlayerAnimator(), () => base({ held: heldAt(SHOULDER_HEIGHT + 0.5) }), 120);
        expect(low.raise).toBeLessThan(level.raise);
        // level with the shoulders: the arms point at it from where the shoulders reach to (forward
        // by the reach, and up by REACH_RISE of it), so just under straight ahead
        expect(level.raise).toBeCloseTo(Math.atan2(1.2 - level.reach, REACH_RISE * level.reach), 1);
        expect(level.raise).toBeLessThanOrEqual(Math.PI / 2);
        expect(high.raise).toBeGreaterThan(level.raise);
        // a grip far below the shoulders (looking well down): the arms aim down at it, as low as
        // 0.45 rad from hanging, never lower
        const deep = run(
            new PlayerAnimator(),
            () => base({ held: { ...heldAt(SHOULDER_HEIGHT - 1.2), z: -0.35 } }),
            120
        );
        expect(deep.raise).toBeCloseTo(0.45, 2);
        const lowish = run(
            new PlayerAnimator(),
            () => base({ held: { ...heldAt(SHOULDER_HEIGHT - 0.5), z: -0.9 } }),
            120
        );
        expect(lowish.raise).toBeGreaterThan(0.45);
        expect(lowish.raise).toBeLessThan(low.raise);
        // empty paws hang
        expect(run(new PlayerAnimator(), () => base(), 60).raise).toBeCloseTo(0, 3);
    });

    it('a grab lunges out and the weight comes on: heavier dips the arms more and leans back more', () => {
        const dip = (mass: number) => {
            const a = new PlayerAnimator();
            let minRaise = Infinity;
            let maxReach = 0;
            const o = run(
                a,
                (n) => base({ held: heldAt(SHOULDER_HEIGHT, mass), events: { ...noEvents(), grabbed: n === 0 } }),
                90,
                (o) => {
                    if (o.raise > 0.3) minRaise = Math.min(minRaise, o.raise);
                    maxReach = Math.max(maxReach, o.reach);
                }
            );
            return { o, maxReach };
        };
        const light = dip(2);
        const heavy = dip(40);
        expect(light.maxReach).toBeGreaterThan(0.03);
        expect(heavy.o.lean).toBeGreaterThan(light.o.lean);
        // settles near the aim after a moment either way
        expect(light.o.raise).toBeGreaterThan(1.3);
        expect(heavy.o.raise).toBeGreaterThan(1.3);
    });

    it('wide things spread the arms out, small ones bring them in', () => {
        const wide = run(new PlayerAnimator(), () => base({ held: heldAt(SHOULDER_HEIGHT, 5, 0.5) }), 120);
        const small = run(new PlayerAnimator(), () => base({ held: heldAt(SHOULDER_HEIGHT, 1, 0.08) }), 120);
        // the hands go either side of the grip: wide apart for a wide thing, together for a small one
        expect(wide.spread).toBeGreaterThan(small.spread + 0.1);
        expect(small.spread).toBeLessThan(0);
    });

    it('a throw flings the arms up and lunges forward, then they come back down', () => {
        const a = new PlayerAnimator();
        let peak = 0;
        let minLean = 0;
        run(a, () => base({ held: heldAt(SHOULDER_HEIGHT) }), 60);
        const o = run(
            a,
            (n) => base({ events: { ...noEvents(), thrown: n === 0 } }),
            90,
            (o) => {
                peak = Math.max(peak, o.raise);
                minLean = Math.min(minLean, o.lean);
            }
        );
        expect(peak).toBeGreaterThan(Math.PI / 2 + 0.3);
        expect(minLean).toBeLessThan(-0.1);
        expect(o.raise).toBeLessThan(0.15);
    });

    it('a missed grab swipes out and back', () => {
        const a = new PlayerAnimator();
        let peak = 0;
        const o = run(
            a,
            (n) => base({ events: { ...noEvents(), missed: n === 0 } }),
            60,
            (o) => (peak = Math.max(peak, o.raise))
        );
        expect(peak).toBeGreaterThan(0.6);
        expect(o.raise).toBeLessThan(0.1);
    });

    it('a hard landing dips the body forward; a step does not', () => {
        const land = (vy: number) => {
            const a = new PlayerAnimator();
            let minLean = 0;
            run(
                a,
                (n) => base({ grounded: n >= 10, vy: n < 10 ? vy : 0 }),
                60,
                (o) => (minLean = Math.min(minLean, o.lean))
            );
            return minLean;
        };
        expect(land(-8)).toBeLessThan(-0.1);
        expect(land(-1)).toBeGreaterThan(-0.01);
    });

    it('stays bounded and settles under any mix of events', () => {
        const a = new PlayerAnimator();
        let n = 0;
        const o = run(
            a,
            () => {
                n++;
                return base({
                    walkAmount: 1,
                    walkPhase: n * 0.2,
                    held: n % 90 < 60 ? heldAt(0.5 + (n % 7) * 0.2, 60, 0.6, 1) : null,
                    events: {
                        grabbed: n % 90 === 0,
                        missed: n % 13 === 0,
                        thrown: n % 90 === 60,
                        dropped: n % 31 === 0
                    }
                });
            },
            2000,
            (o) => {
                for (const v of Object.values(o)) expect(Number.isFinite(v)).toBe(true);
                expect(o.raise).toBeLessThanOrEqual(2.7);
                expect(o.lean).toBeGreaterThanOrEqual(-0.5);
            }
        );
        // the body's own reach limit, plus the grab lunge's overshoot
        expect(o.reach).toBeLessThanOrEqual(BODY.reachMax + 0.06);
    });
});
