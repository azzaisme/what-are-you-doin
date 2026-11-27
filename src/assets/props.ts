/**
 * Single-part and simple multi-part props: timber plank, log, bucket, test cube and sphere.
 * Sizes are multiples of 0.1 m where the design doc proposes them (§2.5).
 */

import { GRID_SIZE } from '../voxels/grid.ts';
import { aabb, composePose, copyPose, pose, quatFromYawPitchRoll } from '../voxels/math.ts';
import type { Pose } from '../voxels/math.ts';
import { M, voxel } from '../voxels/palette.ts';
import { box, cup, ellipsoid, grain, implicit, latticeShade, solid } from '../voxels/volumes.ts';
import type { Volume } from '../voxels/volumes.ts';

import { ASSET_SCHEMA_VERSION } from './asset.ts';
import type { AssetPart, VoxelAsset } from './asset.ts';

/** Asset whose parts all share the root pose, optionally with fixed local offsets. */
function rigid(name: string, parts: AssetPart[], offsets?: Pose[]): VoxelAsset {
    const local = offsets ?? parts.map(() => pose());
    return {
        schema: ASSET_SCHEMA_VERSION,
        name,
        parts,
        animChannels: 0,
        evaluate(root: Pose, _anim: ArrayLike<number>, out: Pose[]) {
            for (let i = 0; i < parts.length; i++) composePose(root, local[i], out[i]);
        }
    };
}

/** 2.4 x 0.2 x 0.1 m plank, long axis X, grain along X, lighter end grain. */
export const PLANK_LENGTH = 2.4;
/** The plank's half extents (m): the asset, its collider and everything that fits planks use these. */
export const PLANK_HALF = { x: PLANK_LENGTH / 2, y: 0.1, z: 0.05 } as const;
/**
 * The tutorial's long plank (entity `long-plank`, placed only by the tutorial): the same section and
 * wood, LONG_PLANK_LENGTH long, so one plank laid from the bank clears the tutorial's ditch (2.3 m
 * between the banks' lips) with 0.4 m or more on each bank. Everywhere else planks stay 2.4 m.
 */
export const LONG_PLANK_LENGTH = 3.8;
export const LONG_PLANK_HALF = { x: LONG_PLANK_LENGTH / 2, y: PLANK_HALF.y, z: PLANK_HALF.z } as const;
/** Half extents of a plank entity by name (the long plank or a standard one). */
export function plankHalfOf(name: string): { x: number; y: number; z: number } {
    return name === 'long-plank' ? LONG_PLANK_HALF : PLANK_HALF;
}
export function plankAsset(name = 'plank', length = PLANK_LENGTH): VoxelAsset {
    const hx = length / 2;
    const g = grain(M.Timber, 'x', 0.1, 5);
    const v = box(hx, PLANK_HALF.y, PLANK_HALF.z, (x, y, z) =>
        Math.abs(x) > hx - 0.08 ? voxel(M.TimberEnd, latticeShade(x, y, z, 0.1, 2)) : g(x, y, z)
    );
    return rigid(name, [{ name: 'plank', volume: v, priority: 1, refColor: 0xc48d55 }]);
}

/** 3.2 x 0.2 x 0.15 m beam (long enough to span the timber yard's 2.7 m creek gap), long axis X. */
export const BEAM_HALF = { x: 1.6, y: 0.1, z: 0.075 };
export function beamAsset(name = 'beam'): VoxelAsset {
    const g = grain(M.Timber, 'x', 0.15, 11);
    const v = box(BEAM_HALF.x, BEAM_HALF.y, BEAM_HALF.z, (x, y, z) =>
        Math.abs(x) > BEAM_HALF.x - 0.07 ? voxel(M.TimberEnd, latticeShade(x, y, z, 0.1, 3)) : g(x, y, z)
    );
    return rigid(name, [{ name: 'beam', volume: v, priority: 1, refColor: 0xa8743f }]);
}

/** Log: radius 0.2 m, length 2.0 m, long axis X. Bark with ring end grain. */
export const LOG_RADIUS = 0.2;
export function logAsset(): VoxelAsset {
    const v = implicit(
        aabb(-1.0, -LOG_RADIUS, -LOG_RADIUS, 1.0, LOG_RADIUS, LOG_RADIUS),
        (_x, y, z) => y * y + z * z < LOG_RADIUS * LOG_RADIUS,
        (x, y, z) => {
            const r = Math.hypot(y, z);
            if (Math.abs(x) > 0.92) return voxel(M.LogEnd, Math.floor(r / 0.06) & 1 ? 1 : 2);
            if (r < LOG_RADIUS - 0.07) return voxel(M.TimberEnd);
            return voxel(M.LogBark, latticeShade(x, Math.atan2(z, y), 0, 0.25, 8));
        }
    );
    return rigid('log', [{ name: 'log', volume: v, priority: 1, refColor: 0x6b4a30 }]);
}

/** Bucket: ~0.32 m diameter, 0.3 m tall (about 10 L), origin at the bottom centre, with a handle arc. */
export const BUCKET_HEIGHT = 0.3;
export const BUCKET_HANDLE_TOP = 0.46;
export const BUCKET_INNER_RADIUS = 0.08;
export function bucketAsset(): VoxelAsset {
    // The wall and handle are drawn as thick as the lattice needs to show them: on the 1 cm lattice
    // (per-item cell sizes, src/assets/cell-tier.ts) they are real thicknesses, on 5-10 cm cells
    // they are exaggerated so the bucket still reads as a bucket.
    const fine = GRID_SIZE < 0.03;
    const wallT = fine ? 0.015 : 0.08;
    const baseT = fine ? 0.02 : 0.08;
    const wall = cup(0.13, 0.16, BUCKET_HEIGHT, wallT, baseT, (x, y, z) =>
        voxel(M.Galvanised, y > BUCKET_HEIGHT - (fine ? 0.02 : 0.0) ? 2 : latticeShade(x, y, z, fine ? 0.04 : 0.1, 6))
    );
    // the handle: an arc over the top, along X
    const [hIn, hOut, hHalf] = fine ? [0.155, 0.17, 0.008] : [0.12, 0.18, 0.05];
    const handle = implicit(
        aabb(-0.18, BUCKET_HEIGHT - 0.05, -hHalf, 0.18, BUCKET_HANDLE_TOP + 0.02, hHalf),
        (x, y) => {
            const cy = BUCKET_HEIGHT - 0.04;
            const r = Math.hypot(x, y - cy);
            return y >= cy && r > hIn && r < hOut;
        },
        solid(M.Steel)
    );
    // the water inside (Epic 7): fills the hollow up to the surface the simulation gives it (litres
    // and the surface's slope in the bucket's frame, animation channels BUCKET_LITRES.. below). On
    // coarse cells it also reaches into the wall a little, so it shows as a blue disc in the narrow
    // opening. The surface is set by evaluate() just before each rasterization of this asset.
    const inner = (y: number) => 0.13 + 0.03 * (y / BUCKET_HEIGHT) - wallT;
    const surface = { h: 0, sx: 0, sz: 0 };
    const top = BUCKET_HEIGHT - 0.005;
    const shade = (x: number, y: number, z: number) =>
        voxel(M.BucketWater, latticeShade(x, y, z, fine ? 0.03 : 0.1, 4));
    const water: Volume = {
        bounds: aabb(-0.16, baseT, -0.16, 0.16, top, 0.16),
        shape: { type: 'custom' },
        sample(x, y, z) {
            if (y < baseT || y > top) return 0;
            if (y > surface.h + surface.sx * x + surface.sz * z) return 0;
            return Math.hypot(x, z) < inner(y) + (fine ? 0 : 0.02) ? shade(x, y, z) : 0;
        }
    };
    const full = new Float64Array(BUCKET_ANIM_CHANNELS);
    full[BUCKET_LITRES] = BUCKET_CAPACITY;
    const parts: AssetPart[] = [
        { name: 'bucket', volume: wall, priority: 2, refColor: 0xa9b0b4 },
        { name: 'water', volume: water, priority: 3, policy: fine ? 'coverage50' : 'conservative', refColor: 0x3a9ee0 },
        { name: 'handle', volume: handle, priority: 3, policy: 'conservative', refColor: 0x9aa0a6 }
    ];
    return {
        schema: ASSET_SCHEMA_VERSION,
        name: 'bucket',
        parts,
        animChannels: BUCKET_ANIM_CHANNELS,
        evaluate(root: Pose, anim: ArrayLike<number>, out: Pose[]) {
            surface.h = bucketWaterLevel(anim);
            surface.sx = clampSlope(anim[BUCKET_SLOPE_X]);
            surface.sz = clampSlope(anim[BUCKET_SLOPE_Z]);
            for (let i = 0; i < parts.length; i++) copyPose(root, out[i]);
        },
        partHidden(anim: ArrayLike<number>, part: number) {
            return part === 1 && !((anim[BUCKET_LITRES] || 0) > 0.02);
        },
        // the water is the one part evaluate() reshapes: its surface rises with the litres
        partFill: { part: 1, full, floor: baseT, level: bucketWaterLevel }
    };
}

/** The bucket water's surface height at the middle (m above the bucket's bottom) for its litres. */
function bucketWaterLevel(anim: ArrayLike<number>): number {
    return BUCKET_FLOOR + Math.max(0, Math.min(BUCKET_CAPACITY, anim[BUCKET_LITRES] || 0)) / BUCKET_LITRES_PER_M;
}

/** Bucket animation channels: litres of water, and the water surface's slope in the bucket's frame. */
export const BUCKET_LITRES = 0;
export const BUCKET_SLOPE_X = 1;
export const BUCKET_SLOPE_Z = 2;
export const BUCKET_ANIM_CHANNELS = 3;
/** Matches src/sim/water.ts (WATER): a full bucket, its floor, and litres per metre of depth. */
export const BUCKET_CAPACITY = 10;
const BUCKET_FLOOR = 0.02;
const BUCKET_LITRES_PER_M = Math.PI * 0.13 * 0.13 * 1000;
const clampSlope = (s: number) => (Number.isFinite(s) ? Math.max(-6, Math.min(6, s)) : 0);

export function cubeAsset(size = 0.5, material: number = M.TestOrange): VoxelAsset {
    const h = size / 2;
    return rigid('cube', [
        {
            name: 'cube',
            volume: box(h, h, h, (x, y, z) =>
                voxel(
                    material,
                    (Math.floor((x + h) / (h / 2)) + Math.floor((y + h) / (h / 2)) + Math.floor((z + h) / (h / 2))) & 1
                        ? 0
                        : 2
                )
            ),
            priority: 1,
            refColor: 0xe5732a
        }
    ]);
}

export function sphereAsset(radius = 0.3, material: number = M.TestBlue): VoxelAsset {
    // a beach-ball-like band pattern makes rotation visible
    return rigid('sphere', [
        {
            name: 'sphere',
            volume: ellipsoid(radius, radius, radius, (x, y, z) =>
                voxel(Math.abs(y) < radius * 0.25 ? M.HiVisStripe : material, latticeShade(x, y, z, 0.2, 1) & 1)
            ),
            priority: 1,
            refColor: 0x2f7fc4
        }
    ]);
}

/** Helper for scripted motion: a yaw-pitch-roll pose. */
export function yprPose(x: number, y: number, z: number, yaw: number, pitch: number, roll: number, out: Pose): Pose {
    out.p.x = x;
    out.p.y = y;
    out.p.z = z;
    quatFromYawPitchRoll(yaw, pitch, roll, out.q);
    return out;
}

export { copyPose };

/** Windsock: a tapered striped tube along +X from its mount (the pole top). */
export function windsockAsset(): VoxelAsset {
    const segs = [
        { x: 0.13, h: 0.13 },
        { x: 0.39, h: 0.11 },
        { x: 0.63, h: 0.09 },
        { x: 0.85, h: 0.07 }
    ];
    const parts = segs.map((g, i) => ({
        name: `sock-${i}`,
        volume: box(0.12, g.h, g.h, solid(i % 2 ? M.HiVisStripe : M.HiVis)),
        priority: 2,
        refColor: i % 2 ? 0xe8e8cf : 0xf26a1b
    }));
    const offsets = segs.map((g) => pose(g.x, 0, 0));
    const ring = {
        name: 'sock-ring',
        volume: box(0.02, 0.15, 0.15, solid(M.Steel, 1)),
        priority: 3,
        refColor: 0x9aa0a6
    };
    return rigid('windsock', [ring, ...parts], [pose(0, 0, 0), ...offsets]);
}
