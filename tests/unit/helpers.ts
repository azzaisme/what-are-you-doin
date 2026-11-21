import { CHUNK_BITS, CHUNK_MASK, CHUNK_VOLUME, GRID_SIZE } from '../../src/voxels/grid.ts';
import { MeshOutput, meshRegion } from '../../src/voxels/mesher.ts';
import type { MeshMode } from '../../src/voxels/mesher.ts';
import type { VoxelWorld } from '../../src/voxels/world.ts';

export interface Cell {
    i: number;
    j: number;
    k: number;
}

export function keyToCell(world: VoxelWorld, key: number): Cell {
    const c = world.chunks[Math.floor(key / CHUNK_VOLUME)];
    const li = key % CHUNK_VOLUME;
    const lx = li & CHUNK_MASK;
    const lz = (li >> CHUNK_BITS) & CHUNK_MASK;
    const ly = li >> (2 * CHUNK_BITS);
    return { i: c.cx * 16 + lx, j: c.cy * 16 + ly, k: c.cz * 16 + lz };
}

export function cellId(c: Cell): string {
    return `${c.i},${c.j},${c.k}`;
}

export function objectCellSet(world: VoxelWorld, id: number): Set<string> {
    const out = new Set<string>();
    for (const key of world.objectCells(id).keys()) out.add(cellId(keyToCell(world, key)));
    return out;
}

/** Number of 26-connected components in a cell set. */
export function components(cells: Set<string>): number {
    const seen = new Set<string>();
    let n = 0;
    for (const start of cells) {
        if (seen.has(start)) continue;
        n++;
        const stack = [start];
        seen.add(start);
        while (stack.length) {
            const cur = stack.pop()!;
            const [i, j, k] = cur.split(',').map(Number);
            for (let dx = -1; dx <= 1; dx++)
                for (let dy = -1; dy <= 1; dy++)
                    for (let dz = -1; dz <= 1; dz++) {
                        const id = `${i + dx},${j + dy},${k + dz}`;
                        if (cells.has(id) && !seen.has(id)) {
                            seen.add(id);
                            stack.push(id);
                        }
                    }
        }
    }
    return n;
}

export interface Face {
    cell: string;
    dir: string;
    value: number;
}

const DIRS = ['+x', '-x', '+y', '-y', '+z', '-z'];

/** Decomposes all quads of a mesh output into unit faces (cell + outward direction + colour key). */
export function meshFaces(out: MeshOutput): Face[] {
    const faces: Face[] = [];
    for (const cls of out.classes) {
        for (let q = 0; q < cls.vertexCount; q += 4) {
            const p = cls.positions;
            const nx = cls.normals[q * 3];
            const ny = cls.normals[q * 3 + 1];
            const nz = cls.normals[q * 3 + 2];
            const a = nx !== 0 ? 0 : ny !== 0 ? 1 : 2;
            const sign = (nx || ny || nz) > 0 ? 1 : -1;
            const mins = [Infinity, Infinity, Infinity];
            const maxs = [-Infinity, -Infinity, -Infinity];
            for (let v = 0; v < 4; v++) {
                for (let c = 0; c < 3; c++) {
                    const x = p[(q + v) * 3 + c];
                    mins[c] = Math.min(mins[c], x);
                    maxs[c] = Math.max(maxs[c], x);
                }
            }
            const lo = mins.map((m) => Math.round(m / GRID_SIZE));
            const hi = maxs.map((m) => Math.round(m / GRID_SIZE));
            const plane = lo[a];
            const cellA = sign > 0 ? plane - 1 : plane;
            const u = (a + 1) % 3;
            const w = (a + 2) % 3;
            const col = cls.colors;
            const value = col[q * 4] | (col[q * 4 + 1] << 8) | (col[q * 4 + 2] << 16);
            for (let iu = lo[u]; iu < hi[u]; iu++) {
                for (let iw = lo[w]; iw < hi[w]; iw++) {
                    const c = [0, 0, 0];
                    c[a] = cellA;
                    c[u] = iu;
                    c[w] = iw;
                    faces.push({ cell: `${c[0]},${c[1]},${c[2]}`, dir: DIRS[a * 2 + (sign > 0 ? 0 : 1)], value });
                }
            }
        }
    }
    return faces;
}

export function meshAll(
    world: VoxelWorld,
    mode: MeshMode,
    minI: number,
    minJ: number,
    minK: number,
    sx: number,
    sy: number,
    sz: number,
    greedy = true
): MeshOutput {
    const out = new MeshOutput();
    meshRegion(world, mode, minI, minJ, minK, sx, sy, sz, out, { greedy, ao: true });
    return out;
}

/** Deterministic PRNG for tests. */
export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
