/**
 * Level 1 — the Timber Yard and the shallow creek (design doc §3.1, the first vertical slice area).
 *
 * Sunrise. A gravel timber yard on the near bank: a timber shed, a plank stack, two beams, a log
 * pile, a parked ute, a co-worker beaver and the bucket on a stump. North of it a creek too deep to
 * wade runs across the valley between steep banks; the old footbridge has collapsed, leaving two
 * stone abutments 2.7 m apart. Across it a forest road climbs towards the ridge, where the flower
 * stands against the sky. Objective: get the bucket to the flag on the far bank.
 *
 * Pure module (no engine): analytic terrain, static scenery and the level description.
 */

import { GRID_SIZE, cellCenterX, cellCenterZ, cellIndexX, cellIndexZ } from '../voxels/grid.ts';
import { pose, quatFromYawPitchRoll } from '../voxels/math.ts';
import type { Pose } from '../voxels/math.ts';
import { M, voxel } from '../voxels/palette.ts';
import { createRasterStats } from '../voxels/rasterizer.ts';
import { grain, hash3, latticeShade, solid } from '../voxels/volumes.ts';
import type { MaterialField } from '../voxels/volumes.ts';
import type { VoxelWorld } from '../voxels/world.ts';

import { fbm, lerp, oak, patchShade, pine, rasterizeTerrain, rng, rock, smoothstep } from './common.ts';
import type { RockSpot, TreeSpot } from './common.ts';
import { drawStand, sawmillPieces } from './forestry.ts';
import type { ForestryDef } from './forestry.ts';
import { rasterizePieces } from './level.ts';
import type { LevelBuildResult, LevelDef, LevelLayout, PropPlacement, StaticPiece } from './level.ts';
import { waterButt } from './water-butt.ts';

export const YARD_BOUNDS = { minX: -28, maxX: 28, minZ: -42, maxZ: 14 };
export const CUT_BASE_Y = -2;

/** Creek water surface; the bed lies about 0.6 m below, the banks 0.85 m above. */
export const CREEK_WATER_Y = -0.45;
export const CREEK_BED_Y = -1.05;
/** Yard pad height (a grid plane at both 5 and 10 cm cells). */
export const YARD_Y = 0.4;
const FAR_BANK_Y = 0.5;
/** The old bridge crossing. */
export const BRIDGE_X = -1;

export function creekCenterZ(x: number): number {
    return -2 + 0.45 * Math.sin((x - BRIDGE_X) * 0.16);
}

export function creekHalfWidth(x: number): number {
    return 2.0 + 0.25 * Math.sin(x * 0.3 + 1);
}

/** The yard pad (flat gravel). */
const YARD = { minX: -15.5, maxX: 9, minZ: 1.6, maxZ: 12.5 };
/** Summit of the ridge where the flower stands. */
export const SUMMIT = { x: 3, z: -35 };

export function yardWeight(x: number, z: number): number {
    const m = 1.6;
    const wx = smoothstep(YARD.minX - m, YARD.minX, x) * (1 - smoothstep(YARD.maxX, YARD.maxX + m, x));
    const wz = smoothstep(YARD.minZ - 0.4, YARD.minZ + 0.6, z) * (1 - smoothstep(YARD.maxZ, YARD.maxZ + m, z));
    return wx * wz;
}

/** The logging stand east of the yard (YARD_FORESTRY): levelled, so felled logs lie where they fall. */
const STAND = { minX: 10.6, maxX: 18.6, minZ: 2.4, maxZ: 12.2 };

function standWeight(x: number, z: number): number {
    const m = 1.6;
    const wx = smoothstep(STAND.minX - m, STAND.minX, x) * (1 - smoothstep(STAND.maxX, STAND.maxX + m, x));
    const wz = smoothstep(STAND.minZ - 0.4, STAND.minZ + 0.6, z) * (1 - smoothstep(STAND.maxZ, STAND.maxZ + m, z));
    return wx * wz;
}

/** The forest road on the far bank: from the bridge north towards the ridge. */
export function roadCenterX(z: number): number {
    return BRIDGE_X + 1.4 * Math.sin((z + 4) * 0.13) - 0.04 * (z + 4);
}

function onRoad(x: number, z: number): number {
    if (z > -3.9 || z < -21) return 99;
    return Math.abs(x - roadCenterX(z));
}

/** Continuous ground height at (x, z). Collision and placement use this, never voxels. */
export function yardHeight(x: number, z: number): number {
    const zc = creekCenterZ(x);
    const hw = creekHalfWidth(x);
    const d = z - zc;
    const ad = Math.abs(d);

    let bank: number;
    if (d > 0) {
        bank = YARD_Y + 0.12 + 0.3 * (fbm(x * 0.15, z * 0.15, 11) - 0.5) + 0.6 * smoothstep(9, 14, z);
        bank = lerp(bank, YARD_Y - 1e-3, Math.max(yardWeight(x, z), standWeight(x, z)));
    } else {
        bank = FAR_BANK_Y + 0.25 * (fbm(x * 0.14, z * 0.14, 5) - 0.4);
        // gentle rise through the forest, then the ridge and its summit
        bank += 1.4 * smoothstep(-7, -20, z) * (0.6 + 0.7 * fbm(x * 0.07, z * 0.07, 9));
        const ridge = smoothstep(-21, -33, z);
        if (ridge > 0) bank += ridge * (5 + 4 * fbm(x * 0.05 + 1.7, 0.4, 21, 4) + 1.2 * fbm(x * 0.12, z * 0.12, 25));
        bank += 3.2 * Math.exp(-((x - SUMMIT.x) ** 2 + (z - SUMMIT.z) ** 2) / 30) * smoothstep(-26, -32, z);
        // the road is graded flat across, following the hill
        const r = onRoad(x, z);
        if (r < 3) {
            const roadY =
                FAR_BANK_Y + 1.4 * smoothstep(-7, -20, z) * (0.6 + 0.7 * fbm(roadCenterX(z) * 0.07, z * 0.07, 9));
            bank = lerp(roadY, bank, smoothstep(1.6, 3, r));
        }
    }

    // steep-walled channel: the creek cannot be waded or climbed out of
    if (ad < hw) return CREEK_BED_Y + 0.15 * smoothstep(0, hw * 0.8, ad);
    const t = smoothstep(hw, hw + 0.3, ad);
    const h = lerp(CREEK_BED_Y + 0.15, bank, t);
    // beyond the forest the ridge is terraced into 0.3 m benches (as in the River Lab, ADR 0005):
    // a deliberate stepped silhouette that also keeps the triangle count down
    // (the upper forest is benched too, except the road, which keeps a smooth grade for the ute)
    const terrace = Math.max(smoothstep(-19, -23, z), smoothstep(-10, -13, z) * smoothstep(2.2, 3.4, onRoad(x, z)));
    if (terrace > 0) return lerp(h, Math.floor(h / 0.3) * 0.3 + 1e-3, terrace);
    return h;
}

export function yardTopCell(x: number, z: number): number {
    return Math.floor(yardHeight(x, z) / GRID_SIZE - 1e-9);
}

export function yardSurfaceY(x: number, z: number): number {
    return (yardTopCell(x, z) + 1) * GRID_SIZE;
}

export function yardSurfaceMaterial(x: number, z: number, top: number): number {
    const y = (top + 1) * GRID_SIZE;
    const ad = Math.abs(z - creekCenterZ(x));
    const hw = creekHalfWidth(x);
    if (z < -23) {
        const slope =
            Math.abs(yardHeight(x + 0.3, z) - yardHeight(x - 0.3, z)) +
            Math.abs(yardHeight(x, z + 0.3) - yardHeight(x, z - 0.3));
        if (slope > 0.9) return voxel(M.HillRock, patchShade(x, z, 3, 13) & 1);
        return voxel(M.HillGrass, patchShade(x, z, 4.5, 9));
    }
    // fine shade patches only where the player works; large merge-friendly patches elsewhere
    const shade = patchShade(x, z, Math.abs(x) < 14 && z > -9 && z < 12 ? 1.2 : 3, 71);
    if (ad < hw) return voxel(fbm(x * 0.5, z * 0.5, 3) > 0.55 ? M.Pebble : M.Sand, shade);
    if (y < YARD_Y - 0.15 && ad < hw + 0.5) return voxel(M.Mud, shade);
    if (yardWeight(x, z) > 0.55) {
        // gravel yard with sawdust around the saw and the plank stack
        const saw = Math.hypot(x - SAWMILL_SPOT.x, z - SAWMILL_SPOT.z) < 2.8 || Math.hypot(x + 4.6, z - 6) < 1.8;
        if (saw) return voxel(M.Sand, shade & 1);
        return voxel(fbm(x * 0.25, z * 0.25, 17) > 0.62 ? M.Dirt : M.Path, shade);
    }
    if (onRoad(x, z) < 1.5) return voxel(M.Path, shade);
    if (fbm(x * 0.2, z * 0.2, 41) > 0.64) return voxel(M.GrassDry, shade);
    return voxel(M.Grass, shade);
}

export function yardSideMaterial(depthBelowTop: number, j: number, z: number): number {
    const strata = hash3(Math.floor((j * GRID_SIZE) / 0.1), 0, 0, 5) & 3;
    if (z < -23) return depthBelowTop * GRID_SIZE <= 0.3 ? voxel(M.HillGrass, 1) : voxel(M.HillRock, strata & 1);
    if (depthBelowTop * GRID_SIZE <= 0.2) return voxel(M.Dirt, strata);
    return voxel(M.Rock, strata);
}

// ------------------------------------------------------------------------------------- pieces

const stone =
    (seed: number): MaterialField =>
    (x, y, z) =>
        voxel(M.Rock, latticeShade(x, y, z, 0.2, seed));
const oldTimber: MaterialField = (x, y, z) => voxel(M.Timber, 1 + (latticeShade(x, y, z, 0.15, 4) & 1) * 2);
const darkTimber: MaterialField = (x, y, z) => voxel(M.LogBark, latticeShade(x, y, z, 0.2, 6) & 1);

function piece(
    name: string,
    shape: StaticPiece['shape'],
    x: number,
    y: number,
    z: number,
    field: MaterialField,
    opts: { yaw?: number; pitch?: number; roll?: number; collide?: boolean; priority?: number } = {}
): StaticPiece {
    return {
        name,
        shape,
        pose: pose(x, y, z, quatFromYawPitchRoll(opts.yaw ?? 0, opts.pitch ?? 0, opts.roll ?? 0)),
        field,
        collide: opts.collide ?? true,
        priority: opts.priority ?? 2
    };
}

const boxS = (hx: number, hy: number, hz: number) => ({ type: 'box' as const, hx, hy, hz });

/** Bridge geometry, shared by the pieces, the tests and the level rules. */
export const BRIDGE = (() => {
    const zc = creekCenterZ(BRIDGE_X);
    const hw = creekHalfWidth(BRIDGE_X);
    const nearEdge = zc + hw; // yard bank
    const farEdge = zc - hw;
    const protrude = 0.86;
    return {
        zc,
        nearFace: nearEdge - protrude,
        farFace: farEdge + protrude,
        nearEdge,
        farEdge,
        /** Clear gap between the abutment faces. */
        gap: nearEdge - farEdge - 2 * protrude,
        halfWidth: 1.3
    };
})();

export function yardPieces(): StaticPiece[] {
    const P: StaticPiece[] = [];
    const B = BRIDGE;
    // ---- the old crossing: two stone abutments, a snapped stringer, boards in the water
    const nearTop = YARD_Y;
    const farTop = yardHeight(BRIDGE_X, B.farEdge - 0.6);
    const nearLen = B.nearEdge - B.nearFace + 0.5;
    const farLen = B.farFace - B.farEdge + 0.5;
    P.push(
        piece(
            'abutment-near',
            boxS(B.halfWidth, (nearTop - CREEK_BED_Y) / 2, nearLen / 2),
            BRIDGE_X,
            (nearTop + CREEK_BED_Y) / 2,
            B.nearFace + nearLen / 2,
            stone(3),
            { priority: 3 }
        )
    );
    P.push(
        piece(
            'abutment-far',
            boxS(B.halfWidth, (farTop - CREEK_BED_Y) / 2, farLen / 2),
            BRIDGE_X,
            (farTop + CREEK_BED_Y) / 2,
            B.farFace - farLen / 2,
            stone(5),
            { priority: 3 }
        )
    );
    // capstones, slightly proud
    P.push(
        piece('cap-near', boxS(B.halfWidth + 0.05, 0.05, 0.25), BRIDGE_X, nearTop + 0.05, B.nearFace + 0.25, stone(7), {
            priority: 3
        })
    );
    P.push(
        piece('cap-far', boxS(B.halfWidth + 0.05, 0.05, 0.25), BRIDGE_X, farTop + 0.05, B.farFace - 0.25, stone(9), {
            priority: 3
        })
    );
    // the snapped stringer hanging off the near abutment into the water
    P.push(
        piece('stringer-snapped', boxS(0.09, 0.09, 0.8), BRIDGE_X - 0.8, nearTop - 0.45, B.nearFace - 0.6, darkTimber, {
            pitch: -0.7
        })
    );
    // old deck boards lying on the creek bed
    P.push(
        piece('board-1', boxS(1.0, 0.04, 0.12), BRIDGE_X + 0.3, CREEK_BED_Y + 0.2, B.zc + 0.3, oldTimber, { yaw: 0.5 })
    );
    P.push(
        piece('board-2', boxS(0.9, 0.04, 0.12), BRIDGE_X - 0.6, CREEK_BED_Y + 0.22, B.zc - 0.5, oldTimber, {
            yaw: -0.3,
            roll: 0.2
        })
    );
    // a warning post by the gap
    P.push(
        piece(
            'warning-post',
            boxS(0.05, 0.6, 0.05),
            BRIDGE_X + B.halfWidth + 0.3,
            nearTop + 0.6,
            B.nearFace + 0.4,
            solid(M.Timber, 1)
        )
    );
    P.push(
        piece(
            'warning-sign',
            boxS(0.32, 0.18, 0.025),
            BRIDGE_X + B.halfWidth + 0.3,
            nearTop + 1.15,
            B.nearFace + 0.4,
            (_x, y) => voxel(Math.abs(y) < 0.06 ? M.HiVisStripe : M.HiVis, 0),
            { priority: 3 }
        )
    );

    // ---- the flood gauge (Epic 8): a banded post in the creek by the crossing; its marks going
    // under is the rising river's tell (§2.9). Bands every 10 cm, one world-aligned set.
    const gaugeTop = YARD_Y + 0.45;
    const gaugeHalf = (gaugeTop - CREEK_BED_Y) / 2;
    const gaugeY = (gaugeTop + CREEK_BED_Y) / 2;
    P.push(
        piece(
            'flood-gauge',
            boxS(0.05, gaugeHalf, 0.05),
            FLOOD_GAUGE.x,
            gaugeY,
            FLOOD_GAUGE.z,
            (_x, y) => voxel(Math.floor((y + gaugeY) / 0.1 + 1e-6) & 1 ? M.HiVis : M.HiVisStripe, 0),
            { priority: 3 }
        )
    );

    // ---- the far-bank goal flag
    const goal = YARD_GOAL;
    const gx = (goal.minX + goal.maxX) / 2;
    const gz = goal.minZ + 0.3;
    const gy = yardHeight(gx, gz);
    P.push(piece('flag-pole', boxS(0.04, 1.2, 0.04), gx, gy + 1.2, gz, solid(M.Steel, 1)));
    P.push(
        piece(
            'flag',
            boxS(0.35, 0.2, 0.02),
            gx + 0.39,
            gy + 2.15,
            gz,
            (x, y) =>
                voxel((Math.floor((x + 0.35) / 0.1) + Math.floor((y + 0.2) / 0.1)) & 1 ? M.HiVis : M.TestOrange, 0),
            { priority: 3 }
        )
    );

    // ---- timber shed: four posts, a pitched roof, a back wall of boards
    const sx0 = -13;
    const sx1 = -7;
    const sz0 = 8.6;
    const sz1 = 11.6;
    for (const [px, pz] of [
        [sx0, sz0],
        [sx1, sz0],
        [sx0, sz1],
        [sx1, sz1]
    ]) {
        P.push(piece('shed-post', boxS(0.08, 1.25, 0.08), px, YARD_Y + 1.25, pz, darkTimber));
    }
    const sc = (sx0 + sx1) / 2;
    P.push(
        piece(
            'shed-roof',
            boxS(3.4, 0.05, 1.85),
            sc,
            YARD_Y + 2.62,
            (sz0 + sz1) / 2,
            (x, y, z) =>
                voxel(M.Galvanised, Math.floor((x + 3.4) / 0.3) & 1 ? 0 : 2 + (latticeShade(x, y, z, 0.3, 2) & 1)),
            { pitch: 0.1, priority: 3 }
        )
    );
    P.push(piece('shed-wall', boxS(3.0, 1.05, 0.04), sc, YARD_Y + 1.05, sz1 + 0.05, grain(M.Timber, 'y', 0.2, 8)));
    P.push(piece('shed-rack', boxS(2.6, 0.04, 0.6), sc, YARD_Y + 0.7, sz1 - 0.7, oldTimber));
    for (const rx of [sc - 2.4, sc, sc + 2.4])
        P.push(piece('shed-rack-leg', boxS(0.05, 0.33, 0.5), rx, YARD_Y + 0.33, sz1 - 0.7, darkTimber));

    // ---- the sawmill (Epic 6): its frame, guide and rack; the blade and lamp move (src/levels/forestry.ts)
    P.push(...sawmillPieces(YARD_FORESTRY.sawmill!));

    // ---- the windsock pole (the sock itself is a moving object that follows the wind)
    const wsy = yardHeight(WINDSOCK.x, WINDSOCK.z);
    P.push(
        piece(
            'windsock-pole',
            boxS(0.05, WINDSOCK.height / 2, 0.05),
            WINDSOCK.x,
            wsy + WINDSOCK.height / 2,
            WINDSOCK.z,
            solid(M.Steel, 1)
        )
    );

    // ---- the bucket stump and a yard sign
    P.push(
        piece(
            'stump',
            { type: 'cylinder', axis: 'y', r: 0.26, half: 0.22 },
            BUCKET_STUMP.x,
            YARD_Y + 0.22,
            BUCKET_STUMP.z,
            (x, y, z) =>
                voxel(
                    y > 0.17 ? M.LogEnd : M.LogBark,
                    y > 0.17 ? (Math.floor(Math.hypot(x, z) / 0.07) & 1 ? 1 : 2) : latticeShade(x, y, z, 0.15, 3)
                )
        )
    );
    P.push(piece('sign-post-l', boxS(0.05, 0.75, 0.05), 6.4, YARD_Y + 0.75, 2.6, darkTimber));
    P.push(piece('sign-post-r', boxS(0.05, 0.75, 0.05), 8.2, YARD_Y + 0.75, 2.6, darkTimber));
    P.push(
        piece(
            'sign-board',
            boxS(1.0, 0.25, 0.03),
            7.3,
            YARD_Y + 1.35,
            2.6,
            (x, y) =>
                voxel(
                    Math.abs(y) < 0.11 &&
                        Math.abs(x) < 0.85 &&
                        hash3(Math.floor((x + 1) / 0.1), Math.floor((y + 1) / 0.1), 0, 3) % 3 === 0
                        ? M.HiVis
                        : M.Timber,
                    1
                ),
            { priority: 3 }
        )
    );

    // ---- the flower on the summit: the goal of the whole journey, silhouetted on the ridge
    const fy = yardHeight(SUMMIT.x, SUMMIT.z);
    P.push(
        piece(
            'flower-stem',
            { type: 'cylinder', axis: 'y', r: 0.22, half: 1.6 },
            SUMMIT.x,
            fy + 1.5,
            SUMMIT.z,
            solid(M.Grass, 2),
            { collide: false }
        )
    );
    P.push(
        piece(
            'flower-leaf',
            { type: 'ellipsoid', rx: 0.9, ry: 0.15, rz: 0.4 },
            SUMMIT.x + 0.7,
            fy + 1.0,
            SUMMIT.z,
            solid(M.Grass, 0),
            { collide: false, yaw: 0.3, roll: 0.4 }
        )
    );
    for (let n = 0; n < 6; n++) {
        const a = (n / 6) * Math.PI * 2;
        P.push(
            piece(
                'flower-petal',
                { type: 'ellipsoid', rx: 0.95, ry: 0.5, rz: 0.22 },
                SUMMIT.x + Math.cos(a) * 0.9,
                fy + 3.4 + Math.sin(a) * 0.9,
                SUMMIT.z + 0.1,
                solid(M.Flower, n & 1 ? 0 : 2),
                { collide: false, roll: a, priority: 2 }
            )
        );
    }
    P.push(
        piece(
            'flower-centre',
            { type: 'ellipsoid', rx: 0.55, ry: 0.55, rz: 0.4 },
            SUMMIT.x,
            fy + 3.4,
            SUMMIT.z + 0.25,
            solid(M.HiVis, 1),
            { collide: false, priority: 4 }
        )
    );
    // the water butt by the stump (Epic 7), last: earlier pieces keep their colliders' order
    P.push(...yardButt().pieces);
    return P;
}

/** The windsock: a pole by the yard's creek edge. */
export const WINDSOCK = { x: 4.6, z: 1.6, height: 3.2 };

/** Bucket stump in the yard. */
export const BUCKET_STUMP = { x: 5.6, z: 4.4, top: YARD_Y + 0.44 };
/** The yard's water tank (Epic 7): its tap fills a bucket set under it (YARD_TAP). */
export const yardButt = () => waterButt('water butt', YARD_TAP.x, YARD_TAP.z, YARD_Y, YARD_Y, Math.PI / 2, 40);
/**
 * Where the yard's tap fills a bucket set on the ground under it: the south-west corner of the yard,
 * clear of the paths to the bridge, the logging stand and the sawmill (its post stands to the north).
 */
export const YARD_TAP = { x: -4.4, z: 10.4 };
/** Far-bank goal area for the bucket. */
export const YARD_GOAL = { minX: BRIDGE_X - 3.5, maxX: BRIDGE_X + 3.5, minZ: -9.5, maxZ: -5.2 };

export function yardLayout(seed = 1): LevelLayout {
    const r = rng(seed * 7 + 3);
    const trees: TreeSpot[] = [];
    const add = (x: number, z: number, s: number, kind: 'pine' | 'oak' = 'pine') => {
        // keep the road, the creek, the yard and the goal clear
        if (onRoad(x, z) < 2.6) return;
        if (Math.abs(z - creekCenterZ(x)) < creekHalfWidth(x) + 1.2) return;
        if (yardWeight(x, z) > 0.05) return;
        if (
            x > YARD_GOAL.minX - 1.5 &&
            x < YARD_GOAL.maxX + 1.5 &&
            z > YARD_GOAL.minZ - 1.5 &&
            z < YARD_GOAL.maxZ + 1.5
        )
            return;
        trees.push({ x, z, scale: s, yaw: r() * Math.PI * 2, kind });
    };
    // the forest across the creek, thickening uphill
    for (let n = 0; n < 44; n++) add(-26 + r() * 52, -6 - r() * 15, 0.9 + r() * 0.55);
    // the ridge
    for (let n = 0; n < 22; n++) add(-30 + r() * 60, -22 - r() * 14, 0.85 + r() * 0.6);
    // a few around the yard's edges (east of the yard is the logging stand: YARD_FORESTRY)
    for (const [x, z, s] of [
        [-18.5, 6, 1.2],
        [-17.5, 11.5, 1.05],
        [-20, 1.8, 1.0],
        [17, 1.8, 1.1],
        [-23, 9, 1.25],
        [21, 8, 1.2]
    ] as const) {
        add(x, z, s);
    }
    // autumn oaks by the creek and the yard: their leaves fall and drift on the wind
    for (const [x, z, s] of [
        [-16.5, 3.4, 1.25],
        [10.5, 2.9, 1.1],
        [6.8, -6.8, 1.2],
        [-8.8, -6.4, 1.15],
        [14.5, -4.6, 1.3],
        [-19.5, -5.2, 1.2],
        [4.2, -12.5, 1.1],
        [-6.5, -11.5, 1.25]
    ] as const) {
        add(x, z, s, 'oak');
    }
    const rocks: RockSpot[] = [];
    for (const [x, z, s] of [
        [-6.5, 2.2, 0.45],
        [4.2, -5.0, 0.5],
        [-7.5, -5.6, 0.6],
        [9.5, -6.5, 0.55],
        [-14, 2.4, 0.5],
        [11.5, 1.9, 0.4]
    ] as const) {
        rocks.push({
            x,
            z,
            rx: s * (1.1 + r() * 0.3),
            ry: s * (0.65 + r() * 0.2),
            rz: s * (0.9 + r() * 0.3),
            yaw: r() * Math.PI
        });
    }
    return { trees, rocks, pieces: yardPieces() };
}

export function buildTimberYard(world: VoxelWorld, seed = 1): LevelBuildResult {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const stats = createRasterStats();
    const B = YARD_BOUNDS;
    const columns = rasterizeTerrain(world, {
        minX: B.minX,
        maxX: B.maxX,
        minZ: B.minZ,
        maxZ: B.maxZ,
        cutBaseY: CUT_BASE_Y,
        topCell: yardTopCell,
        surface: yardSurfaceMaterial,
        side: yardSideMaterial
    });
    const layout = yardLayout(seed);
    let trees = 0;
    for (const t of layout.trees) {
        if (t.kind === 'oak') oak(world, t.x, t.z, yardSurfaceY(t.x, t.z), t.scale, t.yaw, stats, trees + seed * 17);
        else pine(world, t.x, t.z, yardSurfaceY(t.x, t.z), t.scale, t.yaw, stats, trees + seed * 17);
        trees++;
    }
    trees += drawStand(world, YARD_FORESTRY, stats);
    let rocks = 0;
    for (const k of layout.rocks) {
        rock(world, k.x, k.z, yardSurfaceY(k.x, k.z), k.rx, k.ry, k.rz, k.yaw, stats, rocks + 5);
        rocks++;
    }
    rasterizePieces(world, layout.pieces, stats);

    // reeds and flowers: single-cell columns, grid aligned by construction
    const r = rng(seed * 13 + 1);
    let reeds = 0;
    for (let n = 0; n < 260; n++) {
        const x = B.minX + 1 + r() * (B.maxX - B.minX - 2);
        const side = r() < 0.5 ? -1 : 1;
        const z = creekCenterZ(x) + side * (creekHalfWidth(x) + 0.35 + r() * 0.8);
        if (Math.abs(x - BRIDGE_X) < 2) continue;
        const i = cellIndexX(x);
        const k = cellIndexZ(z);
        const top = yardTopCell(cellCenterX(i), cellCenterZ(k));
        if (yardWeight(x, z) > 0.3) continue;
        const h = Math.round((0.15 + r() * r() * 0.5) / GRID_SIZE);
        for (let j = 1; j <= h; j++) world.setStatic(i, top + j, k, voxel(M.Reed, (j + n) & 3), 1);
        reeds++;
    }
    for (let n = 0; n < 70; n++) {
        const x = -24 + r() * 48;
        const z = -6 - r() * 14;
        if (onRoad(x, z) < 1.8) continue;
        const i = cellIndexX(x);
        const k = cellIndexZ(z);
        world.setStatic(i, yardTopCell(cellCenterX(i), cellCenterZ(k)) + 1, k, voxel(M.Flower, r() < 0.3 ? 2 : 0), 1);
    }
    world.finalizeStatic();
    const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return { columns, staticCells: world.staticCellCount(), trees, rocks, reeds, stats, ms: t1 - t0 };
}

const at = (x: number, y: number, z: number, yaw = 0, pitch = 0, roll = 0): Pose =>
    pose(x, y, z, quatFromYawPitchRoll(yaw, pitch, roll));
const FLAT = Math.PI / 2; // planks and beams lie on their wide face

/** The sawmill: infeed (east) towards the logging stand, outfeed rack (west) towards the yard. */
const SAWMILL_SPOT = { x: 4.6, z: 9.6, yaw: 0, y: YARD_Y };

/**
 * Logging (Epic 6): a stand of six pines east of the yard, 3 m apart (a felled trunk never reaches
 * a neighbour's) and far enough from the play area's edge that none falls against its wall, and
 * the sawmill between it and the yard. The axe lies by the infeed.
 */
export const YARD_FORESTRY: ForestryDef = {
    trees: [
        // leans (rad, towards x/z): their weight pulls the fall their way; tree 0 leans hard north,
        // more than a cut's push, so it falls north whichever side it is cut from
        { x: 13.0, z: 4.3, yaw: 0.3, lean: { x: 0, z: -0.11 } },
        { x: 16.0, z: 4.5, yaw: 1.7 },
        { x: 13.1, z: 7.3, yaw: 2.9, lean: { x: -0.05, z: 0 } },
        { x: 16.1, z: 7.5, yaw: 4.1, lean: { x: 0.04, z: 0.03 } },
        { x: 12.9, z: 10.3, yaw: 5.3, lean: { x: -0.03, z: 0 } },
        { x: 16.0, z: 10.5, yaw: 0.9, lean: { x: 0.05, z: -0.02 } }
    ],
    sawmill: SAWMILL_SPOT,
    axe: pose(8.4, YARD_Y + 0.06, 8.5, quatFromYawPitchRoll(0.3, 0, Math.PI / 2)),
    ground: (x, z) => yardSurfaceY(x, z)
};

/** Where the yard's dynamic props start. */
export function yardProps(): PropPlacement[] {
    const P: PropPlacement[] = [];
    // plank stack by the shed: six planks, long axis X, flat
    const plankNames = ['plank', 'extra-plank-0', 'extra-plank-1', 'extra-plank-2', 'extra-plank-3', 'extra-plank-4'];
    plankNames.forEach((name, n) =>
        P.push({ name, pose: at(-4.6, YARD_Y + 0.055 + n * 0.105, 6 + (n % 2) * 0.04, 0, FLAT) })
    );
    // two beams near the creek
    P.push({ name: 'beam-0', pose: at(-2.2, YARD_Y + 0.08, 3.3, 0.06, FLAT) });
    P.push({ name: 'beam-1', pose: at(-2.2, YARD_Y + 0.08, 3.85, 0.06, FLAT) });
    // log pile: two side by side, one on top
    P.push({ name: 'log', pose: at(7.2, YARD_Y + 0.21, 7.1, Math.PI / 2) });
    P.push({ name: 'extra-log-0', pose: at(7.62, YARD_Y + 0.21, 7.1, Math.PI / 2) });
    P.push({ name: 'extra-log-1', pose: at(7.41, YARD_Y + 0.58, 7.1, Math.PI / 2) });
    P.push({ name: 'cube', pose: at(-8.4, YARD_Y + 0.26, 7.6, 0.3) });
    P.push({ name: 'bucket', pose: at(BUCKET_STUMP.x, BUCKET_STUMP.top + 0.01, BUCKET_STUMP.z, 0.4) });
    P.push({ name: 'held-plank', pose: at(-5, YARD_Y + 0.06, 11, 0, FLAT) });
    return P;
}

/** The flood gauge post, upstream of the crossing by the near bank. */
export const FLOOD_GAUGE = { x: BRIDGE_X - 2.1, z: BRIDGE.nearEdge - 0.45 };
/** The flood's peak: over the capstones (0.5 / 0.6 m), a hand above the banks. */
export const FLOOD_PEAK_Y = 0.6;

/**
 * Where the flood leaves the timber it took: the near bank downstream of the yard, side by side,
 * in the clear (between the sign and the oak, and past the rock), so each piece can be picked up
 * by either end.
 */
function floodWashup(): { x: number; y: number; z: number }[] {
    return [
        [8, 0.6],
        [8, 1.0],
        [14.4, 0.6],
        [14.4, 1.0]
    ].map(([x, out]) => {
        const z = creekCenterZ(x) + creekHalfWidth(x) + out;
        // dropped onto the highest ground under a 3.2 m beam's whole length (the bank is uneven)
        let top = -Infinity;
        for (let dx = -1.7; dx <= 1.7; dx += 0.1)
            for (const dz of [-0.15, 0, 0.15]) top = Math.max(top, yardHeight(x + dx, z + dz));
        return { x, y: top + 0.2, z };
    });
}

export const timberYardLevel: LevelDef = {
    id: 'yard',
    name: 'Timber Yard',
    bounds: YARD_BOUNDS,
    playArea: { minX: -26, maxX: 26, minZ: -20, maxZ: 13 },
    water: { y: CREEK_WATER_Y, cx: 0, cz: -2, halfX: 28, halfZ: 2.95 },
    terrainHeight: yardHeight,
    layout: yardLayout,
    build: buildTimberYard,
    // early sunrise over the creek; a north-westerly breeze with gusts down the valley
    sun: { elevation: 7, azimuth: 105 },
    wind: { dir: Math.PI * 0.3, base: 1.4, gust: 3.6 },
    windsock: WINDSOCK,
    // the world fights back (Epic 8): finishing the bridge brings the flood; carrying a plank by
    // the creek brings a gust aimed at it
    hazards: {
        seed: 1,
        flood: {
            peakY: FLOOD_PEAK_Y,
            current: { x: 1.3, z: 0 },
            crossing: { x: BRIDGE_X, halfX: BRIDGE.halfWidth + 0.3, z0: BRIDGE.nearFace, z1: BRIDGE.farFace },
            washup: floodWashup()
        },
        gust: { force: 1050 },
        // parked on a slope (3.5 degrees or more) and left: the handbrake lets go
        handbrake: { slope: 0.06 }
    },
    spawn: { x: 1.2, z: 6.2, yaw: 0.12, pitch: -0.1 },
    orbitHome: { pos: [9, 4.2, 12], focus: [-1, 0.5, 0] },
    startFirstPerson: true,
    actors: {
        beaver: { mode: 'idle', pose: at(-6.3, YARD_Y, 7.4, 2.4) },
        ute: { mode: 'drivable', pose: at(-10.5, YARD_Y + 0.002, 4.6, Math.PI / 2 + 0.15) }
    },
    props: yardProps(),
    forestry: YARD_FORESTRY,
    rules: {
        objective: 'Get the bucket of water across the creek to the flag',
        goal: YARD_GOAL,
        minLitres: 0.25,
        waterSources: [yardButt().source],
        fallY: -0.2,
        isSafe: (x, z) => Math.abs(z - creekCenterZ(x)) > creekHalfWidth(x) + 0.9,
        lostY: CREEK_WATER_Y + 0.15
    },
    scriptedProps: false
};
