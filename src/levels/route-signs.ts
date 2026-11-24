/**
 * Route signs for the journey (design doc §8, Epic 9): a timber board on two posts with the area's
 * number in big pixel digits and an arrow for the way on, on a band of the area's colour. Read at a
 * glance from the road at 5-10 cm voxels: one glyph pixel is 10 cm.
 *
 * Pure module (no engine). The board is a static piece; its material field paints the glyphs.
 */

import { pose, quatFromYawPitchRoll } from '../voxels/math.ts';
import type { Pose } from '../voxels/math.ts';
import { M, voxel } from '../voxels/palette.ts';
import { latticeShade } from '../voxels/volumes.ts';
import type { MaterialField } from '../voxels/volumes.ts';

import type { StaticPiece } from './level.ts';

/** One glyph pixel (m). */
export const SIGN_PIXEL = 0.1;

/** 3 x 5 digits, top row first ('#' lit). */
const DIGITS: Record<string, string[]> = {
    '0': ['###', '#.#', '#.#', '#.#', '###'],
    '1': ['.#.', '##.', '.#.', '.#.', '###'],
    '2': ['##.', '..#', '.#.', '#..', '###'],
    '3': ['##.', '..#', '.#.', '..#', '##.'],
    '4': ['#.#', '#.#', '###', '..#', '..#'],
    '5': ['###', '#..', '##.', '..#', '##.'],
    '6': ['.##', '#..', '###', '#.#', '###'],
    '7': ['###', '..#', '.#.', '.#.', '.#.'],
    '8': ['###', '#.#', '###', '#.#', '###'],
    '9': ['###', '#.#', '###', '..#', '##.']
};

/** 5 x 5 arrows: straight on, bear left, bear right. */
export type SignArrow = 'up' | 'left' | 'right';
const ARROWS: Record<SignArrow, string[]> = {
    up: ['..#..', '.###.', '#.#.#', '..#..', '..#..'],
    left: ['..#..', '.#...', '#####', '.#...', '..#..'],
    right: ['..#..', '...#.', '#####', '...#.', '..#..']
};

/** Whether glyph pixel (col, row) of `rows` is lit; outside it is unlit. */
function lit(rows: string[], col: number, row: number): boolean {
    return row >= 0 && row < rows.length && col >= 0 && col < rows[row].length && rows[row][col] === '#';
}

export interface SignFace {
    /** The area's number (1-9), drawn on the left. */
    number: number;
    /** The way on, drawn on the right. */
    arrow: SignArrow;
    /** The band's material (the area's colour). */
    colour: number;
}

/**
 * Board half extents (m): 14 x 7 glyph pixels (1.4 x 0.7 m), one pixel thick. Its edges and its
 * pixels fall on 10 cm lines, which are cell boundaries at both 5 and 10 cm voxels, so the glyphs come
 * out crisp (the board must be axis-aligned and snapped: see routeSign).
 */
export const SIGN_BOARD = { hx: 0.7, hy: 0.35, hz: 0.05 };

/**
 * The board's face, in board-local metres (x right as you read it, y up). In 10 cm pixels across the
 * 14 x 7 board: a one-pixel timber border; on the coloured band inside it, the digit (3 x 5) and the
 * arrow (5 x 5) in light paint, two pixels apart.
 */
export function signFace(face: SignFace): MaterialField {
    const digit = DIGITS[String(Math.max(0, Math.min(9, Math.round(face.number))))];
    const arrow = ARROWS[face.arrow];
    const P = SIGN_PIXEL;
    return (x, y, z) => {
        // pixel column from the left edge, row from the top edge
        const col = Math.floor((x + SIGN_BOARD.hx) / P);
        const row = Math.floor((SIGN_BOARD.hy - y) / P);
        if (col < 1 || col > 12 || row < 1 || row > 5) return voxel(M.LogBark, latticeShade(x, y, z, 0.2, 6) & 1);
        if (lit(digit, col - 2, row - 1) || lit(arrow, col - 7, row - 1)) return voxel(M.HiVisStripe, 0);
        return voxel(face.colour, 0);
    };
}

/** Snaps to the nearest multiple of 10 cm, plus `offset`. */
const snap = (v: number, offset = 0) => Math.round((v - offset) / SIGN_PIXEL) * SIGN_PIXEL + offset;

/**
 * A route sign standing at `foot` (its ground point). `quarter` turns it by multiples of 90 degrees
 * (0: the face looks along +z, read by someone looking along -z; 1: along +x... 3: along -x). The
 * board is snapped to 10 cm lines so the glyphs fall on whole cells.
 */
export function routeSign(
    foot: { x: number; y: number; z: number },
    quarter: 0 | 1 | 2 | 3,
    face: SignFace
): StaticPiece[] {
    const yaw = (quarter * Math.PI) / 2;
    const q = quatFromYawPitchRoll(yaw, 0, 0);
    const c = Math.round(Math.cos(yaw));
    const s = Math.round(Math.sin(yaw));
    const top = 1.6;
    // the board's centre: on 10 cm lines across and through it, half a pixel off them in height
    // (7 pixels tall)
    const bx = snap(foot.x);
    const bz = snap(foot.z);
    const by = snap(foot.y + top - SIGN_BOARD.hy, SIGN_PIXEL / 2);
    // local (lx, lz), turned by yaw about +y (local +z goes to (sin yaw, cos yaw))
    const at = (lx: number, y: number, lz: number): Pose => pose(bx + lx * c + lz * s, y, bz - lx * s + lz * c, q);
    const post: MaterialField = (x, y, z) => voxel(M.LogBark, latticeShade(x, y, z, 0.2, 6) & 1);
    const postTop = by + SIGN_BOARD.hy - 0.05;
    const postHalf = (postTop - foot.y + 0.3) / 2;
    return [
        ...[-1, 1].map((side): StaticPiece => ({
            name: 'route-sign-post',
            shape: { type: 'box', hx: 0.06, hy: postHalf, hz: 0.06 },
            // behind the board, sunk 30 cm into the ground
            pose: at(side * (SIGN_BOARD.hx - 0.16), postTop - postHalf, -0.11),
            field: post,
            collide: true,
            priority: 2
        })),
        {
            name: 'route-sign',
            shape: { type: 'box', ...SIGN_BOARD },
            pose: at(0, by, 0),
            field: signFace(face),
            collide: true,
            priority: 3
        }
    ];
}
