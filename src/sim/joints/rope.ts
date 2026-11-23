/**
 * Ropes (Epic 5, #52; shared with Epic 8's hazards, #75): a line tied between two pieces, or a
 * piece and the ground, that pulls only when taut. A winch winds one in; a hazard can tie one
 * off. Each rope's tension is known exactly (it is the force this module applies), and a rope
 * snaps past its breaking load.
 *
 * Model: an elastic line, pulling with T = k x + c x' when stretched past its length (never
 * pushing), applied as equal and opposite impulses at its two ends before each physics step.
 * - k = EA / L, a 12 mm natural-fibre rope (EA about 110 kN: ~10 % stretch at its breaking load),
 *   held to what a 60 Hz step can follow for the masses at its ends (as the nails' anchor springs
 *   are): a heavy log on a short rope is stiffer than the step allows.
 * - It is a straight line between its ends: it does not wrap around what lies between them.
 * - Breaking load: ROPE.strength (12 mm manila, minimum breaking strength about 10 kN).
 *
 * Its pull is external to the stress meter's joints, so a rope tied to a nailed piece loads that
 * piece's joints, as it should.
 */

import type RAPIER from '@dimforge/rapier3d-compat';

import type { Vec3 } from '../../voxels/math.ts';
import { SIM_DT } from '../clock.ts';
import type { PhysicsWorld } from '../physics/world.ts';

import { GROUND } from './graph.ts';

export const ROPE = {
    /** Axial stiffness E A (N): k = EA / L. */
    EA: 110_000,
    /** Damping ratio of the stretch (fraction of critical, for the masses at its ends). */
    damping: 0.4,
    /** Breaking load (N). */
    strength: 10_000,
    /** Shortest a rope can be wound to (m). */
    minLength: 0.3,
    /** The step can follow a spring of at most m_eff (ring / dt)^2: a period of 2 pi / ring steps. */
    ring: 0.5
};

export interface Rope {
    id: number;
    /** Body id at one end, and its tie point in that body's frame. */
    a: number;
    la: Vec3;
    /** Body id at the other end (GROUND: a fixed point), and its tie point (b's frame, or world). */
    b: number;
    lb: Vec3;
    /** Unstretched length (m). */
    length: number;
    /** Tension last step (N). */
    tension: number;
    /** Its stretch last step (m; 0 slack), for the rate it is stretching at. */
    stretch: number;
}

export interface RopeEvent {
    kind: 'snap';
    id: number;
    /** Where it parted (the middle of the line, world). */
    x: number;
    y: number;
    z: number;
}

/** Ropes in a physics world. Construct once per world: it adds itself to the world's step hooks. */
export class RopeSystem {
    private readonly pw: PhysicsWorld;
    private readonly list = new Map<number, Rope>();
    private nextId = 1;
    private readonly snapped: RopeEvent[] = [];

    constructor(pw: PhysicsWorld) {
        this.pw = pw;
        pw.stepHooks.unshift({ before: () => this.pull(), after: () => undefined });
    }

    /**
     * Ties a rope from body `a` (at `la`, its local frame) to body `b` (at `lb`, local), or to a
     * fixed point `lb` (world) when b is GROUND. Its length defaults to the distance now (just
     * taut). Returns its id, or -1 if a body is missing.
     */
    tie(a: number, la: Vec3, b: number, lb: Vec3, length?: number): number {
        if (!this.pw.bodies.get(a) || (b !== GROUND && !this.pw.bodies.get(b))) return -1;
        const id = this.nextId++;
        const r: Rope = { id, a, la: { ...la }, b, lb: { ...lb }, length: 0, tension: 0, stretch: 0 };
        const [p, q] = this.ends(r);
        r.length = Math.max(ROPE.minLength, length ?? Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z));
        this.list.set(id, r);
        return id;
    }

    get(id: number): Rope | undefined {
        return this.list.get(id);
    }

    ropes(): IterableIterator<Rope> {
        return this.list.values();
    }

    get size(): number {
        return this.list.size;
    }

    /** Sets a rope's unstretched length (m; at least ROPE.minLength). A winch changes it a little each step. */
    setLength(id: number, length: number): void {
        const r = this.list.get(id);
        if (r) r.length = Math.max(ROPE.minLength, length);
    }

    /** Tension (N) last step; 0 when slack or gone. */
    tension(id: number): number {
        return this.list.get(id)?.tension ?? 0;
    }

    /** The distance between its two ends now (m). */
    span(id: number): number {
        const r = this.list.get(id);
        if (!r) return 0;
        const [p, q] = this.ends(r);
        return Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z);
    }

    /** Cuts a rope (no event). */
    cut(id: number): boolean {
        return this.list.delete(id);
    }

    /** Ropes that snapped since the last call. */
    events(): RopeEvent[] {
        return this.snapped.splice(0);
    }

    /** Its two ends in the world now: [a's tie point, b's]. */
    ends(r: Rope): [Vec3, Vec3] {
        return [this.world(r.a, r.la), r.b === GROUND ? { ...r.lb } : this.world(r.b, r.lb)];
    }

    /** Drops ropes whose bodies are gone (a piece removed or respawned elsewhere is still tied). */
    private prune(): void {
        for (const r of this.list.values())
            if (!this.pw.bodies.get(r.a) || (r.b !== GROUND && !this.pw.bodies.get(r.b))) this.list.delete(r.id);
    }

    /** Before each physics step: every taut rope pulls its ends together; a rope past its strength snaps. */
    private pull(): void {
        if (this.list.size === 0) return;
        this.prune();
        const dt = SIM_DT;
        for (const r of [...this.list.values()]) {
            const A = this.pw.bodies.get(r.a)!;
            const B = r.b === GROUND ? null : this.pw.bodies.get(r.b)!;
            const [p, q] = this.ends(r);
            const dx = q.x - p.x;
            const dy = q.y - p.y;
            const dz = q.z - p.z;
            const d = Math.hypot(dx, dy, dz);
            const stretch = d - r.length;
            const prev = r.stretch;
            r.stretch = Math.max(0, stretch);
            if (stretch <= 0 || d < 1e-6) {
                r.tension = 0;
                continue;
            }
            const n = { x: dx / d, y: dy / d, z: dz / d };
            // how fast it is stretching, over the last step (not the ends' velocities now: those
            // hold the step's gravity, which this pull is about to take out, and damped it read as
            // stretching: a hanging block sat 12 % short of its stretch)
            const rate = (r.stretch - prev) / dt;
            // the masses the line moves, along it at its ends (a body's turn included)
            const invA = A.kind === 'dynamic' ? invMassAt(A.body, p, n) : 0;
            const invB = B && B.kind === 'dynamic' ? invMassAt(B.body, q, n) : 0;
            const inv = invA + invB;
            if (inv <= 0) {
                r.tension = 0;
                continue;
            }
            const m = 1 / inv;
            const k = Math.min(ROPE.EA / r.length, m * (ROPE.ring / dt) ** 2);
            const c = 2 * ROPE.damping * Math.sqrt(k * m);
            const T = Math.max(0, k * stretch + c * rate);
            r.tension = T;
            if (T > ROPE.strength) {
                this.list.delete(r.id);
                this.snapped.push({
                    kind: 'snap',
                    id: r.id,
                    x: (p.x + q.x) / 2,
                    y: (p.y + q.y) / 2,
                    z: (p.z + q.z) / 2
                });
                continue;
            }
            // (an impulse on a sleeping body is lost: pieces spawn asleep, and a still one sleeps)
            if (invA > 0 && A.body.isSleeping()) A.body.wakeUp();
            if (B && invB > 0 && B.body.isSleeping()) B.body.wakeUp();
            const j = T * dt;
            if (invA > 0) A.body.applyImpulseAtPoint({ x: n.x * j, y: n.y * j, z: n.z * j }, p, true);
            if (B && invB > 0) B.body.applyImpulseAtPoint({ x: -n.x * j, y: -n.y * j, z: -n.z * j }, q, true);
        }
    }

    private world(id: number, l: Vec3): Vec3 {
        const b = this.pw.bodies.get(id)!.body;
        const t = b.translation();
        const q = b.rotation();
        // v' = v + 2 w (u x v) + 2 u x (u x v)
        const cx = q.y * l.z - q.z * l.y;
        const cy = q.z * l.x - q.x * l.z;
        const cz = q.x * l.y - q.y * l.x;
        return {
            x: t.x + l.x + 2 * (q.w * cx + (q.y * cz - q.z * cy)),
            y: t.y + l.y + 2 * (q.w * cy + (q.z * cx - q.x * cz)),
            z: t.z + l.z + 2 * (q.w * cz + (q.x * cy - q.y * cx))
        };
    }
}

/** 1 / (the mass a push along n at p moves): 1/m + (r x n) . I^-1 (r x n). */
function invMassAt(b: RAPIER.RigidBody, p: Vec3, n: Vec3): number {
    const m = b.mass();
    if (!(m > 0)) return 0;
    const c = b.worldCom();
    const rx = p.x - c.x;
    const ry = p.y - c.y;
    const rz = p.z - c.z;
    const ux = ry * n.z - rz * n.y;
    const uy = rz * n.x - rx * n.z;
    const uz = rx * n.y - ry * n.x;
    const u2 = ux * ux + uy * uy + uz * uz;
    if (u2 < 1e-12) return 1 / m;
    // inertia about the axis r x n: u.I.u / |u|^2; its share of the push is |u|^2 / I_u
    const I = b.effectiveAngularInertia();
    const Iu =
        (ux * (I.m11 * ux + I.m12 * uy + I.m13 * uz) +
            uy * (I.m12 * ux + I.m22 * uy + I.m23 * uz) +
            uz * (I.m13 * ux + I.m23 * uy + I.m33 * uz)) /
        u2;
    return 1 / m + (Iu > 0 ? u2 / Iu : 0);
}
