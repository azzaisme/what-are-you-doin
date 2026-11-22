import { describe, expect, it } from 'vitest';

import { nearestPath, pathLength } from '../../src/levels/side-paths.ts';
import {
    LANDMARKS,
    SIDE_PATHS,
    roadT,
    routeT,
    routeToWorld,
    routeU,
    valleyHeight,
    valleyLayout
} from '../../src/levels/valley.ts';

const hAt = (u: number, t: number) => {
    const w = routeToWorld(u, t);
    return valleyHeight(w.x, w.z);
};

/** Walks a path's centre line in 0.25 m steps: (u, t) points. */
function walk(points: readonly (readonly [number, number])[]): [number, number][] {
    const out: [number, number][] = [];
    for (let n = 0; n + 1 < points.length; n++) {
        const [au, at] = points[n];
        const [bu, bt] = points[n + 1];
        const steps = Math.ceil(Math.hypot(bu - au, bt - at) / 0.25);
        for (let k = 0; k < steps; k++) out.push([au + ((bu - au) * k) / steps, at + ((bt - at) * k) / steps]);
    }
    out.push([...points[points.length - 1]] as [number, number]);
    return out;
}

describe('Valley side paths', () => {
    it('nearestPath finds the centre line and how far along it is', () => {
        const p = {
            name: 'test',
            points: [
                [0, 0],
                [10, 0],
                [10, 10]
            ] as const,
            halfWidth: 1
        };
        const h = nearestPath([p], 4, 0.5, 2)!;
        expect(h.d).toBeCloseTo(0.5, 9);
        expect(h.along).toBeCloseTo(4, 9);
        expect(nearestPath([p], 4, 3, 2)).toBeNull();
        expect(nearestPath([p], 10.5, 6, 2)!.along).toBeCloseTo(16, 9);
        expect(pathLength(p)).toBe(20);
    });

    it('each path leaves the road and is walkable: gentle along, level across, no steps', () => {
        for (const p of SIDE_PATHS) {
            const [u0, t0] = p.points[0];
            expect(Math.abs(t0 - roadT(u0))).toBeLessThan(3);
            const pts = walk(p.points);
            let prev = hAt(pts[0][0], pts[0][1]);
            for (const [u, t] of pts) {
                const y = hAt(u, t);
                // a 0.25 m step: under a 1 in 2.5 grade, never a ledge the beaver can't step up
                expect(Math.abs(y - prev), `${p.name} at ${u.toFixed(1)}, ${t.toFixed(1)}`).toBeLessThan(0.1);
                prev = y;
                // level across the track
                const du = 0.6;
                expect(Math.abs(hAt(u + du, t) - hAt(u - du, t)), `${p.name} across`).toBeLessThan(0.25);
            }
        }
    });

    it('the logging track loops back to the road; the lookout track ends at the lookout', () => {
        const loop = SIDE_PATHS.find((p) => p.name === 'logging-track')!;
        const [ue, te] = loop.points[loop.points.length - 1];
        expect(Math.abs(te - roadT(ue))).toBeLessThan(3);
        expect(pathLength(loop)).toBeGreaterThan(25);
        const look = SIDE_PATHS.find((p) => p.name === 'lookout-track')!;
        const [ul, tl] = look.points[look.points.length - 1];
        expect(Math.hypot(ul - LANDMARKS.lookout.u, tl - LANDMARKS.lookout.t)).toBeLessThan(3);
    });

    it('no tree stands on a path', () => {
        const trees = valleyLayout(1).trees;
        for (const tr of trees) {
            const u = routeU(tr.x, tr.z);
            const t = routeT(tr.x, tr.z);
            const hit = nearestPath(SIDE_PATHS, u, t, 2);
            expect(hit, `tree at ${u.toFixed(1)}, ${t.toFixed(1)}`).toBeNull();
        }
    });
});
