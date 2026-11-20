/**
 * Level description: everything the voxel build, the physics world, the simulation and the client
 * need to know about a level, as plain data and pure functions. Engine-free and physics-free (shapes
 * here are descriptions; the physics adapter turns them into colliders).
 */

import type { WindSpec } from '../fx/wind.ts';
import type { Pose } from '../voxels/math.ts';
import type { RasterStats, SamplingPolicy } from '../voxels/rasterizer.ts';
import { box, cylinder, ellipsoid } from '../voxels/volumes.ts';
import type { MaterialField, Volume } from '../voxels/volumes.ts';
import type { VoxelWorld } from '../voxels/world.ts';

import type { RockSpot, TreeSpot } from './common.ts';
import type { LevelData } from './data.ts';

export type LevelId = string;

export interface Rect {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
}

export type PieceShape =
    | { type: 'box'; hx: number; hy: number; hz: number }
    | { type: 'cylinder'; axis: 'x' | 'y' | 'z'; r: number; half: number }
    | { type: 'ellipsoid'; rx: number; ry: number; rz: number };

/** A static scenery piece: rasterized into the static voxel layer and (optionally) a collider. */
export interface StaticPiece {
    name: string;
    shape: PieceShape;
    pose: Pose;
    field: MaterialField;
    priority?: number;
    policy?: SamplingPolicy;
    /** False for things out of reach or purely decorative at a distance. */
    collide: boolean;
}

export interface LevelLayout {
    trees: TreeSpot[];
    rocks: RockSpot[];
    pieces: StaticPiece[];
}

export interface LevelBuildResult {
    columns: number;
    staticCells: number;
    trees: number;
    rocks: number;
    reeds: number;
    stats: RasterStats;
    ms: number;
}

/** Where a named entity starts (dynamic props), in the level's own terms. */
export interface PropPlacement {
    name: string;
    pose: Pose;
}

/** One tutorial step; the steps are done in order. */
export type TutorialStep =
    | { kind: 'look'; text: string }
    | { kind: 'reach'; text: string; rect: Rect }
    | { kind: 'jump'; text: string }
    | { kind: 'grab'; text: string; entity?: string }
    /** A prop (by entity name) resting inside a rect. */
    | { kind: 'place'; text: string; entity: string; rect: Rect }
    | { kind: 'goal'; text: string };

export interface LevelRules {
    /** The objective, shown in the HUD. */
    objective: string;
    /** The bucket counts as delivered when it rests inside this rectangle. */
    goal: Rect;
    /** Below this height the player has fallen in (the creek): they are put back on safe ground. */
    fallY: number;
    /** Ground the player may be returned to after a fall. */
    isSafe(x: number, z: number): boolean;
    /** Below this height essential items (the bucket) are returned to their start. */
    lostY: number;
    /** Tutorial steps, done in order (the last is usually the goal). */
    steps?: TutorialStep[];
}

export interface LevelDef {
    id: LevelId;
    name: string;
    /** Extent of the terrain (voxel columns and the collision heightfield). */
    bounds: Rect;
    /** Area the player can walk in (invisible walls). */
    playArea: Rect;
    water: { y: number; cx: number; cz: number; halfX: number; halfZ: number };
    /** Continuous ground height (collision and placement use this, never voxels). */
    terrainHeight(x: number, z: number): number;
    /** Same seed → same layout for voxels and colliders. */
    layout(seed: number): LevelLayout;
    build(world: VoxelWorld, seed: number): LevelBuildResult;
    sun: { elevation: number; azimuth: number };
    /** Wind (forces on light bodies, leaves, water ripples); calm when absent. */
    wind?: WindSpec;
    /** A windsock on a pole (the wind's visible tell, §2.9). */
    windsock?: { x: number; z: number; height: number };
    spawn: { x: number; z: number; yaw: number; pitch: number };
    orbitHome: { pos: [number, number, number]; focus: [number, number, number] };
    startFirstPerson: boolean;
    /** Scripted actors: the beaver walks its loop or stands idle, the ute laps or is parked. */
    actors: {
        beaver: { mode: 'loop' } | { mode: 'idle'; pose: Pose } | { mode: 'none' };
        ute: { mode: 'track' } | { mode: 'parked'; pose: Pose } | { mode: 'none' };
    };
    /** Dynamic props present in this level and where they start (physics props mode). */
    props: PropPlacement[];
    /** Objective and recovery rules; absent for the test lab. */
    rules?: LevelRules;
    /** Whether the Epic 1 scripted-props comparison mode applies. */
    scriptedProps: boolean;
    /** The data this level was made from (data levels and designer levels), sent to the worker. */
    data?: LevelData;
}

export function pieceVolume(p: StaticPiece): Volume {
    const s = p.shape;
    if (s.type === 'box') return box(s.hx, s.hy, s.hz, p.field);
    if (s.type === 'cylinder') return cylinder(s.axis, s.r, s.half, p.field);
    return ellipsoid(s.rx, s.ry, s.rz, p.field);
}

/** Writes the static pieces of a layout into the static voxel layer. */
export function rasterizePieces(world: VoxelWorld, pieces: readonly StaticPiece[], stats: RasterStats): void {
    for (const p of pieces)
        world.rasterizeStatic(pieceVolume(p), p.pose, p.policy ?? 'coverage50', p.priority ?? 2, stats);
}
