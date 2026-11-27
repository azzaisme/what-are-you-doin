/**
 * The road closure's pieces (Epic 8, #77, src/sim/hazard-road.ts):
 *
 * - barrier: a long striped board on three trestles, set across the road. Its origin is the middle
 *   of its collision box (BARRIER_HALF), as the physics body's is;
 * - closure sign: a post at the side track's mouth carrying a board with two faces, back to back:
 *   the road goes on (an arrow straight up, on the area's colour) and closed (orange and cream, an
 *   arrow down the track). Its channel swings the board over, 0 (the road goes on) to 1 (closed).
 */

import { SIGN_BOARD, signFace } from '../levels/route-signs.ts';
import { GRID_SIZE } from '../voxels/grid.ts';
import { composePose, pose, quatFromYawPitchRoll } from '../voxels/math.ts';
import type { Pose } from '../voxels/math.ts';
import { M, voxel } from '../voxels/palette.ts';
import { box, latticeShade } from '../voxels/volumes.ts';
import type { MaterialField } from '../voxels/volumes.ts';

import { ASSET_SCHEMA_VERSION } from './asset.ts';
import type { AssetPart, VoxelAsset } from './asset.ts';

/** The barrier's collision box (half extents, m): 5.6 m across the road (1.2 m past each edge), 1.1 m high, 0.6 m deep. */
export const BARRIER_HALF = { x: 2.8, y: 0.55, z: 0.3 };
/**
 * How fast a lone player's hand swings round with their view while holding the barrier (m/s):
 * heavy to swing round (BodyOptions.handSpeed).
 */
export const BARRIER_HAND_SPEED = 1.5;

const timber: MaterialField = (x, y, z) => voxel(M.LogBark, latticeShade(x, y, z, 0.2, 6) & 1);

/** Hi-vis orange and cream stripes, 40 cm wide, slanting. */
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

/** How high the sign's board stands (its centre, m above the foot). */
const SIGN_TOP = 1.6;

/**
 * The closure sign's board (half size, m): 24 x 12 pixels of 10 cm. Big enough for its words in
 * 5 cm letters and the arrow in 10 cm pixels; the open face is the route sign (SIGN_BOARD) in the
 * middle of it, on timber.
 */
export const CLOSURE_BOARD = { hx: 1.2, hy: 0.6 };
const POST_HALF = (SIGN_TOP + CLOSURE_BOARD.hy) / 2;

/** 3 x 5 letters (top row first, '#' painted) for the closed face. */
const LETTERS: Record<string, string[]> = {
    A: ['.#.', '#.#', '###', '#.#', '#.#'],
    C: ['.##', '#..', '#..', '#..', '.##'],
    D: ['##.', '#.#', '#.#', '#.#', '##.'],
    E: ['###', '#..', '##.', '#..', '###'],
    L: ['#..', '#..', '#..', '#..', '###'],
    O: ['###', '#.#', '#.#', '#.#', '###'],
    R: ['##.', '#.#', '##.', '#.#', '#.#'],
    S: ['.##', '#..', '.#.', '..#', '##.'],
    T: ['###', '.#.', '.#.', '.#.', '.#.'],
    U: ['#.#', '#.#', '#.#', '#.#', '###']
};

/** 5 x 5 arrows for the closed face (in 10 cm pixels), top row first. */
const CLOSED_ARROWS: Record<'left' | 'right', string[]> = {
    left: ['..#..', '.#...', '#####', '.#...', '..#..'],
    right: ['..#..', '...#.', '#####', '...#.', '..#..']
};

/** A line of letters (5 cm pixels; a space is half a letter): is (col, row) of it painted? */
function textLit(text: string, col: number, row: number): boolean {
    if (row < 0 || row >= 5 || col < 0) return false;
    let c = col;
    for (const ch of text) {
        const w = ch === ' ' ? 2 : 4;
        if (c < w) return ch !== ' ' && c < 3 && LETTERS[ch][row][c] === '#';
        c -= w;
    }
    return false;
}

/**
 * The closed face, read across the board (board-local m, x to the reader's right, y up): an orange and
 * cream striped border (10 cm), and on cream "ROAD CLOSED" in black 5 cm letters, then "DETOUR" and
 * a big orange arrow (10 cm pixels) towards the track. Every pixel falls on whole 5 or 10 cm cells (the
 * board stands on 10 cm lines: src/levels/valley.ts).
 */
function closedFace(arrow: 'left' | 'right'): MaterialField {
    const B = CLOSURE_BOARD;
    const arrowRows = CLOSED_ARROWS[arrow];
    return (x, y, z) => {
        // from the board's top left corner (m)
        const fx = x + B.hx;
        const fy = B.hy - y;
        if (fx < 0.1 || fx > 2 * B.hx - 0.1 || fy < 0.1 || fy > 2 * B.hy - 0.1) return stripes(x, y, z);
        // the words need cells of 5 cm or less (at 10 cm they would be noise: there the board shows
        // its stripes and the arrow)
        if (GRID_SIZE < 0.075) {
            // line 1: ROAD CLOSED, 0.2 m from the top, from 0.15 m in
            if (textLit('ROAD CLOSED', Math.floor((fx - 0.15) / 0.05), Math.floor((fy - 0.2) / 0.05)))
                return voxel(M.Tyre, 0);
            // line 2: DETOUR, 0.65 m down, from 0.3 m in
            if (textLit('DETOUR', Math.floor((fx - 0.3) / 0.05), Math.floor((fy - 0.65) / 0.05)))
                return voxel(M.Tyre, 0);
        }
        // the arrow: 10 cm pixels, 0.5 m down and 1.6 m in (whole 10 cm cells: the board's top
        // and left edges stand on 10 cm lines)
        const ac = Math.floor((fx - 1.6) / 0.1);
        const ar = Math.floor((fy - 0.5) / 0.1);
        if (ac >= 0 && ac < 5 && ar >= 0 && ar < 5 && arrowRows[ar][ac] === '#') return voxel(M.HiVis, 0);
        return voxel(M.HiVisStripe, 0);
    };
}

/**
 * The open face: the route sign ("2", straight on) in the middle of the board, on timber, raised
 * half a pixel (it is 7 pixels tall on a board of 12) so its pixels too fall on whole cells.
 */
function openFace(colour: number): MaterialField {
    const route = signFace({ number: 2, arrow: 'up', colour });
    return (x, y, z) =>
        Math.abs(x) < SIGN_BOARD.hx && Math.abs(y - 0.05) < SIGN_BOARD.hy
            ? route(x, y - 0.05, z)
            : voxel(M.LogBark, latticeShade(x, y, z, 0.2, 6) & 1);
}

/**
 * The sign: `colour` is the area's on its open face (the road goes on: the route sign's "2" and an
 * arrow straight up), `towardsTrack` the arrow on the closed face. Its root is the post's foot; the
 * board's open face looks along the root's +z (at oncoming traffic) at swing 0, and turns half round
 * by swing 1.
 */
export function closureSignAsset(colour: number, towardsTrack: 'left' | 'right'): VoxelAsset {
    const B = CLOSURE_BOARD;
    const parts: AssetPart[] = [
        { name: 'closure-post', volume: box(0.06, POST_HALF, 0.06, timber), priority: 2, refColor: 0x7a5a3a },
        {
            name: 'closure-open',
            volume: box(B.hx, B.hy, 0.05, openFace(colour)),
            priority: 3,
            refColor: 0x3a7a3a
        },
        {
            name: 'closure-closed',
            volume: box(B.hx, B.hy, 0.05, closedFace(towardsTrack)),
            priority: 3,
            refColor: 0xe05030
        }
    ];
    // the post stands beside the board (clear of it as it turns); the board turns about its middle
    const post = pose(B.hx + 0.1, POST_HALF - 0.05, 0);
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
