/**
 * A header tank with a tap (Epic 7): the clean refill point levels place on purpose. A timber
 * barrel with steel hoops up on a slim post, out of everyone's way (players walk under it), and a
 * pipe down to a tap over the spot where a bucket stands to be filled. The post and the barrel are
 * solid; the pipe and the tap are not (a hanging bucket swings under them). The spot is the level's
 * water source (an upright bucket there fills while the tank has water).
 */

import { pose, quatFromYawPitchRoll } from '../voxels/math.ts';
import { M, voxel } from '../voxels/palette.ts';
import { latticeShade } from '../voxels/volumes.ts';

import type { StaticPiece, WaterSource } from './level.ts';

/** Barrel radius and half height, and how far its centre stands from the fill spot. */
const R = 0.32;
const HALF = 0.4;
const OFFSET = 0.9;
/** The barrel's underside above the ground: clear over a player's head (the capsule is 1.4 m). */
const LIFT = 1.65;

/**
 * The pieces and the source of a tank whose tap fills a bucket standing at (x, z) on ground at
 * `floorY` (a stump top, the ground). Its post stands `OFFSET` m away along `dir` (radians about
 * +y, 0 = +x), on ground at `groundY`.
 */
export function waterButt(
    name: string,
    x: number,
    z: number,
    floorY: number,
    groundY: number,
    dir: number,
    litres: number
): { pieces: StaticPiece[]; source: WaterSource } {
    const ux = Math.cos(dir);
    const uz = -Math.sin(dir);
    const bx = x + ux * OFFSET;
    const bz = z + uz * OFFSET;
    const base = groundY + LIFT;
    const q = quatFromYawPitchRoll(dir, 0, 0);
    const staves = (sx: number, sy: number, sz: number) => {
        // steel hoops near the ends, timber staves between, a wet dark rim of water on top
        if (Math.abs(sy - 0.26) < 0.03 || Math.abs(sy + 0.26) < 0.03) return voxel(M.Steel, 1);
        if (sy > HALF - 0.03 && Math.hypot(sx, sz) < R - 0.04) return voxel(M.BucketWater, 2);
        const a = Math.atan2(sz, sx);
        return voxel(M.Timber, (Math.floor((a / Math.PI) * 9 + 9) & 1) * 2 + (latticeShade(sx, sy, sz, 0.2, 5) & 1));
    };
    const steel = () => voxel(M.Steel, 2);
    // the pipe: out under the barrel towards the spot, then down to the tap, high enough over the
    // spot to clear a bucket's handle
    const spoutY = floorY + 0.56;
    const armY = base - 0.06;
    const armLen = OFFSET - 0.06;
    const tx = x + ux * 0.06;
    const tz = z + uz * 0.06;
    const pieces: StaticPiece[] = [
        {
            name: `${name}-post`,
            shape: { type: 'cylinder', axis: 'y', r: 0.06, half: (LIFT + 0.08) / 2 },
            pose: pose(bx, groundY - 0.08 + (LIFT + 0.08) / 2, bz, q),
            field: (sx, sy, sz) => voxel(M.LogBark, latticeShade(sx, sy, sz, 0.2, 7) & 1),
            collide: true,
            priority: 2
        },
        {
            name: `${name}-barrel`,
            shape: { type: 'cylinder', axis: 'y', r: R, half: HALF },
            pose: pose(bx, base + HALF, bz, q),
            field: staves,
            collide: true,
            priority: 2
        },
        {
            name: `${name}-pipe-arm`,
            shape: { type: 'box', hx: armLen / 2, hy: 0.03, hz: 0.03 },
            pose: pose(bx - ux * (armLen / 2), armY, bz - uz * (armLen / 2), q),
            field: steel,
            collide: false,
            priority: 3
        },
        {
            name: `${name}-pipe-down`,
            shape: { type: 'box', hx: 0.03, hy: (armY - spoutY) / 2, hz: 0.03 },
            pose: pose(tx, (armY + spoutY) / 2, tz, q),
            field: steel,
            collide: false,
            priority: 3
        },
        {
            name: `${name}-tap`,
            shape: { type: 'box', hx: 0.04, hy: 0.05, hz: 0.04 },
            pose: pose(tx, spoutY - 0.05, tz, q),
            field: () => voxel(M.HiVis, 1),
            collide: false,
            priority: 3
        }
    ];
    return { pieces, source: { name, x, z, r: 0.32, y: floorY - 0.05, h: 0.75, litres } };
}
