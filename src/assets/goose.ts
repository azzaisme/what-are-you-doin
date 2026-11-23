/**
 * The goose (Epic 8, #78, src/sim/hazard-goose.ts): a grey-brown goose with a black neck and head
 * and a white chin strap, about 0.8 m tall with its neck up. Its root is on the ground between its
 * feet, facing +z. Channels (GOOSE_*): its gait (a walk cycle), neck (0 grazing low, 1 reared up),
 * wings (0 folded, 1 spread) and beak (0 shut, 1 open).
 */

import { GOOSE_BEAK, GOOSE_GAIT, GOOSE_NECK, GOOSE_WINGS } from '../sim/hazard-goose.ts';
import { composePose, pose, quatFromYawPitchRoll } from '../voxels/math.ts';
import type { Pose } from '../voxels/math.ts';
import { M, voxel } from '../voxels/palette.ts';
import { box, ellipsoid } from '../voxels/volumes.ts';
import type { MaterialField } from '../voxels/volumes.ts';

import { ASSET_SCHEMA_VERSION } from './asset.ts';
import type { AssetPart, VoxelAsset } from './asset.ts';

/** Grey-brown back, pale belly. */
const bodyField: MaterialField = (_x, y) => voxel(y < -0.06 ? M.Muzzle : M.Pebble, 0);
/** Black, with a white strap under the chin and up the cheeks. */
const headField: MaterialField = (_x, y, z) => voxel(y < 0.01 && z < 0.04 ? M.HiVisStripe : M.Tyre, 0);
const black: MaterialField = () => voxel(M.Tyre, 0);
const beakField: MaterialField = () => voxel(M.Nose, 0);
const wingField: MaterialField = (_x, _y, z) => voxel(z < -0.12 ? M.FurDark : M.Pebble, 1);
const legField: MaterialField = () => voxel(M.Tail, 0);

const BODY_Y = 0.34;
const NECK_HALF = 0.17;

export function gooseAsset(): VoxelAsset {
    const parts: AssetPart[] = [
        { name: 'goose-body', volume: ellipsoid(0.17, 0.14, 0.3, bodyField), priority: 3, refColor: 0x7d8682 },
        { name: 'goose-tail', volume: box(0.08, 0.03, 0.06, black), priority: 3, refColor: 0x1f1f20 },
        { name: 'goose-neck', volume: box(0.04, NECK_HALF, 0.04, black), priority: 3, refColor: 0x1f1f20 },
        { name: 'goose-head', volume: box(0.045, 0.045, 0.08, headField), priority: 4, refColor: 0x1f1f20 },
        { name: 'goose-beak-top', volume: box(0.025, 0.012, 0.045, beakField), priority: 4, refColor: 0x2a1a14 },
        { name: 'goose-beak-low', volume: box(0.02, 0.01, 0.04, beakField), priority: 4, refColor: 0x2a1a14 },
        { name: 'goose-wing-l', volume: box(0.02, 0.1, 0.24, wingField), priority: 3, refColor: 0x5e3b22 },
        { name: 'goose-wing-r', volume: box(0.02, 0.1, 0.24, wingField), priority: 3, refColor: 0x5e3b22 },
        { name: 'goose-leg-l', volume: box(0.02, 0.11, 0.02, legField), priority: 2, refColor: 0x3e2e26 },
        { name: 'goose-leg-r', volume: box(0.02, 0.11, 0.02, legField), priority: 2, refColor: 0x3e2e26 }
    ];
    const local = parts.map(() => pose());
    const tmp = pose();
    const neckBase = pose();
    const hip = pose();
    const set = (p: Pose, x: number, y: number, z: number, yaw: number, pitch: number, roll: number) => {
        p.p.x = x;
        p.p.y = y;
        p.p.z = z;
        const q = quatFromYawPitchRoll(yaw, pitch, roll);
        p.q.x = q.x;
        p.q.y = q.y;
        p.q.z = q.z;
        p.q.w = q.w;
        return p;
    };
    return {
        schema: ASSET_SCHEMA_VERSION,
        name: 'goose',
        parts,
        animChannels: 4,
        cellTier: 'base',
        evaluate(root: Pose, anim: ArrayLike<number>, out: Pose[]) {
            const gait = anim[GOOSE_GAIT] || 0;
            const neck = Math.max(0, Math.min(1, anim[GOOSE_NECK] || 0));
            const wings = Math.max(0, Math.min(1, anim[GOOSE_WINGS] || 0));
            const beak = Math.max(0, Math.min(1, anim[GOOSE_BEAK] || 0));
            const swing = Math.sin(gait * Math.PI * 2);
            const bob = Math.abs(swing) * 0.015;
            // body, a little nose-up as it rears
            const lift = -0.25 * neck;
            composePose(root, set(local[0], 0, BODY_Y + bob, 0, 0, lift, 0), out[0]);
            composePose(out[0], set(local[1], 0, 0.05, -0.3, 0, -0.2, 0), out[1]);
            // the neck from the chest: leaning forward low (grazing) to upright (reared)
            const lean = 1.1 * (1 - neck);
            const base = set(tmp, 0, 0.08, 0.22, 0, lean, 0);
            composePose(out[0], base, neckBase);
            composePose(neckBase, set(local[2], 0, NECK_HALF, 0, 0, 0, 0), out[2]);
            // the head at the neck's top, held level, beak forward
            composePose(neckBase, set(local[3], 0, 2 * NECK_HALF + 0.02, 0.04, 0, -lean - lift, 0), out[3]);
            composePose(out[3], set(local[4], 0, 0.0, 0.12, 0, 0, 0), out[4]);
            composePose(out[3], set(local[5], 0, -0.02, 0.11, 0, 0.45 * beak, 0), out[5]);
            // the wings at the shoulders: folded along the back, spread out and up
            for (const side of [-1, 1]) {
                const i = side < 0 ? 6 : 7;
                const spread = side * (0.15 + 1.25 * wings);
                composePose(out[0], set(local[i], side * 0.16, 0.04, -0.02, 0, 0, spread), out[i]);
            }
            // the legs, swinging with the gait
            for (const side of [-1, 1]) {
                const i = side < 0 ? 8 : 9;
                const a = 0.5 * swing * side;
                composePose(root, set(tmp, side * 0.07, 0.22, 0.02, 0, a, 0), hip);
                composePose(hip, set(local[i], 0, -0.11, 0, 0, 0, 0), out[i]);
            }
        }
    };
}
