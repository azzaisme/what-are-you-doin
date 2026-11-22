/**
 * The River Lab entity catalogue: stable ids, names, voxel assets and overlap priorities, in snapshot
 * order. Physics-free, so the voxel worker can build its object table without loading Rapier.
 */

import type { VoxelAsset } from '../assets/asset.ts';
import { DUMMY_PARTS, dummyPartAsset } from '../assets/dummy.ts';
import {
    axeAsset,
    counterAsset,
    crownAsset,
    sawmillAsset,
    shortLogAsset,
    standMarkerAsset
} from '../assets/forestry.ts';
import { BODY } from '../assets/player-body.ts';
import {
    beamAsset,
    bucketAsset,
    cubeAsset,
    logAsset,
    plankAsset,
    sphereAsset,
    windsockAsset
} from '../assets/props.ts';
import { uteAsset } from '../assets/ute.ts';
import { SAWMILL } from '../levels/forestry.ts';
import { pose } from '../voxels/math.ts';
import type { Pose } from '../voxels/math.ts';
import { M } from '../voxels/palette.ts';

import { ANIM_MAX } from './snapshots.ts';

export const MAX_STRESS = 25;
/** Players per world: local split screen and networked guests share these slots. */
export const MAX_PLAYERS = 8;
export const DUMMY_ID0 = 200;
/** Extra prop pools, sized for the Valley (its seven areas each have their own timber or crates). */
export const EXTRA_PLANKS = 12;
export const EXTRA_BEAMS = 12;
export const EXTRA_LOGS = 2;
export const EXTRA_CRATES = 6;
/**
 * Forestry pools (Epic 6): stand trees per level, logs felled at once (each with its crown while
 * it falls), short logs bucked from them, and planks the sawmill makes. Sawn planks are ordinary
 * planks (`extra-plank-12` on), so everything that works with planks works with them.
 */
export const STAND_TREES = 6;
export const FELLED_LOGS = 6;
export const SHORT_LOGS = 6;
export const SAWN_PLANKS = 15;
/** Beams the sawmill makes in beam mode (`beam-12` on: ordinary beams). */
export const SAWN_BEAMS = 4;
/** The first sawn plank's `extra-plank-N` number. */
export const SAWN_PLANK0 = EXTRA_PLANKS;

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
    /** The level's windsock (hidden in levels without one). */
    windsock: SimEntity;
    /** Logging and sawing (hidden in levels without a stand or a sawmill). */
    forestry: ForestryEntities;
    /** Voxel beaver bodies for the players (shown in two-player mode). */
    avatars: SimEntity[];
    /** Your own limbs in first person (1 cm); drawn by the renderer only. */
    fpBody: SimEntity;
    /** Not voxelized: carries the character's eye pose through the snapshot ring. */
    player: SimEntity;
    /** Not voxelized: player 2's eye pose. */
    player2: SimEntity;
    /** Not voxelized: every player's eye pose, by slot (player, player2, player3, player4). */
    eyes: SimEntity[];
}

export interface ForestryEntities {
    /** One per stand tree: draws its cut and carries its state. */
    markers: SimEntity[];
    /** A falling tree's crown, by felled-log slot. */
    crowns: SimEntity[];
    felled: SimEntity[];
    short: SimEntity[];
    sawn: SimEntity[];
    /** Sawn beams (the sawmill's beam mode). */
    beams: SimEntity[];
    axe: SimEntity;
    sawmill: SimEntity;
    /** Effect counters (no voxels): where chips flew and needles burst, and how many times. */
    chips: SimEntity;
    needles: SimEntity;
}

export function createLabEntities(): LabEntities {
    const entities: SimEntity[] = [];
    const add = (id: number, name: string, asset: VoxelAsset, priority: number): SimEntity => {
        if (asset.animChannels > ANIM_MAX) throw new Error(`${name}: too many animation channels`);
        const e: SimEntity = {
            id,
            name,
            asset,
            priority,
            pose: pose(),
            anim: new Float64Array(ANIM_MAX),
            visible: true,
            slot: entities.length
        };
        entities.push(e);
        return e;
    };
    const beaver = add(1, 'beaver', BODY.asset, 3);
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
        const asset =
            kind === 0
                ? plankAsset(`stress-plank-${n}`)
                : kind === 1
                  ? cubeAsset(0.4, n % 2 ? M.TestBlue : M.TestOrange)
                  : logAsset();
        stress.push(add(100 + n, `stress-${n}`, asset, 0));
    }
    const dummy: SimEntity[] = [];
    for (let n = 0; n < DUMMY_PARTS.length; n++)
        dummy.push(add(DUMMY_ID0 + n, `dummy-${DUMMY_PARTS[n].name}`, dummyPartAsset(n), 2));
    const extras: SimEntity[] = [];
    for (let n = 0; n < EXTRA_PLANKS; n++)
        extras.push(add(300 + n, `extra-plank-${n}`, plankAsset(`extra-plank-${n}`), 1));
    for (let n = 0; n < EXTRA_BEAMS; n++) extras.push(add(320 + n, `beam-${n}`, beamAsset(`beam-${n}`), 1));
    for (let n = 0; n < EXTRA_LOGS; n++) extras.push(add(340 + n, `extra-log-${n}`, logAsset(), 1));
    for (let n = 0; n < EXTRA_CRATES; n++) extras.push(add(360 + n, `crate-${n}`, cubeAsset(0.5, M.Timber), 1));
    const windsock = add(950, 'windsock', windsockAsset(), 2);
    const markers: SimEntity[] = [];
    for (let n = 0; n < STAND_TREES; n++) markers.push(add(400 + n, `tree-${n}`, standMarkerAsset(), 4));
    const crowns: SimEntity[] = [];
    const felled: SimEntity[] = [];
    for (let n = 0; n < FELLED_LOGS; n++) {
        felled.push(add(420 + n, `felled-log-${n}`, logAsset(), 1));
        crowns.push(add(410 + n, `crown-${n}`, crownAsset(), 1));
    }
    const short: SimEntity[] = [];
    for (let n = 0; n < SHORT_LOGS; n++) short.push(add(430 + n, `short-log-${n}`, shortLogAsset(), 1));
    const sawn: SimEntity[] = [];
    for (let n = 0; n < SAWN_PLANKS; n++) {
        const name = `extra-plank-${SAWN_PLANK0 + n}`;
        sawn.push(add(380 + n, name, plankAsset(name), 1));
    }
    const beams: SimEntity[] = [];
    for (let n = 0; n < SAWN_BEAMS; n++) {
        const name = `beam-${EXTRA_BEAMS + n}`;
        beams.push(add(396 + n, name, beamAsset(name), 1));
    }
    const axe = add(440, 'axe', axeAsset(), 2);
    const sawmill = add(
        441,
        'sawmill',
        sawmillAsset(SAWMILL.blade.y, SAWMILL.blade.r, SAWMILL.housing.top, SAWMILL.lever),
        4
    );
    const chips = add(442, 'chips-fx', counterAsset('chips-fx'), 0);
    const needles = add(443, 'needles-fx', counterAsset('needles-fx'), 0);
    const forestry: ForestryEntities = { markers, crowns, felled, short, sawn, beams, axe, sawmill, chips, needles };
    for (const e of [...markers, ...crowns, ...felled, ...short, ...sawn, ...beams, axe, sawmill, chips, needles])
        e.visible = false;
    const avatars: SimEntity[] = [];
    for (let n = 0; n < MAX_PLAYERS; n++) avatars.push(add(910 + n, `avatar-${n}`, BODY.asset, 3));
    const eyes: SimEntity[] = [];
    for (let n = 0; n < MAX_PLAYERS; n++)
        eyes.push(add(900 + n, n === 0 ? 'player' : `player${n + 1}`, EMPTY_ASSET, 0));
    // your own limbs at 1 cm, drawn by the renderer in place of your beaver (never by the sim)
    const fpBody = add(960, 'fp-body', BODY.firstPerson, 3);
    fpBody.visible = false;
    return {
        entities,
        beaver,
        bucket,
        ute,
        plank,
        log,
        cube,
        sphere,
        held,
        stress,
        dummy,
        extras,
        windsock,
        forestry,
        avatars,
        fpBody,
        player: eyes[0],
        player2: eyes[1],
        eyes
    };
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
