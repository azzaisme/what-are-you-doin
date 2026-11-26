/**
 * The hand winch (Epic 5, #52: a solo aid): a drum on a post staked into the yard, by the
 * sawmill's infeed, with a rope (src/sim/joints/rope.ts) to haul what one beaver cannot lift.
 *
 * - At the winch, with empty hands, grab: you take the rope's hook and walk it out (it pays out
 *   behind you, up to WINCH.maxLength).
 * - Carrying the hook, grab a piece (a log, a beam, a plank): the hook goes into it where you look.
 * - At the winch again, grab: you crank (grab again, or walk away, to stop). Cranking winds the
 *   rope in at WINCH.windSpeed. Its ratchet holds what it has wound. The gearing gives the crank's
 *   hand WINCH.gearing times its grip (GRAB.maxForce) on the rope: past that pull, winding stalls
 *   and the ratchet only clicks. The rope's own strength (ROPE.strength) is above it, so cranking
 *   alone never snaps the rope.
 * - At the winch, drop (Q): the ratchet's pawl is lifted and the hook comes back to the drum.
 *
 * The winch is scenery (its post and drum are static pieces of the level): it costs the snapshot
 * nothing. The rope is display data on the wire, sent when it changes (like the nails).
 * Deterministic, fixed ticks, host only.
 */

import type { Vec3 } from '../voxels/math.ts';

import { SIM_DT } from './clock.ts';
import { GROUND } from './joints/graph.ts';
import { ROPE } from './joints/rope.ts';
import type { RopeSystem } from './joints/rope.ts';
import { GRAB, viewDir } from './physics/grab.ts';
import type { PhysicsWorld } from './physics/world.ts';

export interface WinchSpot {
    x: number;
    z: number;
    /** Ground height at the post (m). */
    y: number;
    /** The crank's side: the winch faces this way (rad, like a player's yaw). */
    yaw: number;
}

export const WINCH = {
    /** The drum's height above the ground (m). */
    drumHeight: 0.55,
    /** How close (eye to drum) a beaver must be to take the hook or crank (m). */
    reach: 1.8,
    /** ...and how near the view must pass the drum (m). */
    aim: 0.4,
    /** Cranked, the rope winds in this fast (m/s). */
    windSpeed: 0.25,
    /**
     * Mechanical advantage of crank and gears over the drum: a hand on the crank pulls the rope
     * with this many times its grip. 6 x 650 N = 3.9 kN, under the rope's 10 kN.
     */
    gearing: 6,
    /** Rope on the drum (m): the hook goes no further. */
    maxLength: 25,
    /** Slack left when the hook goes in (m): hooking does not jerk the piece. */
    slack: 0.2,
    /** A stalled ratchet clicks this often (ticks). */
    clickTicks: 20
} as const;

/** The most the winch pulls the rope with (N). */
export const WINCH_PULL = WINCH.gearing * GRAB.maxForce;

export type WinchEventKind = 'take' | 'hook' | 'crank' | 'stop' | 'click' | 'release' | 'drop';

export interface WinchEvent {
    kind: WinchEventKind;
    player: number;
}

/** What the rope is doing, for drawing it (here and on guests). */
export interface WinchRopeView {
    /** The drum (world). */
    from: Vec3;
    /** Hooked into body `body` at `local` (its frame); -1: in a player's hand (`player`), or on the drum. */
    body: number;
    local: Vec3;
    player: number;
}

export class Winch {
    readonly spot: WinchSpot;
    private readonly pw: PhysicsWorld;
    private readonly ropes: RopeSystem;
    /** The rope, when hooked into a piece (-1: on the drum, or in a hand). */
    private ropeId = -1;
    /** The player carrying the hook (-1: nobody). */
    private carrier = -1;
    /** The player cranking (-1: nobody). */
    private cranker = -1;
    private stalled = 0;
    /** What the hook may go into (the bucket is not: it crosses only over what is built, #132). */
    private readonly hookable: (id: number) => boolean;

    constructor(pw: PhysicsWorld, ropes: RopeSystem, spot: WinchSpot, hookable: (id: number) => boolean = () => true) {
        this.pw = pw;
        this.ropes = ropes;
        this.spot = spot;
        this.hookable = hookable;
    }

    /** The drum's centre (world): where the rope leaves the winch. */
    get drum(): Vec3 {
        return { x: this.spot.x, y: this.spot.y + WINCH.drumHeight, z: this.spot.z };
    }

    get hooked(): number {
        const r = this.ropeId >= 0 ? this.ropes.get(this.ropeId) : undefined;
        return r ? r.a : -1;
    }

    get cranking(): number {
        return this.cranker;
    }

    get carrying(): number {
        return this.carrier;
    }

    /** The rope's tension now (N; 0 when slack or not hooked). */
    get tension(): number {
        return this.ropeId >= 0 ? this.ropes.tension(this.ropeId) : 0;
    }

    /** Its unstretched length now (m; 0 when not hooked). */
    get length(): number {
        return this.ropeId >= 0 ? (this.ropes.get(this.ropeId)?.length ?? 0) : 0;
    }

    /** Is a player's view on the winch (close enough, aimed at the drum)? */
    looksAt(eye: Vec3, yaw: number, pitch: number): boolean {
        const d = this.drum;
        const dx = d.x - eye.x;
        const dy = d.y - eye.y;
        const dz = d.z - eye.z;
        const dist = Math.hypot(dx, dy, dz);
        if (dist > WINCH.reach) return false;
        const v = viewDir(yaw, pitch, { x: 0, y: 0, z: 0 });
        const along = dx * v.x + dy * v.y + dz * v.z;
        if (along <= 0) return false;
        const off = Math.hypot(dx - v.x * along, dy - v.y * along, dz - v.z * along);
        return off <= WINCH.aim;
    }

    /**
     * A grab by player `i` (hands empty unless `held` >= 0). Returns whether the winch took it
     * (otherwise it goes on to the rest of the grab: picking things up, the sawmill, the ute...).
     */
    grab(i: number, eye: Vec3, yaw: number, pitch: number, held: number, out: WinchEvent[]): boolean {
        // carrying the hook: it goes into the piece you look at
        if (this.carrier === i) {
            const hit = this.pw.viewHit(eye, yaw, pitch, i);
            if (!hit || !this.hookable(hit.pb.id)) return true; // (nothing it can go into: you keep the hook)
            const b = hit.pb.body;
            const t = b.translation();
            const q = b.rotation();
            const local = inverseRotate(q, hit.point.x - t.x, hit.point.y - t.y, hit.point.z - t.z);
            const d = this.drum;
            const span = Math.hypot(hit.point.x - d.x, hit.point.y - d.y, hit.point.z - d.z);
            const id = this.ropes.tie(hit.pb.id, local, GROUND, d, span + WINCH.slack);
            if (id < 0) return true;
            this.ropeId = id;
            this.carrier = -1;
            out.push({ kind: 'hook', player: i });
            return true;
        }
        if (!this.looksAt(eye, yaw, pitch) || held >= 0) return false;
        if (this.cranker === i) {
            this.cranker = -1;
            out.push({ kind: 'stop', player: i });
        } else if (this.ropeId >= 0 && this.ropes.get(this.ropeId)) {
            if (this.cranker >= 0) return true; // (someone else is cranking)
            this.cranker = i;
            this.stalled = 0;
            out.push({ kind: 'crank', player: i });
        } else if (this.carrier < 0) {
            this.ropeId = -1;
            this.carrier = i;
            out.push({ kind: 'take', player: i });
        }
        return true;
    }

    /** A drop (Q) by player `i` at the winch: lifts the pawl, the hook comes back to the drum. */
    drop(i: number, eye: Vec3, yaw: number, pitch: number, out: WinchEvent[]): boolean {
        if (this.carrier === i) {
            this.carrier = -1;
            out.push({ kind: 'drop', player: i });
            return true;
        }
        if (!this.looksAt(eye, yaw, pitch) || this.ropeId < 0) return false;
        this.ropes.cut(this.ropeId);
        this.ropeId = -1;
        this.cranker = -1;
        out.push({ kind: 'release', player: i });
        return true;
    }

    /**
     * Each tick, after the players' commands: winds the rope in while someone cranks at the winch,
     * stalls (with a click) past the gearing's pull, and drops the hook if its carrier walks off
     * further than the rope reaches. `where(i)` is player i's eye (null: not playing).
     */
    step(where: (i: number) => Vec3 | null, out: WinchEvent[]): void {
        if (this.ropeId >= 0 && !this.ropes.get(this.ropeId)) {
            // snapped, or its piece is gone: the drum keeps what is left
            this.ropeId = -1;
            this.cranker = -1;
        }
        if (this.carrier >= 0) {
            const e = where(this.carrier);
            const d = this.drum;
            if (!e || Math.hypot(e.x - d.x, e.z - d.z) > WINCH.maxLength) {
                out.push({ kind: 'drop', player: this.carrier });
                this.carrier = -1;
            }
        }
        if (this.cranker < 0 || this.ropeId < 0) return;
        const e = where(this.cranker);
        const d = this.drum;
        if (!e || Math.hypot(e.x - d.x, e.y - d.y, e.z - d.z) > WINCH.reach) {
            out.push({ kind: 'stop', player: this.cranker });
            this.cranker = -1;
            return;
        }
        if (this.ropes.tension(this.ropeId) >= WINCH_PULL) {
            // the ratchet holds; the crank goes no further
            if (this.stalled++ % WINCH.clickTicks === 0) out.push({ kind: 'click', player: this.cranker });
            return;
        }
        this.stalled = 0;
        const r = this.ropes.get(this.ropeId)!;
        this.ropes.setLength(this.ropeId, r.length - WINCH.windSpeed * SIM_DT);
    }

    /** The rope as it is now, for drawing it; null: wound on the drum. */
    view(): WinchRopeView | null {
        const r = this.ropeId >= 0 ? this.ropes.get(this.ropeId) : undefined;
        if (r) return { from: this.drum, body: r.a, local: { ...r.la }, player: -1 };
        if (this.carrier >= 0) return { from: this.drum, body: -1, local: { x: 0, y: 0, z: 0 }, player: this.carrier };
        return null;
    }

    /** Lets go of everything (a level reset). */
    reset(): void {
        if (this.ropeId >= 0) this.ropes.cut(this.ropeId);
        this.ropeId = -1;
        this.carrier = -1;
        this.cranker = -1;
    }
}

/**
 * The rope on the wire (and for the host's own drawing), by entity index: [] wound on the drum;
 * [1, slot] the hook in that player's hand; [2, index, x, y, z] hooked into entity `index` at a
 * point of its frame (cm). Sent only when it changes (the presence keeps the last value).
 */
export function encodeWinchRope(v: WinchRopeView | null, indexOf: (id: number) => number): number[] {
    if (!v) return [];
    if (v.body < 0) return [1, v.player];
    const k = indexOf(v.body);
    if (k < 0) return [];
    const cm = (x: number) => Math.round(x * 100);
    return [2, k, cm(v.local.x), cm(v.local.y), cm(v.local.z)];
}

export type WinchRopeEnd = { hand: number } | { index: number; local: Vec3 };

/** A rope off the wire, checked (null: on the drum, or not a rope). */
export function decodeWinchRope(a: unknown, entityCount: number, players: number): WinchRopeEnd | null {
    if (!Array.isArray(a) || !a.every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
    const n = a as number[];
    if (n[0] === 1 && n.length === 2 && Number.isInteger(n[1]) && n[1] >= 0 && n[1] < players) return { hand: n[1] };
    if (n[0] === 2 && n.length === 5 && Number.isInteger(n[1]) && n[1] >= 0 && n[1] < entityCount) {
        const ok = n.slice(2).every((c) => Math.abs(c) <= 1000);
        if (ok) return { index: n[1], local: { x: n[2] / 100, y: n[3] / 100, z: n[4] / 100 } };
    }
    return null;
}

/** v by the inverse of q. */
function inverseRotate(q: { x: number; y: number; z: number; w: number }, x: number, y: number, z: number): Vec3 {
    const qx = -q.x;
    const qy = -q.y;
    const qz = -q.z;
    const cx = qy * z - qz * y;
    const cy = qz * x - qx * z;
    const cz = qx * y - qy * x;
    return {
        x: x + 2 * (q.w * cx + (qy * cz - qz * cy)),
        y: y + 2 * (q.w * cy + (qz * cx - qx * cz)),
        z: z + 2 * (q.w * cz + (qx * cy - qy * cx))
    };
}

/** (ROPE is re-exported for the winch's tests: its strength is above the winch's pull.) */
export { ROPE };
