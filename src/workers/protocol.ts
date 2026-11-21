/**
 * Messages between the main thread and the voxel worker. Plain data and transferable typed arrays
 * only; nothing engine-specific crosses this boundary (design doc §4.3, §5.5 Phase C).
 */

import type { MeshMode } from '../voxels/mesher.ts';
import type { SamplingPolicy } from '../voxels/rasterizer.ts';

/** Floats per tracked object in a frame request: visible, px py pz, qx qy qz qw, anim[6]. */
export const STATE_STRIDE = 14;

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
      }
    | { type: 'query'; id: number; what: 'hash' | 'verify' };

export type FromWorker =
    | { type: 'ready'; build: BuildInfo; units: UnitMesh[] }
    | { type: 'frame'; units: UnitMesh[]; stats: FrameStats }
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
