import { describe, expect, it } from 'vitest';

import { BEAVER_ARM_RAISE, BEAVER_FIRST_PERSON, beaverAsset } from '../../src/assets/beaver.ts';
import { EYE_HEIGHT } from '../../src/sim/lab-sim.ts';
import { pose } from '../../src/voxels/math.ts';

const HEAD = ['head', 'muzzle', 'earL', 'earR', 'hatDome', 'hatBrim'];
const index = (n: string) => beaverAsset.parts.findIndex((p) => p.name === n);

/** Where a hand tip lands in the player's view: degrees below the horizon and to the side. */
function handInView(raise: number, firstPerson: boolean, part: 'armL' | 'armR') {
    const poses = beaverAsset.parts.map(() => pose());
    const anim = new Float64Array(beaverAsset.animChannels);
    anim[BEAVER_ARM_RAISE] = raise;
    anim[BEAVER_FIRST_PERSON] = firstPerson ? 1 : 0;
    beaverAsset.evaluate(pose(), anim, poses);
    const { p: c, q } = poses[index(part)];
    // the arm hangs along its local -Y; the tip is 0.18 m past the part centre
    const ax = -2 * (q.x * q.y - q.w * q.z);
    const ay = -(1 - 2 * (q.x * q.x + q.z * q.z));
    const az = -2 * (q.y * q.z + q.w * q.x);
    const t = { x: c.x + 0.18 * ax, y: c.y + 0.18 * ay, z: c.z + 0.18 * az };
    // the camera sits at the body's x, z (the beaver faces +Z)
    return {
        near: Math.hypot(c.x, c.y - EYE_HEIGHT, c.z),
        below: (Math.atan2(EYE_HEIGHT - t.y, t.z) * 180) / Math.PI,
        side: (Math.atan2(Math.abs(t.x), t.z) * 180) / Math.PI
    };
}

describe('your own body in first person', () => {
    it('leaves the head out only for your own camera', () => {
        const fp = new Float64Array(beaverAsset.animChannels);
        fp[BEAVER_FIRST_PERSON] = 1;
        const other = new Float64Array(beaverAsset.animChannels);
        for (const n of HEAD) {
            expect(beaverAsset.partHidden!(fp, index(n)), n).toBe(true);
            expect(beaverAsset.partHidden!(other, index(n)), n).toBe(false);
        }
        for (const n of ['body', 'vest', 'armL', 'armR', 'legL', 'footR'])
            expect(beaverAsset.partHidden!(fp, index(n)), n).toBe(false);
    });

    it('shows both hands at the bottom of the view, and higher while holding', () => {
        // the default look is 7 degrees down with a 52 degree vertical field of view: the bottom
        // edge is 33 degrees below the horizon; the side edges (16:9) about 40 degrees out
        for (const arm of ['armL', 'armR'] as const) {
            const ready = handInView(0, true, arm);
            expect(ready.below).toBeLessThan(32);
            expect(ready.below).toBeGreaterThan(20);
            expect(ready.side).toBeLessThan(30);
            // not in your face: the arm is about as far away as a held phone
            expect(ready.near).toBeGreaterThan(0.35);
            const holding = handInView(1.95, true, arm);
            expect(holding.below).toBeLessThan(ready.below - 8);
            // other players' view of you: arms hang at your sides unless you hold something
            expect(handInView(0, false, arm).below).toBeGreaterThan(60);
        }
    });
});
