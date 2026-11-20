/**
 * Voxel asset model (design doc §5.2).
 *
 * An asset is a list of parts, each an analytic local volume with a deterministic overlap priority.
 * A pose function maps the asset's root pose plus a small animation vector to one world pose per
 * part. The same "evaluate pose, then rasterize into the shared grid" path serves characters,
 * vehicles, logs and props alike.
 */

import type { Pose } from '../voxels/math.ts';
import type { SamplingPolicy } from '../voxels/rasterizer.ts';
import type { Volume } from '../voxels/volumes.ts';

export const ASSET_SCHEMA_VERSION = 1;

export interface AssetPart {
    name: string;
    volume: Volume;
    /** Higher wins when parts of the same object overlap (hat overrides head). 0..255. */
    priority: number;
    /** Per-asset-class sampling override (e.g. thin handles). */
    policy?: SamplingPolicy;
    /** sRGB colour for the debug conventional reference renderer. */
    refColor: number;
}

export interface VoxelAsset {
    readonly schema: number;
    readonly name: string;
    readonly parts: readonly AssetPart[];
    /** Number of animation channels this asset reads. */
    readonly animChannels: number;
    /**
     * Writes one world pose per part into `out` (same order as `parts`). Must be deterministic and
     * must not allocate per call.
     */
    evaluate(root: Pose, anim: ArrayLike<number>, out: Pose[]): void;
}
