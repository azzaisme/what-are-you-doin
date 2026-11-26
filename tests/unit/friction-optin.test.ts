/**
 * The Min friction rule is opt-in (Epic 5, #52): only a shape that asks to slide (the log dolly's
 * casters) keeps its own low friction; every other collider in every level grips as it always has
 * (Rapier's default rule, the two frictions averaged).
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';

import { LEVELS } from '../../src/levels/index.ts';
import { LabSim } from '../../src/sim/lab-sim.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';

beforeAll(() => initPhysics());

/** Every collider's (friction, rule) in a freshly built level, with the shapes that slide. */
export function frictions(s: LabSim): { average: Map<string, number>; min: number } {
    const average = new Map<string, number>();
    let min = 0;
    s.physics.world.forEachCollider((c) => {
        if (c.frictionCombineRule() === RAPIER.CoefficientCombineRule.Min) min++;
        else {
            expect(c.frictionCombineRule()).toBe(RAPIER.CoefficientCombineRule.Average);
            const k = c.friction().toFixed(3);
            average.set(k, (average.get(k) ?? 0) + 1);
        }
    });
    return { average, min };
}

describe('the Min friction rule is opt-in (#52)', () => {
    for (const [id, level] of Object.entries(LEVELS))
        it(`${id}: every collider averages its friction, but the shapes that slide`, () => {
            const s = new LabSim({ level });
            const f = frictions(s);
            console.log(
                `frictions ${id}: ${[...f.average]
                    .sort()
                    .map(([k, n]) => `${k} x${n}`)
                    .join(', ')}; Min rule: ${f.min}`
            );
            expect(f.min).toBe(0);
        });
});
