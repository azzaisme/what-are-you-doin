/**
 * Planks are 2.4 m everywhere but the tutorial, whose long plank is 3.8 m. Every level's planks start
 * clear of everything, and the sawmill's outfeed has room for them.
 */

import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';

import { LONG_PLANK_LENGTH, PLANK_HALF, PLANK_LENGTH, plankAsset, plankHalfOf } from '../../src/assets/props.ts';
import { levelFromData } from '../../src/levels/data.ts';
import { SAWMILL, sawmillToWorld } from '../../src/levels/forestry.ts';
import { LEVELS } from '../../src/levels/index.ts';
import { starterLevel } from '../../src/levels/starter.ts';
import { propBody } from '../../src/sim/lab-physics.ts';
import { LabSim } from '../../src/sim/lab-sim.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { quatFromYawPitchRoll, quatMul } from '../../src/voxels/math.ts';

beforeAll(() => initPhysics());

/** What a box at a pose would overlap (shrunk by 5 mm: resting contact is not an overlap). */
function overlaps(s: LabSim, p: RAPIER.Vector, q: RAPIER.Rotation, hx: number, hy: number, hz: number, skip?: number) {
    const names = new Map<number, string>();
    for (const [id, b] of s.physics.bodies)
        for (const c of b.colliders) names.set(c.handle, s.entities.find((e) => e.id === id)?.name ?? `#${id}`);
    const own = skip === undefined ? [] : s.physics.bodies.get(skip)!.colliders;
    const hits: string[] = [];
    s.physics.world.intersectionsWithShape(p, q, new RAPIER.Cuboid(hx - 0.005, hy - 0.005, hz - 0.005), (c) => {
        if (!own.includes(c)) hits.push(names.get(c.handle) ?? 'static piece');
        return true;
    });
    return hits;
}

describe('planks: 2.4 m, and the tutorial’s 3.8 m long plank', () => {
    it('a plank is 2.4 x 0.2 x 0.1 m (24 kg); the long plank 3.8 m (38 kg), the same wood, in voxels and collider', () => {
        expect(PLANK_LENGTH).toBe(2.4);
        expect(LONG_PLANK_LENGTH).toBe(3.8);
        const s = new LabSim();
        for (const [name, length, mass] of [
            ['plank', PLANK_LENGTH, 24],
            ['long-plank', LONG_PLANK_LENGTH, 38]
        ] as const) {
            const b = s.entities.find((e) => e.name === name)!.asset.parts[0].volume.bounds;
            expect(b.maxX - b.minX).toBeCloseTo(length, 9);
            expect(b.maxY - b.minY).toBeCloseTo(0.2, 9);
            expect(b.maxZ - b.minZ).toBeCloseTo(0.1, 9);
            const h = plankHalfOf(name);
            expect(propBody(name)!.shape).toEqual({ type: 'box', hx: h.x, hy: h.y, hz: h.z });
            expect(h.x * 2).toBeCloseTo(length, 9);
            const shape = propBody(name)!.shape as { hx: number; hy: number; hz: number };
            expect(8 * shape.hx * shape.hy * shape.hz * propBody(name)!.opts.density).toBeCloseTo(mass, 6);
        }
        expect(plankAsset().parts[0].volume.bounds.maxX).toBeCloseTo(PLANK_HALF.x, 9);
    });

    it('only the tutorial places the long plank', () => {
        for (const [id, level] of Object.entries(LEVELS))
            expect(
                level.props.some((p) => p.name === 'long-plank'),
                id
            ).toBe(id === 'tutorial');
    });

    const levels = { ...LEVELS, starter: levelFromData(starterLevel()) };
    for (const [id, level] of Object.entries(levels))
        it(`every plank in ${id} starts clear of the ground, the level's pieces and every other prop`, () => {
            const s = new LabSim({ level });
            s.step();
            let n = 0;
            for (const e of s.entities) {
                const b = s.physics.bodies.get(e.id);
                if (!b || !b.enabled || b.kind !== 'dynamic' || !e.name.includes('plank')) continue;
                n++;
                const hits = overlaps(
                    s,
                    b.body.translation(),
                    b.body.rotation(),
                    PLANK_HALF.x,
                    PLANK_HALF.y,
                    PLANK_HALF.z,
                    e.id
                );
                expect(hits, `${id} ${e.name}`).toEqual([]);
            }
            expect(n).toBeGreaterThan(0);
        });

    for (const id of ['yard', 'valley'])
        it(`the sawmill's outfeed (${id}) has room for each plank it puts out, clear of the blade`, () => {
            const s = new LabSim({ level: LEVELS[id] });
            s.step();
            const spot = s.sawmill!.spot;
            const flat = quatMul(quatFromYawPitchRoll(spot.yaw, 0, 0), quatFromYawPitchRoll(0, Math.PI / 2, 0));
            const O = SAWMILL.outfeed;
            // the plank's near end stays past the blade guard and the feed table
            expect(O.x + PLANK_HALF.x).toBeLessThan(-SAWMILL.guard.halfX);
            // over the bars: its middle between the first and last
            expect(O.x).toBeLessThan(Math.max(...O.bars));
            expect(O.x).toBeGreaterThan(Math.min(...O.bars));
            for (const z of O.laneZ)
                for (let layer = 0; layer < 2; layer++) {
                    const w = sawmillToWorld(
                        spot,
                        O.x,
                        O.barTop + PLANK_HALF.z + 0.003 + layer * (2 * PLANK_HALF.z + 0.005),
                        z
                    );
                    expect(
                        overlaps(s, w, flat, PLANK_HALF.x, PLANK_HALF.y, PLANK_HALF.z),
                        `lane ${z} layer ${layer}`
                    ).toEqual([]);
                }
        });
});
