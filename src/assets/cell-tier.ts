/**
 * Per-item voxel sizes (owner decision, 2026-11-21: "big things have big blocks and small things
 * have small blocks, all the way down to 1x1x1"). Every object is drawn on one of three
 * world-aligned lattices that share the origin:
 *
 * - fine: 1 cm, for small things (the bucket, the ragdoll's head and hands);
 * - base: the player's voxel size setting (5 cm by default), for props, characters and the world;
 * - coarse: twice the base size (10 cm by default, at most 20 cm), for big things (the ute).
 *
 * Cubes still never rotate or slide and render meshes never move; small things just have smaller
 * cubes. The tier is picked from the asset's size at rest, so new assets need no table entry.
 */

import { aabb, mat34, pose, poseToMat34, transformAabb } from '../voxels/math.ts';
import type { AABB } from '../voxels/math.ts';

import type { VoxelAsset } from './asset.ts';

export type CellTier = 'fine' | 'base' | 'coarse';
export const CELL_TIERS: readonly CellTier[] = ['fine', 'base', 'coarse'];

/** The fine lattice's cell size (cm). */
export const FINE_CELL_CM = 1;
/** Coarse cells are this many base cells. */
export const COARSE_FACTOR = 2;
export const COARSE_MAX_CM = 20;

/** Fine only when its bounding box holds at most this many 1 cm cells (re-rasterized per frame). */
const FINE_CELL_BUDGET = 80_000;
/** And when its longest side is at most this long (m). */
const FINE_MAX_SIDE = 0.6;
/** Coarse when its longest side is at least this long and its shortest at least COARSE_MIN_SIDE. */
const COARSE_LONG_SIDE = 3;
const COARSE_MIN_SIDE = 1;

export function tierCellCm(tier: CellTier, baseCm: number): number {
    if (tier === 'fine') return FINE_CELL_CM;
    if (tier === 'coarse') return Math.min(COARSE_MAX_CM, baseCm * COARSE_FACTOR);
    return baseCm;
}

/** Bounds of an asset at rest (identity root, zero animation), in its root frame. */
export function assetBounds(asset: VoxelAsset): AABB {
    const poses = asset.parts.map(() => pose());
    asset.evaluate(pose(), new Float64Array(Math.max(1, asset.animChannels)), poses);
    const out = aabb(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity);
    const m = mat34();
    const b = aabb(0, 0, 0, 0, 0, 0);
    asset.parts.forEach((p, i) => {
        transformAabb(p.volume.bounds, poseToMat34(poses[i], m), b);
        out.minX = Math.min(out.minX, b.minX);
        out.minY = Math.min(out.minY, b.minY);
        out.minZ = Math.min(out.minZ, b.minZ);
        out.maxX = Math.max(out.maxX, b.maxX);
        out.maxY = Math.max(out.maxY, b.maxY);
        out.maxZ = Math.max(out.maxZ, b.maxZ);
    });
    return out;
}

/** The lattice an asset is drawn on, from its size. */
export function assetTier(asset: VoxelAsset): CellTier {
    if (asset.cellTier) return asset.cellTier;
    if (asset.parts.length === 0) return 'base';
    const b = assetBounds(asset);
    const sides = [b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ].sort((a, c) => a - c);
    const fineCells = (sides[0] / 0.01) * (sides[1] / 0.01) * (sides[2] / 0.01);
    if (sides[2] <= FINE_MAX_SIDE && fineCells <= FINE_CELL_BUDGET) return 'fine';
    if (sides[2] >= COARSE_LONG_SIDE && sides[0] >= COARSE_MIN_SIDE) return 'coarse';
    return 'base';
}
