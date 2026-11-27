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

/** Every collider's friction and combine rule, in creation order (Rapier's own handle order). */
function census(s: LabSim): string[] {
    const list: string[] = [];
    s.physics.world.forEachCollider((c) => {
        const rule =
            c.frictionCombineRule() === RAPIER.CoefficientCombineRule.Min
                ? 'min'
                : c.frictionCombineRule() === RAPIER.CoefficientCombineRule.Average
                  ? 'avg'
                  : `rule${c.frictionCombineRule()}`;
        if (rule === 'min') {
            // only the dolly's casters: steel balls of their own low friction
            expect(s.physics.bodyOfCollider(c.handle)?.id).toBe(s.dolly.id);
            expect(c.friction()).toBeCloseTo(DOLLY.casterFriction, 6);
        }
        list.push(`${c.friction().toFixed(3)} ${rule}`);
    });
    return list;
}

/** Counts of each (friction, rule), sorted: what a change would show. */
function histogram(list: readonly string[]): Record<string, number> {
    const h: Record<string, number> = {};
    for (const k of [...list].sort()) h[k] = (h[k] ?? 0) + 1;
    return h;
}

/** FNV-1a over the whole ordered list: any change, even two colliders swapping, changes it. */
function fnv(list: readonly string[]): string {
    let h = 0x811c9dc5;
    for (const ch of list.join('\n')) {
        h ^= ch.charCodeAt(0);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

/**
 * Committed: each level's colliders as built. They are epics-5-10's at 085dd00 (measured on it with
 * this census: the tutorial and the River Lab identical, hash and all), plus, in the Yard and the
 * Valley, the winch's 4 static colliders at 0.8 and the dolly's 8 (4 timber at 0.9, 4 casters at
 * 0.03 with the Min rule). An unintended change to any collider's friction or rule fails here.
 * The Valley also has #87's foot detours (stepping stones, fallen trunk, boulders) and the trees
 * and rocks kept off their paths: measured with this census, 085dd00 to the detours alone moves
 * 0.5 by -3, 0.6 by -12, 0.8 by +4 and 0.9 by -1, and with them the Valley here is exactly that
 * plus the winch's and dolly's 12.
 */
const EXPECTED: Record<string, { histogram: Record<string, number>; hash: string }> = {
    tutorial: {
        histogram: { '0.500 avg': 24, '0.600 avg': 34, '0.700 avg': 27, '0.800 avg': 34, '0.900 avg': 4 },
        hash: 'b278b350'
    },
    valley: {
        histogram: {
            '0.030 min': 4,
            '0.500 avg': 56,
            '0.600 avg': 1785,
            '0.700 avg': 63,
            '0.750 avg': 16,
            '0.800 avg': 646,
            '0.900 avg': 86
        },
        hash: 'cb19ae62'
    },
    yard: {
        histogram: {
            '0.030 min': 4,
            '0.500 avg': 35,
            '0.600 avg': 245,
            '0.700 avg': 56,
            '0.750 avg': 6,
            '0.800 avg': 144,
            '0.900 avg': 11
        },
        hash: 'f2a5f377'
    },
    // (as on epics-5-10: no winch, no dolly)
    lab: {
        histogram: { '0.500 avg': 12, '0.600 avg': 202, '0.700 avg': 28, '0.800 avg': 61, '0.900 avg': 11 },
        hash: '8c68f9e2'
    }
};

describe('the dolly’s sliding casters and towing grip are its own (#52)', () => {
    for (const [id, level] of Object.entries(LEVELS))
        it(`${id}: every collider averages its friction but the dolly’s casters; only the dolly is towed`, () => {
            const s = new LabSim({ level });
            const list = census(s);
            const hasDolly = s.physics.bodies.has(s.dolly.id);
            const towed = [...s.physics.bodies.values()].filter((b) => b.towed).map((b) => b.id);
            expect(towed).toEqual(hasDolly ? [s.dolly.id] : []);
            expect(s.physics.bodies.get(s.bucket.id)?.towed).toBeUndefined();
            const got = { histogram: histogram(list), hash: fnv(list) };
            console.log(`frictions ${id}: ${JSON.stringify(got)}`);
            expect(list.filter((k) => k.endsWith(' min')).length).toBe(hasDolly ? 4 : 0);
            expect(got).toEqual(EXPECTED[id]);
        }, 60_000);
});
