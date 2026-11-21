/**
 * Which body the players (and the River Lab's walking NPC) have. Temporary: tall lanky people stand
 * in for the beavers (owner request, 2026-11-21). Set PLAYER_BODY back to 'beaver' to restore them;
 * nothing else needs to change. Both bodies share the beaver's animation channels.
 *
 * A module constant, not a URL setting: the voxel worker builds the same assets and has no page
 * URL, and every device in an online game must agree.
 */

import type { Pose } from '../voxels/math.ts';

import type { VoxelAsset } from './asset.ts';
import { beaverAsset, beaverFirstPersonAsset, beaverLeftHand } from './beaver.ts';
import {
    PERSON_ARM_LENGTH,
    PERSON_EYE_HEIGHT,
    PERSON_SHOULDER_HEIGHT,
    PERSON_STRIDE,
    personAsset,
    personFirstPersonAsset,
    personLeftHand
} from './person.ts';

export type BodyKind = 'person' | 'beaver';
export const PLAYER_BODY = 'person' as BodyKind;

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
    /** Held things are drawn in to this distance from the eye after a grab (m; Infinity: never). */
    comfortHold: number;
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
        comfortHold: 1.7
    },
    beaver: {
        asset: beaverAsset,
        firstPerson: beaverFirstPersonAsset,
        leftHand: beaverLeftHand,
        eyeHeight: 1.22,
        shoulderHeight: 0.84,
        armLength: 0.34,
        stride: 0.95,
        comfortHold: Infinity
    }
};

export const BODY: PlayerBody = BODIES[PLAYER_BODY];
