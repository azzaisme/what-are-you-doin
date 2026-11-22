import { beforeAll, describe, expect, it } from 'vitest';

import { UTE_TRACK_HALF, UTE_WHEELBASE_HALF } from '../../src/assets/ute.ts';
import { nearestPath, pathLength } from '../../src/levels/side-paths.ts';
import {
    LANDMARKS,
    SIDE_PATHS,
    roadT,
    routeT,
    routeToWorld,
    routeU,
    valleyHeight,
    valleyHeightUngraded,
    valleyLayout,
    valleyLevel
} from '../../src/levels/valley.ts';
import { neutralCommand } from '../../src/sim/commands.ts';
import { EYE_HEIGHT, LabSim } from '../../src/sim/lab-sim.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { pose, quatFromYawPitchRoll } from '../../src/voxels/math.ts';

beforeAll(() => initPhysics());

const hUngraded = (u: number, t: number) => {
    const w = routeToWorld(u, t);
    return valleyHeightUngraded(w.x, w.z);
};
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
        let needed = 0;
        for (const p of SIDE_PATHS) {
            const [u0, t0] = p.points[0];
            expect(Math.abs(t0 - roadT(u0))).toBeLessThan(3);
            for (let n = 0; n + 1 < p.points.length; n++) {
                const [au, at] = p.points[n];
                const [bu, bt] = p.points[n + 1];
                const len = Math.hypot(bu - au, bt - at);
                // across the track: perpendicular to this stretch's own direction
                const xu = -(bt - at) / len;
                const xt = (bu - au) / len;
                const pts = walk([p.points[n], p.points[n + 1]]);
                let prev = hAt(pts[0][0], pts[0][1]);
                for (const [u, t] of pts) {
                    const y = hAt(u, t);
                    // a 0.25 m step: under a 1 in 2.5 grade, never a ledge the beaver can't step up
                    expect(Math.abs(y - prev), `${p.name} at ${u.toFixed(1)}, ${t.toFixed(1)}`).toBeLessThan(0.1);
                    prev = y;
                    // level across, over the beaver's width and more (1.2 m): the graded cross-fall,
                    // against the ground's own (without the track)
                    const across = (h: (u: number, t: number) => number) =>
                        Math.abs(h(u + xu * 0.6, t + xt * 0.6) - h(u - xu * 0.6, t - xt * 0.6));
                    const graded = across(hAt);
                    const natural = across(hUngraded);
                    const where = `${p.name} across at ${u.toFixed(1)}, ${t.toFixed(1)}`;
                    expect(graded, where).toBeLessThan(0.06);
                    // where the ground falls away across the track, the grading takes most of it out
                    if (natural > 0.06) {
                        needed++;
                        // (measured: nil along the stretches, 0.4 of it at worst where two stretches meet)
                        expect(graded, where).toBeLessThan(natural * 0.5);
                    }
                }
            }
        }
        // the hillside the tracks cross needed it in places
        expect(needed).toBeGreaterThan(20);
    });

    it('no static piece stands on a path', () => {
        for (const piece of valleyLayout(1).pieces) {
            if (!piece.collide) continue;
            const s = piece.shape;
            // the piece's reach across the ground (a bound on any yaw)
            const r =
                s.type === 'box'
                    ? Math.hypot(s.hx, s.hz)
                    : s.type === 'cylinder'
                      ? Math.max(s.r, s.half)
                      : Math.max(s.rx, s.rz);
            const u = routeU(piece.pose.p.x, piece.pose.p.z);
            const t = routeT(piece.pose.p.x, piece.pose.p.z);
            for (const p of SIDE_PATHS) {
                const hit = nearestPath([p], u, t, p.halfWidth + r + 0.3);
                expect(hit, `${piece.name} at ${u.toFixed(1)}, ${t.toFixed(1)} on ${p.name}`).toBeNull();
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
        // at the lookout's foot, short of its legs (1.3 m out from its middle)
        const d = Math.hypot(ul - LANDMARKS.lookout.u, tl - LANDMARKS.lookout.t);
        expect(d).toBeLessThan(5.5);
        expect(d).toBeGreaterThan(1.3 * Math.SQRT2 + look.halfWidth);
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

    it('a beaver walks each path end to end by input, staying on it', () => {
        for (const p of SIDE_PATHS) {
            const s = new LabSim({ level: valleyLevel });
            let n = 0;
            s.step(neutralCommand(n++));
            s.fpActive = true;
            const start = routeToWorld(p.points[0][0], p.points[0][1]);
            s.placePlayer(start.x, start.z, 0);
            for (let k = 0; k < 20; k++) s.step(neutralCommand(n++));
            let next = 1;
            let worst = 0;
            let ticks = 0;
            for (; ticks < 60 * 60 && next < p.points.length; ticks++) {
                const w = routeToWorld(p.points[next][0], p.points[next][1]);
                const dx = w.x - s.player.x;
                const dz = w.z - s.player.z;
                if (Math.hypot(dx, dz) < 0.5) {
                    next++;
                    continue;
                }
                s.step({ ...neutralCommand(n++), yaw: Math.atan2(-dx, -dz), moveZ: 1 });
                const hit = nearestPath([p], routeU(s.player.x, s.player.z), routeT(s.player.x, s.player.z), 9);
                worst = Math.max(worst, hit ? hit.d : 9);
            }
            expect(next, `${p.name}: reached the end`).toBe(p.points.length);
            expect(worst, `${p.name}: stayed on the track`).toBeLessThan(p.halfWidth - 0.3);
            expect(s.progress.falls).toBe(0);
            // at walking speed, about its length in seconds (2.2 m/s: no crawl anywhere)
            expect(ticks / 60, `${p.name}: walk time`).toBeLessThan(pathLength(p) / 2.2 + 3);
        }
    }, 120_000);

    it('the ute fits the logging loop: driven end to end in the Valley, every wheel within the track', () => {
        const loop = SIDE_PATHS.find((q) => q.name === 'logging-track')!;
        const s = new LabSim({ level: valleyLevel, hazards: false });
        let n = 0;
        let yaw = 0;
        let pitch = 0;
        const step = (c: Record<string, unknown> = {}, k = 1) => {
            for (let i = 0; i < k; i++) s.step({ ...neutralCommand(n++), yaw, pitch, ...c });
        };
        step({}, 30);
        s.fpActive = true;
        const corners = loop.points.map(([u, t]) => routeToWorld(u, t));
        const a = corners[0];
        const b = corners[1];
        // the ute, brought to the loop's start facing along it (yaw 0 faces +z)
        const yaw0 = Math.atan2(b.x - a.x, b.z - a.z);
        s.physics.place(s.ute.id, pose(a.x, valleyHeight(a.x, a.z) + 0.3, a.z, quatFromYawPitchRoll(yaw0, 0, 0)));
        step({}, 60);
        // in at the driver's door (its right side, local -x), looking at it
        const u0 = s.ute.pose.p;
        const sx = -Math.cos(yaw0);
        const sz = Math.sin(yaw0);
        s.placePlayer(u0.x + sx * 2.2, u0.z + sz * 2.2, 0);
        step({}, 20);
        yaw = Math.atan2(sx, sz);
        pitch = -Math.atan2(s.player.y + EYE_HEIGHT - (u0.y + 0.6), 1.4);
        step({}, 5);
        step({ grab: true });
        expect(s.driver).toBe(0);
        const yawOf = (q: { x: number; y: number; z: number; w: number }) =>
            Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
        let next = 1;
        let worst = 0;
        let ticks = 0;
        for (; ticks < 60 * 60 && next < corners.length; ticks++) {
            const p = s.ute.pose.p;
            const q = s.ute.pose.q;
            const w = corners[next];
            if (Math.hypot(w.x - p.x, w.z - p.z) < 1.5) {
                next++;
                continue;
            }
            // steer for the next corner (A/D: positive turns right, lowering the yaw), gently on
            const e = Math.atan2(w.x - p.x, w.z - p.z) - yawOf(q);
            const err = Math.atan2(Math.sin(e), Math.cos(e));
            step({ moveZ: 0.35, moveX: Math.max(-1, Math.min(1, -2.5 * err)) });
            // every wheel inside the graded band
            const uy = yawOf(q);
            for (const [wx, wz] of [
                [UTE_TRACK_HALF, UTE_WHEELBASE_HALF],
                [-UTE_TRACK_HALF, UTE_WHEELBASE_HALF],
                [UTE_TRACK_HALF, -UTE_WHEELBASE_HALF],
                [-UTE_TRACK_HALF, -UTE_WHEELBASE_HALF]
            ]) {
                const x = p.x + wx * Math.cos(uy) + wz * Math.sin(uy);
                const z = p.z - wx * Math.sin(uy) + wz * Math.cos(uy);
                const hit = nearestPath([loop], routeU(x, z), routeT(x, z), 9);
                worst = Math.max(worst, hit ? hit.d : 9);
            }
            // upright
            expect(1 - 2 * (q.x * q.x + q.z * q.z), 'upright').toBeGreaterThan(0.85);
        }
        expect(next, 'reached the far end of the loop').toBe(corners.length);
        expect(worst, 'the farthest wheel from the centre line').toBeLessThan(loop.halfWidth);
        expect(s.driver).toBe(0);
    }, 180_000);
});
