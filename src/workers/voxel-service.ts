/**
 * The voxel world and its reconstruction, packaged as a service with no engine and no DOM
 * dependencies. Runs inside the voxel Web Worker in the browser (Phase C, design doc §5.5) and
 * directly in Node for benchmarks and tests.
 *
 * Per voxel frame: decode object states (already sampled at the voxel time by the main thread),
 * evaluate asset part poses, rasterize, resolve the composite, mesh dirty units, and return
 * finished buffers. The main thread only uploads them, all at once.
 */

import { assetBounds } from '../assets/cell-tier.ts';
import { TREE_STATE, TREE_SWAY } from '../assets/forestry.ts';
import { parseLevelData, levelFromData } from '../levels/data.ts';
import { clearStandTree, drawStandTree, drawStump } from '../levels/forestry.ts';
import type { ForestryDef } from '../levels/forestry.ts';
import { getLevel } from '../levels/index.ts';
import type { LevelDef } from '../levels/level.ts';
import { createLabEntities } from '../sim/lab-entities.ts';
import type { SimEntity } from '../sim/lab-entities.ts';
import { ANIM_MAX } from '../sim/snapshots.ts';
import { DYNAMIC_REGION, STATIC_REGION, collectDirty, unpackRegion } from '../voxels/dirty.ts';
import type { DirtyWork } from '../voxels/dirty.ts';
import {
    CHUNK_COORD_LIMIT,
    CHUNK_SIZE,
    CHUNK_Y_LIMIT,
    GRID_SIZE,
    candidateCells,
    cellIndexX,
    cellIndexY,
    cellIndexZ,
    createCellRange,
    rangeCellCount
} from '../voxels/grid.ts';
import { aabb, mat34, pose, poseToMat34, transformAabb } from '../voxels/math.ts';
import type { AABB, Pose } from '../voxels/math.ts';
import { MeshOutput, meshRegionBlocked } from '../voxels/mesher.ts';
import type { MeshMode } from '../voxels/mesher.ts';
import { MAX_PART_CANDIDATES, createRasterStats, resetRasterStats } from '../voxels/rasterizer.ts';
import type { SamplingPolicy } from '../voxels/rasterizer.ts';
import { VoxelWorld } from '../voxels/world.ts';
import type { CellBox, PartInstance } from '../voxels/world.ts';

import { PARTICLE_OBJECT_ID, STATE_STRIDE } from './protocol.ts';
import type { BuildInfo, ClassMesh, FrameStats, TileReport, UnitMesh } from './protocol.ts';

/** How far from the origin this lattice's chunks reach (m), with a margin for object size. */
const LATTICE_REACH = CHUNK_COORD_LIMIT * CHUNK_SIZE * GRID_SIZE - 4;
const LATTICE_REACH_Y = CHUNK_Y_LIMIT * CHUNK_SIZE * GRID_SIZE - 2;

interface Tracked {
    id: number;
    /** False: tracked for the state layout only, drawn by another lattice's service. */
    drawn: boolean;
    /** Drawn on another lattice and registered here as a mask (see VoxelWorld.rasterizeMask). */
    mask: boolean;
    /** Your own first-person limbs: win ties against other objects (see outranks). */
    ownBody: boolean;
    /** A mask's reach from its root (m, maskReach); 0 for others. */
    reach: number;
    /** World bounds of each part at the last pose (objectBounds). */
    partBounds: AABB[];
    /** Compositor order (priority desc, then id asc): lower rank wins. */
    priority: number;
    evaluate: (root: Pose, anim: ArrayLike<number>, out: Pose[]) => void;
    hidden?: (anim: ArrayLike<number>, part: number) => boolean;
    root: Pose;
    anim: Float64Array;
    poses: Pose[];
    parts: PartInstance[];
}

/**
 * The most any object may reach from its root (m), animation included (checked when a service
 * starts, see maskReach). A mask is looked for only within its own reach of this lattice's objects.
 */
export const MASK_REACH = 12;

/** How far an asset's parts may reach from its root: at rest, a quarter more and 0.5 m for animation. */
export function maskReach(b: AABB): number {
    const rest = Math.hypot(Math.max(-b.minX, b.maxX), Math.max(-b.minY, b.maxY), Math.max(-b.minZ, b.maxZ));
    return rest * 1.25 + 0.5;
}
/**
 * Candidate cells a lattice may sample for masks in one voxel frame (see rasterizeMasks). Measured
 * by scripts/bench-lattice.ts on the 1 cm lattice: at most about 2.7 ms a frame within it.
 */
export const MASK_BUDGET = 12_000;

/**
 * Does `a` win a shared cell against `b` (priority desc, then id asc, as the compositor orders)?
 * Your own first-person limbs win ties: another player's beaver (same priority, lower id) does not
 * cut holes in them.
 */
function outranks(a: Tracked, b: Tracked): boolean {
    if (a.priority !== b.priority) return a.priority > b.priority;
    if (a.ownBody !== b.ownBody) return a.ownBody;
    return a.id < b.id;
}

/** Candidate cells a mask's parts would sample inside their boxes (parts the rasterizer rejects cost 0). */
function maskCost(t: Tracked, boxes: readonly (CellBox | null)[]): number {
    let n = 0;
    t.parts.forEach((p, i) => {
        const box = boxes[i];
        if (p.hidden || !box) return;
        const pb = t.partBounds[i];
        if (!candidateCells(pb.minX, pb.minY, pb.minZ, pb.maxX, pb.maxY, pb.maxZ, _range)) return;
        if (rangeCellCount(_range) > MAX_PART_CANDIDATES) return;
        const nx = Math.min(_range.maxI, box.i1) - Math.max(_range.minI, box.i0) + 1;
        const ny = Math.min(_range.maxJ, box.j1) - Math.max(_range.minJ, box.j0) + 1;
        const nz = Math.min(_range.maxK, box.k1) - Math.max(_range.minK, box.k0) + 1;
        if (nx > 0 && ny > 0 && nz > 0) n += nx * ny * nz;
    });
    return n;
}
const _range = createCellRange();

/** Do two boxes overlap (touching counts)? An empty box (minX = Infinity) meets nothing. */
function meets(a: AABB, b: AABB): boolean {
    return (
        a.minX <= b.maxX &&
        b.minX <= a.maxX &&
        a.minY <= b.maxY &&
        b.minY <= a.maxY &&
        a.minZ <= b.maxZ &&
        b.minZ <= a.maxZ
    );
}

/** World bounds of an object's posed, shown parts, and of each part (t.partBounds). */
function objectBounds(t: Tracked, out: AABB): AABB {
    out.minX = out.minY = out.minZ = Infinity;
    out.maxX = out.maxY = out.maxZ = -Infinity;
    t.parts.forEach((p, i) => {
        const pb = t.partBounds[i];
        if (p.hidden) {
            pb.minX = Infinity; // empty: meets nothing
            return;
        }
        transformAabb(p.volume.bounds, poseToMat34(p.pose, _m), pb);
        out.minX = Math.min(out.minX, pb.minX);
        out.minY = Math.min(out.minY, pb.minY);
        out.minZ = Math.min(out.minZ, pb.minZ);
        out.maxX = Math.max(out.maxX, pb.maxX);
        out.maxY = Math.max(out.maxY, pb.maxY);
        out.maxZ = Math.max(out.maxZ, pb.maxZ);
    });
    return out;
}
const _m = mat34();

/** Order of tracked objects: every sim entity that has voxel parts, in sim order. */
export function trackedEntityOrder(sim: { entities: SimEntity[] }): number[] {
    return sim.entities.filter((e) => e.asset.parts.length > 0).map((e) => e.slot);
}

/** How the static layer draws a stand tree. */
type StandDrawn = 'standing' | 'stump' | 'none';

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
    /**
     * Logging (Epic 6): the level's stand trees, and per tree the stand marker it is read from
     * (tracked index) and whether the static layer shows it felled. The sim publishes each tree's
     * state in its marker's channels; a change re-draws that tree's static voxels (tree or stump).
     */
    /** Each stand tree as the static layer draws it: standing, a stump, or not at all (it leans: its marker draws it). */
    private wood: { def: ForestryDef; markers: number[]; drawn: StandDrawn[] } | null = null;
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
    /** `masks`: false leaves objects on other lattices out (#107 off; benchmarks compare with it). */
    constructor(objects?: Set<number>, masks = true) {
        this.world.addObject(PARTICLE_OBJECT_ID, 0);
        for (const e of createLabEntities().entities) {
            if (e.asset.parts.length === 0) continue;
            const drawn = !objects || objects.has(e.id);
            // another lattice's object takes its cells from this lattice's lower-priority objects
            // (only a lattice that draws objects of its own needs to know)
            const mask = masks && !drawn && objects !== undefined && objects.size > 0;
            const ownBody = e.name === 'fp-body';
            if (drawn || mask) this.world.addObject(e.id, e.priority, mask, ownBody);
            const reach = mask ? maskReach(assetBounds(e.asset)) : 0;
            if (!(reach <= MASK_REACH))
                throw new Error(`${e.name}: reaches ${reach.toFixed(2)} m from its root, over MASK_REACH`);
            const poses = e.asset.parts.map(() => pose());
            this.tracked.push({
                id: e.id,
                drawn,
                mask,
                ownBody,
                reach,
                partBounds: e.asset.parts.map(() => aabb(0, 0, 0, 0, 0, 0)),
                priority: e.priority,
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
        this.wood = null;
        if (def.forestry && this.withWorld) {
            const ents = createLabEntities().entities.filter((e) => e.asset.parts.length > 0);
            const markers = def.forestry.trees.map((_, k) => ents.findIndex((e) => e.name === `tree-${k}`));
            this.wood = { def: def.forestry, markers, drawn: markers.map((): StandDrawn => 'standing') };
        }
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
        nearTileSize = 0,
        nearRadius?: number
    ): { units: UnitMesh[]; stats: FrameStats; tiles?: TileReport } {
        const t0 = performance.now();
        resetRasterStats(this.raster);
        let objects = 0;
        if (focus && focus.length >= 2) this.focus = focus;
        // the quality preset's view distance: tiles beyond the new radius go on the next unload
        if (this.stream && nearRadius !== undefined && nearRadius > 0) this.stream.radius = nearRadius;
        if (this.stream && this.focus) this.updateTiles(this.focus, this.tileBudgetMs, this.stream.radius);
        if (this.far && nearTiles) this.updateHoles(nearTiles, nearTileSize);
        if (this.wood) this.updateStand(states);
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
            objectBounds(t, this.boundsOf(t));
            this.local.push(t);
            objects++;
        }
        this.rasterizeMasks(states, reference, cull);
        this.local.length = 0;
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
                latticeMasks: this.maskStats.masks,
                latticeHidden: comp.latticeHidden,
                maskSkipped: this.maskStats.skipped,
                maskCells: this.maskStats.cells,
                maskRejected: this.maskStats.rejected,
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

    /** This frame's drawn objects (for the masks), and per tracked object its world bounds. */
    private readonly local: Tracked[] = [];
    private readonly bounds = new Map<number, AABB>();
    /** Mask rasterization telemetry, reset every frame (its rejections are reported). */
    private readonly maskRaster = createRasterStats();
    private readonly maskQueue: { t: Tracked; boxes: (CellBox | null)[]; cost: number }[] = [];
    /** Candidate cells masks may sample a frame (MASK_BUDGET; tests lower it). */
    maskBudget = MASK_BUDGET;
    /** Last frame's masks: rasterized, skipped over the budget, and the candidate cells spent. */
    readonly maskStats = { masks: 0, skipped: 0, cells: 0, rejected: 0 };

    private boundsOf(t: Tracked): AABB {
        let b = this.bounds.get(t.id);
        if (!b) {
            b = aabb(0, 0, 0, 0, 0, 0);
            this.bounds.set(t.id, b);
        }
        return b;
    }

    /**
     * Per-item cell sizes: every object drawn on another lattice that outranks one of this
     * lattice's objects it touches is rasterized here, at this lattice's size, inside one box: the
     * union of where its bounds meet theirs (one cell of margin). Where it wins, those cells are left
     * empty here and only its own lattice draws them. A cell gives way where its centre lies inside
     * the winner ('center' sampling: one sample a cell).
     *
     * Budget: at most MASK_BUDGET candidate cells a frame on this lattice. Masks are taken in
     * compositor order (the highest priority first); one that would overrun what is left is skipped
     * this frame (its object and this lattice's simply intersect, as before #107) and counted.
     */
    private rasterizeMasks(states: Float64Array, reference: boolean, cull: number): void {
        const st = this.maskStats;
        st.masks = st.skipped = st.cells = 0;
        resetRasterStats(this.maskRaster);
        const queue = this.maskQueue;
        queue.length = 0;
        for (let n = 0; n < this.tracked.length; n++) {
            const t = this.tracked[n];
            if (!t.mask) continue;
            const o = n * STATE_STRIDE;
            const visible =
                !reference &&
                this.local.length > 0 &&
                states[o] > 0.5 &&
                Math.abs(states[o + 1]) < LATTICE_REACH &&
                Math.abs(states[o + 2]) < LATTICE_REACH_Y &&
                Math.abs(states[o + 3]) < LATTICE_REACH &&
                (cull === 0 || this.nearFocus(states[o + 1], states[o + 3], cull));
            const boxes = visible ? this.maskBoxesFor(t, states, o) : null;
            if (boxes) queue.push({ t, boxes, cost: maskCost(t, boxes) });
            else if (this.world.objectCellCount(t.id) > 0) this.world.clearObject(t.id);
        }
        queue.sort((a, b) => (outranks(a.t, b.t) ? -1 : 1));
        for (const q of queue) {
            if (st.cells + q.cost > this.maskBudget) {
                st.skipped++;
                if (this.world.objectCellCount(q.t.id) > 0) this.world.clearObject(q.t.id);
                continue;
            }
            st.cells += q.cost;
            this.world.rasterizeMask(q.t.id, q.t.parts, 'center', this.maskRaster, q.boxes);
            st.masks++;
        }
        st.rejected = this.maskRaster.rejected;
    }

    /**
     * Poses a mask object and returns, per part, the box (cells) where its bounds meet the bounds
     * of the parts of this lattice's objects it outranks (null for a part that meets none), or null
     * when no part meets any.
     */
    private maskBoxesFor(t: Tracked, states: Float64Array, o: number): (CellBox | null)[] | null {
        // cheap first: is its root within its reach of any object it outranks?
        const px = states[o + 1];
        const py = states[o + 2];
        const pz = states[o + 3];
        let near = false;
        for (const l of this.local) {
            if (!outranks(t, l)) continue;
            const b = this.bounds.get(l.id)!;
            if (
                px > b.minX - t.reach &&
                px < b.maxX + t.reach &&
                py > b.minY - t.reach &&
                py < b.maxY + t.reach &&
                pz > b.minZ - t.reach &&
                pz < b.maxZ + t.reach
            ) {
                near = true;
                break;
            }
        }
        if (!near) return null;
        t.root.p.x = px;
        t.root.p.y = py;
        t.root.p.z = pz;
        t.root.q.x = states[o + 4];
        t.root.q.y = states[o + 5];
        t.root.q.z = states[o + 6];
        t.root.q.w = states[o + 7];
        for (let c = 0; c < ANIM_MAX; c++) t.anim[c] = states[o + 8 + c];
        t.evaluate(t.root, t.anim, t.poses);
        if (t.hidden) for (let i = 0; i < t.parts.length; i++) t.parts[i].hidden = t.hidden(t.anim, i);
        const mb = objectBounds(t, this.boundsOf(t));
        // this lattice's parts it may take cells from: those of the objects it outranks, near it
        const targets: AABB[] = [];
        for (const l of this.local) {
            if (!outranks(t, l) || !meets(mb, this.bounds.get(l.id)!)) continue;
            for (const pb of l.partBounds) if (meets(mb, pb)) targets.push(pb);
        }
        if (targets.length === 0) return null;
        // per part: the union of where its bounds meet theirs, one cell of margin
        let any = false;
        const boxes = t.parts.map((p, i): CellBox | null => {
            if (p.hidden) return null;
            const pb = t.partBounds[i];
            let x0 = Infinity;
            let y0 = Infinity;
            let z0 = Infinity;
            let x1 = -Infinity;
            let y1 = -Infinity;
            let z1 = -Infinity;
            for (const b of targets) {
                if (!meets(pb, b)) continue;
                x0 = Math.min(x0, Math.max(pb.minX, b.minX));
                y0 = Math.min(y0, Math.max(pb.minY, b.minY));
                z0 = Math.min(z0, Math.max(pb.minZ, b.minZ));
                x1 = Math.max(x1, Math.min(pb.maxX, b.maxX));
                y1 = Math.max(y1, Math.min(pb.maxY, b.maxY));
                z1 = Math.max(z1, Math.min(pb.maxZ, b.maxZ));
            }
            if (x0 > x1) return null;
            any = true;
            return {
                i0: cellIndexX(x0) - 1,
                i1: cellIndexX(x1) + 1,
                j0: cellIndexY(y0) - 1,
                j1: cellIndexY(y1) + 1,
                k0: cellIndexZ(z0) - 1,
                k1: cellIndexZ(z1) + 1
            };
        });
        return any ? boxes : null;
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
        // slack in proportion to the radius (36 m keeps ~48.6 m, 24 m keeps ~32.4 m)
        const keep = st.radius * 1.35;
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
            // a fresh tile draws its stand trees standing
            if (this.wood)
                this.wood.def.trees.forEach((t, k) => {
                    const i = cellIndexX(t.x);
                    const kk = cellIndexZ(t.z);
                    if (i >= r.i0 && i <= r.i1 && kk >= r.k0 && kk <= r.k1) this.wood!.drawn[k] = 'standing';
                });
            if (performance.now() - t0 > budgetMs || ++n >= maxTiles) break;
        }
        if (want.length > 0) this.world.finalizeStatic();
    }

    /**
     * Stand trees whose state changed in the snapshots: a felled one leaves the static layer (a
     * stump stays), a regrown one comes back, and a leaning one (the falling-tree hazard, #74)
     * leaves it whole while its marker draws it tilted, coming back if it stands up again. Only
     * where the world is built (streamed levels: the tree's tile).
     */
    private updateStand(states: Float64Array): void {
        const w = this.wood!;
        let changed = false;
        for (let k = 0; k < w.markers.length; k++) {
            const n = w.markers[k];
            if (n < 0) continue;
            const o = n * STATE_STRIDE;
            // a hidden marker says nothing (no snapshot yet)
            if (!(states[o] > 0.5)) continue;
            const want: StandDrawn =
                states[o + 8 + TREE_STATE] > 0.5 ? 'stump' : states[o + 8 + TREE_SWAY] > 0.001 ? 'none' : 'standing';
            if (want === w.drawn[k]) continue;
            const t = w.def.trees[k];
            if (this.stream) {
                const T = this.world.tileCells;
                const tk = (ti: number, tkk: number) => (ti + 32768) * 65536 + (tkk + 32768);
                if (!this.stream.built.has(tk(Math.floor(cellIndexX(t.x) / T), Math.floor(cellIndexZ(t.z) / T))))
                    continue;
            }
            const g = w.def.ground(t.x, t.z);
            clearStandTree(this.world, t, k, g, this.raster);
            if (want === 'stump') drawStump(this.world, t, g, this.raster);
            else if (want === 'standing') drawStandTree(this.world, t, k, g, this.raster);
            w.drawn[k] = want;
            changed = true;
        }
        if (changed) this.world.finalizeStatic();
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
