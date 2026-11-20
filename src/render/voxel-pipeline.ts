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
 */

import type { LabSim } from '../sim/lab-sim.ts';
import { ANIM_MAX } from '../sim/snapshots.ts';
import { pose } from '../voxels/math.ts';
import type { SamplingPolicy } from '../voxels/rasterizer.ts';
import { STATE_STRIDE } from '../workers/protocol.ts';
import type { BuildInfo, FrameStats, FromWorker, ToWorker, UnitMesh } from '../workers/protocol.ts';

import type { VoxelRenderer } from './voxel-renderer.ts';

export class VoxelClient {
    policy: SamplingPolicy = 'coverage50';
    reference = false;
    build: BuildInfo | null = null;
    lastStats: FrameStats | null = null;
    /** Voxel frames requested but superseded before they could be sent. */
    skippedFrames = 0;
    appliedFrame = -1;
    uploadMs = 0;

    private readonly worker: Worker;
    private readonly renderer: VoxelRenderer;
    private readonly sim: LabSim;
    private readonly slots: number[];
    private busy = false;
    private pending: { frame: number; time: number } | null = null;
    private inbox: { units: UnitMesh[]; stats: FrameStats } | null = null;
    private queryId = 0;
    private readonly queries = new Map<number, (v: unknown) => void>();
    private readyResolve: ((b: BuildInfo) => void) | null = null;
    private readyReject: ((e: Error) => void) | null = null;
    private readonly root = pose();
    private readonly anim = new Float64Array(ANIM_MAX);
    private staticUnits: UnitMesh[] | null = null;

    constructor(worker: Worker, renderer: VoxelRenderer, sim: LabSim) {
        this.worker = worker;
        this.renderer = renderer;
        this.sim = sim;
        this.slots = sim.entities.filter((e) => e.asset.parts.length > 0).map((e) => e.slot);
        worker.onmessage = (e: MessageEvent<FromWorker>) => this.receive(e.data);
        worker.onerror = (e) => {
            console.error('voxel worker error', e.message);
            this.readyReject?.(new Error(e.message));
        };
    }

    /** Builds the static world in the worker; resolves once its meshes are ready to apply. */
    init(cellCm: number, seed: number, level: string): Promise<BuildInfo> {
        return new Promise((resolve, reject) => {
            this.readyResolve = resolve;
            this.readyReject = reject;
            this.send({ type: 'init', cellCm, seed, level });
        });
    }

    /** Applies the initial static meshes (call from the main thread when ready). */
    applyStatic(): void {
        if (this.staticUnits) {
            this.renderer.apply(this.staticUnits);
            this.staticUnits = null;
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

    /** Applies a finished voxel frame, if one arrived. Returns true when meshes changed. */
    poll(): boolean {
        const r = this.inbox;
        if (!r) return false;
        this.inbox = null;
        const up = this.renderer.apply(r.units);
        this.uploadMs = up.uploadMs;
        this.lastStats = r.stats;
        this.appliedFrame = r.stats.frame;
        this.busy = false;
        if (this.pending) {
            const p = this.pending;
            this.pending = null;
            this.dispatch(p.frame, p.time);
        }
        return true;
    }

    query<T>(what: 'hash' | 'verify'): Promise<T> {
        const id = ++this.queryId;
        return new Promise((resolve) => {
            this.queries.set(id, resolve as (v: unknown) => void);
            this.send({ type: 'query', id, what });
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
        }
        this.busy = true;
        this.send({ type: 'frame', frame, time, policy: this.policy, reference: this.reference, states }, [states.buffer]);
    }

    private send(msg: ToWorker, transfer: ArrayBuffer[] = []): void {
        this.worker.postMessage(msg, transfer);
    }

    private receive(msg: FromWorker): void {
        switch (msg.type) {
            case 'ready':
                this.build = msg.build;
                this.staticUnits = msg.units;
                this.readyResolve?.(msg.build);
                break;
            case 'frame':
                this.inbox = { units: msg.units, stats: msg.stats };
                break;
            case 'query': {
                const q = this.queries.get(msg.id);
                this.queries.delete(msg.id);
                q?.(msg.result);
                break;
            }
            case 'error':
                console.error('voxel worker:', msg.message);
                this.readyReject?.(new Error(msg.message));
                break;
        }
    }
}
