import { describe, expect, it } from 'vitest';

import { rasterizePieces } from '../../src/levels/level.ts';
import type { StaticPiece } from '../../src/levels/level.ts';
import { SIGN_BOARD, SIGN_PIXEL, routeSign } from '../../src/levels/route-signs.ts';
import type { SignArrow } from '../../src/levels/route-signs.ts';
import { STAGE_COLOURS, roadT, routeT, routeToWorld, routeU, valleyLayout } from '../../src/levels/valley.ts';
import { GRID_SIZE, cellIndexX, cellIndexY, cellIndexZ } from '../../src/voxels/grid.ts';
import { M, voxelMaterial } from '../../src/voxels/palette.ts';
import { createRasterStats } from '../../src/voxels/rasterizer.ts';
import { VoxelWorld } from '../../src/voxels/world.ts';

/**
 * Reads a sign's face back from the voxels: one character per 10 cm glyph pixel inside the border
 * ('#' light paint, '.' the band, 'x' anything else), looking at the face from the front.
 */
function readFace(quarter: 0 | 1 | 2 | 3, number: number, arrow: SignArrow, foot = { x: 1.234, y: 0.517, z: -2.71 }) {
    return readBoard(routeSign(foot, quarter, { number, arrow, colour: M.TestBlue }), M.TestBlue);
}

/** The quarter turn of a sign board from its pose (its yaw is a multiple of 90 degrees). */
function quarterOf(board: StaticPiece): 0 | 1 | 2 | 3 {
    const q = board.pose.q;
    const yaw = 2 * Math.atan2(q.y, q.w);
    return (((Math.round(yaw / (Math.PI / 2)) % 4) + 4) % 4) as 0 | 1 | 2 | 3;
}

/** Reads a voxelized board's face back (see readFace); `band` is its band material. */
function readBoard(pieces: StaticPiece[], band: number) {
    const w = new VoxelWorld();
    rasterizePieces(w, pieces, createRasterStats());
    const board = pieces.find((p) => p.name === 'route-sign')!;
    const c = board.pose.p;
    const quarter = quarterOf(board);
    const yaw = (quarter * Math.PI) / 2;
    // the reader's right and the face's outward normal, in the world
    const right = { x: Math.round(Math.cos(yaw)), z: -Math.round(Math.sin(yaw)) };
    const out = { x: Math.round(Math.sin(yaw)), z: Math.round(Math.cos(yaw)) };
    const rows: string[] = [];
    for (let row = 1; row <= 5; row++) {
        let line = '';
        for (let col = 1; col <= 12; col++) {
            // the pixel's centre, just inside the front face
            const lx = -SIGN_BOARD.hx + (col + 0.5) * SIGN_PIXEL;
            const ly = SIGN_BOARD.hy - (row + 0.5) * SIGN_PIXEL;
            const d = SIGN_BOARD.hz - GRID_SIZE / 2;
            const x = c.x + right.x * lx + out.x * d;
            const z = c.z + right.z * lx + out.z * d;
            const m = voxelMaterial(w.staticAt(cellIndexX(x), cellIndexY(c.y + ly), cellIndexZ(z)));
            line += m === M.HiVisStripe ? '#' : m === band ? '.' : 'x';
        }
        rows.push(line);
    }
    return rows;
}

describe('route signs', () => {
    it('the digit and the arrow come out cell-exact on the face, whichever way the sign turns', () => {
        for (const quarter of [0, 1, 2, 3] as const) {
            expect(readFace(quarter, 3, 'up'), `quarter ${quarter}`).toEqual([
                '.##.....#...',
                '...#...###..',
                '..#...#.#.#.',
                '...#....#...',
                '.##.....#...'
            ]);
        }
        expect(readFace(3, 7, 'right')).toEqual([
            '.###....#...',
            '...#.....#..',
            '..#...#####.',
            '..#......#..',
            '..#.....#...'
        ]);
    });

    it('stands on the ground with its board at reading height', () => {
        const foot = { x: 4.04, y: 1.13, z: 7.77 };
        const pieces = routeSign(foot, 0, { number: 5, arrow: 'left', colour: M.Brick });
        const board = pieces.find((p) => p.name === 'route-sign')!;
        expect(board.pose.p.y - SIGN_BOARD.hy - foot.y).toBeGreaterThan(0.8);
        expect(board.pose.p.y + SIGN_BOARD.hy - foot.y).toBeLessThan(1.8);
        for (const post of pieces.filter((p) => p.name === 'route-sign-post')) {
            const s = post.shape as { hy: number };
            expect(post.pose.p.y - s.hy).toBeLessThan(foot.y);
        }
    });

    it('the Valley signs: numbered 3 to 7 up the road, facing players coming up it, arrows where the road bends', () => {
        const pieces = valleyLayout(1).pieces;
        const boards = pieces
            .filter((p) => p.name === 'route-sign')
            .map((b) => ({ b, u: routeU(b.pose.p.x, b.pose.p.z), t: routeT(b.pose.p.x, b.pose.p.z) }))
            .sort((a, b) => a.u - b.u);
        expect(boards.length).toBe(5);
        boards.forEach(({ b, u, t }, n) => {
            const stage = n + 2;
            // its posts are the two nearest route-sign-posts
            const posts = pieces
                .filter((p) => p.name === 'route-sign-post')
                .sort((p, q) => dist2(p, b) - dist2(q, b))
                .slice(0, 2);
            const face = readBoard([...posts, b], STAGE_COLOURS[stage]);
            // the number
            const expected = DIGIT_ROWS[stage + 1];
            for (let r = 0; r < 5; r++)
                expect(face[r].slice(1, 4), `sign ${stage + 1} digit row ${r}`).toBe(expected[r]);
            // the arrow: towards the road's bend ahead (+t is the reader's right)
            const ahead = roadT(u + 14) - roadT(u);
            const arrow = ahead > 1.5 ? 'right' : ahead < -1.5 ? 'left' : 'up';
            for (let r = 0; r < 5; r++)
                expect(face[r].slice(6, 11), `sign ${stage + 1} arrow row ${r}`).toBe(ARROW_ROWS[arrow][r]);
            // facing: its face looks back down the route and towards the road
            const yaw = (quarterOf(b) * Math.PI) / 2;
            const nx = Math.sin(yaw);
            const nz = Math.cos(yaw);
            const down = { x: -Math.SQRT1_2, z: Math.SQRT1_2 };
            const r0 = routeToWorld(u, roadT(u));
            const toRoad = { x: r0.x - b.pose.p.x, z: r0.z - b.pose.p.z };
            expect(nx * down.x + nz * down.z, `sign ${stage + 1} faces down the route`).toBeGreaterThan(0.5);
            expect(nx * toRoad.x + nz * toRoad.z, `sign ${stage + 1} faces the road`).toBeGreaterThan(0);
            // beside the road, not on it
            expect(Math.abs(t - roadT(u))).toBeGreaterThan(1.8);
        });
    });
});

const dist2 = (p: StaticPiece, q: StaticPiece) => (p.pose.p.x - q.pose.p.x) ** 2 + (p.pose.p.z - q.pose.p.z) ** 2;

/** The glyphs as the face reader prints them (route-signs.ts DIGITS and ARROWS). */
const DIGIT_ROWS: Record<number, string[]> = {
    3: ['##.', '..#', '.#.', '..#', '##.'],
    4: ['#.#', '#.#', '###', '..#', '..#'],
    5: ['###', '#..', '##.', '..#', '##.'],
    6: ['.##', '#..', '###', '#.#', '###'],
    7: ['###', '..#', '.#.', '.#.', '.#.']
};
const ARROW_ROWS: Record<SignArrow, string[]> = {
    up: ['..#..', '.###.', '#.#.#', '..#..', '..#..'],
    left: ['..#..', '.#...', '#####', '.#...', '..#..'],
    right: ['..#..', '...#.', '#####', '...#.', '..#..']
};
