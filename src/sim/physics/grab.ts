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
    /**
     * Hard cap on the force one beaver can exert: lifts up to ~66 kg alone. The 113 kg log needs two
     * beavers (2 x 650 N > 1,108 N), as the design intends (§2.4).
     */
    maxForce: 650,
    /** Released when the anchor stays further than this from its target... */
    breakDistance: 1.25,
    /** ...for this long (seconds; a 24 kg plank lifted from the ground needs ~0.5 s at the cap)... */
    breakTime: 0.75,
    /** ...or at once beyond this distance (snagged behind something). */
    snapDistance: 2.2,
    /**
     * Extra angular damping while held, so held props settle instead of spinning. Low enough that a
     * prop held off its balance point visibly tips and swings about the grip.
     */
    heldAngularDamping: 1.5,
    /** The same for things that hang from a fixed grab point (the bucket): steady, no wrist. */
    hangingAngularDamping: 6,
    /**
     * Wrist: one player's grip resists twisting up to this torque (N m), holding what they carry at
     * the angle they picked it up at (turning with them). Held near its balance point a plank stays
     * level; held 0.3 m off it (24 kg: 71 N m of twist) it starts to sag; held by the end it tips.
     */
    maxTorque: 70,
    /**
     * A beam is shouldered rather than held in the hands: braced, the grip holds it level even by
     * its end (36 kg, 1.6 m off the balance point: 565 N m), so one player can push it out over a
     * gap and lay it across. Planks keep the hand wrist and still tip when held off balance.
     */
    braceTorque: 700,
    /** Wrist spring natural frequency (Hz) and damping ratio, inertia-normalized. */
    wristFrequency: 2.2,
    wristDamping: 1.0,
    /** Throw: desired speed along the view, capped by the impulse a beaver can give. */
    throwSpeed: 9,
    maxThrowImpulse: 45
} as const;

export interface GrabForceInput {
    mass: number;
    /**
     * Mass the spring-damper acts on: the body's effective mass at the anchor (smaller than its
     * mass when the anchor is off the centre of mass, because a push there also spins it). Scaling
     * the spring by the full mass makes small, light props held by the rim (the bucket) overshoot
     * every tick and shake. Per world axis (see effectiveMassAlong); defaults to `mass`. Gravity
     * support always uses `mass`.
     */
    springMass?: Vec3Like;
    gravity: number;
    anchor: Vec3Like;
    anchorVelocity: Vec3Like;
    target: Vec3Like;
    /** Velocity of the hold point itself (moves with the eye and swings with the view). */
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
    // spring-damper part and gravity support, combined under the cap with support taking priority:
    // a saturated grab still holds the object up instead of letting it sag while it catches up
    const msx = Math.min(i.mass, i.springMass?.x ?? i.mass);
    const msy = Math.min(i.mass, i.springMass?.y ?? i.mass);
    const msz = Math.min(i.mass, i.springMass?.z ?? i.mass);
    const sx = msx * (k * ex + c * vx);
    const sy = msy * (k * ey + c * vy);
    const sz = msz * (k * ez + c * vz);
    const g = i.mass * i.gravity;
    let fx = sx;
    let fy = sy + g;
    let fz = sz;
    const mag = Math.hypot(fx, fy, fz);
    out.requested = mag;
    out.saturated = mag > maxForce;
    if (out.saturated) {
        if (g >= maxForce) {
            fx = 0;
            fy = maxForce;
            fz = 0;
        } else {
            // largest s in [0, 1] with |G + s S| = maxForce
            const ss = sx * sx + sy * sy + sz * sz;
            const gs = g * sy;
            const s =
                ss > 0
                    ? Math.max(
                          0,
                          Math.min(1, (-gs + Math.sqrt(Math.max(0, gs * gs - ss * (g * g - maxForce * maxForce)))) / ss)
                      )
                    : 0;
            fx = s * sx;
            fy = g + s * sy;
            fz = s * sz;
        }
    }
    if (!Number.isFinite(fx + fy + fz)) fx = fy = fz = 0;
    out.fx = fx;
    out.fy = fy;
    out.fz = fz;
    out.error = Math.hypot(ex, ey, ez);
    return out;
}

/** Symmetric 3x3 matrix (world inverse inertia tensor). */
export interface Sym3 {
    m11: number;
    m12: number;
    m13: number;
    m22: number;
    m23: number;
    m33: number;
}

/**
 * Effective mass of a body for a push along unit direction `n` at offset `r` from its centre of
 * mass: 1 / (1/m + (r x n) . I^-1 (r x n)), with I^-1 the world inverse inertia tensor.
 */
export function effectiveMassAlong(mass: number, r: Vec3Like, invI: Sym3, n: Vec3Like): number {
    if (!(mass > 0)) return 0;
    const cx = r.y * n.z - r.z * n.y;
    const cy = r.z * n.x - r.x * n.z;
    const cz = r.x * n.y - r.y * n.x;
    const ix = invI.m11 * cx + invI.m12 * cy + invI.m13 * cz;
    const iy = invI.m12 * cx + invI.m22 * cy + invI.m23 * cz;
    const iz = invI.m13 * cx + invI.m23 * cy + invI.m33 * cz;
    const inv = 1 / mass + Math.max(0, cx * ix + cy * iy + cz * iz);
    return Number.isFinite(inv) && inv > 0 ? 1 / inv : mass;
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

export interface Quat {
    x: number;
    y: number;
    z: number;
    w: number;
}

export interface WristResult {
    /** World torque to apply (N m), capped. */
    tx: number;
    ty: number;
    tz: number;
    /** Angle from the held orientation (rad). */
    angle: number;
    /** Wanted torque over the cap (1 or more: the wrist cannot hold it; it tips). */
    load: number;
}

/**
 * The wrist's torque for one tick: a damped spring turning the body from its orientation `q`
 * towards `target`, as angular acceleration (inertia-normalized, so light and heavy things respond
 * alike) times the body's world inertia, capped at `maxTorque`. Gravity is not compensated: a body
 * held off its balance point sags until the spring (or the cap) balances the twist of its weight.
 */
export function wristTorque(
    q: Quat,
    target: Quat,
    angVel: Vec3Like,
    invI: Sym3,
    out: WristResult,
    maxTorque: number = GRAB.maxTorque
): WristResult {
    // error rotation e = target * conj(q), shortest way round, as a rotation vector
    let ex = target.w * -q.x + target.x * q.w + target.y * -q.z - target.z * -q.y;
    let ey = target.w * -q.y - target.x * -q.z + target.y * q.w + target.z * -q.x;
    let ez = target.w * -q.z + target.x * -q.y - target.y * -q.x + target.z * q.w;
    let ew = target.w * q.w - target.x * -q.x - target.y * -q.y - target.z * -q.z;
    if (ew < 0) {
        ex = -ex;
        ey = -ey;
        ez = -ez;
        ew = -ew;
    }
    const sn = Math.hypot(ex, ey, ez);
    const angle = 2 * Math.atan2(sn, ew);
    const k = sn > 1e-9 ? angle / sn : 2;
    const w0 = 2 * Math.PI * GRAB.wristFrequency;
    const c = 2 * GRAB.wristDamping * w0;
    // wanted angular acceleration
    const ax = w0 * w0 * ex * k - c * angVel.x;
    const ay = w0 * w0 * ey * k - c * angVel.y;
    const az = w0 * w0 * ez * k - c * angVel.z;
    // torque = I a, with I the inverse of the world inverse inertia
    const { m11: a, m12: b, m13: d, m22: e, m23: f, m33: g } = invI;
    const c11 = e * g - f * f;
    const c12 = d * f - b * g;
    const c13 = b * f - d * e;
    const det = a * c11 + b * c12 + d * c13;
    let tx = 0;
    let ty = 0;
    let tz = 0;
    if (Number.isFinite(det) && Math.abs(det) > 1e-12) {
        const c22 = a * g - d * d;
        const c23 = b * d - a * f;
        const c33 = a * e - b * b;
        tx = (c11 * ax + c12 * ay + c13 * az) / det;
        ty = (c12 * ax + c22 * ay + c23 * az) / det;
        tz = (c13 * ax + c23 * ay + c33 * az) / det;
    }
    const mag = Math.hypot(tx, ty, tz);
    const load = maxTorque > 0 ? mag / maxTorque : Infinity;
    const scale = mag > maxTorque && mag > 0 ? maxTorque / mag : 1;
    out.tx = Number.isFinite(tx) ? tx * scale : 0;
    out.ty = Number.isFinite(ty) ? ty * scale : 0;
    out.tz = Number.isFinite(tz) ? tz * scale : 0;
    out.angle = angle;
    out.load = Number.isFinite(load) ? load : 0;
    return out;
}
