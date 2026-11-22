/**
 * Joint loads (Epic 5, #49). Every connection's physics joint is a set of springs (joints.ts): a
 * linear one of the nails' slip modulus holding the anchor points together, and for timber to
 * timber an angular one holding the nailed turn. So a joint's load is read from how far it has
 * given: force = linear stiffness x slip (the distance between its two anchor points), moment =
 * angular stiffness x turn away from the nailed rest. Nothing is solved, so nothing is ambiguous:
 * a beam nailed down at both ends shares its load between nails and seats by stiffness, as a real
 * one does.
 *
 * Bearing: a joint pushing piece a back out of b, against the face the nail went into, is the
 * pieces pressing on each other (the seat holding the beam up), which they carry themselves, not
 * the nails. That part of the force is reported as `bearing` and left out of `force`.
 *
 * Read after each physics step (`after()`); engine-free and deterministic.
 */

import type { PhysicsWorld } from '../physics/world.ts';

import { GROUND, angularStiffness, linearStiffness } from './graph.ts';
import type { Connection, JointGraph } from './graph.ts';

export interface JointLoad {
    /** Force the nails carry (N): the spring's force less any bearing (shear and pull together). */
    force: number;
    /** Across the nails (N): their shear. */
    shear: number;
    /** Along the nails, pulling the pieces apart (N): withdrawal. */
    pull: number;
    /** Along the nails, pressing the pieces together (N): bearing, which the pieces carry. */
    bearing: number;
    /** Bending moment (N m) the joint carries (0 for an anchor: a pin). */
    moment: number;
    /** The spring's whole force on body a (N), world frame (debug overlay). */
    fx: number;
    fy: number;
    fz: number;
}

type Q = { x: number; y: number; z: number; w: number };
const IDENT: Q = { x: 0, y: 0, z: 0, w: 1 };

/** Measures connection loads from their springs. Call `before()` before and `after()` after each step. */
export class StressMeter {
    private readonly pw: PhysicsWorld;
    private readonly graph: JointGraph;
    /** Load per connection id from the last step. */
    readonly loads = new Map<number, JointLoad>();

    constructor(pw: PhysicsWorld, graph: JointGraph) {
        this.pw = pw;
        this.graph = graph;
    }

    before(): void {
        // jointed pieces are kept awake: asleep, Rapier neither integrates them nor solves their
        // contacts (a settled beam would keep the load of its last settling step)
        for (const c of this.graph.connections())
            for (const id of [c.a, c.b]) {
                const pb = id === GROUND ? undefined : this.pw.bodies.get(id);
                if (pb && pb.kind === 'dynamic' && pb.enabled && pb.body.isSleeping()) pb.body.wakeUp();
            }
    }

    after(): void {
        this.loads.clear();
        for (const c of this.graph.connections()) {
            const l = this.read(c);
            if (l) this.loads.set(c.id, l);
        }
    }

    /** One connection's load from its springs, or null when a piece is missing. */
    read(c: Connection): JointLoad | null {
        const A = this.pw.bodies.get(c.a)?.body;
        if (!A) return null;
        const B = c.b === GROUND ? null : (this.pw.bodies.get(c.b)?.body ?? null);
        if (c.b !== GROUND && !B) return null;
        const qa = A.rotation();
        const ta = A.translation();
        const qb = B ? B.rotation() : IDENT;
        const tb = B ? B.translation() : { x: 0, y: 0, z: 0 };
        // slip: a's anchor point away from b's
        const pa = rotate(qa, c.anchorA.x, c.anchorA.y, c.anchorA.z);
        const pb = B ? rotate(qb, c.anchorB.x, c.anchorB.y, c.anchorB.z) : [c.anchorB.x, c.anchorB.y, c.anchorB.z];
        const kl = linearStiffness(c);
        // the spring pulls a's anchor back to b's
        const fx = -kl * (ta.x + pa[0] - (tb.x + pb[0]));
        const fy = -kl * (ta.y + pa[1] - (tb.y + pb[1]));
        const fz = -kl * (ta.z + pa[2] - (tb.z + pb[2]));
        // along the nails (into b): positive pulls a into b, so the nails are being pulled out
        let along = 0;
        let shear = Math.hypot(fx, fy, fz);
        if (c.axis) {
            const [dx, dy, dz] = rotate(qa, c.axis.x, c.axis.y, c.axis.z);
            along = fx * dx + fy * dy + fz * dz;
            shear = Math.hypot(fx - along * dx, fy - along * dy, fz - along * dz);
        }
        const pull = Math.max(0, along);
        const bearing = Math.max(0, -along);
        // the turn from frame 1 (a's) to frame 2 (b's, at its nailed rest): conj(qa) * qb * rel
        let moment = 0;
        const ka = angularStiffness(c);
        if (ka > 0) {
            const e = qmul({ x: -qa.x, y: -qa.y, z: -qa.z, w: qa.w }, qmul(qb, c.rel));
            moment = ka * 2 * Math.atan2(Math.hypot(e.x, e.y, e.z), Math.abs(e.w));
        }
        return { force: Math.hypot(shear, pull), shear, pull, bearing, moment, fx, fy, fz };
    }
}

function rotate(q: Q, x: number, y: number, z: number): [number, number, number] {
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

function qmul(a: Q, b: Q): Q {
    return {
        x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
        y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
        z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
        w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
    };
}
