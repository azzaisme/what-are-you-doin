/**
 * Hazard (#77): the road closure sign swap. Coming up the road towards a side track, the sign at the
 * track's mouth clunks over from "the road goes on" to "closed, detour down the track", and a barrier
 * stands across the road further on. Counterplay: take the side track (on foot or in the ute), or
 * move the barrier by hand.
 *
 * - **Trigger:** a player on foot CLOSURE.leadS from the junction at a run, in a window
 *   CLOSURE.window deep (anyone on foot in the window: standing, or facing either way, counts); or the ute closing on it, once the quickest it could get there
 *   (flat out from its speed now: quickest()) drops to leadS (+ CLOSURE.uteWindowS). Either way the
 *   tell lands at least 2.5 s before it reaches the junction however it speeds up, and one already
 *   closer (when the closure could not start before) gets none. Once a run, through the director's
 *   budget (one hazard at a time, the quiet start and spells, the weather).
 * - **Tell:** a mechanical clunk and a toast, and the sign's board swinging over (CLUNK.swingS) to
 *   the closed face, its arrow pointing down the track. The barrier is set across the road, beyond
 *   the junction, only when nobody stands where it goes.
 * - **The barrier is pinned** (its movement locked: the ute stops against it, it does not shove it)
 *   until someone takes hold of it (any player, a guest too: the grab is the host's); then it is a
 *   light prop to drag or carry off the road.
 * - **Over** (the director is free again) when the barrier is clear of the road, every corner more
 *   than CLOSURE.clearM outside the road's edge, or when every player, and the ute if someone is
 *   driving it, is past it (rejoined the road beyond, by the track). An empty ute, wherever it was
 *   left, does not hold it. No timer: waiting is not a way round.
 * - **The sign never lies:** it shows the closed face exactly while the barrier stands on the road;
 *   it clunks back to "the road goes on" once the barrier is clear, and stays closed if everyone took
 *   the track and left the barrier where it was; dragged back onto the road, it clunks closed again
 *   (CLOSURE_SHUT). A run's reset puts both back.
 *
 * Host only, like the rest of the director: guests see the barrier (a prop) and the sign (its swing
 * on its channel) in the snapshots, and hear the clunk from the toast (src/audio/game-audio.ts).
 */

import type { Pose } from '../voxels/math.ts';

import type { PhysicsWorld } from './physics/world.ts';

const S = (s: number) => Math.round(s * 60);

export const CLOSURE = {
    /** The tell lands at least this long before the junction at the actor's top speed (s). */
    leadS: 2.5,
    /** ... and fires within this much further out (m): a window, not "anywhere closer". */
    window: 1.5,
    /** On foot: a run (m/s). */
    runSpeed: 4.2,
    /**
     * The ute: its top speed (m/s) and, to be safe, more than its best acceleration (m/s^2): its
     * peak along the road, driven by input from the yard over the creek, is 3.7 (asserted under 4
     * in tests/unit/road-closure.test.ts); the #131 audit measured 4.6 coming off the creek's
     * bridge another way. Its tell comes
     * when the quickest it could reach the junction from where and how fast it is going drops to
     * leadS + uteWindowS: so its own lead is at least leadS however it is driven.
     */
    uteSpeed: 10,
    uteAccel: 5,
    uteWindowS: 0.5,
    /** The ute counts as coming only while it closes on the junction at least this fast (m/s). */
    uteMoving: 1,
    /** How far either side of the road's centre an actor counts as on it (m). */
    corridor: 6,
    /** The sign's board takes this long to swing over (s). */
    swingS: 1.2,
    /** The barrier is clear of the road when every corner is this far outside its edge (m). */
    clearM: 1,
    /** Nobody within this much of the barrier's footprint when it is set down (m). */
    standOff: 0.6,
    max: 1
} as const;

export const CLOSURE_PHASE = { idle: 0, tell: 1, active: 2 } as const;

/** The toasts (every device plays the clunk from them: src/audio/game-audio.ts). */
export const CLOSURE_TELL =
    '🚧 Clunk! Road closed ahead: drive round by the old logging track, or shift the barrier. On foot, you can squeeze past.';
export const CLOSURE_OPEN = '🚧 Clunk. The road is open again.';
/** The barrier put back across the road (by hand): the sign clunks closed again. */
export const CLOSURE_SHUT = '🚧 Clunk! The barrier is back across the road: road closed.';

/** Stand marker channel for the sign: its board's swing, 0 (the road goes on) to 1 (closed). */
export const SIGN_SWING = 0;

/** Where it happens, in the level's own terms (functions of world x, z). */
export interface RoadClosureSpec {
    /** How far along the route a point is (m), and where the side track leaves and rejoins the road. */
    along: (x: number, z: number) => number;
    junction: number;
    rejoin: number;
    /**
     * Where the closed stretch of road begins (along): a driven ute still before it (in the yard,
     * across the creek) does not keep the closure going; every player does. An empty ute never does.
     */
    from: number;
    /** Distance from the road's centre line, across it (m), and the road's half width. */
    across: (x: number, z: number) => number;
    roadHalf: number;
    /** The barrier as it stands across the road (its foot), and its half size. */
    barrier: Pose;
    barrierHalf: { x: number; y: number; z: number };
    /** The sign's foot, facing the oncoming road. */
    sign: Pose;
}

/** What the closure moves: the barrier (a prop body) and the sign (drawn from its channel). */
export interface ClosureEntities {
    barrier: { id: number; visible: boolean; pose: Pose };
    sign: { pose: Pose; anim: Float64Array; visible: boolean };
}

export interface RoadClosureHost {
    readonly tick: number;
    readonly physics: PhysicsWorld;
    readonly entities: ClosureEntities;
    /** Who could be coming: players on foot, and the ute (its speed). */
    readonly walkers: readonly { x: number; z: number }[];
    /** The ute (where, how fast, and whether someone is driving it), or null without one. */
    readonly ute: { x: number; z: number; speed: number; driven?: boolean } | null;
    say(text: string): void;
}

export class RoadClosure {
    phase: number = CLOSURE_PHASE.idle;
    count = 0;
    since = 0;
    /** The barrier is on the road's side of things (placed), and still locked in place. */
    deployed = false;
    pinned = false;
    /** The sign's board: where it is (0..1) and where it is going. */
    swing = 0;
    /** When the tell came, and how far the actor that brought it was from the junction (m). */
    tellDistance = 0;
    private placedHidden = false;
    /** The ute's distance along the route last tick (for how fast it is closing on the junction). */
    private uteAlong = NaN;
    private uteClosing = 0;
    private readonly spec: RoadClosureSpec;

    constructor(spec: RoadClosureSpec) {
        this.spec = spec;
    }

    reset(): void {
        this.phase = CLOSURE_PHASE.idle;
        this.count = this.since = 0;
        this.deployed = this.pinned = false;
        this.swing = 0;
        this.tellDistance = 0;
        this.placedHidden = false;
        this.uteAlong = NaN;
        this.uteClosing = 0;
    }

    get busy(): boolean {
        return this.phase !== CLOSURE_PHASE.idle;
    }

    /**
     * Whether the barrier stands on the road: placed, and its footprint reaching within
     * CLOSURE.clearM of the road (it is clear once every corner is that far out, on one side).
     */
    blocking(pw: PhysicsWorld, id: number): boolean {
        if (!this.deployed) return false;
        const b = pw.bodies.get(id)?.body;
        if (!b) return false;
        const p = b.translation();
        const q = b.rotation();
        const h = this.spec.barrierHalf;
        const edge = this.spec.roadHalf + CLOSURE.clearM;
        // its footprint across the road (corners on both sides: it spans it)
        let lo = Infinity;
        let hi = -Infinity;
        for (const sx of [-1, 1])
            for (const sz of [-1, 1]) {
                const c = rotate(q, sx * h.x, 0, sz * h.z);
                const a = this.spec.across(p.x + c.x, p.z + c.z);
                lo = Math.min(lo, a);
                hi = Math.max(hi, a);
            }
        return lo < edge && hi > -edge;
    }

    /** One tick; `mayStart` is the director's budget. */
    step(h: RoadClosureHost, mayStart: boolean): void {
        const { physics: pw, entities: e } = h;
        const sp = this.spec;
        const bid = e.barrier.id;
        // the barrier waits out of the world until the closure sets it down
        if (!this.deployed && !this.placedHidden && pw.bodies.has(bid)) {
            pw.setEnabled(bid, false);
            this.placedHidden = true;
        }
        e.barrier.visible = this.deployed;
        // how fast the ute closes on the junction (m/s, along the route), every tick
        const along = h.ute ? sp.along(h.ute.x, h.ute.z) : NaN;
        this.uteClosing = Number.isFinite(along - this.uteAlong) ? (along - this.uteAlong) * 60 : 0;
        this.uteAlong = along;
        // hidden, it keeps the pose it will stand at (out of the world, nothing touches it)
        if (!this.deployed) copyPose(sp.barrier, e.barrier.pose);
        if (this.phase === CLOSURE_PHASE.idle && !this.deployed && mayStart && this.count < CLOSURE.max) {
            const d = this.approaching(h);
            if (d !== null && this.spotClear(h)) {
                pw.place(bid, sp.barrier);
                pw.setEnabled(bid, true);
                this.pin(pw, bid, true);
                this.deployed = true;
                e.barrier.visible = true;
                this.phase = CLOSURE_PHASE.tell;
                this.since = h.tick;
                this.tellDistance = d;
                this.count++;
                h.say(CLOSURE_TELL);
            }
        }
        // a hand on it frees it (a guest's too: the host runs every grab)
        if (this.deployed && this.pinned && pw.holders(bid) > 0) this.pin(pw, bid, false);
        const blocking = this.blocking(pw, bid);
        if (this.phase === CLOSURE_PHASE.tell && h.tick - this.since >= S(CLOSURE.swingS))
            this.phase = CLOSURE_PHASE.active;
        // over once the road is open, or everyone has gone round
        if (this.phase !== CLOSURE_PHASE.idle && (!blocking || this.everyonePast(h))) this.phase = CLOSURE_PHASE.idle;
        // the sign: closed exactly while the barrier stands on the road
        const target = blocking ? 1 : 0;
        if (this.swing > 0.5 && target === 0 && this.swing === 1) h.say(CLOSURE_OPEN);
        // put back across the road (not the closure's own tell, this tick): it says so as it closes
        const told = this.phase === CLOSURE_PHASE.tell && this.since === h.tick;
        if (target === 1 && this.swing === 0 && !told) h.say(CLOSURE_SHUT);
        const k = 1 / S(CLOSURE.swingS);
        this.swing = target > this.swing ? Math.min(target, this.swing + k) : Math.max(target, this.swing - k);
        copyPose(sp.sign, e.sign.pose);
        e.sign.anim[SIGN_SWING] = smooth(this.swing);
        e.sign.visible = true;
    }

    /** How far from the junction the nearest one coming is, when one is within the tell's reach. */
    private approaching(h: RoadClosureHost): number | null {
        const sp = this.spec;
        let best: number | null = null;
        const onRoad = (x: number, z: number) => Math.abs(sp.across(x, z)) <= CLOSURE.corridor;
        const take = (d: number) => {
            if (best === null || d < best) best = d;
        };
        // on foot: in the window, far enough that even at a run the junction is leadS away (one
        // already closer is not surprised late: it has no tell, and no closure)
        const near = CLOSURE.leadS * CLOSURE.runSpeed;
        for (const w of h.walkers) {
            const d = sp.junction - sp.along(w.x, w.z);
            if (onRoad(w.x, w.z) && d >= near && d <= near + CLOSURE.window) take(d);
        }
        // the ute: by the quickest it could get there from here, closing on it as fast as it is
        const along = this.uteAlong;
        const closing = this.uteClosing;
        if (h.ute && closing >= CLOSURE.uteMoving && onRoad(h.ute.x, h.ute.z)) {
            const d = sp.junction - along;
            const t = quickest(d, Math.min(closing, CLOSURE.uteSpeed));
            if (d > 0 && t >= CLOSURE.leadS && t <= CLOSURE.leadS + CLOSURE.uteWindowS) take(d);
        }
        return best;
    }

    /** Nobody (and not the ute) stands where the barrier goes. */
    private spotClear(h: RoadClosureHost): boolean {
        const sp = this.spec;
        const b = sp.barrier.p;
        const q = sp.barrier.q;
        const inv = { x: -q.x, y: -q.y, z: -q.z, w: q.w };
        const near = (x: number, z: number, r: number) => {
            const l = rotate(inv, x - b.x, 0, z - b.z);
            return (
                Math.abs(l.x) < sp.barrierHalf.x + r + CLOSURE.standOff &&
                Math.abs(l.z) < sp.barrierHalf.z + r + CLOSURE.standOff
            );
        };
        if (h.walkers.some((w) => near(w.x, w.z, 0.4))) return false;
        return !(h.ute && near(h.ute.x, h.ute.z, 2));
    }

    /** Every player and the ute are on the road beyond the barrier. */
    private everyonePast(h: RoadClosureHost): boolean {
        const sp = this.spec;
        const past = (x: number, z: number) => sp.along(x, z) >= sp.rejoin;
        const left = (x: number, z: number) => sp.along(x, z) < sp.from;
        // an empty ute does not hold it, wherever it was left: only one with a driver counts
        const ute = h.ute && h.ute.driven !== false ? h.ute : null;
        return h.walkers.every((w) => past(w.x, w.z)) && (!ute || left(ute.x, ute.z) || past(ute.x, ute.z));
    }

    /** Locks (or frees) the barrier's movement: locked, the ute stops against it. */
    private pin(pw: PhysicsWorld, id: number, on: boolean): void {
        const b = pw.bodies.get(id)?.body;
        if (!b) return;
        b.setEnabledTranslations(!on, !on, !on, true);
        b.lockRotations(on, true);
        if (on) {
            b.setLinvel({ x: 0, y: 0, z: 0 }, true);
            b.setAngvel({ x: 0, y: 0, z: 0 }, true);
        }
        this.pinned = on;
    }
}

function copyPose(from: Pose, to: Pose): void {
    to.p.x = from.p.x;
    to.p.y = from.p.y;
    to.p.z = from.p.z;
    to.q.x = from.q.x;
    to.q.y = from.q.y;
    to.q.z = from.q.z;
    to.q.w = from.q.w;
}

const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

function rotate(
    q: { x: number; y: number; z: number; w: number },
    x: number,
    y: number,
    z: number
): { x: number; y: number; z: number } {
    // v' = v + 2w (u x v) + 2 u x (u x v)
    const tx = 2 * (q.y * z - q.z * y);
    const ty = 2 * (q.z * x - q.x * z);
    const tz = 2 * (q.x * y - q.y * x);
    return {
        x: x + q.w * tx + (q.y * tz - q.z * ty),
        y: y + q.w * ty + (q.z * tx - q.x * tz),
        z: z + q.w * tz + (q.x * ty - q.y * tx)
    };
}

/** The least time (s) the ute could take to cover d (m) from speed v: flat out, capped at top speed. */
export function quickest(d: number, v: number): number {
    const a = CLOSURE.uteAccel;
    const top = CLOSURE.uteSpeed;
    const da = (top * top - v * v) / (2 * a);
    if (d <= da) return (-v + Math.sqrt(v * v + 2 * a * d)) / a;
    return (top - v) / a + (d - da) / top;
}
