/**
 * Data levels: a plain JSON description of a level (ground and its features, scenery pieces, trees,
 * rocks, props, spawn, goal, tutorial steps, sun, wind) turned into a LevelDef. The tutorial is one;
 * the level designer edits these and plays them. Pure module, no engine.
 */

import type { WindSpec } from '../fx/wind.ts';
import { GRID_SIZE } from '../voxels/grid.ts';
import { pose, quatFromYawPitchRoll, quatMul } from '../voxels/math.ts';
import type { Pose } from '../voxels/math.ts';
import { M, voxel } from '../voxels/palette.ts';
import { createRasterStats } from '../voxels/rasterizer.ts';
import { hash3, latticeShade } from '../voxels/volumes.ts';
import type { MaterialField } from '../voxels/volumes.ts';
import type { VoxelWorld } from '../voxels/world.ts';

import { fbm, oak, patchShade, pine, rasterizeTerrain, rock, smoothstep } from './common.ts';
import { rasterizePieces } from './level.ts';
import type { LevelBuildResult, LevelDef, LevelLayout, PieceShape, Rect, StaticPiece, TutorialStep } from './level.ts';

export const LEVEL_DATA_VERSION = 1;

/** Materials a data level may use, by name. */
export const MATERIAL_NAMES = {
    timber: M.Timber,
    'dark-timber': M.LogBark,
    stone: M.Rock,
    steel: M.Steel,
    'hi-vis': M.HiVis,
    stripe: M.HiVisStripe,
    grass: M.Grass,
    dirt: M.Dirt,
    path: M.Path,
    sand: M.Sand,
    moss: M.Moss,
    galvanised: M.Galvanised,
    leaf: M.Leaf,
    'leaf-gold': M.LeafGold,
    flower: M.Flower,
    test: M.TestOrange
} as const;
export type MaterialName = keyof typeof MATERIAL_NAMES;

export type GroundFeature =
    /** A trench between two points (steep walls; with water if `water`). */
    | { type: 'ditch'; x1: number; z1: number; x2: number; z2: number; width: number; depth: number }
    /** A rounded hill. */
    | { type: 'mound'; x: number; z: number; r: number; h: number }
    /** A flat area at a height (yards, pads, lanes). */
    | { type: 'flat'; rect: Rect; y: number }
    /** A surface material painted over a rect (paths, gravel). */
    | { type: 'paint'; rect: Rect; material: MaterialName };

export interface PieceData {
    shape: PieceShape;
    x: number;
    y: number;
    z: number;
    yaw?: number;
    pitch?: number;
    roll?: number;
    material: MaterialName;
    collide?: boolean;
    name?: string;
}

export interface LevelData {
    v: number;
    id: string;
    name: string;
    size: Rect;
    ground: { base: number; noise: number; seed: number };
    features: GroundFeature[];
    /** Water surface height, or absent for none (the plane is hidden far below). */
    waterY?: number;
    pieces: PieceData[];
    trees: { x: number; z: number; scale: number; yaw: number; kind?: 'pine' | 'oak' }[];
    rocks: { x: number; z: number; size: number; yaw: number }[];
    /** Dynamic props by entity name (plank, beam-0, log, cube, sphere, bucket, extra-plank-0, ...). */
    props: { name: string; x: number; z: number; lift?: number; yaw?: number; flat?: boolean }[];
    spawn: { x: number; z: number; yaw: number };
    goal?: Rect;
    objective?: string;
    steps?: TutorialStep[];
    sun?: { elevation: number; azimuth: number };
    wind?: WindSpec;
}

const FLAT_PITCH = Math.PI / 2;

/** Distance from a point to a segment. */
function segDist(px: number, pz: number, x1: number, z1: number, x2: number, z2: number): number {
    const dx = x2 - x1;
    const dz = z2 - z1;
    const l2 = dx * dx + dz * dz || 1e-9;
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (pz - z1) * dz) / l2));
    return Math.hypot(px - (x1 + dx * t), pz - (z1 + dz * t));
}

const inRect = (r: Rect, x: number, z: number) => x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ;

/** The ground height function of a data level. */
export function dataHeight(d: LevelData): (x: number, z: number) => number {
    const g = d.ground;
    return (x: number, z: number) => {
        let h = g.base + g.noise * (fbm(x * 0.12, z * 0.12, g.seed) - 0.5);
        for (const f of d.features) {
            if (f.type === 'flat') {
                const r = f.rect;
                // blend over 1 m around the rect
                const w =
                    smoothstep(r.minX - 1, r.minX, x) *
                    (1 - smoothstep(r.maxX, r.maxX + 1, x)) *
                    smoothstep(r.minZ - 1, r.minZ, z) *
                    (1 - smoothstep(r.maxZ, r.maxZ + 1, z));
                h = h + (f.y - h) * w;
            } else if (f.type === 'mound') {
                const dd = Math.hypot(x - f.x, z - f.z) / f.r;
                if (dd < 1) h += f.h * (0.5 + 0.5 * Math.cos(dd * Math.PI));
            }
        }
        // ditches last: they cut through everything
        for (const f of d.features) {
            if (f.type !== 'ditch') continue;
            const dd = segDist(x, z, f.x1, f.z1, f.x2, f.z2);
            const half = f.width / 2;
            if (dd < half + 0.25) h -= f.depth * (1 - smoothstep(half, half + 0.25, dd));
        }
        return h;
    };
}

/** True inside any ditch (where a fallen player is "in the ditch"). */
function inDitch(d: LevelData, x: number, z: number): boolean {
    return d.features.some((f) => f.type === 'ditch' && segDist(x, z, f.x1, f.z1, f.x2, f.z2) < f.width / 2 + 0.6);
}

function pieceField(m: MaterialName, seed: number): MaterialField {
    const mat = MATERIAL_NAMES[m] ?? M.Timber;
    if (mat === M.Timber || mat === M.LogBark) return (x, y, z) => voxel(mat, latticeShade(x, y, z, 0.15, seed) & 3);
    if (mat === M.Rock) return (x, y, z) => voxel(mat, latticeShade(x, y, z, 0.2, seed));
    return () => voxel(mat, 0);
}

export function dataLayout(d: LevelData): LevelLayout {
    const height = dataHeight(d);
    return {
        trees: d.trees.map((t) => ({ ...t })),
        rocks: d.rocks.map((r, i) => ({
            x: r.x,
            z: r.z,
            rx: r.size * 1.2,
            ry: r.size * 0.75,
            rz: r.size,
            yaw: r.yaw + i * 0
        })),
        pieces: d.pieces.map((p, i): StaticPiece => {
            const ground = height(p.x, p.z);
            return {
                name: p.name ?? `piece-${i}`,
                shape: p.shape,
                // piece y is relative to the ground under it, so pieces follow terrain edits
                pose: pose(p.x, ground + p.y, p.z, quatFromYawPitchRoll(p.yaw ?? 0, p.pitch ?? 0, p.roll ?? 0)),
                field: pieceField(p.material, i + 1),
                collide: p.collide ?? true,
                priority: 3
            };
        })
    };
}

export function buildDataLevel(d: LevelData, world: VoxelWorld, seed = 1): LevelBuildResult {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const stats = createRasterStats();
    const height = dataHeight(d);
    const topCell = (x: number, z: number) => Math.floor(height(x, z) / GRID_SIZE - 1e-9);
    const paints = d.features.filter((f): f is Extract<GroundFeature, { type: 'paint' }> => f.type === 'paint');
    const surface = (x: number, z: number, top: number) => {
        const shade = patchShade(x, z, 1.4, d.ground.seed + 5);
        for (const p of paints) if (inRect(p.rect, x, z)) return voxel(MATERIAL_NAMES[p.material] ?? M.Path, shade);
        if (inDitch(d, x, z) && (top + 1) * GRID_SIZE < d.ground.base - 0.2) return voxel(M.Dirt, shade);
        return voxel(fbm(x * 0.2, z * 0.2, d.ground.seed + 9) > 0.62 ? M.GrassDry : M.Grass, shade);
    };
    const side = (depth: number, j: number) =>
        voxel(depth * GRID_SIZE <= 0.25 ? M.Dirt : M.Rock, hash3(Math.floor((j * GRID_SIZE) / 0.1), 0, 0, 5) & 3);
    const s = d.size;
    const columns = rasterizeTerrain(world, {
        minX: s.minX,
        maxX: s.maxX,
        minZ: s.minZ,
        maxZ: s.maxZ,
        cutBaseY: d.ground.base - 2.5,
        topCell,
        surface,
        side: (depth, j) => side(depth, j)
    });
    const layout = dataLayout(d);
    let trees = 0;
    for (const t of layout.trees) {
        const base = (topCell(t.x, t.z) + 1) * GRID_SIZE;
        if (t.kind === 'oak') oak(world, t.x, t.z, base, t.scale, t.yaw, stats, trees + seed * 19);
        else pine(world, t.x, t.z, base, t.scale, t.yaw, stats, trees + seed * 19);
        trees++;
    }
    let rocks = 0;
    for (const k of layout.rocks) {
        rock(world, k.x, k.z, (topCell(k.x, k.z) + 1) * GRID_SIZE, k.rx, k.ry, k.rz, k.yaw, stats, rocks + 7);
        rocks++;
    }
    rasterizePieces(world, layout.pieces, stats);
    world.finalizeStatic();
    const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return { columns, staticCells: world.staticCellCount(), trees, rocks, reeds: 0, stats, ms: t1 - t0 };
}

/** Validates and normalizes untrusted level JSON (imports, local storage). Throws on garbage. */
export function parseLevelData(json: unknown): LevelData {
    const o = json as Partial<LevelData>;
    if (!o || typeof o !== 'object' || o.v !== LEVEL_DATA_VERSION) throw new Error('not a level file (version)');
    const num = (v: unknown, lo: number, hi: number, d = 0) =>
        typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;
    const rect = (r: unknown, d: Rect): Rect => {
        const q = (r ?? {}) as Partial<Rect>;
        return {
            minX: num(q.minX, -60, 60, d.minX),
            maxX: num(q.maxX, -60, 60, d.maxX),
            minZ: num(q.minZ, -60, 60, d.minZ),
            maxZ: num(q.maxZ, -60, 60, d.maxZ)
        };
    };
    const size = rect(o.size, { minX: -28, maxX: 28, minZ: -42, maxZ: 14 });
    const arr = <T>(v: unknown, max: number): T[] => (Array.isArray(v) ? (v.slice(0, max) as T[]) : []);
    const mat = (m: unknown): MaterialName =>
        typeof m === 'string' && m in MATERIAL_NAMES ? (m as MaterialName) : 'timber';
    const shape = (s: unknown): PieceShape => {
        const q = (s ?? {}) as Record<string, unknown>;
        if (q.type === 'cylinder')
            return {
                type: 'cylinder',
                axis: q.axis === 'x' || q.axis === 'z' ? q.axis : 'y',
                r: num(q.r, 0.05, 6, 0.2),
                half: num(q.half, 0.05, 10, 0.5)
            };
        if (q.type === 'ellipsoid')
            return {
                type: 'ellipsoid',
                rx: num(q.rx, 0.05, 6, 0.5),
                ry: num(q.ry, 0.05, 6, 0.5),
                rz: num(q.rz, 0.05, 6, 0.5)
            };
        return {
            type: 'box',
            hx: num(q.hx, 0.025, 10, 0.5),
            hy: num(q.hy, 0.025, 10, 0.5),
            hz: num(q.hz, 0.025, 10, 0.5)
        };
    };
    const features: GroundFeature[] = [];
    for (const f of arr<Record<string, unknown>>(o.features, 200)) {
        if (f.type === 'ditch')
            features.push({
                type: 'ditch',
                x1: num(f.x1, -60, 60),
                z1: num(f.z1, -60, 60),
                x2: num(f.x2, -60, 60),
                z2: num(f.z2, -60, 60),
                width: num(f.width, 0.3, 12, 2),
                depth: num(f.depth, 0.1, 4, 1)
            });
        else if (f.type === 'mound')
            features.push({
                type: 'mound',
                x: num(f.x, -60, 60),
                z: num(f.z, -60, 60),
                r: num(f.r, 0.5, 30, 4),
                h: num(f.h, -5, 12, 1)
            });
        else if (f.type === 'flat')
            features.push({
                type: 'flat',
                rect: rect(f.rect, { minX: -2, maxX: 2, minZ: -2, maxZ: 2 }),
                y: num(f.y, -5, 12, 0.3)
            });
        else if (f.type === 'paint')
            features.push({
                type: 'paint',
                rect: rect(f.rect, { minX: -2, maxX: 2, minZ: -2, maxZ: 2 }),
                material: mat(f.material)
            });
    }
    const g = (o.ground ?? {}) as Partial<LevelData['ground']>;
    const sp = (o.spawn ?? {}) as Partial<LevelData['spawn']>;
    return {
        v: LEVEL_DATA_VERSION,
        id: typeof o.id === 'string' && /^[a-z0-9-]{1,32}$/.test(o.id) ? o.id : 'custom',
        name: typeof o.name === 'string' ? o.name.slice(0, 48) : 'Custom level',
        size,
        ground: {
            base: num(g.base, -5, 10, 0.3),
            noise: num(g.noise, 0, 4, 0.3),
            seed: Math.trunc(num(g.seed, 0, 1e6, 1))
        },
        features,
        waterY: typeof o.waterY === 'number' ? num(o.waterY, -5, 10) : undefined,
        pieces: arr<Record<string, unknown>>(o.pieces, 600).map((p) => ({
            shape: shape(p.shape),
            x: num(p.x, -60, 60),
            y: num(p.y, -5, 20),
            z: num(p.z, -60, 60),
            yaw: num(p.yaw, -10, 10),
            pitch: num(p.pitch, -10, 10),
            roll: num(p.roll, -10, 10),
            material: mat(p.material),
            collide: p.collide !== false,
            name: typeof p.name === 'string' ? p.name.slice(0, 32) : undefined
        })),
        trees: arr<Record<string, unknown>>(o.trees, 200).map((t) => ({
            x: num(t.x, -60, 60),
            z: num(t.z, -60, 60),
            scale: num(t.scale, 0.4, 2.5, 1),
            yaw: num(t.yaw, -10, 10),
            kind: t.kind === 'oak' ? 'oak' : 'pine'
        })),
        rocks: arr<Record<string, unknown>>(o.rocks, 100).map((r) => ({
            x: num(r.x, -60, 60),
            z: num(r.z, -60, 60),
            size: num(r.size, 0.15, 3, 0.5),
            yaw: num(r.yaw, -10, 10)
        })),
        props: arr<Record<string, unknown>>(o.props, 40)
            .filter((p) => typeof p.name === 'string')
            .map((p) => ({
                name: String(p.name).slice(0, 32),
                x: num(p.x, -60, 60),
                z: num(p.z, -60, 60),
                lift: num(p.lift, -1, 10, 0),
                yaw: num(p.yaw, -10, 10),
                flat: p.flat === true
            })),
        spawn: { x: num(sp.x, -60, 60), z: num(sp.z, -60, 60), yaw: num(sp.yaw, -10, 10) },
        goal: o.goal ? rect(o.goal, { minX: -2, maxX: 2, minZ: -2, maxZ: 2 }) : undefined,
        objective: typeof o.objective === 'string' ? o.objective.slice(0, 120) : undefined,
        steps: Array.isArray(o.steps) ? (o.steps.slice(0, 20) as TutorialStep[]) : undefined,
        sun: o.sun
            ? { elevation: num(o.sun.elevation, -4, 80, 20), azimuth: num(o.sun.azimuth, 0, 360, 120) }
            : undefined,
        wind: o.wind
            ? { dir: num(o.wind.dir, -10, 10), base: num(o.wind.base, 0, 15, 1), gust: num(o.wind.gust, 0, 20, 2) }
            : undefined
    };
}

/** Rest heights of the props (centre above the ground) for placing them. */
const PROP_LIFT: Record<string, number> = {
    plank: 0.06,
    beam: 0.08,
    log: 0.22,
    cube: 0.26,
    sphere: 0.31,
    bucket: 0.01
};
function propLift(name: string): number {
    if (name.includes('plank')) return PROP_LIFT.plank;
    if (name.startsWith('beam')) return PROP_LIFT.beam;
    if (name.includes('log')) return PROP_LIFT.log;
    return PROP_LIFT[name] ?? 0.3;
}

/** A playable level from data. */
export function levelFromData(d: LevelData): LevelDef {
    const height = dataHeight(d);
    const s = d.size;
    // turn about Y, then lay flat (planks and beams on their wide face): composed explicitly
    const at = (x: number, z: number, lift: number, yaw = 0, flat = false): Pose =>
        pose(
            x,
            height(x, z) + lift,
            z,
            quatMul(quatFromYawPitchRoll(yaw, 0, 0), quatFromYawPitchRoll(0, flat ? FLAT_PITCH : 0, 0))
        );
    const waterY = d.waterY ?? -20;
    const steps = d.steps;
    return {
        id: d.id,
        name: d.name,
        bounds: s,
        playArea: { minX: s.minX + 2, maxX: s.maxX - 2, minZ: s.minZ + 2, maxZ: s.maxZ - 2 },
        water: {
            y: waterY,
            cx: (s.minX + s.maxX) / 2,
            cz: (s.minZ + s.maxZ) / 2,
            halfX: (s.maxX - s.minX) / 2,
            halfZ: (s.maxZ - s.minZ) / 2
        },
        terrainHeight: height,
        layout: () => dataLayout(d),
        build: (world, seed) => buildDataLevel(d, world, seed),
        sun: d.sun ?? { elevation: 24, azimuth: 120 },
        wind: d.wind,
        spawn: { x: d.spawn.x, z: d.spawn.z, yaw: d.spawn.yaw, pitch: -0.08 },
        orbitHome: {
            pos: [d.spawn.x + 6, height(d.spawn.x, d.spawn.z) + 4, d.spawn.z + 8],
            focus: [d.spawn.x, height(d.spawn.x, d.spawn.z) + 0.5, d.spawn.z - 6]
        },
        startFirstPerson: true,
        actors: { beaver: { mode: 'none' }, ute: { mode: 'none' } },
        props: d.props.map((p) => ({
            name: p.name,
            pose: at(
                p.x,
                p.z,
                p.lift || propLift(p.name),
                p.yaw ?? 0,
                p.flat ?? (p.name.includes('plank') || p.name.startsWith('beam'))
            )
        })),
        rules: {
            objective: d.objective ?? (d.goal ? 'Get the bucket to the goal' : 'Explore'),
            goal: d.goal ?? { minX: 1e6, maxX: 1e6 + 1, minZ: 1e6, maxZ: 1e6 + 1 },
            fallY: Math.min(
                ...d.features
                    .filter((f) => f.type === 'ditch')
                    .map((f) => d.ground.base - (f as { depth: number }).depth * 0.6),
                d.ground.base - 3
            ),
            isSafe: (x, z) => !inDitch(d, x, z),
            lostY: Math.max(waterY + 0.15, d.ground.base - 4),
            steps
        },
        scriptedProps: false,
        data: d
    };
}
