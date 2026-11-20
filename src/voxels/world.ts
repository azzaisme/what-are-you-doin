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
 * Storage is sparse: chunks are allocated only when written. A level-sized dense array is never
 * allocated (§5.5).
 */

import {
    CHUNK_BITS,
    CHUNK_MASK,
    CHUNK_SIZE,
    CHUNK_VOLUME,
    chunkCoordInRange,
    localIndex,
    packChunkCoord
} from './grid.ts';
import type { Pose } from './math.ts';
import { rasterizeVolume    } from './rasterizer.ts';
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
}

interface DynamicEntry {
    id: number;
    priority: number;
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

export class VoxelWorld {
    private readonly byCoord = new Map<number, Chunk>();
    bedrock: Bedrock | null = null;

    /** True when a cell lies inside the implicit bedrock. */
    isBedrock(i: number, j: number, k: number): boolean {
        const b = this.bedrock;
        if (!b) return false;
        const x = i - b.minI;
        const z = k - b.minK;
        if (x < 0 || z < 0 || x >= b.width || z >= b.depth) return false;
        return j < b.bottom[x + z * b.width];
    }
    readonly chunks: Chunk[] = [];
    private readonly objects = new Map<number, DynamicEntry>();
    private order: DynamicEntry[] = [];
    private readonly dirtyCells = new Set<number>();

    /** Composite telemetry from the last resolve(). */
    readonly lastComposite: CompositeStats = { dirtyCells: 0, changedCells: 0, dynDynOverlaps: 0, dynStaticOverlaps: 0 };
    /** Running totals of overlap cells currently present. */
    dynStaticOverlapCells = 0;

    // ------------------------------------------------------------------------------- chunks

    getChunk(cx: number, cy: number, cz: number): Chunk | undefined {
        return this.byCoord.get(packChunkCoord(cx, cy, cz));
    }

    getOrCreateChunk(cx: number, cy: number, cz: number): Chunk {
        const key = packChunkCoord(cx, cy, cz);
        let c = this.byCoord.get(key);
        if (!c) {
            if (!chunkCoordInRange(cx) || !chunkCoordInRange(cy) || !chunkCoordInRange(cz)) {
                throw new RangeError(`Chunk coordinate out of range: ${cx}, ${cy}, ${cz}`);
            }
            if (this.chunks.length >= MAX_CHUNKS) throw new RangeError('Chunk budget exceeded');
            c = new Chunk(this.chunks.length, cx, cy, cz);
            this.chunks.push(c);
            this.byCoord.set(key, c);
        }
        return c;
    }

    /** Small-integer key of a cell: chunk id * 4096 + local index. Creates the chunk if needed. */
    cellKey(i: number, j: number, k: number): number {
        const c = this.getOrCreateChunk(i >> CHUNK_BITS, j >> CHUNK_BITS, k >> CHUNK_BITS);
        return c.id * CHUNK_VOLUME + localIndex(i & CHUNK_MASK, j & CHUNK_MASK, k & CHUNK_MASK);
    }

    get chunkCount(): number {
        return this.chunks.length;
    }

    // ------------------------------------------------------------------------------- static layer

    /**
     * Writes a static voxel. When two static writes hit the same cell, the higher priority wins;
     * equal priority keeps the first. Value 0 is ignored (static cells are only added at load).
     */
    setStatic(i: number, j: number, k: number, value: number, priority = 0): void {
        if (value <= 0) return;
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
    rasterizeStatic(volume: Volume, worldPose: Pose, policy: SamplingPolicy, priority: number, stats: RasterStats): void {
        this.staticSink.priority = priority;
        rasterizeVolume(volume, worldPose, policy, priority, this.staticSink, stats);
    }

    private readonly staticSink = {
        world: this as VoxelWorld,
        priority: 0,
        write(i: number, j: number, k: number, value: number, priority: number) {
            this.world.setStatic(i, j, k, value, priority);
        }
    };

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

    addObject(id: number, priority = 0): void {
        if (this.objects.has(id)) throw new Error(`Dynamic object ${id} already registered`);
        if (!Number.isInteger(id) || id < 0) throw new Error(`Invalid object id ${id}`);
        const e: DynamicEntry = { id, priority, cells: new Map(), prev: new Map(), count: 0 };
        this.objects.set(id, e);
        this.order.push(e);
        this.order.sort((a, b) => b.priority - a.priority || a.id - b.id);
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
        const order = this.order;
        const n = order.length;
        for (const key of this.dirtyCells) {
            const c = this.chunks[key >>> 12];
            const li = key & (CHUNK_VOLUME - 1);
            let winner = 0;
            let cover = 0;
            for (let o = 0; o < n; o++) {
                const v = order[o].cells.get(key);
                if (v !== undefined) {
                    if (cover === 0) winner = v & 0xffff;
                    cover++;
                }
            }
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
        this.dirtyCells.clear();
        return st;
    }

    /** Marks a chunk dyn-dirty, plus face/edge/corner neighbours when the cell lies on a border. */
    private markDynDirtyAround(c: Chunk, li: number): void {
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
                    if (n) n.dynDirty = true;
                }
            }
        }
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
