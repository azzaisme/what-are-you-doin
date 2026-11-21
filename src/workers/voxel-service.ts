/**
 * The voxel world and its reconstruction, packaged as a service with no engine and no DOM
 * dependencies. Runs inside the voxel Web Worker in the browser (Phase C, design doc §5.5) and
 * directly in Node for benchmarks and tests.
 *
 * Per voxel frame: decode object states (already sampled at the voxel time by the main thread),
 * evaluate asset part poses, rasterize, resolve the composite, mesh dirty units, and return
 * finished buffers. The main thread only uploads them, all at once.
 */

import { parseLevelData, levelFromData } from '../levels/data.ts';
import { getLevel } from '../levels/index.ts';
import { createLabEntities } from '../sim/lab-entities.ts';
import type { SimEntity } from '../sim/lab-entities.ts';
import { ANIM_MAX } from '../sim/snapshots.ts';
import { DYNAMIC_REGION, STATIC_REGION, collectDirty, unpackRegion } from '../voxels/dirty.ts';
import type { DirtyWork } from '../voxels/dirty.ts';
import { CHUNK_SIZE, GRID_SIZE } from '../voxels/grid.ts';
import { pose } from '../voxels/math.ts';
import type { Pose } from '../voxels/math.ts';
import { MeshOutput, meshRegionBlocked } from '../voxels/mesher.ts';
import type { MeshMode } from '../voxels/mesher.ts';
import { createRasterStats, resetRasterStats } from '../voxels/rasterizer.ts';
import type { SamplingPolicy } from '../voxels/rasterizer.ts';
import { VoxelWorld } from '../voxels/world.ts';
import type { PartInstance } from '../voxels/world.ts';

import { PARTICLE_OBJECT_ID, STATE_STRIDE } from './protocol.ts';
import type { BuildInfo, ClassMesh, FrameStats, UnitMesh } from './protocol.ts';

interface Tracked {
    id: number;
    evaluate: (root: Pose, anim: ArrayLike<number>, out: Pose[]) => void;
    root: Pose;
    anim: Float64Array;
    poses: Pose[];
    parts: PartInstance[];
}

/** Order of tracked objects: every sim entity that has voxel parts, in sim order. */
export function trackedEntityOrder(sim: { entities: SimEntity[] }): number[] {
    return sim.entities.filter((e) => e.asset.parts.length > 0).map((e) => e.slot);
}

export class VoxelService {
    readonly world = new VoxelWorld();
    private readonly tracked: Tracked[] = [];
    private readonly raster = createRasterStats();
    private readonly out = new MeshOutput();
    private readonly work: DirtyWork = { staticRegions: [], dynamicRegions: [], dynamicHasContent: [] };
    /** Dynamic regions that have ever held content (and so have a render unit). */
    private readonly knownDynamic = new Set<number>();

    constructor() {
        this.world.addObject(PARTICLE_OBJECT_ID, 0);
        for (const e of createLabEntities().entities) {
            if (e.asset.parts.length === 0) continue;
            this.world.addObject(e.id, e.priority);
            const poses = e.asset.parts.map(() => pose());
            this.tracked.push({
                id: e.id,
                evaluate: e.asset.evaluate.bind(e.asset),
                root: pose(),
                anim: new Float64Array(ANIM_MAX),
                poses,
                parts: e.asset.parts.map((p, i) => ({
                    volume: p.volume,
                    pose: poses[i],
                    priority: p.priority,
                    policy: p.policy
                }))
            });
        }
    }

    get trackedCount(): number {
        return this.tracked.length;
    }

    build(seed: number, level = 'yard', data?: unknown): { build: BuildInfo; units: UnitMesh[] } {
        // designer levels arrive as data (validated again here: the worker trusts nothing)
        const def = data ? levelFromData(parseLevelData(data)) : getLevel(level);
        const r = def.build(this.world, seed);
        const t0 = performance.now();
        const units = this.meshDirty();
        return {
            build: {
                cellCm: GRID_SIZE * 100,
                columns: r.columns,
                staticCells: r.staticCells,
                trees: r.trees,
                chunks: this.world.chunkCount,
                buildMs: r.ms,
                staticMeshMs: performance.now() - t0
            },
            units
        };
    }

    frame(
        frame: number,
        time: number,
        policy: SamplingPolicy,
        reference: boolean,
        states: Float64Array,
        particles?: Float32Array,
        particleCount = 0
    ): { units: UnitMesh[]; stats: FrameStats } {
        const t0 = performance.now();
        resetRasterStats(this.raster);
        let objects = 0;
        for (let n = 0; n < this.tracked.length; n++) {
            const t = this.tracked[n];
            const o = n * STATE_STRIDE;
            const visible = !reference && states[o] > 0.5;
            if (!visible) {
                if (this.world.objectCellCount(t.id) > 0) this.world.clearObject(t.id);
                continue;
            }
            t.root.p.x = states[o + 1];
            t.root.p.y = states[o + 2];
            t.root.p.z = states[o + 3];
            t.root.q.x = states[o + 4];
            t.root.q.y = states[o + 5];
            t.root.q.z = states[o + 6];
            t.root.q.w = states[o + 7];
            for (let c = 0; c < ANIM_MAX; c++) t.anim[c] = states[o + 8 + c];
            t.evaluate(t.root, t.anim, t.poses);
            this.world.rasterizeObject(t.id, t.parts, policy, this.raster);
            objects++;
        }
        // particles: single cells on the global grid, behind every object
        const pc = particles && !reference ? Math.min(particleCount, Math.floor(particles.length / 4)) : 0;
        if (pc > 0) this.world.rasterizePoints(PARTICLE_OBJECT_ID, particles!, pc, 0);
        else if (this.world.objectCellCount(PARTICLE_OBJECT_ID) > 0) this.world.clearObject(PARTICLE_OBJECT_ID);
        const t1 = performance.now();
        const comp = this.world.resolve();
        const t2 = performance.now();
        const units = this.meshDirty();
        const t3 = performance.now();
        let staticRebuilt = 0;
        for (const u of units) if (u.mode === 'static') staticRebuilt++;
        return {
            units,
            stats: {
                frame,
                time,
                objects,
                parts: this.raster.parts,
                candidates: this.raster.candidates,
                samples: this.raster.samples,
                occupied: this.raster.occupied,
                rejected: this.raster.rejected,
                changedCells: comp.changedCells,
                dirtyCells: comp.dirtyCells,
                dynDynOverlaps: comp.dynDynOverlaps,
                dynStaticOverlaps: comp.dynStaticOverlaps,
                staticRebuilt,
                dynamicRebuilt: units.length - staticRebuilt,
                rasterMs: t1 - t0,
                resolveMs: t2 - t1,
                meshMs: t3 - t2,
                totalMs: t3 - t0,
                dynamicCells: this.world.dynamicCellCount(),
                particles: pc,
                chunks: this.world.chunkCount
            }
        };
    }

    /** Meshes every dirty static region and dynamic region into standalone, transferable buffers. */
    meshDirty(): UnitMesh[] {
        const work = collectDirty(this.world, this.work);
        const units: UnitMesh[] = [];
        for (const key of work.staticRegions) {
            const [x, y, z] = unpackRegion(key);
            units.push(
                this.meshUnit(
                    key,
                    'static',
                    x * STATIC_REGION.x,
                    y * STATIC_REGION.y,
                    z * STATIC_REGION.z,
                    STATIC_REGION.x,
                    STATIC_REGION.y,
                    STATIC_REGION.z
                )
            );
        }
        for (let n = 0; n < work.dynamicRegions.length; n++) {
            const key = work.dynamicRegions[n];
            if (!this.knownDynamic.has(key)) {
                if (!work.dynamicHasContent[n]) continue; // never had content: nothing to clear
                this.knownDynamic.add(key);
            }
            const [x, y, z] = unpackRegion(key);
            units.push(
                this.meshUnit(
                    key,
                    'dynamic',
                    x * DYNAMIC_REGION,
                    y * DYNAMIC_REGION,
                    z * DYNAMIC_REGION,
                    DYNAMIC_REGION,
                    DYNAMIC_REGION,
                    DYNAMIC_REGION
                )
            );
        }
        return units;
    }

    private meshUnit(
        key: number,
        mode: MeshMode,
        minI: number,
        minJ: number,
        minK: number,
        sx: number,
        sy: number,
        sz: number
    ): UnitMesh {
        const out = this.out;
        out.reset();
        meshRegionBlocked(
            this.world,
            mode,
            minI,
            minJ,
            minK,
            sx,
            sy,
            sz,
            mode === 'static' ? DYNAMIC_REGION : CHUNK_SIZE,
            out
        );
        const classes: ClassMesh[] = out.classes.map((b) => ({
            positions: b.positions.slice(0, b.vertexCount * 3),
            normals: b.normals.slice(0, b.vertexCount * 3),
            colors: b.colors.slice(0, b.vertexCount * 4),
            indices: b.indices.slice(0, b.indexCount),
            vertexCount: b.vertexCount,
            indexCount: b.indexCount
        }));
        return { key, mode, minI, minJ, minK, sx, sy, sz, quads: out.quads, classes };
    }

    /** Re-meshes every live unit and checks that every vertex lies on a grid plane (§7.4). */
    verifyGrid(): { vertices: number; misaligned: number } {
        let vertices = 0;
        let misaligned = 0;
        const check = (
            mode: MeshMode,
            minI: number,
            minJ: number,
            minK: number,
            sx: number,
            sy: number,
            sz: number
        ) => {
            this.out.reset();
            meshRegionBlocked(
                this.world,
                mode,
                minI,
                minJ,
                minK,
                sx,
                sy,
                sz,
                mode === 'static' ? DYNAMIC_REGION : CHUNK_SIZE,
                this.out
            );
            for (const b of this.out.classes) {
                for (let v = 0; v < b.vertexCount * 3; v++) {
                    const g = b.positions[v] / GRID_SIZE;
                    vertices++;
                    if (Math.abs(g - Math.round(g)) > 1e-3) misaligned++;
                }
            }
        };
        for (const key of this.knownDynamic) {
            const [x, y, z] = unpackRegion(key);
            check(
                'dynamic',
                x * DYNAMIC_REGION,
                y * DYNAMIC_REGION,
                z * DYNAMIC_REGION,
                DYNAMIC_REGION,
                DYNAMIC_REGION,
                DYNAMIC_REGION
            );
        }
        // a sample of static regions near the lab centre
        for (const [x, z] of [
            [0, 0],
            [-1, -1],
            [0, -1],
            [-1, 0]
        ]) {
            for (let y = -1; y <= 1; y++)
                check(
                    'static',
                    x * STATIC_REGION.x,
                    y * STATIC_REGION.y,
                    z * STATIC_REGION.z,
                    STATIC_REGION.x,
                    STATIC_REGION.y,
                    STATIC_REGION.z
                );
        }
        return { vertices, misaligned };
    }
}
