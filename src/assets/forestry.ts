/**
 * Forestry assets (Epic 6): the moving voxel parts of logging and sawing.
 *
 * - stand marker: one per stand tree, at its foot. Draws the growing cut (a pale band of exposed
 *   wood around the trunk at the cut height, widening as the cut deepens) and carries the tree's
 *   state in its animation channels, so guests and the voxel worker learn of a felled or regrown
 *   tree from the same snapshots as everything else;
 * - crown: a falling tree's needle tiers and upper trunk, riding on its log until it breaks off;
 * - sawmill: the turning blade, the status lamp and the progress bar;
 * - axe, short log.
 *
 * The static trees, the stump and the machine's frame are drawn by src/levels/forestry.ts.
 */

import { PINE_TIERS } from '../levels/common.ts';
import {
    CROWN_TRUNK_TOP,
    LOG_LENGTH,
    STAND_CROWN_LIFT,
    STAND_SCALE,
    STUMP_HEIGHT,
    needleCone
} from '../levels/forestry.ts';
import { aabb, composePose, pose, quatFromAxisAngle, quatMul, quatRotate } from '../voxels/math.ts';
import type { Pose } from '../voxels/math.ts';
import { M, voxel } from '../voxels/palette.ts';
import { box, cylinder, implicit, latticeShade, solid } from '../voxels/volumes.ts';

import { ASSET_SCHEMA_VERSION } from './asset.ts';
import type { AssetPart, VoxelAsset } from './asset.ts';
import { LOG_RADIUS } from './props.ts';

// ------------------------------------------------------------------------------- stand marker

/** Stand marker channels: cut progress (0-1), state (TREE_*), unused. */
export const TREE_CUT = 0;
export const TREE_STATE = 1;
export const TREE_STANDING = 0;
export const TREE_DOWN = 1;
/** Number of notch sizes drawn (the cut is shown in this many steps). */
const NOTCH_STEPS = 4;

/**
 * The marker's root is the tree's foot, turned so local +z faces the side being cut. Each notch
 * part is a band of pale wood a little proud of the bark, covering more of the trunk's
 * circumference as the cut deepens (a quarter, half, three quarters, all of it).
 */
export function standMarkerAsset(): VoxelAsset {
    const parts: AssetPart[] = [];
    const bandY = STUMP_HEIGHT + 0.04;
    for (let n = 0; n < NOTCH_STEPS; n++) {
        const half = ((n + 1) / NOTCH_STEPS) * Math.PI;
        const r = LOG_RADIUS + 0.03;
        parts.push({
            name: `notch-${n}`,
            volume: implicit(
                aabb(-r, bandY - 0.07, -r, r, bandY + 0.07, r),
                (x, _y, z) => {
                    const rr = Math.hypot(x, z);
                    return rr < r && rr > LOG_RADIUS - 0.08 && Math.abs(Math.atan2(x, z)) <= half;
                },
                (x, y, z) => voxel(M.TimberEnd, latticeShade(x, y, z, 0.05, 5) & 1)
            ),
            priority: 4,
            refColor: 0xdbb07a
        });
    }
    return {
        schema: ASSET_SCHEMA_VERSION,
        name: 'stand-marker',
        parts,
        animChannels: 2,
        cellTier: 'base',
        evaluate(root: Pose, _anim: ArrayLike<number>, out: Pose[]) {
            for (let i = 0; i < parts.length; i++) composePose(root, IDENTITY, out[i]);
        },
        partHidden(anim: ArrayLike<number>, part: number) {
            if (anim[TREE_STATE] > 0.5) return true;
            const cut = anim[TREE_CUT];
            if (!(cut > 0.001)) return true;
            const step = Math.min(NOTCH_STEPS - 1, Math.floor(cut * NOTCH_STEPS));
            return part !== step;
        }
    };
}

const IDENTITY = pose();

// ------------------------------------------------------------------------------- crown

/** The log's centre above the ground while the tree stands. */
export const LOG_CENTRE_HEIGHT = STUMP_HEIGHT + LOG_LENGTH / 2;

/**
 * A falling tree's crown in its log's frame (the log's long axis, local +x, points up the tree):
 * the trunk above the log and the four needle tiers. Never collides: it rides on the log while the
 * tree falls and breaks off when it lands.
 */
export function crownAsset(): VoxelAsset {
    const s = STAND_SCALE;
    // cones and the trunk are built along +y; this turns +y onto the log's +x
    const yToX = quatFromAxisAngle(0, 0, 1, -Math.PI / 2);
    const parts: AssetPart[] = [];
    const offsets: Pose[] = [];
    const top = LOG_LENGTH / 2;
    const trunkHalf = (CROWN_TRUNK_TOP - STUMP_HEIGHT - LOG_LENGTH) / 2;
    parts.push({
        name: 'crown-trunk',
        volume: cylinder('y', LOG_RADIUS * 0.85, trunkHalf, (x, y, z) =>
            voxel(M.Bark, latticeShade(x, y * 0.5, z, 0.1, 4))
        ),
        priority: 1,
        refColor: 0x5a3e2a
    });
    offsets.push(pose(top + trunkHalf, 0, 0, { ...yToX }));
    PINE_TIERS.forEach((t, n) => {
        parts.push({
            name: `tier-${n}`,
            volume: needleCone(t.r * s, t.h * s, 31 + n),
            priority: 2,
            refColor: 0x2f5a35
        });
        offsets.push(pose(t.y * s + STAND_CROWN_LIFT - LOG_CENTRE_HEIGHT, 0, 0, { ...yToX }));
    });
    return {
        schema: ASSET_SCHEMA_VERSION,
        name: 'crown',
        parts,
        animChannels: 0,
        evaluate(root: Pose, _anim: ArrayLike<number>, out: Pose[]) {
            for (let i = 0; i < parts.length; i++) composePose(root, offsets[i], out[i]);
        }
    };
}

// ------------------------------------------------------------------------------- sawmill

/** Sawmill channels: blade angle (rad), cut progress (0-1), state (SAW_*), mode (SAW_PLANKS/SAW_BEAM). */
export const SAW_SPIN = 0;
export const SAW_PROGRESS = 1;
export const SAW_STATE = 2;
export const SAW_MODE = 3;
export const SAW_PLANKS = 0;
export const SAW_BEAM = 1;
export const SAW_READY = 0;
export const SAW_CUTTING = 1;
export const SAW_STOPPED = 2;
/** Progress bar segments. */
const SAW_BAR = 5;

/**
 * The sawmill's moving parts, in the machine's frame (src/levels/forestry.ts SAWMILL): the blade
 * (a disc across the feed line, axis z, with dark teeth so its turning shows), a lamp on the motor
 * (green ready, orange sawing, red stopped) and a progress bar along the beam.
 */
export function sawmillAsset(
    bladeY: number,
    bladeR: number,
    top: number,
    lever: { x: number; y: number; z: number }
): VoxelAsset {
    const parts: AssetPart[] = [];
    const offsets: Pose[] = [];
    // blade: built in the x-y plane (a z cylinder), teeth every 45 degrees
    parts.push({
        name: 'blade',
        volume: cylinder('z', bladeR, 0.025, (x, y) => {
            const r = Math.hypot(x, y);
            const a = Math.atan2(y, x);
            const spoke = Math.abs(Math.sin(a * 2)) < 0.22 && r < bladeR - 0.08;
            return voxel(r > bladeR - 0.07 ? M.Chrome : spoke ? M.UteTrim : M.Steel, 0);
        }),
        priority: 4,
        refColor: 0xd7dade
    });
    offsets.push(pose(0, bladeY, 0));
    // lamp: one part per state, on the motor's front
    for (const [name, mat] of [
        ['lamp-ready', M.Leaf],
        ['lamp-cutting', M.HiVis],
        ['lamp-stopped', M.Taillight]
    ] as const) {
        parts.push({ name, volume: box(0.08, 0.07, 0.08, solid(mat, 0)), priority: 5, refColor: 0xf26a1b });
        offsets.push(pose(0.34, top + 0.28, 0));
    }
    // progress bar: segments along the beam's infeed face
    for (let n = 0; n < SAW_BAR; n++) {
        parts.push({
            name: `bar-${n}`,
            volume: box(0.06, 0.05, 0.04, solid(M.HiVis, 2)),
            priority: 5,
            refColor: 0xf26a1b
        });
        offsets.push(pose(0.47, top - 0.1, -0.4 + (n * 0.8) / (SAW_BAR - 1)));
    }
    // the mode lever on the near post: thrown towards the infeed for planks, the outfeed for a beam
    const LEVER_HALF = 0.17;
    for (const [name, angle] of [
        ['lever-planks', -0.6],
        ['lever-beam', 0.6]
    ] as const) {
        parts.push({
            name,
            volume: box(0.025, LEVER_HALF, 0.025, (_x, y) => voxel(y > LEVER_HALF - 0.06 ? M.HiVis : M.UteTrim, 0)),
            priority: 5,
            refColor: 0xf26a1b
        });
        const q = quatFromAxisAngle(0, 0, 1, angle);
        const v = { x: 0, y: 0, z: 0 };
        quatRotate(q, 0, LEVER_HALF, 0, v);
        offsets.push(pose(lever.x + v.x, lever.y + v.y, lever.z + v.z, q));
    }
    const LEVER0 = parts.length - 2;
    const spin = { x: 0, y: 0, z: 0, w: 1 };
    const tmp = pose();
    return {
        schema: ASSET_SCHEMA_VERSION,
        name: 'sawmill',
        parts,
        animChannels: 4,
        cellTier: 'base',
        evaluate(root: Pose, anim: ArrayLike<number>, out: Pose[]) {
            // the blade turns about its own axis (z)
            quatFromAxisAngle(0, 0, 1, anim[SAW_SPIN], spin);
            tmp.p.x = offsets[0].p.x;
            tmp.p.y = offsets[0].p.y;
            tmp.p.z = offsets[0].p.z;
            quatMul(offsets[0].q, spin, tmp.q);
            composePose(root, tmp, out[0]);
            for (let i = 1; i < parts.length; i++) composePose(root, offsets[i], out[i]);
        },
        partHidden(anim: ArrayLike<number>, part: number) {
            if (part === 0) return false;
            if (part >= LEVER0) return part - LEVER0 !== (anim[SAW_MODE] > 0.5 ? SAW_BEAM : SAW_PLANKS);
            const state = Math.round(anim[SAW_STATE]);
            if (part <= 3) return part - 1 !== state;
            const seg = part - 4;
            return !(anim[SAW_PROGRESS] > (seg + 0.5) / SAW_BAR);
        }
    };
}

// ------------------------------------------------------------------------------- tools and pieces

/** Axe: a 0.8 m handle along local y, the head at the top (+y), the edge towards +x. */
export const AXE = { handleHalf: 0.4, headY: 0.33 } as const;
export function axeAsset(): VoxelAsset {
    const handle = box(0.03, AXE.handleHalf, 0.03, (x, y, z) => voxel(M.Timber, latticeShade(x, y, z, 0.1, 7) & 1));
    const head = box(0.11, 0.06, 0.035, (x) => voxel(x > 0.07 ? M.Chrome : M.Steel, 0));
    const grip = box(0.04, 0.08, 0.04, solid(M.HiVis, 0));
    const offsets = [pose(), pose(0.05, AXE.headY, 0), pose(0, -AXE.handleHalf + 0.1, 0)];
    const parts: AssetPart[] = [
        { name: 'handle', volume: handle, priority: 1, refColor: 0xc48d55 },
        { name: 'head', volume: head, priority: 2, refColor: 0x9aa0a6 },
        { name: 'grip', volume: grip, priority: 2, refColor: 0xf26a1b }
    ];
    return {
        schema: ASSET_SCHEMA_VERSION,
        name: 'axe',
        parts,
        animChannels: 0,
        cellTier: 'base',
        evaluate(root: Pose, _anim: ArrayLike<number>, out: Pose[]) {
            for (let i = 0; i < parts.length; i++) composePose(root, offsets[i], out[i]);
        }
    };
}

/** Short log: a log bucked in half (radius 0.2 m, 1.0 m long, long axis X), light enough to carry alone. */
export const SHORT_LOG_HALF = 0.5;
export function shortLogAsset(): VoxelAsset {
    const v = implicit(
        aabb(-SHORT_LOG_HALF, -LOG_RADIUS, -LOG_RADIUS, SHORT_LOG_HALF, LOG_RADIUS, LOG_RADIUS),
        (_x, y, z) => y * y + z * z < LOG_RADIUS * LOG_RADIUS,
        (x, y, z) => {
            const r = Math.hypot(y, z);
            if (Math.abs(x) > SHORT_LOG_HALF - 0.08) return voxel(M.LogEnd, Math.floor(r / 0.06) & 1 ? 1 : 2);
            return voxel(M.LogBark, latticeShade(x, Math.atan2(z, y), 0, 0.25, 9));
        }
    );
    const local = pose();
    const parts: AssetPart[] = [{ name: 'short-log', volume: v, priority: 1, refColor: 0x6b4a30 }];
    return {
        schema: ASSET_SCHEMA_VERSION,
        name: 'short-log',
        parts,
        animChannels: 0,
        evaluate(root: Pose, _anim: ArrayLike<number>, out: Pose[]) {
            composePose(root, local, out[0]);
        }
    };
}

/** An entity with no voxels that carries a counter (effects: chips, needles) through snapshots. */
export function counterAsset(name: string): VoxelAsset {
    return {
        schema: ASSET_SCHEMA_VERSION,
        name,
        parts: [],
        animChannels: 1,
        evaluate() {
            // nothing to draw
        }
    };
}
