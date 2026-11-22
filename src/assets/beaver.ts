/**
 * The beaver engineer: 1.4 m = 14 cells tall (design doc §2.2, §3.2).
 *
 * Built from simple primitive volumes on a small joint hierarchy. The walk cycle is evaluated as a
 * continuous pose underneath and rasterized into the shared world grid; no voxel limb is ever
 * rotated as a block. Details (eyes, teeth, nose) are volumes that reach into the head so that
 * whichever head surface cell they cover takes their material - they never vanish as sub-cell
 * specks, and they never require smaller voxels.
 */

import { aabb, composePose, pose } from '../voxels/math.ts';
import type { Pose } from '../voxels/math.ts';
import { M, voxel } from '../voxels/palette.ts';
import { box, ellipsoid, implicit, latticeShade, solid, speckled } from '../voxels/volumes.ts';

import { ASSET_SCHEMA_VERSION } from './asset.ts';
import type { AssetPart, VoxelAsset } from './asset.ts';
import { attach, evaluateAttachments, Rig } from './rig.ts';
import type { Attachment } from './rig.ts';

/** Animation channels. */
export const BEAVER_WALK_PHASE = 0;
export const BEAVER_WALK_AMOUNT = 1;
export const BEAVER_CARRY = 2;
export const BEAVER_HEAD_YAW = 3;
/**
 * Both arms raised forward by this angle (radians; 0 hangs, pi/2 points straight ahead): the player
 * beavers lift their arms toward what they hold, so the hands show in first person.
 */
export const BEAVER_ARM_RAISE = 4;
/** 1: drawn for its own player's camera, so the head (which the camera sits inside) is left out. */
export const BEAVER_FIRST_PERSON = 5;
/** Shoulders reaching forward (m): grabbing, throwing (src/sim/player-anim.ts). */
export const BEAVER_ARM_REACH = 6;
/** Arms turned outward (rad; negative turns them in): wide things are held at their sides. */
export const BEAVER_ARM_SPREAD = 7;
/** Torso lean (rad; positive leans back): against a load, into a throw, on landing. */
export const BEAVER_LEAN = 8;
/** Head pitch (rad; positive looks up): where the player looks. */
export const BEAVER_HEAD_PITCH = 9;
export const BEAVER_ANIM_CHANNELS = 10;

export const BEAVER_HEIGHT = 1.4;
/**
 * Shoulder to paw tip (m). A little long for a real beaver, so a carried plank or beam sits in its
 * paws in front of the belly rather than floating beyond them.
 */
export const BEAVER_ARM_LENGTH = 0.44;

const rig = new Rig([
    { name: 'pelvis', parent: -1, x: 0, y: 0.34, z: 0 },
    { name: 'spine', parent: 0, x: 0, y: 0.28, z: 0 },
    { name: 'head', parent: 1, x: 0, y: 0.5, z: 0.03 },
    { name: 'hipL', parent: 0, x: 0.12, y: 0, z: 0 },
    { name: 'hipR', parent: 0, x: -0.12, y: 0, z: 0 },
    { name: 'shoulderL', parent: 1, x: 0.3, y: 0.22, z: 0 },
    { name: 'shoulderR', parent: 1, x: -0.3, y: 0.22, z: 0 },
    { name: 'tail', parent: 0, x: 0, y: -0.04, z: -0.22 }
]);
const J = {
    pelvis: rig.index('pelvis'),
    spine: rig.index('spine'),
    head: rig.index('head'),
    hipL: rig.index('hipL'),
    hipR: rig.index('hipR'),
    shoulderL: rig.index('shoulderL'),
    shoulderR: rig.index('shoulderR'),
    tail: rig.index('tail')
};

const fur = speckled(M.Fur, 0.1, 11);
const vestField = (x: number, y: number, z: number) => {
    // reflective stripe band, otherwise hi-vis orange
    if (y > -0.07 && y < 0.03) return voxel(M.HiVisStripe);
    return voxel(M.HiVis, latticeShade(x, y, z, 0.2, 3));
};
const vest = implicit(
    aabb(-0.33, -0.22, -0.3, 0.33, 0.32, 0.3),
    (x, y, z) => {
        const e = (x * x) / (0.32 * 0.32) + (y * y) / (0.31 * 0.31) + (z * z) / (0.29 * 0.29);
        if (e >= 1) return false;
        // open front shows the belly fur
        return !(z > 0.12 && Math.abs(x) < 0.09);
    },
    vestField
);
const hatDome = implicit(
    // dome top lands just under 1.40 m when standing (head centre 1.12 + 0.12 + 0.159)
    aabb(-0.26, 0, -0.27, 0.26, 0.16, 0.27),
    (x, y, z) => (x * x) / (0.255 * 0.255) + (y * y) / (0.159 * 0.159) + (z * z) / (0.265 * 0.265) < 1,
    (x, y, z) => voxel(M.HardHat, y > 0.12 ? 2 : latticeShade(x, y, z, 0.3, 7) & 1)
);
// Eyes are painted into the head's material field, so they sit flush on whichever surface cells
// cover the eye windows. The windows are smaller than a cell; material precedence (palette) makes
// any cell whose inside sub-samples touch a window take the eye colour, so an eye never vanishes
// and rarely grows beyond one or two cells.
const EYE_X = 0.145;
const EYE_Y = 0.035;
const EYE_HALF = 0.046;
const headField = (x: number, y: number, z: number) => {
    if (z > 0.05 && Math.abs(y - EYE_Y) < EYE_HALF + 0.006 && Math.abs(Math.abs(x) - EYE_X) < EYE_HALF)
        return voxel(M.Eye);
    return fur(x, y, z);
};
const muzzleBase = speckled(M.Muzzle, 0.1, 9);
// nose and teeth are painted onto the muzzle, the same way as the eyes
const muzzleField = (x: number, y: number, z: number) => {
    if (z > 0.0 && y > -0.005 && Math.abs(x) < 0.052) return voxel(M.Nose);
    // two buck teeth on the lower front, one cell each side of centre when aligned
    if (z > -0.03 && y < -0.05 && Math.abs(x) < 0.055) return voxel(M.Tooth, x < 0 ? 0 : 1);
    return muzzleBase(x, y, z);
};
const arm = implicit(
    aabb(-0.065, -BEAVER_ARM_LENGTH / 2 - 0.01, -0.07, 0.065, BEAVER_ARM_LENGTH / 2 + 0.01, 0.07),
    () => true,
    (x, y, z) => (y < -BEAVER_ARM_LENGTH / 2 + 0.1 ? voxel(M.FurDark) : fur(x, y, z))
);
const tail = box(0.15, 0.05, 0.26, (x, _y, z) =>
    voxel(M.Tail, (Math.floor(x / 0.07) + Math.floor(z / 0.07)) & 1 ? 1 : 2)
);

const parts: AssetPart[] = [];
const attachments: Attachment[] = [];
function part(p: AssetPart, a: Attachment): void {
    parts.push(p);
    attachments.push(a);
}

part(
    { name: 'body', volume: ellipsoid(0.3, 0.36, 0.27, fur), priority: 2, refColor: 0x8a5a33 },
    attach(J.spine, 0, 0, 0)
);
part(
    { name: 'belly', volume: ellipsoid(0.19, 0.27, 0.12, speckled(M.Muzzle, 0.1, 5)), priority: 3, refColor: 0xd9b58a },
    attach(J.spine, 0, -0.04, 0.19)
);
part({ name: 'vest', volume: vest, priority: 4, refColor: 0xf26a1b }, attach(J.spine, 0, 0.05, 0));
part(
    { name: 'head', volume: ellipsoid(0.24, 0.21, 0.22, headField), priority: 3, refColor: 0x8a5a33 },
    attach(J.head, 0, 0, 0)
);
// Face layout for a 10 cm grid (head-local y, top to bottom): dome, brim, eyes, muzzle with nose,
// teeth - one cell row each, so features stay legible while the head bobs and nods by sub-cell
// amounts. The eye windows are 0.21 m apart, so a fur cell always separates the two eyes.
part(
    { name: 'muzzle', volume: ellipsoid(0.16, 0.11, 0.115, muzzleField), priority: 5, refColor: 0xd9b58a },
    attach(J.head, 0, -0.1, 0.15)
);
part(
    { name: 'earL', volume: box(0.05, 0.05, 0.045, solid(M.FurDark)), priority: 4, refColor: 0x5e3b22 },
    attach(J.head, 0.18, 0.12, -0.03)
);
part(
    { name: 'earR', volume: box(0.05, 0.05, 0.045, solid(M.FurDark)), priority: 4, refColor: 0x5e3b22 },
    attach(J.head, -0.18, 0.12, -0.03)
);
part({ name: 'hatDome', volume: hatDome, priority: 7, refColor: 0xf2c230 }, attach(J.head, 0, 0.12, 0));
part(
    {
        name: 'hatBrim',
        volume: box(0.26, 0.05, 0.26, solid(M.HardHat, 1)),
        priority: 7,
        policy: 'coverage25',
        refColor: 0xf2c230
    },
    attach(J.head, 0, 0.135, 0.01)
);
part({ name: 'armL', volume: arm, priority: 2, refColor: 0x8a5a33 }, attach(J.shoulderL, 0, -BEAVER_ARM_LENGTH / 2, 0));
part({ name: 'armR', volume: arm, priority: 2, refColor: 0x8a5a33 }, attach(J.shoulderR, 0, -BEAVER_ARM_LENGTH / 2, 0));
part(
    { name: 'legL', volume: box(0.08, 0.15, 0.09, fur), priority: 2, refColor: 0x8a5a33 },
    attach(J.hipL, 0, -0.16, 0)
);
part(
    { name: 'legR', volume: box(0.08, 0.15, 0.09, fur), priority: 2, refColor: 0x8a5a33 },
    attach(J.hipR, 0, -0.16, 0)
);
part(
    { name: 'footL', volume: box(0.085, 0.045, 0.14, solid(M.FurDark)), priority: 3, refColor: 0x5e3b22 },
    attach(J.hipL, 0, -0.295, 0.05)
);
part(
    { name: 'footR', volume: box(0.085, 0.045, 0.14, solid(M.FurDark)), priority: 3, refColor: 0x5e3b22 },
    attach(J.hipR, 0, -0.295, 0.05)
);
part(
    { name: 'tail', volume: tail, priority: 1, policy: 'coverage25', refColor: 0x3e2e26 },
    attach(J.tail, 0, 0, -0.24)
);

/** Parts left out in first person: everything on the head joint. */
const HEAD_PARTS = ['head', 'muzzle', 'earL', 'earR', 'hatDome', 'hatBrim'].map((n) => {
    const i = parts.findIndex((p) => p.name === n);
    if (i < 0) throw new Error(`beaver part ${n} missing`);
    return i;
});
const HEAD_PART_SET = new Set(HEAD_PARTS);
/** Raised arms also turn inward by up to this much (radians), so both hands come into view. */
export const BEAVER_ARM_INWARD = 0.15;
const ARM_INWARD = BEAVER_ARM_INWARD;
/**
 * First person only (the player's own camera): the beaver's short arms hang 38 cm below the eye and
 * could never reach into view, so for that one camera the shoulders move up and forward (spine
 * frame, m) and the arms rest in a ready pose at the bottom corners of the view. Every other camera
 * sees the normal beaver.
 */
const FP_SHOULDER = { x: 0.08, y: 0.1, z: 0.25 };
/** First person: the torso sits this far back (m), so it shows only when you look well down. */
const FP_SPINE_Z = -0.12;
const FP_READY_RAISE = 1.55;

const _root = pose();
const _hand = pose(0, -BEAVER_ARM_LENGTH + 0.02, 0.02);

export const beaverAsset: VoxelAsset = {
    schema: ASSET_SCHEMA_VERSION,
    name: 'beaver',
    parts,
    animChannels: BEAVER_ANIM_CHANNELS,
    evaluate(root: Pose, anim: ArrayLike<number>, out: Pose[]) {
        poseRig(root, anim);
        evaluateAttachments(rig, attachments, out);
    },
    partHidden(anim: ArrayLike<number>, part: number) {
        return (anim[BEAVER_FIRST_PERSON] ?? 0) > 0.5 && HEAD_PART_SET.has(part);
    }
};

/** Shoulder joints above the spine joint, the torso's pivot (m). */
const SHOULDER_ABOVE_SPINE = 0.22;

function poseRig(root: Pose, anim: ArrayLike<number>): void {
    const phase = anim[BEAVER_WALK_PHASE] ?? 0;
    const amount = anim[BEAVER_WALK_AMOUNT] ?? 0;
    const carry = anim[BEAVER_CARRY] ?? 0;
    const headYaw = anim[BEAVER_HEAD_YAW] ?? 0;
    const fp = (anim[BEAVER_FIRST_PERSON] ?? 0) > 0.5;
    // empty-handed in first person, the paws are held up ready in view; holding something, they
    // aim at it from the real shoulders, like everyone else sees them
    const ready = fp && carry < 0.5;
    const raise = Math.max(ready ? FP_READY_RAISE : 0, Math.min(2.7, anim[BEAVER_ARM_RAISE] ?? 0));
    const reach = anim[BEAVER_ARM_REACH] ?? 0;
    const spread = anim[BEAVER_ARM_SPREAD] ?? 0;
    const lean = anim[BEAVER_LEAN] ?? 0;
    const headPitch = anim[BEAVER_HEAD_PITCH] ?? 0;
    // the torso leans back out of the lower view; the shoulders come forward and in. Reaching
    // brings the shoulders forward and a little up
    const spinePitch = 0.05 * amount + 0.6 * Math.max(0, reach) - lean;
    // leaning back with raised arms, the shoulders slide forward along the torso (the arms reach
    // out), so the hands stay on what they hold
    const raised = Math.min(1, raise);
    const keep = SHOULDER_ABOVE_SPINE * Math.tan(Math.max(0, -spinePitch)) * raised;
    rig.setShift(J.spine, 0, 0, fp ? FP_SPINE_Z : 0);
    const sz = (ready ? FP_SHOULDER.z : 0) - (fp ? FP_SPINE_Z : 0) + reach + keep;
    const sy = (ready ? FP_SHOULDER.y : 0) + 0.3 * Math.max(0, reach);
    rig.setShift(J.shoulderL, ready ? -FP_SHOULDER.x : 0, sy, sz);
    rig.setShift(J.shoulderR, ready ? FP_SHOULDER.x : 0, sy, sz);
    // raised arms stop swinging; hanging arms swing fully
    const hang = Math.max(0, 1 - raise / 0.6);
    const inward = ARM_INWARD * Math.min(1, raise) - spread;
    const s = Math.sin(phase);
    const s2 = Math.sin(2 * phase);

    _root.p.x = root.p.x;
    _root.p.y = root.p.y + 0.03 * amount * (1 - Math.cos(2 * phase)) * 0.5;
    _root.p.z = root.p.z;
    _root.q.x = root.q.x;
    _root.q.y = root.q.y;
    _root.q.z = root.q.z;
    _root.q.w = root.q.w;

    rig.setRot(J.pelvis, 0.06 * amount * s, 0, 0.035 * amount * s);
    // positive spine pitch leans forward: walking, reaching; the lean channel leans back
    rig.setRot(J.spine, 0, spinePitch, 0);
    // raised arms keep aiming where the animation points them (at what you hold) as the torso
    // leans; hanging arms move with it
    const aim = raise + spinePitch * Math.min(1, raise);
    // the head follows the look, less the torso's lean (looking down pitches it forward)
    rig.setRot(J.head, headYaw, -0.05 * amount * s2 - 0.7 * headPitch - 0.6 * spinePitch, 0);
    rig.setRot(J.hipL, 0, 0.5 * amount * s, 0);
    rig.setRot(J.hipR, 0, -0.5 * amount * s, 0);
    // the right arm swings; the left arm holds the bucket out a little when carrying
    // (negative pitch swings an arm forward)
    rig.setRot(J.shoulderR, inward, -0.4 * amount * s * hang - aim, -0.05 * hang);
    rig.setRot(
        J.shoulderL,
        -inward,
        ((1 - carry) * 0.4 * amount * s - carry * 0.12) * hang - aim,
        (0.05 + carry * 0.12) * hang
    );
    rig.setRot(J.tail, 0.22 * amount * s, -0.38 + 0.06 * amount * s2, 0);
    rig.evaluate(_root);
}

/**
 * Your own limbs in first person, on the 1 cm lattice: arms, legs and feet, posed exactly like the
 * player's beaver in first person (shoulders forward, paws in view). The renderer draws it in place
 * of your own beaver, for your camera only; the torso is left out, since it would fill the lower
 * view a hand's width from the camera.
 */
const FP_LIMBS = ['armL', 'armR', 'legL', 'legR', 'footL', 'footR'].map((n) => parts.findIndex((p) => p.name === n));
const _fpAnim = new Float64Array(BEAVER_ANIM_CHANNELS);
export const beaverFirstPersonAsset: VoxelAsset = {
    schema: ASSET_SCHEMA_VERSION,
    name: 'beaver-first-person',
    // one sample per 1 cm cell is plenty for 13 cm limbs, and several times cheaper (they are rebuilt
    // every voxel frame)
    parts: FP_LIMBS.map((i) => ({ ...parts[i], policy: 'center' as const })),
    animChannels: BEAVER_ANIM_CHANNELS,
    cellTier: 'fine',
    evaluate(root: Pose, anim: ArrayLike<number>, out: Pose[]) {
        for (let c = 0; c < BEAVER_ANIM_CHANNELS; c++) _fpAnim[c] = anim[c] ?? 0;
        _fpAnim[BEAVER_FIRST_PERSON] = 1;
        poseRig(root, _fpAnim);
        for (let k = 0; k < FP_LIMBS.length; k++) {
            const a = attachments[FP_LIMBS[k]];
            composePose(rig.world[a.joint], a.offset, out[k]);
        }
    }
};

/** World pose of the left hand (bucket grip), for attaching carried items. */
export function beaverLeftHand(root: Pose, anim: ArrayLike<number>, out: Pose): Pose {
    poseRig(root, anim);
    return composePose(rig.world[J.shoulderL], _hand, out);
}
