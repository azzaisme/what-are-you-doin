import { beforeAll, describe, expect, it } from 'vitest';

import { YARD_Y, timberYardLevel } from '../../src/levels/timber-yard.ts';
import { neutralCommand } from '../../src/sim/commands.ts';
import type { PlayerCommand } from '../../src/sim/commands.ts';
import { EYE_HEIGHT, LabSim } from '../../src/sim/lab-sim.ts';
import { GRAB } from '../../src/sim/physics/grab.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';

beforeAll(() => initPhysics());

const cmd = (n: number, c: Partial<PlayerCommand> = {}): PlayerCommand => ({ ...neutralCommand(n), ...c });

/** Two-player yard sim with both players in first person. */
function coop(): LabSim {
    const s = new LabSim({ level: timberYardLevel });
    s.step(cmd(0));
    s.fpActive = true;
    s.setPlayerCount(2);
    for (let n = 1; n < 20; n++) s.step(cmd(n), cmd(n));
    return s;
}

/** Pitch that looks from player i's eye at a point. */
function aim(s: LabSim, i: number, x: number, y: number, z: number): { yaw: number; pitch: number } {
    const p = s.players[i];
    const dx = x - p.x;
    const dz = z - p.z;
    return { yaw: Math.atan2(-dx, -dz), pitch: -Math.atan2(p.y + EYE_HEIGHT - y, Math.hypot(dx, dz)) };
}

describe('local co-op: two players, one world', () => {
    it('both players walk independently; voxel beaver bodies appear only with two players', () => {
        const solo = new LabSim({ level: timberYardLevel });
        solo.step(cmd(0));
        expect(solo.avatars.some((a) => a.visible)).toBe(false);
        const s = coop();
        expect(s.avatars.map((a) => a.visible)).toEqual([true, true, false, false]);
        const a0 = { ...s.players[0] };
        const b0 = { ...s.players[1] };
        // player 2 starts on player 1's right: walk apart (walking into each other, they bump)
        for (let n = 0; n < 60; n++) s.step(cmd(100 + n, { moveX: -1 }), cmd(100 + n, { moveX: 1 }));
        expect(s.players[0].x - a0.x).toBeLessThan(-1);
        expect(s.players[1].x - b0.x).toBeGreaterThan(1);
        // the bodies follow the players (feet), walking
        expect(Math.hypot(s.avatars[1].pose.p.x - s.players[1].x, s.avatars[1].pose.p.z - s.players[1].z)).toBeLessThan(
            1e-9
        );
        s.setPlayerCount(1);
        s.step(cmd(500));
        expect(s.avatars.some((a) => a.visible)).toBe(false);
    });

    it('one beaver cannot lift the 113 kg log; two beavers together can', () => {
        const s = coop();
        const log = s.log;
        const lx = log.pose.p.x;
        const lz = log.pose.p.z;
        const ly = log.pose.p.y;
        // the pile's logs lie along Z; stand off each end of the bottom log
        s.placePlayer(lx - 0.9, lz + 2.3, 0, 0);
        s.placePlayer(lx - 0.9, lz - 2.3, Math.PI, 1);
        for (let n = 0; n < 10; n++) s.step(cmd(n), cmd(n));
        const a = aim(s, 0, lx, ly, lz + 0.75);
        const b = aim(s, 1, lx, ly, lz - 0.75);
        s.step(cmd(50, { ...a, grab: true }), cmd(50, { ...b }));
        expect(s.physics.heldIdOf(0)).toBe(log.id);
        for (let n = 0; n < 90; n++) s.step(cmd(60 + n, { yaw: a.yaw, pitch: 0.1 }), cmd(60 + n, b));
        // alone: the log does not come up (or the grab breaks)
        expect(log.pose.p.y).toBeLessThan(ly + 0.25);
        s.physics.release(0);
        s.step(cmd(200, { ...a, grab: true }), cmd(200, { ...b, grab: true }));
        expect(s.physics.holders(log.id)).toBe(2);
        let maxForce = 0;
        for (let n = 0; n < 150; n++) {
            s.step(cmd(201 + n, { yaw: a.yaw, pitch: 0.05 }), cmd(201 + n, { yaw: b.yaw, pitch: 0.05 }));
            maxForce = Math.max(maxForce, s.physics.rig(0)!.grabForce, s.physics.rig(1)!.grabForce);
        }
        expect(s.physics.holders(log.id)).toBe(2);
        expect(log.pose.p.y).toBeGreaterThan(ly + 0.4);
        expect(maxForce).toBeLessThanOrEqual(GRAB.maxForce + 1e-6);
        // one lets go: still held by the other, collision restored only when both have let go
        s.physics.release(1);
        expect(s.physics.holders(log.id)).toBe(1);
        s.physics.release(0);
        expect(s.physics.holders(log.id)).toBe(0);
    });

    it('each player has their own creek recovery', () => {
        const s = coop();
        s.placePlayer(4, 1.2, 0, 1);
        for (let n = 0; n < 10; n++) s.step(cmd(n), cmd(n));
        for (let n = 0; n < 200 && s.progress.falls === 0; n++) s.step(cmd(100 + n), cmd(100 + n, { moveZ: 1 }));
        expect(s.progress.falls).toBe(1);
        expect(s.events.at(-1)?.text).toContain('Player 2');
        expect(s.players[1].y).toBeGreaterThan(YARD_Y - 0.1);
    });

    it('two-player play is deterministic for the same commands', () => {
        const run = () => {
            const s = coop();
            for (let n = 0; n < 300; n++) {
                s.step(
                    cmd(n, { moveZ: n < 100 ? 1 : 0, yaw: Math.sin(n * 0.02), pitch: -0.4, grab: n === 120 }),
                    cmd(n, { moveX: n < 80 ? 1 : 0, yaw: -Math.sin(n * 0.03), jump: n === 50 })
                );
            }
            return [
                ...s.players.map((p) => [p.x, p.y, p.z]),
                ...s.entities.map((e) => [e.pose.p.x, e.pose.p.y, e.pose.p.z])
            ];
        };
        expect(run()).toEqual(run());
    });
});
