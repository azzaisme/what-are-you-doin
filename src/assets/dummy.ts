/**
 * Ragdoll crash-test dummy (Epic 2 experiment): a beaver-coloured figure of seven rigid parts, each
 * its own voxel object posed by its own physics body and joined by ball joints. It shares the
 * beaver palette but is deliberately simpler than the beaver rig; whether the real beaver should
 * ragdoll this way is an owner question for a later epic.
 *
 * Dimensions are half extents in metres, used by both the voxel volumes and the physics colliders.
 */

import { composePose, pose, quatFromYawPitchRoll } from '../voxels/math.ts';
import type { Pose } from '../voxels/math.ts';
import { M, voxel } from '../voxels/palette.ts';
import { box, latticeShade, solid } from '../voxels/volumes.ts';

import { ASSET_SCHEMA_VERSION } from './asset.ts';
import type { AssetPart, VoxelAsset } from './asset.ts';

export interface DummyPartSpec {
    name: string;
    /** Half extents of the collision box. */
    hx: number;
    hy: number;
    hz: number;
    /** Rest position of the part centre relative to the dummy's feet origin. */
    x: number;
    y: number;
    z: number;
    /** Index of the parent part (-1 for the body) and the joint point relative to the feet origin. */
    parent: number;
    jx: number;
    jy: number;
    jz: number;
}

// a 1.4 m figure: legs 0.3, body 0.6, head 0.3, plus a hat brim
export const DUMMY_PARTS: readonly DummyPartSpec[] = [
    { name: 'body', hx: 0.2, hy: 0.3, hz: 0.16, x: 0, y: 0.62, z: 0, parent: -1, jx: 0, jy: 0, jz: 0 },
    { name: 'head', hx: 0.16, hy: 0.14, hz: 0.15, x: 0, y: 1.08, z: 0.02, parent: 0, jx: 0, jy: 0.93, jz: 0 },
    { name: 'armL', hx: 0.05, hy: 0.16, hz: 0.05, x: 0.27, y: 0.72, z: 0, parent: 0, jx: 0.24, jy: 0.88, jz: 0 },
    { name: 'armR', hx: 0.05, hy: 0.16, hz: 0.05, x: -0.27, y: 0.72, z: 0, parent: 0, jx: -0.24, jy: 0.88, jz: 0 },
    { name: 'legL', hx: 0.07, hy: 0.15, hz: 0.07, x: 0.11, y: 0.16, z: 0, parent: 0, jx: 0.11, jy: 0.32, jz: 0 },
    { name: 'legR', hx: 0.07, hy: 0.15, hz: 0.07, x: -0.11, y: 0.16, z: 0, parent: 0, jx: -0.11, jy: 0.32, jz: 0 },
    { name: 'tail', hx: 0.13, hy: 0.03, hz: 0.18, x: 0, y: 0.36, z: -0.36, parent: 0, jx: 0, jy: 0.38, jz: -0.17 }
];

function rigidParts(name: string, parts: AssetPart[], offsets: Pose[]): VoxelAsset {
    return {
        schema: ASSET_SCHEMA_VERSION,
        name,
        parts,
        animChannels: 0,
        evaluate(root: Pose, _anim: ArrayLike<number>, out: Pose[]) {
            for (let i = 0; i < parts.length; i++) composePose(root, offsets[i], out[i]);
        }
    };
}

const fur = (x: number, y: number, z: number) => voxel(M.Fur, latticeShade(x, y, z, 0.1, 3));

/** Voxel asset for one dummy part (origin at the part centre). */
export function dummyPartAsset(index: number): VoxelAsset {
    const p = DUMMY_PARTS[index];
    const id = `dummy-${p.name}`;
    switch (p.name) {
        case 'body': {
            // fur body with a hi-vis vest band
            const vest = box(p.hx + 0.01, 0.13, p.hz + 0.01, (x, y, z) => voxel(Math.abs(y) < 0.03 ? M.HiVisStripe : M.HiVis, latticeShade(x, y, z, 0.1, 5) & 1));
            return rigidParts(
                id,
                [
                    { name: 'body', volume: box(p.hx, p.hy, p.hz, fur), priority: 1, refColor: 0x8a5a36 },
                    { name: 'vest', volume: vest, priority: 2, refColor: 0xe8e23a }
                ],
                [pose(), pose(0, 0.05, 0)]
            );
        }
        case 'head': {
            const hat = box(0.19, 0.04, 0.19, solid(M.HardHat));
            const dome = box(0.15, 0.06, 0.15, solid(M.HardHat));
            const teeth = box(0.05, 0.035, 0.02, solid(M.Tooth));
            const eye = box(0.025, 0.025, 0.015, solid(M.Eye));
            return rigidParts(
                id,
                [
                    { name: 'head', volume: box(p.hx, p.hy, p.hz, fur), priority: 1, refColor: 0x8a5a36 },
                    { name: 'brim', volume: hat, priority: 3, refColor: 0xf0b323 },
                    { name: 'dome', volume: dome, priority: 3, refColor: 0xf0b323 },
                    { name: 'teeth', volume: teeth, priority: 4, refColor: 0xf4f0e0 },
                    { name: 'eyeL', volume: eye, priority: 4, refColor: 0x111111 },
                    { name: 'eyeR', volume: eye, priority: 4, refColor: 0x111111 }
                ],
                [pose(), pose(0, p.hy + 0.02, 0), pose(0, p.hy + 0.1, 0), pose(0, -0.08, p.hz + 0.01), pose(0.07, 0.03, p.hz + 0.005), pose(-0.07, 0.03, p.hz + 0.005)]
            );
        }
        case 'tail':
            return rigidParts(id, [{ name: 'tail', volume: box(p.hx, p.hy, p.hz, (x, y, z) => voxel(M.Tail, latticeShade(x, y, z, 0.08, 9))), priority: 1, refColor: 0x3a2a20 }], [pose()]);
        default:
            return rigidParts(id, [{ name: p.name, volume: box(p.hx, p.hy, p.hz, (x, y, z) => voxel(M.FurDark, latticeShade(x, y, z, 0.1, 7))), priority: 1, refColor: 0x5a3a26 }], [pose()]);
    }
}

/** World rest pose of a dummy part for a dummy placed at feet position (x, y, z) with a yaw. */
export function dummyRestPose(index: number, x: number, y: number, z: number, yaw: number, out: Pose): Pose {
    const p = DUMMY_PARTS[index];
    const root = pose(x, y, z, quatFromYawPitchRoll(yaw, 0, 0));
    return composePose(root, pose(p.x, p.y, p.z), out);
}
