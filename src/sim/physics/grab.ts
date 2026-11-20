/**
 * Grab force law (design doc §2.4): a damped spring from the grabbed anchor point to a target point
 * in front of the player, with gravity compensation, limited by a maximum force. Applied as an
 * impulse once per fixed tick, so it never grows with frame rate. Pure math, no Rapier types, so it
 * can be unit tested and shared with a server later.
 */

export interface Vec3Like {
    x: number;
    y: number;
    z: number;
}

/** Tuning. Lengths in metres, forces in newtons, masses in kilograms. */
export const GRAB = {
    /** Ray length from the eye for acquiring an object. */
    reach: 2.6,
    /** Hold distance range from the eye. */
    minHold: 0.7,
    maxHold: 2.6,
    /** Spring natural frequency (Hz) and damping ratio, mass-normalized. */
    frequency: 3.2,
    damping: 1.0,
    /** Hard cap on the force a beaver can exert (~45 kg lift after gravity). */
    maxForce: 450,
    /** Released when the anchor stays further than this from its target... */
    breakDistance: 1.25,
    /** ...for this long (seconds; a 24 kg plank lifted from the ground needs ~0.5 s at the cap)... */
    breakTime: 0.75,
    /** ...or at once beyond this distance (snagged behind something). */
    snapDistance: 2.2,
    /** Extra angular damping while held, so held props settle instead of spinning. */
    heldAngularDamping: 6,
    /** Throw: desired speed along the view, capped by the impulse a beaver can give. */
    throwSpeed: 9,
    maxThrowImpulse: 45
} as const;

export interface GrabForceInput {
    mass: number;
    gravity: number;
    anchor: Vec3Like;
    anchorVelocity: Vec3Like;
    target: Vec3Like;
    targetVelocity: Vec3Like;
}

export interface GrabForceResult {
    /** Force to apply at the anchor (N), already bounded. */
    fx: number;
    fy: number;
    fz: number;
    /** Magnitude before the bound. */
    requested: number;
    /** Distance from anchor to target. */
    error: number;
    saturated: boolean;
}

/** Bounded spring-damper force pulling the anchor to the target. */
export function grabForce(i: GrabForceInput, out: GrabForceResult, maxForce: number = GRAB.maxForce): GrabForceResult {
    const w = 2 * Math.PI * GRAB.frequency;
    const k = w * w;
    const c = 2 * GRAB.damping * w;
    const ex = i.target.x - i.anchor.x;
    const ey = i.target.y - i.anchor.y;
    const ez = i.target.z - i.anchor.z;
    const vx = i.targetVelocity.x - i.anchorVelocity.x;
    const vy = i.targetVelocity.y - i.anchorVelocity.y;
    const vz = i.targetVelocity.z - i.anchorVelocity.z;
    let fx = i.mass * (k * ex + c * vx);
    let fy = i.mass * (k * ey + c * vy + i.gravity);
    let fz = i.mass * (k * ez + c * vz);
    const mag = Math.hypot(fx, fy, fz);
    out.requested = mag;
    out.saturated = mag > maxForce;
    if (out.saturated) {
        const s = maxForce / mag;
        fx *= s;
        fy *= s;
        fz *= s;
    }
    if (!Number.isFinite(fx + fy + fz)) fx = fy = fz = 0;
    out.fx = fx;
    out.fy = fy;
    out.fz = fz;
    out.error = Math.hypot(ex, ey, ez);
    return out;
}

/** Throw impulse magnitude for a body of a mass: light things fly fast, heavy things barely move. */
export function throwImpulse(mass: number): number {
    if (!(mass > 0)) return 0;
    return Math.min(mass * GRAB.throwSpeed, GRAB.maxThrowImpulse);
}

export function clampHold(d: number): number {
    return Math.max(GRAB.minHold, Math.min(GRAB.maxHold, Number.isFinite(d) ? d : GRAB.minHold));
}

/** View direction for a yaw/pitch (engine convention: yaw 0 looks along -Z). */
export function viewDir(yaw: number, pitch: number, out: Vec3Like): Vec3Like {
    const cp = Math.cos(pitch);
    out.x = -Math.sin(yaw) * cp;
    out.y = Math.sin(pitch);
    out.z = -Math.cos(yaw) * cp;
    return out;
}
