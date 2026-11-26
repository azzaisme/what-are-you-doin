/** Test helpers for the hand winch (Epic 5, #52). */
import { expect } from 'vitest';

import { DOLLY } from '../../src/assets/dolly.ts';
import type { LabSim } from '../../src/sim/lab-sim.ts';
import { encodeWinchRope } from '../../src/sim/winch.ts';
import type { WinchEvent } from '../../src/sim/winch.ts';
import { quatRotate } from '../../src/voxels/math.ts';
import type { Vec3 } from '../../src/voxels/math.ts';

/**
 * The winch's rope out, really (Epic 5, #52): its hook taken at the drum and hooked into the log
 * dolly at the far corner of its stop (the dolly is the last entity, so its index is the widest on
 * the wire, and a corner gives the widest point). Returns what goes on the wire for it.
 */
export function hookDolly(sim: LabSim): number[] {
    const w = sim.winch!;
    const out: WinchEvent[] = [];
    const look = (eye: Vec3, at: Vec3) => ({
        yaw: Math.atan2(-(at.x - eye.x), -(at.z - eye.z)),
        pitch: Math.atan2(at.y - eye.y, Math.hypot(at.x - eye.x, at.z - eye.z))
    });
    // at the drum, empty-handed: take the hook
    const d = w.drum;
    const atDrum = { x: d.x + 1, y: d.y + 0.3, z: d.z };
    const a = look(atDrum, d);
    expect(w.grab(0, atDrum, a.yaw, a.pitch, -1, out)).toBe(true);
    expect(w.carrying).toBe(0);
    // at the dolly: the corner of its stop, looked at from above and outside it
    const b = sim.physics.bodies.get(sim.dolly.id)!.body;
    const t = b.translation();
    const q = b.rotation();
    const v = { x: 0, y: 0, z: 0 };
    quatRotate(q, 0.28, DOLLY.deckTop + 0.3, -0.3, v);
    const corner = { x: t.x + v.x, y: t.y + v.y, z: t.z + v.z };
    quatRotate(q, 1, 0, -1, v);
    const eye = { x: corner.x + v.x * 0.6, y: corner.y + 0.8, z: corner.z + v.z * 0.6 };
    const c = look(eye, corner);
    expect(w.grab(0, eye, c.yaw, c.pitch, -1, out)).toBe(true);
    expect(w.hooked).toBe(sim.dolly.id);
    const index = new Map(sim.entities.map((e, i) => [e.id, i]));
    return encodeWinchRope(w.view(), (id) => index.get(id) ?? -1);
}
