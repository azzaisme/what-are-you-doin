/**
 * Friction creep in play (Epic 5, #49): Rapier's friction does not quite stick under a steady
 * sideways load. On a properly built bridge (beams nailed at both ends, a nailed deck), what does
 * that come to: four beavers standing on it for a minute, and the ute crossing it ten times.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { BRIDGE, BRIDGE_X } from '../../src/levels/timber-yard.ts';
import { neutralCommand } from '../../src/sim/commands.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { pose, quatFromYawPitchRoll } from '../../src/voxels/math.ts';

import { LINES, driveOver, hammerAt, yardBridge } from './bridge-helpers.ts';

beforeAll(() => initPhysics());

/** The yard bridge nailed at both ends, with two patches of three nailed deck planks. */
function deckedBridge() {
    const { s, beams } = yardBridge([1, -1], 2);
    const mid = [1, 2].map((k) => BRIDGE.nearFace - (k * BRIDGE.gap) / 3);
    const planks = ['plank', 'extra-plank-0', 'extra-plank-1', 'extra-plank-2', 'extra-plank-3', 'extra-plank-4'].map(
        (n) => s.entities.find((e) => e.name === n)!
    );
    const top = Math.max(...beams.map((b) => b.pose.p.y)) + 0.075;
    const plankZ = planks.map((_, k) => mid[k < 3 ? 0 : 1] + ((k % 3) - 1) * 0.22);
    planks.forEach((p, k) =>
        s.physics.place(p.id, pose(BRIDGE_X, top + 0.06, plankZ[k], quatFromYawPitchRoll(0, Math.PI / 2, 0)))
    );
    for (let k = 0; k < 40; k++) s.step(neutralCommand(s.tick + 1));
    for (const z of plankZ) for (const x of LINES) hammerAt(s.joints, { x, y: top + 0.1, z }, s.tick);
    expect(s.joints.graph.size).toBe(4 + 2 * planks.length);
    for (let k = 0; k < 60; k++) s.step(neutralCommand(s.tick + 1));
    return { s, pieces: [...beams, ...planks], mid, top };
}

type Sim = ReturnType<typeof deckedBridge>['s'];
type Piece = Sim['entities'][number];

/** How far each piece has moved from where it was (largest, mm), and which. */
function drift(pieces: Piece[], from: Map<number, { x: number; y: number; z: number }>) {
    let worst = 0;
    let name = '';
    for (const p of pieces) {
        const a = from.get(p.id)!;
        const d = Math.hypot(p.pose.p.x - a.x, p.pose.p.y - a.y, p.pose.p.z - a.z) * 1000;
        if (d > worst) [worst, name] = [d, p.name];
    }
    return { worst, name };
}

const where = (pieces: Piece[]) => new Map(pieces.map((p) => [p.id, { ...p.pose.p }]));

describe('friction creep in play (#49)', () => {
    it('four beavers standing on the bridge for a minute, then the ute over it ten times: no piece creeps', () => {
        const { s, pieces, mid, top } = deckedBridge();
        s.fpActive = true;
        s.step(neutralCommand(s.tick + 1));
        const start = where(pieces);
        for (let i = 1; i < 4; i++) s.setSlotActive(i, true);
        [0, 1, 2, 3].forEach((i) => {
            s.placePlayer(BRIDGE_X, BRIDGE.nearEdge + 1, 0, i);
            const pl = s.players[i];
            pl.x = BRIDGE_X + (i % 2 ? 0.6 : -0.6);
            pl.z = mid[i >> 1];
            pl.y = top + 0.12;
            s.physics.placeCharacter(pl.x, pl.y, pl.z, i);
        });
        for (let k = 0; k < 60 * 60; k++) {
            const c = neutralCommand(s.tick + 1);
            s.step(c, c, [c, c]);
        }
        const stood = drift(pieces, start);
        const onBridge = s.players.slice(0, 4).filter((p) => p.z < BRIDGE.nearFace && p.z > BRIDGE.farFace).length;
        // off the bridge, then the ute: ten crossings, bank to bank
        for (let i = 1; i < 4; i++) s.setSlotActive(i, false);
        s.placePlayer(BRIDGE_X + 3, BRIDGE.nearEdge + 4, 0);
        const before = where(pieces);
        let reached = 0;
        for (let n = 0; n < 10; n++) {
            if (driveOver(s).reached) reached++;
            s.step({ ...neutralCommand(s.tick + 1), grab: true }); // out of the ute
            for (let k = 0; k < 30; k++) s.step(neutralCommand(s.tick + 1));
        }
        const driven = drift(pieces, before);
        const total = drift(pieces, start);
        console.log(
            `four beavers (${onBridge} on it) for 60 s: the most any piece moved ${stood.worst.toFixed(1)} mm (${stood.name}); the ute over it ${reached} times of 10: ${driven.worst.toFixed(1)} mm (${driven.name}); in all ${total.worst.toFixed(1)} mm`
        );
        expect(onBridge).toBe(4);
        expect(reached).toBe(10);
        expect(stood.worst).toBeLessThan(2);
        expect(driven.worst).toBeLessThan(2);
        expect(s.joints.graph.size).toBe(16);
    }, 600_000);
});
