/**
 * Forestry (Epic 6, design doc §2.5), the level side: a logging stand of trees that can be cut
 * down, and a sawmill. Plain data and pure functions shared by the voxel build (the worker), the
 * physics and the simulation, so every device draws the same trees and the same machine.
 *
 * Only the stand's trees can be felled: the rest of the forest stays scenery (no full ecosystem
 * destructibility). A stand tree is a pine with a log-sized trunk:
 *
 *   - a stump STUMP_HEIGHT tall stays in the ground when it is cut;
 *   - the trunk above the cut is exactly one log (LOG_RADIUS x 2 m, the props' log), so the felled
 *     trunk simply becomes a physical log;
 *   - the crown (needle tiers and the trunk above the log) falls with it, then breaks off.
 *
 * The sawmill is described in its own frame: logs go in at +x (the infeed guide), pass the blade at
 * x = 0 and come out as planks on the outfeed rack at -x. Its frame, housing, guide rails and rack
 * are static pieces (voxels and colliders); the blade, the status lamp and the progress bar move
 * (the `sawmill` entity, src/assets/forestry.ts).
 *
 * Engine-free and physics-free.
 */

import { LOG_RADIUS } from '../assets/props.ts';
import { pose, quatFromAxisAngle, quatFromYawPitchRoll, quatMul, quatRotate } from '../voxels/math.ts';
import type { Pose, Quat } from '../voxels/math.ts';
import { M, voxel, voxelMaterial } from '../voxels/palette.ts';
import type { RasterStats } from '../voxels/rasterizer.ts';
import { cone, cylinder, latticeShade, solid } from '../voxels/volumes.ts';
import type { MaterialField, Volume } from '../voxels/volumes.ts';
import type { VoxelWorld } from '../voxels/world.ts';

import { PINE_TIERS } from './common.ts';
import type { StaticPiece } from './level.ts';

/** Height of the cut above the ground: what stays standing as a stump. */
export const STUMP_HEIGHT = 0.3;
/** Length of the trunk above the cut that becomes the log (the props' log: 2 m). */
export const LOG_LENGTH = 2.0;
/** Stand trees are pines of this scale (their trunk radius is the log's). */
export const STAND_SCALE = 1.3;
/**
 * The crown sits this much higher than a scenery pine's: a clear trunk to chew at (a tall player's
 * eye stays below the needles) that is one whole log long.
 */
export const STAND_CROWN_LIFT = 1.0;
/** The crown: the trunk carries on above the log up into the needle tiers. */
export const CROWN_TRUNK_TOP = 5.2;

export interface StandTree {
    x: number;
    z: number;
    /** Turns the needle pattern (looks only). */
    yaw: number;
    /**
     * How the tree leans (its weight): a horizontal vector towards the lean whose length is the
     * tilt from upright (rad). A leaning tree is drawn leaning, and its weight pulls the fall its
     * way (src/sim/forestry.ts). Absent: upright.
     */
    lean?: { x: number; z: number };
}

/** The tilt of a leaning stand tree: up turned towards its lean by the lean's length. */
export function standTilt(t: StandTree, out: Quat = { x: 0, y: 0, z: 0, w: 1 }): Quat {
    const lx = t.lean?.x ?? 0;
    const lz = t.lean?.z ?? 0;
    const a = Math.hypot(lx, lz);
    // up x lean: turning about it tips the top towards the lean
    return quatFromAxisAngle(lz, 0, -lx, a, out);
}

/** The pose of a point of a stand tree `y` up its (leaning) axis from its foot, with its yaw. */
export function standPose(t: StandTree, ground: number, y: number): Pose {
    const tilt = standTilt(t);
    const v = { x: 0, y: 0, z: 0 };
    quatRotate(tilt, 0, y, 0, v);
    return pose(t.x + v.x, ground + v.y, t.z + v.z, quatMul(tilt, quatFromYawPitchRoll(t.yaw, 0, 0)));
}

export interface SawmillSpot {
    x: number;
    z: number;
    /** Heading of the machine's +x (infeed) axis, about +y. */
    yaw: number;
    /** Ground height at the machine (the yard pad is flat). */
    y: number;
}

export interface ForestryDef {
    /** The logging stand: trees that can be chewed or chopped down. */
    trees: StandTree[];
    sawmill: SawmillSpot | null;
    /** Where the axe starts (leaning by the sawmill), and where it comes back to when lost. */
    axe: Pose | null;
    /** The voxel ground surface the trees stand on (the level build's own). */
    ground(x: number, z: number): number;
}

// ------------------------------------------------------------------------------- sawmill frame

/** The sawmill's layout in its own frame (m). */
export const SAWMILL = {
    /** Infeed guide: logs lie here, along the x axis, between two low rails. */
    guide: { x0: 1.0, x1: 3.4, halfZ: 0.55, railH: 0.1 },
    /** A log in the guide counts when its centre is this close to the guide's middle (along x). */
    guideSlack: 0.75,
    /** The housing over the blade: posts either side, a beam over the top (a beaver walks under it). */
    housing: { halfX: 0.45, postZ: 0.62, top: 1.75 },
    /** The blade's centre height and radius. */
    blade: { y: 0.42, r: 0.42 },
    /** The blade guard zone: a player inside it stops the saw. */
    guard: { halfX: 0.8, halfZ: 0.85 },
    /** Outfeed rack: planks come out here, side by side, long axis x. */
    outfeed: { x: -2.05, bars: [-1.05, -2.05, -3.05], barTop: 0.1, laneZ: [-0.3, 0, 0.3] },
    /** The mode lever's pivot (on the near post): grab it to switch between planks and a beam. */
    lever: { x: 0.2, y: 0.95, z: -0.8 },
    /** Height of the log's centre while it is fed through. */
    feedY: LOG_RADIUS + 0.02
} as const;

/** A point in the sawmill's frame, in the world. */
export function sawmillToWorld(
    s: SawmillSpot,
    lx: number,
    ly: number,
    lz: number
): { x: number; y: number; z: number } {
    const q = quatFromYawPitchRoll(s.yaw, 0, 0);
    const v = { x: 0, y: 0, z: 0 };
    quatRotate(q, lx, ly, lz, v);
    return { x: s.x + v.x, y: s.y + v.y, z: s.z + v.z };
}

/** A world point in the sawmill's frame. */
export function worldToSawmill(s: SawmillSpot, x: number, y: number, z: number): { x: number; y: number; z: number } {
    const q = quatFromYawPitchRoll(-s.yaw, 0, 0);
    const v = { x: 0, y: 0, z: 0 };
    quatRotate(q, x - s.x, y - s.y, z - s.z, v);
    return v;
}

const steel: MaterialField = solid(M.Steel, 1);
const dark: MaterialField = solid(M.UteTrim, 0);
const frameTimber: MaterialField = (x, y, z) => voxel(M.LogBark, latticeShade(x, y, z, 0.2, 6) & 1);

/** The sawmill's static parts: housing, motor, guide rails, outfeed rack, a sign. */
export function sawmillPieces(s: SawmillSpot): StaticPiece[] {
    const P: StaticPiece[] = [];
    const q = quatFromYawPitchRoll(s.yaw, 0, 0);
    const add = (
        name: string,
        shape: StaticPiece['shape'],
        lx: number,
        ly: number,
        lz: number,
        field: MaterialField,
        priority = 3,
        collide = true
    ) => {
        const w = sawmillToWorld(s, lx, ly, lz);
        P.push({ name, shape, pose: pose(w.x, w.y, w.z, { ...q }), field, collide, priority });
    };
    const H = SAWMILL.housing;
    const G = SAWMILL.guide;
    // housing: two posts and a beam over the feed line, the motor on top
    for (const z of [-H.postZ, H.postZ])
        add('saw-post', { type: 'box', hx: 0.12, hy: H.top / 2, hz: 0.08 }, 0, H.top / 2, z, steel);
    add('saw-beam', { type: 'box', hx: H.halfX, hy: 0.1, hz: H.postZ + 0.08 }, 0, H.top - 0.1, 0, steel);
    add('saw-motor', { type: 'box', hx: 0.3, hy: 0.2, hz: 0.24 }, 0, H.top + 0.2, 0, (_x, y) =>
        voxel(y > 0.08 ? M.HiVis : M.UteTrim, 0)
    );
    // the mode lever's mount on the near post
    const L = SAWMILL.lever;
    add('saw-lever-mount', { type: 'box', hx: 0.06, hy: 0.06, hz: 0.04 }, L.x, L.y, L.z + 0.04, dark, 3, false);
    // the blade guard: a hood over the top of the blade (the blade itself turns: the entity)
    add('saw-hood', { type: 'box', hx: 0.5, hy: 0.04, hz: 0.1 }, 0, SAWMILL.blade.y + SAWMILL.blade.r + 0.1, 0, dark);
    // infeed guide: two low rails along x
    const gx = (G.x0 + G.x1) / 2;
    const ghx = (G.x1 - G.x0) / 2;
    for (const z of [-G.halfZ - 0.03, G.halfZ + 0.03])
        add('saw-rail', { type: 'box', hx: ghx, hy: G.railH / 2, hz: 0.03 }, gx, G.railH / 2, z, frameTimber);
    // feed table under the blade (logs slide across it)
    add('saw-table', { type: 'box', hx: H.halfX + 0.25, hy: 0.02, hz: 0.42 }, 0, 0.02, 0, steel, 2);
    // outfeed rack: bars across the plank lanes
    const O = SAWMILL.outfeed;
    for (const x of O.bars)
        add('saw-rack', { type: 'box', hx: 0.06, hy: O.barTop / 2, hz: 0.62 }, x, O.barTop / 2, 0, frameTimber);
    // a sign by the infeed: hi-vis board on a post (no collision for the board)
    add('saw-sign-post', { type: 'box', hx: 0.04, hy: 0.55, hz: 0.04 }, G.x1 + 0.3, 0.55, G.halfZ + 0.9, dark);
    add(
        'saw-sign',
        { type: 'box', hx: 0.03, hy: 0.18, hz: 0.32 },
        G.x1 + 0.3,
        1.2,
        G.halfZ + 0.9,
        (_x, y, z) =>
            voxel(Math.abs(y) < 0.1 && Math.abs(z) < 0.24 && (Math.floor(z / 0.08) & 1) === 0 ? M.UteTrim : M.HiVis, 0),
        3,
        false
    );
    return P;
}

// ------------------------------------------------------------------------------- stand trees

/** Materials a stand tree is made of (what felling clears from the static layer). */
const TREE_MATERIALS = new Set<number>([M.Bark, M.Needle, M.NeedleLight, M.LogBark, M.LogEnd, M.HiVis]);

/** Radius of a stand tree's crown footprint (m), for spacing and clearing. */
export const STAND_CROWN_RADIUS = PINE_TIERS[0].r * STAND_SCALE;

interface TreeVolume {
    volume: Volume;
    /** Offset of the volume's origin above the ground. */
    y: number;
    priority: number;
}

function treeVolumes(seed: number): TreeVolume[] {
    const s = STAND_SCALE;
    const out: TreeVolume[] = [];
    // the trunk from the ground into the crown (the static tree draws it whole)
    const trunkHalf = CROWN_TRUNK_TOP / 2;
    out.push({
        volume: cylinder('y', LOG_RADIUS, trunkHalf, (lx, ly, lz) =>
            voxel(M.Bark, latticeShade(lx, ly * 0.5, lz, 0.1, seed))
        ),
        y: trunkHalf - 0.05,
        priority: 1
    });
    // the stand's mark: a hi-vis band at chest height says "this one may be cut"
    out.push({
        volume: cylinder('y', LOG_RADIUS + 0.02, 0.05, solid(M.HiVis, 0)),
        y: 0.95,
        priority: 3
    });
    for (let n = 0; n < PINE_TIERS.length; n++) {
        const t = PINE_TIERS[n];
        out.push({ volume: needleCone(t.r * s, t.h * s, seed * 7 + n), y: t.y * s + STAND_CROWN_LIFT, priority: 2 });
    }
    return out;
}

/** A needle tier (the same look as the scenery pines). */
export function needleCone(r: number, h: number, seed: number): Volume {
    return cone(r, h, (lx, ly, lz) => {
        const rr = Math.hypot(lx, lz) / (r * (1 - ly / h) + 1e-6);
        const lit = rr > 0.72 && ly > h * 0.15;
        return voxel(lit ? M.NeedleLight : M.Needle, latticeShade(lx, ly, lz, 0.2, seed));
    });
}

/** The stump left by felling: bark sides, a pale cut face with rings. */
function stumpVolume(): Volume {
    const half = (STUMP_HEIGHT + 0.05) / 2;
    return cylinder('y', LOG_RADIUS, half, (x, y, z) => {
        const top = y > half - 0.06;
        const r = Math.hypot(x, z);
        return top
            ? voxel(M.LogEnd, Math.floor(r / 0.06) & 1 ? 1 : 2)
            : voxel(M.LogBark, latticeShade(x, y, z, 0.15, 3));
    });
}

/** Seed of a stand tree's voxel shading (stable per tree). */
const treeSeed = (n: number) => 9100 + n * 13;

/** Draws a standing stand tree into the static layer. */
export function drawStandTree(world: VoxelWorld, t: StandTree, n: number, ground: number, stats: RasterStats): void {
    // a recording world ("Voxels: Off") keeps each stand tree apart, to show it by its state
    const group = (world as { group?: (name: string | null) => void }).group;
    group?.call(world, `stand-${n}`);
    for (const v of treeVolumes(treeSeed(n)))
        world.rasterizeStatic(v.volume, standPose(t, ground, v.y), 'coverage50', v.priority, stats);
    group?.call(world, null);
}

/** Draws a stump into the static layer. */
export function drawStump(world: VoxelWorld, t: StandTree, ground: number, stats: RasterStats): void {
    const half = (STUMP_HEIGHT + 0.05) / 2;
    world.rasterizeStatic(stumpVolume(), pose(t.x, ground + half - 0.05, t.z), 'coverage50', 2, stats);
}

/** Draws every stand tree's stump, each as its own group `stump-<n>` (a recording world only). */
export function drawStumps(world: VoxelWorld, def: ForestryDef, stats: RasterStats): void {
    const group = (world as { group?: (name: string | null) => void }).group;
    def.trees.forEach((t, n) => {
        group?.call(world, `stump-${n}`);
        drawStump(world, t, def.ground(t.x, t.z), stats);
        group?.call(world, null);
    });
}

/**
 * Clears a stand tree (or its stump) from the static layer: every tree-material cell inside the
 * tree's own volumes. Ground and other scenery are left alone (the stand is kept clear of other
 * trees, so nothing else of these materials lies inside).
 */
export function clearStandTree(world: VoxelWorld, t: StandTree, n: number, ground: number, stats: RasterStats): number {
    let cleared = 0;
    const sink = (i: number, j: number, k: number) => {
        const v = world.staticAt(i, j, k);
        if (v !== 0 && TREE_MATERIALS.has(voxelMaterial(v)) && world.clearStatic(i, j, k)) cleared++;
    };
    for (const v of treeVolumes(treeSeed(n)))
        world.forEachCell(v.volume, standPose(t, ground, v.y), 'coverage50', sink, stats);
    const half = (STUMP_HEIGHT + 0.05) / 2;
    world.forEachCell(stumpVolume(), pose(t.x, ground + half - 0.05, t.z), 'coverage50', sink, stats);
    return cleared;
}

/** Draws every stand tree standing (the level build). */
export function drawStand(world: VoxelWorld, def: ForestryDef, stats: RasterStats): number {
    def.trees.forEach((t, n) => drawStandTree(world, t, n, def.ground(t.x, t.z), stats));
    return def.trees.length;
}
