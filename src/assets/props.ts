/**
 * Single-part and simple multi-part props: timber plank, log, bucket, test cube and sphere.
 * Sizes are multiples of 0.1 m where the design doc proposes them (§2.5).
 */

import { aabb, composePose, copyPose, pose, quatFromYawPitchRoll  } from '../voxels/math.ts';
import type { Pose } from '../voxels/math.ts';
import { M, voxel } from '../voxels/palette.ts';
import { box, cup, ellipsoid, grain, implicit, latticeShade, solid } from '../voxels/volumes.ts';

import { ASSET_SCHEMA_VERSION   } from './asset.ts';
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
    const v = box(1.2, 0.1, 0.05, (x, y, z) => (Math.abs(x) > 1.12 ? voxel(M.TimberEnd, latticeShade(x, y, z, 0.1, 2)) : g(x, y, z)));
    return rigid(name, [{ name: 'plank', volume: v, priority: 1, refColor: 0xc48d55 }]);
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
    const wall = cup(0.13, 0.16, BUCKET_HEIGHT, 0.08, 0.08, (x, y, z) => voxel(M.Galvanised, y > 0.3 ? 2 : latticeShade(x, y, z, 0.1, 6)));
    // the handle: a thick arc over the top, along X
    const handle = implicit(
        aabb(-0.18, BUCKET_HEIGHT - 0.05, -0.05, 0.18, BUCKET_HANDLE_TOP + 0.02, 0.05),
        (x, y) => {
            const cy = BUCKET_HEIGHT - 0.04;
            const r = Math.hypot(x, y - cy);
            return y >= cy && r > 0.12 && r < 0.18;
        },
        solid(M.Steel)
    );
    return rigid('bucket', [
        { name: 'bucket', volume: wall, priority: 2, refColor: 0xa9b0b4 },
        { name: 'handle', volume: handle, priority: 3, policy: 'conservative', refColor: 0x9aa0a6 }
    ]);
}

export function cubeAsset(size = 0.5, material: number = M.TestOrange): VoxelAsset {
    const h = size / 2;
    return rigid('cube', [{ name: 'cube', volume: box(h, h, h, (x, y, z) => voxel(material, (Math.floor((x + h) / (h / 2)) + Math.floor((y + h) / (h / 2)) + Math.floor((z + h) / (h / 2))) & 1 ? 0 : 2)), priority: 1, refColor: 0xe5732a }]);
}

export function sphereAsset(radius = 0.3, material: number = M.TestBlue): VoxelAsset {
    // a beach-ball-like band pattern makes rotation visible
    return rigid('sphere', [{ name: 'sphere', volume: ellipsoid(radius, radius, radius, (x, y, z) => voxel(Math.abs(y) < radius * 0.25 ? M.HiVisStripe : material, latticeShade(x, y, z, 0.2, 1) & 1)), priority: 1, refColor: 0x2f7fc4 }]);
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
