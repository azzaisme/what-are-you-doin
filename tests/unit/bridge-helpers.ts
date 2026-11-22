/** Shared set-ups for the bridge tests: the Timber Yard with its beams laid and nailed, and a careful driver. */
import { UTE_TRACK_HALF } from '../../src/assets/ute.ts';
import { BRIDGE, BRIDGE_X, YARD_Y, timberYardLevel } from '../../src/levels/timber-yard.ts';
import { neutralCommand } from '../../src/sim/commands.ts';
import type { NailPreview } from '../../src/sim/joints/joints.ts';
import type { JointSystem } from '../../src/sim/joints/joints.ts';
import { LabSim } from '../../src/sim/lab-sim.ts';
import { pose, quatFromYawPitchRoll, quatMul } from '../../src/voxels/math.ts';

export const FLAT_ALONG_Z = quatMul(quatFromYawPitchRoll(Math.PI / 2, 0, 0), quatFromYawPitchRoll(0, Math.PI / 2, 0));
export const LINES = [BRIDGE_X - UTE_TRACK_HALF, BRIDGE_X + UTE_TRACK_HALF];

/** Yaw and pitch that look from `eye` at `at`. */
export function aim(eye: { x: number; y: number; z: number }, at: { x: number; y: number; z: number }) {
    const dx = at.x - eye.x;
    const dy = at.y - eye.y;
    const dz = at.z - eye.z;
    return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
}

/** A hammer blow from 0.9 m above and 0.3 m to the +z side of a point, at it. */
export function hammerAt(js: JointSystem, at: { x: number; y: number; z: number }, tick: number): NailPreview {
    const eye = { x: at.x, y: at.y + 0.9, z: at.z + 0.3 };
    const { yaw, pitch } = aim(eye, at);
    return js.nail(eye, yaw, pitch, 0, tick);
}

/**
 * Both yard beams across the creek on the ute's wheel lines, settled, then nailed: `ends` says
 * which ends (near +1, far -1), `nails` how many per end (8 cm apart).
 */
export function yardBridge(
    ends: number[],
    nails: number
): { s: LabSim; beams: LabSim['entities']; tick: () => number } {
    const s = new LabSim({ level: timberYardLevel });
    const beams = ['beam-0', 'beam-1'].map((name) => s.entities.find((e) => e.name === name)!);
    beams.forEach((b, i) => s.physics.place(b.id, pose(LINES[i], YARD_Y + 0.3, BRIDGE.zc, FLAT_ALONG_Z)));
    let n = 0;
    for (; n < 60; n++) s.step(neutralCommand(n));
    for (let i = 0; i < 2; i++)
        for (const end of ends)
            for (let k = 0; k < nails; k++) {
                const z = end > 0 ? BRIDGE.nearFace + 0.22 + 0.08 * k : BRIDGE.farFace - 0.22 - 0.08 * k;
                hammerAt(s.joints, { x: LINES[i], y: beams[i].pose.p.y + 0.12, z }, n);
            }
    return { s, beams, tick: () => n };
}

/** Puts the ute on the yard bank facing the bridge, seats player 1 and drives it over carefully. */
export function driveOver(s: LabSim, every: (k: number) => void = () => undefined): { reached: boolean } {
    let n = s.tick;
    const v = s.vehicle!;
    s.physics.place(v.id, pose(BRIDGE_X, YARD_Y + 0.25, BRIDGE.nearEdge + 3.2, quatFromYawPitchRoll(Math.PI, 0, 0)));
    for (let k = 0; k < 60; k++) s.step(neutralCommand(n++));
    s.fpActive = true;
    s.step(neutralCommand(n++));
    if (!s.takeDriverSeat(0)) throw new Error('no seat');
    const target = BRIDGE.farEdge - 2.5;
    for (let k = 0; k < 60 * 20 && s.ute.pose.p.z > target; k++) {
        const q = s.ute.pose.q;
        const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
        let dy = yaw - Math.PI;
        dy -= Math.round(dy / (2 * Math.PI)) * 2 * Math.PI;
        // steer back onto the bridge's centre line and heading
        const steer = Math.max(-1, Math.min(1, 4 * (BRIDGE_X - s.ute.pose.p.x) + 3 * dy));
        s.step({ ...neutralCommand(n++, Math.PI), moveZ: 0.35, moveX: steer });
        every(k);
    }
    return { reached: s.ute.pose.p.z <= target };
}
