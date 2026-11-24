/**
 * Floodwater (Epic 8, the rising-river hazard): buoyancy, drag and a downstream current on dynamic
 * bodies below a moving water surface. Each body is sampled at a few points inside its collision
 * shape; every submerged sample is pushed at its own position, so a beam with one end in the water
 * lifts and swings about the other.
 *
 * Only runs while the river is in flood (the normal creek leaves things lying on its bed, as it
 * always has). Engine-free; deterministic (fixed order, fixed step).
 */

import RAPIER from '@dimforge/rapier3d-compat';

import type { Vec3Like } from './grab.ts';
import { GRAVITY, LAYER, groups } from './world.ts';
import type { PhysBody, PhysicsWorld, ShapeSpec } from './world.ts';

/** Water density (kg/m^3). Timber (380-500) floats; the bucket's steel walls are light overall. */
export const WATER_DENSITY = 1000;
/** Drag coefficient on a sample's cross-section. */
const DRAG = 0.6;

export interface WaterArea {
    cx: number;
    cz: number;
    halfX: number;
    halfZ: number;
}

export interface FloodFlow {
    /** Surface height now. */
    y: number;
    /** Current velocity (m/s) at full strength. */
    vx: number;
    vz: number;
    /** 0..1: how much of the flood's force acts (eases in and out with the water). */
    strength: number;
}

interface Samples {
    /** Body-local sample points, xyz. */
    pts: Float32Array;
    /** Volume and edge of one sample's cube. */
    vol: number;
    edge: number;
}

const cache = new WeakMap<PhysBody, Samples>();

/** Sample points inside a shape (body-local), about one per 0.35 m along each axis. */
export function shapeSamples(s: ShapeSpec): Samples {
    let hx: number, hy: number, hz: number;
    let oy = 0;
    let inside: (x: number, y: number, z: number) => boolean = () => true;
    switch (s.type) {
        case 'box':
            hx = s.hx;
            hy = s.hy;
            hz = s.hz;
            break;
        case 'ball':
            hx = hy = hz = s.r;
            inside = (x, y, z) => x * x + y * y + z * z <= s.r * s.r;
            break;
        case 'capsule':
            hx = hz = s.r;
            hy = s.half + s.r;
            oy = s.offsetY ?? 0;
            inside = (x, y, z) => {
                const d = Math.max(0, Math.abs(y) - s.half);
                return x * x + d * d + z * z <= s.r * s.r;
            };
            break;
        case 'cylinder': {
            oy = s.offsetY ?? 0;
            const r = s.r;
            const h = s.half;
            if (s.axis === 'x') {
                hx = h;
                hy = hz = r;
                inside = (_x, y, z) => y * y + z * z <= r * r;
            } else if (s.axis === 'z') {
                hz = h;
                hx = hy = r;
                inside = (x, y) => x * x + y * y <= r * r;
            } else {
                hy = h;
                hx = hz = r;
                inside = (x, _y, z) => x * x + z * z <= r * r;
            }
            break;
        }
    }
    const n = (h: number) => Math.max(1, Math.min(9, Math.round((2 * h) / 0.35)));
    const nx = n(hx);
    const ny = n(hy);
    const nz = n(hz);
    const pts: number[] = [];
    for (let i = 0; i < nx; i++)
        for (let j = 0; j < ny; j++)
            for (let k = 0; k < nz; k++) {
                const x = -hx + ((i + 0.5) * 2 * hx) / nx;
                const y = -hy + ((j + 0.5) * 2 * hy) / ny;
                const z = -hz + ((k + 0.5) * 2 * hz) / nz;
                if (inside(x, y, z)) pts.push(x, y + oy, z);
            }
    const vol = shapeVolume(s) / Math.max(1, pts.length / 3);
    return { pts: new Float32Array(pts), vol, edge: Math.cbrt(vol) };
}

export function shapeVolume(s: ShapeSpec): number {
    switch (s.type) {
        case 'box':
            return 8 * s.hx * s.hy * s.hz;
        case 'ball':
            return (4 / 3) * Math.PI * s.r ** 3;
        case 'capsule':
            return Math.PI * s.r * s.r * 2 * s.half + (4 / 3) * Math.PI * s.r ** 3;
        case 'cylinder':
            return Math.PI * s.r * s.r * 2 * s.half;
    }
}

const _p: Vec3Like = { x: 0, y: 0, z: 0 };

/**
 * Pushes every dynamic body in the water area that dips below the surface: buoyancy, drag
 * against the current, per sample. `floor(x, z)` is the ground height (water only stands where
 * the ground is below the surface). Returns the number of bodies the water touched.
 */
export function applyFlood(
    pw: PhysicsWorld,
    area: WaterArea,
    flow: FloodFlow,
    floor: (x: number, z: number) => number,
    dt: number
): number {
    if (flow.strength <= 0) return 0;
    let touched = 0;
    for (const pb of pw.bodies.values()) {
        if (pb.kind !== 'dynamic' || !pb.enabled || !pb.shape) continue;
        const b = pb.body;
        const t = b.translation();
        // quick reject: the body's centre is far above the water or outside the area
        if (t.y - 3 > flow.y) continue;
        if (Math.abs(t.x - area.cx) > area.halfX + 3 || Math.abs(t.z - area.cz) > area.halfZ + 3) continue;
        let s = cache.get(pb);
        if (!s) {
            s = shapeSamples(pb.shape);
            cache.set(pb, s);
        }
        const q = b.rotation();
        const v = b.linvel();
        const w = b.angvel();
        const half = s.edge / 2;
        const area1 = s.edge * s.edge;
        // explicit drag never reverses a sample's motion within a tick (stable for light bodies)
        const kMax = (0.8 * b.mass()) / Math.max(1, s.pts.length / 3);
        let any = false;
        for (let n = 0; n < s.pts.length; n += 3) {
            rotate(q, s.pts[n], s.pts[n + 1], s.pts[n + 2], _p);
            const rx = _p.x;
            const ry = _p.y;
            const rz = _p.z;
            const px = t.x + rx;
            const py = t.y + ry;
            const pz = t.z + rz;
            if (Math.abs(px - area.cx) > area.halfX || Math.abs(pz - area.cz) > area.halfZ) continue;
            const sub = Math.min(1, (flow.y - (py - half)) / s.edge);
            if (sub <= 0) continue;
            if (floor(px, pz) >= flow.y) continue;
            any = true;
            // point velocity v + w x r, relative to the moving water
            const ux = flow.vx * flow.strength - (v.x + w.y * rz - w.z * ry);
            const uy = -(v.y + w.z * rx - w.x * rz);
            const uz = flow.vz * flow.strength - (v.z + w.x * ry - w.y * rx);
            const u = Math.hypot(ux, uy, uz);
            const k = Math.min(0.5 * WATER_DENSITY * DRAG * area1 * sub * u * dt, kMax);
            const lift = WATER_DENSITY * GRAVITY * s.vol * sub * flow.strength * dt;
            b.applyImpulseAtPoint({ x: k * ux, y: lift + k * uy, z: k * uz }, { x: px, y: py, z: pz }, true);
        }
        if (any) touched++;
    }
    return touched;
}

function rotate(q: { x: number; y: number; z: number; w: number }, x: number, y: number, z: number, out: Vec3Like) {
    const tx = 2 * (q.y * z - q.z * y);
    const ty = 2 * (q.z * x - q.x * z);
    const tz = 2 * (q.x * y - q.y * x);
    out.x = x + q.w * tx + (q.y * tz - q.z * ty);
    out.y = y + q.w * ty + (q.z * tx - q.x * tz);
    out.z = z + q.w * tz + (q.x * ty - q.y * tx);
    return out;
}

/** A player's weight on what they stand on (kg). */
export const PLAYER_MASS = 75;
const FOOTPRINT = [
    [0.15, 0.15],
    [-0.15, 0.15],
    [0.15, -0.15],
    [-0.15, -0.15]
] as const;

/**
 * In a flood, players standing on a floating piece weigh it down: their weight presses the body
 * under their feet (the character controller is kinematic and otherwise presses nothing). Only
 * floating pieces in the flood; if standing weight becomes general physics (Epic 5's bridge
 * loads), this goes. Returns the number of players pressing something.
 */
export function pressStanding(
    pw: PhysicsWorld,
    feet: readonly { x: number; y: number; z: number }[],
    waterY: number,
    dt: number
): number {
    let n = 0;
    const hits: { pb: PhysBody; x: number; y: number; z: number }[] = [];
    for (const f of feet) {
        if (f.y > waterY + 1.5) continue;
        // the weight spreads over what is under the feet's footprint (two beams side by side)
        hits.length = 0;
        for (const [ox, oz] of FOOTPRINT) {
            const x = f.x + ox;
            const z = f.z + oz;
            const hit = pw.world.castRay(
                new RAPIER.Ray({ x, y: f.y + 0.1, z }, { x: 0, y: -1, z: 0 }),
                0.35,
                true,
                RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
                groups(0xffff, LAYER.prop)
            );
            if (!hit) continue;
            const pb = pw.bodyOfCollider(hit.collider.handle);
            if (!pb || pb.kind !== 'dynamic' || !pb.shape || !pb.enabled) continue;
            hits.push({ pb, x, y: f.y + 0.1 - hit.timeOfImpact, z });
        }
        if (!hits.length) continue;
        const share = (PLAYER_MASS * GRAVITY * dt) / hits.length;
        for (const h of hits) h.pb.body.applyImpulseAtPoint({ x: 0, y: -share, z: 0 }, h, true);
        n++;
    }
    return n;
}
