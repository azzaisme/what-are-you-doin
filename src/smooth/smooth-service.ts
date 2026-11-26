/**
 * "Voxels: Off": builds the smooth meshes of a level and of every object's parts, from the same
 * source the voxelizer uses (no engine, so it runs in a worker and in Node tests).
 *
 * - The level's build runs once against a RecordingWorld: the ground comes back as its spec, every
 *   static piece, tree and rock as a volume at a pose, reeds and flowers as single cells.
 * - Ground: a heightfield of the level's continuous height (the one physics stands on), coloured
 *   by the terrain's own surface material, in 16 m chunks for culling.
 * - Volumes: tessellated primitives, or marching tetrahedra for custom shapes (geometry.ts).
 * - Stand trees and their stumps: one unit each, named, so the renderer shows each by its state.
 * - Objects: each part's mesh in its own frame, shared between objects with the same volume; the
 *   renderer moves them every frame (parts never re-mesh).
 */

import { drawStumps } from '../levels/forestry.ts';
import type { LevelDef } from '../levels/level.ts';
import { createLabEntities } from '../sim/lab-entities.ts';
import { GRID_SIZE } from '../voxels/grid.ts';
import { createRasterStats } from '../voxels/rasterizer.ts';
import type { Volume } from '../voxels/volumes.ts';
import type { VoxelWorld } from '../voxels/world.ts';
import type { ClassMesh } from '../workers/protocol.ts';

import { SmoothBuilder, addCellBox, addHeightfield, addVolume } from './geometry.ts';
import { RecordingWorld } from './recorder.ts';

/** Ground and static pieces are grouped in squares of this size (m). */
export const SMOOTH_CHUNK = 16;

export interface SmoothUnit {
    /** 'chunk:<ci>,<ck>', 'stand-<n>' or 'stump-<n>'. */
    name: string;
    classes: ClassMesh[];
    /** World bounds [minX, minY, minZ, maxX, maxY, maxZ]. */
    bounds: number[];
}

export interface SmoothBuild {
    units: SmoothUnit[];
    /** Distinct part meshes (local frame). */
    partMeshes: ClassMesh[][];
    /** Per entity id: the index into partMeshes of each of its parts. */
    entityParts: Record<number, number[]>;
    stats: {
        buildMs: number;
        terrainMs: number;
        volumesMs: number;
        partsMs: number;
        volumes: number;
        customVolumes: number;
        cells: number;
        triangles: number;
        partTriangles: number;
    };
}

export interface SmoothOptions {
    /** Ground grid (m): finer on small levels. Default 0.25 m, 0.5 m on levels over 100 m across. */
    groundStep?: number;
    /** Grid for objects' custom volumes: their longest side over this (default 20), 2-10 cm. */
    customDivisions?: number;
    /** The same for static scenery (rocks, crowns: seen from further; default 12), 2-30 cm. */
    staticDivisions?: number;
    /** Draw reeds and flowers (cells written one by one). Default true. */
    cells?: boolean;
}

/** A custom volume's polygonizing grid: its longest side over `divisions`, within [min, max] (m). */
const customStepFor = (v: Volume, divisions: number, max: number) => {
    const b = v.bounds;
    const longest = Math.max(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ);
    return Math.min(max, Math.max(0.02, longest / divisions));
};

function boundsOf(classes: ClassMesh[]): number[] {
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const c of classes)
        for (let v = 0; v < c.vertexCount * 3; v += 3)
            for (let a = 0; a < 3; a++) {
                b[a] = Math.min(b[a], c.positions[v + a]);
                b[a + 3] = Math.max(b[a + 3], c.positions[v + a]);
            }
    return b;
}

export function buildSmooth(def: LevelDef, seed: number, opts: SmoothOptions = {}): SmoothBuild {
    const t0 = performance.now();
    const rec = new RecordingWorld();
    def.build(rec as unknown as VoxelWorld, seed);
    if (def.forestry) drawStumps(rec as unknown as VoxelWorld, def.forestry, createRasterStats());
    const divisions = opts.customDivisions ?? 20;
    const builders = new Map<string, SmoothBuilder>();
    const builder = (name: string) => {
        let b = builders.get(name);
        if (!b) {
            b = new SmoothBuilder();
            builders.set(name, b);
        }
        return b;
    };
    const chunkName = (x: number, z: number) => `chunk:${Math.floor(x / SMOOTH_CHUNK)},${Math.floor(z / SMOOTH_CHUNK)}`;

    // ground
    const t1 = performance.now();
    const B = def.bounds;
    const step = opts.groundStep ?? (Math.max(B.maxX - B.minX, B.maxZ - B.minZ) > 100 ? 0.5 : 0.25);
    for (const t of rec.terrain) {
        // the terrain's surface material, as rasterizeTerrain picks it: the top cell there, and the
        // steepness in cells (top differences one cell either side, summed over x and z, halved)
        const value = (x: number, z: number, _h: number, dhdx: number, dhdz: number) =>
            t.surface(x, z, t.topCell(x, z), Math.abs(dhdx) + Math.abs(dhdz));
        for (let cz = Math.floor(t.minZ / SMOOTH_CHUNK); cz * SMOOTH_CHUNK < t.maxZ; cz++)
            for (let cx = Math.floor(t.minX / SMOOTH_CHUNK); cx * SMOOTH_CHUNK < t.maxX; cx++) {
                const x0 = Math.max(t.minX, cx * SMOOTH_CHUNK);
                const x1 = Math.min(t.maxX, (cx + 1) * SMOOTH_CHUNK);
                const z0 = Math.max(t.minZ, cz * SMOOTH_CHUNK);
                const z1 = Math.min(t.maxZ, (cz + 1) * SMOOTH_CHUNK);
                if (x1 <= x0 || z1 <= z0) continue;
                addHeightfield(
                    builder(`chunk:${cx},${cz}`),
                    x0,
                    z0,
                    x1,
                    z1,
                    step,
                    (x, z) => def.terrainHeight(x, z),
                    value
                );
            }
    }

    // static volumes and cells
    const t2 = performance.now();
    let customVolumes = 0;
    for (const v of rec.volumes) {
        if (v.volume.shape.type === 'custom') customVolumes++;
        const name = v.group ?? chunkName(v.pose.p.x, v.pose.p.z);
        addVolume(builder(name), v.volume, v.pose, customStepFor(v.volume, opts.staticDivisions ?? 12, 0.3));
    }
    if (opts.cells ?? true)
        for (const c of rec.cells) {
            const g = GRID_SIZE;
            const name = c.group ?? chunkName((c.i + 0.5) * g, (c.k + 0.5) * g);
            addCellBox(builder(name), c.i * g, c.j * g, c.k * g, g, c.value);
        }

    const units: SmoothUnit[] = [];
    let triangles = 0;
    for (const [name, b] of builders) {
        if (b.empty) continue;
        const classes = b.toMeshes();
        triangles += b.triangles;
        units.push({ name, classes, bounds: boundsOf(classes) });
    }

    // every object's parts, in their own frames
    const t3 = performance.now();
    const partMeshes: ClassMesh[][] = [];
    // objects made by the same asset function (twenty planks) share meshes: keyed by the asset's
    // name without its number, the part, and the part's shape and bounds
    const byShape = new Map<string, number>();
    const entityParts: Record<number, number[]> = {};
    let partTriangles = 0;
    for (const e of createLabEntities().entities) {
        if (e.asset.parts.length === 0) continue;
        const base = e.asset.name.replace(/-\d+$/, '');
        entityParts[e.id] = e.asset.parts.map((p) => {
            const key = `${base}:${p.name}:${JSON.stringify(p.volume.shape)}:${JSON.stringify(p.volume.bounds)}`;
            let n = byShape.get(key);
            if (n === undefined) {
                const b = new SmoothBuilder();
                addVolume(b, p.volume, null, customStepFor(p.volume, divisions, 0.1));
                partTriangles += b.triangles;
                n = partMeshes.length;
                partMeshes.push(b.toMeshes());
                byShape.set(key, n);
            }
            return n;
        });
    }
    const t4 = performance.now();
    return {
        units,
        partMeshes,
        entityParts,
        stats: {
            buildMs: t4 - t0,
            terrainMs: t2 - t1,
            volumesMs: t3 - t2,
            partsMs: t4 - t3,
            volumes: rec.volumes.length,
            customVolumes,
            cells: rec.cells.length,
            triangles,
            partTriangles
        }
    };
}
