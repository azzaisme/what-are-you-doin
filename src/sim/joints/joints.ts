/**
 * Fastening (Epic 5, #47 #48): the hammer's connection preview and the physics joints behind the
 * joint graph. A nail is a data connection (graph.ts) mirrored by one Rapier joint per pair of
 * bodies (or per anchor site): a spherical joint holding the anchor points together, with angular
 * springs (force-based motors) that pull the pieces back to their nailed orientation, stiffer with
 * each nail. It is never a rigid body of its own.
 *
 * The preview runs the same test the hammer does, so what the prompt says is what a blow does:
 * - the view ray must hit a timber piece (A) within reach, squarely enough;
 * - a nail driven along the view from that point must pass through A and bite into what lies behind
 *   it (B: more timber, or stable ground as an anchor) across a gap of at most NAIL.maxGap (the local
 *   contact test);
 * - A and B must not be sliding against each other;
 * - a pair already fastened takes the nail as a reinforcement, unless it lands on an existing one.
 *
 * Engine-free (no PlayCanvas); deterministic (queries and joints change only inside sim ticks).
 */

import RAPIER from '@dimforge/rapier3d-compat';

import { quatMul, quatRotate, vec3 } from '../../voxels/math.ts';
import type { Vec3 } from '../../voxels/math.ts';
import { viewDir } from '../physics/grab.ts';
import type { Quat, Vec3Like } from '../physics/grab.ts';
import { LAYER, groups } from '../physics/world.ts';
import type { PhysBody, PhysicsWorld } from '../physics/world.ts';

import { GROUND, JointGraph, NAIL } from './graph.ts';
import type { Connection, NailRefusal } from './graph.ts';

const ALL = 0xffff;

export interface NailPreview {
    /** The piece the nail goes through (entity id), or -1 when the view is not on timber. */
    a: number;
    /** What it would fasten to: an entity id, GROUND, or NOTHING. */
    b: number;
    /** 'none' when a blow would hold. */
    refusal: NailRefusal;
    /** Where the nail head would go (world), and the joint point between the pieces. */
    head: Vec3;
    joint: Vec3;
    /** The existing connection it would reinforce, or 0. */
    reinforces: number;
    /** Measured gap between the pieces along the nail (m), and how far it bites into b. */
    gap: number;
    bite: number;
}

/** `b` of a preview with nothing behind the piece. */
export const NOTHING = -2;

export function emptyPreview(): NailPreview {
    return {
        a: -1,
        b: NOTHING,
        refusal: 'none',
        head: { x: 0, y: 0, z: 0 },
        joint: { x: 0, y: 0, z: 0 },
        reinforces: 0,
        gap: 0,
        bite: 0
    };
}

const _dir = { x: 0, y: 0, z: 0 };
const _v = { x: 0, y: 0, z: 0 };

function toLocal(b: RAPIER.RigidBody, p: Vec3Like): Vec3 {
    const t = b.translation();
    const q = b.rotation();
    return quatRotate({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, p.x - t.x, p.y - t.y, p.z - t.z, vec3());
}

/** a^-1 * b. */
function quatConjMul(a: Quat, b: Quat): Quat {
    return quatMul({ x: -a.x, y: -a.y, z: -a.z, w: a.w }, b);
}

/**
 * The joint graph of one physics world and the Rapier joints that make it hold. Rebuilt with the
 * world (a sim reset clears every connection).
 */
export class JointSystem {
    readonly graph = new JointGraph();
    private readonly pw: PhysicsWorld;
    private readonly rapier = new Map<number, RAPIER.ImpulseJoint>();
    private ground: RAPIER.RigidBody | null = null;

    constructor(pw: PhysicsWorld) {
        this.pw = pw;
        // a body put somewhere else (respawned, recovered, reset) or switched off comes loose
        pw.onRelocate = (id) => this.detach(id);
    }

    private groundBody(): RAPIER.RigidBody {
        if (!this.ground) this.ground = this.pw.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
        return this.ground;
    }

    /** What a hammer blow from this eye and view would do (read-only). */
    preview(eye: Vec3Like, yaw: number, pitch: number, p: number, out: NailPreview = emptyPreview()): NailPreview {
        out.a = -1;
        out.b = NOTHING;
        out.refusal = 'none';
        out.reinforces = 0;
        out.gap = out.bite = 0;
        const pw = this.pw;
        const world = pw.world;
        const d = viewDir(yaw, pitch, _dir);
        const rig = pw.rigs[p];
        const hit = world.castRayAndGetNormal(
            new RAPIER.Ray({ x: eye.x, y: eye.y, z: eye.z }, { x: d.x, y: d.y, z: d.z }),
            NAIL.reach,
            true,
            RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
            groups(ALL, ALL & ~LAYER.player),
            rig?.collider
        );
        if (!hit) return out;
        const A = pw.bodyOfCollider(hit.collider.handle);
        // the ground, a tree, the ute: no hammer prompt at all
        if (!A || A.kind !== 'dynamic' || !A.enabled || !A.grabbable) return out;
        out.a = A.id;
        if (!A.nailable) {
            out.refusal = 'not-timber';
            return out;
        }
        const t = hit.timeOfImpact;
        const P = { x: eye.x + d.x * t, y: eye.y + d.y * t, z: eye.z + d.z * t };
        out.head.x = P.x;
        out.head.y = P.y;
        out.head.z = P.z;
        const n1 = hit.normal;
        if (-(n1.x * d.x + n1.y * d.y + n1.z * d.z) < NAIL.minCos) {
            out.refusal = 'glancing';
            return out;
        }
        // how far the nail runs inside A: from its point back along the nail to A's far face
        const L = NAIL.length;
        const tip = { x: P.x + d.x * L, y: P.y + d.y * L, z: P.z + d.z * L };
        const back = new RAPIER.Ray(tip, { x: -d.x, y: -d.y, z: -d.z });
        let exitBack = Infinity;
        for (const c of A.colliders) {
            const s = c.castRay(back, L, true);
            if (s >= 0) exitBack = Math.min(exitBack, s);
        }
        if (exitBack <= 1e-4) {
            out.refusal = 'too-thick';
            return out;
        }
        const depthA = Number.isFinite(exitBack) ? L - exitBack : 0;
        // what lies behind A along the nail (anything but A and the players)
        const eps = 1e-3;
        const behind = world.castRayAndGetNormal(
            new RAPIER.Ray({ x: P.x + d.x * eps, y: P.y + d.y * eps, z: P.z + d.z * eps }, { x: d.x, y: d.y, z: d.z }),
            L,
            true,
            RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
            groups(ALL, ALL & ~LAYER.player),
            undefined,
            A.body
        );
        if (!behind) {
            out.refusal = 'nothing-behind';
            return out;
        }
        const tB = behind.timeOfImpact + eps;
        const B = pw.bodyOfCollider(behind.collider.handle);
        out.b = B ? B.id : GROUND;
        out.gap = tB - depthA;
        out.bite = L - tB;
        if (tB - depthA > NAIL.maxGap || L - tB < NAIL.minBite) {
            out.refusal = 'gap';
            return out;
        }
        if (
            (B && (B.kind !== 'dynamic' || !B.nailable || !B.enabled)) ||
            (!B && !pw.isAnchor(behind.collider.handle))
        ) {
            out.refusal = 'cannot-fasten';
            return out;
        }
        const n2 = behind.normal;
        // the solid side: a ray starting inside B reports a zero normal; treat that as square
        const n2len = Math.hypot(n2.x, n2.y, n2.z);
        if (n2len > 0.5 && -(n2.x * d.x + n2.y * d.y + n2.z * d.z) / n2len < NAIL.minCos) {
            out.refusal = 'glancing';
            return out;
        }
        // the joint point: the interface between the pieces
        const m = Math.max(0, Math.min(depthA, tB));
        const J = { x: P.x + d.x * m, y: P.y + d.y * m, z: P.z + d.z * m };
        out.joint.x = J.x;
        out.joint.y = J.y;
        out.joint.z = J.z;
        // no fastening pieces that slide against each other
        const va = A.body.velocityAtPoint(J, _v);
        let sx = va.x;
        let sy = va.y;
        let sz = va.z;
        if (B) {
            const vb = B.body.velocityAtPoint(J);
            sx -= vb.x;
            sy -= vb.y;
            sz -= vb.z;
        }
        if (Math.hypot(sx, sy, sz) > NAIL.maxSlip) {
            out.refusal = 'moving';
            return out;
        }
        const existing = this.graph.find(A.id, out.b, J);
        if (existing) {
            out.reinforces = existing.id;
            out.refusal = this.graph.nailRefusal(existing, this.nailLocal(existing, P));
            if (out.refusal !== 'none') return out;
        }
        if (this.graph.nailCount >= NAIL.maxTotal) out.refusal = 'limit';
        return out;
    }

    /** A world point in the frame nails of this connection are stored in (its `a` body). */
    private nailLocal(c: Connection, p: Vec3Like): Vec3 {
        const body = this.pw.bodies.get(c.a)?.body;
        return body ? toLocal(body, p) : { x: p.x, y: p.y, z: p.z };
    }

    /**
     * Swings the hammer: a nail where the preview says it holds. Returns the preview (its refusal
     * says why nothing was fastened). Whoever holds either piece lets go: it is fixed now.
     */
    nail(eye: Vec3Like, yaw: number, pitch: number, p: number, tick: number): NailPreview {
        const pv = this.preview(eye, yaw, pitch, p);
        if (pv.a < 0 || pv.b === NOTHING || pv.refusal !== 'none') return pv;
        if (pv.reinforces) {
            const c = this.graph.get(pv.reinforces)!;
            this.graph.addNail(c.id, this.nailLocal(c, pv.head));
            this.stiffen(c);
        } else {
            const A = this.pw.bodies.get(pv.a)!;
            const B = pv.b === GROUND ? null : this.pw.bodies.get(pv.b)!;
            const qa = A.body.rotation();
            const conn = this.graph.add({
                a: A.id,
                b: pv.b,
                type: B ? 'nail' : 'anchor',
                anchorA: toLocal(A.body, pv.joint),
                anchorB: B ? toLocal(B.body, pv.joint) : { ...pv.joint },
                rel: B ? quatConjMul(B.body.rotation(), qa) : { x: qa.x, y: qa.y, z: qa.z, w: qa.w },
                nails: [toLocal(A.body, pv.head)],
                stiffness: B ? NAIL.stiffness : NAIL.anchorStiffness,
                tick
            });
            if (conn) this.makeJoint(conn, A, B);
        }
        for (const id of [pv.a, pv.b]) if (id >= 0) this.pw.releaseAll(id);
        return pv;
    }

    /**
     * The physics joint: the anchor points are held together rigidly, and the pieces' relative
     * turn springs back to where it was when nailed, with an angular stiffness (N m/rad) of
     * stiffness x nails x NAIL.angularStiffness. So one nail flexes more than four, and a heavy
     * load visibly bends a joint before it breaks.
     */
    private makeJoint(c: Connection, A: PhysBody, B: PhysBody | null): void {
        const data = RAPIER.JointData.spherical(c.anchorA, c.anchorB);
        const j = this.pw.world.createImpulseJoint(data, A.body, B ? B.body : this.groundBody(), true);
        // spherical joint data takes no frames: set them on the joint (the turn at nailing is the rest)
        j.setLocalFrame1(c.anchorA, { x: 0, y: 0, z: 0, w: 1 });
        j.setLocalFrame2(c.anchorB, c.rel);
        // the pieces were touching when nailed: their contact would only fight the joint
        if (B) j.setContactsEnabled(false);
        this.rapier.set(c.id, j);
        this.stiffen(c);
    }

    /** Angular stiffness of a connection's joint (N m/rad). */
    angularStiffness(c: Connection): number {
        return c.stiffness * Math.max(1, c.nails.length) * NAIL.angularStiffness;
    }

    /** Sets a connection's joint springs from its stiffness and nails. */
    private stiffen(c: Connection): void {
        const j = this.rapier.get(c.id);
        if (!j) return;
        const k = this.angularStiffness(c);
        const proto = RAPIER.SphericalImpulseJoint.prototype;
        for (const axis of [RAPIER.JointAxis.AngX, RAPIER.JointAxis.AngY, RAPIER.JointAxis.AngZ]) {
            proto.configureMotorModel.call(j, axis, RAPIER.MotorModel.ForceBased);
            proto.configureMotorPosition.call(j, axis, 0, k, k * NAIL.angularDamping);
        }
    }

    /** Removes one connection and its joint, waking both pieces (call between physics steps). */
    remove(id: number): Connection | undefined {
        const c = this.graph.remove(id);
        const j = this.rapier.get(id);
        if (j) {
            this.pw.world.removeImpulseJoint(j, true);
            this.rapier.delete(id);
        }
        for (const b of c ? [c.a, c.b] : []) this.pw.bodies.get(b)?.body.wakeUp();
        return c;
    }

    /** Unfastens everything attached to a body. */
    detach(id: number): void {
        for (const c of this.graph.of(id)) this.remove(c.id);
    }

    clear(): void {
        for (const c of [...this.graph.connections()]) this.remove(c.id);
    }

    /** The Rapier joint behind a connection (tests, stress readout). */
    jointOf(id: number): RAPIER.ImpulseJoint | undefined {
        return this.rapier.get(id);
    }
}
