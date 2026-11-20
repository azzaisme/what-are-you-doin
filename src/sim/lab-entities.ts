/**
 * The River Lab entity catalogue: stable ids, names, voxel assets and overlap priorities, in snapshot
 * order. Physics-free, so the voxel worker can build its object table without loading Rapier.
 */

import type { VoxelAsset } from '../assets/asset.ts';
import { beaverAsset } from '../assets/beaver.ts';
import { DUMMY_PARTS, dummyPartAsset } from '../assets/dummy.ts';
import { beamAsset, bucketAsset, cubeAsset, logAsset, plankAsset, sphereAsset } from '../assets/props.ts';
import { uteAsset } from '../assets/ute.ts';
import { pose } from '../voxels/math.ts';
import type { Pose } from '../voxels/math.ts';
import { M } from '../voxels/palette.ts';

import { ANIM_MAX } from './snapshots.ts';

export const MAX_STRESS = 25;
export const DUMMY_ID0 = 200;
export const EXTRA_PLANKS = 5;
export const EXTRA_BEAMS = 2;
export const EXTRA_LOGS = 2;

export interface SimEntity {
    /** Stable identity, also the voxel object id. */
    id: number;
    name: string;
    asset: VoxelAsset;
    /** Cross-object overlap priority (higher wins). */
    priority: number;
    pose: Pose;
    anim: Float64Array;
    visible: boolean;
    /** Index in snapshot buffers. */
    slot: number;
}

export interface LabEntities {
    entities: SimEntity[];
    beaver: SimEntity;
    bucket: SimEntity;
    ute: SimEntity;
    plank: SimEntity;
    log: SimEntity;
    cube: SimEntity;
    sphere: SimEntity;
    held: SimEntity;
    stress: SimEntity[];
    dummy: SimEntity[];
    /** Extra level props (more planks, beams, logs); hidden unless a level places them. */
    extras: SimEntity[];
    /** Not voxelized: carries the character's eye pose through the snapshot ring. */
    player: SimEntity;
}

export function createLabEntities(): LabEntities {
    const entities: SimEntity[] = [];
    const add = (id: number, name: string, asset: VoxelAsset, priority: number): SimEntity => {
        if (asset.animChannels > ANIM_MAX) throw new Error(`${name}: too many animation channels`);
        const e: SimEntity = { id, name, asset, priority, pose: pose(), anim: new Float64Array(ANIM_MAX), visible: true, slot: entities.length };
        entities.push(e);
        return e;
    };
    const beaver = add(1, 'beaver', beaverAsset, 3);
    const bucket = add(2, 'bucket', bucketAsset(), 4);
    const ute = add(3, 'ute', uteAsset, 2);
    const plank = add(4, 'plank', plankAsset(), 1);
    const log = add(5, 'log', logAsset(), 1);
    const cube = add(6, 'cube', cubeAsset(), 1);
    const sphere = add(7, 'sphere', sphereAsset(), 1);
    const held = add(8, 'held-plank', plankAsset('held-plank'), 5);
    const stress: SimEntity[] = [];
    for (let n = 0; n < MAX_STRESS; n++) {
        const kind = n % 3;
        const asset = kind === 0 ? plankAsset(`stress-plank-${n}`) : kind === 1 ? cubeAsset(0.4, n % 2 ? M.TestBlue : M.TestOrange) : logAsset();
        stress.push(add(100 + n, `stress-${n}`, asset, 0));
    }
    const dummy: SimEntity[] = [];
    for (let n = 0; n < DUMMY_PARTS.length; n++) dummy.push(add(DUMMY_ID0 + n, `dummy-${DUMMY_PARTS[n].name}`, dummyPartAsset(n), 2));
    const extras: SimEntity[] = [];
    for (let n = 0; n < EXTRA_PLANKS; n++) extras.push(add(300 + n, `extra-plank-${n}`, plankAsset(`extra-plank-${n}`), 1));
    for (let n = 0; n < EXTRA_BEAMS; n++) extras.push(add(320 + n, `beam-${n}`, beamAsset(`beam-${n}`), 1));
    for (let n = 0; n < EXTRA_LOGS; n++) extras.push(add(340 + n, `extra-log-${n}`, logAsset(), 1));
    const player = add(900, 'player', EMPTY_ASSET, 0);
    return { entities, beaver, bucket, ute, plank, log, cube, sphere, held, stress, dummy, extras, player };
}

const EMPTY_ASSET: VoxelAsset = {
    schema: 1,
    name: 'empty',
    parts: [],
    animChannels: 0,
    evaluate() {
        // no parts to pose
    }
};

export type { Pose };
