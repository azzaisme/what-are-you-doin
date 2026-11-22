/**
 * Which body the players (and the River Lab's walking NPC) have: the beaver engineers (design doc
 * §2.2). Tall lanky people stood in for them from 2026-11-21 to 2026-11-22 (owner request,
 * temporary; #90); set PLAYER_BODY to 'person' to bring them back. Both bodies share the beaver's
 * animation channels.
 *
 * A module constant, not a URL setting: the voxel worker builds the same assets and has no page
 * URL, and every device in an online game must agree.
 */

import type { Pose } from '../voxels/math.ts';

import type { VoxelAsset } from './asset.ts';
import { BEAVER_ARM_INWARD, BEAVER_ARM_LENGTH, beaverAsset, beaverFirstPersonAsset, beaverLeftHand } from './beaver.ts';
import {
    PERSON_ARM_INWARD,
    PERSON_ARM_LENGTH,
    PERSON_EYE_HEIGHT,
    PERSON_SHOULDER_HEIGHT,
    PERSON_STRIDE,
    personAsset,
    personFirstPersonAsset,
    personLeftHand
} from './person.ts';

export type BodyKind = 'person' | 'beaver';
export const PLAYER_BODY = 'beaver' as BodyKind;

export interface PlayerBody {
    asset: VoxelAsset;
    /** Your own limbs on the 1 cm lattice, drawn for your camera in first person. */
    firstPerson: VoxelAsset;
    leftHand(root: Pose, anim: ArrayLike<number>, out: Pose): Pose;
    /** Above the feet (m). */
    eyeHeight: number;
    shoulderHeight: number;
    armLength: number;
    /** Distance walked per walk cycle (m). */
    stride: number;
    /** Half the distance between the shoulders (m). */
    shoulderHalfWidth: number;
    /** How far raised arms turn in with no spread (rad). */
    armInward: number;
    /**
     * How far from the shoulders held things are carried (m): where the hands are, with the arms
     * out (Infinity: wherever they were grabbed).
     */
    holdReach: number;
    /** The nearest the eye a thing in your hands is carried (m). */
    holdMin: number;
    /** How far the shoulders may reach forward into what you hold (m). */
    reachMax: number;
    /**
     * The grab lets go when what you hold is dragged this far from your hands for a moment (m), or
     * at once beyond `snapDistance`: shorter arms hold on less far.
     */
    breakDistance: number;
    snapDistance: number;
}

const BODIES: Record<BodyKind, PlayerBody> = {
    person: {
        asset: personAsset,
        firstPerson: personFirstPersonAsset,
        leftHand: personLeftHand,
        eyeHeight: PERSON_EYE_HEIGHT,
        shoulderHeight: PERSON_SHOULDER_HEIGHT,
        armLength: PERSON_ARM_LENGTH,
        stride: PERSON_STRIDE,
        shoulderHalfWidth: 0.2,
        armInward: PERSON_ARM_INWARD,
        // arm's length and a little reach into it
        holdReach: PERSON_ARM_LENGTH + 0.06,
        holdMin: 0.7,
        reachMax: 0.2,
        breakDistance: 1.25,
        snapDistance: 2.2
    },
    beaver: {
        asset: beaverAsset,
        firstPerson: beaverFirstPersonAsset,
        leftHand: beaverLeftHand,
        eyeHeight: 1.22,
        shoulderHeight: 0.84,
        armLength: BEAVER_ARM_LENGTH,
        stride: 0.95,
        shoulderHalfWidth: 0.3,
        armInward: BEAVER_ARM_INWARD,
        // short arms, so the beaver leans in and reaches out with its shoulders to carry things
        // well out in front, about where a person holds them
        holdReach: BEAVER_ARM_LENGTH + 0.35,
        holdMin: 0.7,
        reachMax: 0.45,
        // a reach of 0.95 m with the lean, against a person's 1.04 m: a hard yank tears it out of
        // the paws sooner
        breakDistance: 1.25,
        snapDistance: 1.8
    }
};

export const BODY: PlayerBody = BODIES[PLAYER_BODY];
