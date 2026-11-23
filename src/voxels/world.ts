/**
 * Sparse chunked voxel world and deterministic compositor (design doc §5.3 steps 4-5, §5.5).
 *
 * Two layers per chunk:
 *  - static: authored scenery, rasterized once. Never erased by a dynamic object.
 *  - dyn:    the composited winner of all dynamic objects covering a cell, rebuilt per voxel frame
 *            only for cells whose contributors changed.
 *
 * Each dynamic object keeps its own sparse occupancy (cell key -> value). When an object moves, the
 * symmetric difference between its previous and current occupancy marks cells dirty, and each dirty
 * cell re-resolves its winner from all objects in a fixed order (priority desc, id asc). When the
 * winner leaves, the next contributor - or the static layer - shows through again. Nothing is ever
 * erased from the static layer.
 *
 * Composite policy: a dynamic cell overrides a static cell (counted as telemetry). Overlaps between
 * dynamic objects are resolved by object priority, then lower id.
 *
 * Masks (per-item cell sizes, ADR 0011): an object drawn on another lattice can be registered as a
 * mask. It is rasterized on this lattice, only where it meets this lattice's own objects, and takes
 * part in the same priority order; where a mask wins a cell, the cell is left empty here (the other
 * lattice draws it). So a 1 cm bucket held in a 5 cm paw shows the bucket, not the paw through it.
 *
 * Storage is sparse: chunks are allocated only when written. A level-sized dense array is never
 * allocated (§5.5).
 */

import {
    CHUNK_BITS,
    CHUNK_MASK,
    CHUNK_SIZE,
    CHUNK_VOLUME,
    GRID_SIZE,
    chunkCoordInRange,
    chunkYInRange,
    localIndex,
    packChunkCoord
} from './grid.ts';
import type { Pose } from './math.ts';
import { rasterizeVolume } from './rasterizer.ts';
import type { CellSink, RasterStats, SamplingPolicy } from './rasterizer.ts';
import type { Volume } from './volumes.ts';

/** Chunk ids stay below 2^18 so cell keys (id * 4096 + local) stay small integers. */
export const MAX_CHUNKS = 1 << 18;

export class Chunk {
    readonly id: number;
    readonly cx: number;
    readonly cy: number;
    readonly cz: number;
    stat: Uint16Array | null = null;
    statPrio: Uint8Array | null = null;
    dyn: Uint16Array | null = null;
    staticCount = 0;
    dynCount = 0;
    /** Cells where a dynamic value overrides a static value. */
    overrideCount = 0;
    /** Set when the dynamic layer in or next to this chunk changed. */
    dynDirty = false;
    /** Set when static emission in this chunk changed (static write or override change). */
    staticDirty = false;

    constructor(id: number, cx: number, cy: number, cz: number) {
        this.id = id;
        this.cx = cx;
        this.cy = cy;
        this.cz = cz;
    }
}

/** A part of a dynamic object for one voxel frame. */
export interface PartInstance {
    volume: Volume;
    pose: Pose;
    priority: number;
    /** Optional per-asset-class sampling policy override. */
    policy?: SamplingPolicy;
    /** Left out of this frame (see VoxelAsset.partHidden). */
    hidden?: boolean;
}

interface DynamicEntry {
    id: number;
    priority: number;
    /** Drawn on another lattice: wins cells by priority but leaves them empty here. */
    mask: boolean;
    ownBody: boolean;
    cells: Map<number, number>;
    prev: Map<number, number>;
    /** Occupied cells after the last rasterization. */
    count: number;
}

export interface CompositeStats {
    dirtyCells: number;
    changedCells: number;
    dynDynOverlaps: number;
    dynStaticOverlaps: number;
    /** Cells an object on another lattice now takes from one of this lattice's objects. */
    latticeHidden: number;
}

/**
 * Implicit solid ground below a heightfield shell: cells under each column's stored bottom count as
 * solid for face exposure and AO, but are never drawn and never stored. Lets terrain be stored as a
 * thin shell (sparse) without emitting the hidden underside faces.
 */
export interface Bedrock {
    minI: number;
    minK: number;
    width: number;
    depth: number;
    /** Per column (i - minI) + (k - minK) * width: cells with j < bottom are implicitly solid. */
    bottom: Int32Array;
}

/** A rectangle of cell columns (inclusive). */
export interface ColumnRect {
    i0: number;
    i1: number;
    k0: number;
    k1: number;
}

/** A box of cells (inclusive): where a mask object is sampled. */
export interface CellBox extends ColumnRect {
    j0: number;
    j1: number;
}

/** The value a mask holds in its own occupancy (never drawn: a winning mask leaves the cell empty). */
const MASK_VALUE = 0xffff;

const tileKey = (ti: number, tk: number) => (ti + 32768) * 65536 + (tk + 32768);

export class VoxelWorld {
    private readonly byCoord = new Map<number, Chunk>();
    /** Bedrock of a level built in one go. */
    bedrock: Bedrock | null = null;
    /**
     * Streamed levels: bedrock per tile of `tileCells` x `tileCells` columns (tile (ti, tk) covers
     * columns ti * tileCells .. (ti + 1) * tileCells - 1), added and dropped with the tile.
     */
    readonly bedrockTiles = new Map<number, Bedrock>();
    tileCells = 0;
    /** When set, static writes outside these columns are ignored (building one tile). */
    clip: ColumnRect | null = null;
    /** Ids of released chunks, reused before new ones are made. */
    private readonly freeIds: number[] = [];

    /** The bedrock holding column (i, k), if any. */
    bedrockAt(i: number, k: number): Bedrock | null {
        const b = this.bedrock;
        if (b) {
            const x = i - b.minI;
            const z = k - b.minK;
            if (x >= 0 && z >= 0 && x < b.width && z < b.depth) return b;
        }
        if (this.tileCells === 0 || this.bedrockTiles.size === 0) return null;
        const t = this.tileCells;
        return this.bedrockTiles.get(tileKey(Math.floor(i / t), Math.floor(k / t))) ?? null;
    }

    /** True when a cell lies inside the implicit bedrock. */
    isBedrock(i: number, j: number, k: number): boolean {
        const b = this.bedrockAt(i, k);
        if (!b) return false;
        const x = i - b.minI;
        const z = k - b.minK;
        if (x < 0 || z < 0 || x >= b.width || z >= b.depth) return false;
        return j < b.bottom[x + z * b.width];
    }

    /** Registers the bedrock of one streamed tile. */
    setTileBedrock(ti: number, tk: number, b: Bedrock | null): void {
        if (b) this.bedrockTiles.set(tileKey(ti, tk), b);
        else this.bedrockTiles.delete(tileKey(ti, tk));
    }

    readonly chunks: Chunk[] = [];
    private readonly objects = new Map<number, DynamicEntry>();
    private order: DynamicEntry[] = [];
    private readonly dirtyCells = new Set<number>();

    /** Composite telemetry from the last resolve(). */
    readonly lastComposite: CompositeStats = {
        dirtyCells: 0,
        changedCells: 0,
        dynDynOverlaps: 0,
        dynStaticOverlaps: 0,
        latticeHidden: 0
    };
    /** Running totals of overlap cells currently present. */
    dynStaticOverlapCells = 0;
    /** Cells (keys) where a mask currently hides one of this lattice's objects. */
    private readonly latticeHiddenCells = new Set<number>();

    // ------------------------------------------------------------------------------- chunks

    getChunk(cx: number, cy: number, cz: number): Chunk | undefined {
        return this.byCoord.get(packChunkCoord(cx, cy, cz));
    }

    getOrCreateChunk(cx: number, cy: number, cz: number): Chunk {
        const key = packChunkCoord(cx, cy, cz);
        let c = this.byCoord.get(key);
        if (!c) {
            if (!chunkCoordInRange(cx) || !chunkYInRange(cy) || !chunkCoordInRange(cz)) {
                throw new RangeError(`Chunk coordinate out of range: ${cx}, ${cy}, ${cz}`);
            }
            const free = this.freeIds.pop();
            if (free !== undefined) {
                c = new Chunk(free, cx, cy, cz);
                this.chunks[free] = c;
            } else {
                if (this.chunks.length >= MAX_CHUNKS) throw new RangeError('Chunk budget exceeded');
                c = new Chunk(this.chunks.length, cx, cy, cz);
                this.chunks.push(c);
            }
            this.byCoord.set(key, c);
        }
        return c;
    }

    /** Small-integer key of a cell: chunk id * 4096 + local index. Creates the chunk if needed. */
    cellKey(i: number, j: number, k: number): number {
        const c = this.getOrCreateChunk(i >> CHUNK_BITS, j >> CHUNK_BITS, k >> CHUNK_BITS);
        return c.id * CHUNK_VOLUME + localIndex(i & CHUNK_MASK, j & CHUNK_MASK, k & CHUNK_MASK);
    }

    /** Live chunks (released ones are not counted). */
    get chunkCount(): number {
        return this.chunks.length - this.freeIds.length;
    }

    /**
     * Drops the static layer of a rectangle of columns (a streamed tile leaving view). The chunks
     * are marked static-dirty, so their regions re-mesh (empty when nothing is left). Chunks left
     * with nothing in them are released later by `releaseEmpty` (after the empty meshes went out).
     */
    clearStaticColumns(r: ColumnRect): void {
        const ci0 = r.i0 >> CHUNK_BITS;
        const ci1 = r.i1 >> CHUNK_BITS;
        const ck0 = r.k0 >> CHUNK_BITS;
        const ck1 = r.k1 >> CHUNK_BITS;
        for (const c of this.chunks) {
            if (c.cx < ci0 - 1 || c.cx > ci1 + 1 || c.cz < ck0 - 1 || c.cz > ck1 + 1) continue;
            // neighbours keep their meshes: their faces towards the cleared columns (on the edge of
            // the near world, over the far lattice) are not worth re-meshing a whole region for
            if (!c.stat || c.cx < ci0 || c.cx > ci1 || c.cz < ck0 || c.cz > ck1) continue;
            // the part of this chunk inside the rectangle (all of it when the rectangle is aligned)
            const x0 = Math.max(0, r.i0 - c.cx * CHUNK_SIZE);
            const x1 = Math.min(CHUNK_SIZE - 1, r.i1 - c.cx * CHUNK_SIZE);
            const z0 = Math.max(0, r.k0 - c.cz * CHUNK_SIZE);
            const z1 = Math.min(CHUNK_SIZE - 1, r.k1 - c.cz * CHUNK_SIZE);
            const whole = x0 === 0 && z0 === 0 && x1 === CHUNK_SIZE - 1 && z1 === CHUNK_SIZE - 1;
            if (whole) {
                c.stat = null;
                c.statPrio = null;
                c.staticCount = 0;
            } else {
                for (let ly = 0; ly < CHUNK_SIZE; ly++)
                    for (let lz = z0; lz <= z1; lz++)
                        for (let lx = x0; lx <= x1; lx++) {
                            const li = localIndex(lx, ly, lz);
                            if (c.stat[li] === 0) continue;
                            if (c.dyn && c.dyn[li] !== 0) {
                                c.overrideCount--;
                                this.dynStaticOverlapCells--;
                            }
                            c.stat[li] = 0;
                            c.staticCount--;
                        }
                if (c.staticCount === 0) {
                    c.stat = null;
                    c.statPrio = null;
                }
            }
            if (whole && c.overrideCount) {
                this.dynStaticOverlapCells -= c.overrideCount;
                c.overrideCount = 0;
            }
            c.staticDirty = true;
            c.dynDirty = true;
        }
    }

    /** Marks the static chunks around a column rectangle for re-meshing (a tile arrived next door). */
    touchAround(r: ColumnRect): void {
        const ci0 = (r.i0 >> CHUNK_BITS) - 1;
        const ci1 = (r.i1 >> CHUNK_BITS) + 1;
        const ck0 = (r.k0 >> CHUNK_BITS) - 1;
        const ck1 = (r.k1 >> CHUNK_BITS) + 1;
        for (const c of this.chunks) {
            if (!c.stat || c.cx < ci0 || c.cx > ci1 || c.cz < ck0 || c.cz > ck1) continue;
            const inside = c.cx > ci0 && c.cx < ci1 && c.cz > ck0 && c.cz < ck1;
            if (!inside) c.staticDirty = true;
        }
    }

    /** Releases chunks that hold nothing and have no pending re-mesh; their ids are reused. */
    releaseEmpty(): number {
        let n = 0;
        for (const c of this.chunks) {
            if (c.stat || c.dynCount > 0 || c.staticDirty || c.dynDirty) continue;
            if (this.byCoord.get(packChunkCoord(c.cx, c.cy, c.cz)) !== c) continue;
            this.byCoord.delete(packChunkCoord(c.cx, c.cy, c.cz));
            c.dyn = null;
            this.freeIds.push(c.id);
            n++;
        }
        return n;
    }

    // ------------------------------------------------------------------------------- static layer

    /**
     * Writes a static voxel. When two static writes hit the same cell, the higher priority wins;
     * equal priority keeps the first. Value 0 is ignored (static cells are only added at load).
     */
    setStatic(i: number, j: number, k: number, value: number, priority = 0): void {
        if (value <= 0) return;
        const clip = this.clip;
        if (clip && (i < clip.i0 || i > clip.i1 || k < clip.k0 || k > clip.k1)) return;
        const c = this.getOrCreateChunk(i >> CHUNK_BITS, j >> CHUNK_BITS, k >> CHUNK_BITS);
        if (!c.stat) c.stat = new Uint16Array(CHUNK_VOLUME);
        if (!c.statPrio) c.statPrio = new Uint8Array(CHUNK_VOLUME);
        const li = localIndex(i & CHUNK_MASK, j & CHUNK_MASK, k & CHUNK_MASK);
        const old = c.stat[li];
        if (old !== 0 && c.statPrio![li] >= priority) return;
        if (old === 0) c.staticCount++;
        c.stat[li] = value;
        c.statPrio![li] = priority;
        c.staticDirty = true;
        this.markDynDirtyAround(c, li);
    }

    /**
     * Ends static loading: frees the per-cell static priorities (only needed to resolve overlaps
     * between static writes). A later static write simply starts from priority 0 again.
     */
    finalizeStatic(): void {
        for (const c of this.chunks) c.statPrio = null;
    }

    /** Rasterizes a static volume once into the static layer. */
    rasterizeStatic(
        volume: Volume,
        worldPose: Pose,
        policy: SamplingPolicy,
        priority: number,
        stats: RasterStats
    ): void {
        this.staticSink.priority = priority;
        rasterizeVolume(volume, worldPose, policy, priority, this.staticSink, stats, this.clip);
    }

    private readonly staticSink = {
        world: this as VoxelWorld,
        priority: 0,
        write(i: number, j: number, k: number, value: number, priority: number) {
            this.world.setStatic(i, j, k, value, priority);
        }
    };

    /**
     * Removes one static voxel (a felled tree leaves the static layer). The chunk and any
     * neighbour sharing a face with the cell re-mesh. Returns false when the cell held none.
     */
    clearStatic(i: number, j: number, k: number): boolean {
        const c = this.byCoord.get(packChunkCoord(i >> CHUNK_BITS, j >> CHUNK_BITS, k >> CHUNK_BITS));
        if (!c || !c.stat) return false;
        const li = localIndex(i & CHUNK_MASK, j & CHUNK_MASK, k & CHUNK_MASK);
        if (c.stat[li] === 0) return false;
        if (c.dyn && c.dyn[li] !== 0) {
            c.overrideCount--;
            this.dynStaticOverlapCells--;
        }
        c.stat[li] = 0;
        if (c.statPrio) c.statPrio[li] = 0;
        c.staticCount--;
        c.staticDirty = true;
        this.markDynDirtyAround(c, li, true);
        return true;
    }

    /** Visits the cells a volume covers (as rasterizeStatic would write them), writing nothing. */
    forEachCell(
        volume: Volume,
        worldPose: Pose,
        policy: SamplingPolicy,
        fn: (i: number, j: number, k: number, value: number) => void,
        stats: RasterStats
    ): void {
        rasterizeVolume(volume, worldPose, policy, 0, { write: fn }, stats, this.clip);
    }

    staticAt(i: number, j: number, k: number): number {
        const c = this.byCoord.get(packChunkCoord(i >> CHUNK_BITS, j >> CHUNK_BITS, k >> CHUNK_BITS));
        if (!c || !c.stat) return 0;
        return c.stat[localIndex(i & CHUNK_MASK, j & CHUNK_MASK, k & CHUNK_MASK)];
    }

    dynAt(i: number, j: number, k: number): number {
        const c = this.byCoord.get(packChunkCoord(i >> CHUNK_BITS, j >> CHUNK_BITS, k >> CHUNK_BITS));
        if (!c || !c.dyn) return 0;
        return c.dyn[localIndex(i & CHUNK_MASK, j & CHUNK_MASK, k & CHUNK_MASK)];
    }

    /** Visible composite value: dynamic overrides static. */
    valueAt(i: number, j: number, k: number): number {
        const c = this.byCoord.get(packChunkCoord(i >> CHUNK_BITS, j >> CHUNK_BITS, k >> CHUNK_BITS));
        if (!c) return 0;
        const li = localIndex(i & CHUNK_MASK, j & CHUNK_MASK, k & CHUNK_MASK);
        const d = c.dyn ? c.dyn[li] : 0;
        if (d) return d;
        return c.stat ? c.stat[li] : 0;
    }

    // ------------------------------------------------------------------------------- dynamic objects

    /** `ownBody`: your own first-person limbs, first among equal priorities (see VoxelService). */
    addObject(id: number, priority = 0, mask = false, ownBody = false): void {
        if (this.objects.has(id)) throw new Error(`Dynamic object ${id} already registered`);
        if (!Number.isInteger(id) || id < 0) throw new Error(`Invalid object id ${id}`);
        const e: DynamicEntry = { id, priority, mask, ownBody, cells: new Map(), prev: new Map(), count: 0 };
        this.objects.set(id, e);
        this.order.push(e);
        this.order.sort((a, b) => b.priority - a.priority || Number(b.ownBody) - Number(a.ownBody) || a.id - b.id);
    }

    hasObject(id: number): boolean {
        return this.objects.has(id);
    }

    get objectCount(): number {
        return this.objects.size;
    }

    objectCellCount(id: number): number {
        return this.objects.get(id)?.count ?? 0;
    }

    /** Iterates (cellKey, value) of one object's current occupancy. For tests and debug. */
    objectCells(id: number): ReadonlyMap<number, number> {
        const e = this.objects.get(id);
        const out = new Map<number, number>();
        if (!e) return out;
        for (const [k, v] of e.cells) out.set(k, v & 0xffff);
        return out;
    }

    removeObject(id: number): void {
        const e = this.objects.get(id);
        if (!e) return;
        for (const key of e.cells.keys()) this.dirtyCells.add(key);
        e.cells.clear();
        e.prev.clear();
        this.objects.delete(id);
        this.order = this.order.filter((o) => o !== e);
    }

    private readonly objSink = {
        world: this as VoxelWorld,
        target: null as Map<number, number> | null,
        write(i: number, j: number, k: number, value: number, priority: number) {
            const key = this.world.cellKey(i, j, k);
            const map = this.target!;
            const packed = value | (priority << 16);
            const old = map.get(key);
            // within one object the higher part priority wins; equal priority keeps the first part
            if (old === undefined || priority > old >>> 16) map.set(key, packed);
        }
    } satisfies CellSink & { world: VoxelWorld; target: Map<number, number> | null };

    /**
     * Rasterizes all parts of an object for this voxel frame and marks changed cells dirty.
     * Returns the number of cells whose value for this object changed.
     */
    rasterizeObject(id: number, parts: readonly PartInstance[], policy: SamplingPolicy, stats: RasterStats): number {
        const e = this.objects.get(id);
        if (!e) throw new Error(`Unknown dynamic object ${id}`);
        // swap buffers; reuse the old map as the new target
        const prev = e.cells;
        const next = e.prev;
        next.clear();
        this.objSink.target = next;
        for (let p = 0; p < parts.length; p++) {
            const part = parts[p];
            if (part.hidden) continue;
            const prio = Math.max(0, Math.min(255, part.priority | 0));
            rasterizeVolume(part.volume, part.pose, part.policy ?? policy, prio, this.objSink, stats);
        }
        this.objSink.target = null;
        e.prev = prev;
        e.cells = next;
        e.count = next.size;

        let changed = 0;
        const dirty = this.dirtyCells;
        for (const [key, v] of next) {
            const old = prev.get(key);
            if (old === undefined || (old & 0xffff) !== (v & 0xffff)) {
                dirty.add(key);
                changed++;
            }
        }
        for (const key of prev.keys()) {
            if (!next.has(key)) {
                dirty.add(key);
                changed++;
            }
        }
        return changed;
    }

    private readonly maskSink = {
        world: this as VoxelWorld,
        target: null as Map<number, number> | null,
        write(i: number, j: number, k: number, _value: number, priority: number) {
            // only where this lattice has chunks: a mask matters only over this lattice's own cells
            const c = this.world.getChunk(i >> CHUNK_BITS, j >> CHUNK_BITS, k >> CHUNK_BITS);
            if (!c) return;
            const key = c.id * CHUNK_VOLUME + localIndex(i & CHUNK_MASK, j & CHUNK_MASK, k & CHUNK_MASK);
            if (!this.target!.has(key)) this.target!.set(key, MASK_VALUE | (priority << 16));
        }
    } satisfies CellSink & { world: VoxelWorld; target: Map<number, number> | null };

    /**
     * Rasterizes a mask object (registered with `mask`), each part only inside its own cell box
     * (`boxes[part]`; null leaves the part out), and marks changed cells dirty. `policy` is the
     * mask's own (the service samples cell centres: a cell gives way where its centre lies inside
     * the winner). Returns the number of cells that changed.
     */
    rasterizeMask(
        id: number,
        parts: readonly PartInstance[],
        policy: SamplingPolicy,
        stats: RasterStats,
        boxes: readonly (CellBox | null)[]
    ): number {
        const e = this.objects.get(id);
        if (!e || !e.mask) throw new Error(`Unknown mask object ${id}`);
        const prev = e.cells;
        const next = e.prev;
        next.clear();
        this.maskSink.target = next;
        for (let p = 0; p < parts.length; p++) {
            const part = parts[p];
            const b = boxes[p];
            if (part.hidden || !b) continue;
            rasterizeVolume(part.volume, part.pose, policy, e.priority, this.maskSink, stats, b);
        }
        this.maskSink.target = null;
        e.prev = prev;
        e.cells = next;
        e.count = next.size;
        let changed = 0;
        const dirty = this.dirtyCells;
        for (const key of next.keys())
            if (!prev.has(key)) {
                dirty.add(key);
                changed++;
            }
        for (const key of prev.keys())
            if (!next.has(key)) {
                dirty.add(key);
                changed++;
            }
        return changed;
    }

    /**
     * Writes an object made of single cells (particles: leaves, chips, splashes). `points` holds
     * x, y, z (metres) and a voxel value per point; each point fills the one cell containing it, on
     * the global grid like everything else. Marks changed cells dirty; returns how many changed.
     */
    rasterizePoints(id: number, points: Float32Array, count: number, priority = 0): number {
        const e = this.objects.get(id);
        if (!e) throw new Error(`Unknown dynamic object ${id}`);
        const prev = e.cells;
        const next = e.prev;
        next.clear();
        const inv = 1 / GRID_SIZE;
        for (let n = 0; n < count; n++) {
            const o = n * 4;
            const x = points[o];
            const y = points[o + 1];
            const z = points[o + 2];
            if (!Number.isFinite(x + y + z)) continue;
            const key = this.cellKey(Math.floor(x * inv), Math.floor(y * inv), Math.floor(z * inv));
            if (!next.has(key)) next.set(key, (points[o + 3] & 0xffff) | (priority << 16));
        }
        e.prev = prev;
        e.cells = next;
        e.count = next.size;
        let changed = 0;
        const dirty = this.dirtyCells;
        for (const [key, v] of next) {
            const old = prev.get(key);
            if (old === undefined || (old & 0xffff) !== (v & 0xffff)) {
                dirty.add(key);
                changed++;
            }
        }
        for (const key of prev.keys()) {
            if (!next.has(key)) {
                dirty.add(key);
                changed++;
            }
        }
        return changed;
    }

    /** Clears an object's occupancy without removing it (e.g. hidden in reference mode). */
    clearObject(id: number): void {
        const e = this.objects.get(id);
        if (!e) return;
        for (const key of e.cells.keys()) this.dirtyCells.add(key);
        e.cells.clear();
        e.prev.clear();
        e.count = 0;
    }

    get pendingDirtyCells(): number {
        return this.dirtyCells.size;
    }

    /**
     * Resolves the composite winner of every dirty cell and marks affected chunks dirty.
     * Call once per voxel frame after rasterizing all objects, before meshing.
     */
    resolve(): CompositeStats {
        const st = this.lastComposite;
        st.dirtyCells = this.dirtyCells.size;
        st.changedCells = 0;
        st.dynDynOverlaps = 0;
        st.dynStaticOverlaps = 0;
        // only objects holding cells can contribute (the same order, without the empty ones)
        const order = this.order.filter((e) => e.cells.size > 0);
        const n = order.length;
        for (const key of this.dirtyCells) {
            const c = this.chunks[key >>> 12];
            const li = key & (CHUNK_VOLUME - 1);
            let winner = 0;
            let cover = 0;
            let masked = false;
            for (let o = 0; o < n; o++) {
                const e = order[o];
                const v = e.cells.get(key);
                if (v === undefined) continue;
                if (e.mask) {
                    // another lattice's object: it takes the cell from everything after it
                    if (cover === 0) masked = true;
                    continue;
                }
                if (cover === 0) winner = masked ? 0 : v & 0xffff;
                cover++;
            }
            if (masked && cover > 0) this.latticeHiddenCells.add(key);
            else this.latticeHiddenCells.delete(key);
            if (cover > 1) st.dynDynOverlaps++;
            if (!c.dyn) {
                if (winner === 0) continue;
                c.dyn = new Uint16Array(CHUNK_VOLUME);
            }
            const old = c.dyn[li];
            if (old === winner) continue;
            st.changedCells++;
            const s = c.stat ? c.stat[li] : 0;
            if (old === 0) c.dynCount++;
            if (winner === 0) c.dynCount--;
            const wasOverride = old !== 0 && s !== 0;
            const isOverride = winner !== 0 && s !== 0;
            if (wasOverride !== isOverride) {
                c.overrideCount += isOverride ? 1 : -1;
                this.dynStaticOverlapCells += isOverride ? 1 : -1;
                c.staticDirty = true;
            }
            c.dyn[li] = winner;
            this.markDynDirtyAround(c, li);
        }
        st.dynStaticOverlaps = this.dynStaticOverlapCells;
        st.latticeHidden = this.latticeHiddenCells.size;
        this.dirtyCells.clear();
        return st;
    }

    /** Marks a chunk dyn-dirty, plus face/edge/corner neighbours when the cell lies on a border. */
    private markDynDirtyAround(c: Chunk, li: number, statToo = false): void {
        c.dynDirty = true;
        const lx = li & CHUNK_MASK;
        const lz = (li >> CHUNK_BITS) & CHUNK_MASK;
        const ly = li >> (2 * CHUNK_BITS);
        const bx = lx === 0 ? -1 : lx === CHUNK_SIZE - 1 ? 1 : 0;
        const by = ly === 0 ? -1 : ly === CHUNK_SIZE - 1 ? 1 : 0;
        const bz = lz === 0 ? -1 : lz === CHUNK_SIZE - 1 ? 1 : 0;
        if (bx === 0 && by === 0 && bz === 0) return;
        for (let dy = by < 0 ? -1 : 0; dy <= (by > 0 ? 1 : 0); dy++) {
            for (let dz = bz < 0 ? -1 : 0; dz <= (bz > 0 ? 1 : 0); dz++) {
                for (let dx = bx < 0 ? -1 : 0; dx <= (bx > 0 ? 1 : 0); dx++) {
                    if (dx === 0 && dy === 0 && dz === 0) continue;
                    const n = this.byCoord.get(packChunkCoord(c.cx + dx, c.cy + dy, c.cz + dz));
                    if (n) {
                        n.dynDirty = true;
                        if (statToo && n.stat) n.staticDirty = true;
                    }
                }
            }
        }
    }

    /** Per object id: the cells a mask (another lattice's object) currently takes from it. */
    latticeHiddenByObject(): Map<number, number> {
        const out = new Map<number, number>();
        for (const key of this.latticeHiddenCells)
            for (const e of this.order) {
                if (e.mask || !e.cells.has(key)) continue;
                out.set(e.id, (out.get(e.id) ?? 0) + 1);
            }
        return out;
    }

    /** Total static cells (for stats). */
    staticCellCount(): number {
        let n = 0;
        for (const c of this.chunks) n += c.staticCount;
        return n;
    }

    dynamicCellCount(): number {
        let n = 0;
        for (const c of this.chunks) n += c.dynCount;
        return n;
    }

    /** Deterministic hash of the composite dynamic layer (for same-pose tests). */
    dynamicHash(): number {
        let h = 2166136261;
        for (const c of this.chunks) {
            if (!c.dyn || c.dynCount === 0) continue;
            const d = c.dyn;
            for (let li = 0; li < CHUNK_VOLUME; li++) {
                const v = d[li];
                if (v === 0) continue;
                h = Math.imul(h ^ (c.id * CHUNK_VOLUME + li), 16777619);
                h = Math.imul(h ^ v, 16777619);
            }
        }
        return h >>> 0;
    }
}
