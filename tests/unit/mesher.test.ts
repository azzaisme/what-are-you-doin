import { describe, expect, it } from 'vitest';

import { GRID_SIZE } from '../../src/voxels/grid.ts';
import { DEG, pose, quatFromAxisAngle } from '../../src/voxels/math.ts';
import { M, VALUE_RGB, voxel } from '../../src/voxels/palette.ts';
import { createRasterStats } from '../../src/voxels/rasterizer.ts';
import { box, grain, solid } from '../../src/voxels/volumes.ts';
import { VoxelWorld } from '../../src/voxels/world.ts';

import { meshAll, meshFaces, mulberry32  } from './helpers.ts';
import type { Face } from './helpers.ts';

const DIRS: [string, number, number, number][] = [
    ['+x', 1, 0, 0],
    ['-x', -1, 0, 0],
    ['+y', 0, 1, 0],
    ['-y', 0, -1, 0],
    ['+z', 0, 0, 1],
    ['-z', 0, 0, -1]
];

/** Brute-force expected faces for one emission mode over a cell box. */
function expectedFaces(world: VoxelWorld, mode: 'static' | 'dynamic', min: number[], size: number[]): Map<string, number> {
    const out = new Map<string, number>();
    for (let i = min[0]; i < min[0] + size[0]; i++)
        for (let j = min[1]; j < min[1] + size[1]; j++)
            for (let k = min[2]; k < min[2] + size[2]; k++) {
                const s = world.staticAt(i, j, k);
                const d = world.dynAt(i, j, k);
                const e = mode === 'static' ? (s && !d ? s : 0) : d;
                if (!e) continue;
                for (const [name, dx, dy, dz] of DIRS) {
                    const ns = world.staticAt(i + dx, j + dy, k + dz);
                    const nd = world.dynAt(i + dx, j + dy, k + dz);
                    const blocked = mode === 'static' ? ns !== 0 : ns !== 0 || nd !== 0;
                    if (!blocked) out.set(`${i},${j},${k}|${name}`, VALUE_RGB[e]);
                }
            }
    return out;
}

function faceMap(faces: Face[]): Map<string, number> {
    const m = new Map<string, number>();
    for (const f of faces) {
        const id = `${f.cell}|${f.dir}`;
        expect(m.has(id), `duplicate face ${id}`).toBe(false);
        m.set(id, f.value);
    }
    return m;
}

function randomWorld(seed: number): VoxelWorld {
    const rnd = mulberry32(seed);
    const world = new VoxelWorld();
    // static noise straddling the origin and chunk seams (chunks are 16 cells)
    for (let n = 0; n < 900; n++) {
        const i = Math.floor(rnd() * 24) - 12;
        const j = Math.floor(rnd() * 24) - 12;
        const k = Math.floor(rnd() * 24) - 12;
        world.setStatic(i, j, k, voxel(rnd() < 0.5 ? M.Rock : M.Grass, Math.floor(rnd() * 4)));
    }
    world.addObject(1);
    world.addObject(2);
    const stats = createRasterStats();
    const q = quatFromAxisAngle(0.4, 1, 0.2, 33 * DEG);
    world.rasterizeObject(1, [{ volume: box(0.6, 0.3, 0.25, grain(M.Timber, 'x')), pose: pose(-0.07, 0.11, 0.03, q), priority: 0 }], 'coverage50', stats);
    world.rasterizeObject(2, [{ volume: box(0.3, 0.3, 0.3, solid(M.TestBlue)), pose: pose(0.4, -0.2, -0.6), priority: 0 }], 'center', stats);
    world.resolve();
    return world;
}

describe('mesher: exposed faces match brute force across chunk seams and negatives (§5.9)', () => {
    for (const seed of [1, 2, 3]) {
        it(`seed ${seed}: static and dynamic emission match the brute-force rules`, () => {
            const world = randomWorld(seed);
            const min = [-14, -14, -14];
            const size = [28, 28, 28];
            for (const mode of ['static', 'dynamic'] as const) {
                const got = faceMap(meshFaces(meshAll(world, mode, min[0], min[1], min[2], size[0], size[1], size[2], false)));
                const exp = expectedFaces(world, mode, min, size);
                expect(got.size).toBe(exp.size);
                for (const [id, v] of exp) expect(got.get(id), id).toBe(v);
            }
        });
    }

    it('meshing per 16^3 chunk gives the same faces as meshing one large box (no seam loss/duplication)', () => {
        const world = randomWorld(9);
        for (const mode of ['static', 'dynamic'] as const) {
            const whole = faceMap(meshFaces(meshAll(world, mode, -16, -16, -16, 32, 32, 32, true)));
            const parts: Face[] = [];
            for (const cx of [-16, 0])
                for (const cy of [-16, 0])
                    for (const cz of [-16, 0]) parts.push(...meshFaces(meshAll(world, mode, cx, cy, cz, 16, 16, 16, true)));
            const chunked = faceMap(parts);
            expect(chunked).toEqual(whole);
        }
    });
});

describe('mesher: composite visibility has no coplanar duplicates', () => {
    it('every visible composite face is emitted exactly once with the composite colour', () => {
        const world = randomWorld(4);
        const min = [-14, -14, -14];
        const size = [28, 28, 28];
        const st = faceMap(meshFaces(meshAll(world, 'static', min[0], min[1], min[2], size[0], size[1], size[2])));
        const dy = faceMap(meshFaces(meshAll(world, 'dynamic', min[0], min[1], min[2], size[0], size[1], size[2])));
        for (const id of dy.keys()) expect(st.has(id), `coplanar duplicate ${id}`).toBe(false);
        for (let i = min[0]; i < min[0] + size[0]; i++)
            for (let j = min[1]; j < min[1] + size[1]; j++)
                for (let k = min[2]; k < min[2] + size[2]; k++) {
                    const v = world.valueAt(i, j, k);
                    if (!v) continue;
                    for (const [name, dx, dy2, dz] of DIRS) {
                        if (world.valueAt(i + dx, j + dy2, k + dz)) continue;
                        const id = `${i},${j},${k}|${name}`;
                        const col = st.get(id) ?? dy.get(id);
                        expect(col, `visible face missing ${id}`).toBe(VALUE_RGB[v]);
                    }
                }
    });
});

describe('mesher: greedy merging preserves silhouette and materials', () => {
    it('greedy and per-face meshes cover the same unit faces with the same colours', () => {
        const world = randomWorld(5);
        for (const mode of ['static', 'dynamic'] as const) {
            const a = meshAll(world, mode, -14, -14, -14, 28, 28, 28, true);
            const b = meshAll(world, mode, -14, -14, -14, 28, 28, 28, false);
            expect(faceMap(meshFaces(a))).toEqual(faceMap(meshFaces(b)));
            expect(a.quads).toBeLessThanOrEqual(b.quads);
        }
    });

    it('merges a flat uniform floor into a few large quads', () => {
        const world = new VoxelWorld();
        for (let i = 0; i < 32; i++) for (let k = 0; k < 32; k++) world.setStatic(i, 0, k, voxel(M.Grass, 0));
        const out = meshAll(world, 'static', 0, 0, 0, 32, 1, 32);
        const top = meshFaces(out).filter((f) => f.dir === '+y');
        expect(top.length).toBe(32 * 32);
        expect(out.quads).toBeLessThan(40);
    });
});

describe('mesher: grid alignment and winding (§7.4)', () => {
    it('places 100% of vertices on grid planes and winds triangles counter-clockwise outward', () => {
        const world = randomWorld(6);
        const out = meshAll(world, 'dynamic', -14, -14, -14, 28, 28, 28);
        let verts = 0;
        for (const cls of out.classes) {
            for (let v = 0; v < cls.vertexCount * 3; v++) {
                const x = cls.positions[v] / GRID_SIZE;
                expect(Math.abs(x - Math.round(x))).toBeLessThan(1e-4);
                verts++;
            }
            for (let t = 0; t < cls.indexCount; t += 3) {
                const ia = cls.indices[t];
                const ib = cls.indices[t + 1];
                const ic = cls.indices[t + 2];
                const p = cls.positions;
                const ux = p[ib * 3] - p[ia * 3];
                const uy = p[ib * 3 + 1] - p[ia * 3 + 1];
                const uz = p[ib * 3 + 2] - p[ia * 3 + 2];
                const vx = p[ic * 3] - p[ia * 3];
                const vy = p[ic * 3 + 1] - p[ia * 3 + 1];
                const vz = p[ic * 3 + 2] - p[ia * 3 + 2];
                const cx = uy * vz - uz * vy;
                const cy = uz * vx - ux * vz;
                const cz = ux * vy - uy * vx;
                const n = cls.normals;
                const dot = cx * n[ia * 3] + cy * n[ia * 3 + 1] + cz * n[ia * 3 + 2];
                expect(dot).toBeGreaterThan(0);
            }
        }
        expect(verts).toBeGreaterThan(0);
    });

    it('emits only axis-aligned normals', () => {
        const world = randomWorld(7);
        const out = meshAll(world, 'static', -14, -14, -14, 28, 28, 28);
        for (const cls of out.classes) {
            for (let v = 0; v < cls.vertexCount; v++) {
                const n = [cls.normals[v * 3], cls.normals[v * 3 + 1], cls.normals[v * 3 + 2]];
                expect(n.filter((c) => c !== 0).length).toBe(1);
                expect(Math.abs(n[0] + n[1] + n[2])).toBe(1);
            }
        }
    });
});

describe('mesher: ambient occlusion', () => {
    it('darkens the corner of a floor next to a wall and leaves open floor unoccluded', () => {
        const world = new VoxelWorld();
        for (let i = 0; i < 4; i++) for (let k = 0; k < 4; k++) world.setStatic(i, 0, k, voxel(M.Rock));
        world.setStatic(0, 1, 0, voxel(M.Rock));
        const out = meshAll(world, 'static', 0, 0, 0, 4, 2, 4, false);
        const cls = out.classes[0];
        let minA = 255;
        let maxA = 0;
        for (let v = 0; v < cls.vertexCount; v++) {
            if (cls.normals[v * 3 + 1] !== 1) continue;
            minA = Math.min(minA, cls.colors[v * 4 + 3]);
            maxA = Math.max(maxA, cls.colors[v * 4 + 3]);
        }
        expect(minA).toBeLessThan(255);
        expect(maxA).toBe(255);
    });
});
