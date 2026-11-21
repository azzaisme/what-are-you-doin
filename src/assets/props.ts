/**
 * Single-part and simple multi-part props: timber plank, log, bucket, test cube and sphere.
 * Sizes are multiples of 0.1 m where the design doc proposes them (§2.5).
 */

import { GRID_SIZE } from '../voxels/grid.ts';
import { aabb, composePose, copyPose, pose, quatFromYawPitchRoll } from '../voxels/math.ts';
import type { Pose } from '../voxels/math.ts';
import { M, voxel } from '../voxels/palette.ts';
import { box, cup, ellipsoid, grain, implicit, latticeShade, solid } from '../voxels/volumes.ts';

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
export function plankAsset(name = 'plank'): VoxelAsset {
    const g = grain(M.Timber, 'x', 0.1, 5);
    const v = box(1.2, 0.1, 0.05, (x, y, z) =>
        Math.abs(x) > 1.12 ? voxel(M.TimberEnd, latticeShade(x, y, z, 0.1, 2)) : g(x, y, z)
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
export const BUCKET_WATER_LEVEL = 0.22;
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
    // the water inside: fills the hollow up to the water level (on coarse cells it also reaches
    // into the wall a little, so it shows as a blue disc in the narrow opening)
    const inner = (y: number) => 0.13 + 0.03 * (y / BUCKET_HEIGHT) - wallT;
    const water = implicit(
        aabb(-0.16, baseT, -0.16, 0.16, BUCKET_WATER_LEVEL, 0.16),
        (x, y, z) => Math.hypot(x, z) < inner(y) + (fine ? 0 : 0.02),
        (x, y, z) => voxel(M.BucketWater, latticeShade(x, y, z, fine ? 0.03 : 0.1, 4))
    );
    return rigid('bucket', [
        { name: 'bucket', volume: wall, priority: 2, refColor: 0xa9b0b4 },
        { name: 'water', volume: water, priority: 3, policy: fine ? 'coverage50' : 'conservative', refColor: 0x3a9ee0 },
        { name: 'handle', volume: handle, priority: 3, policy: 'conservative', refColor: 0x9aa0a6 }
    ]);
}

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
