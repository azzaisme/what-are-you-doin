/**
 * Valley set-up shared by tests that play its crossings: where a crossing's gaps are along the road,
 * and the bridge (two beams side by side over each gap) placed over them.
 */

import { GORGE, ROUTE_YAW, roadT, routeToWorld, valleyHeight, valleyLevel } from '../../src/levels/valley.ts';
import { neutralCommand } from '../../src/sim/commands.ts';
import type { LabSim } from '../../src/sim/lab-sim.ts';
import { quatFromYawPitchRoll } from '../../src/voxels/math.ts';

/** Ground height at a route-frame point. */
export const hAt = (u: number, t: number): number => {
    const w = routeToWorld(u, t);
    return valleyHeight(w.x, w.z);
};

/**
 * The gaps along the road at a crossing: runs of ground well below its rims (the crevasse's bed is
 * at the fall line itself, so "below the fall line" would miss its edges).
 */
export function gapsAt(cu: number): [number, number][] {
    const t = roadT(cu);
    const rims = Math.min(hAt(cu - 6, t), hAt(cu + 6, t));
    const gaps: [number, number][] = [];
    let start = NaN;
    for (let u = cu - 6; u <= cu + 6; u += 0.02) {
        const low = hAt(u, t) < Math.min(rims, valleyLevel.rules!.fallY + 1) - 0.5;
        if (low && Number.isNaN(start)) start = u;
        if (!low && !Number.isNaN(start)) {
            gaps.push([start, u]);
            start = NaN;
        }
    }
    if (cu === GORGE.u) {
        const [a, b] = gaps.pop()!;
        gaps.push([a, GORGE.u - GORGE.pierHalfU], [GORGE.u + GORGE.pierHalfU, b]);
    }
    return gaps;
}

/** Two beams side by side over each gap of a crossing, along the road (the bridge, placed). */
export function bridge(s: LabSim, cu: number, names: string[]): void {
    const t = roadT(cu);
    let n = 0;
    for (const [a, b] of gapsAt(cu)) {
        const rim = Math.max(hAt(a - 0.3, t), hAt(b + 0.3, t));
        for (const dt of [-0.11, 0.11]) {
            const w = routeToWorld((a + b) / 2, t + dt);
            const name = names[n++];
            const e = s.entities.find((x) => x.name === name)!;
            s.physics.place(e.id, {
                p: { x: w.x, y: rim + 0.2, z: w.z },
                q: quatFromYawPitchRoll(ROUTE_YAW + Math.PI / 2, Math.PI / 2, 0)
            });
        }
    }
    for (let i = 0; i < 120; i++) s.step(neutralCommand(s.tick));
}
