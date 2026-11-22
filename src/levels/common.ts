/**
 * Shared level-building helpers: noise, a deterministic PRNG, the column terrain rasterizer (shell
 * fill over implicit bedrock, ADR 0005), and the stepped pine and boulder used by every level.
 * Pure module, no engine.
 */

import { GRID_SIZE, cellCenterX, cellCenterZ, cellIndexX, cellIndexZ } from '../voxels/grid.ts';
import { aabb, pose, quatFromYawPitchRoll } from '../voxels/math.ts';
import { M, voxel } from '../voxels/palette.ts';
import type { RasterStats } from '../voxels/rasterizer.ts';
import { cone, cylinder, hash3, implicit, latticeShade } from '../voxels/volumes.ts';
import type { VoxelWorld } from '../voxels/world.ts';

export function smoothstep(e0: number, e1: number, x: number): number {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
}

export function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

function hashUnit(i: number, j: number, seed: number): number {
    return hash3(i, j, seed, 1013) / 4294967296;
}

/** Smooth 2D value noise in [0, 1). */
export function valueNoise(x: number, z: number, seed: number): number {
    const xi = Math.floor(x);
    const zi = Math.floor(z);
    const fx = x - xi;
    const fz = z - zi;
    const ux = fx * fx * (3 - 2 * fx);
    const uz = fz * fz * (3 - 2 * fz);
    const a = hashUnit(xi, zi, seed);
    const b = hashUnit(xi + 1, zi, seed);
    const c = hashUnit(xi, zi + 1, seed);
    const d = hashUnit(xi + 1, zi + 1, seed);
    return lerp(lerp(a, b, ux), lerp(c, d, ux), uz);
}

export function fbm(x: number, z: number, seed: number, octaves = 3): number {
    let sum = 0;
    let amp = 0.5;
    let f = 1;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
        sum += valueNoise(x * f, z * f, seed + o * 31) * amp;
        norm += amp;
        amp *= 0.5;
        f *= 2.03;
    }
    return sum / norm;
}

/** Contiguous shade patches (merge-friendly) instead of per-cell noise. */
export function patchShade(x: number, z: number, scale: number, seed: number): number {
    return Math.min(3, Math.floor(fbm(x / scale, z / scale, seed, 2) * 4.4 - 0.2)) & 3;
}

/** Deterministic PRNG. */
export function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export interface TreeSpot {
    x: number;
    z: number;
    scale: number;
    yaw: number;
    /** 'pine' (default) or 'oak' (deciduous, autumn crown: leaves fall from it). */
    kind?: 'pine' | 'oak';
}

/** Oak dimensions in units of its scale: trunk, and the crown blobs (offset x, y, z, radius). */
export const OAK = {
    trunkHeight: 1.9,
    trunkRadius: 0.17,
    blobs: [
        [0, 2.55, 0, 1.15],
        [0.7, 2.25, 0.3, 0.8],
        [-0.55, 2.35, -0.45, 0.85]
    ] as const
};

export interface RockSpot {
    x: number;
    z: number;
    rx: number;
    ry: number;
    rz: number;
    yaw: number;
}

/** Pine tier cones (radius, height, base height), in units of the tree scale. */
export const PINE_TIERS = [
    { r: 1.15, h: 1.7, y: 0.9 },
    { r: 0.92, h: 1.5, y: 1.75 },
    { r: 0.68, h: 1.3, y: 2.55 },
    { r: 0.42, h: 1.05, y: 3.3 }
] as const;
export const PINE_TRUNK_HEIGHT = 1.8;
export const pineTrunkRadius = (scale: number) => 0.13 * scale + 0.03;

/** Height of a rock's centre above the analytic ground (the voxel build uses the same offset). */
export const ROCK_CENTRE_LIFT = 0.35;

export interface TerrainSpec {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    /** Bottom of the stored shell along the world border. */
    cutBaseY: number;
    /** Integer index of the top solid cell at (x, z). */
    topCell(x: number, z: number): number;
    /** `grad`: the ground's steepness there (rise over run, summed over x and z), from the column tops. */
    surface(x: number, z: number, top: number, grad: number): number;
    side(depthBelowTop: number, j: number, z: number, x: number): number;
}

/**
 * Writes ground columns: the top cell gets the surface material, the shell below it is filled down
 * to one below the lowest neighbour (or the cut base on the border), and everything deeper is
 * implicit bedrock. Returns the number of columns.
 */
export function rasterizeTerrain(world: VoxelWorld, t: TerrainSpec): number {
    const i0 = cellIndexX(t.minX);
    const i1 = cellIndexX(t.maxX) - 1;
    const k0 = cellIndexZ(t.minZ);
    const k1 = cellIndexZ(t.maxZ) - 1;
    const W = i1 - i0 + 1;
    const D = k1 - k0 + 1;
    const tops = new Int32Array(W * D);
    for (let k = k0; k <= k1; k++) {
        const z = cellCenterZ(k);
        for (let i = i0; i <= i1; i++) tops[i - i0 + (k - k0) * W] = t.topCell(cellCenterX(i), z);
    }
    const cutBase = Math.floor(t.cutBaseY / GRID_SIZE);
    const bottoms = new Int32Array(W * D);
    let columns = 0;
    for (let k = k0; k <= k1; k++) {
        const z = cellCenterZ(k);
        for (let i = i0; i <= i1; i++) {
            const x = cellCenterX(i);
            const top = tops[i - i0 + (k - k0) * W];
            let bottom: number;
            if (i === i0 || i === i1 || k === k0 || k === k1) {
                bottom = Math.min(cutBase, top - 3);
            } else {
                const n = Math.min(
                    tops[i - 1 - i0 + (k - k0) * W],
                    tops[i + 1 - i0 + (k - k0) * W],
                    tops[i - i0 + (k - 1 - k0) * W],
                    tops[i - i0 + (k + 1 - k0) * W]
                );
                bottom = Math.min(top - 1, n - 1);
            }
            bottoms[i - i0 + (k - k0) * W] = bottom;
            const o = i - i0 + (k - k0) * W;
            const gx = i > i0 && i < i1 ? Math.abs(tops[o + 1] - tops[o - 1]) : 0;
            const gz = k > k0 && k < k1 ? Math.abs(tops[o + W] - tops[o - W]) : 0;
            world.setStatic(i, top, k, t.surface(x, z, top, (gx + gz) / 2), 0);
            for (let j = top - 1; j >= bottom; j--) world.setStatic(i, j, k, t.side(top - j, j, z, x), 0);
            columns++;
        }
    }
    world.bedrock = { minI: i0, minK: k0, width: W, depth: D, bottom: bottoms };
    return columns;
}

/**
 * The same ground as `rasterizeTerrain`, for one tile of a streamed level: columns `r` only (clipped
 * to the terrain), with the tile's own bedrock. Neighbouring tops come from the analytic surface, so
 * a tile is identical whether its neighbours are built or not. Returns the number of columns.
 */
export function rasterizeTerrainTile(
    world: VoxelWorld,
    t: TerrainSpec,
    r: { i0: number; i1: number; k0: number; k1: number },
    tile: { ti: number; tk: number }
): number {
    const L0 = cellIndexX(t.minX);
    const L1 = cellIndexX(t.maxX) - 1;
    const M0 = cellIndexZ(t.minZ);
    const M1 = cellIndexZ(t.maxZ) - 1;
    const i0 = Math.max(r.i0, L0);
    const i1 = Math.min(r.i1, L1);
    const k0 = Math.max(r.k0, M0);
    const k1 = Math.min(r.k1, M1);
    if (i0 > i1 || k0 > k1) {
        world.setTileBedrock(tile.ti, tile.tk, null);
        return 0;
    }
    // tops with a one-column margin
    const W = i1 - i0 + 3;
    const D = k1 - k0 + 3;
    const tops = new Int32Array(W * D);
    for (let k = k0 - 1; k <= k1 + 1; k++) {
        const z = cellCenterZ(k);
        for (let i = i0 - 1; i <= i1 + 1; i++) tops[i - i0 + 1 + (k - k0 + 1) * W] = t.topCell(cellCenterX(i), z);
    }
    const cutBase = Math.floor(t.cutBaseY / GRID_SIZE);
    const bw = r.i1 - r.i0 + 1;
    const bd = r.k1 - r.k0 + 1;
    const bottoms = new Int32Array(bw * bd).fill(-0x7fffffff);
    let columns = 0;
    for (let k = k0; k <= k1; k++) {
        const z = cellCenterZ(k);
        for (let i = i0; i <= i1; i++) {
            const x = cellCenterX(i);
            const o = i - i0 + 1 + (k - k0 + 1) * W;
            const top = tops[o];
            let bottom: number;
            if (i === L0 || i === L1 || k === M0 || k === M1) bottom = Math.min(cutBase, top - 3);
            else bottom = Math.min(top - 1, Math.min(tops[o - 1], tops[o + 1], tops[o - W], tops[o + W]) - 1);
            bottoms[i - r.i0 + (k - r.k0) * bw] = bottom;
            const grad = (Math.abs(tops[o + 1] - tops[o - 1]) + Math.abs(tops[o + W] - tops[o - W])) / 2;
            world.setStatic(i, top, k, t.surface(x, z, top, grad), 0);
            for (let j = top - 1; j >= bottom; j--) world.setStatic(i, j, k, t.side(top - j, j, z, x), 0);
            columns++;
        }
    }
    world.setTileBedrock(tile.ti, tile.tk, { minI: r.i0, minK: r.k0, width: bw, depth: bd, bottom: bottoms });
    return columns;
}

/** A stepped pine: trunk and four needle tiers, rasterized into the static layer. `base` is the ground top. */
export function pine(
    world: VoxelWorld,
    x: number,
    z: number,
    base: number,
    scale: number,
    yaw: number,
    stats: RasterStats,
    seed: number
): void {
    const trunkH = PINE_TRUNK_HEIGHT * scale;
    const trunk = cylinder('y', pineTrunkRadius(scale), trunkH * 0.5, (lx, ly, lz) =>
        voxel(M.Bark, latticeShade(lx, ly * 0.5, lz, 0.1, seed))
    );
    const q = quatFromYawPitchRoll(yaw, 0, 0);
    world.rasterizeStatic(trunk, pose(x, base + trunkH * 0.5 - 0.05, z, q), 'coverage50', 1, stats);
    const tiers = PINE_TIERS;
    for (let n = 0; n < tiers.length; n++) {
        const t = tiers[n];
        const r = t.r * scale;
        const h = t.h * scale;
        const tierSeed = seed * 7 + n;
        const needles = cone(r, h, (lx, ly, lz) => {
            const rr = Math.hypot(lx, lz) / (r * (1 - ly / h) + 1e-6);
            const lit = rr > 0.72 && ly > h * 0.15;
            return voxel(lit ? M.NeedleLight : M.Needle, latticeShade(lx, ly, lz, 0.2, tierSeed));
        });
        world.rasterizeStatic(needles, pose(x, base + t.y * scale, z, q), 'coverage50', 2, stats);
    }
}

/** A mossy boulder (noisy ellipsoid). `base` is the ground top. */
export function rock(
    world: VoxelWorld,
    x: number,
    z: number,
    base: number,
    rx: number,
    ry: number,
    rz: number,
    yaw: number,
    stats: RasterStats,
    seed: number
): void {
    const v = implicit(
        aabb(-rx * 1.25, -ry * 1.25, -rz * 1.25, rx * 1.25, ry * 1.25, rz * 1.25),
        (lx, ly, lz) => {
            const e = (lx * lx) / (rx * rx) + (ly * ly) / (ry * ry) + (lz * lz) / (rz * rz);
            const n = valueNoise(lx * 3 + seed, lz * 3 + ly * 2, seed) * 0.45;
            return e < 0.85 + n;
        },
        (lx, ly, lz) =>
            ly > ry * 0.45 && valueNoise(lx * 4, lz * 4, seed + 3) > 0.35
                ? voxel(M.Moss, latticeShade(lx, ly, lz, 0.1, seed))
                : voxel(M.Rock, latticeShade(lx, ly, lz, 0.1, seed))
    );
    world.rasterizeStatic(
        v,
        pose(x, base + ry * ROCK_CENTRE_LIFT, z, quatFromYawPitchRoll(yaw, 0, 0)),
        'center',
        3,
        stats
    );
}

/** A deciduous tree in early autumn: trunk and a lumpy crown of green, gold and red patches. */
export function oak(
    world: VoxelWorld,
    x: number,
    z: number,
    base: number,
    scale: number,
    yaw: number,
    stats: RasterStats,
    seed: number
): void {
    const q = quatFromYawPitchRoll(yaw, 0, 0);
    const th = OAK.trunkHeight * scale;
    const trunk = cylinder('y', OAK.trunkRadius * scale + 0.02, th * 0.5, (lx, ly, lz) =>
        voxel(M.Bark, latticeShade(lx, ly * 0.5, lz, 0.1, seed))
    );
    world.rasterizeStatic(trunk, pose(x, base + th * 0.5 - 0.05, z, q), 'coverage50', 1, stats);
    for (let n = 0; n < OAK.blobs.length; n++) {
        const [bx, by, bz, br] = OAK.blobs[n];
        const r = br * scale;
        const crown = implicit(
            aabb(-r * 1.2, -r * 1.2, -r * 1.2, r * 1.2, r * 1.2, r * 1.2),
            (lx, ly, lz) =>
                lx * lx + ly * ly * 1.25 + lz * lz <
                r * r * (0.82 + 0.3 * valueNoise(lx * 2.2 + seed, lz * 2.2 + ly * 1.7, seed + n)),
            (lx, ly, lz) => {
                const t = valueNoise((lx + x) * 1.3, (lz + z) * 1.3 + ly, seed + 7);
                const mat = t > 0.68 ? M.LeafRed : t > 0.45 ? M.LeafGold : M.Leaf;
                return voxel(mat, latticeShade(lx, ly, lz, 0.2, seed + n));
            }
        );
        const off = { x: bx * scale, z: bz * scale };
        // the blobs turn with the tree's yaw
        const c = Math.cos(yaw);
        const sn = Math.sin(yaw);
        world.rasterizeStatic(
            crown,
            pose(x + off.x * c + off.z * sn, base + by * scale, z - off.x * sn + off.z * c, q),
            'coverage50',
            2,
            stats
        );
    }
}

/** World centres and radii of an oak's crown blobs (for colliders and falling leaves). */
export function oakCrown(t: TreeSpot, base: number): { x: number; y: number; z: number; r: number }[] {
    const c = Math.cos(t.yaw);
    const sn = Math.sin(t.yaw);
    return OAK.blobs.map(([bx, by, bz, br]) => ({
        x: t.x + bx * t.scale * c + bz * t.scale * sn,
        y: base + by * t.scale,
        z: t.z - bx * t.scale * sn + bz * t.scale * c,
        r: br * t.scale
    }));
}
