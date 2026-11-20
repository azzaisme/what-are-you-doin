/**
 * The ute test object (design doc §2.7, §7.2): a small pickup built from boxes plus four wheel
 * volumes. Wheels follow their own steer/spin/suspension poses before voxelizing; tread and rim
 * patterns live in the wheel's local material field so the spin reads in the reconstructed cells.
 */

import { aabb, quatFromYawPitchRoll  } from '../voxels/math.ts';
import type { Pose } from '../voxels/math.ts';
import { M, voxel } from '../voxels/palette.ts';
import { box, cylinder, implicit, latticeShade, solid, speckled } from '../voxels/volumes.ts';

import { ASSET_SCHEMA_VERSION   } from './asset.ts';
import type { AssetPart, VoxelAsset } from './asset.ts';
import { attach, evaluateAttachments, Rig  } from './rig.ts';
import type { Attachment } from './rig.ts';

export const UTE_WHEEL_SPIN = 0;
export const UTE_STEER = 1;
export const UTE_SUSPENSION = 2;
export const UTE_PITCH = 3;
export const UTE_ROLL = 4;
export const UTE_ANIM_CHANNELS = 5;

export const UTE_WHEEL_RADIUS = 0.34;
export const UTE_WHEELBASE_HALF = 1.15;
export const UTE_TRACK_HALF = 0.68;

const rig = new Rig([
    { name: 'chassis', parent: -1, x: 0, y: UTE_WHEEL_RADIUS, z: 0 },
    { name: 'wheelFL', parent: -1, x: UTE_TRACK_HALF, y: UTE_WHEEL_RADIUS, z: UTE_WHEELBASE_HALF },
    { name: 'wheelFR', parent: -1, x: -UTE_TRACK_HALF, y: UTE_WHEEL_RADIUS, z: UTE_WHEELBASE_HALF },
    { name: 'wheelRL', parent: -1, x: UTE_TRACK_HALF, y: UTE_WHEEL_RADIUS, z: -UTE_WHEELBASE_HALF },
    { name: 'wheelRR', parent: -1, x: -UTE_TRACK_HALF, y: UTE_WHEEL_RADIUS, z: -UTE_WHEELBASE_HALF }
]);
const CH = rig.index('chassis');
const WHEELS = [rig.index('wheelFL'), rig.index('wheelFR'), rig.index('wheelRL'), rig.index('wheelRR')];

// paint: one colour with a faint large-scale variation (no per-cell noise)
const paint = (x: number, y: number, z: number) => voxel(M.UtePaint, latticeShade(x, y, z, 0.9, 21) === 2 ? 2 : 0);
const ARCH_R = 0.43;
const lowerBody = implicit(
    aabb(-0.8, -0.2, -1.8, 0.8, 0.2, 1.8),
    (_x, y, z) => {
        // wheel arches: cylinders around the axles (axle at local y = -0.34 relative to this part)
        for (const az of [UTE_WHEELBASE_HALF, -UTE_WHEELBASE_HALF]) {
            const dy = y + 0.34;
            const dz = z - az;
            if (dy * dy + dz * dz < ARCH_R * ARCH_R) return false;
        }
        return true;
    },
    (x, y, z) => (y < -0.13 ? voxel(M.UteTrim) : paint(x, y, z))
);

const wheelField = (_x: number, y: number, z: number) => {
    const r = Math.hypot(y, z);
    const ang = Math.atan2(z, y);
    if (r > 0.25) {
        // tread blocks: alternating shade around the circumference
        return voxel(M.Tyre, Math.floor((ang / Math.PI) * 9) & 1 ? 0 : 3);
    }
    if (r < 0.08) return voxel(M.Chrome);
    // five spokes
    const spoke = Math.abs(((((ang / (2 * Math.PI)) * 5) % 1) + 1) % 1 - 0.5) < 0.18;
    return spoke ? voxel(M.Chrome) : voxel(M.UteTrim);
};
const wheel = cylinder('x', UTE_WHEEL_RADIUS, 0.12, wheelField);

const parts: AssetPart[] = [];
const attachments: Attachment[] = [];
function part(p: AssetPart, a: Attachment): void {
    parts.push(p);
    attachments.push(a);
}

part({ name: 'lowerBody', volume: lowerBody, priority: 2, refColor: 0xb3342b }, attach(CH, 0, 0.34, 0));
part({ name: 'hood', volume: box(0.77, 0.06, 0.55, paint), priority: 2, refColor: 0xb3342b }, attach(CH, 0, 0.58, 1.24));
part({ name: 'cab', volume: box(0.76, 0.3, 0.55, paint), priority: 2, refColor: 0xb3342b }, attach(CH, 0, 0.84, 0.15));
part({ name: 'windscreen', volume: box(0.66, 0.19, 0.07, solid(M.Glass)), priority: 4, refColor: 0x2d3d4a }, attach(CH, 0, 0.88, 0.67));
part({ name: 'sideWindows', volume: box(0.78, 0.16, 0.38, solid(M.Glass, 2)), priority: 3, refColor: 0x2d3d4a }, attach(CH, 0, 0.9, 0.17));
part({ name: 'rearWindow', volume: box(0.6, 0.14, 0.06, solid(M.Glass)), priority: 3, refColor: 0x2d3d4a }, attach(CH, 0, 0.9, -0.37));
part({ name: 'bedFloor', volume: box(0.78, 0.05, 0.86, speckled(M.Steel, 0.2, 4)), priority: 2, refColor: 0x9aa0a6 }, attach(CH, 0, 0.58, -0.94));
part({ name: 'bedSideL', volume: box(0.05, 0.15, 0.86, paint), priority: 3, refColor: 0xb3342b }, attach(CH, 0.75, 0.76, -0.94));
part({ name: 'bedSideR', volume: box(0.05, 0.15, 0.86, paint), priority: 3, refColor: 0xb3342b }, attach(CH, -0.75, 0.76, -0.94));
part({ name: 'tailgate', volume: box(0.8, 0.15, 0.05, paint), priority: 3, refColor: 0xb3342b }, attach(CH, 0, 0.76, -1.77));
part({ name: 'bumperF', volume: box(0.82, 0.07, 0.07, solid(M.UteTrim)), priority: 3, refColor: 0x2c2e31 }, attach(CH, 0, 0.17, 1.82));
part({ name: 'bumperR', volume: box(0.82, 0.07, 0.07, solid(M.UteTrim)), priority: 3, refColor: 0x2c2e31 }, attach(CH, 0, 0.17, -1.82));
part({ name: 'grille', volume: box(0.34, 0.1, 0.04, solid(M.UteTrim)), priority: 4, refColor: 0x2c2e31 }, attach(CH, 0, 0.42, 1.79));
part({ name: 'headlightL', volume: box(0.11, 0.06, 0.05, solid(M.Headlight)), priority: 5, refColor: 0xf6f0d8 }, attach(CH, 0.56, 0.44, 1.78));
part({ name: 'headlightR', volume: box(0.11, 0.06, 0.05, solid(M.Headlight)), priority: 5, refColor: 0xf6f0d8 }, attach(CH, -0.56, 0.44, 1.78));
part({ name: 'taillightL', volume: box(0.06, 0.08, 0.05, solid(M.Taillight)), priority: 5, refColor: 0xd0281f }, attach(CH, 0.72, 0.68, -1.78));
part({ name: 'taillightR', volume: box(0.06, 0.08, 0.05, solid(M.Taillight)), priority: 5, refColor: 0xd0281f }, attach(CH, -0.72, 0.68, -1.78));
for (let w = 0; w < 4; w++) {
    part({ name: `wheel${w}`, volume: wheel, priority: 6, refColor: 0x1f1f20 }, attach(WHEELS[w], 0, 0, 0));
}

export const uteAsset: VoxelAsset = {
    schema: ASSET_SCHEMA_VERSION,
    name: 'ute',
    parts,
    animChannels: UTE_ANIM_CHANNELS,
    evaluate(root: Pose, anim: ArrayLike<number>, out: Pose[]) {
        const spin = anim[UTE_WHEEL_SPIN] ?? 0;
        const steer = anim[UTE_STEER] ?? 0;
        const susp = anim[UTE_SUSPENSION] ?? 0;
        const pitch = anim[UTE_PITCH] ?? 0;
        const roll = anim[UTE_ROLL] ?? 0;
        // chassis rides on suspension; wheels stay on the ground
        rig.joints[CH].y = UTE_WHEEL_RADIUS + susp;
        quatFromYawPitchRoll(0, pitch, roll, rig.rot[CH]);
        for (let w = 0; w < 4; w++) {
            quatFromYawPitchRoll(w < 2 ? steer : 0, spin, 0, rig.rot[WHEELS[w]]);
        }
        rig.evaluate(root);
        evaluateAttachments(rig, attachments, out);
    }
};
