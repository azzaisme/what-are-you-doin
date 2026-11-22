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
import type { LevelDef } from '../levels/level.ts';
import { createLabEntities } from '../sim/lab-entities.ts';
import type { SimEntity } from '../sim/lab-entities.ts';
import { ANIM_MAX } from '../sim/snapshots.ts';
import { DYNAMIC_REGION, STATIC_REGION, collectDirty, unpackRegion } from '../voxels/dirty.ts';
import type { DirtyWork } from '../voxels/dirty.ts';
import { CHUNK_COORD_LIMIT, CHUNK_SIZE, CHUNK_Y_LIMIT, GRID_SIZE } from '../voxels/grid.ts';
import { pose } from '../voxels/math.ts';
import type { Pose } from '../voxels/math.ts';
import { MeshOutput, meshRegionBlocked } from '../voxels/mesher.ts';
import type { MeshMode } from '../voxels/mesher.ts';
import { createRasterStats, resetRasterStats } from '../voxels/rasterizer.ts';
import type { SamplingPolicy } from '../voxels/rasterizer.ts';
import { VoxelWorld } from '../voxels/world.ts';
import type { PartInstance } from '../voxels/world.ts';

import { PARTICLE_OBJECT_ID, STATE_STRIDE } from './protocol.ts';
import type { BuildInfo, ClassMesh, FrameStats, TileReport, UnitMesh } from './protocol.ts';

/** How far from the origin this lattice's chunks reach (m), with a margin for object size. */
const LATTICE_REACH = CHUNK_COORD_LIMIT * CHUNK_SIZE * GRID_SIZE - 4;
const LATTICE_REACH_Y = CHUNK_Y_LIMIT * CHUNK_SIZE * GRID_SIZE - 2;

interface Tracked {
    id: number;
    /** False: tracked for the state layout only, drawn by another lattice's service. */
    drawn: boolean;
    evaluate: (root: Pose, anim: ArrayLike<number>, out: Pose[]) => void;
    hidden?: (anim: ArrayLike<number>, part: number) => boolean;
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
    /** Static world and particles (the base lattice); other lattices draw objects only. */
    private withWorld = true;
    /** Streamed level: the near tiles, built around the cameras (null: everything is built at once). */
    private stream: {
        def: LevelDef;
        seed: number;
        radius: number;
        built: Map<number, { ti: number; tk: number }>;
        changed: boolean;
    } | null = null;
    /**
     * The far lattice of a streamed level: everything except the near tiles another lane has built
     * (their columns are cleared here, and rebuilt when the near tile goes).
     */
    private far: { def: LevelDef; seed: number; holes: Map<number, { ti: number; tk: number }> } | null = null;
    /** Cameras the near world follows (x, z pairs), from the last frame request. */
    private focus: Float32Array | null = null;
    /**
     * Milliseconds a voxel frame may spend building tiles. One tile at most per frame (a tile takes
     * 20-120 ms here), so moving objects keep updating while the world streams in.
     */
    tileBudgetMs = 10;

    /**
     * `objects`: the entity ids this service draws (per-item cell sizes run one service per
     * lattice); every entity with voxel parts when absent. The frame states still cover every
     * tracked entity in sim order; the others are skipped.
     */
    constructor(objects?: Set<number>) {
        this.world.addObject(PARTICLE_OBJECT_ID, 0);
        for (const e of createLabEntities().entities) {
            if (e.asset.parts.length === 0) continue;
            const drawn = !objects || objects.has(e.id);
            if (drawn) this.world.addObject(e.id, e.priority);
            const poses = e.asset.parts.map(() => pose());
            this.tracked.push({
                id: e.id,
                drawn,
                evaluate: e.asset.evaluate.bind(e.asset),
                hidden: e.asset.partHidden?.bind(e.asset),
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

    build(
        seed: number,
        level = 'yard',
        data?: unknown,
        withWorld = true,
        far = false
    ): { build: BuildInfo; units: UnitMesh[] } {
        // designer levels arrive as data (validated again here: the worker trusts nothing)
        const def = data ? levelFromData(parseLevelData(data)) : getLevel(level);
        this.withWorld = withWorld && !far;
        let r = { columns: 0, staticCells: 0, trees: 0, ms: 0 };
        if (far || (withWorld && !def.stream)) r = def.build(this.world, seed);
        if (far && def.stream) {
            this.far = { def, seed, holes: new Map() };
            this.world.tileCells = STATIC_REGION.x;
        } else if (withWorld && def.stream) {
            // streamed: the tiles around the start now, the rest as the cameras move
            const t0 = performance.now();
            this.world.tileCells = STATIC_REGION.x;
            this.stream = { def, seed, radius: def.stream.radius, built: new Map(), changed: true };
            const sp = def.spawn;
            this.updateTiles(new Float32Array([sp.x, sp.z]), Infinity, Math.min(def.stream.radius, 18), Infinity);
            r = {
                columns: 0,
                staticCells: this.world.staticCellCount(),
                trees: 0,
                ms: performance.now() - t0
            };
        }
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
        particleCount = 0,
        focus?: Float32Array,
        nearTiles?: Int32Array,
        nearTileSize = 0
    ): { units: UnitMesh[]; stats: FrameStats; tiles?: TileReport } {
        const t0 = performance.now();
        resetRasterStats(this.raster);
        let objects = 0;
        if (focus && focus.length >= 2) this.focus = focus;
        if (this.stream && this.focus) this.updateTiles(this.focus, this.tileBudgetMs, this.stream.radius);
        if (this.far && nearTiles) this.updateHoles(nearTiles, nearTileSize);
        // objects beyond the near world are not drawn (their ground is not built there either)
        const cull = this.stream && this.focus ? this.stream.radius + 4 : 0;
        for (let n = 0; n < this.tracked.length; n++) {
            const t = this.tracked[n];
            if (!t.drawn) continue;
            const o = n * STATE_STRIDE;
            // beyond the lattice's chunk range (the 1 cm lattice reaches +-160 m, +-18 m up): not drawn
            const inRange =
                Math.abs(states[o + 1]) < LATTICE_REACH &&
                Math.abs(states[o + 2]) < LATTICE_REACH_Y &&
                Math.abs(states[o + 3]) < LATTICE_REACH;
            const visible =
                !reference &&
                states[o] > 0.5 &&
                inRange &&
                (cull === 0 || this.nearFocus(states[o + 1], states[o + 3], cull));
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
            if (t.hidden) for (let i = 0; i < t.parts.length; i++) t.parts[i].hidden = t.hidden(t.anim, i);
            this.world.rasterizeObject(t.id, t.parts, policy, this.raster);
            objects++;
        }
        // particles: single cells on the global grid, behind every object
        const pc =
            particles && !reference && this.withWorld ? Math.min(particleCount, Math.floor(particles.length / 4)) : 0;
        if (pc > 0) this.world.rasterizePoints(PARTICLE_OBJECT_ID, particles!, pc, 0);
        else if (this.world.objectCellCount(PARTICLE_OBJECT_ID) > 0) this.world.clearObject(PARTICLE_OBJECT_ID);
        const t1 = performance.now();
        const comp = this.world.resolve();
        const t2 = performance.now();
        const units = this.meshDirty();
        const t3 = performance.now();
        let staticRebuilt = 0;
        for (const u of units) if (u.mode === 'static') staticRebuilt++;
        let tiles: TileReport | undefined;
        if (this.stream?.changed) {
            this.stream.changed = false;
            const list = new Int32Array(this.stream.built.size * 2);
            let n = 0;
            for (const t of this.stream.built.values()) {
                list[n++] = t.ti;
                list[n++] = t.tk;
            }
            tiles = { size: STATIC_REGION.x * GRID_SIZE, tiles: list };
        }
        return {
            tiles,
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

    private nearFocus(x: number, z: number, r: number): boolean {
        const f = this.focus!;
        for (let n = 0; n + 1 < f.length; n += 2) if ((x - f[n]) ** 2 + (z - f[n + 1]) ** 2 < r * r) return true;
        return false;
    }

    /**
     * Streamed levels: drops tiles that every camera has left (with some slack, so walking back and
     * forth does not rebuild them), then builds the missing tiles within `radius` of a camera,
     * nearest first, until the time budget is spent (at least one when any is missing).
     */
    private updateTiles(focus: Float32Array, budgetMs: number, radius: number, maxTiles = 1): void {
        const st = this.stream!;
        const T = STATIC_REGION.x;
        const size = T * GRID_SIZE;
        const half = size * 0.5;
        const dist = (ti: number, tk: number) => {
            const cx = (ti + 0.5) * size;
            const cz = (tk + 0.5) * size;
            let d = Infinity;
            for (let n = 0; n + 1 < focus.length; n += 2) d = Math.min(d, Math.hypot(cx - focus[n], cz - focus[n + 1]));
            return d;
        };
        const key = (ti: number, tk: number) => (ti + 32768) * 65536 + (tk + 32768);
        // chunks emptied by earlier unloads (their empty meshes have gone out)
        this.world.releaseEmpty();
        const keep = st.radius + size * 2;
        for (const [k, t] of st.built) {
            if (dist(t.ti, t.tk) - half <= keep) continue;
            const r = { i0: t.ti * T, i1: t.ti * T + T - 1, k0: t.tk * T, k1: t.tk * T + T - 1 };
            this.world.clearStaticColumns(r);
            this.world.setTileBedrock(t.ti, t.tk, null);
            st.built.delete(k);
            st.changed = true;
        }
        // wanted tiles, nearest first, within the level's bounds
        const B = st.def.bounds;
        const want: { ti: number; tk: number; d: number }[] = [];
        for (let n = 0; n + 1 < focus.length; n += 2) {
            const ti0 = Math.floor(Math.max(B.minX, focus[n] - radius) / size);
            const ti1 = Math.floor(Math.min(B.maxX - 1e-6, focus[n] + radius) / size);
            const tk0 = Math.floor(Math.max(B.minZ, focus[n + 1] - radius) / size);
            const tk1 = Math.floor(Math.min(B.maxZ - 1e-6, focus[n + 1] + radius) / size);
            for (let tk = tk0; tk <= tk1; tk++)
                for (let ti = ti0; ti <= ti1; ti++) {
                    if (st.built.has(key(ti, tk))) continue;
                    const d = dist(ti, tk);
                    if (d - half > radius) continue;
                    if (!want.some((w) => w.ti === ti && w.tk === tk)) want.push({ ti, tk, d });
                }
        }
        want.sort((a, b) => a.d - b.d);
        const t0 = performance.now();
        let n = 0;
        for (const w of want) {
            const r = { i0: w.ti * T, i1: w.ti * T + T - 1, k0: w.tk * T, k1: w.tk * T + T - 1 };
            this.world.clip = r;
            try {
                st.def.stream!.buildTile(this.world, st.seed, r, { ti: w.ti, tk: w.tk });
            } finally {
                this.world.clip = null;
            }
            st.built.set(key(w.ti, w.tk), { ti: w.ti, tk: w.tk });
            st.changed = true;
            if (performance.now() - t0 > budgetMs || ++n >= maxTiles) break;
        }
        if (want.length > 0) this.world.finalizeStatic();
    }

    /**
     * The far lattice: clears the columns under newly built near tiles and rebuilds (coarse) the
     * columns of near tiles that went, so the two lattices never draw the same ground.
     */
    private updateHoles(tiles: Int32Array, size: number): void {
        const f = this.far!;
        if (size <= 0) return;
        const key = (ti: number, tk: number) => (ti + 32768) * 65536 + (tk + 32768);
        const want = new Map<number, { ti: number; tk: number }>();
        for (let n = 0; n + 1 < tiles.length; n += 2)
            want.set(key(tiles[n], tiles[n + 1]), { ti: tiles[n], tk: tiles[n + 1] });
        // columns whose centres lie inside the near tile
        const cols = (t: { ti: number; tk: number }) => ({
            i0: Math.ceil((t.ti * size) / GRID_SIZE - 0.5),
            i1: Math.ceil(((t.ti + 1) * size) / GRID_SIZE - 0.5) - 1,
            k0: Math.ceil((t.tk * size) / GRID_SIZE - 0.5),
            k1: Math.ceil(((t.tk + 1) * size) / GRID_SIZE - 0.5) - 1
        });
        this.world.releaseEmpty();
        for (const [k, t] of f.holes) {
            if (want.has(k)) continue;
            const r = cols(t);
            f.holes.delete(k);
            if (r.i0 > r.i1 || r.k0 > r.k1) continue;
            this.world.clip = r;
            try {
                f.def.stream!.buildTile(this.world, f.seed, r, { ti: 1e6 + t.ti, tk: 1e6 + t.tk });
            } finally {
                this.world.clip = null;
            }
        }
        for (const [k, t] of want) {
            if (f.holes.has(k)) continue;
            f.holes.set(k, t);
            const r = cols(t);
            if (r.i0 <= r.i1 && r.k0 <= r.k1) this.world.clearStaticColumns(r);
        }
        this.world.finalizeStatic();
    }

    /** Streamed levels: the tiles currently built (ti, tk). */
    get builtTiles(): { ti: number; tk: number }[] {
        return this.stream ? [...this.stream.built.values()] : [];
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
