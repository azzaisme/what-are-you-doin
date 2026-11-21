import { beforeAll, describe, expect, it } from 'vitest';

import { BEAVER_FIRST_PERSON } from '../../src/assets/beaver.ts';
import { BODY, PLAYER_BODY } from '../../src/assets/player-body.ts';
import { neutralCommand } from '../../src/sim/commands.ts';
import type { PlayerCommand } from '../../src/sim/commands.ts';
import { EYE_HEIGHT, LabSim } from '../../src/sim/lab-sim.ts';
import { handsHold, initPhysics } from '../../src/sim/physics/world.ts';
import type { Vec3Like } from '../../src/voxels/math.ts';
import { pose } from '../../src/voxels/math.ts';

beforeAll(() => initPhysics());

const cmd = (n: number, c: Partial<PlayerCommand> = {}): PlayerCommand => ({ ...neutralCommand(n), ...c });

/** Where player 1's hand tips are (world), in first person (your own view) or as others see you. */
function handTips(s: LabSim, firstPerson: boolean): Vec3Like[] {
    const a = s.avatars[0];
    const poses = a.asset.parts.map(() => pose());
    const anim = Float64Array.from(a.anim);
    anim[BEAVER_FIRST_PERSON] = firstPerson ? 1 : 0;
    a.asset.evaluate(a.pose, anim, poses);
    return (['armL', 'armR'] as const).map((n) => {
        const { p: c, q } = poses[a.asset.parts.findIndex((p) => p.name === n)];
        // the arm part hangs along its local -Y, centred half an arm from the shoulder
        const t = BODY.armLength / 2;
        return {
            x: c.x - t * 2 * (q.x * q.y - q.w * q.z),
            y: c.y - t * (1 - 2 * (q.x * q.x + q.z * q.z)),
            z: c.z - t * 2 * (q.y * q.z + q.w * q.x)
        };
    });
}

describe.runIf(PLAYER_BODY === 'person')('holding things in your hands', () => {
    it('carries at arm’s length for where you look', () => {
        const drop = BODY.eyeHeight - BODY.shoulderHeight;
        for (const pitch of [-0.8, -0.35, 0, 0.3]) {
            const h = handsHold(BODY.holdReach, drop, pitch);
            // the hold point is arm's reach from the shoulders
            const fwd = h * Math.cos(pitch);
            const up = h * Math.sin(pitch) + drop;
            expect(Math.hypot(fwd, up)).toBeCloseTo(BODY.holdReach, 9);
        }
    });

    for (const [what, pitch] of [
        ['plank', -0.35],
        ['plank', 0],
        ['plank', -0.8],
        ['cube', -0.4],
        ['bucket', -0.4]
    ] as const) {
        it(`both hands are on the ${what} (looking ${pitch} rad), in your view and to others`, () => {
            const s = new LabSim();
            for (let n = 0; n < 120; n++) s.step(cmd(n));
            const e = s[what];
            const pl = e.pose.p;
            s.fpActive = true;
            // grabbed from 1.6 m away: drawn in to your hands
            s.placePlayer(pl.x, pl.z + 1.6, 0);
            const eye = s.player.y + EYE_HEIGHT;
            const p0 = -Math.atan2(eye - pl.y, 1.6);
            for (let n = 0; n < 10; n++) s.step(cmd(200 + n, { pitch: p0 }));
            s.step(cmd(300, { grab: true, pitch: p0 }));
            for (let n = 0; n < 120; n++) s.step(cmd(301 + n, { pitch }));
            const grip = { x: 0, y: 0, z: 0, mass: 0, halfWidth: 0, strain: 0 };
            expect(s.physics.heldInfo(0, grip)).toBe(true);
            expect(s.physics.rig(0)!.holdDist).toBeLessThan(1.1);
            for (const fp of [true, false]) {
                const [l, r] = handTips(s, fp);
                for (const t of [l, r]) {
                    // at the grip's height and distance, either side of it
                    expect(Math.abs(t.y - grip.y), `${fp} height`).toBeLessThan(0.1);
                    expect(Math.abs(t.z - grip.z), `${fp} depth`).toBeLessThan(0.08);
                    expect(Math.abs(t.x - grip.x), `${fp} side`).toBeLessThan(0.36);
                }
                expect(l.x).toBeLessThan(grip.x);
                expect(r.x).toBeGreaterThan(grip.x);
            }
        });
    }
});
