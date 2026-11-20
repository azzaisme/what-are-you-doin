// Measures static scene build + meshing in Node (CPU reference, no GPU).
import { buildRiverLab } from '../src/levels/river-lab.ts';
import { DYNAMIC_REGION, STATIC_REGION } from '../src/voxels/dirty.ts';
import { MeshOutput, meshRegionBlocked } from '../src/voxels/mesher.ts';
import { VoxelWorld } from '../src/voxels/world.ts';

const world = new VoxelWorld();
const r = buildRiverLab(world, 1);
console.log(`build: ${r.ms.toFixed(0)} ms, columns ${r.columns}, static cells ${r.staticCells}, chunks ${world.chunkCount}, trees ${r.trees}, rocks ${r.rocks}, reeds ${r.reeds}`);
const RX = STATIC_REGION.x, RY = STATIC_REGION.y, RZ = STATIC_REGION.z;
const regions = new Set<string>();
for (const c of world.chunks) if (c.stat) regions.add(`${Math.floor(c.cx * 16 / RX)},${Math.floor(c.cy * 16 / RY)},${Math.floor(c.cz * 16 / RZ)}`);
const out = new MeshOutput();
let quads = 0, faces = 0, tris = 0, maxMs = 0, nonEmpty = 0;
const t0 = performance.now();
for (const key of regions) {
    const [a, b, c] = key.split(',').map(Number);
    out.reset();
    const s = performance.now();
    meshRegionBlocked(world, 'static', a * RX, b * RY, c * RZ, RX, RY, RZ, DYNAMIC_REGION, out);
    maxMs = Math.max(maxMs, performance.now() - s);
    quads += out.quads; faces += out.faces; tris += out.triangleCount;
    if (out.quads) nonEmpty++;
}
console.log(`static mesh: ${regions.size} regions (${nonEmpty} non-empty), ${(performance.now() - t0).toFixed(0)} ms total, max region ${maxMs.toFixed(1)} ms`);
console.log(`unit faces ${faces}, quads ${quads} (greedy ratio ${(faces / quads).toFixed(2)}), triangles ${tris}`);
const mem = process.memoryUsage();
console.log(`heap ${(mem.heapUsed / 1e6).toFixed(0)} MB, arrayBuffers ${(mem.arrayBuffers / 1e6).toFixed(0)} MB`);
