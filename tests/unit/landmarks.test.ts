import { describe, expect, it, vi } from 'vitest';

import { OAK, PINE_TIERS } from '../../src/levels/common.ts';
import type * as LevelMod from '../../src/levels/level.ts';
import type * as ValleyMod from '../../src/levels/valley.ts';
import {
    LANDMARKS,
    VALLEY_STAGES,
    routeT,
    routeToWorld,
    routeU,
    valleyHeight,
    valleyLayout
} from '../../src/levels/valley.ts';
import type * as RasterMod from '../../src/voxels/rasterizer.ts';
import type * as WorldMod from '../../src/voxels/world.ts';

/** Landmark piece names, by landmark. */
const PARTS = {
    lookout: ['lookout-leg', 'lookout-brace', 'lookout-cabin', 'lookout-band', 'lookout-roof'],
    mast: ['mast', 'mast-pad', 'mast-dish', 'mast-hut'],
    flower: ['flower-stem', 'flower-leaf', 'flower-petal', 'flower-centre']
};

describe('Valley landmarks', () => {
    it('every part of the lookout, the mast and the summit flower survives the 40 cm far lattice', async () => {
        // the far lattice's own cell size: a fresh module graph with 40 cm cells, as the far worker
        // gets (src/workers/voxel-worker.ts)
        vi.resetModules();
        const g = globalThis as { __UE_CELL_CM__?: number };
        g.__UE_CELL_CM__ = 40;
        try {
            const grid = await import('../../src/voxels/grid.ts');
            expect(grid.GRID_SIZE).toBeCloseTo(0.4, 9);
            const { valleyLayout: layout } = (await import('../../src/levels/valley.ts')) as typeof ValleyMod;
            const { pieceVolume } = (await import('../../src/levels/level.ts')) as typeof LevelMod;
            const { VoxelWorld } = (await import('../../src/voxels/world.ts')) as typeof WorldMod;
            const { createRasterStats } = (await import('../../src/voxels/rasterizer.ts')) as typeof RasterMod;
            const pieces = layout(1).pieces;
            for (const name of [...PARTS.lookout, ...PARTS.mast, ...PARTS.flower]) {
                const mine = pieces.filter((p) => p.name === name);
                expect(mine.length, name).toBeGreaterThan(0);
                for (const p of mine) {
                    // each piece alone in an empty world: the cells it writes
                    const w = new VoxelWorld();
                    w.rasterizeStatic(
                        pieceVolume(p),
                        p.pose,
                        p.policy ?? 'coverage50',
                        p.priority ?? 2,
                        createRasterStats()
                    );
                    w.finalizeStatic();
                    expect(w.staticCellCount(), `${name} at 40 cm`).toBeGreaterThan(2);
                    // and at least one full 40 cm cell thick on its thinnest axis
                    const sh = p.shape;
                    const thin =
                        sh.type === 'box'
                            ? 2 * Math.min(sh.hx, sh.hy, sh.hz)
                            : sh.type === 'cylinder'
                              ? 2 * Math.min(sh.r, sh.half)
                              : 2 * Math.min(sh.rx, sh.ry, sh.rz);
                    expect(thin, `${name} thickness`).toBeGreaterThanOrEqual(0.42);
                }
            }
        } finally {
            delete g.__UE_CELL_CM__;
            vi.resetModules();
        }
    });

    it('on Low the far lattice still holds the lookout, the mast and the summit flower', async () => {
        vi.resetModules();
        const g = globalThis as { __UE_CELL_CM__?: number };
        g.__UE_CELL_CM__ = 40;
        try {
            const grid = await import('../../src/voxels/grid.ts');
            const { VoxelService } = await import('../../src/workers/voxel-service.ts');
            const { createLabEntities } = await import('../../src/sim/lab-entities.ts');
            const { STATE_STRIDE } = await import('../../src/workers/protocol.ts');
            const { valleyLayout: layout } = (await import('../../src/levels/valley.ts')) as typeof ValleyMod;
            // the far lattice's own service (the far worker's), given the Low radius with a frame,
            // as the voxel client never does (it sends the radius to the near lane only)
            const far = new VoxelService(new Set());
            far.build(1, 'valley', undefined, true, true);
            const count = createLabEntities().entities.filter((e) => e.asset.parts.length > 0).length;
            const spawn = routeToWorld(-4, 0);
            for (let f = 0; f < 5; f++)
                far.frame(
                    f,
                    0,
                    'coverage50',
                    false,
                    new Float64Array(count * STATE_STRIDE),
                    undefined,
                    0,
                    new Float32Array([spawn.x, spawn.z]),
                    new Int32Array(0),
                    6.4,
                    24
                );
            const pieces = layout(1).pieces;
            for (const name of ['lookout-cabin', 'mast', 'flower-centre', 'flower-petal']) {
                const p = pieces.find((q) => q.name === name)!;
                const c = p.pose.p;
                const v = far.world.staticAt(grid.cellIndexX(c.x), grid.cellIndexY(c.y), grid.cellIndexZ(c.z));
                expect(v, `${name} in the far lattice`).toBeGreaterThan(0);
            }
        } finally {
            delete g.__UE_CELL_CM__;
            vi.resetModules();
        }
    }, 300_000);

    it('trees stay clear of the landmarks', () => {
        for (const tr of valleyLayout(1).trees) {
            const u = routeU(tr.x, tr.z);
            const t = routeT(tr.x, tr.z);
            for (const l of Object.values(LANDMARKS))
                expect(Math.hypot(u - l.u, t - l.t), `tree ${tr.x.toFixed(1)}, ${tr.z.toFixed(1)}`).toBeGreaterThan(
                    4.5
                );
        }
    });

    it('the lookout cabin can be seen from the Timber Yard, over the ground and the trees', () => {
        const start = VALLEY_STAGES[0].start;
        const eye = { x: start.x, y: valleyHeight(start.x, start.z) + 1.22, z: start.z };
        const cab = routeToWorld(LANDMARKS.lookout.u, LANDMARKS.lookout.t);
        const cabin = layoutPiece('lookout-cabin').pose.p;
        expect(Math.hypot(cabin.x - cab.x, cabin.z - cab.z)).toBeLessThan(0.1);
        const trees = valleyLayout(1).trees;
        const pineTop = PINE_TIERS[3].y + PINE_TIERS[3].h;
        const oakTop = Math.max(...OAK.blobs.map((b) => b[1] + b[3]));
        // the upper half of the cabin, under its roof
        const target = { x: cabin.x, y: cabin.y + 0.5, z: cabin.z };
        const dist = Math.hypot(cabin.x - eye.x, cabin.z - eye.z);
        expect(dist).toBeGreaterThan(50);
        let blocked = 0;
        // the sight line to the cabin, every 0.5 m (the last 3 m are the lookout itself)
        for (let s = 2; s < dist - 3; s += 0.5) {
            const k = s / dist;
            const x = eye.x + (target.x - eye.x) * k;
            const z = eye.z + (target.z - eye.z) * k;
            const y = eye.y + (target.y - eye.y) * k;
            if (valleyHeight(x, z) > y) blocked++;
            for (const tr of trees) {
                const r = PINE_TIERS[0].r * tr.scale;
                if (Math.hypot(tr.x - x, tr.z - z) > r) continue;
                // a tree's crown, up to its top
                if (valleyHeight(tr.x, tr.z) + (tr.kind === 'oak' ? oakTop : pineTop) * tr.scale > y) blocked++;
            }
        }
        expect(blocked).toBe(0);
    });
});

function layoutPiece(name: string) {
    const p = valleyLayout(1).pieces.find((q) => q.name === name);
    if (!p) throw new Error(name);
    return p;
}
