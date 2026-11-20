/**
 * Voxel worker entry. The cell size must be known before any voxel module evaluates (sizes derive
 * from it at import time), so the service is imported dynamically after the init message sets it.
 */

import type { FromWorker, ToWorker } from './protocol.ts';
// type-only: erased at build time, so it does not evaluate voxel modules before the cell size is set
import { transferables } from './protocol.ts';
import type { VoxelService as Service } from './voxel-service.ts';

let service: Service | null = null;
const queue: ToWorker[] = [];
let ready = false;

const post = (msg: FromWorker, transfer: ArrayBuffer[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = async (e: MessageEvent<ToWorker>) => {
    const msg = e.data;
    if (msg.type === 'init') {
        (globalThis as { __UE_CELL_CM__?: number }).__UE_CELL_CM__ = msg.cellCm;
        try {
            const { VoxelService } = await import('./voxel-service.ts');
            service = new VoxelService();
            const { build, units } = service.build(msg.seed, msg.level, msg.data);
            post({ type: 'ready', build, units }, transferables(units));
            ready = true;
            for (const m of queue.splice(0)) handle(m);
        } catch (err) {
            post({ type: 'error', message: err instanceof Error ? `${err.message}\n${err.stack}` : String(err) });
        }
        return;
    }
    if (!ready) queue.push(msg);
    else handle(msg);
};

function handle(msg: ToWorker): void {
    if (!service) return;
    try {
        if (msg.type === 'frame') {
            const { units, stats } = service.frame(
                msg.frame,
                msg.time,
                msg.policy,
                msg.reference,
                msg.states,
                msg.particles,
                msg.particleCount ?? 0
            );
            post({ type: 'frame', units, stats }, transferables(units));
        } else if (msg.type === 'query') {
            const result = msg.what === 'hash' ? service.world.dynamicHash() : service.verifyGrid();
            post({ type: 'query', id: msg.id, result });
        }
    } catch (err) {
        post({ type: 'error', message: err instanceof Error ? `${err.message}\n${err.stack}` : String(err) });
    }
}
