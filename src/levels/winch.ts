/**
 * The hand winch's scenery (Epic 5, #52): a base plate staked into the ground, two posts, a drum
 * between them with the rope coiled on it, and a crank. Static pieces of the level (they collide,
 * so a hauled log stops against the drum); what it does is src/sim/winch.ts.
 */

import type { WinchSpot } from '../sim/winch.ts';
import { WINCH } from '../sim/winch.ts';
import { pose, quatFromYawPitchRoll, quatRotate } from '../voxels/math.ts';
import { M, voxel } from '../voxels/palette.ts';
import { latticeShade, solid } from '../voxels/volumes.ts';
import type { MaterialField } from '../voxels/volumes.ts';

import type { StaticPiece } from './level.ts';

const steel: MaterialField = solid(M.Steel, 1);
const dark: MaterialField = solid(M.UteTrim, 0);
const rope: MaterialField = (x, y, z) => voxel(M.LogBark, latticeShade(x, y, z, 0.05, 3) & 1);

/** The winch's static pieces at `s` (its drum's axle runs across its yaw). */
export function winchPieces(s: WinchSpot): StaticPiece[] {
    const q = quatFromYawPitchRoll(s.yaw, 0, 0);
    const P: StaticPiece[] = [];
    const v = { x: 0, y: 0, z: 0 };
    const add = (
        name: string,
        shape: StaticPiece['shape'],
        lx: number,
        ly: number,
        lz: number,
        field: MaterialField,
        collide = true
    ) => {
        quatRotate(q, lx, ly, lz, v);
        P.push({ name, shape, pose: pose(s.x + v.x, s.y + ly, s.z + v.z, { ...q }), field, collide, priority: 3 });
    };
    const h = WINCH.drumHeight;
    add('winch-base', { type: 'box', hx: 0.36, hy: 0.03, hz: 0.16 }, 0, 0.03, 0, dark);
    for (const x of [-0.27, 0.27])
        add('winch-post', { type: 'box', hx: 0.05, hy: (h + 0.12) / 2, hz: 0.06 }, x, (h + 0.12) / 2, 0, steel);
    // the drum, its axle across the posts, with the rope coiled on it
    add('winch-drum', { type: 'cylinder', axis: 'x', r: 0.13, half: 0.21 }, 0, h, 0, rope);
    // the crank on the right-hand post, its handle out to the side
    add('winch-crank', { type: 'box', hx: 0.02, hy: 0.14, hz: 0.02 }, 0.34, h + 0.07, 0, steel, false);
    add('winch-handle', { type: 'box', hx: 0.07, hy: 0.02, hz: 0.02 }, 0.4, h + 0.2, 0, dark, false);
    return P;
}
