/**
 * Headless CPU benchmark of the voxel reconstruction path (no GPU upload): fixed-step sim ->
 * interpolated sample at voxel time -> pose evaluation -> rasterize -> resolve -> mesh dirty units.
 * Usage: node scripts/bench-voxels.ts [minutes=10] [hz=20]
 * Runs every policy and stress level briefly, then one long run for memory/allocation stability.
 */
import os from 'node:os';

import { buildRiverLab } from '../src/levels/river-lab.ts';
import { SIM_DT } from '../src/sim/clock.ts';
import { LabSim } from '../src/sim/lab-sim.ts';
import { ANIM_MAX } from '../src/sim/snapshots.ts';
import { DYNAMIC_REGION, STATIC_REGION, collectDirty, unpackRegion } from '../src/voxels/dirty.ts';
import type { DirtyWork } from '../src/voxels/dirty.ts';
import { CHUNK_SIZE } from '../src/voxels/grid.ts';
import { pose } from '../src/voxels/math.ts';
import { MeshOutput, meshRegionBlocked } from '../src/voxels/mesher.ts';
import { SAMPLING_POLICIES, createRasterStats, resetRasterStats  } from '../src/voxels/rasterizer.ts';
import type { SamplingPolicy } from '../src/voxels/rasterizer.ts';
import { VoxelWorld  } from '../src/voxels/world.ts';
import type { PartInstance } from '../src/voxels/world.ts';

const minutes = Number(process.argv[2] ?? 10);
const hz = Number(process.argv[3] ?? 20);

function setup() {
    const world = new VoxelWorld();
    buildRiverLab(world, 1);
    const out = new MeshOutput();
    const work: DirtyWork = { staticRegions: [], dynamicRegions: [], dynamicHasContent: [] };
    const meshAll = () => {
        collectDirty(world, work);
        let quads = 0;
        for (const key of work.staticRegions) {
            const [x, y, z] = unpackRegion(key);
            out.reset();
            meshRegionBlocked(world, 'static', x * STATIC_REGION.x, y * STATIC_REGION.y, z * STATIC_REGION.z, STATIC_REGION.x, STATIC_REGION.y, STATIC_REGION.z, DYNAMIC_REGION, out);
            quads += out.quads;
        }
        for (const key of work.dynamicRegions) {
            const [x, y, z] = unpackRegion(key);
            out.reset();
            meshRegionBlocked(world, 'dynamic', x * DYNAMIC_REGION, y * DYNAMIC_REGION, z * DYNAMIC_REGION, DYNAMIC_REGION, DYNAMIC_REGION, DYNAMIC_REGION, CHUNK_SIZE, out);
            quads += out.quads;
        }
        return { quads, staticRegions: work.staticRegions.length, dynChunks: work.dynamicRegions.length };
    };
    meshAll(); // initial static meshing
    const sim = new LabSim();
    const tracked = sim.entities
        .filter((e) => e.asset.parts.length > 0)
        .map((e) => {
            world.addObject(e.id, e.priority);
            const poses = e.asset.parts.map(() => pose());
            return { e, root: pose(), anim: new Float64Array(ANIM_MAX), poses, parts: e.asset.parts.map((p, i) => ({ volume: p.volume, pose: poses[i], priority: p.priority, policy: p.policy }) as PartInstance) };
        });
    return { world, sim, tracked, meshAll };
}

function pct(a: number[], p: number) {
    const s = [...a].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

function run(policy: SamplingPolicy, stress: number, frames: number, sampleMemory = false) {
    const { world, sim, tracked, meshAll } = setup();
    sim.stressCount = stress;
    const stats = createRasterStats();
    const raster: number[] = [];
    const resolve: number[] = [];
    const mesh: number[] = [];
    const total: number[] = [];
    let samples = 0;
    let cells = 0;
    let dyn = 0;
    const mem: number[] = [];
    let chunksAt = 0;
    for (let f = 1; f <= frames; f++) {
        const tv = f / hz;
        sim.runTo(Math.ceil(tv / SIM_DT) + 1);
        const t0 = performance.now();
        resetRasterStats(stats);
        for (const t of tracked) {
            if (!sim.ring.sample(t.e.slot, tv, t.root, t.anim)) {
                if (world.objectCellCount(t.e.id)) world.clearObject(t.e.id);
                continue;
            }
            t.e.asset.evaluate(t.root, t.anim, t.poses);
            world.rasterizeObject(t.e.id, t.parts, policy, stats);
        }
        const t1 = performance.now();
        world.resolve();
        const t2 = performance.now();
        const m = meshAll();
        const t3 = performance.now();
        if (f > 20) {
            raster.push(t1 - t0);
            resolve.push(t2 - t1);
            mesh.push(t3 - t2);
            total.push(t3 - t0);
            samples += stats.samples;
            cells += stats.occupied;
            dyn += m.dynChunks;
        }
        if (sampleMemory && f % (hz * 30) === 0) {
            globalThis.gc?.();
            mem.push(process.memoryUsage().heapUsed / 1e6);
        }
        if (f === 200) chunksAt = world.chunkCount;
    }
    const n = total.length;
    return {
        policy,
        stress,
        frames,
        ms: {
            raster: { p50: pct(raster, 0.5), p95: pct(raster, 0.95) },
            resolve: { p50: pct(resolve, 0.5), p95: pct(resolve, 0.95) },
            mesh: { p50: pct(mesh, 0.5), p95: pct(mesh, 0.95) },
            total: { p50: pct(total, 0.5), p95: pct(total, 0.95), max: Math.max(...total) }
        },
        perFrame: { samples: Math.round(samples / n), occupiedCells: Math.round(cells / n), dynChunksMeshed: +(dyn / n).toFixed(1) },
        chunks: { at200: chunksAt, end: world.chunkCount },
        heapMB: mem.map((x) => +x.toFixed(1))
    };
}

console.log(`CPU: ${os.cpus()[0].model} x${os.cpus().length}, node ${process.version}, voxel ${hz} Hz`);
const results = [];
for (const policy of process.env.QUICK ? ['coverage50' as SamplingPolicy] : SAMPLING_POLICIES) results.push(run(policy, 0, 300));
for (const stress of process.env.QUICK ? [] : [10, 25]) results.push(run('coverage50', stress, 300));
for (const r of results) console.log(JSON.stringify(r));
const long = run('coverage50', 0, Math.round(minutes * 60 * hz), true);
console.log('LONG', JSON.stringify(long));
