/**
 * Lattice priority (#107): scenes taken from the real sim, for tests and scripts/bench-lattice.ts.
 *
 * realBucketCarry: player 1 grabs the bucket in first person and carries it, as
 * tests/unit/hands.test.ts does (a physics grab from 1.6 m, then 120 steps looking at `pitch`).
 * Returns what the voxel pipeline sends for your 1 cm limbs (your beaver's root and animation,
 * VoxelClient's fp-body state) and the bucket's pose. Needs initPhysics() first.
 */
import { neutralCommand } from '../src/sim/commands.ts';
import type { PlayerCommand } from '../src/sim/commands.ts';
import { EYE_HEIGHT, LabSim } from '../src/sim/lab-sim.ts';
import type { Pose } from '../src/voxels/math.ts';

export interface CarryScene {
    /** Your beaver's root and animation: the fp-body's state. */
    body: Pose;
    anim: Float64Array;
    bucket: Pose;
    /** The grab holds (the physics rig reports the bucket held). */
    held: boolean;
}

const copy = (p: Pose): Pose => ({ p: { ...p.p }, q: { ...p.q } });

export function realBucketCarry(pitch = -0.4): CarryScene {
    const cmd = (n: number, c: Partial<PlayerCommand> = {}): PlayerCommand => ({ ...neutralCommand(n), ...c });
    const s = new LabSim();
    for (let n = 0; n < 120; n++) s.step(cmd(n));
    const pl = s.bucket.pose.p;
    s.fpActive = true;
    s.placePlayer(pl.x, pl.z + 1.6, 0);
    const eye = s.player.y + EYE_HEIGHT;
    const p0 = -Math.atan2(eye - pl.y, 1.6);
    for (let n = 0; n < 10; n++) s.step(cmd(200 + n, { pitch: p0 }));
    s.step(cmd(300, { grab: true, pitch: p0 }));
    for (let n = 0; n < 120; n++) s.step(cmd(301 + n, { pitch }));
    const grip = { x: 0, y: 0, z: 0, mass: 0, halfWidth: 0, strain: 0 };
    const a = s.avatars[0];
    return {
        body: copy(a.pose),
        anim: Float64Array.from(a.anim),
        bucket: copy(s.bucket.pose),
        held: s.physics.heldInfo(0, grip)
    };
}
