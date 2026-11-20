/**
 * Scripted, deterministic physics test (Epic 2 gate): the plank is dropped with a fixed tilt and
 * spin onto the near bank (LabSim.dropTest) and its continuous pose is rasterized into the global
 * voxel grid at chosen ticks. Used by the unit tests and by `scripts/drop-test.ts` (evidence image).
 *
 * Physics and voxels stay separate: the test reads poses out of the simulation and rasterizes them
 * exactly as the voxel worker would; nothing flows back.
 */

import { CHUNK_BITS, CHUNK_MASK, CHUNK_VOLUME } from '../voxels/grid.ts';
import { pose } from '../voxels/math.ts';
import type { Pose } from '../voxels/math.ts';
import { createRasterStats } from '../voxels/rasterizer.ts';
import type { SamplingPolicy } from '../voxels/rasterizer.ts';
import { VoxelWorld } from '../voxels/world.ts';

import { ACTION_DROP_TEST, neutralCommand } from './commands.ts';
import { LabSim } from './lab-sim.ts';


export interface DropFrame {
    tick: number;
    pose: Pose;
    /** Rotation angle from the starting orientation (radians). */
    angle: number;
    /** Occupied cells as signed integer indices, sorted. */
    cells: [number, number, number][];
    hash: number;
}

/** Runs the drop and captures the plank's voxel occupancy at the given ticks after the drop. */
export function runDropTest(captureTicks: readonly number[], policy: SamplingPolicy = 'coverage50'): DropFrame[] {
    const sim = new LabSim();
    sim.step({ ...neutralCommand(0), action: ACTION_DROP_TEST });
    const start = { ...sim.plank.pose.q };
    const world = new VoxelWorld();
    const stats = createRasterStats();
    const e = sim.plank;
    world.addObject(e.id, e.priority);
    const poses = e.asset.parts.map(() => pose());
    const frames: DropFrame[] = [];
    const last = Math.max(...captureTicks);
    for (let t = 0; t <= last; t++) {
        if (t > 0) sim.step(neutralCommand(t));
        if (!captureTicks.includes(t)) continue;
        e.asset.evaluate(e.pose, e.anim, poses);
        world.rasterizeObject(
            e.id,
            e.asset.parts.map((p, i) => ({ volume: p.volume, pose: poses[i], priority: p.priority, policy: p.policy })),
            policy,
            stats
        );
        const cells: [number, number, number][] = [];
        for (const key of world.objectCells(e.id).keys()) cells.push(keyToIndex(world, key));
        cells.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
        let hash = 2166136261;
        for (const c of cells) for (const v of c) hash = Math.imul(hash ^ (v & 0xffff), 16777619) >>> 0;
        const q = e.pose.q;
        const dot = Math.min(1, Math.abs(q.x * start.x + q.y * start.y + q.z * start.z + q.w * start.w));
        frames.push({ tick: t, pose: { p: { ...e.pose.p }, q: { ...q } }, angle: 2 * Math.acos(dot), cells, hash });
    }
    sim.physics.free();
    return frames;
}

function keyToIndex(world: VoxelWorld, key: number): [number, number, number] {
    const c = world.chunks[Math.floor(key / CHUNK_VOLUME)];
    const li = key % CHUNK_VOLUME;
    const lx = li & CHUNK_MASK;
    const lz = (li >> CHUNK_BITS) & CHUNK_MASK;
    const ly = li >> (2 * CHUNK_BITS);
    return [c.cx * 16 + lx, c.cy * 16 + ly, c.cz * 16 + lz];
}
