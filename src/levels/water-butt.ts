/**
 * A water butt with a tap (Epic 7): the clean refill point levels place on purpose. A timber barrel
 * with steel hoops and a spout reaching out over the spot where a bucket stands to be filled. The
 * spot is the level's water source (an upright bucket there fills while the butt has water).
 */

import { pose, quatFromYawPitchRoll } from '../voxels/math.ts';
import { M, voxel } from '../voxels/palette.ts';
import { latticeShade } from '../voxels/volumes.ts';

import type { StaticPiece, WaterSource } from './level.ts';

/** Barrel radius and height, and how far its centre stands from the fill spot. */
const R = 0.32;
const HALF = 0.5;
const OFFSET = 0.62;

/**
 * The pieces and the source of a butt whose tap fills a bucket standing at (x, z) on ground at
 * `floorY` (a stump top, the ground). The barrel stands `OFFSET` m away along `dir` (radians about
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
    const by = groundY - 0.08 + HALF;
    const q = quatFromYawPitchRoll(dir, 0, 0);
    const staves = (sx: number, sy: number, sz: number) => {
        // steel hoops near the ends, timber staves between, a wet dark rim of water on top
        if (Math.abs(sy - 0.32) < 0.03 || Math.abs(sy + 0.32) < 0.03) return voxel(M.Steel, 1);
        if (sy > HALF - 0.03 && Math.hypot(sx, sz) < R - 0.04) return voxel(M.BucketWater, 2);
        const a = Math.atan2(sz, sx);
        return voxel(M.Timber, (Math.floor((a / Math.PI) * 9 + 9) & 1) * 2 + (latticeShade(sx, sy, sz, 0.2, 5) & 1));
    };
    // the spout: out of the barrel's side towards the spot, high enough to clear the bucket's handle
    const spoutY = floorY + 0.56;
    const spoutLen = OFFSET - R + 0.02;
    const pieces: StaticPiece[] = [
        {
            name: `${name}-barrel`,
            shape: { type: 'cylinder', axis: 'y', r: R, half: HALF },
            pose: pose(bx, by, bz, q),
            field: staves,
            collide: true,
            priority: 2
        },
        {
            name: `${name}-spout`,
            shape: { type: 'box', hx: spoutLen / 2, hy: 0.035, hz: 0.035 },
            pose: pose(bx - ux * (R + spoutLen / 2 - 0.04), spoutY, bz - uz * (R + spoutLen / 2 - 0.04), q),
            field: () => voxel(M.Steel, 2),
            collide: false,
            priority: 3
        },
        {
            name: `${name}-tap`,
            shape: { type: 'box', hx: 0.03, hy: 0.05, hz: 0.03 },
            pose: pose(x + ux * 0.06, spoutY - 0.05, z + uz * 0.06, q),
            field: () => voxel(M.HiVis, 1),
            collide: false,
            priority: 3
        }
    ];
    return { pieces, source: { name, x, z, r: 0.32, y: floorY - 0.05, h: 0.75, litres } };
}
