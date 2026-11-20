/**
 * The River Lab (design doc §7.2): a compact original test scene. A shallow river crosses the lab
 * along X, a flat far-bank plateau holds the moving test props, pines and rocks frame it, and a
 * terraced ridge gives a distant silhouette. Everything solid is written into the same 10 cm grid.
 *
 * Pure module: it knows the analytic terrain (used by the walker and for placing props) and how to
 * rasterize the static scenery into a VoxelWorld. It never touches the engine.
 */

import { GRID_SIZE, cellCenterX, cellCenterZ, cellIndexX, cellIndexZ } from '../voxels/grid.ts';
import { aabb, pose, quatFromYawPitchRoll } from '../voxels/math.ts';
import { M, voxel } from '../voxels/palette.ts';
import { createRasterStats  } from '../voxels/rasterizer.ts';
import type { RasterStats } from '../voxels/rasterizer.ts';
import { cone, cylinder, hash3, implicit, latticeShade } from '../voxels/volumes.ts';
import type { VoxelWorld } from '../voxels/world.ts';

/** River surface height. Mid-cell, so the shoreline steps read above and below the water. */
export const WATER_Y = -0.05;
/** Flat far-bank plateau where the ute and beaver move. Top of ground exactly on a grid plane. */
export const PLATEAU_Y = 0.3;

export const LAB_MIN_X = -28;
export const LAB_MAX_X = 28;
export const LAB_MIN_Z = -42;
export const LAB_MAX_Z = 14;
const CUT_BASE_Y = -1.5;

/** Plateau region (far bank). */
export const PLATEAU = { minX: -10.5, maxX: 8.5, minZ: -11.5, maxZ: -4.2 };

/** The ute's oval track on the plateau. */
export const UTE_TRACK = { cx: -4.6, cz: -7.8, rx: 3.9, rz: 2.4 };
/** The beaver's walking loop. */
export const BEAVER_LOOP = { cx: 4.4, cz: -6.4, r: 1.9 };

// ------------------------------------------------------------------------------------- noise

function smoothstep(e0: number, e1: number, x: number): number {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
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

function fbm(x: number, z: number, seed: number, octaves = 3): number {
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

// ------------------------------------------------------------------------------------- terrain

export function riverCenterZ(x: number): number {
    return 0.6 * Math.sin(x * 0.21 + 0.4) + 0.25 * Math.sin(x * 0.57 + 1.3);
}

export function riverHalfWidth(x: number): number {
    return 2.25 + 0.3 * Math.sin(x * 0.29 + 2.0);
}

function plateauWeight(x: number, z: number): number {
    const p = PLATEAU;
    const m = 1.2;
    const wx = smoothstep(p.minX - m, p.minX, x) * (1 - smoothstep(p.maxX, p.maxX + m, x));
    const wz = smoothstep(p.minZ - m, p.minZ, z) * (1 - smoothstep(p.maxZ, p.maxZ + m, z));
    return wx * wz;
}

/** Continuous ground height at (x, z), before quantization to cells. */
export function terrainHeight(x: number, z: number): number {
    const zc = riverCenterZ(x);
    const half = riverHalfWidth(x);
    const d = z - zc;
    const ad = Math.abs(d);
    const near = d > 0;

    // bank height on each side
    let bank: number;
    if (near) {
        bank = 0.42 + 0.22 * (fbm(x * 0.18, z * 0.18, 7) - 0.5) + 0.25 * smoothstep(8, 14, z);
    } else {
        bank = 0.32 + 0.3 * (fbm(x * 0.16, z * 0.16, 3) - 0.5);
        // rolling rise towards the ridge, then the ridge itself
        bank += 0.9 * smoothstep(-12, -22, z) * (0.6 + 0.8 * fbm(x * 0.08, z * 0.08, 5));
        const ridge = smoothstep(-22, -33, z);
        if (ridge > 0) {
            const peak = 5.5 + 4.5 * fbm(x * 0.045 + 3.1, 0.7, 19, 4) + 1.5 * fbm(x * 0.12, z * 0.12, 23);
            bank += ridge * peak;
        }
        const w = plateauWeight(x, z);
        bank = lerp(bank, PLATEAU_Y - 1e-3, w);
    }

    if (ad < half) {
        return -0.62 + 0.52 * smoothstep(half * 0.35, half, ad);
    }
    const t = smoothstep(half, half + 1.0, ad);
    const h = lerp(-0.1, bank, t);
    // the distant ridge is terraced into 0.3 m benches: a deliberate stepped silhouette
    const terrace = smoothstep(-19, -23, z);
    if (terrace > 0) return lerp(h, Math.floor(h / TERRACE) * TERRACE + 1e-3, terrace);
    return h;
}

const TERRACE = 0.3;

/** Integer cell index of the top solid cell of the ground column containing (x, z). */
export function groundTopCell(x: number, z: number): number {
    return Math.floor(terrainHeight(x, z) / GRID_SIZE - 1e-9);
}

/** Height of the top surface of the voxel ground column at (x, z) (a grid plane). */
export function groundSurfaceY(x: number, z: number): number {
    return (groundTopCell(x, z) + 1) * GRID_SIZE;
}

function onUteTrack(x: number, z: number): number {
    const t = UTE_TRACK;
    const dx = (x - t.cx) / t.rx;
    const dz = (z - t.cz) / t.rz;
    const r = Math.hypot(dx, dz);
    // distance (approx, metres) from the oval
    return Math.abs(r - 1) * Math.min(t.rx, t.rz);
}

/** Contiguous shade patches (merge-friendly) instead of per-cell noise. */
function patchShade(x: number, z: number, scale: number, seed: number): number {
    return Math.min(3, Math.floor(fbm(x / scale, z / scale, seed, 2) * 4.4 - 0.2)) & 3;
}

function surfaceMaterial(x: number, z: number, top: number): number {
    const y = (top + 1) * GRID_SIZE;
    const patch = fbm(x * 0.35, z * 0.35, 41);
    if (z < -24) {
        // distant ridge: calm colours, large patches, so faces merge
        const slope = Math.abs(terrainHeight(x + 0.3, z) - terrainHeight(x - 0.3, z)) + Math.abs(terrainHeight(x, z + 0.3) - terrainHeight(x, z - 0.3));
        if (slope > 0.8) return voxel(M.HillRock, patchShade(x, z, 3, 13) & 1);
        return voxel(M.HillGrass, patchShade(x, z, 4.5, 9));
    }
    const shade = patchShade(x, z, Math.abs(x) < 14 && z > -16 ? 0.9 : 2.5, 77);
    if (y <= WATER_Y - 0.05) return voxel(patch > 0.52 ? M.Pebble : M.Sand, shade);
    if (y <= WATER_Y + 0.2) return voxel(M.Mud, shade);
    if (y <= WATER_Y + 0.32 && Math.abs(z - riverCenterZ(x)) < riverHalfWidth(x) + 0.75) return voxel(M.Sand, shade);
    if (z < 0 && onUteTrack(x, z) < 0.95) return voxel(M.Path, shade);
    if (patch > 0.62) return voxel(M.GrassDry, shade);
    return voxel(M.Grass, shade);
}

/** Exposed cut faces read as horizontal strata: shade depends on height only, so runs merge. */
function sideMaterial(depthBelowTop: number, j: number, z: number): number {
    const strata = hash3(Math.floor((j * GRID_SIZE) / 0.1), 0, 0, 5) & 3;
    // ridge terrace risers stay green (sod over the bench edge), rock lower down
    if (z < -24) return depthBelowTop * GRID_SIZE <= 0.3 ? voxel(M.HillGrass, 1 + (hash3(Math.floor((j * GRID_SIZE) / 0.3), 0, 0, 5) & 1) * 2) : voxel(M.HillRock, hash3(Math.floor((j * GRID_SIZE) / 0.3), 0, 0, 5) & 1);
    if (depthBelowTop * GRID_SIZE <= 0.2) return voxel(M.Dirt, strata);
    return voxel(M.Rock, strata);
}

// ------------------------------------------------------------------------------------- props

function pine(world: VoxelWorld, x: number, z: number, scale: number, yaw: number, stats: RasterStats, seed: number): void {
    const base = groundSurfaceY(x, z);
    const trunkH = PINE_TRUNK_HEIGHT * scale;
    const trunk = cylinder('y', pineTrunkRadius(scale), trunkH * 0.5, (lx, ly, lz) => voxel(M.Bark, latticeShade(lx, ly * 0.5, lz, 0.1, seed)));
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

function rock(world: VoxelWorld, x: number, z: number, rx: number, ry: number, rz: number, yaw: number, stats: RasterStats, seed: number): void {
    const base = groundSurfaceY(x, z);
    const v = implicit(
        aabb(-rx * 1.25, -ry * 1.25, -rz * 1.25, rx * 1.25, ry * 1.25, rz * 1.25),
        (lx, ly, lz) => {
            const e = (lx * lx) / (rx * rx) + (ly * ly) / (ry * ry) + (lz * lz) / (rz * rz);
            const n = valueNoise(lx * 3 + seed, lz * 3 + ly * 2, seed) * 0.45;
            return e < 0.85 + n;
        },
        (lx, ly, lz) => (ly > ry * 0.45 && valueNoise(lx * 4, lz * 4, seed + 3) > 0.35 ? voxel(M.Moss, latticeShade(lx, ly, lz, 0.1, seed)) : voxel(M.Rock, latticeShade(lx, ly, lz, 0.1, seed)))
    );
    world.rasterizeStatic(v, pose(x, base + ry * ROCK_CENTRE_LIFT, z, quatFromYawPitchRoll(yaw, 0, 0)), 'center', 3, stats);
}

// ------------------------------------------------------------------------------------- layout

export interface TreeSpot {
    x: number;
    z: number;
    scale: number;
    yaw: number;
}

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

/**
 * Tree and rock placement, independent of the voxel grid. The voxel build and the physics colliders
 * both read it, so they always agree. Same random sequence as the original build.
 */
export function labLayout(seed = 1): { trees: TreeSpot[]; rocks: RockSpot[]; rng: () => number } {
    const r = rng(seed);
    const trees: TreeSpot[] = [];
    const lab: [number, number, number][] = [
        [-11.5, -13.0, 1.15],
        [-8.6, -14.6, 1.3],
        [-5.0, -13.4, 1.0],
        [-1.8, -15.0, 1.25],
        [1.4, -12.8, 0.95],
        [4.8, -14.2, 1.2],
        [8.6, -12.2, 1.05],
        [11.6, -9.5, 1.3],
        [12.5, -14.8, 1.0],
        [-13.2, -7.0, 1.2],
        [-12.6, 5.6, 1.1],
        [11.8, 6.4, 1.25],
        [9.4, 10.5, 0.9],
        [-9.8, 10.8, 1.0],
        [16.5, -11.0, 1.2],
        [-17.0, -12.5, 1.3],
        [19.5, -16.0, 1.1],
        [-20.5, -17.5, 1.15]
    ];
    for (const [x, z, s] of lab) {
        const tx = x + (r() - 0.5) * 0.4;
        const tz = z + (r() - 0.5) * 0.4;
        trees.push({ x: tx, z: tz, scale: s, yaw: r() * Math.PI * 2 });
    }
    for (let n = 0; n < 34; n++) {
        const x = -32 + r() * 64;
        const z = -25 - r() * 12;
        const scale = 0.8 + r() * 0.6;
        trees.push({ x, z, scale, yaw: r() * Math.PI * 2 });
    }
    const rocks: RockSpot[] = [];
    const rockSpots: [number, number, number][] = [
        [-6.8, -3.1, 0.55],
        [-2.6, 2.9, 0.4],
        [6.6, 3.1, 0.6],
        [9.4, -3.4, 0.45],
        [2.4, 0.4, 0.32],
        [-9.6, 0.1, 0.38],
        [12.0, 1.9, 0.7],
        [-12.4, -3.6, 0.6],
        [0.6, -16.5, 0.9],
        [-15.5, -14.0, 0.75]
    ];
    for (const [x, z, s] of rockSpots) {
        const rx = s * (1.1 + r() * 0.4);
        const ry = s * (0.65 + r() * 0.2);
        const rz = s * (0.9 + r() * 0.3);
        rocks.push({ x, z, rx, ry, rz, yaw: r() * Math.PI });
    }
    // the voxel build continues this random stream for reeds and flowers
    return { trees, rocks, rng: r };
}

/** Height of a rock's centre above the analytic ground (the voxel build uses the same offset). */
export const ROCK_CENTRE_LIFT = 0.35;

// ------------------------------------------------------------------------------------- build

export interface LabBuildResult {
    columns: number;
    staticCells: number;
    trees: number;
    rocks: number;
    reeds: number;
    stats: RasterStats;
    ms: number;
}

/** Deterministic PRNG. */
function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function buildRiverLab(world: VoxelWorld, seed = 1): LabBuildResult {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const stats = createRasterStats();
    const i0 = cellIndexX(LAB_MIN_X);
    const i1 = cellIndexX(LAB_MAX_X) - 1;
    const k0 = cellIndexZ(LAB_MIN_Z);
    const k1 = cellIndexZ(LAB_MAX_Z) - 1;
    const W = i1 - i0 + 1;
    const D = k1 - k0 + 1;

    // ---- heightfield of top cells, sampled at column centres
    const tops = new Int32Array(W * D);
    for (let k = k0; k <= k1; k++) {
        const z = cellCenterZ(k);
        for (let i = i0; i <= i1; i++) {
            tops[(i - i0) + (k - k0) * W] = groundTopCell(cellCenterX(i), z);
        }
    }
    const cutBase = Math.floor(CUT_BASE_Y / GRID_SIZE);
    const bottoms = new Int32Array(W * D);
    let columns = 0;
    for (let k = k0; k <= k1; k++) {
        const z = cellCenterZ(k);
        for (let i = i0; i <= i1; i++) {
            const x = cellCenterX(i);
            const top = tops[(i - i0) + (k - k0) * W];
            // shell fill: down to one below the lowest neighbour, or to the cut base on the border
            let bottom: number;
            if (i === i0 || i === i1 || k === k0 || k === k1) {
                bottom = Math.min(cutBase, top - 3);
            } else {
                const n = Math.min(tops[(i - 1 - i0) + (k - k0) * W], tops[(i + 1 - i0) + (k - k0) * W], tops[(i - i0) + (k - 1 - k0) * W], tops[(i - i0) + (k + 1 - k0) * W]);
                bottom = Math.min(top - 1, n - 1);
            }
            bottoms[(i - i0) + (k - k0) * W] = bottom;
            world.setStatic(i, top, k, surfaceMaterial(x, z, top), 0);
            for (let j = top - 1; j >= bottom; j--) world.setStatic(i, j, k, sideMaterial(top - j, j, z), 0);
            columns++;
        }
    }

    // everything below the stored shell is implicit bedrock (solid for exposure, never drawn)
    world.bedrock = { minI: i0, minK: k0, width: W, depth: D, bottom: bottoms };

    // ---- pines and rocks from the shared layout (physics builds its colliders from the same data)
    const layout = labLayout(seed);
    const r = layout.rng;
    let trees = 0;
    for (const t of layout.trees) {
        pine(world, t.x, t.z, t.scale, t.yaw, stats, trees + seed * 13);
        trees++;
    }
    let rocks = 0;
    for (const k of layout.rocks) {
        rock(world, k.x, k.z, k.rx, k.ry, k.rz, k.yaw, stats, rocks + 3);
        rocks++;
    }

    // ---- reeds at the waterline, single-cell columns (grid aligned by construction)
    let reeds = 0;
    for (let n = 0; n < 300; n++) {
        const x = LAB_MIN_X + 1 + r() * (LAB_MAX_X - LAB_MIN_X - 2);
        const side = r() < 0.5 ? -1 : 1;
        const z = riverCenterZ(x) + side * (riverHalfWidth(x) + 0.05 + (r() - 0.35) * 0.9);
        const i = cellIndexX(x);
        const k = cellIndexZ(z);
        const top = groundTopCell(cellCenterX(i), cellCenterZ(k));
        const groundY = (top + 1) * GRID_SIZE;
        if (groundY < WATER_Y - 0.3 || groundY > WATER_Y + 0.35) continue;
        // heights in metres (0.1-0.55 m), converted to cells
        const h = Math.round((0.1 + r() * r() * 0.45) / GRID_SIZE);
        for (let j = 1; j <= h; j++) world.setStatic(i, top + j, k, voxel(M.Reed, (j + n) & 3), 1);
        if (h * GRID_SIZE >= 0.35 && r() < 0.35) {
            const head = Math.max(1, Math.round(0.08 / GRID_SIZE));
            for (let c = 1; c <= head; c++) world.setStatic(i, top + h + c, k, voxel(M.FurDark, 1), 1);
        }
        reeds++;
    }

    // ---- a scatter of tiny flowers on the near bank
    for (let n = 0; n < 45; n++) {
        const x = -12 + r() * 24;
        const z = 4.5 + r() * 8;
        const i = cellIndexX(x);
        const k = cellIndexZ(z);
        const top = groundTopCell(cellCenterX(i), cellCenterZ(k));
        world.setStatic(i, top + 1, k, voxel(M.Flower, r() < 0.3 ? 2 : 0), 1);
    }

    world.finalizeStatic();
    const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return { columns, staticCells: world.staticCellCount(), trees, rocks, reeds, stats, ms: t1 - t0 };
}
