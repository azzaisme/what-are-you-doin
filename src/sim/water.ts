/**
 * The bucket's water (design doc §2.8, Epic 7): a volume in litres and a slosh state, integrated at
 * the fixed step. No per-voxel fluid: the surface is one plane, tilted by a damped oscillator that the
 * water's apparent gravity (gravity minus the bucket's acceleration) drives, and water leaves over the
 * rim when the tilted plane holds less than the bucket has.
 *
 * - The slosh state is the surface's tilt in WORLD terms (how far its normal leans towards world x
 *   and z, as the sine of the lean: bounded, and smooth even for a bucket swung far out), so turning
 *   the bucket slowly does not excite it, and the surface stays level while you tip a still bucket.
 *   Shaking, swinging, braking and impacts accelerate the water and set it rocking.
 * - What the bucket can hold at a moment comes from that surface seen in the bucket's own frame
 *   (`fit`): tip it, or let the water rock high enough, and the excess spills at the low point of
 *   the rim (`lip`).
 *
 * Pure math, no Rapier or engine types: the simulation passes in the bucket's orientation and the
 * velocity of the water's centre each tick. Every output is finite and the volume stays inside
 * [0, capacity] whatever comes in.
 */

import { BUCKET_CAPACITY } from '../assets/props.ts';
import { quatRotate } from '../voxels/math.ts';
import type { Quat, Vec3 } from '../voxels/math.ts';

import { SIM_DT } from './clock.ts';

/** Tuning. Lengths in metres (bucket-local, origin at the bottom centre), volumes in litres. */
export const WATER = {
    /** A full bucket (design doc §2.8: 10 L proposed). Leaves ~9 cm to the rim. */
    capacity: BUCKET_CAPACITY,
    /** Mean inner radius of the tapered bucket (0.115 m at the floor, 0.145 m at the rim). */
    radius: 0.13,
    /** Inside floor height. */
    floor: 0.02,
    /** Rim height. */
    rim: 0.3,
    /** Slosh damping ratio: real water in a bucket is near 0.02; tuned up (playtest, design doc §2.8) so a swinging carry does not build up waves and the water settles within half a second. */
    damping: 0.4,
    /** The excess over what the tilted bucket holds leaves with this time constant (s). */
    spillTau: 0.1,
    /** ...and at least this much per second while there is any (so a spill always finishes). */
    minSpillRate: 0.3,
    /** The water takes up the bucket's spin about its axis with this time constant (s). */
    spinUp: 2,
    /** Surface slopes are kept within this (beyond ~80 degrees it makes no difference). */
    maxSlope: 6,
    /** Accelerations beyond this (m/s^2, a one-tick contact spike) are clipped before they drive the slosh. */
    maxAccel: 120,
    /** Apparent gravity below this (m/s^2: thrown, falling) leaves the water rocking freely. */
    freeFall: 2.5,
    /**
     * Impacts: a change of velocity in one tick beyond `splashFrom` (m/s: a 45 cm drop) throws
     * water out, `splashPer` of a full bucket per m/s beyond it (fuller buckets splash more, as the
     * square of how full they are), up to `splashMax` of what is in it.
     */
    splashFrom: 3,
    splashPer: 1 / 16,
    splashMax: 0.5,
    /** Filling from a tap or spring (L/s). */
    fillRate: 4,
    /** The flower needs at least this much poured into it (issue #64: ~0.25 L, tune after tests). */
    minDelivery: 0.25,
    /** Litres (= kg) the bucket's mass may lag the water before it is updated (design doc §2.8). */
    massStep: 0.5
} as const;

const GRAVITY = 9.81;
/** Litres per metre of depth (area x 1000). */
export const LITRES_PER_M = Math.PI * WATER.radius * WATER.radius * 1000;
/** Inside depth floor to rim (m). */
const DEPTH = WATER.rim - WATER.floor;

/** Litres the bucket holds with its surface rising `rise` metres from the middle to the wall. */
export function fitLitres(rise: number): number {
    const t = Math.max(0, Number.isFinite(rise) ? rise : Infinity);
    // the plane through the axis keeps the cylinder's volume until its low side reaches the floor;
    // past that the water is a wedge that shrinks as 1 / rise (continuous at rise = depth / 2)
    const f = t <= DEPTH / 2 ? 1 - t / DEPTH : DEPTH / (4 * t);
    return LITRES_PER_M * DEPTH * f;
}

/** Height of the mean water surface above the bucket's origin for a volume. */
export function surfaceHeight(litres: number): number {
    return WATER.floor + Math.max(0, litres) / LITRES_PER_M;
}

/** Undamped first slosh mode of a cylinder of water (rad/s): w^2 = g k / R tanh(k h / R), k = 1.841. */
export function sloshOmega(litres: number): number {
    const k = 1.841 / WATER.radius;
    const h = Math.max(0.02, Math.max(0, litres) / LITRES_PER_M);
    return Math.sqrt(GRAVITY * k * Math.tanh(k * h));
}

export interface WaterInput {
    /** The bucket's orientation (world from local). */
    q: Quat;
    /** World velocity of the bucket at its water's centre (m/s). */
    v: Vec3;
    /** World angular velocity (rad/s). */
    w: Vec3;
}

export class BucketWater {
    /** Litres in the bucket, in [0, capacity]. */
    volume: number;
    /**
     * The surface's lean from world level: its unit normal is (-sx, sqrt(1 - sx^2 - sz^2), -sz), so
     * (sx, sz) is the sine of the lean towards +x / +z (where the surface rises). And its rate.
     */
    sx = 0;
    sz = 0;
    vx = 0;
    vz = 0;
    /** How fast the water turns about the bucket's axis (rad/s): it lags the bucket's own spin. */
    spin = 0;
    /** The surface's slope in the bucket's own frame (visuals, spilling), and whether it is upside down. */
    readonly local = { x: 0, z: 0, inverted: false };
    /** Where the last spill left the rim, bucket-local. */
    readonly lip: Vec3 = { x: WATER.radius, y: WATER.rim, z: 0 };
    /** Litres spilled over the rim on the last step. */
    spilled = 0;
    private readonly prevV = { x: 0, y: 0, z: 0 };
    private hasPrev = false;

    constructor(volume: number = WATER.capacity) {
        this.volume = clampVolume(volume);
    }

    /** Sets the volume (spare buckets, tests) and calms the surface. */
    reset(volume: number): void {
        this.volume = clampVolume(volume);
        this.sx = this.sz = this.vx = this.vz = this.spin = 0;
        this.hasPrev = false;
        this.spilled = 0;
    }

    /** Forgets the last velocity (the bucket was teleported: no acceleration spike from it). */
    teleported(): void {
        this.hasPrev = false;
    }

    /** Adds water (a refill), up to capacity; returns the litres taken. */
    add(litres: number): number {
        const want = Math.max(0, Math.min(Number.isFinite(litres) ? litres : 0, WATER.capacity - this.volume));
        this.volume = clampVolume(this.volume + want);
        return want;
    }

    /** One fixed step. Returns the litres spilled over the rim (also in `spilled`). */
    step(input: WaterInput, dt: number = SIM_DT): number {
        const v = input.v;
        // apparent gravity: gravity minus the water's acceleration
        let ax = 0;
        let ay = 0;
        let az = 0;
        let jolt = 0;
        if (this.hasPrev && finite3(v)) {
            ax = (v.x - this.prevV.x) / dt;
            ay = (v.y - this.prevV.y) / dt;
            az = (v.z - this.prevV.z) / dt;
            const a = Math.hypot(ax, ay, az);
            jolt = a * dt;
            if (a > WATER.maxAccel) {
                const k = WATER.maxAccel / a;
                ax *= k;
                ay *= k;
                az *= k;
            }
        }
        if (finite3(v)) {
            this.prevV.x = v.x;
            this.prevV.y = v.y;
            this.prevV.z = v.z;
            this.hasPrev = true;
        }
        const gx = -ax;
        const gy = -GRAVITY - ay;
        const gz = -az;
        const w0 = sloshOmega(this.volume);
        const g = Math.hypot(gx, gy, gz);
        // the level the surface would settle at under this apparent gravity (world slope); thrown or
        // falling (no apparent gravity) or "gravity" pointing up, the water just keeps rocking
        let fx = 0;
        let fz = 0;
        if (g > WATER.freeFall && gy < -0.2 * g) {
            const ex = gx / g;
            const ez = gz / g;
            fx = w0 * w0 * (ex - this.sx);
            fz = w0 * w0 * (ez - this.sz);
        }
        const c = 2 * WATER.damping * w0;
        this.vx += (fx - c * this.vx) * dt;
        this.vz += (fz - c * this.vz) * dt;
        this.sx += this.vx * dt;
        this.sz += this.vz * dt;
        const lean = Math.hypot(this.sx, this.sz);
        if (lean > MAX_LEAN) {
            this.sx *= MAX_LEAN / lean;
            this.sz *= MAX_LEAN / lean;
        }
        if (!Number.isFinite(this.sx + this.sz + this.vx + this.vz)) this.sx = this.sz = this.vx = this.vz = 0;
        const ny = Math.sqrt(Math.max(0, 1 - this.sx * this.sx - this.sz * this.sz));

        // the surface in the bucket's frame: its normal turned into local coordinates
        const q = input.q;
        const qn = Math.hypot(q.x, q.y, q.z, q.w) || 1;
        _conj.x = -q.x / qn;
        _conj.y = -q.y / qn;
        _conj.z = -q.z / qn;
        _conj.w = q.w / qn;
        quatRotate(_conj, -this.sx, ny, -this.sz, _n);
        const loc = this.local;
        loc.inverted = _n.y <= 0.02 * Math.hypot(_n.x, _n.y, _n.z);
        loc.x = loc.inverted ? 0 : clampSlope(-_n.x / _n.y);
        loc.z = loc.inverted ? 0 : clampSlope(-_n.z / _n.y);
        if (!Number.isFinite(loc.x + loc.z)) loc.x = loc.z = 0;
        // spun about its own axis, the water slowly picks up the spin (Newton's bucket), and its
        // surface dishes, climbing the wall by w^2 R^2 / 4g
        const w = input.w;
        quatRotate(_conj, finite(w.x), finite(w.y), finite(w.z), _wl);
        const wy = Math.max(-60, Math.min(60, _wl.y));
        this.spin += (wy - this.spin) * (1 - Math.exp(-dt / WATER.spinUp));
        if (!Number.isFinite(this.spin)) this.spin = 0;
        const spinRise = Math.min(0.2, (this.spin * this.spin * WATER.radius * WATER.radius) / (4 * GRAVITY));
        const slope = Math.hypot(loc.x, loc.z);
        const holds = loc.inverted ? 0 : fitLitres(WATER.radius * slope + spinRise);
        // the low point of the rim: where the surface climbs highest
        if (slope > 1e-6) {
            this.lip.x = (WATER.radius * loc.x) / slope;
            this.lip.z = (WATER.radius * loc.z) / slope;
        } else if (loc.inverted) {
            this.lip.x = this.lip.z = 0;
        }
        this.lip.y = loc.inverted ? 0.6 * WATER.rim : WATER.rim;
        let out = 0;
        const excess = this.volume - holds;
        if (excess > 0) {
            out = Math.min(excess, Math.max(excess * (1 - Math.exp(-dt / WATER.spillTau)), WATER.minSpillRate * dt));
            this.volume = clampVolume(this.volume - out);
        }
        // an impact throws some out over the rim, whichever way it comes
        if (jolt > WATER.splashFrom && this.volume > 0) {
            const full = this.volume / WATER.capacity;
            const frac = Math.min(WATER.splashMax, (jolt - WATER.splashFrom) * WATER.splashPer) * full * full;
            const splash = this.volume * frac;
            this.volume = clampVolume(this.volume - splash);
            out += splash;
        }
        this.spilled = out;
        return out;
    }
}

function clampVolume(v: number): number {
    return Number.isFinite(v) ? Math.max(0, Math.min(WATER.capacity, v)) : 0;
}
/** The surface never leans past ~84 degrees from level. */
const MAX_LEAN = 0.995;
function clampSlope(s: number): number {
    return Number.isFinite(s) ? Math.max(-WATER.maxSlope, Math.min(WATER.maxSlope, s)) : 0;
}
const finite = (v: number) => (Number.isFinite(v) ? v : 0);
const finite3 = (v: Vec3) => Number.isFinite(v.x + v.y + v.z);

const _conj: Quat = { x: 0, y: 0, z: 0, w: 1 };
const _n = { x: 0, y: 0, z: 0 };
const _wl = { x: 0, y: 0, z: 0 };
