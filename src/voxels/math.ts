/**
 * Minimal rigid-transform math for the shared simulation / voxel boundary.
 *
 * Deliberately engine-free: poses cross from the simulation to the rasterizer as plain numbers,
 * never as engine objects (design doc §4.3). Only rigid transforms (rotation + translation) are
 * supported; non-uniform scale is not allowed for voxel sources (§5.3).
 */

export interface Vec3 {
    x: number;
    y: number;
    z: number;
}

/** Unit quaternion, (x, y, z) vector part and w scalar part. */
export interface Quat {
    x: number;
    y: number;
    z: number;
    w: number;
}

/** Rigid pose: position p, orientation q. Maps local points to world as p + q * local. */
export interface Pose {
    p: Vec3;
    q: Quat;
}

export function vec3(x = 0, y = 0, z = 0): Vec3 {
    return { x, y, z };
}

export function quatIdentity(): Quat {
    return { x: 0, y: 0, z: 0, w: 1 };
}

export function pose(px = 0, py = 0, pz = 0, q: Quat = quatIdentity()): Pose {
    return { p: { x: px, y: py, z: pz }, q: { x: q.x, y: q.y, z: q.z, w: q.w } };
}

export function copyPose(src: Pose, out: Pose): Pose {
    out.p.x = src.p.x;
    out.p.y = src.p.y;
    out.p.z = src.p.z;
    out.q.x = src.q.x;
    out.q.y = src.q.y;
    out.q.z = src.q.z;
    out.q.w = src.q.w;
    return out;
}

export function clonePose(src: Pose): Pose {
    return copyPose(src, pose());
}

export function quatFromAxisAngle(ax: number, ay: number, az: number, radians: number, out: Quat = quatIdentity()): Quat {
    const len = Math.hypot(ax, ay, az);
    if (len === 0 || !Number.isFinite(len)) {
        out.x = 0;
        out.y = 0;
        out.z = 0;
        out.w = 1;
        return out;
    }
    const h = radians * 0.5;
    const s = Math.sin(h) / len;
    out.x = ax * s;
    out.y = ay * s;
    out.z = az * s;
    out.w = Math.cos(h);
    return out;
}

/** Rotation by yaw about Y, then pitch about X, then roll about Z, all in radians (intrinsic Y-X-Z). */
export function quatFromYawPitchRoll(yaw: number, pitch: number, roll: number, out: Quat = quatIdentity()): Quat {
    const qy = quatFromAxisAngle(0, 1, 0, yaw);
    const qx = quatFromAxisAngle(1, 0, 0, pitch);
    const qz = quatFromAxisAngle(0, 0, 1, roll);
    quatMul(qy, qx, out);
    return quatMul(out, qz, out);
}

/** out = a * b (apply b first, then a). Safe when out aliases a or b. */
export function quatMul(a: Quat, b: Quat, out: Quat = quatIdentity()): Quat {
    const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y;
    const y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
    const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w;
    const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
    out.x = x;
    out.y = y;
    out.z = z;
    out.w = w;
    return out;
}

export function quatNormalize(q: Quat, out: Quat = q): Quat {
    const len = Math.hypot(q.x, q.y, q.z, q.w);
    if (len === 0 || !Number.isFinite(len)) {
        out.x = 0;
        out.y = 0;
        out.z = 0;
        out.w = 1;
        return out;
    }
    out.x = q.x / len;
    out.y = q.y / len;
    out.z = q.z / len;
    out.w = q.w / len;
    return out;
}

/** Shortest-arc spherical interpolation. */
export function quatSlerp(a: Quat, b: Quat, t: number, out: Quat = quatIdentity()): Quat {
    let bx = b.x;
    let by = b.y;
    let bz = b.z;
    let bw = b.w;
    let cos = a.x * bx + a.y * by + a.z * bz + a.w * bw;
    if (cos < 0) {
        cos = -cos;
        bx = -bx;
        by = -by;
        bz = -bz;
        bw = -bw;
    }
    let k0: number;
    let k1: number;
    if (cos > 0.9995) {
        k0 = 1 - t;
        k1 = t;
    } else {
        const theta = Math.acos(cos);
        const sin = Math.sin(theta);
        k0 = Math.sin((1 - t) * theta) / sin;
        k1 = Math.sin(t * theta) / sin;
    }
    out.x = a.x * k0 + bx * k1;
    out.y = a.y * k0 + by * k1;
    out.z = a.z * k0 + bz * k1;
    out.w = a.w * k0 + bw * k1;
    return quatNormalize(out);
}

/** Rotates v by q into out. Safe when out aliases v. */
export function quatRotate(q: Quat, vx: number, vy: number, vz: number, out: Vec3): Vec3 {
    // t = 2 * cross(q.xyz, v); v' = v + w * t + cross(q.xyz, t)
    const tx = 2 * (q.y * vz - q.z * vy);
    const ty = 2 * (q.z * vx - q.x * vz);
    const tz = 2 * (q.x * vy - q.y * vx);
    out.x = vx + q.w * tx + (q.y * tz - q.z * ty);
    out.y = vy + q.w * ty + (q.z * tx - q.x * tz);
    out.z = vz + q.w * tz + (q.x * ty - q.y * tx);
    return out;
}

/** out = parent * child (child expressed in parent's frame). Safe when out aliases either. */
export function composePose(parent: Pose, child: Pose, out: Pose): Pose {
    const px = parent.p.x;
    const py = parent.p.y;
    const pz = parent.p.z;
    const r = quatRotate(parent.q, child.p.x, child.p.y, child.p.z, _tmpV);
    const rx = r.x;
    const ry = r.y;
    const rz = r.z;
    quatMul(parent.q, child.q, out.q);
    quatNormalize(out.q);
    out.p.x = px + rx;
    out.p.y = py + ry;
    out.p.z = pz + rz;
    return out;
}

const _tmpV: Vec3 = { x: 0, y: 0, z: 0 };

export function lerpPose(a: Pose, b: Pose, t: number, out: Pose): Pose {
    const ax = a.p.x;
    const ay = a.p.y;
    const az = a.p.z;
    out.p.x = ax + (b.p.x - ax) * t;
    out.p.y = ay + (b.p.y - ay) * t;
    out.p.z = az + (b.p.z - az) * t;
    quatSlerp(a.q, b.q, t, out.q);
    return out;
}

export function poseIsFinite(p: Pose): boolean {
    return (
        Number.isFinite(p.p.x) &&
        Number.isFinite(p.p.y) &&
        Number.isFinite(p.p.z) &&
        Number.isFinite(p.q.x) &&
        Number.isFinite(p.q.y) &&
        Number.isFinite(p.q.z) &&
        Number.isFinite(p.q.w) &&
        p.q.x * p.q.x + p.q.y * p.q.y + p.q.z * p.q.z + p.q.w * p.q.w > 1e-12
    );
}

/**
 * Row-major 3x4 rigid transform, stored as 12 numbers: [r00 r01 r02 tx, r10 r11 r12 ty, r20 r21 r22 tz].
 * Used in hot loops to avoid quaternion math per sample.
 */
export type Mat34 = Float64Array;

export function mat34(): Mat34 {
    return new Float64Array(12);
}

/** Local-to-world matrix of a pose. */
export function poseToMat34(p: Pose, out: Mat34): Mat34 {
    const { x, y, z, w } = p.q;
    const x2 = x + x;
    const y2 = y + y;
    const z2 = z + z;
    const xx = x * x2;
    const xy = x * y2;
    const xz = x * z2;
    const yy = y * y2;
    const yz = y * z2;
    const zz = z * z2;
    const wx = w * x2;
    const wy = w * y2;
    const wz = w * z2;
    out[0] = 1 - (yy + zz);
    out[1] = xy - wz;
    out[2] = xz + wy;
    out[3] = p.p.x;
    out[4] = xy + wz;
    out[5] = 1 - (xx + zz);
    out[6] = yz - wx;
    out[7] = p.p.y;
    out[8] = xz - wy;
    out[9] = yz + wx;
    out[10] = 1 - (xx + yy);
    out[11] = p.p.z;
    return out;
}

/** World-to-local matrix of a rigid pose: R^T, -R^T t. */
export function invertRigidMat34(m: Mat34, out: Mat34): Mat34 {
    const r00 = m[0];
    const r01 = m[1];
    const r02 = m[2];
    const r10 = m[4];
    const r11 = m[5];
    const r12 = m[6];
    const r20 = m[8];
    const r21 = m[9];
    const r22 = m[10];
    const tx = m[3];
    const ty = m[7];
    const tz = m[11];
    out[0] = r00;
    out[1] = r10;
    out[2] = r20;
    out[4] = r01;
    out[5] = r11;
    out[6] = r21;
    out[8] = r02;
    out[9] = r12;
    out[10] = r22;
    out[3] = -(r00 * tx + r10 * ty + r20 * tz);
    out[7] = -(r01 * tx + r11 * ty + r21 * tz);
    out[11] = -(r02 * tx + r12 * ty + r22 * tz);
    return out;
}

/** Axis-aligned bounding box. */
export interface AABB {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
}

export function aabb(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): AABB {
    return { minX, minY, minZ, maxX, maxY, maxZ };
}

/** Conservative world AABB of a local AABB transformed by m (exact for boxes, §5.3 step 1). */
export function transformAabb(local: AABB, m: Mat34, out: AABB): AABB {
    const cx = (local.minX + local.maxX) * 0.5;
    const cy = (local.minY + local.maxY) * 0.5;
    const cz = (local.minZ + local.maxZ) * 0.5;
    const ex = (local.maxX - local.minX) * 0.5;
    const ey = (local.maxY - local.minY) * 0.5;
    const ez = (local.maxZ - local.minZ) * 0.5;
    const wx = m[0] * cx + m[1] * cy + m[2] * cz + m[3];
    const wy = m[4] * cx + m[5] * cy + m[6] * cz + m[7];
    const wz = m[8] * cx + m[9] * cy + m[10] * cz + m[11];
    const hx = Math.abs(m[0]) * ex + Math.abs(m[1]) * ey + Math.abs(m[2]) * ez;
    const hy = Math.abs(m[4]) * ex + Math.abs(m[5]) * ey + Math.abs(m[6]) * ez;
    const hz = Math.abs(m[8]) * ex + Math.abs(m[9]) * ey + Math.abs(m[10]) * ez;
    out.minX = wx - hx;
    out.minY = wy - hy;
    out.minZ = wz - hz;
    out.maxX = wx + hx;
    out.maxY = wy + hy;
    out.maxZ = wz + hz;
    return out;
}

export const DEG = Math.PI / 180;
