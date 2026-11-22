/**
 * Main-thread side of voxel reconstruction (Phase C, design doc §5.5). For each voxel frame it
 * samples every object's interpolated state at the voxel time from the simulation's snapshot ring
 * and sends it to the voxel worker; finished meshes come back as transferred buffers.
 *
 * At most one frame is in flight. If the worker is still busy when the next voxel frame is due,
 * only the newest due frame is kept (older ones are skipped, never queued), so a slow device shows
 * a lower effective voxel rate instead of growing latency. Results are applied by the frame
 * director (poll), never from the message handler, so a voxel frame always lands between frames
 * and every render pass of a frame sees the same completed voxel frame.
 *
 * Per-item cell sizes (src/assets/cell-tier.ts): one worker per lattice ("lane"), each drawing its
 * own objects; the base lane also holds the static world and the particles. A voxel frame goes to
 * every lane at once and is applied only when every lane has finished it, so a 1 cm bucket never
 * lags the 5 cm beaver carrying it.
 */

import { BEAVER_FIRST_PERSON } from '../assets/beaver.ts';
import type { LabSim } from '../sim/lab-sim.ts';
import { ANIM_MAX } from '../sim/snapshots.ts';
import { pose } from '../voxels/math.ts';
import type { SamplingPolicy } from '../voxels/rasterizer.ts';
import { STATE_STRIDE } from '../workers/protocol.ts';
import type { BuildInfo, FrameStats, FromWorker, TileReport, ToWorker, UnitMesh } from '../workers/protocol.ts';

import type { VoxelRenderer } from './voxel-renderer.ts';

/** One lattice: its worker, its renderer, and what it draws. */
export interface LaneSpec {
    worker: Worker;
    renderer: VoxelRenderer;
    cellCm: number;
    /** Entity ids drawn on this lattice; every entity when absent. */
    objects?: number[];
    /** Static world and particles (exactly one lane). */
    world: boolean;
    /**
     * The far lattice of a streamed level: the whole static world, coarse, except where the near
     * world is built (each voxel frame tells it which near tiles are).
     */
    far?: boolean;
}

interface Lane extends LaneSpec {
    inbox: { units: UnitMesh[]; stats: FrameStats; tiles?: TileReport } | null;
    staticUnits: UnitMesh[] | null;
    build: BuildInfo | null;
}

/** Stats summed over lanes (counts), or the slowest lane (times). */
const SUMMED: (keyof FrameStats)[] = [
    'objects',
    'parts',
    'candidates',
    'samples',
    'occupied',
    'rejected',
    'changedCells',
    'dirtyCells',
    'dynDynOverlaps',
    'dynStaticOverlaps',
    'latticeMasks',
    'latticeHidden',
    'staticRebuilt',
    'dynamicRebuilt',
    'dynamicCells',
    'chunks'
];
const SLOWEST: (keyof FrameStats)[] = ['rasterMs', 'resolveMs', 'meshMs', 'totalMs'];

export class VoxelClient {
    policy: SamplingPolicy = 'coverage50';
    reference = false;
    /**
     * Sim slot of the beaver drawn for this device's only camera in first person (its head is left
     * out, BEAVER_FIRST_PERSON), or -1.
     */
    firstPersonSlot = -1;
    /** Sim slot of the 1 cm first-person limbs drawn in its place (beaverFirstPersonAsset), or -1. */
    firstPersonBodySlot = -1;
    /**
     * Your own limbs' root pose (x, y, z, yaw) in the voxel frame in flight and in the one on screen,
     * or null when it has no first-person body. lockBody moves the on-screen limbs from the pose they
     * were built at to where you are now, every render frame.
     */
    private bodyInFlight: [number, number, number, number] | null = null;
    private bodyOnScreen: [number, number, number, number] | null = null;
    build: BuildInfo | null = null;
    lastStats: FrameStats | null = null;
    /** The last voxel frame's stats per lane (same order as the lanes). */
    laneStats: (FrameStats | null)[] = [];
    /** Voxel frames requested but superseded before they could be sent. */
    skippedFrames = 0;
    appliedFrame = -1;
    uploadMs = 0;
    /** Particle cells for a voxel time (leaves, dust, splashes); optional. */
    particles: ((time: number) => { buffer: Float32Array; count: number }) | null = null;
    /** Streamed levels: this device's camera positions (x, z pairs), sent with each voxel frame. */
    focus: (() => Float32Array) | null = null;
    /** Streamed levels: the near world's radius (m), from the quality preset (null: the level's). */
    nearRadius: number | null = null;
    /** Streamed levels: near tiles built (ti, tk keys) and their size (m). */
    readonly nearTiles = new Set<number>();
    nearTileSize = 0;
    /** The same as ti, tk pairs, for the far lattice. */
    private nearTileList: Int32Array | null = null;

    private *nearTileArray(): Iterable<number> {
        for (const k of this.nearTiles) {
            yield Math.floor(k / 65536) - 32768;
            yield (k % 65536) - 32768;
        }
    }

    readonly lanes: Lane[];
    private readonly sim: LabSim;
    private readonly slots: number[];
    private busy = false;
    private pending: { frame: number; time: number } | null = null;
    private queryId = 0;
    private readonly queries = new Map<number, (v: unknown) => void>();
    private readyCount = 0;
    private readyResolve: ((b: BuildInfo) => void) | null = null;
    private readyReject: ((e: Error) => void) | null = null;
    private readonly root = pose();
    private readonly anim = new Float64Array(ANIM_MAX);

    constructor(lanes: LaneSpec[], sim: LabSim) {
        if (lanes.filter((l) => l.world && !l.far).length !== 1)
            throw new Error('exactly one voxel lane holds the world');
        this.lanes = lanes.map((l) => ({ ...l, inbox: null, staticUnits: null, build: null }));
        this.laneStats = lanes.map(() => null);
        this.sim = sim;
        this.slots = sim.entities.filter((e) => e.asset.parts.length > 0).map((e) => e.slot);
        for (const lane of this.lanes) {
            lane.worker.onmessage = (e: MessageEvent<FromWorker>) => this.receive(lane, e.data);
            lane.worker.onerror = (e) => {
                console.error(`voxel worker (${lane.cellCm} cm) error`, e.message);
                this.readyReject?.(new Error(e.message));
            };
        }
    }

    /**
     * Keeps your own limbs with the camera between voxel frames. They are rebuilt only as often as
     * voxel frames land (slower on phones, and every lane must finish first), while the camera moves
     * every render frame; so the lane that draws only them is turned and shifted as one piece, from
     * the pose they were built at to `x, y, z, yaw` (your root now, your look's yaw). Their animation
     * still updates with voxel frames. Does nothing when the limbs share a lane with anything else.
     */
    lockBody(bodyId: number, now: { x: number; y: number; z: number; yaw: number } | null): void {
        const lane = this.lanes.find((l) => l.objects?.length === 1 && l.objects[0] === bodyId);
        if (!lane) return;
        const b = this.bodyOnScreen;
        if (!b || !now) {
            lane.renderer.setRootTransform(0, 0, 0, 0);
            return;
        }
        const o = bodyLockOffset(b, now);
        lane.renderer.setRootTransform(o[0], o[1], o[2], o[3]);
    }

    /** The renderers of every lane (stats, grid checks). */
    get renderers(): VoxelRenderer[] {
        return this.lanes.map((l) => l.renderer);
    }

    private get worldLane(): Lane {
        return this.lanes.find((l) => l.world && !l.far)!;
    }

    /** Lanes that take part in voxel frames (all of them). */
    private get frameLanes(): Lane[] {
        return this.lanes;
    }

    /** Is the near world built over the whole rectangle (m)? */
    nearCovers(minX: number, maxX: number, minZ: number, maxZ: number): boolean {
        const s = this.nearTileSize;
        if (s <= 0) return false;
        const e = 1e-6;
        for (let tk = Math.floor((minZ + e) / s); tk <= Math.floor((maxZ - e) / s); tk++)
            for (let ti = Math.floor((minX + e) / s); ti <= Math.floor((maxX - e) / s); ti++)
                if (!this.nearTiles.has((ti + 32768) * 65536 + (tk + 32768))) return false;
        return true;
    }

    /** Builds the static world (and each lane's objects); resolves once every lane is ready. */
    init(seed: number, level: string, data?: unknown): Promise<BuildInfo> {
        return new Promise((resolve, reject) => {
            this.readyResolve = resolve;
            this.readyReject = reject;
            this.readyCount = 0;
            for (const l of this.lanes)
                this.send(l, {
                    type: 'init',
                    cellCm: l.cellCm,
                    seed,
                    level,
                    data,
                    objects: l.objects,
                    world: l.world,
                    far: l.far
                });
        });
    }

    /** Applies the initial static meshes (call from the main thread when ready). */
    applyStatic(): void {
        for (const l of this.lanes) {
            if (l.staticUnits) {
                l.renderer.apply(l.staticUnits);
                l.staticUnits = null;
            }
        }
    }

    /** Requests reconstruction of a voxel frame. */
    request(frame: number, time: number): void {
        if (this.busy) {
            if (this.pending) this.skippedFrames++;
            this.pending = { frame, time };
            return;
        }
        this.dispatch(frame, time);
    }

    /** Applies a finished voxel frame once every lane has it. Returns true when meshes changed. */
    poll(): boolean {
        if (!this.busy || this.frameLanes.some((l) => !l.inbox)) return false;
        let uploadMs = 0;
        let tilesChanged = false;
        this.lanes.forEach((l, i) => {
            const r = l.inbox;
            if (!r) return;
            l.inbox = null;
            uploadMs += l.renderer.apply(r.units).uploadMs;
            this.laneStats[i] = r.stats;
            if (r.tiles) {
                this.nearTiles.clear();
                this.nearTileSize = r.tiles.size;
                const t = r.tiles.tiles;
                for (let n = 0; n + 1 < t.length; n += 2)
                    this.nearTiles.add((t[n] + 32768) * 65536 + (t[n + 1] + 32768));
                tilesChanged = true;
            }
        });
        if (tilesChanged) this.nearTileList = Int32Array.from(this.nearTileArray());
        this.uploadMs = uploadMs;
        this.bodyOnScreen = this.bodyInFlight;
        this.lastStats = this.combine();
        this.appliedFrame = this.lastStats.frame;
        this.busy = false;
        if (this.pending) {
            const p = this.pending;
            this.pending = null;
            this.dispatch(p.frame, p.time);
        }
        return true;
    }

    private combine(): FrameStats {
        const base = this.laneStats[this.lanes.indexOf(this.worldLane)]!;
        const out = { ...base };
        for (const k of SUMMED) out[k] = 0;
        for (const st of this.laneStats) {
            if (!st) continue;
            for (const k of SUMMED) out[k] += st[k];
            for (const k of SLOWEST) out[k] = Math.max(out[k], st[k]);
        }
        return out;
    }

    /**
     * `hash`: dynamic content of every lane combined; `verify`: grid checks summed over lanes;
     * `lattice`: per object id, the cells an object on another lattice takes from it (summed).
     */
    async query<T>(what: 'hash' | 'verify' | 'lattice'): Promise<T> {
        const results = await Promise.all(this.lanes.map((l) => this.queryLane(l, what)));
        if (what === 'lattice') {
            const out: Record<number, number> = {};
            for (const r of results as Record<number, number>[])
                for (const [id, n] of Object.entries(r)) out[Number(id)] = (out[Number(id)] ?? 0) + n;
            return out as T;
        }
        if (what === 'hash') return results.reduce((h: number, r) => (Math.imul(h, 31) + (r as number)) >>> 0, 17) as T;
        const v = { vertices: 0, misaligned: 0 };
        for (const r of results as { vertices: number; misaligned: number }[]) {
            v.vertices += r.vertices;
            v.misaligned += r.misaligned;
        }
        return v as T;
    }

    private queryLane(lane: Lane, what: 'hash' | 'verify' | 'lattice'): Promise<unknown> {
        const id = ++this.queryId;
        return new Promise((resolve) => {
            this.queries.set(id, resolve);
            this.send(lane, { type: 'query', id, what });
        });
    }

    get inFlight(): boolean {
        return this.busy;
    }

    private dispatch(frame: number, time: number): void {
        const states = new Float64Array(this.slots.length * STATE_STRIDE);
        for (let n = 0; n < this.slots.length; n++) {
            const o = n * STATE_STRIDE;
            const visible = this.sim.ring.sample(this.slots[n], time, this.root, this.anim);
            states[o] = visible ? 1 : 0;
            states[o + 1] = this.root.p.x;
            states[o + 2] = this.root.p.y;
            states[o + 3] = this.root.p.z;
            states[o + 4] = this.root.q.x;
            states[o + 5] = this.root.q.y;
            states[o + 6] = this.root.q.z;
            states[o + 7] = this.root.q.w;
            for (let c = 0; c < ANIM_MAX; c++) states[o + 8 + c] = this.anim[c];
            if (this.slots[n] === this.firstPersonSlot) states[o + 8 + BEAVER_FIRST_PERSON] = 1;
        }
        // first person: your own beaver gives way to your 1 cm limbs
        this.bodyInFlight = null;
        if (this.firstPersonSlot >= 0 && this.firstPersonBodySlot >= 0) {
            const a = this.slots.indexOf(this.firstPersonSlot);
            const b = this.slots.indexOf(this.firstPersonBodySlot);
            if (a >= 0 && b >= 0) {
                const visible = this.sim.ring.sample(this.firstPersonSlot, time, this.root, this.anim);
                if (visible) {
                    const p = this.root.p;
                    this.bodyInFlight = [p.x, p.y, p.z, yawOf(this.root.q)];
                }
                const o = b * STATE_STRIDE;
                states[o] = visible ? 1 : 0;
                states[o + 1] = this.root.p.x;
                states[o + 2] = this.root.p.y;
                states[o + 3] = this.root.p.z;
                states[o + 4] = this.root.q.x;
                states[o + 5] = this.root.q.y;
                states[o + 6] = this.root.q.z;
                states[o + 7] = this.root.q.w;
                for (let c = 0; c < ANIM_MAX; c++) states[o + 8 + c] = this.anim[c];
                states[a * STATE_STRIDE] = 0;
            }
        }
        this.busy = true;
        const fx = this.particles?.(time);
        const lanes = this.frameLanes;
        const focus = this.focus?.();
        for (const l of lanes) {
            const st = l === lanes[lanes.length - 1] ? states : states.slice();
            const particles = l.world && !l.far && fx && fx.count > 0 ? fx.buffer.slice(0, fx.count * 4) : undefined;
            const transfer: ArrayBuffer[] = [st.buffer as ArrayBuffer];
            if (particles) transfer.push(particles.buffer as ArrayBuffer);
            this.send(
                l,
                {
                    type: 'frame',
                    frame,
                    time,
                    policy: this.policy,
                    reference: this.reference,
                    states: st,
                    particles,
                    particleCount: particles ? fx!.count : 0,
                    focus: l.world && !l.far && focus ? focus.slice() : undefined,
                    nearTiles: l.far && this.nearTileList ? this.nearTileList.slice() : undefined,
                    nearTileSize: l.far ? this.nearTileSize : undefined,
                    nearRadius: l.world && !l.far && this.nearRadius !== null ? this.nearRadius : undefined
                },
                transfer
            );
        }
    }

    private send(lane: Lane, msg: ToWorker, transfer: ArrayBuffer[] = []): void {
        lane.worker.postMessage(msg, transfer);
    }

    private receive(lane: Lane, msg: FromWorker): void {
        switch (msg.type) {
            case 'ready':
                lane.build = msg.build;
                lane.staticUnits = msg.units;
                if (lane.world && !lane.far) this.build = msg.build;
                if (++this.readyCount === this.lanes.length) this.readyResolve?.(this.build!);
                break;
            case 'frame':
                lane.inbox = { units: msg.units, stats: msg.stats, tiles: msg.tiles };
                break;
            case 'query': {
                const q = this.queries.get(msg.id);
                this.queries.delete(msg.id);
                q?.(msg.result);
                break;
            }
            case 'error':
                console.error(`voxel worker (${lane.cellCm} cm):`, msg.message);
                this.readyReject?.(new Error(msg.message));
                break;
        }
    }
}

/**
 * The rigid move (shift x, y, z after a turn of yaw about Y, as an entity transform) that takes a
 * body built at `built` (x, y, z, yaw) to `now`: T(now) * inverse(T(built)).
 */
export function bodyLockOffset(
    built: readonly [number, number, number, number],
    now: { x: number; y: number; z: number; yaw: number }
): [number, number, number, number] {
    const d = now.yaw - built[3];
    const c = Math.cos(d);
    const s = Math.sin(d);
    return [now.x - (c * built[0] + s * built[2]), now.y - built[1], now.z - (-s * built[0] + c * built[2]), d];
}

/** Yaw (about Y) of a rotation, in the engine's convention (yaw 0 looks along -Z). */
function yawOf(q: { x: number; y: number; z: number; w: number }): number {
    return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
}
