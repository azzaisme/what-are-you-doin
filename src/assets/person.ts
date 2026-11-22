/**
 * A tall, lanky, simple person: the stand-in player body from 2026-11-21 to 2026-11-22, kept behind
 * PLAYER_BODY in player-body.ts (owner request, 2026-11-21: "replace
 * (temporarily) the beavers with people… tall lanky simple people"). About 2 m tall: a small head,
 * a narrow torso, and very long thin arms and legs (fingertips just above the knee). Hard hat and
 * hi-vis vest, like the beavers.
 *
 * Same animation channels as the beaver (BEAVER_* in beaver.ts), so the sim, the network and the
 * body animator (src/sim/player-anim.ts) drive either. src/assets/player-body.ts chooses which.
 * Thin limbs use coverage25 sampling, so they stay solid on a 5-10 cm lattice.
 */

import { aabb, composePose, pose } from '../voxels/math.ts';
import type { Pose } from '../voxels/math.ts';
import { M, voxel } from '../voxels/palette.ts';
import { box, implicit, latticeShade, solid } from '../voxels/volumes.ts';

import { ASSET_SCHEMA_VERSION } from './asset.ts';
import type { AssetPart, VoxelAsset } from './asset.ts';
import {
    BEAVER_ANIM_CHANNELS,
    BEAVER_ARM_RAISE,
    BEAVER_ARM_REACH,
    BEAVER_ARM_SPREAD,
    BEAVER_CARRY,
    BEAVER_FIRST_PERSON,
    BEAVER_HEAD_PITCH,
    BEAVER_HEAD_YAW,
    BEAVER_LEAN,
    BEAVER_WALK_AMOUNT,
    BEAVER_WALK_PHASE,
    REACH_RISE
} from './beaver.ts';
import { attach, evaluateAttachments, Rig } from './rig.ts';
import type { Attachment } from './rig.ts';

export const PERSON_HEIGHT = 2.0;
/** Eye height above the feet (m). */
export const PERSON_EYE_HEIGHT = 1.86;
/** Shoulder height above the feet (m), and shoulder to fingertip (m). */
export const PERSON_SHOULDER_HEIGHT = 1.66;
export const PERSON_ARM_LENGTH = 0.84;
/** Distance walked per full walk cycle (two steps), m: long legs, long strides. */
export const PERSON_STRIDE = 1.6;

const HIP_Y = 1.02;
const LEG = 0.98;

const rig = new Rig([
    { name: 'pelvis', parent: -1, x: 0, y: HIP_Y, z: 0 },
    { name: 'spine', parent: 0, x: 0, y: 0.02, z: 0 },
    { name: 'head', parent: 1, x: 0, y: 0.76, z: 0.01 },
    { name: 'hipL', parent: 0, x: 0.08, y: 0, z: 0 },
    { name: 'hipR', parent: 0, x: -0.08, y: 0, z: 0 },
    { name: 'shoulderL', parent: 1, x: 0.2, y: PERSON_SHOULDER_HEIGHT - HIP_Y - 0.02, z: 0 },
    { name: 'shoulderR', parent: 1, x: -0.2, y: PERSON_SHOULDER_HEIGHT - HIP_Y - 0.02, z: 0 }
]);
const J = {
    pelvis: rig.index('pelvis'),
    spine: rig.index('spine'),
    head: rig.index('head'),
    hipL: rig.index('hipL'),
    hipR: rig.index('hipR'),
    shoulderL: rig.index('shoulderL'),
    shoulderR: rig.index('shoulderR')
};

// a hi-vis vest over a dark work shirt: two reflective bands
const torso = implicit(
    aabb(-0.15, -0.31, -0.075, 0.15, 0.31, 0.075),
    (x, y) => {
        // narrower at the waist than at the shoulders
        const half = 0.115 + 0.035 * ((y + 0.31) / 0.62);
        return Math.abs(x) < half;
    },
    (x, y, z) => {
        if ((y > -0.17 && y < -0.11) || (y > 0.05 && y < 0.11)) return voxel(M.HiVisStripe);
        // open front shows the shirt
        if (z > 0.05 && Math.abs(x) < 0.03) return voxel(M.Workwear, 1);
        return voxel(M.HiVis, latticeShade(x, y, z, 0.2, 3));
    }
);
const EYE_X = 0.04;
const EYE_Y = 0.01;
const head = implicit(
    aabb(-0.095, -0.125, -0.105, 0.095, 0.125, 0.105),
    (x, y, z) => (x * x) / (0.095 * 0.095) + (y * y) / (0.125 * 0.125) + (z * z) / (0.105 * 0.105) < 1,
    (x, y, z) => {
        if (z > 0.04 && Math.abs(y - EYE_Y) < 0.022 && Math.abs(Math.abs(x) - EYE_X) < 0.022) return voxel(M.Eye);
        return voxel(M.Skin, latticeShade(x, y, z, 0.25, 5) & 1);
    }
);
const hatDome = implicit(
    aabb(-0.11, 0, -0.12, 0.11, 0.08, 0.12),
    (x, y, z) => (x * x) / (0.11 * 0.11) + (y * y) / (0.08 * 0.08) + (z * z) / (0.12 * 0.12) < 1,
    (x, y, z) => voxel(M.HardHat, y > 0.06 ? 2 : latticeShade(x, y, z, 0.3, 7) & 1)
);
// long thin arms: sleeve to the elbow, then forearm and hand
const arm = implicit(
    aabb(-0.03, -PERSON_ARM_LENGTH / 2, -0.035, 0.03, PERSON_ARM_LENGTH / 2, 0.035),
    () => true,
    (x, y, z) => {
        if (y > 0.02) return voxel(M.Workwear, latticeShade(x, y, z, 0.2, 2));
        return voxel(M.Skin, y < -0.33 ? 2 : 0);
    }
);
const leg = box(0.04, LEG / 2 - 0.04, 0.045, (x, y, z) => voxel(M.Workwear, latticeShade(x, y, z, 0.2, 2)));

const parts: AssetPart[] = [];
const attachments: Attachment[] = [];
function part(p: AssetPart, a: Attachment): void {
    parts.push(p);
    attachments.push(a);
}

part({ name: 'torso', volume: torso, priority: 3, refColor: 0xf26a1b }, attach(J.spine, 0, 0.32, 0));
part(
    {
        name: 'hips',
        volume: box(0.12, 0.07, 0.065, solid(M.Workwear)),
        priority: 2,
        policy: 'coverage25',
        refColor: 0x34405a
    },
    attach(J.pelvis, 0, 0.0, 0)
);
part(
    {
        name: 'neck',
        volume: box(0.03, 0.06, 0.03, solid(M.Skin)),
        priority: 2,
        policy: 'coverage25',
        refColor: 0xd9a47e
    },
    attach(J.spine, 0, 0.69, 0)
);
part({ name: 'head', volume: head, priority: 3, refColor: 0xd9a47e }, attach(J.head, 0, 0.09, 0));
part({ name: 'hatDome', volume: hatDome, priority: 6, refColor: 0xf2c230 }, attach(J.head, 0, 0.16, 0));
part(
    {
        name: 'hatBrim',
        volume: box(0.12, 0.015, 0.14, solid(M.HardHat, 1)),
        priority: 6,
        policy: 'coverage25',
        refColor: 0xf2c230
    },
    attach(J.head, 0, 0.165, 0.015)
);
part(
    { name: 'armL', volume: arm, priority: 2, policy: 'coverage25', refColor: 0x34405a },
    attach(J.shoulderL, 0, -PERSON_ARM_LENGTH / 2, 0)
);
part(
    { name: 'armR', volume: arm, priority: 2, policy: 'coverage25', refColor: 0x34405a },
    attach(J.shoulderR, 0, -PERSON_ARM_LENGTH / 2, 0)
);
part(
    { name: 'legL', volume: leg, priority: 2, policy: 'coverage25', refColor: 0x34405a },
    attach(J.hipL, 0, -LEG / 2 + 0.02, 0)
);
part(
    { name: 'legR', volume: leg, priority: 2, policy: 'coverage25', refColor: 0x34405a },
    attach(J.hipR, 0, -LEG / 2 + 0.02, 0)
);
part(
    {
        name: 'footL',
        volume: box(0.045, 0.035, 0.09, solid(M.Boot)),
        priority: 3,
        policy: 'coverage25',
        refColor: 0x3b2a1e
    },
    attach(J.hipL, 0, -HIP_Y + 0.035, 0.035)
);
part(
    {
        name: 'footR',
        volume: box(0.045, 0.035, 0.09, solid(M.Boot)),
        priority: 3,
        policy: 'coverage25',
        refColor: 0x3b2a1e
    },
    attach(J.hipR, 0, -HIP_Y + 0.035, 0.035)
);

/** Parts left out in first person: the head and everything on it (the camera is inside). */
const HEAD_PART_SET = new Set(
    ['neck', 'head', 'hatDome', 'hatBrim'].map((n) => {
        const i = parts.findIndex((p) => p.name === n);
        if (i < 0) throw new Error(`person part ${n} missing`);
        return i;
    })
);
/** Raised arms turn inward by up to this much (rad), so both hands come into view. */
export const PERSON_ARM_INWARD = 0.05;
const ARM_INWARD = PERSON_ARM_INWARD;
/**
 * First person (the player's own camera): the shoulders come forward a little and the arms rest
 * in a ready pose, hands low in the view. The long arms reach what you hold without more help.
 */
const FP_SHOULDER = { x: -0.02, y: 0, z: 0.1 };
const FP_SPINE_Z = -0.06;
const FP_READY_RAISE = 1.25;

const _root = pose();
const _hand = pose(0, -PERSON_ARM_LENGTH + 0.03, 0.02);

export const personAsset: VoxelAsset = {
    schema: ASSET_SCHEMA_VERSION,
    name: 'person',
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
const SHOULDER_ABOVE_SPINE = PERSON_SHOULDER_HEIGHT - HIP_Y - 0.04;

function poseRig(root: Pose, anim: ArrayLike<number>): void {
    const phase = anim[BEAVER_WALK_PHASE] ?? 0;
    const amount = anim[BEAVER_WALK_AMOUNT] ?? 0;
    const carry = anim[BEAVER_CARRY] ?? 0;
    const headYaw = anim[BEAVER_HEAD_YAW] ?? 0;
    const fp = (anim[BEAVER_FIRST_PERSON] ?? 0) > 0.5;
    // empty-handed in first person, the arms are held up ready in view; holding something, they
    // aim at it like everyone else sees them
    const ready = fp && carry < 0.5;
    const raise = Math.max(ready ? FP_READY_RAISE : 0, Math.min(2.7, anim[BEAVER_ARM_RAISE] ?? 0));
    const reach = anim[BEAVER_ARM_REACH] ?? 0;
    const spread = anim[BEAVER_ARM_SPREAD] ?? 0;
    const lean = anim[BEAVER_LEAN] ?? 0;
    const headPitch = anim[BEAVER_HEAD_PITCH] ?? 0;

    const spinePitch = 0.06 * amount + 0.5 * Math.max(0, reach) - lean;
    // leaning back with raised arms, the shoulders slide forward along the torso (the arms reach
    // out), so the hands stay on what they hold
    const raised = Math.min(1, raise);
    const keep = SHOULDER_ABOVE_SPINE * Math.tan(Math.max(0, -spinePitch)) * raised;
    rig.setShift(J.spine, 0, 0, fp ? FP_SPINE_Z : 0);
    const sz = (ready ? FP_SHOULDER.z : 0) - (fp ? FP_SPINE_Z : 0) + reach + keep;
    const sy = (fp ? FP_SHOULDER.y : 0) + REACH_RISE * Math.max(0, reach);
    rig.setShift(J.shoulderL, fp ? -FP_SHOULDER.x : 0, sy, sz);
    rig.setShift(J.shoulderR, fp ? FP_SHOULDER.x : 0, sy, sz);
    // raised arms stop swinging; hanging arms swing fully
    const hang = Math.max(0, 1 - raise / 0.6);
    const inward = ARM_INWARD * Math.min(1, raise) - spread;
    const s = Math.sin(phase);
    const s2 = Math.sin(2 * phase);

    _root.p.x = root.p.x;
    // long legs: a bigger bob at the passing position
    _root.p.y = root.p.y + 0.045 * amount * (1 - Math.cos(2 * phase)) * 0.5;
    _root.p.z = root.p.z;
    _root.q.x = root.q.x;
    _root.q.y = root.q.y;
    _root.q.z = root.q.z;
    _root.q.w = root.q.w;

    rig.setRot(J.pelvis, 0.08 * amount * s, 0, 0.025 * amount * s);
    // the shoulders counter-rotate against the hips
    rig.setRot(J.spine, -0.12 * amount * s, spinePitch, 0);
    // raised arms keep aiming where the animation points them (at what you hold) as the torso
    // leans; hanging arms move with it
    const aim = raise + spinePitch * Math.min(1, raise);
    rig.setRot(J.head, headYaw + 0.1 * amount * s, -0.04 * amount * s2 - 0.7 * headPitch - 0.6 * spinePitch, 0);
    rig.setRot(J.hipL, 0, 0.45 * amount * s, 0);
    rig.setRot(J.hipR, 0, -0.45 * amount * s, 0);
    // long arms swing opposite the legs; the left one holds a bucket out a little when carrying
    rig.setRot(J.shoulderR, inward, -0.38 * amount * s * hang - aim, -0.06 * hang);
    rig.setRot(
        J.shoulderL,
        -inward,
        ((1 - carry) * 0.38 * amount * s - carry * 0.12) * hang - aim,
        (0.06 + carry * 0.1) * hang
    );
    rig.evaluate(_root);
}

/** Your own limbs in first person, on the 1 cm lattice (see beaverFirstPersonAsset). */
const FP_LIMBS = ['armL', 'armR', 'legL', 'legR', 'footL', 'footR'].map((n) => parts.findIndex((p) => p.name === n));
const _fpAnim = new Float64Array(BEAVER_ANIM_CHANNELS);
export const personFirstPersonAsset: VoxelAsset = {
    schema: ASSET_SCHEMA_VERSION,
    name: 'person-first-person',
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

/** World pose of the left hand, for attaching carried items. */
export function personLeftHand(root: Pose, anim: ArrayLike<number>, out: Pose): Pose {
    poseRig(root, anim);
    return composePose(rig.world[J.shoulderL], _hand, out);
}
