/**
 * "Voxels: Off" worker: builds the smooth meshes of the level and of every object's parts once,
 * off the main thread (src/smooth/smooth-service.ts). The base cell size is set first, as for the
 * voxel workers, so reeds and flowers keep their size.
 */

import type { SmoothBuild } from '../smooth/smooth-service.ts';

export type ToSmoothWorker = { type: 'build'; cellCm: number; level: string; data?: unknown; seed: number };
export type FromSmoothWorker = { type: 'built'; build: SmoothBuild } | { type: 'error'; message: string };

self.onmessage = async (e: MessageEvent<ToSmoothWorker>) => {
    const msg = e.data;
    if (msg.type !== 'build') return;
    (globalThis as { __UE_CELL_CM__?: number }).__UE_CELL_CM__ = msg.cellCm;
    try {
        const { buildSmooth } = await import('../smooth/smooth-service.ts');
        const { getLevel } = await import('../levels/index.ts');
        const { levelFromData, parseLevelData } = await import('../levels/data.ts');
        const def = msg.data ? levelFromData(parseLevelData(msg.data)) : getLevel(msg.level);
        const build = buildSmooth(def, msg.seed);
        const transfer: ArrayBuffer[] = [];
        for (const set of [...build.units.map((u) => u.classes), ...build.partMeshes])
            for (const c of set)
                transfer.push(
                    c.positions.buffer as ArrayBuffer,
                    c.normals.buffer as ArrayBuffer,
                    c.colors.buffer as ArrayBuffer,
                    c.indices.buffer as ArrayBuffer
                );
        (self as unknown as Worker).postMessage({ type: 'built', build } satisfies FromSmoothWorker, transfer);
    } catch (err) {
        (self as unknown as Worker).postMessage({
            type: 'error',
            message: err instanceof Error ? `${err.message}\n${err.stack}` : String(err)
        } satisfies FromSmoothWorker);
    }
};
