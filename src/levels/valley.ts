/**
 * The Valley — the whole journey as one continuous map (design doc §3.1; owner request: "the rest
 * of the levels, one big map"). Seven areas along one road, from the Timber Yard to the flower:
 *
 *   1 Timber Yard          take the bucket from its stump down to the old bridge
 *   2 Shallow Creek        bridge the collapsed footbridge (2.6 m)
 *   3 Forest Road          carry long beams from the log dump over the washed-out culvert (2.7 m)
 *   4 Gorge                two spans to an old stone pier in the middle (2 x 2.2 m)
 *   5 Old Industrial Works stack crates to get up the 1.5 m retaining wall
 *   6 Mountain Approach    bridge the crevasse across the switchback road (2.6 m)
 *   7 Flower Summit        set the bucket down by the flower
 *
 * Each crossing runs right across the map, so the only way on is to build. The bucket is a shared,
 * essential item: lost, it comes back at the last checkpoint reached.
 *
 * The map is 224 m square, too big to hold in 5 cm voxels at once: it is streamed in tiles around the
 * cameras, and a coarse far lattice shows the rest (LevelDef.stream). The start is the Timber Yard
 * itself (same ground, pieces and props), turned 45 degrees to face up the valley.
 *
 * Route frame: u runs along the route from the creek crossing (u = 0) to the summit (u = 202), t
 * across it. Pieces placed in the route frame have local +x across (t) and local -z up the route
 * (u), like the Timber Yard's own frame.
 *
 * Pure module (no engine).
 */

import { GRID_SIZE, cellCenterX, cellCenterZ, cellIndexX, cellIndexZ } from '../voxels/grid.ts';
import { pose, quatFromYawPitchRoll, quatMul } from '../voxels/math.ts';
import type { Pose } from '../voxels/math.ts';
import { M, voxel } from '../voxels/palette.ts';
import { createRasterStats } from '../voxels/rasterizer.ts';
import type { RasterStats } from '../voxels/rasterizer.ts';
import { grain, hash3, latticeShade, solid } from '../voxels/volumes.ts';
import type { MaterialField } from '../voxels/volumes.ts';
import type { ColumnRect, VoxelWorld } from '../voxels/world.ts';

import {
    OAK,
    PINE_TIERS,
    fbm,
    lerp,
    oak,
    patchShade,
    pine,
    rasterizeTerrain,
    rasterizeTerrainTile,
    rng,
    rock,
    smoothstep
} from './common.ts';
import type { RockSpot, TerrainSpec, TreeSpot } from './common.ts';
import { STAND_CROWN_RADIUS, drawStandTree } from './forestry.ts';
import type { ForestryDef } from './forestry.ts';
import { pieceVolume } from './level.ts';
import type { LevelBuildResult, LevelDef, LevelLayout, LevelStage, PropPlacement, Rect, StaticPiece } from './level.ts';
import { routeSign } from './route-signs.ts';
import { nearestPath } from './side-paths.ts';
import type { SidePath } from './side-paths.ts';
import {
    BRIDGE_X,
    BUCKET_STUMP,
    CREEK_BED_Y,
    CREEK_WATER_Y,
    WINDSOCK,
    YARD_Y,
    creekCenterZ,
    creekHalfWidth,
    yardHeight,
    YARD_FORESTRY,
    yardLayout,
    yardPieces,
    yardProps,
    yardSideMaterial,
    yardSurfaceMaterial
} from './timber-yard.ts';

// ------------------------------------------------------------------------------- the route frame

const S2 = Math.SQRT1_2;
/** The creek crossing (the Timber Yard's old bridge), in world coordinates. */
export const ORIGIN = { x: -64, z: 62 };
export const VALLEY_BOUNDS = { minX: -112, maxX: 112, minZ: -112, maxZ: 112 };

export const routeU = (x: number, z: number) => (x - ORIGIN.x - (z - ORIGIN.z)) * S2;
export const routeT = (x: number, z: number) => (x - ORIGIN.x + (z - ORIGIN.z)) * S2;
export function routeToWorld(u: number, t: number): { x: number; z: number } {
    return { x: ORIGIN.x + (u + t) * S2, z: ORIGIN.z + (t - u) * S2 };
}
/** Turns the route frame (and the Timber Yard's frame) into the world. */
export const ROUTE_YAW = -Math.PI / 4;
const ROUTE_Q = quatFromYawPitchRoll(ROUTE_YAW, 0, 0);

/** Timber Yard frame (x along the creek, z towards the yard) to route coordinates. */
const yardU = (z: number) => -(z - creekCenterZ(BRIDGE_X));
const yardT = (x: number) => x - BRIDGE_X;
export function yardToWorld(x: number, z: number): { x: number; z: number } {
    return routeToWorld(yardU(z), yardT(x));
}
/** A pose in the Timber Yard's frame, in the world. */
function fromYard(p: Pose): Pose {
    const w = yardToWorld(p.p.x, p.p.z);
    const out = pose(w.x, p.p.y, w.z);
    quatMul(ROUTE_Q, p.q, out.q);
    return out;
}

// ------------------------------------------------------------------------------- the crossings

/** The creek is the Timber Yard's creek, carried on across the valley. */
const creekU = (t: number) => yardU(creekCenterZ(t + BRIDGE_X));
const creekHW = (t: number) => creekHalfWidth(t + BRIDGE_X);
/** The washed-out culvert on the forest road. */
export const DITCH = { u: 40, hw: 1.2 };
const ditchU = (t: number) => DITCH.u + 0.6 * Math.sin(0.11 * t);
/** The gorge, with the old stone pier in the middle of the crossing. */
export const GORGE = { u: 85, hw: 2.8, pierHalfU: 0.6, pierHalfT: 1.3 };
const gorgeU = (t: number) => GORGE.u + 1.2 * Math.sin(0.06 * t);
/** The works' retaining wall: the lower yard at 3.8 m, the upper at 5.3 m. */
export const WALL = { u: 118, low: 3.8, high: 5.3 };
/** The crevasse across the mountain road. */
export const CREVASSE = { u: 170, hw: 1.2, bed: -0.35 };
const crevasseU = (t: number) => CREVASSE.u + 0.8 * Math.sin(0.07 * t);
/** The flower on the summit. */
export const SUMMIT_U = 202;

interface Channel {
    centre: (t: number) => number;
    hw: (t: number) => number;
    bed: number;
}
const CHANNELS: Channel[] = [
    { centre: creekU, hw: creekHW, bed: CREEK_BED_Y },
    { centre: ditchU, hw: () => DITCH.hw, bed: CREEK_BED_Y },
    { centre: gorgeU, hw: () => GORGE.hw, bed: CREEK_BED_Y },
    { centre: crevasseU, hw: () => CREVASSE.hw, bed: CREVASSE.bed }
];

/** Distance (in u) from (u, t) to the nearest crossing's edge (negative inside it). */
function channelEdge(u: number, t: number): number {
    let d = Infinity;
    for (const c of CHANNELS) d = Math.min(d, Math.abs(u - c.centre(t)) - c.hw(t));
    return d;
}

// ------------------------------------------------------------------------------- the road

/** Across-route offset of the road's centre line. */
export function roadT(u: number): number {
    if (u > 4 && u < 82) return 2.5 * Math.sin((u - 4) * 0.07) * smoothstep(4, 12, u) * (1 - smoothstep(74, 82, u));
    if (u > 140 && u < 192)
        return 4 * Math.sin((u - 140) * 0.09) * smoothstep(140, 148, u) * (1 - smoothstep(184, 192, u));
    return 0;
}

/** Height of the road (and the valley floor) along the route. */
function floorY(u: number, t: number): number {
    // the mountain climbs in two pitches with a level bench at the crevasse (both lips the same height)
    const climb = 0.55 * smoothstep(142, 164, u) + 0.45 * smoothstep(176, 192, u);
    if (u >= WALL.u) return WALL.high + 7.2 * climb - 3 * smoothstep(214, 244, u);
    if (u >= gorgeU(t)) return WALL.low;
    if (u >= -16) return 0.5 + 3.3 * smoothstep(6, 80, u);
    return 0.5 + 0.6 * smoothstep(-16, -24, u);
}

/** The works' yards: flat ground either side of the road. */
function worksWeight(u: number, a: number): number {
    return smoothstep(88, 92, u) * (1 - smoothstep(139, 143, u)) * (1 - smoothstep(16, 22, a));
}

/** How much of the Timber Yard's own ground applies at (u, t). */
function yardBlend(u: number, t: number): number {
    return (1 - smoothstep(21, 26, Math.abs(t))) * (1 - smoothstep(2.5, 6, u)) * smoothstep(-18, -15.5, u);
}

/**
 * Side paths off the road (side-paths.ts): the old logging track loops off the forest road and back
 * before the culvert (somewhere to go when the road is closed; wide enough for the ute), and a track
 * climbs from past the culvert to the foot of the fire lookout, stopping short of its legs.
 */
export const SIDE_PATHS: SidePath[] = [
    {
        name: 'logging-track',
        points: [
            [11, roadT(11) + 2.2],
            [15, 8.5],
            [21, 12.5],
            [28, 13],
            [33, 9.5],
            [35.5, roadT(35.5) + 2.2]
        ],
        halfWidth: 1.6
    },
    {
        name: 'lookout-track',
        points: [
            [48, roadT(48) + 2.2],
            [51, 9],
            [54, 15],
            [56, 19.2]
        ],
        halfWidth: 1.4
    }
];

/** Continuous ground height in the route frame. */
function heightUT(u: number, t: number, paths = true): number {
    let y = naturalUT(u, t);
    // side paths: graded flat across to their centre line's own height
    const hit = paths ? nearestPath(SIDE_PATHS, u, t, 3.2) : null;
    const pathW = hit ? 1 - smoothstep(hit.path.halfWidth, hit.path.halfWidth + 1.6, hit.d) : 0;
    if (hit && pathW > 0) y = lerp(y, naturalUT(hit.u, hit.t), pathW);
    // the valley sides are terraced into 0.3 m benches (as in the Timber Yard): fewer triangles
    const terrace = smoothstep(12, 16, Math.abs(t - roadT(u))) * (1 - yardBlend(u, t)) * (1 - pathW);
    if (terrace > 0) y = lerp(y, Math.floor(y / 0.3) * 0.3 + 1e-3, terrace);
    // the crossings, cut right across the valley with steep walls
    for (const c of CHANNELS) {
        const d = Math.abs(u - c.centre(t));
        const hw = c.hw(t);
        if (d < hw) return c.bed + 0.15 * smoothstep(0, hw * 0.8, d);
        if (d < hw + 0.3) y = lerp(c.bed + 0.15, y, smoothstep(hw, hw + 0.3, d));
    }
    return y;
}

/** Ground height before terraces, side paths and the crossings. */
function naturalUT(u: number, t: number): number {
    const rt = roadT(u);
    const a = Math.abs(t - rt);
    const f = floorY(u, t);
    // the valley sides: higher further up the valley, lower and gentler by the yard
    const H = u < 0 ? 3 : u < 90 ? 5 : u < 142 ? 7 : 5;
    let y =
        f +
        smoothstep(9, 42, a) * H * (0.55 + 0.9 * fbm(u * 0.03, t * 0.03, 21)) +
        smoothstep(4, 14, a) * 1.2 * (fbm(u * 0.08, t * 0.08, 7) - 0.3) +
        0.22 * smoothstep(2.5, 5, a) * (fbm(u * 0.15, t * 0.15, 11) - 0.5);
    // the summit mound, and the high ground around it
    y += 1.8 * Math.exp(-((u - SUMMIT_U) ** 2 + t * t) / 40);
    y += 3 * smoothstep(150, 200, u) * smoothstep(10, 34, a);
    // the road is graded flat across
    y = lerp(f, y, smoothstep(1.8, 3.4, a));
    // the works' yards are levelled
    const w = worksWeight(u, a);
    if (w > 0) y = lerp(y, f, w);
    // the Timber Yard's own ground at the start
    const yb = yardBlend(u, t);
    if (yb > 0) y = lerp(y, yardHeight(t + BRIDGE_X, creekCenterZ(BRIDGE_X) - u), yb);
    return y;
}

export function valleyHeight(x: number, z: number): number {
    return heightUT(routeU(x, z), routeT(x, z));
}

/** The ground as it would be without the side paths' grading (tests: what the grading changed). */
export function valleyHeightUngraded(x: number, z: number): number {
    return heightUT(routeU(x, z), routeT(x, z), false);
}

const topCell = (x: number, z: number) => Math.floor(valleyHeight(x, z) / GRID_SIZE - 1e-9);
const surfaceY = (x: number, z: number) => (topCell(x, z) + 1) * GRID_SIZE;

function surfaceMaterial(x: number, z: number, top: number, grad: number): number {
    const u = routeU(x, z);
    const t = routeT(x, z);
    if (yardBlend(u, t) > 0.5) return yardSurfaceMaterial(t + BRIDGE_X, creekCenterZ(BRIDGE_X) - u, top);
    const y = (top + 1) * GRID_SIZE;
    const a = Math.abs(t - roadT(u));
    const shade = patchShade(x, z, a < 12 ? 1.4 : 3.5, 71);
    for (const c of CHANNELS) {
        if (Math.abs(u - c.centre(t)) < c.hw(t)) {
            if (c.bed > CREEK_WATER_Y) return voxel(M.HillRock, shade & 1);
            return voxel(fbm(x * 0.5, z * 0.5, 3) > 0.55 ? M.Pebble : M.Sand, shade);
        }
    }
    const mountain = u > 142;
    if (a > 3) {
        if (grad > 1.5) return voxel(mountain || u > 88 ? M.HillRock : M.Rock, shade & 1);
    }
    if (a < 1.6) return voxel(u > 88 && u < 142 ? M.Concrete : M.Path, shade);
    const side = nearestPath(SIDE_PATHS, u, t, 1.4);
    if (side && side.d < side.path.halfWidth - 0.45 + 0.25 * fbm(x * 0.6, z * 0.6, 17))
        return voxel(fbm(x * 0.4, z * 0.4, 19) > 0.62 ? M.GrassDry : M.Path, shade);
    if (worksWeight(u, a) > 0.5)
        return voxel(fbm(x * 0.2, z * 0.2, 13) > 0.6 ? M.Pebble : M.Concrete, shade & 1 ? 1 : 3);
    if (mountain) return voxel(y > 13.2 && a > 5 ? M.Snow : M.HillGrass, shade);
    if (u > 88) return voxel(M.HillGrass, shade);
    if (fbm(x * 0.2, z * 0.2, 41) > 0.64) return voxel(M.GrassDry, shade);
    if (fbm(x * 0.12, z * 0.12, 43) > 0.68) return voxel(M.Moss, shade);
    return voxel(M.Grass, shade);
}

function sideMaterial(depth: number, j: number, z: number, x: number): number {
    const u = routeU(x, z);
    const t = routeT(x, z);
    if (yardBlend(u, t) > 0.5) return yardSideMaterial(depth, j, creekCenterZ(BRIDGE_X) - u);
    const strata = hash3(Math.floor((j * GRID_SIZE) / 0.1), 0, 0, 5) & 3;
    // the retaining wall is concrete where the road meets it
    if (Math.abs(u - WALL.u) < 0.5 && Math.abs(t) < 14) return voxel(M.Concrete, strata & 1);
    if (u > 142 && depth * GRID_SIZE <= 0.25) return voxel(M.HillGrass, 1);
    if (depth * GRID_SIZE <= 0.2) return voxel(M.Dirt, strata);
    return voxel(u > 88 ? M.HillRock : M.Rock, strata);
}

export const VALLEY_TERRAIN: TerrainSpec = {
    ...VALLEY_BOUNDS,
    cutBaseY: -2.5,
    topCell,
    surface: surfaceMaterial,
    side: sideMaterial
};

// ------------------------------------------------------------------------------- pieces

const stone =
    (seed: number): MaterialField =>
    (x, y, z) =>
        voxel(M.Rock, latticeShade(x, y, z, 0.2, seed));
const darkTimber: MaterialField = (x, y, z) => voxel(M.LogBark, latticeShade(x, y, z, 0.2, 6) & 1);
const brick: MaterialField = (x, y, z) =>
    voxel(M.Brick, (Math.floor(y / 0.1) + Math.floor((x + z) / 0.25)) & 1 ? latticeShade(x, y, z, 0.3, 3) & 1 : 2);
const concrete: MaterialField = (x, y, z) => voxel(M.Concrete, latticeShade(x, y, z, 0.4, 9) & 3);
const rust: MaterialField = (x, y, z) => voxel(M.Rust, latticeShade(x, y, z, 0.3, 12) & 3);
const crane: MaterialField = (x, y, z) => voxel(M.HardHat, latticeShade(x, y, z, 0.4, 2) & 1);

type Shape = StaticPiece['shape'];
const boxS = (hx: number, hy: number, hz: number): Shape => ({ type: 'box', hx, hy, hz });

/** A piece placed in the route frame (local +x across the route, local -z up it). */
function piece(
    name: string,
    shape: Shape,
    u: number,
    y: number,
    t: number,
    field: MaterialField,
    opts: { yaw?: number; pitch?: number; roll?: number; collide?: boolean; priority?: number } = {}
): StaticPiece {
    const w = routeToWorld(u, t);
    return {
        name,
        shape,
        pose: pose(w.x, y, w.z, quatFromYawPitchRoll(ROUTE_YAW + (opts.yaw ?? 0), opts.pitch ?? 0, opts.roll ?? 0)),
        field,
        collide: opts.collide ?? true,
        priority: opts.priority ?? 2
    };
}

const groundUT = (u: number, t: number) => heightUT(u, t);

/** A checkpoint flag: a pole and a chequered flag, coloured per stage. */
function flag(u: number, t: number, colour: number): StaticPiece[] {
    const y = groundUT(u, t);
    return [
        piece('flag-pole', boxS(0.04, 1.2, 0.04), u, y + 1.2, t, solid(M.Steel, 1)),
        piece(
            'flag',
            boxS(0.35, 0.2, 0.02),
            u,
            y + 2.15,
            t + 0.39,
            (x, yy) =>
                voxel((Math.floor((x + 0.35) / 0.1) + Math.floor((yy + 0.2) / 0.1)) & 1 ? colour : M.HiVisStripe, 0),
            { priority: 3 }
        )
    ];
}

/**
 * The route sign at an area's start: the area's number and the way on, on a band of its colour,
 * beside the road facing players coming up it (route-signs.ts). The board is axis-aligned (the route
 * runs at 45 degrees), turned to face down the road and across it.
 */
function signpost(u: number, t: number, stage: number): StaticPiece[] {
    const w = routeToWorld(u, t);
    // the road bends ahead: the arrow bears that way (+t is to the reader's right)
    const ahead = roadT(u + 14) - roadT(u);
    const arrow = ahead > 1.5 ? 'right' : ahead < -1.5 ? 'left' : 'up';
    // left of the road its face looks along +z (down the route and across); right of it, along -x
    return routeSign({ x: w.x, y: groundUT(u, t), z: w.z }, t < roadT(u) ? 0 : 3, {
        number: stage + 1,
        arrow,
        colour: STAGE_COLOURS[stage]
    });
}

/** Checkpoint centres (route frame), one per stage. */
export const CHECKPOINTS = [
    { u: -4.8, t: -3.4 }, // 1: by the old bridge (yard side)
    { u: 5.4, t: 0 }, // 2: the far bank (the Timber Yard's own goal)
    { u: 46, t: roadT(46) }, // 3: past the culvert
    { u: 93, t: 0 }, // 4: across the gorge
    { u: 124, t: 0 }, // 5: the works' upper yard
    { u: 174.2, t: roadT(174.2) }, // 6: past the crevasse, on the level bench
    { u: SUMMIT_U, t: 0 } // 7: the flower
];
export const STAGE_COLOURS = [M.HiVis, M.TestOrange, M.Grass, M.TestBlue, M.Brick, M.Snow, M.Flower];

function valleyPieces(): StaticPiece[] {
    const P: StaticPiece[] = [];
    // ---- 1-2: the Timber Yard and the old bridge, as they are (the summit flower moves up here)
    for (const p of yardPieces()) {
        if (p.name.startsWith('flower')) continue;
        P.push({ ...p, pose: fromYard(p.pose) });
    }
    P.push(...flag(CHECKPOINTS[0].u, CHECKPOINTS[0].t - 1.6, STAGE_COLOURS[0]));

    // ---- 3: the forest road and the washed-out culvert
    const du = DITCH.u;
    const dt = roadT(du);
    // the broken culvert pipe in the stream, and the old road edge posts
    P.push(
        piece('culvert-pipe', { type: 'cylinder', axis: 'x', r: 0.45, half: 1.4 }, du, -0.55, dt + 2.6, concrete, {
            yaw: 0.25,
            roll: 0.2
        })
    );
    for (const side of [-1, 1]) {
        P.push(
            piece(
                'culvert-post',
                boxS(0.06, 0.55, 0.06),
                du - side * 2.0,
                groundUT(du - side * 2, dt - 1.9) + 0.55,
                dt - 1.9,
                solid(M.HiVis, 0)
            )
        );
        P.push(
            piece(
                'culvert-post',
                boxS(0.06, 0.55, 0.06),
                du - side * 2.0,
                groundUT(du - side * 2, dt + 1.9) + 0.55,
                dt + 1.9,
                solid(M.HiVis, 0)
            )
        );
    }
    // the log dump where the long beams wait, with a stack of logs (scenery)
    const lu = 24;
    const lt = roadT(lu) + 4.6;
    for (let n = 0; n < 3; n++)
        P.push(
            piece(
                'dump-log',
                { type: 'cylinder', axis: 'z', r: 0.22, half: 1.6 },
                lu - 1.2,
                groundUT(lu - 1.2, lt) + 0.22 + (n === 2 ? 0.38 : 0),
                lt - 0.5 + (n === 2 ? 0.22 : n * 0.45),
                darkTimber
            )
        );
    P.push(...signpost(8, roadT(8) - 2.4, 2));
    P.push(...flag(CHECKPOINTS[2].u, CHECKPOINTS[2].t - 2.2, STAGE_COLOURS[2]));

    // ---- 4: the gorge, its stone pier and a waterfall from the works' outfall
    const gu = GORGE.u;
    const rim = WALL.low;
    P.push(
        piece(
            'gorge-pier',
            boxS(GORGE.pierHalfT, (rim - CREEK_BED_Y) / 2, GORGE.pierHalfU),
            gu,
            (rim + CREEK_BED_Y) / 2,
            0,
            stone(11),
            { priority: 3 }
        )
    );
    P.push(
        piece('pier-cap', boxS(GORGE.pierHalfT + 0.05, 0.05, GORGE.pierHalfU + 0.05), gu, rim + 0.05, 0, stone(13), {
            priority: 3
        })
    );
    for (const side of [-1, 1]) {
        const eu = gu + side * (GORGE.hw + 0.25);
        P.push(piece('gorge-cap', boxS(1.4, 0.06, 0.25), eu, rim + 0.06, 0, stone(15 + side), { priority: 3 }));
    }
    // the old trestle's remains hanging off the far rim
    P.push(piece('trestle-snapped', boxS(0.1, 0.1, 1.3), gu + 2.3, rim - 1.0, 0.8, darkTimber, { pitch: 0.9 }));
    P.push(piece('trestle-leg', boxS(0.09, 2.0, 0.09), gu - 1.6, 0.5, -1.5, darkTimber, { roll: 0.35 }));
    // the outfall: a concrete pipe end in the far wall, and the water falling from it
    const { u: wu, t: wt } = waterfallSpot();
    P.push(
        piece('outfall', { type: 'cylinder', axis: 'z', r: 0.7, half: 0.6 }, wu + 0.3, rim - 0.6, wt, concrete, {
            priority: 3
        })
    );
    P.push(
        piece(
            'waterfall',
            boxS(0.55, (rim - 0.6 - CREEK_WATER_Y) / 2, 0.12),
            wu - 0.35,
            (rim - 0.6 + CREEK_WATER_Y) / 2,
            wt,
            (x, y, z) => voxel(M.Splash, latticeShade(x, y * 0.3, z, 0.15, 21) & 3),
            { collide: false, priority: 3 }
        )
    );
    P.push(
        piece(
            'waterfall-foam',
            { type: 'ellipsoid', rx: 1.2, ry: 0.25, rz: 1.0 },
            wu - 1.0,
            CREEK_WATER_Y + 0.05,
            wt,
            solid(M.Splash, 2),
            {
                collide: false
            }
        )
    );
    // the timber pile at the gorge
    P.push(...signpost(70, roadT(70) - 2.6, 3));
    P.push(...flag(CHECKPOINTS[3].u, CHECKPOINTS[3].t - 2.4, STAGE_COLOURS[3]));

    // ---- 5: the old industrial works
    // the retaining wall's concrete coping along the road, and a fallen ramp's rubble (low)
    P.push(piece('wall-coping', boxS(13, 0.08, 0.3), WALL.u + 0.2, WALL.high + 0.08, 0, concrete, { priority: 3 }));
    for (const [ru, rtt, s] of [
        [WALL.u - 0.9, -3.2, 0.25],
        [WALL.u - 1.5, 2.4, 0.2],
        [WALL.u - 0.7, 5.1, 0.22]
    ] as const)
        P.push(
            piece('rubble', boxS(s * 1.4, s * 0.6, s), ru, WALL.low + s * 0.55, rtt, concrete, {
                yaw: ru,
                collide: true
            })
        );
    // the brick hall with a galvanised roof
    const hu = 129;
    const ht = 13;
    const hy = WALL.high;
    P.push(piece('hall', boxS(5, 2.6, 4.5), hu, hy + 2.6, ht, brick, { priority: 3 }));
    P.push(
        piece(
            'hall-roof',
            boxS(5.4, 0.08, 4.9),
            hu,
            hy + 5.35,
            ht,
            (x, y, z) =>
                voxel(M.Galvanised, Math.floor((x + 5.4) / 0.3) & 1 ? 0 : 2 + (latticeShade(x, y, z, 0.3, 2) & 1)),
            { priority: 3 }
        )
    );
    for (const wu2 of [-2.6, 0, 2.6])
        P.push(
            piece('hall-window', boxS(0.04, 0.6, 1.0), hu + wu2, hy + 3.4, ht - 5.02, solid(M.Glass, 1), {
                priority: 4,
                yaw: Math.PI / 2
            })
        );
    P.push(
        piece('hall-door', boxS(1.2, 1.3, 0.04), hu - 4.52, hy + 1.3, ht, solid(M.Rust, 1), {
            priority: 4,
            yaw: Math.PI / 2
        })
    );
    // the chimney (the works' landmark from down the valley)
    P.push(
        piece('chimney', { type: 'cylinder', axis: 'y', r: 0.85, half: 5.5 }, hu + 3.2, hy + 5.5, ht + 6.5, brick, {
            priority: 3
        })
    );
    P.push(
        piece(
            'chimney-top',
            { type: 'cylinder', axis: 'y', r: 1.0, half: 0.2 },
            hu + 3.2,
            hy + 11.1,
            ht + 6.5,
            solid(M.UteTrim, 0),
            { priority: 3 }
        )
    );
    // tanks and a pipe run
    for (const [tu, tt] of [
        [136, 8],
        [136, 12.5]
    ] as const) {
        P.push(
            piece(
                'tank',
                { type: 'cylinder', axis: 'y', r: 1.8, half: 2.0 },
                tu,
                hy + 2.0,
                tt,
                solid(M.Galvanised, 1),
                { priority: 3 }
            )
        );
        P.push(
            piece('tank-band', { type: 'cylinder', axis: 'y', r: 1.85, half: 0.08 }, tu, hy + 3.1, tt, rust, {
                priority: 4
            })
        );
    }
    P.push(
        piece('pipe', { type: 'cylinder', axis: 'x', r: 0.25, half: 4.5 }, 133.5, hy + 3.4, 4.2, rust, {
            priority: 3,
            collide: false
        })
    );
    for (const pt of [0.6, 3.6, 6.6]) P.push(piece('pipe-leg', boxS(0.07, 1.6, 0.07), 133.5, hy + 1.6, pt, rust));
    // the tower crane over the lower yard, a crate hanging from it
    const cu = 108;
    const ct = -12;
    P.push(piece('crane-mast', boxS(0.45, 6.5, 0.45), cu, WALL.low + 6.5, ct, crane, { priority: 3 }));
    P.push(
        piece('crane-jib', boxS(0.3, 0.3, 8.5), cu - 4.5, WALL.low + 13.2, ct, crane, { priority: 3, collide: false })
    );
    P.push(
        piece('crane-counter', boxS(0.8, 0.5, 1.0), cu + 4.6, WALL.low + 12.9, ct, concrete, {
            priority: 3,
            collide: false
        })
    );
    P.push(
        piece('crane-cab', boxS(0.7, 0.6, 0.7), cu, WALL.low + 12.2, ct + 0.9, solid(M.Glass, 1), {
            priority: 4,
            collide: false
        })
    );
    P.push(
        piece('crane-cable', boxS(0.02, 4.2, 0.02), cu - 10, WALL.low + 8.8, ct, solid(M.UteTrim, 0), {
            collide: false
        })
    );
    P.push(
        piece('crane-crate', boxS(0.5, 0.4, 0.5), cu - 10, WALL.low + 4.2, ct, grain(M.Timber, 'x', 0.15, 3), {
            collide: false
        })
    );
    P.push(...signpost(96, -2.6, 4));
    P.push(...flag(CHECKPOINTS[4].u, CHECKPOINTS[4].t - 2.4, STAGE_COLOURS[4]));

    // ---- 6: the mountain road and the crevasse
    const vu = CREVASSE.u;
    const vt = roadT(vu);
    for (const side of [-1, 1]) {
        P.push(
            piece(
                'crevasse-post',
                boxS(0.06, 0.55, 0.06),
                vu - side * 1.9,
                groundUT(vu - side * 1.9, vt - 1.9) + 0.55,
                vt - 1.9,
                solid(M.HiVis, 0)
            )
        );
        P.push(
            piece(
                'crevasse-post',
                boxS(0.06, 0.55, 0.06),
                vu - side * 1.9,
                groundUT(vu - side * 1.9, vt + 1.9) + 0.55,
                vt + 1.9,
                solid(M.HiVis, 0)
            )
        );
    }
    // the road's edge posts on the way up
    for (let u = 146; u < 190; u += 6) {
        if (Math.abs(u - vu) < 4) continue;
        const t = roadT(u) + 2.6;
        P.push(
            piece('road-post', boxS(0.05, 0.4, 0.05), u, groundUT(u, t) + 0.4, t, (_x, y) =>
                voxel(y > 0.25 ? M.HiVis : M.HiVisStripe, 0)
            )
        );
    }
    P.push(...signpost(146, roadT(146) - 2.6, 5));
    P.push(...flag(CHECKPOINTS[5].u, CHECKPOINTS[5].t - 2.4, STAGE_COLOURS[5]));

    // ---- 7: the flower on the summit: the goal of the whole journey
    const fy = groundUT(SUMMIT_U, 0);
    P.push(
        piece(
            'flower-stem',
            { type: 'cylinder', axis: 'y', r: 0.3, half: 1.6 },
            SUMMIT_U,
            fy + 1.5,
            0,
            solid(M.Grass, 2),
            { collide: false }
        )
    );
    P.push(
        piece(
            'flower-leaf',
            { type: 'ellipsoid', rx: 0.9, ry: 0.22, rz: 0.4 },
            SUMMIT_U,
            fy + 1.0,
            0.7,
            solid(M.Grass, 0),
            {
                collide: false,
                yaw: 0.3,
                roll: 0.4
            }
        )
    );
    for (let n = 0; n < 6; n++) {
        const a = (n / 6) * Math.PI * 2;
        P.push(
            piece(
                'flower-petal',
                { type: 'ellipsoid', rx: 0.95, ry: 0.5, rz: 0.22 },
                SUMMIT_U - 0.1,
                fy + 3.4 + Math.sin(a) * 0.9,
                Math.cos(a) * 0.9,
                solid(M.Flower, n & 1 ? 0 : 2),
                { collide: false, roll: a }
            )
        );
    }
    P.push(
        piece(
            'flower-centre',
            { type: 'ellipsoid', rx: 0.55, ry: 0.55, rz: 0.4 },
            SUMMIT_U - 0.25,
            fy + 3.4,
            0,
            solid(M.HiVis, 1),
            {
                collide: false,
                priority: 4
            }
        )
    );
    // a ring of stones around it, where the bucket goes
    for (let n = 0; n < 10; n++) {
        const a = (n / 10) * Math.PI * 2;
        const su = SUMMIT_U + Math.cos(a) * 2.1;
        const st = Math.sin(a) * 2.1;
        P.push(
            piece('summit-stone', boxS(0.16, 0.08, 0.12), su, groundUT(su, st) + 0.04, st, stone(30 + n), {
                yaw: a,
                collide: false
            })
        );
    }
    P.push(...signpost(192, -2.6, 6));
    P.push(...landmarkPieces());
    return P;
}

/**
 * Distant landmarks: a silhouette for each area that reads from far down the valley. Every part is
 * at least 42 cm thick, so it survives the 40 cm far lattice (tests/unit/landmarks.test.ts). The works have their chimney and crane, the gorge its
 * waterfall and the summit its flower; these add the forest's fire lookout on the ridge and the
 * mountain's radio mast.
 */
export const LANDMARKS = {
    lookout: { u: 58, t: 24 },
    mast: { u: 184, t: -26 }
};

function landmarkPieces(): StaticPiece[] {
    const P: StaticPiece[] = [];
    // the fire lookout: a timber cabin on four braced legs, with a hip roof and a hi-vis band
    {
        const { u, t } = LANDMARKS.lookout;
        const y = groundUT(u, t) - 0.3;
        const legH = 11;
        for (const [du, dt] of [
            [-1.3, -1.3],
            [-1.3, 1.3],
            [1.3, -1.3],
            [1.3, 1.3]
        ] as const)
            P.push(
                piece('lookout-leg', boxS(0.22, legH / 2, 0.22), u + du, y + legH / 2, t + dt, darkTimber, {
                    roll: -dt * 0.03,
                    pitch: du * 0.03
                })
            );
        // cross braces on each face
        for (const [du, dt, yaw] of [
            [-1.3, 0, 0],
            [1.3, 0, 0],
            [0, -1.3, Math.PI / 2],
            [0, 1.3, Math.PI / 2]
        ] as const)
            for (const [tilt, h] of [
                [-0.9, 0.3],
                [0.9, 0.3],
                [-0.9, 0.7],
                [0.9, 0.7]
            ] as const)
                P.push(
                    piece('lookout-brace', boxS(0.21, 0.21, 1.9), u + du, y + legH * h, t + dt, darkTimber, {
                        yaw,
                        pitch: tilt,
                        collide: false
                    })
                );
        P.push(
            piece('lookout-cabin', boxS(1.5, 1.0, 1.5), u, y + legH + 1.0, t, grain(M.Timber, 'y', 0.2, 5), {
                priority: 3
            })
        );
        P.push(
            piece('lookout-band', boxS(1.55, 0.21, 1.55), u, y + legH + 1.35, t, solid(M.HiVis, 0), { priority: 4 })
        );
        for (let n = 0; n < 3; n++)
            P.push(
                piece(
                    'lookout-roof',
                    boxS(1.8 - n * 0.55, 0.21, 1.8 - n * 0.55),
                    u,
                    y + legH + 2.2 + n * 0.4,
                    t,
                    solid(M.Galvanised, n & 1 ? 0 : 2),
                    { priority: 3 }
                )
            );
    }
    // the radio mast: a lattice tower banded orange and white, on a concrete pad, with a dish
    {
        const { u, t } = LANDMARKS.mast;
        const y = groundUT(u, t);
        const H = 18;
        P.push(piece('mast-pad', boxS(1.4, 0.4, 1.4), u, y + 0.1, t, concrete));
        P.push(
            piece('mast', boxS(0.4, H / 2, 0.4), u, y + H / 2, t, (_x, yy) =>
                voxel(Math.floor((yy + H / 2) / 2.25) & 1 ? M.HiVisStripe : M.HiVis, 0)
            )
        );
        P.push(
            piece(
                'mast-dish',
                { type: 'cylinder', axis: 'z', r: 0.8, half: 0.22 },
                u + 0.6,
                y + H * 0.7,
                t,
                solid(M.Galvanised, 2),
                {
                    collide: false,
                    yaw: 0.6,
                    priority: 3
                }
            )
        );
        P.push(piece('mast-hut', boxS(1.2, 1.0, 0.9), u - 2.2, y + 0.9, t + 0.4, concrete, { priority: 3 }));
    }
    return P;
}

// ------------------------------------------------------------------------------- trees, rocks, decor

interface Scene {
    layout: LevelLayout;
    /** Horizontal reach of each tree, rock and piece (m), for building only the tiles they touch. */
    treeR: number[];
    rockR: number[];
    pieceR: number[];
    /** Reeds (x, z, height m) and flowers (x, z, colour shade). */
    reeds: [number, number, number][];
    flowers: [number, number, number][];
}

const scenes = new Map<number, Scene>();

function inBounds(x: number, z: number, m: number): boolean {
    const B = VALLEY_BOUNDS;
    return x > B.minX + m && x < B.maxX - m && z > B.minZ + m && z < B.maxZ - m;
}

/** Keep-clear test for trees and rocks (route frame). */
function clearSpot(u: number, t: number, r: number): boolean {
    const a = Math.abs(t - roadT(u));
    if (a < 3.4 + r * 0.6) return false;
    if (channelEdge(u, t) < 1.4 + r * 0.5) return false;
    if (yardBlend(u, t) > 0.02) return false;
    if (worksWeight(u, a) > 0.02) return false;
    if (Math.abs(u - WALL.u) < 2.5) return false;
    if (Math.hypot(u - SUMMIT_U, t) < 7) return false;
    for (const l of Object.values(LANDMARKS)) if (Math.hypot(u - l.u, t - l.t) < 4.5) return false;
    if (nearestPath(SIDE_PATHS, u, t, 2.4 + r * 0.6)) return false;
    for (const c of CHECKPOINTS) if (Math.hypot(u - c.u, t - c.t) < 4) return false;
    // the timber piles
    for (const [su, st] of STAGING) if (Math.hypot(u - su, t - st) < 4.5) return false;
    return true;
}

/** Where each area's timber waits (route frame), for keeping trees off it. */
const STAGING: [number, number][] = [
    [27, roadT(24) + 4.6],
    [76, roadT(76) + 4.4],
    [108, -4],
    [160, roadT(160) + 4.4]
];

function scene(seed: number): Scene {
    const cached = scenes.get(seed);
    if (cached) return cached;
    const r = rng(seed * 7 + 11);
    const trees: TreeSpot[] = [];
    // the Timber Yard's own trees on its side of the creek
    for (const t of yardLayout(seed).trees) {
        if (t.z < -4) continue;
        const w = yardToWorld(t.x, t.z);
        trees.push({ ...t, x: w.x, z: w.z });
    }
    const add = (u: number, t: number, s: number, kind: 'pine' | 'oak' = 'pine') => {
        if (!clearSpot(u, t, s)) return;
        const w = routeToWorld(u, t);
        if (!inBounds(w.x, w.z, 2)) return;
        trees.push({ x: w.x, z: w.z, scale: s, yaw: r() * Math.PI * 2, kind });
    };
    const across = (spread: number, min: number) => (r() < 0.5 ? -1 : 1) * (min + r() * spread);
    // behind and beside the yard
    for (let n = 0; n < 50; n++) add(-60 + r() * 56, across(40, 20), 0.95 + r() * 0.5);
    for (let n = 0; n < 30; n++) add(-60 + r() * 42, across(20, 3), 0.95 + r() * 0.5);
    // the forest: thick along the road, the oaks by the creek
    for (let n = 0; n < 240; n++) add(6 + r() * 76, roadT(40) + across(42, 3.4), 0.9 + r() * 0.6);
    for (let n = 0; n < 18; n++) add(4 + r() * 10, across(18, 4), 1.1 + r() * 0.3, 'oak');
    // either side of the gorge and around the works
    for (let n = 0; n < 60; n++) add(80 + r() * 64, across(40, 18), 0.9 + r() * 0.5);
    // the mountainside: smaller pines, thinning towards the summit
    for (let n = 0; n < 170; n++) add(140 + r() * 60, roadT(165) + across(36, 4), 0.75 + r() * 0.5);
    for (let n = 0; n < 40; n++) add(-40 + r() * 280, across(30, 60), 0.9 + r() * 0.5);

    const rocks: RockSpot[] = [];
    const addRock = (u: number, t: number, s: number) => {
        if (!clearSpot(u, t, s * 1.5)) return;
        const w = routeToWorld(u, t);
        if (!inBounds(w.x, w.z, 2)) return;
        rocks.push({
            x: w.x,
            z: w.z,
            rx: s * (1.1 + r() * 0.3),
            ry: s * (0.65 + r() * 0.2),
            rz: s * (0.9 + r() * 0.3),
            yaw: r() * Math.PI
        });
    };
    for (const t of yardLayout(seed).rocks) {
        if (t.z < -4) continue;
        const w = yardToWorld(t.x, t.z);
        rocks.push({ ...t, x: w.x, z: w.z });
    }
    for (let n = 0; n < 30; n++) addRock(6 + r() * 76, across(30, 4), 0.35 + r() * 0.4);
    for (let n = 0; n < 24; n++)
        addRock(gorgeU(0) + (r() < 0.5 ? -1 : 1) * (4 + r() * 4), across(40, 2), 0.4 + r() * 0.5);
    for (let n = 0; n < 50; n++) addRock(142 + r() * 70, across(30, 3.5), 0.4 + r() * 0.7);

    const pieces = valleyPieces();
    // reeds along the creek and the stream; flowers in the forest and on the summit meadow
    const reeds: [number, number, number][] = [];
    for (let n = 0; n < 700; n++) {
        const ditch = n % 3 === 0;
        const t = -90 + r() * 180;
        const side = r() < 0.5 ? -1 : 1;
        const u = ditch
            ? ditchU(t) + side * (DITCH.hw + 0.3 + r() * 0.7)
            : creekU(t) + side * (creekHW(t) + 0.35 + r() * 0.8);
        if (Math.abs(t - roadT(u)) < 2.4 || yardBlend(u, t) > 0.3) continue;
        const w = routeToWorld(u, t);
        if (!inBounds(w.x, w.z, 1)) continue;
        reeds.push([w.x, w.z, 0.15 + r() * r() * 0.5]);
    }
    const flowers: [number, number, number][] = [];
    for (let n = 0; n < 600; n++) {
        const summit = n % 3 === 0;
        const u = summit ? SUMMIT_U - 14 + r() * 26 : 6 + r() * 76;
        const t = summit ? across(14, 2.8) : roadT(u) + across(30, 2.2);
        if (Math.abs(t - roadT(u)) < 1.9 || channelEdge(u, t) < 0.6 || nearestPath(SIDE_PATHS, u, t, 1.6)) continue;
        const w = routeToWorld(u, t);
        if (!inBounds(w.x, w.z, 1)) continue;
        flowers.push([w.x, w.z, r() < 0.3 ? 2 : 0]);
    }

    const pineR = (s: number) => PINE_TIERS[0].r * s + 0.1;
    const oakR = (s: number) => (OAK.blobs[0][3] + 0.75) * s + 0.1;
    const reach = (p: StaticPiece) => {
        const s = p.shape;
        if (s.type === 'box') return Math.hypot(s.hx, s.hy, s.hz) + 0.1;
        if (s.type === 'cylinder') return Math.hypot(s.r, s.half) + 0.1;
        return Math.max(s.rx, s.ry, s.rz) + 0.1;
    };
    const sc: Scene = {
        layout: { trees, rocks, pieces },
        treeR: trees.map((t) => (t.kind === 'oak' ? oakR(t.scale) : pineR(t.scale))),
        rockR: rocks.map((k) => Math.max(k.rx, k.rz) + 0.15),
        pieceR: pieces.map(reach),
        reeds,
        flowers
    };
    scenes.set(seed, sc);
    return sc;
}

export function valleyLayout(seed = 1): LevelLayout {
    return scene(seed).layout;
}

// ------------------------------------------------------------------------------- building

/** Writes scenery (trees, rocks, pieces, decor) touching the rectangle (m); everything when null. */
function buildScenery(
    world: VoxelWorld,
    seed: number,
    rect: { x0: number; x1: number; z0: number; z1: number } | null,
    stats: RasterStats
): { trees: number; rocks: number; reeds: number } {
    const sc = scene(seed);
    const hit = (x: number, z: number, r: number) =>
        !rect || (x + r > rect.x0 && x - r < rect.x1 && z + r > rect.z0 && z - r < rect.z1);
    let trees = 0;
    sc.layout.trees.forEach((t, n) => {
        if (!hit(t.x, t.z, sc.treeR[n])) return;
        if (t.kind === 'oak') oak(world, t.x, t.z, surfaceY(t.x, t.z), t.scale, t.yaw, stats, n + seed * 17);
        else pine(world, t.x, t.z, surfaceY(t.x, t.z), t.scale, t.yaw, stats, n + seed * 17);
        trees++;
    });
    let rocks = 0;
    // the Timber Yard's logging stand (felled trees: the voxel worker follows the sim)
    VALLEY_FORESTRY.trees.forEach((t, n) => {
        if (!hit(t.x, t.z, STAND_CROWN_RADIUS)) return;
        drawStandTree(world, t, n, surfaceY(t.x, t.z), stats);
        trees++;
    });
    sc.layout.rocks.forEach((k, n) => {
        if (!hit(k.x, k.z, sc.rockR[n])) return;
        rock(world, k.x, k.z, surfaceY(k.x, k.z), k.rx, k.ry, k.rz, k.yaw, stats, n + 5);
        rocks++;
    });
    sc.layout.pieces.forEach((p, n) => {
        if (!hit(p.pose.p.x, p.pose.p.z, sc.pieceR[n])) return;
        world.rasterizeStatic(pieceVolume(p), p.pose, p.policy ?? 'coverage50', p.priority ?? 2, stats);
    });
    // single-cell decor only where cells are small enough to read as reeds and flowers
    let reeds = 0;
    if (GRID_SIZE <= 0.11) {
        for (const [x, z, h] of sc.reeds) {
            if (!hit(x, z, 0.1)) continue;
            const i = cellIndexX(x);
            const k = cellIndexZ(z);
            const top = topCell(cellCenterX(i), cellCenterZ(k));
            const n = Math.max(1, Math.round(h / GRID_SIZE));
            for (let j = 1; j <= n; j++) world.setStatic(i, top + j, k, voxel(M.Reed, (j + i) & 3), 1);
            reeds++;
        }
        for (const [x, z, shade] of sc.flowers) {
            if (!hit(x, z, 0.1)) continue;
            const i = cellIndexX(x);
            const k = cellIndexZ(z);
            world.setStatic(i, topCell(cellCenterX(i), cellCenterZ(k)) + 1, k, voxel(M.Flower, shade), 1);
        }
    }
    return { trees, rocks, reeds };
}

export function buildValley(world: VoxelWorld, seed = 1): LevelBuildResult {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const stats = createRasterStats();
    const columns = rasterizeTerrain(world, VALLEY_TERRAIN);
    const r = buildScenery(world, seed, null, stats);
    world.finalizeStatic();
    const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return { columns, staticCells: world.staticCellCount(), ...r, stats, ms: t1 - t0 };
}

function buildValleyTile(world: VoxelWorld, seed: number, r: ColumnRect, tile: { ti: number; tk: number }): number {
    const columns = rasterizeTerrainTile(world, VALLEY_TERRAIN, r, tile);
    const stats = createRasterStats();
    buildScenery(
        world,
        seed,
        { x0: r.i0 * GRID_SIZE, x1: (r.i1 + 1) * GRID_SIZE, z0: r.k0 * GRID_SIZE, z1: (r.k1 + 1) * GRID_SIZE },
        stats
    );
    return columns;
}

// ------------------------------------------------------------------------------- props and stages

const FLAT = Math.PI / 2;
/** A pose in the route frame (yaw about the route frame's own axes). */
function atUT(u: number, t: number, lift: number, yaw = 0, pitch = 0, roll = 0): Pose {
    const w = routeToWorld(u, t);
    return pose(w.x, groundUT(u, t) + lift, w.z, quatFromYawPitchRoll(ROUTE_YAW + yaw, pitch, roll));
}

/** The Timber Yard's logging stand and sawmill, where the yard is (area 1). */
const VALLEY_FORESTRY: ForestryDef = (() => {
    const y = YARD_FORESTRY;
    const saw = y.sawmill!;
    const w = yardToWorld(saw.x, saw.z);
    return {
        // positions and leans turned with the yard
        trees: y.trees.map((t) => ({
            ...yardToWorld(t.x, t.z),
            yaw: t.yaw + ROUTE_YAW,
            lean: t.lean && {
                x: t.lean.x * Math.cos(ROUTE_YAW) + t.lean.z * Math.sin(ROUTE_YAW),
                z: -t.lean.x * Math.sin(ROUTE_YAW) + t.lean.z * Math.cos(ROUTE_YAW)
            }
        })),
        sawmill: { x: w.x, z: w.z, yaw: saw.yaw + ROUTE_YAW, y: saw.y },
        axe: y.axe ? fromYard(y.axe) : null,
        ground: surfaceY
    };
})();

/** How many of each prop the Valley uses (sim/lab-entities.ts sizes its pools from these). */
export const VALLEY_PROPS = { planks: 12, beams: 12, crates: 6 };

function valleyProps(): PropPlacement[] {
    const P: PropPlacement[] = yardProps().map((p) => ({ name: p.name, pose: fromYard(p.pose) }));
    // forest road: three long beams at the log dump, side by side (long axis across the road)
    const [lu, lt] = STAGING[0];
    for (let n = 0; n < 3; n++) P.push({ name: `beam-${2 + n}`, pose: atUT(lu - 0.45 + n * 0.45, lt, 0.08, 0, FLAT) });
    // the gorge: four beams and four planks on a pile before the edge
    const [gu, gt] = STAGING[1];
    for (let n = 0; n < 4; n++) P.push({ name: `beam-${5 + n}`, pose: atUT(gu - 0.7 + n * 0.45, gt, 0.08, 0, FLAT) });
    for (let n = 0; n < 4; n++)
        P.push({ name: `extra-plank-${5 + n}`, pose: atUT(gu - 3, gt + 0.4, 0.06 + n * 0.105, 0, FLAT) });
    // the works: six crates in the lower yard
    const [cu, ct] = STAGING[2];
    for (let n = 0; n < 6; n++)
        P.push({ name: `crate-${n}`, pose: atUT(cu + (n % 3) * 0.7, ct + Math.floor(n / 3) * 0.8, 0.26, n * 0.3) });
    // the mountain: three beams and three planks
    const [mu, mt] = STAGING[3];
    for (let n = 0; n < 3; n++) P.push({ name: `beam-${9 + n}`, pose: atUT(mu - 0.45 + n * 0.45, mt, 0.08, 0, FLAT) });
    for (let n = 0; n < 3; n++)
        P.push({ name: `extra-plank-${9 + n}`, pose: atUT(mu - 3, mt + 0.3, 0.06 + n * 0.105, 0, FLAT) });
    return P;
}

const square = (u: number, t: number, half: number): Rect => {
    const w = routeToWorld(u, t);
    return { minX: w.x - half, maxX: w.x + half, minZ: w.z - half, maxZ: w.z + half };
};
/** A point just short of a checkpoint (where players and the bucket restart). */
const restart = (u: number, t: number) => {
    const w = routeToWorld(u, t);
    return { x: w.x, z: w.z, yaw: ROUTE_YAW };
};
const bucketAt = (u: number, t: number) => {
    const w = routeToWorld(u, t);
    return { x: w.x, z: w.z, y: groundUT(u, t) + 0.03 };
};

const stump = yardToWorld(BUCKET_STUMP.x, BUCKET_STUMP.z);

export const VALLEY_STAGES: LevelStage[] = [
    {
        name: 'Timber Yard',
        objective: 'Take the bucket from its stump down to the flag by the old bridge',
        goal: square(CHECKPOINTS[0].u, CHECKPOINTS[0].t, 1.8),
        start: { x: stump.x, z: stump.z, yaw: ROUTE_YAW },
        bucket: { x: stump.x, z: stump.z, y: BUCKET_STUMP.top + 0.01 }
    },
    {
        name: 'Shallow Creek',
        objective: 'Bridge the creek and get the bucket to the flag on the far bank',
        goal: square(CHECKPOINTS[1].u, CHECKPOINTS[1].t, 2.6),
        start: restart(-4.5, 1),
        bucket: bucketAt(-4.5, 1.6)
    },
    {
        name: 'Forest Road',
        objective: 'Carry the long beams from the log dump over the washed-out culvert',
        goal: square(CHECKPOINTS[2].u, CHECKPOINTS[2].t, 2.6),
        start: restart(8, roadT(8)),
        bucket: bucketAt(8, roadT(8) + 0.8)
    },
    {
        name: 'Gorge',
        objective: 'Span the gorge to the old pier and on to the far side',
        goal: square(CHECKPOINTS[3].u, CHECKPOINTS[3].t, 2.6),
        start: restart(50, roadT(50)),
        bucket: bucketAt(50, roadT(50) + 0.8)
    },
    {
        name: 'Old Industrial Works',
        objective: 'Stack the crates and get the bucket up onto the works’ upper yard',
        goal: square(CHECKPOINTS[4].u, CHECKPOINTS[4].t, 3),
        start: restart(96, 1),
        bucket: bucketAt(96, 1.8)
    },
    {
        name: 'Mountain Approach',
        objective: 'Bridge the crevasse on the mountain road',
        goal: square(CHECKPOINTS[5].u, CHECKPOINTS[5].t, 2.6),
        start: restart(128, -2),
        bucket: bucketAt(128, -1.2)
    },
    {
        name: 'Flower Summit',
        objective: 'Set the bucket down by the flower',
        goal: square(SUMMIT_U, 0, 2.0),
        start: restart(175, roadT(175)),
        bucket: bucketAt(175, roadT(175) + 0.8)
    }
];

/** Ground the player may be put back on after a fall. */
function isSafe(x: number, z: number): boolean {
    return channelEdge(routeU(x, z), routeT(x, z)) > 0.9;
}

const wsock = yardToWorld(WINDSOCK.x, WINDSOCK.z);
const spawn = yardToWorld(1.2, 6.2);
const orbitFrom = yardToWorld(9, 12);
const orbitTo = yardToWorld(-1, 0);
const yardActors = {
    beaver: fromYard(pose(-6.3, YARD_Y, 7.4, quatFromYawPitchRoll(2.4, 0, 0))),
    ute: fromYard(pose(-10.5, YARD_Y + 0.002, 4.6, quatFromYawPitchRoll(Math.PI / 2 + 0.15, 0, 0)))
};

/** Where the gorge's waterfall comes out of the far wall (route coordinates: along u, across t). */
function waterfallSpot(): { u: number; t: number } {
    const t = 15;
    return { u: gorgeU(t) + GORGE.hw, t };
}

/** The waterfall's middle, in the world: its roar is heard from here (Epic 8, #80). */
export function valleyWaterfall(): { x: number; y: number; z: number } {
    const { u, t } = waterfallSpot();
    const w = routeToWorld(u - 0.35, t);
    return { x: w.x, y: (WALL.low - 0.6 + CREEK_WATER_Y) / 2, z: w.z };
}

export const valleyLevel: LevelDef = {
    id: 'valley',
    name: 'The Valley',
    bounds: VALLEY_BOUNDS,
    playArea: { minX: -109, maxX: 109, minZ: -109, maxZ: 109 },
    water: { y: CREEK_WATER_Y, cx: 0, cz: 0, halfX: 112, halfZ: 112 },
    sounds: { waterfalls: [valleyWaterfall()] },
    terrainHeight: valleyHeight,
    layout: valleyLayout,
    build: buildValley,
    stream: {
        buildTile: buildValleyTile,
        radius: 36,
        lowRadius: 24,
        farCm: 40,
        fog: { start: 30, end: 260 }
    },
    sun: { elevation: 9, azimuth: 105 - 45 },
    wind: { dir: Math.PI * 0.3, base: 1.4, gust: 3.6 },
    windsock: { x: wsock.x, z: wsock.z, height: WINDSOCK.height },
    spawn: { x: spawn.x, z: spawn.z, yaw: 0.12 + ROUTE_YAW, pitch: -0.1 },
    orbitHome: {
        pos: [orbitFrom.x, 4.2, orbitFrom.z],
        focus: [orbitTo.x, 0.5, orbitTo.z]
    },
    startFirstPerson: true,
    actors: {
        beaver: { mode: 'idle', pose: yardActors.beaver },
        ute: { mode: 'drivable', pose: yardActors.ute }
    },
    props: valleyProps(),
    forestry: VALLEY_FORESTRY,
    rules: {
        objective: 'Deliver the bucket to the flower on the summit',
        goal: VALLEY_STAGES[VALLEY_STAGES.length - 1].goal,
        fallY: -0.2,
        isSafe,
        lostY: CREEK_WATER_Y + 0.15,
        stages: VALLEY_STAGES
    },
    scriptedProps: false
};
