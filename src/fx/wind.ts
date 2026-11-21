/**
 * Wind: a deterministic field of time (no state), so the simulation (host-authoritative forces on
 * light bodies), the windsock, the water ripples and every device's falling leaves all agree without
 * networking anything. Uniform in space for now; gusts and a slowly wandering direction.
 */

export interface WindSpec {
    /** Direction the wind blows TOWARDS, radians in the XZ plane (0 = +X, pi/2 = +Z). */
    dir: number;
    /** Steady speed (m/s) and the extra speed of the strongest gusts. */
    base: number;
    gust: number;
}

export const CALM: WindSpec = { dir: 0, base: 0.4, gust: 0.6 };

export interface WindSample {
    x: number;
    z: number;
    speed: number;
    /** 0..1: how gusty it is right now (for effects). */
    gustiness: number;
}

/** Wind at simulation time t (seconds). */
export function windAt(
    t: number,
    spec: WindSpec,
    out: WindSample = { x: 0, z: 0, speed: 0, gustiness: 0 }
): WindSample {
    const g = Math.max(0, 0.6 * Math.sin(t * 0.23) + 0.45 * Math.sin(t * 0.57 + 1.3) + 0.2 * Math.sin(t * 1.9 + 0.4));
    const gustiness = Math.min(1, g);
    const speed = spec.base + spec.gust * gustiness;
    const a = spec.dir + 0.3 * Math.sin(t * 0.031) + 0.08 * Math.sin(t * 0.17 + 2);
    out.x = Math.cos(a) * speed;
    out.z = Math.sin(a) * speed;
    out.speed = speed;
    out.gustiness = gustiness;
    return out;
}

const _w: WindSample = { x: 0, z: 0, speed: 0, gustiness: 0 };

/** Horizontal distance the air moves between t0 and t1 (trapezoid steps of at most `step` s). */
export function windTravel(t0: number, t1: number, spec: WindSpec, step = 0.25): { x: number; z: number } {
    let x = 0;
    let z = 0;
    if (!(t1 > t0)) return { x, z };
    const n = Math.max(1, Math.ceil((t1 - t0) / step));
    const h = (t1 - t0) / n;
    windAt(t0, spec, _w);
    let px = _w.x;
    let pz = _w.z;
    for (let i = 1; i <= n; i++) {
        windAt(t0 + i * h, spec, _w);
        x += ((px + _w.x) / 2) * h;
        z += ((pz + _w.z) / 2) * h;
        px = _w.x;
        pz = _w.z;
    }
    return { x, z };
}
