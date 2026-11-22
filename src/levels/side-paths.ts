/**
 * Side paths (design doc §8, Epic 9, #87): narrower tracks off the main road, as polylines in a
 * level's route frame (u along the route, t across it). The level grades its ground along them,
 * paints them as path and keeps trees off; they give a road closure somewhere to send players, and
 * lead to things worth a detour.
 *
 * Pure module (no engine).
 */

export interface SidePath {
    name: string;
    /** Centre line, (u, t) points in order. */
    points: readonly (readonly [number, number])[];
    /** Half the graded width (m); the painted track is a little narrower. */
    halfWidth: number;
}

export interface PathHit {
    /** Distance from the centre line (m). */
    d: number;
    /** The nearest centre-line point. */
    u: number;
    t: number;
    /** The path, and how far along it the nearest point is (m). */
    path: SidePath;
    along: number;
}

/** Bounding boxes of each path (route frame), padded by `pad`, for a cheap reject. */
function bounds(p: SidePath, pad: number) {
    let u0 = Infinity;
    let u1 = -Infinity;
    let t0 = Infinity;
    let t1 = -Infinity;
    for (const [u, t] of p.points) {
        u0 = Math.min(u0, u);
        u1 = Math.max(u1, u);
        t0 = Math.min(t0, t);
        t1 = Math.max(t1, t);
    }
    return { u0: u0 - pad, u1: u1 + pad, t0: t0 - pad, t1: t1 + pad };
}

/**
 * The nearest point on any of `paths` to (u, t), within `reach` m of its centre line (null when
 * none is that close).
 */
export function nearestPath(paths: readonly SidePath[], u: number, t: number, reach: number): PathHit | null {
    let best: PathHit | null = null;
    for (const p of paths) {
        const b = boundsCache.get(p) ?? boundsCache.set(p, bounds(p, 0)).get(p)!;
        if (u < b.u0 - reach || u > b.u1 + reach || t < b.t0 - reach || t > b.t1 + reach) continue;
        let along = 0;
        for (let n = 0; n + 1 < p.points.length; n++) {
            const [au, at] = p.points[n];
            const [bu, bt] = p.points[n + 1];
            const du = bu - au;
            const dt = bt - at;
            const len2 = du * du + dt * dt;
            const len = Math.sqrt(len2);
            const k = len2 > 0 ? Math.max(0, Math.min(1, ((u - au) * du + (t - at) * dt) / len2)) : 0;
            const pu = au + du * k;
            const pt = at + dt * k;
            const d = Math.hypot(u - pu, t - pt);
            if (d <= reach && (!best || d < best.d)) best = { d, u: pu, t: pt, path: p, along: along + k * len };
            along += len;
        }
    }
    return best;
}
const boundsCache = new Map<SidePath, ReturnType<typeof bounds>>();

/** Total length of a path (m). */
export function pathLength(p: SidePath): number {
    let s = 0;
    for (let n = 0; n + 1 < p.points.length; n++)
        s += Math.hypot(p.points[n + 1][0] - p.points[n][0], p.points[n + 1][1] - p.points[n][1]);
    return s;
}
