/**
 * The log dolly (Epic 5, #52: a solo aid): a low timber cradle on four steel ball casters. One end
 * of a log rests in it, between its side chocks, against the stop; the rest of the log lies ahead,
 * its far end dragging on the ground. Towed, not carried (PhysBody.towed): a beaver behind it takes
 * it by the stop and walks on, and the stop pushes the log along on its casters.
 *
 * One rigid part, no animation channels (the casters are balls: nothing to turn), so it costs the
 * snapshot one entity. The same shapes make its voxels and its colliders.
 *
 * Local frame: +x is the stop's end (the back, where the beaver is), y up from the bottom of the
 * casters, z across.
 */

import { aabb } from '../voxels/math.ts';
import { M, voxel } from '../voxels/palette.ts';
import { implicit, latticeShade } from '../voxels/volumes.ts';

import { ASSET_SCHEMA_VERSION } from './asset.ts';
import type { VoxelAsset } from './asset.ts';

export type DollyShape =
    | { kind: 'caster'; x: number; y: number; z: number; r: number }
    | { kind: 'deck' | 'chock' | 'stop'; x: number; y: number; z: number; hx: number; hy: number; hz: number };

const R = 0.06;
const DECK = { hx: 0.3, hy: 0.03, hz: 0.32 };
const DECK_Y = 2 * R + 0.02 + DECK.hy;

export const DOLLY = {
    /** Caster radius (m), and their friction: steel balls, near free to roll any way. */
    casterR: R,
    casterFriction: 0.03,
    /** The cradle's top (m above the casters' bottom): a log's underside rests here. */
    deckTop: DECK_Y + DECK.hy,
    /** The cradle's timber grips the log (and is gripped by a beaver's hand). */
    timberFriction: 0.9,
    density: 600
} as const;

export const DOLLY_SHAPES: readonly DollyShape[] = [
    ...[-1, 1].flatMap((sx) =>
        [-1, 1].map((sz) => ({ kind: 'caster' as const, x: sx * 0.22, y: R, z: sz * 0.24, r: R }))
    ),
    // struts from the casters up to the deck are folded into the deck's thickness
    { kind: 'deck', x: 0, y: DECK_Y, z: 0, ...DECK },
    // side chocks: a log of 0.2 m radius lies between them with 7 cm to spare either side (a
    // beaver swinging a log's end in by hand need not be exact)
    ...[-1, 1].map((sz) => ({
        kind: 'chock' as const,
        x: 0,
        y: DOLLY.deckTop + 0.05,
        z: sz * (DECK.hz - 0.025),
        hx: DECK.hx,
        hy: 0.05,
        hz: 0.025
    })),
    // the stop, most of the way up a log's end (it pushes the log, which cannot ride over it)
    { kind: 'stop', x: DECK.hx - 0.025, y: DOLLY.deckTop + 0.17, z: 0, hx: 0.025, hy: 0.17, hz: DECK.hz }
];

function inside(s: DollyShape, x: number, y: number, z: number): boolean {
    if (s.kind === 'caster') return (x - s.x) ** 2 + (y - s.y) ** 2 + (z - s.z) ** 2 < s.r * s.r;
    return Math.abs(x - s.x) < s.hx && Math.abs(y - s.y) < s.hy && Math.abs(z - s.z) < s.hz;
}

export function dollyAsset(): VoxelAsset {
    const top = DOLLY.deckTop + 0.34;
    const v = implicit(
        aabb(-DECK.hx, 0, -DECK.hz, DECK.hx, top, DECK.hz),
        (x, y, z) => DOLLY_SHAPES.some((s) => inside(s, x, y, z)),
        (x, y, z) => {
            const s = DOLLY_SHAPES.find((d) => inside(d, x, y, z));
            if (s?.kind === 'caster') return voxel(M.Steel, 1);
            if (s?.kind === 'stop') return voxel(M.HiVis, 0);
            return voxel(M.Timber, latticeShade(x, y, z, 0.1, 3) & 1);
        }
    );
    return {
        schema: ASSET_SCHEMA_VERSION,
        name: 'dolly',
        parts: [{ name: 'dolly', volume: v, priority: 1, refColor: 0xc48d55 }],
        animChannels: 0,
        evaluate(root, _anim, out) {
            const o = out[0];
            o.p.x = root.p.x;
            o.p.y = root.p.y;
            o.p.z = root.p.z;
            o.q.x = root.q.x;
            o.q.y = root.q.y;
            o.q.z = root.q.z;
            o.q.w = root.q.w;
        }
    };
}
