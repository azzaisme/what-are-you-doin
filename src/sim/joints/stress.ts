/**
 * Joint loads (Epic 5, #49). Rapier does not report the impulse a joint applies (and in 0.21 not
 * contact friction either), so the load on each connection is reconstructed after every step from
 * what Rapier does report:
 *
 * - each jointed body's change of momentum over the step (linear and angular), with gravity and
 *   damping taken out, and
 * - the normal impulse of every contact it touches (exact: a body at rest balances to 1e-4).
 *
 * What is left over is what its joints and its contact friction did together. A weighted
 * least-norm solve over each group of joined bodies shares that out: unknowns are each
 * connection's force and moment (at its anchor) and each contact's friction (in its tangent
 * plane). Friction is cheap in the weighting (it takes what it can first, as static friction
 * does), and any friction past mu x normal is capped and the rest solved again. Redundant
 * connections (a beam anchored at both ends) share by least norm, close to an elastic split.
 *
 * Engine-free; deterministic (plain doubles, fixed iteration order).
 */

import type RAPIER from '@dimforge/rapier3d-compat';

import { SIM_DT } from '../clock.ts';
import { GRAVITY } from '../physics/world.ts';
import type { PhysBody, PhysicsWorld } from '../physics/world.ts';

import { GROUND } from './graph.ts';
import type { Connection, JointGraph } from './graph.ts';

/** Moments cost like forces at this lever (m) in the least-norm share. */
const LEVER = 0.3;
/** Friction is this much cheaper than joint load (so it takes what it can first). */
const FRICTION_PREFERENCE = 100;

export interface JointLoad {
    /** Force (N) and moment (N m) the connection carried over the last step. */
    force: number;
    moment: number;
    /** The force vector on body a (N), world frame (debug overlay). */
    fx: number;
    fy: number;
    fz: number;
}

interface BodyState {
    pb: PhysBody;
    vx: number;
    vy: number;
    vz: number;
    wx: number;
    wy: number;
    wz: number;
    /** World inertia at the start of the step (row major 3x3). */
    I: number[];
}

interface Friction {
    /** Group body indices on each side (-1: outside the group). */
    i: number;
    j: number;
    px: number;
    py: number;
    pz: number;
    t1: [number, number, number];
    t2: [number, number, number];
    /** mu x the manifold's normal impulse (its cap). */
    cap: number;
}

/** Rapier's tangent basis for a contact normal is not exposed: any orthonormal pair works here. */
function tangents(nx: number, ny: number, nz: number): [[number, number, number], [number, number, number]] {
    const s = nz >= 0 ? 1 : -1;
    const a = -1 / (s + nz);
    const b = nx * ny * a;
    return [
        [1 + s * nx * nx * a, s * b, -s * nx],
        [b, s + ny * ny * a, -ny]
    ];
}

const cross = (ax: number, ay: number, az: number, bx: number, by: number, bz: number): [number, number, number] => [
    ay * bz - az * by,
    az * bx - ax * bz,
    ax * by - ay * bx
];

/**
 * Solves (A W A^T) y = r for y with a little regularization (dense, Gaussian elimination with
 * partial pivoting); returns x = W A^T y. A is rows x cols, row major.
 */
export function leastNorm(A: Float64Array, rows: number, cols: number, W: Float64Array, r: Float64Array): Float64Array {
    const M = new Float64Array(rows * rows);
    for (let i = 0; i < rows; i++)
        for (let j = i; j < rows; j++) {
            let s = 0;
            for (let k = 0; k < cols; k++) s += A[i * cols + k] * W[k] * A[j * cols + k];
            M[i * rows + j] = s;
            M[j * rows + i] = s;
        }
    let trace = 0;
    for (let i = 0; i < rows; i++) trace += M[i * rows + i];
    const eps = 1e-9 * (trace / Math.max(1, rows) + 1e-12);
    for (let i = 0; i < rows; i++) M[i * rows + i] += eps;
    const y = Float64Array.from(r);
    for (let c = 0; c < rows; c++) {
        let p = c;
        for (let i = c + 1; i < rows; i++) if (Math.abs(M[i * rows + c]) > Math.abs(M[p * rows + c])) p = i;
        if (p !== c) {
            for (let k = 0; k < rows; k++) {
                const t = M[c * rows + k];
                M[c * rows + k] = M[p * rows + k];
                M[p * rows + k] = t;
            }
            const t = y[c];
            y[c] = y[p];
            y[p] = t;
        }
        const d = M[c * rows + c];
        if (Math.abs(d) < 1e-30) continue;
        for (let i = c + 1; i < rows; i++) {
            const f = M[i * rows + c] / d;
            if (f === 0) continue;
            for (let k = c; k < rows; k++) M[i * rows + k] -= f * M[c * rows + k];
            y[i] -= f * y[c];
        }
    }
    for (let c = rows - 1; c >= 0; c--) {
        let s = y[c];
        for (let k = c + 1; k < rows; k++) s -= M[c * rows + k] * y[k];
        const d = M[c * rows + c];
        y[c] = Math.abs(d) < 1e-30 ? 0 : s / d;
    }
    const x = new Float64Array(cols);
    for (let k = 0; k < cols; k++) {
        let s = 0;
        for (let i = 0; i < rows; i++) s += A[i * cols + k] * y[i];
        x[k] = W[k] * s;
    }
    return x;
}

/**
 * Measures connection loads. Call `before()` just before the world steps (after every impulse of
 * the tick is applied) and `after()` just after it.
 */
export class StressMeter {
    private readonly pw: PhysicsWorld;
    private readonly graph: JointGraph;
    private readonly states = new Map<number, BodyState>();
    /** Load per connection id from the last step. */
    readonly loads = new Map<number, JointLoad>();

    constructor(pw: PhysicsWorld, graph: JointGraph) {
        this.pw = pw;
        this.graph = graph;
    }

    /** Bodies with at least one connection, in id order. */
    private jointed(): PhysBody[] {
        const ids = new Set<number>();
        for (const c of this.graph.connections()) {
            ids.add(c.a);
            if (c.b !== GROUND) ids.add(c.b);
        }
        const out: PhysBody[] = [];
        for (const id of [...ids].sort((a, b) => a - b)) {
            const pb = this.pw.bodies.get(id);
            if (pb && pb.kind === 'dynamic' && pb.enabled) out.push(pb);
        }
        return out;
    }

    before(): void {
        this.states.clear();
        if (this.graph.size === 0) return;
        for (const pb of this.jointed()) {
            const b = pb.body;
            // asleep: Rapier does not integrate it, so there is nothing to measure (it keeps its last load)
            if (b.isSleeping()) continue;
            const v = b.linvel();
            const w = b.angvel();
            const I = b.effectiveAngularInertia();
            this.states.set(pb.id, {
                pb,
                vx: v.x,
                vy: v.y,
                vz: v.z,
                wx: w.x,
                wy: w.y,
                wz: w.z,
                I: [I.m11, I.m12, I.m13, I.m12, I.m22, I.m23, I.m13, I.m23, I.m33]
            });
        }
    }

    after(): void {
        // connections gone since: forget them; asleep ones keep their last load
        for (const id of [...this.loads.keys()]) if (!this.graph.get(id)) this.loads.delete(id);
        if (this.graph.size === 0 || this.states.size === 0) return;
        // groups of joined bodies (ground does not join groups)
        const seen = new Set<number>();
        for (const id of this.states.keys()) {
            if (seen.has(id)) continue;
            const { bodies } = this.graph.group(id);
            const members = [...bodies].filter((b) => this.states.has(b)).sort((a, b) => a - b);
            for (const m of members) seen.add(m);
            const conns: Connection[] = [];
            for (const c of this.graph.connections())
                if (bodies.has(c.a) && (this.states.has(c.a) || this.states.has(c.b))) conns.push(c);
            if (members.length && conns.length) this.solveGroup(members, conns);
        }
    }

    private solveGroup(members: number[], conns: Connection[]): void {
        const dt = SIM_DT;
        const index = new Map(members.map((id, i) => [id, i]));
        const B = members.length;
        const rows = 6 * B;
        const r = new Float64Array(rows);
        const com: [number, number, number][] = [];
        const frictions: Friction[] = [];
        const world = this.pw.world;
        // residual momentum per body: what joints and friction did
        members.forEach((id, i) => {
            const s = this.states.get(id)!;
            const b = s.pb.body;
            const m = b.mass();
            const c = b.worldCom();
            com.push([c.x, c.y, c.z]);
            const v = b.linvel();
            const w = b.angvel();
            const ld = 1 + dt * b.linearDamping();
            const ad = 1 + dt * b.angularDamping();
            r[6 * i] = m * (v.x * ld - s.vx);
            r[6 * i + 1] = m * (v.y * ld - s.vy) + m * GRAVITY * dt * b.gravityScale();
            r[6 * i + 2] = m * (v.z * ld - s.vz);
            const dwx = w.x * ad - s.wx;
            const dwy = w.y * ad - s.wy;
            const dwz = w.z * ad - s.wz;
            const I = s.I;
            r[6 * i + 3] = I[0] * dwx + I[1] * dwy + I[2] * dwz;
            r[6 * i + 4] = I[3] * dwx + I[4] * dwy + I[5] * dwz;
            r[6 * i + 5] = I[6] * dwx + I[7] * dwy + I[8] * dwz;
        });
        // contacts: take out normal impulses (exact); keep a friction unknown per manifold
        const handled = new Set<string>();
        members.forEach((id, i) => {
            const pb = this.states.get(id)!.pb;
            for (const col of pb.colliders) {
                world.contactPairsWith(col, (other) => {
                    const otherBody = this.pw.bodyOfCollider(other.handle);
                    const j = otherBody ? (index.get(otherBody.id) ?? -1) : -1;
                    // a pair inside the group is visited from both sides: once is enough
                    if (j >= 0) {
                        const key =
                            col.handle < other.handle
                                ? `${col.handle}:${other.handle}`
                                : `${other.handle}:${col.handle}`;
                        if (handled.has(key)) return;
                        handled.add(key);
                    }
                    world.contactPair(col, other, (man, flipped) => {
                        const n = man.normal();
                        // impulse on our collider: +n jn when it is the manifold's second collider
                        const sign = flipped ? 1 : -1;
                        let jnSum = 0;
                        let px = 0;
                        let py = 0;
                        let pz = 0;
                        const ct = col.translation();
                        const cq = col.rotation();
                        for (let k = 0; k < man.numContacts(); k++) {
                            const jn = man.contactImpulse(k);
                            if (!(jn > 0)) continue;
                            const lp = flipped ? man.localContactPoint2(k) : man.localContactPoint1(k);
                            if (!lp) continue;
                            const wp = rotate(cq, lp.x, lp.y, lp.z);
                            const qx = ct.x + wp[0];
                            const qy = ct.y + wp[1];
                            const qz = ct.z + wp[2];
                            const fx = sign * n.x * jn;
                            const fy = sign * n.y * jn;
                            const fz = sign * n.z * jn;
                            this.subtract(r, i, com[i], qx, qy, qz, fx, fy, fz);
                            if (j >= 0) this.subtract(r, j, com[j], qx, qy, qz, -fx, -fy, -fz);
                            jnSum += jn;
                            px += qx * jn;
                            py += qy * jn;
                            pz += qz * jn;
                        }
                        if (jnSum <= 0) return;
                        const [t1, t2] = tangents(n.x, n.y, n.z);
                        // friction acts on our side as +t, on a group body on the other side as -t
                        frictions.push({
                            i,
                            j,
                            px: px / jnSum,
                            py: py / jnSum,
                            pz: pz / jnSum,
                            t1,
                            t2,
                            cap: man.friction() * jnSum
                        });
                    });
                });
            }
        });
        // unknowns: 6 per connection, then 2 per friction
        let frictionFixed: (number[] | null)[] = frictions.map(() => null);
        let x = this.solve(rows, r, index, com, conns, frictions, frictionFixed);
        // cap friction at mu x normal, solve once more with the capped ones fixed
        let capped = false;
        frictionFixed = frictions.map((f, k) => {
            const o = 6 * conns.length + 2 * k;
            const a = x[o];
            const b = x[o + 1];
            const mag = Math.hypot(a, b);
            if (mag > f.cap * 1.0001) {
                capped = true;
                return [(a / mag) * f.cap, (b / mag) * f.cap];
            }
            return null;
        });
        if (capped) x = this.solve(rows, r, index, com, conns, frictions, frictionFixed);
        conns.forEach((c, k) => {
            const o = 6 * k;
            this.loads.set(c.id, {
                force: Math.hypot(x[o], x[o + 1], x[o + 2]) / dt,
                moment: Math.hypot(x[o + 3], x[o + 4], x[o + 5]) / dt,
                fx: x[o] / dt,
                fy: x[o + 1] / dt,
                fz: x[o + 2] / dt
            });
        });
    }

    /** r_i -= the wrench of an impulse f applied at q (about body i's centre of mass). */
    private subtract(
        r: Float64Array,
        i: number,
        c: [number, number, number],
        qx: number,
        qy: number,
        qz: number,
        fx: number,
        fy: number,
        fz: number
    ): void {
        r[6 * i] -= fx;
        r[6 * i + 1] -= fy;
        r[6 * i + 2] -= fz;
        const t = cross(qx - c[0], qy - c[1], qz - c[2], fx, fy, fz);
        r[6 * i + 3] -= t[0];
        r[6 * i + 4] -= t[1];
        r[6 * i + 5] -= t[2];
    }

    private solve(
        rows: number,
        r0: Float64Array,
        index: Map<number, number>,
        com: [number, number, number][],
        conns: Connection[],
        frictions: Friction[],
        fixed: (number[] | null)[]
    ): Float64Array {
        const cols = 6 * conns.length + 2 * frictions.length;
        const A = new Float64Array(rows * cols);
        const W = new Float64Array(cols);
        const r = Float64Array.from(r0);
        const put = (row: number, col: number, v: number) => {
            A[row * cols + col] += v;
        };
        conns.forEach((c, k) => {
            const P = this.anchorWorld(c);
            for (const [id, s] of [
                [c.a, 1],
                [c.b, -1]
            ] as const) {
                const i = id === GROUND ? -1 : (index.get(id) ?? -1);
                if (i < 0) continue;
                const col = 6 * k;
                const d = [P[0] - com[i][0], P[1] - com[i][1], P[2] - com[i][2]];
                for (let a = 0; a < 3; a++) {
                    put(6 * i + a, col + a, s);
                    put(6 * i + 3 + a, col + 3 + a, s);
                }
                // torque of the force about the centre of mass: d x F
                put(6 * i + 3, col + 1, -s * d[2]);
                put(6 * i + 3, col + 2, s * d[1]);
                put(6 * i + 4, col + 0, s * d[2]);
                put(6 * i + 4, col + 2, -s * d[0]);
                put(6 * i + 5, col + 0, -s * d[1]);
                put(6 * i + 5, col + 1, s * d[0]);
            }
            W.fill(1, 6 * k, 6 * k + 3);
            W.fill(LEVER * LEVER, 6 * k + 3, 6 * k + 6);
        });
        frictions.forEach((f, k) => {
            const col = 6 * conns.length + 2 * k;
            const fx = fixed[k];
            for (const [i, s] of [
                [f.i, 1],
                [f.j, -1]
            ] as const) {
                if (i < 0) continue;
                for (let t = 0; t < 2; t++) {
                    const tv = t === 0 ? f.t1 : f.t2;
                    const tq = cross(f.px - com[i][0], f.py - com[i][1], f.pz - com[i][2], tv[0], tv[1], tv[2]);
                    const coeff = [tv[0], tv[1], tv[2], tq[0], tq[1], tq[2]];
                    for (let a = 0; a < 6; a++) {
                        if (fx) r[6 * i + a] -= s * coeff[a] * fx[t];
                        else put(6 * i + a, col + t, s * coeff[a]);
                    }
                }
            }
            W[col] = W[col + 1] = fx ? 0 : FRICTION_PREFERENCE;
        });
        const x = leastNorm(A, rows, cols, W, r);
        frictions.forEach((_, k) => {
            const f = fixed[k];
            if (f) {
                x[6 * conns.length + 2 * k] = f[0];
                x[6 * conns.length + 2 * k + 1] = f[1];
            }
        });
        return x;
    }

    private anchorWorld(c: Connection): [number, number, number] {
        const a = this.pw.bodies.get(c.a)?.body;
        if (!a) return [c.anchorB.x, c.anchorB.y, c.anchorB.z];
        const t = a.translation();
        const p = rotate(a.rotation(), c.anchorA.x, c.anchorA.y, c.anchorA.z);
        return [t.x + p[0], t.y + p[1], t.z + p[2]];
    }
}

function rotate(q: RAPIER.Rotation, x: number, y: number, z: number): [number, number, number] {
    const ix = q.w * x + q.y * z - q.z * y;
    const iy = q.w * y + q.z * x - q.x * z;
    const iz = q.w * z + q.x * y - q.y * x;
    const iw = -q.x * x - q.y * y - q.z * z;
    return [
        ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
        iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
        iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x
    ];
}
