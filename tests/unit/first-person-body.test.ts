import { describe, expect, it } from 'vitest';

import type { VoxelAsset } from '../../src/assets/asset.ts';
import { BEAVER_ARM_RAISE, BEAVER_FIRST_PERSON, beaverAsset, beaverFirstPersonAsset } from '../../src/assets/beaver.ts';
import { assetTier } from '../../src/assets/cell-tier.ts';
import { PERSON_ARM_LENGTH, PERSON_EYE_HEIGHT, personAsset, personFirstPersonAsset } from '../../src/assets/person.ts';
import { pose } from '../../src/voxels/math.ts';

interface Body {
    name: string;
    asset: VoxelAsset;
    fp: VoxelAsset;
    eye: number;
    /** Arm part centre to hand tip (m). */
    tip: number;
    head: string[];
    /** Raise while holding something in front. */
    holding: number;
    shown: string[];
}

const BODIES: Body[] = [
    {
        name: 'beaver',
        asset: beaverAsset,
        fp: beaverFirstPersonAsset,
        eye: 1.22,
        tip: 0.18,
        head: ['head', 'muzzle', 'earL', 'earR', 'hatDome', 'hatBrim'],
        holding: 1.95,
        shown: ['body', 'vest', 'armL', 'armR', 'legL', 'footR']
    },
    {
        name: 'person',
        asset: personAsset,
        fp: personFirstPersonAsset,
        eye: PERSON_EYE_HEIGHT,
        tip: PERSON_ARM_LENGTH / 2,
        head: ['neck', 'head', 'hatDome', 'hatBrim'],
        holding: 1.6,
        shown: ['torso', 'hips', 'armL', 'armR', 'legL', 'footR']
    }
];

describe.each(BODIES)('your own body in first person ($name)', (b) => {
    const index = (n: string) => b.asset.parts.findIndex((p) => p.name === n);

    /** Where a hand tip lands in the player's view: degrees below the horizon and to the side. */
    function handInView(raise: number, firstPerson: boolean, part: 'armL' | 'armR') {
        const poses = b.asset.parts.map(() => pose());
        const anim = new Float64Array(b.asset.animChannels);
        anim[BEAVER_ARM_RAISE] = raise;
        anim[BEAVER_FIRST_PERSON] = firstPerson ? 1 : 0;
        b.asset.evaluate(pose(), anim, poses);
        const { p: c, q } = poses[index(part)];
        // the arm hangs along its local -Y
        const ax = -2 * (q.x * q.y - q.w * q.z);
        const ay = -(1 - 2 * (q.x * q.x + q.z * q.z));
        const az = -2 * (q.y * q.z + q.w * q.x);
        const t = { x: c.x + b.tip * ax, y: c.y + b.tip * ay, z: c.z + b.tip * az };
        // the camera sits at the body's x, z (the body faces +Z)
        return {
            near: Math.hypot(t.x, t.y - b.eye, t.z),
            below: (Math.atan2(b.eye - t.y, t.z) * 180) / Math.PI,
            side: (Math.atan2(Math.abs(t.x), t.z) * 180) / Math.PI
        };
    }

    it('leaves the head out only for your own camera', () => {
        const fp = new Float64Array(b.asset.animChannels);
        fp[BEAVER_FIRST_PERSON] = 1;
        const other = new Float64Array(b.asset.animChannels);
        for (const n of b.head) {
            expect(index(n), n).toBeGreaterThanOrEqual(0);
            expect(b.asset.partHidden!(fp, index(n)), n).toBe(true);
            expect(b.asset.partHidden!(other, index(n)), n).toBe(false);
        }
        for (const n of b.shown) expect(b.asset.partHidden!(fp, index(n)), n).toBe(false);
    });

    it('shows both hands at the bottom of the view, and higher while holding', () => {
        // the default look is 7 degrees down with a 52 degree vertical field of view: the bottom
        // edge is 33 degrees below the horizon; the side edges (16:9) about 40 degrees out
        for (const arm of ['armL', 'armR'] as const) {
            const ready = handInView(0, true, arm);
            expect(ready.below).toBeLessThan(32);
            expect(ready.below).toBeGreaterThan(20);
            expect(ready.side).toBeLessThan(30);
            // not in your face: the hand is about as far away as a held phone, or further
            expect(ready.near).toBeGreaterThan(0.35);
            const holding = handInView(b.holding, true, arm);
            expect(holding.below).toBeLessThan(ready.below - 8);
            // other players' view of you: arms hang at your sides unless you hold something
            expect(handInView(0, false, arm).below).toBeGreaterThan(60);
        }
    });

    it('draws your own limbs on the 1 cm lattice, posed like your first-person body', () => {
        expect(assetTier(b.fp)).toBe('fine');
        expect(b.fp.parts.map((p) => p.name)).toEqual(['armL', 'armR', 'legL', 'legR', 'footL', 'footR']);
        const anim = new Float64Array(b.asset.animChannels);
        anim[BEAVER_ARM_RAISE] = 1.9;
        anim[1] = 0.7; // walking
        const limbs = b.fp.parts.map(() => pose());
        b.fp.evaluate(pose(1, 0, 2), anim, limbs);
        const whole = b.asset.parts.map(() => pose());
        b.asset.evaluate(
            pose(1, 0, 2),
            Float64Array.from(anim, (v, i) => (i === BEAVER_FIRST_PERSON ? 1 : v)),
            whole
        );
        b.fp.parts.forEach((p, k) => {
            const w = whole[index(p.name)];
            expect(Math.hypot(limbs[k].p.x - w.p.x, limbs[k].p.y - w.p.y, limbs[k].p.z - w.p.z), p.name).toBeLessThan(
                1e-12
            );
        });
    });
});
