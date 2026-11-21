/**
 * Asset-local analytic source volumes (design doc §5.2).
 *
 * A volume answers one question: which voxel value (material + shade) is at this LOCAL point, or 0
 * when the point is outside. The rasterizer maps world cell centres into local space with the
 * inverse pose and asks the volume. Local coordinates and pivots need not be grid aligned; only
 * the rasterized output is.
 *
 * Material fields are evaluated in local space, so colour variation is anchored to the asset and
 * does not flicker as the object moves (§3.2).
 */

import { GRID_SIZE } from './grid.ts';
import { aabb } from './math.ts';
import type { AABB } from './math.ts';
import { voxel } from './palette.ts';

/** Maps a local point that is inside the volume to a voxel value (> 0). */
export type MaterialField = (x: number, y: number, z: number) => number;

/** Shape description used by the conservative sampler and by the debug reference renderer. */
export type ShapeInfo =
    | { type: 'box'; hx: number; hy: number; hz: number }
    | { type: 'ellipsoid'; rx: number; ry: number; rz: number }
    | { type: 'cylinder'; axis: Axis; radius: number; halfLength: number }
    | { type: 'cone'; radius: number; height: number }
    | { type: 'custom' };

export type Axis = 'x' | 'y' | 'z';

export interface Volume {
    /** Local-space bounds. Every occupied point lies inside. */
    readonly bounds: AABB;
    readonly shape: ShapeInfo;
    /** Voxel value at a local point, or 0 when outside. Must be deterministic and side-effect free. */
    sample(x: number, y: number, z: number): number;
}

// ---------------------------------------------------------------------------------------------
// Deterministic hashing for material fields

/** 32-bit integer hash of three integers. Deterministic across platforms. */
export function hash3(i: number, j: number, k: number, seed = 0): number {
    let h =
        Math.imul(i | 0, 0x8da6b343) ^
        Math.imul(j | 0, 0xd8163841) ^
        Math.imul(k | 0, 0xcb1ab31f) ^
        Math.imul(seed | 0, 0x165667b1);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
    return (h ^ (h >>> 15)) >>> 0;
}

/** Shade 0..3 from a hashed local lattice of the given scale (metres). */
export function latticeShade(x: number, y: number, z: number, scale: number, seed = 0): number {
    return hash3(Math.floor(x / scale), Math.floor(y / scale), Math.floor(z / scale), seed) & 3;
}

/** Uniform material with shade variation on a local lattice. */
export function speckled(material: number, scale = GRID_SIZE, seed = 0): MaterialField {
    return (x, y, z) => voxel(material, latticeShade(x, y, z, scale, seed));
}

/** Uniform material, single shade. */
export function solid(material: number, shade = 0): MaterialField {
    const v = voxel(material, shade);
    return () => v;
}

/** Wood grain: stripes running along one local axis (shade from the two other axes). */
export function grain(material: number, along: Axis, scale = GRID_SIZE, seed = 0): MaterialField {
    if (along === 'x')
        return (_x, y, z) => voxel(material, hash3(Math.floor(y / scale), Math.floor(z / scale), 0, seed) & 3);
    if (along === 'y')
        return (x, _y, z) => voxel(material, hash3(Math.floor(x / scale), Math.floor(z / scale), 1, seed) & 3);
    return (x, y) => voxel(material, hash3(Math.floor(x / scale), Math.floor(y / scale), 2, seed) & 3);
}

// ---------------------------------------------------------------------------------------------
// Primitive volumes

export function box(hx: number, hy: number, hz: number, field: MaterialField): Volume {
    assertPositive(hx, hy, hz);
    return {
        bounds: aabb(-hx, -hy, -hz, hx, hy, hz),
        shape: { type: 'box', hx, hy, hz },
        sample(x, y, z) {
            if (x < -hx || x >= hx || y < -hy || y >= hy || z < -hz || z >= hz) return 0;
            return field(x, y, z);
        }
    };
}

export function ellipsoid(rx: number, ry: number, rz: number, field: MaterialField): Volume {
    assertPositive(rx, ry, rz);
    const ix = 1 / (rx * rx);
    const iy = 1 / (ry * ry);
    const iz = 1 / (rz * rz);
    return {
        bounds: aabb(-rx, -ry, -rz, rx, ry, rz),
        shape: { type: 'ellipsoid', rx, ry, rz },
        sample(x, y, z) {
            if (x * x * ix + y * y * iy + z * z * iz >= 1) return 0;
            return field(x, y, z);
        }
    };
}

/** Solid cylinder centred on the origin along an axis. */
export function cylinder(axis: Axis, radius: number, halfLength: number, field: MaterialField): Volume {
    assertPositive(radius, halfLength, 1);
    const r2 = radius * radius;
    const b =
        axis === 'x'
            ? aabb(-halfLength, -radius, -radius, halfLength, radius, radius)
            : axis === 'y'
              ? aabb(-radius, -halfLength, -radius, radius, halfLength, radius)
              : aabb(-radius, -radius, -halfLength, radius, radius, halfLength);
    return {
        bounds: b,
        shape: { type: 'cylinder', axis, radius, halfLength },
        sample(x, y, z) {
            let a: number;
            let u: number;
            let v: number;
            if (axis === 'x') {
                a = x;
                u = y;
                v = z;
            } else if (axis === 'y') {
                a = y;
                u = x;
                v = z;
            } else {
                a = z;
                u = x;
                v = y;
            }
            if (a < -halfLength || a >= halfLength || u * u + v * v >= r2) return 0;
            return field(x, y, z);
        }
    };
}

/**
 * Open-topped tube along +Y with a closed bottom (a bucket wall). Origin at the bottom centre.
 * Material from `field`; the interior is empty.
 */
export function cup(
    radiusBottom: number,
    radiusTop: number,
    height: number,
    wall: number,
    base: number,
    field: MaterialField
): Volume {
    assertPositive(radiusBottom, height, wall);
    const rMax = Math.max(radiusBottom, radiusTop);
    return {
        bounds: aabb(-rMax, 0, -rMax, rMax, height, rMax),
        shape: { type: 'custom' },
        sample(x, y, z) {
            if (y < 0 || y >= height) return 0;
            const t = y / height;
            const r = radiusBottom + (radiusTop - radiusBottom) * t;
            const d2 = x * x + z * z;
            if (d2 >= r * r) return 0;
            const ri = r - wall;
            if (y >= base && d2 < ri * ri) return 0;
            return field(x, y, z);
        }
    };
}

/** Solid cone along +Y: base radius at y = 0, apex at y = height. */
export function cone(radius: number, height: number, field: MaterialField): Volume {
    assertPositive(radius, height, 1);
    return {
        bounds: aabb(-radius, 0, -radius, radius, height, radius),
        shape: { type: 'cone', radius, height },
        sample(x, y, z) {
            if (y < 0 || y >= height) return 0;
            const r = radius * (1 - y / height);
            if (x * x + z * z >= r * r) return 0;
            return field(x, y, z);
        }
    };
}

/** Arbitrary implicit volume: `inside` decides occupancy, `field` the material. */
export function implicit(
    bounds: AABB,
    inside: (x: number, y: number, z: number) => boolean,
    field: MaterialField
): Volume {
    return {
        bounds,
        shape: { type: 'custom' },
        sample(x, y, z) {
            if (
                x < bounds.minX ||
                x >= bounds.maxX ||
                y < bounds.minY ||
                y >= bounds.maxY ||
                z < bounds.minZ ||
                z >= bounds.maxZ
            )
                return 0;
            return inside(x, y, z) ? field(x, y, z) : 0;
        }
    };
}

function assertPositive(a: number, b: number, c: number): void {
    if (!(a > 0 && b > 0 && c > 0) || !Number.isFinite(a + b + c)) {
        throw new Error(`Volume dimensions must be positive and finite, got ${a}, ${b}, ${c}`);
    }
}
