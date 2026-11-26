/**
 * Messages between the main thread and the voxel worker. Plain data and transferable typed arrays
 * only; nothing engine-specific crosses this boundary (design doc §4.3, §5.5 Phase C).
 */

import { ANIM_MAX } from '../sim/snapshots.ts';
import type { MeshMode } from '../voxels/mesher.ts';
import type { SamplingPolicy } from '../voxels/rasterizer.ts';

/** Floats per tracked object in a frame request: visible, px py pz, qx qy qz qw, anim[ANIM_MAX]. */
export const STATE_STRIDE = 8 + ANIM_MAX;

export interface ClassMesh {
    positions: Float32Array;
    normals: Float32Array;
    colors: Uint8Array;
    indices: Uint32Array;
    vertexCount: number;
    indexCount: number;
}

export interface UnitMesh {
    key: number;
    mode: MeshMode;
    minI: number;
    minJ: number;
    minK: number;
    sx: number;
    sy: number;
    sz: number;
    quads: number;
    classes: ClassMesh[];
}

/** Dynamic object id of the particle cells (one object, single cells, lowest priority). */
export const PARTICLE_OBJECT_ID = 990;

export interface FrameStats {
    frame: number;
    time: number;
    objects: number;
    parts: number;
    candidates: number;
    samples: number;
    occupied: number;
    rejected: number;
    changedCells: number;
    dirtyCells: number;
    dynDynOverlaps: number;
    dynStaticOverlaps: number;
    /** Objects on other lattices rasterized here because they outrank one of this lattice's (ADR 0011). */
    latticeMasks: number;
    /** Cells where such an object now takes the cell from one of this lattice's objects. */
    latticeHidden: number;
    /** Such objects skipped this frame: the lattice's mask budget (maskLimit) was spent. */
    maskSkipped: number;
    /**
     * The mask work done this frame, in units (MASK_SAMPLE_WEIGHT): cells scanned, weighted
     * samples and changed chunks, plus clearing masks that dropped out. Without those clears it
     * never exceeds maskLimit.
     */
    maskCells: number;
    /**
     * This frame's mask budget in those units (MASK_PRESETS), on lattices that can mask (0 on the
     * others, so the pipeline's sum is the masking lattices' budgets).
     */
    maskLimit: number;
    /** Their parts the rasterizer rejected (runaway bounds), as `rejected` counts for objects. */
    maskRejected: number;
    staticRebuilt: number;
    dynamicRebuilt: number;
    rasterMs: number;
    resolveMs: number;
    meshMs: number;
    totalMs: number;
    dynamicCells: number;
    chunks: number;
    /** Particle cells drawn this voxel frame (leaves, chips, splashes). */
    particles: number;
}

/** Streamed levels: the near tiles built so far (sent when the set changes). */
export interface TileReport {
    /** Tile edge (m); tile (ti, tk) spans [ti * size, (ti + 1) * size) on x and the same on z. */
    size: number;
    /** ti, tk pairs. */
    tiles: Int32Array;
}

export interface BuildInfo {
    cellCm: number;
    columns: number;
    staticCells: number;
    trees: number;
    chunks: number;
    buildMs: number;
    staticMeshMs: number;
}

export type ToWorker =
    | {
          type: 'init';
          cellCm: number;
          seed: number;
          level: string;
          data?: unknown;
          /** Entity ids this worker draws (per-item cell sizes); all when absent. */
          objects?: number[];
          /** Build the static world and draw particles (the base lattice only). Default true. */
          world?: boolean;
          /** The far lattice of a streamed level: the whole static world, coarse, no objects. */
          far?: boolean;
          /** False: objects on other lattices do not take cells from this one (?masks=off, #107). */
          masks?: boolean;
      }
    | {
          type: 'frame';
          frame: number;
          time: number;
          policy: SamplingPolicy;
          reference: boolean;
          states: Float64Array;
          particles?: Float32Array;
          particleCount?: number;
          /** Streamed levels: this device's camera positions (x, z pairs); the near world follows them. */
          focus?: Float32Array;
          /** The far lattice: the near tiles built (ti, tk pairs) and their size (m); it leaves them out. */
          nearTiles?: Int32Array;
          nearTileSize?: number;
          /** Streamed levels: the near world's radius (m) for this device's quality preset. */
          nearRadius?: number;
          /** This device's quality preset, for the mask budget (MASK_PRESETS; default high). */
          maskPreset?: 'high' | 'low';
      }
    | { type: 'query'; id: number; what: 'hash' | 'verify' | 'lattice' };

export type FromWorker =
    | { type: 'ready'; build: BuildInfo; units: UnitMesh[] }
    | { type: 'frame'; units: UnitMesh[]; stats: FrameStats; tiles?: TileReport }
    | { type: 'query'; id: number; result: unknown }
    | { type: 'error'; message: string };

/** Transferable buffers of a set of unit meshes. */
export function transferables(units: UnitMesh[]): ArrayBuffer[] {
    const out: ArrayBuffer[] = [];
    for (const u of units) {
        for (const c of u.classes)
            out.push(
                c.positions.buffer as ArrayBuffer,
                c.normals.buffer as ArrayBuffer,
                c.colors.buffer as ArrayBuffer,
                c.indices.buffer as ArrayBuffer
            );
    }
    return out;
}
