/**
 * Player body animation for grabbing, carrying, throwing and landing: what makes picking things up
 * feel physical. Runs in the sim at the fixed tick (deterministic, and every player sees everyone's
 * through the beaver's animation channels).
 *
 * Every motion is a damped spring towards a target; events add timed pose overlays to the targets:
 * - Holding: the arms aim at the actual grip point on the body, so a heavy log that sags pulls the
 *   arms down with it, and they spread to the sides of wide things. The body leans back against the
 *   load, and strain shows as a slight tremor. Walking bobs what you carry.
 * - Grab: a lunge towards the object, then the arms dip as its weight comes on (more for heavy
 *   things) and settle with a little overshoot.
 * - Missed grab: a quick swipe out and back.
 * - Throw: the arms fling up and forward and the body lunges into it.
 * - Drop: the arms lift slightly as they let go, then fall.
 * - Landing from a fall: the body dips forward.
 *
 * Motions are exaggerated and last a quarter of a second or more, so they read in voxels (a 5-10 cm
 * lattice) rebuilt 20 times a second.
 */

import { REACH_RISE as BODY_REACH_RISE } from '../assets/beaver.ts';
import { BODY } from '../assets/player-body.ts';

/** Where a player's shoulders are, above their feet (m) - between the two shoulders. */
export const SHOULDER_HEIGHT = BODY.shoulderHeight;
/** Arm length, shoulder to paw (m). */
const ARM_LENGTH = BODY.armLength;
const SHOULDER_HALF_WIDTH = BODY.shoulderHalfWidth;
/** How far the body turns raised arms in with no spread (rad; see the assets' ARM_INWARD). */
const ARM_INWARD_READY = BODY.armInward;
/** Reaching shoulders also rise by this much of the reach (the bodies' REACH_RISE). */
const REACH_RISE = BODY_REACH_RISE;
/** How far the shoulders may reach forward into what you hold (m). */
const REACH_MAX = BODY.reachMax;

export interface AnimEvents {
    grabbed: boolean;
    missed: boolean;
    thrown: boolean;
    dropped: boolean;
    /** A jump refused (holding the bucket): a small dip, as if bracing for a hop that never comes. */
    balked?: boolean;
}

export interface AnimInput {
    /** The player: feet position, facing yaw (camera convention: forward = (-sin, -cos)). */
    x: number;
    y: number;
    z: number;
    yaw: number;
    pitch: number;
    grounded: boolean;
    /** Vertical speed before this tick's landing (m/s), for the landing dip. */
    vy: number;
    walkAmount: number;
    walkPhase: number;
    /** What they hold (null: nothing): grip point (world), mass (kg), half width (m), strain (0-1). */
    held: { x: number; y: number; z: number; mass: number; halfWidth: number; strain: number } | null;
    events: AnimEvents;
}

export interface AnimOutput {
    /** Arm raise (rad, 0 hangs, pi/2 straight ahead). */
    raise: number;
    /** How far the shoulders reach forward (m). */
    reach: number;
    /** Arms turned outward (rad; negative turns them in). */
    spread: number;
    /** Torso lean (rad; positive leans back). */
    lean: number;
    /** Head pitch (rad; positive looks up). */
    headPitch: number;
}

class Spring {
    x = 0;
    v = 0;
    readonly k: number;
    readonly c: number;
    constructor(k: number, c: number) {
        this.k = k;
        this.c = c;
    }
    step(target: number, dt: number): void {
        this.v += (this.k * (target - this.x) - this.c * this.v) * dt;
        this.x += this.v * dt;
    }
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** Smoothed attack / hold / release, 0-1, for a time since the start (s). */
function envelope(t: number, attack: number, hold: number, release: number): number {
    if (t <= 0) return 0;
    let x: number;
    if (t < attack) x = t / attack;
    else if (t < attack + hold) x = 1;
    else x = Math.max(0, 1 - (t - attack - hold) / release);
    return x * x * (3 - 2 * x);
}

/**
 * The event overlays: offsets added to the targets (raise rad, reach m, lean rad) over an envelope
 * (s). `...Heavy` parts scale with how heavy the thing grabbed is (0-1, 30 kg and up).
 */
const OVERLAYS = {
    // lunge out to it, then the weight comes on: the arms dip and the body sinks back
    grab: {
        delay: 0,
        attack: 0.06,
        hold: 0.04,
        release: 0.28,
        raise: 0.25,
        raiseHeavy: 0,
        reach: 0.18,
        lean: -0.2,
        leanHeavy: 0
    },
    // a quick swipe out and back
    miss: {
        delay: 0,
        attack: 0.07,
        hold: 0.1,
        release: 0.3,
        raise: 1.2,
        raiseHeavy: 0,
        reach: 0.16,
        lean: -0.16,
        leanHeavy: 0
    },
    // fling up and forward, lunging into it
    throw: {
        delay: 0,
        attack: 0.06,
        hold: 0.12,
        release: 0.45,
        raise: 2.4,
        raiseHeavy: 0,
        reach: 0.22,
        lean: -0.42,
        leanHeavy: 0
    },
    // a little lift as the paws let go
    drop: {
        delay: 0,
        attack: 0.04,
        hold: 0.02,
        release: 0.22,
        raise: 0.35,
        raiseHeavy: 0,
        reach: 0,
        lean: 0,
        leanHeavy: 0
    },
    // landing: dip forward, arms out for balance
    land: {
        delay: 0,
        attack: 0.04,
        hold: 0.06,
        release: 0.35,
        raise: 0.6,
        raiseHeavy: 0,
        reach: 0,
        lean: -0.4,
        leanHeavy: 0
    },
    // the weight coming on, a moment after the grab's lunge: more for heavy things
    weight: {
        delay: 0.08,
        attack: 0.07,
        hold: 0.05,
        release: 0.4,
        raise: -0.25,
        raiseHeavy: -0.55,
        reach: 0,
        lean: 0.03,
        leanHeavy: 0.22
    }
} as const;
type OverlayKind = keyof typeof OVERLAYS;

export class PlayerAnimator {
    // stiff with a little overshoot for the arms; softer for the torso
    readonly raise = new Spring(170, 16);
    readonly reach = new Spring(140, 15);
    readonly spread = new Spring(120, 18);
    readonly lean = new Spring(90, 13);
    readonly head = new Spring(200, 26);
    private time = 0;
    private wasGrounded = true;
    private fallSpeed = 0;
    private readonly overlays: { kind: OverlayKind; t: number; amount: number; heavy: number }[] = (
        Object.keys(OVERLAYS) as OverlayKind[]
    ).map((kind) => ({ kind, t: 0, amount: 0, heavy: 0 }));

    private fire(kind: OverlayKind, amount: number, heavy = 0): void {
        const o = this.overlays.find((x) => x.kind === kind)!;
        o.t = 0;
        o.amount = amount;
        o.heavy = heavy;
    }

    reset(): void {
        for (const s of [this.raise, this.reach, this.spread, this.lean, this.head]) s.x = s.v = 0;
        this.time = 0;
        this.wasGrounded = true;
        this.fallSpeed = 0;
        for (const o of this.overlays) o.amount = 0;
    }

    step(i: AnimInput, dt: number, out: AnimOutput): AnimOutput {
        this.time += dt;
        const e = i.events;
        let raiseT = 0;
        let reachT = 0;
        let spreadT = 0;
        let leanT = 0;
        const h = i.held;
        const heavy = h ? clamp(h.mass / 30, 0, 1) : 0;
        if (h) {
            // aim from the shoulders at the grip, in the player's frame
            const fx = -Math.sin(i.yaw);
            const fz = -Math.cos(i.yaw);
            const dx = h.x - i.x;
            const dz = h.z - i.z;
            const fwd = dx * fx + dz * fz;
            const up = h.y - (i.y + SHOULDER_HEIGHT);
            // the shoulders reach into it (forward, and up by REACH_RISE of that), so the hands
            // get to the grip; the arms aim from where the shoulders reach to
            for (let k = 0; k < 4; k++) {
                const d = Math.hypot(fwd - reachT, up - REACH_RISE * reachT);
                reachT = clamp(reachT + d - ARM_LENGTH, 0, REACH_MAX);
            }
            const af = fwd - reachT;
            const au = up - REACH_RISE * reachT;
            const dist = Math.hypot(af, au);
            raiseT = clamp(Math.atan2(Math.max(0.05, af), -au), 0.45, 2.5);
            // both hands on it, either side of the grip: wide things by their sides, small ones
            // close together
            const hand = clamp(h.halfWidth, 0.08, 0.35);
            const across = Math.max(0.1, dist);
            // turned in (or out) from straight ahead
            spreadT = clamp(ARM_INWARD_READY - Math.atan2(SHOULDER_HALF_WIDTH - hand, across), -0.3, 0.3);
            // lean back against the load; strain shakes the arms a little
            leanT = 0.08 + 0.2 * Math.max(heavy, h.strain);
            raiseT += 0.022 * h.strain * Math.sin(this.time * Math.PI * 2 * 9);
            // what you carry bobs with your step
            raiseT += 0.1 * i.walkAmount * Math.sin(2 * i.walkPhase);
        }

        // events start timed pose overlays (attack, hold, release), which the springs then smooth
        if (e.grabbed) {
            this.fire('grab', 1);
            this.fire('weight', 1, heavy);
        }
        if (e.missed) this.fire('miss', 1);
        if (e.thrown) this.fire('throw', 1);
        if (e.dropped) this.fire('drop', 1);
        if (e.balked) this.fire('land', 0.35);
        // landing: dip forward by how hard you came down
        if (!i.grounded) this.fallSpeed = Math.max(this.fallSpeed, -i.vy);
        if (i.grounded && !this.wasGrounded) {
            const hard = clamp((this.fallSpeed - 2) / 6, 0, 1);
            if (hard > 0) this.fire('land', hard);
            this.fallSpeed = 0;
        }
        this.wasGrounded = i.grounded;
        for (const o of this.overlays) {
            if (o.amount <= 0) continue;
            o.t += dt;
            const s = OVERLAYS[o.kind];
            const w = o.amount * envelope(o.t - s.delay, s.attack, s.hold, s.release);
            if (o.t > s.delay + s.attack + s.hold + s.release) o.amount = 0;
            raiseT += w * (s.raise + s.raiseHeavy * o.heavy);
            reachT += w * s.reach;
            leanT += w * (s.lean + s.leanHeavy * o.heavy);
        }

        this.raise.step(raiseT, dt);
        this.reach.step(reachT, dt);
        this.spread.step(spreadT, dt);
        this.lean.step(leanT, dt);
        this.head.step(clamp(i.pitch, -0.7, 0.55), dt);

        out.raise = clamp(this.raise.x, 0, 2.7);
        out.reach = clamp(this.reach.x, -0.05, REACH_MAX + 0.06);
        out.spread = clamp(this.spread.x, -0.3, 0.45);
        out.lean = clamp(this.lean.x, -0.5, 0.35);
        out.headPitch = this.head.x;
        return out;
    }
}
