/**
 * The log dolly's two exceptions stay its own (Epic 5, #52): only a shape that asks to slide (its
 * casters) keeps its own low friction (Rapier's Min rule); every other collider in every level grips
 * as it always has (the two frictions averaged). And only the dolly is towed (a horizontal-only
 * grip): no other prop, the bucket least of all (it crosses only over what is built, #132).
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';

import { DOLLY } from '../../src/assets/dolly.ts';
import { LEVELS } from '../../src/levels/index.ts';
import { LabSim } from '../../src/sim/lab-sim.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';

beforeAll(() => initPhysics());

/** Every collider's (friction, rule) in a freshly built level, with the shapes that slide. */
function frictions(s: LabSim): { average: Map<string, number>; min: number } {
    const average = new Map<string, number>();
    let min = 0;
    s.physics.world.forEachCollider((c) => {
        if (c.frictionCombineRule() === RAPIER.CoefficientCombineRule.Min) {
            // only the dolly's casters: steel balls of its own low friction
            expect(s.physics.bodyOfCollider(c.handle)?.id).toBe(s.dolly.id);
            expect(c.friction()).toBeCloseTo(DOLLY.casterFriction, 6);
            min++;
        } else {
            expect(c.frictionCombineRule()).toBe(RAPIER.CoefficientCombineRule.Average);
            const k = c.friction().toFixed(3);
            average.set(k, (average.get(k) ?? 0) + 1);
        }
    });
    return { average, min };
}

describe('the dolly’s sliding casters and towing grip are its own (#52)', () => {
    for (const [id, level] of Object.entries(LEVELS))
        it(`${id}: every collider averages its friction but the dolly’s casters; only the dolly is towed`, () => {
            const s = new LabSim({ level });
            const f = frictions(s);
            const hasDolly = s.physics.bodies.has(s.dolly.id);
            const towed = [...s.physics.bodies.values()].filter((b) => b.towed).map((b) => b.id);
            expect(towed).toEqual(hasDolly ? [s.dolly.id] : []);
            expect(s.physics.bodies.get(s.bucket.id)?.towed).toBeUndefined();
            console.log(
                `frictions ${id}: ${[...f.average]
                    .sort()
                    .map(([k, n]) => `${k} x${n}`)
                    .join(', ')}; Min rule: ${f.min} (the dolly's casters)`
            );
            expect(f.min).toBe(hasDolly ? 4 : 0);
        }, 60_000);
});
