/**
 * Dirty-work collection shared by the GPU renderer and headless benchmarks: which static regions
 * and which dynamic chunks need re-meshing after a voxel frame. Clears the chunk flags.
 */

import { CHUNK_SIZE, GRID_SIZE } from './grid.ts';
import type { VoxelWorld } from './world.ts';

/** Static mesh region (one render unit): 6.4 x 3.2 x 6.4 m, expressed in cells. */
const cellsFor = (metres: number) => Math.max(CHUNK_SIZE, Math.round(metres / GRID_SIZE / CHUNK_SIZE) * CHUNK_SIZE);
export const STATIC_REGION = { x: cellsFor(6.4), y: cellsFor(3.2), z: cellsFor(6.4) };

/** Dynamic render unit: 1.6 m cubes, expressed in cells (groups several 16^3 chunks). */
export const DYNAMIC_REGION = cellsFor(1.6);

export function regionKey(x: number, y: number, z: number): number {
    return (x + 512) * 1048576 + (y + 512) * 1024 + (z + 512);
}

export function unpackRegion(key: number): [number, number, number] {
    const z = (key % 1024) - 512;
    const y = (Math.floor(key / 1024) % 1024) - 512;
    const x = Math.floor(key / 1048576) - 512;
    return [x, y, z];
}

export interface DirtyWork {
    staticRegions: number[];
    /** Dynamic regions to re-mesh; `dynamicHasContent` is parallel: any dynamic cell inside. */
    dynamicRegions: number[];
    dynamicHasContent: boolean[];
}

export function collectDirty(world: VoxelWorld, out: DirtyWork): DirtyWork {
    const regions = new Set<number>();
    const dyn = new Map<number, boolean>();
    for (const c of world.chunks) {
        if (c.staticDirty) {
            regions.add(
                regionKey(
                    Math.floor((c.cx * CHUNK_SIZE) / STATIC_REGION.x),
                    Math.floor((c.cy * CHUNK_SIZE) / STATIC_REGION.y),
                    Math.floor((c.cz * CHUNK_SIZE) / STATIC_REGION.z)
                )
            );
            c.staticDirty = false;
        }
        if (c.dynDirty) {
            const key = regionKey(
                Math.floor((c.cx * CHUNK_SIZE) / DYNAMIC_REGION),
                Math.floor((c.cy * CHUNK_SIZE) / DYNAMIC_REGION),
                Math.floor((c.cz * CHUNK_SIZE) / DYNAMIC_REGION)
            );
            dyn.set(key, (dyn.get(key) ?? false) || c.dynCount > 0);
            c.dynDirty = false;
        }
    }
    out.staticRegions = [...regions];
    out.dynamicRegions = [...dyn.keys()];
    out.dynamicHasContent = [...dyn.values()];
    return out;
}
