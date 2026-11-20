import { beforeAll, describe, expect, it } from 'vitest';

import { LEAF_SLOTS, ParticleFX } from '../../src/fx/particles.ts';
import { CALM, windAt, windTravel } from '../../src/fx/wind.ts';
import { riverLabLevel } from '../../src/levels/river-lab.ts';
import { BRIDGE_X, CREEK_WATER_Y, creekCenterZ, timberYardLevel, yardHeight } from '../../src/levels/timber-yard.ts';
import { neutralCommand } from '../../src/sim/commands.ts';
import { LabSim } from '../../src/sim/lab-sim.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { GRID_SIZE } from '../../src/voxels/grid.ts';
import { pose, quatFromYawPitchRoll } from '../../src/voxels/math.ts';
import { M, voxel } from '../../src/voxels/palette.ts';
import { createRasterStats } from '../../src/voxels/rasterizer.ts';
import { box, solid } from '../../src/voxels/volumes.ts';
import { VoxelWorld } from '../../src/voxels/world.ts';

beforeAll(() => initPhysics());

describe('wind', () => {
    it('is a deterministic, bounded field of time', () => {
        const spec = timberYardLevel.wind!;
        let max = 0;
        for (let t = 0; t < 600; t += 0.37) {
            const a = windAt(t, spec);
            const b = windAt(t, spec);
            expect(a).toEqual(b);
            expect(a.speed).toBeGreaterThanOrEqual(spec.base - 1e-9);
            expect(a.speed).toBeLessThanOrEqual(spec.base + spec.gust + 1e-9);
            max = Math.max(max, a.speed);
        }
        expect(max).toBeGreaterThan(spec.base + spec.gust * 0.7); // gusts happen
        const d = windTravel(0, 10, spec);
        expect(Math.hypot(d.x, d.z)).toBeGreaterThan(spec.base * 10 * 0.8);
    });
});

describe('particles', () => {
    it('falls leaves from the oaks, deterministically, never below the ground', () => {
        const a = new LabSim({ level: timberYardLevel });
        const fx1 = new ParticleFX(timberYardLevel, []);
        const fx2 = new ParticleFX(timberYardLevel, []);
        const n = fx1.update(37.25, a.ring);
        fx2.update(37.25, a.ring);
        expect(n).toBeGreaterThan(LEAF_SLOTS * 0.8); // (no viewer: every crown sheds)
        expect(Array.from(fx1.buffer.slice(0, n * 4))).toEqual(Array.from(fx2.buffer.slice(0, n * 4)));
        let inAir = 0;
        for (let i = 0; i < n; i++) {
            const x = fx1.buffer[i * 4];
            const y = fx1.buffer[i * 4 + 1];
            const z = fx1.buffer[i * 4 + 2];
            expect(y).toBeGreaterThanOrEqual(Math.min(yardHeight(x, z), CREEK_WATER_Y) - 1e-3);
            if (y > yardHeight(x, z) + 0.2) inAir++;
        }
        expect(inAir).toBeGreaterThan(3); // some are still falling
        // levels without oaks have no leaves
        expect(new ParticleFX(riverLabLevel, []).update(37.25, a.ring)).toBe(0);
    });

    it('the wind carries falling leaves downwind', () => {
        const calm = { ...timberYardLevel, wind: CALM };
        const s = new LabSim({ level: timberYardLevel });
        const spread = (lvl: typeof timberYardLevel) => {
            const f = new ParticleFX(lvl, []);
            const n = f.update(100, s.ring);
            let sx = 0;
            let sz = 0;
            for (let i = 0; i < n; i++) {
                sx += f.buffer[i * 4];
                sz += f.buffer[i * 4 + 2];
            }
            return { x: sx / n, z: sz / n };
        };
        const windy = spread(timberYardLevel);
        const still = spread(calm);
        const w = timberYardLevel.wind!;
        // the mean leaf position moves along the wind direction
        expect((windy.x - still.x) * Math.cos(w.dir) + (windy.z - still.z) * Math.sin(w.dir)).toBeGreaterThan(0.3);
    });

    it('a dropped plank throws chips; a bucket dropped in the creek splashes', () => {
        const s = new LabSim({ level: timberYardLevel });
        s.step(neutralCommand(0));
        const fx = new ParticleFX(timberYardLevel, [
            { slot: s.plank.slot, bottom: 0.05, timber: true },
            { slot: s.bucket.slot, bottom: 0, timber: false }
        ]);
        s.physics.place(s.plank.id, pose(0, 3, 6, quatFromYawPitchRoll(0, Math.PI / 2, 0)));
        s.physics.place(s.bucket.id, pose(BRIDGE_X + 4, 1.5, creekCenterZ(BRIDGE_X + 4)));
        // sample at a 20 Hz voxel clock, as the renderer does
        for (let n = 1; n <= 150; n++) {
            s.step(neutralCommand(n));
            if (n % 3 === 0) fx.update((s.tick - 1) / 60, s.ring);
        }
        expect(fx.spawned.chips).toBeGreaterThanOrEqual(1);
        expect(fx.spawned.splash).toBeGreaterThanOrEqual(1);
    });

    it('particle cells lie on the global grid, behind real objects', () => {
        const w = new VoxelWorld();
        w.addObject(990, 0);
        w.addObject(1, 3);
        const pts = Float32Array.from([0.123, 0.456, 0.789, voxel(M.Leaf), 0.13, 0.46, 0.79, voxel(M.LeafRed), 5, 5, 5, voxel(M.Dust)]);
        w.rasterizePoints(990, pts, 3, 0);
        // the first two points share a cell at 5 and 10 cm
        expect(w.objectCellCount(990)).toBe(2);
        w.rasterizeObject(1, [{ volume: box(0.5, 0.5, 0.5, solid(M.Timber)), pose: pose(0, 0.5, 0.5), priority: 0 }], 'center', createRasterStats());
        w.resolve();
        const i = Math.floor(0.123 / GRID_SIZE);
        const j = Math.floor(0.456 / GRID_SIZE);
        const k = Math.floor(0.789 / GRID_SIZE);
        expect(w.valueAt(i, j, k) & 0xff).not.toBe(M.Leaf); // the plank wins over the leaf
    });
});

describe('wind in the simulation', () => {
    it('acts only on awake bodies and stays bounded; calm levels feel nothing', () => {
        const s = new LabSim({ level: timberYardLevel });
        for (let n = 0; n < 400; n++) s.step(neutralCommand(n));
        // everything at rest is asleep: the wind does not shuffle props around the yard
        expect(s.physics.stats.activeBodies).toBe(0);
        // a plank thrown in the air feels it, within the cap
        s.physics.place(s.plank.id, pose(0, 4, 6), { x: 0, y: 3, z: 0 });
        let maxF = 0;
        for (let n = 0; n < 60; n++) {
            s.step(neutralCommand(500 + n));
            maxF = Math.max(maxF, s.windForce);
        }
        expect(maxF).toBeGreaterThan(0);
        expect(maxF).toBeLessThanOrEqual(0.6 * 24 * 9.81 + 1e-6);
        const lab = new LabSim();
        for (let n = 0; n < 60; n++) lab.step(neutralCommand(n));
        expect(lab.windForce).toBe(0);
    });

    it('the windsock points downwind', () => {
        const s = new LabSim({ level: timberYardLevel });
        s.step(neutralCommand(0));
        expect(s.windsock.visible).toBe(true);
        const q = s.windsock.pose.q;
        // the sock's +X axis in world space
        const ax = 1 - 2 * (q.y * q.y + q.z * q.z);
        const az = 2 * (q.x * q.z - q.w * q.y);
        const w = windAt(s.tick / 60, timberYardLevel.wind!);
        expect((ax * w.x + az * w.z) / Math.hypot(ax, az) / w.speed).toBeGreaterThan(0.9);
        expect(new LabSim().windsock.visible).toBe(false);
    });
});
