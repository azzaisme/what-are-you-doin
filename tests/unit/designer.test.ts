import { beforeAll, describe, expect, it } from 'vitest';

import { levelFromData, parseLevelData } from '../../src/levels/data.ts';
import { starterLevel } from '../../src/levels/starter.ts';
import { neutralCommand } from '../../src/sim/commands.ts';
import { LabSim } from '../../src/sim/lab-sim.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { VoxelWorld } from '../../src/voxels/world.ts';

beforeAll(() => initPhysics());

describe('level designer data', () => {
    it('the starter level survives a JSON round trip unchanged', () => {
        const once = parseLevelData(JSON.parse(JSON.stringify(starterLevel())));
        expect(parseLevelData(JSON.parse(JSON.stringify(once)))).toEqual(once);
        expect(once.id).toBe('custom');
    });

    it('clamps untrusted values instead of trusting them', () => {
        const d = parseLevelData({
            ...starterLevel(),
            id: '../evil',
            pieces: [{ shape: { type: 'box', hx: 1e9 }, x: 1e9, y: 0, z: 0, material: 'gold' }]
        });
        expect(d.id).toBe('custom');
        expect(d.pieces[0].x).toBeLessThanOrEqual(60);
        expect((d.pieces[0].shape as { hx: number }).hx).toBeLessThanOrEqual(10);
        expect(d.pieces[0].material).toBe('timber');
    });

    it('builds and plays: props in place, the player on the ground at the start', () => {
        const d = parseLevelData(starterLevel());
        d.pieces.push({ shape: { type: 'box', hx: 0.5, hy: 0.5, hz: 0.5 }, x: 3, y: 0.5, z: 8, material: 'timber' });
        const level = levelFromData(d);
        const r = level.build(new VoxelWorld(), 1);
        expect(r.staticCells).toBeGreaterThan(0);
        const s = new LabSim({ level });
        s.fpActive = true;
        s.placePlayer(d.spawn.x, d.spawn.z, 0);
        for (let n = 0; n < 60; n++) s.step(neutralCommand(n));
        const bucket = s.entities.find((e) => e.name === 'bucket')!;
        expect(bucket.visible).toBe(true);
        expect(Math.abs(bucket.pose.p.x - -1.5)).toBeLessThan(0.3);
        expect(Math.abs(s.player.z - d.spawn.z)).toBeLessThan(0.2);
        expect(s.player.y).toBeGreaterThan(level.terrainHeight(d.spawn.x, d.spawn.z) - 0.1);
    }, 60_000);
});
