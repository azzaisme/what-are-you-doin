import { describe, expect, it } from 'vitest';

import { rasterizePieces } from '../../src/levels/level.ts';
import { SIGN_BOARD, SIGN_PIXEL, routeSign } from '../../src/levels/route-signs.ts';
import type { SignArrow } from '../../src/levels/route-signs.ts';
import { valleyLayout } from '../../src/levels/valley.ts';
import { GRID_SIZE, cellIndexX, cellIndexY, cellIndexZ } from '../../src/voxels/grid.ts';
import { M, voxelMaterial } from '../../src/voxels/palette.ts';
import { createRasterStats } from '../../src/voxels/rasterizer.ts';
import { VoxelWorld } from '../../src/voxels/world.ts';

/**
 * Reads a sign's face back from the voxels: one character per 10 cm glyph pixel inside the border
 * ('#' light paint, '.' the band, 'x' anything else), looking at the face from the front.
 */
function readFace(quarter: 0 | 1 | 2 | 3, number: number, arrow: SignArrow, foot = { x: 1.234, y: 0.517, z: -2.71 }) {
    const w = new VoxelWorld();
    const pieces = routeSign(foot, quarter, { number, arrow, colour: M.TestBlue });
    rasterizePieces(w, pieces, createRasterStats());
    const board = pieces.find((p) => p.name === 'route-sign')!;
    const c = board.pose.p;
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
            line += m === M.HiVisStripe ? '#' : m === M.TestBlue ? '.' : 'x';
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

    it('the Valley has a route sign at each area from the Forest Road on', () => {
        const signs = valleyLayout(1).pieces.filter((p) => p.name === 'route-sign');
        expect(signs.length).toBe(5);
    });
});
