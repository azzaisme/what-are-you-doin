/**
 * The road closure's pieces (Epic 8, #77, src/sim/hazard-road.ts):
 *
 * - barrier: a long striped board on three trestles, set across the road. Its origin is the middle
 *   of its collision box (BARRIER_HALF), as the physics body's is;
 * - closure sign: a post at the side track's mouth carrying a board with two faces, back to back:
 *   the road goes on (an arrow straight up, on the area's colour) and closed (red and white, an
 *   arrow down the track). Its channel swings the board over, 0 (the road goes on) to 1 (closed).
 */

import { SIGN_BOARD, SIGN_PIXEL, signFace } from '../levels/route-signs.ts';
import { composePose, pose, quatFromYawPitchRoll } from '../voxels/math.ts';
import type { Pose } from '../voxels/math.ts';
import { M, voxel } from '../voxels/palette.ts';
import { box, latticeShade } from '../voxels/volumes.ts';
import type { MaterialField } from '../voxels/volumes.ts';

import { ASSET_SCHEMA_VERSION } from './asset.ts';
import type { AssetPart, VoxelAsset } from './asset.ts';

/** The barrier's collision box (half extents, m): 5.6 m across the road (1.2 m past each edge), 1.1 m high, 0.6 m deep. */
export const BARRIER_HALF = { x: 2.8, y: 0.55, z: 0.3 };

const timber: MaterialField = (x, y, z) => voxel(M.LogBark, latticeShade(x, y, z, 0.2, 6) & 1);

/** Red and white stripes, 40 cm wide, slanting. */
const stripes: MaterialField = (x, y) => voxel(Math.floor((x + y) / 0.4) & 1 ? M.HiVis : M.HiVisStripe, 0);

export function barrierAsset(): VoxelAsset {
    const h = BARRIER_HALF;
    const parts: AssetPart[] = [];
    const offsets: Pose[] = [];
    // the board, near the top
    parts.push({ name: 'barrier-board', volume: box(h.x, 0.15, 0.04, stripes), priority: 3, refColor: 0xe05030 });
    offsets.push(pose(0, h.y - 0.2, 0));
    // three trestles: two splayed legs each, foot to board
    for (const x of [-h.x + 0.3, 0, h.x - 0.3])
        for (const side of [-1, 1]) {
            parts.push({
                name: 'barrier-leg',
                volume: box(0.04, h.y - 0.05, 0.04, timber),
                priority: 2,
                refColor: 0x7a5a3a
            });
            offsets.push(pose(x, -0.05, side * (h.z - 0.12), quatFromYawPitchRoll(0, side * 0.32, 0)));
        }
    return {
        schema: ASSET_SCHEMA_VERSION,
        name: 'barrier',
        parts,
        animChannels: 0,
        cellTier: 'base',
        evaluate(root: Pose, _anim: ArrayLike<number>, out: Pose[]) {
            for (let i = 0; i < parts.length; i++) composePose(root, offsets[i], out[i]);
        }
    };
}

/** How high the sign's board stands (its centre, m above the foot), and the post's half height. */
const SIGN_TOP = 1.6;
const POST_HALF = (SIGN_TOP + SIGN_BOARD.hy) / 2;

/** 5 x 5 arrows for the closed face, top row first ('#' painted). */
const CLOSED_ARROWS: Record<'left' | 'right', string[]> = {
    left: ['..#..', '.#...', '#####', '.#...', '..#..'],
    right: ['..#..', '...#.', '#####', '...#.', '..#..']
};

/** The closed face: red and white stripes round the edge, a red arrow (down the track) on white. */
function closedFace(arrow: 'left' | 'right'): MaterialField {
    const rows = CLOSED_ARROWS[arrow];
    const P = SIGN_PIXEL;
    return (x, y, z) => {
        const col = Math.floor((x + SIGN_BOARD.hx) / P);
        const row = Math.floor((SIGN_BOARD.hy - y) / P);
        // a one-pixel striped border (14 x 7 pixels)
        if (col < 1 || col > 12 || row < 1 || row > 5) return stripes(x, y, z);
        // the arrow, 5 x 5, in the middle (columns 4-8, rows 1-5)
        const c = col - 4;
        const r = row - 1;
        const lit = c >= 0 && c < 5 && r >= 0 && r < 5 && rows[r][c] === '#';
        return voxel(lit ? M.HiVis : M.HiVisStripe, 0);
    };
}

/**
 * The sign: `open` is the face that says the road goes on (the area's colour, arrow straight up),
 * `towardsTrack` the arrow on the closed face. Its root is the post's foot; the board's open face
 * looks along the root's +z (at oncoming traffic) at swing 0, and turns half round by swing 1.
 */
export function closureSignAsset(colour: number, towardsTrack: 'left' | 'right'): VoxelAsset {
    const parts: AssetPart[] = [
        { name: 'closure-post', volume: box(0.06, POST_HALF, 0.06, timber), priority: 2, refColor: 0x7a5a3a },
        {
            name: 'closure-open',
            volume: box(SIGN_BOARD.hx, SIGN_BOARD.hy, 0.05, signFace({ number: 2, arrow: 'up', colour })),
            priority: 3,
            refColor: 0x3a7a3a
        },
        {
            name: 'closure-closed',
            volume: box(SIGN_BOARD.hx, SIGN_BOARD.hy, 0.05, closedFace(towardsTrack)),
            priority: 3,
            refColor: 0xe05030
        }
    ];
    // the post stands beside the board (clear of it as it turns); the board turns about its middle
    const post = pose(SIGN_BOARD.hx + 0.1, POST_HALF - 0.05, 0);
    const front = pose(0, 0, 0.05);
    const behind = pose(0, 0, -0.05, quatFromYawPitchRoll(Math.PI, 0, 0));
    const pivot = pose();
    return {
        schema: ASSET_SCHEMA_VERSION,
        name: 'closure-sign',
        parts,
        animChannels: 1,
        cellTier: 'base',
        evaluate(root: Pose, anim: ArrayLike<number>, out: Pose[]) {
            composePose(root, post, out[0]);
            // swing 0: the open face looks along +z (at oncoming traffic); 1: turned half round
            const swing = Math.max(0, Math.min(1, anim[0] || 0));
            const q = quatFromYawPitchRoll(swing * Math.PI, 0, 0);
            pivot.p.x = 0;
            pivot.p.y = SIGN_TOP;
            pivot.p.z = 0;
            pivot.q.x = q.x;
            pivot.q.y = q.y;
            pivot.q.z = q.z;
            pivot.q.w = q.w;
            composePose(root, pivot, out[1]);
            composePose(out[1], behind, out[2]);
            composePose(out[1], front, out[1]);
        }
    };
}
