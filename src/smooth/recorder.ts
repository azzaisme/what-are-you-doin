/**
 * A stand-in for the voxel world that records what a level's build writes instead of voxelizing
 * it ("Voxels: Off"): the ground as its spec, every analytic volume at its pose, and the few cells
 * written one by one (reeds, flowers). Groups (stand trees, stumps) are kept apart by name.
 * It has only the members level builds use (src/levels).
 */

import type { TerrainSpec } from '../levels/common.ts';
import { pose } from '../voxels/math.ts';
import type { Pose } from '../voxels/math.ts';
import type { Volume } from '../voxels/volumes.ts';
import type { Bedrock, ColumnRect } from '../voxels/world.ts';

export interface RecordedVolume {
    volume: Volume;
    pose: Pose;
    group: string | null;
}

export interface RecordedCell {
    i: number;
    j: number;
    k: number;
    value: number;
    group: string | null;
}

export class RecordingWorld {
    readonly volumes: RecordedVolume[] = [];
    readonly cells: RecordedCell[] = [];
    readonly terrain: TerrainSpec[] = [];
    private current: string | null = null;
    /** Written by level builds (ignored here). */
    bedrock: Bedrock | null = null;
    clip: ColumnRect | null = null;
    tileCells = 0;

    group(name: string | null): void {
        this.current = name;
    }

    recordTerrain(t: TerrainSpec): number {
        this.terrain.push(t);
        return 0;
    }

    rasterizeStatic(volume: Volume, p: Pose): boolean {
        const copy = pose(p.p.x, p.p.y, p.p.z);
        copy.q.x = p.q.x;
        copy.q.y = p.q.y;
        copy.q.z = p.q.z;
        copy.q.w = p.q.w;
        this.volumes.push({ volume, pose: copy, group: this.current });
        return true;
    }

    setStatic(i: number, j: number, k: number, value: number): void {
        if (value !== 0) this.cells.push({ i, j, k, value, group: this.current });
    }

    staticCellCount(): number {
        return this.cells.length;
    }

    staticAt(): number {
        return 0;
    }

    clearStatic(): boolean {
        return false;
    }

    forEachCell(): void {
        // nothing to visit: no cells are stored
    }

    finalizeStatic(): void {
        // nothing to finalize
    }

    setTileBedrock(): void {
        // no bedrock: the heightfield is the ground
    }
}
