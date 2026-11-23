/**
 * The joint graph (design doc §2.5, Epic 5, #47): what is fastened to what. A bridge is a set of
 * real bodies plus these connections; a grid-snapped look never implies one. Pure data, engine-
 * and physics-free: the simulation owns one graph and mirrors each connection into a physics joint
 * (src/sim/joints/joints.ts), guests rebuild it from the host's wire form.
 *
 * One connection per pair of bodies (no duplicate links), and one per anchor site on the ground.
 * Each nail driven between the same two pieces at a new spot adds to that connection's strength
 * instead of making another link.
 */

import type { Vec3 } from '../../voxels/math.ts';

/** `b` of a connection to stable ground (an abutment, a rock, the terrain): an anchor. */
export const GROUND = -1;

export type JointType = 'nail' | 'anchor';

export const NAIL = {
    /** Length of a nail (m): it must pass through the first piece and bite into the second. */
    length: 0.3,
    /** How far into the second piece a nail must reach to hold (m). */
    minBite: 0.04,
    /** Widest gap a nail may cross between the two pieces (m): no fastening across thin air. */
    maxGap: 0.05,
    /** Reach of the hammer from the eye (m): as far as a grab reaches (GRAB.reach). */
    reach: 2.6,
    /** Steepest angle off the face normal a nail is driven at (cosine; 0.82: about 35 degrees). */
    minCos: 0.82,
    /** The two pieces may not move against each other faster than this (m/s) while nailing. */
    maxSlip: 0.35,
    /** Nails in one connection closer together than this (m) are the same nail. */
    spacing: 0.06,
    /** Nails into ground within this distance (m) of an anchor reinforce it; further away is a new anchor. */
    anchorSite: 0.5,
    /** Nails per connection: more spread the load, up to this many. */
    maxPerJoint: 4,
    /** Nails in the whole world (bounded network state). */
    maxTotal: 64,
    /**
     * Shear capacity of one nail (N), and its withdrawal capacity (N), for a calibrated break
     * (#49): an 8 mm x 300 mm spike in C24 softwood (rho_k 350 kg/m3), characteristic values of
     * EN 1995-1-1. Shear 8.2.2 (8.6 f): f_h,k = 0.082 rho_k d^-0.3 = 15.4 MPa, M_y,Rk = 0.3 f_u
     * d^2.6 = 40.1 N m (f_u 600 MPa), 1.15 sqrt(2 M_y f_h d) = 3.6 kN, plus the rope effect (up to
     * 15 %): 4.2 kN. Withdrawal 8.3.2: f_ax,k = 20e-6 rho_k^2 = 2.45 MPa x d x 100 mm penetration
     * = 2.0 kN. The game breaks at the characteristic value itself (no partial factor: a design
     * would allow kmod / gamma_M = 0.9 / 1.3 = 0.69 of it).
     */
    strength: 4000,
    withdrawal: 2000,
    /**
     * Slip modulus of one nail (N/m): how far it gives under load, from EN 1995-1-1 7.1,
     * K_ser = rho_m^1.5 d^0.8 / 30 per shear plane (rho_m 420 kg/m3 softwood, d 8 mm): 1.5 kN/mm.
     */
    slipModulus: 1.5e6,
    /**
     * A nail's own lever against a turn (m): how deep below the face it bears in bending. With the
     * slip modulus it gives a nail's turn stiffness (K_ser x lever^2) and, with its shear, its
     * moment capacity (strength x lever); see angularStiffness and breaking.ts.
     */
    lever: 0.04,
    /**
     * Turn stiffness of the faces a joint presses together (N m/rad): timber bedding on its seat,
     * E_90,mean x I / t, C24 (EN 338: E_90,mean 370 MPa) on a 20 x 15 cm face (I = b h^3 / 12 =
     * 5.6e-5 m^4) crushing through 10 cm: 2.1e5. The nails are softer in a turn (K_ser x lever^2 =
     * 2.4e3 for one), but it is the pressed faces that hold a seated piece square; with only the
     * nails' spring Rapier let a cantilevered beam rock on its pin (up to 12 rad/s).
     */
    bedding: 2.1e5,
    /** How far from a nail the faces it holds together count as its own (m; stress.ts). */
    faceReach: 0.6,
    /**
     * The damping time of the turn about the nails (s): two faces turning flat on each other rub
     * (with the nails' spring alone, a beam spiked at one end yawed on, damping ratio 0.05).
     */
    twistDamping: 0.05,
    /** The damping time of the joint springs (s). */
    angularDamping: 0.005,
    /** Relative stiffness of a joint: timber to timber flexes more than a spike into stone. */
    stiffness: 0.8,
    anchorStiffness: 1,
    /**
     * Extra solver iterations a nailed piece gets (Rapier's per-body count, on top of the world's
     * 4). The timber springs are stiff for a 24 kg plank's roll at a 60 Hz step, and with the
     * world's iterations the solve left a residue that kept an 8-plank deck quivering (up to 1.3
     * rad/s) and awake forever, at about 1.2 ms a step; under a 113 kg crate it walked the crate
     * 5.4 cm in 10 s. With 24 more the same deck sleeps within 3 s, idle or under the crate. The
     * cost is paid only while the deck is awake.
     */
    solverIterations: 24
} as const;

/**
 * Angular stiffness of a connection's joint (N m/rad). Timber to timber: about every axis. An
 * anchor (a spike into stone or ground) is a pin in bending, and stiff only about the nails' own
 * axis (two nails side by side resist a turn about it as a couple: a beam spiked down at one end
 * does not swing round in the current).
 */
/** sum(lever^2 + r^2) over a connection's nails, r from the group's centre (m^2). */
function nailArm2(c: { nails: Vec3[] }): number {
    const n = c.nails.length;
    if (!n) return NAIL.lever * NAIL.lever;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const p of c.nails) {
        cx += p.x / n;
        cy += p.y / n;
        cz += p.z / n;
    }
    let sum = 0;
    for (const p of c.nails) sum += NAIL.lever * NAIL.lever + (p.x - cx) ** 2 + (p.y - cy) ** 2 + (p.z - cz) ** 2;
    return sum;
}

/**
 * Turn stiffness of a connection about its nails' own axis (N m/rad): only the nails hold that
 * turn (two pieces turning flat on each other slide over the faces), as a couple: K_ser x sum(lever^2
 * + r^2) (EN 1995-1-1 7.1 slip modulus per nail, r from the group's centre), times the joint's
 * stiffness.
 */
export function twistStiffness(c: { stiffness: number; nails: Vec3[] }): number {
    return c.stiffness * NAIL.slipModulus * nailArm2(c);
}

/**
 * Turn stiffness across the nails (tipping one piece on the other, N m/rad): the faces pressed
 * together bed against it (NAIL.bedding), or the nails' couple where that is stiffer.
 */
export function angularStiffness(c: { stiffness: number; nails: Vec3[] }): number {
    return c.stiffness * Math.max(NAIL.bedding, NAIL.slipModulus * nailArm2(c));
}

/** Linear stiffness of a connection's joint (N/m): its nails' slip modulus. */
export function linearStiffness(c: { nails: unknown[] }): number {
    return Math.max(1, c.nails.length) * NAIL.slipModulus;
}

export interface Connection {
    id: number;
    /** Entity ids. `b` is GROUND for an anchor. */
    a: number;
    b: number;
    type: JointType;
    /** Where the connection holds, in a's local frame and in b's (world for an anchor). */
    anchorA: Vec3;
    anchorB: Vec3;
    /** b's orientation relative to a's when fastened (q_b^-1 * q_a; q_a for an anchor). */
    rel: { x: number; y: number; z: number; w: number };
    /** Nail heads, in a's local frame (the visual markers and the nail count). */
    nails: Vec3[];
    /**
     * Into b, in b's local frame (world for an anchor; unit): against the face of b the first nail
     * entered. Pressing a against b along it is bearing (the pieces carry it, not the nails); see
     * stress.ts.
     */
    axis?: Vec3;
    /**
     * The collider the nails bite into (an anchor's stone; runtime only): with a's own shape, the
     * extent of the faces a moment across the nails tips the pieces onto (stress.ts).
     */
    behind?: number;
    stiffness: number;
    /** Load the connection takes before it breaks (N); grows with nails. */
    strength: number;
    /** Accumulated damage 0..1 from sustained or repeated overload (#49). */
    fatigue: number;
    /** Tick it was made. */
    tick: number;
}

export type NailRefusal =
    | 'none'
    | 'not-timber'
    | 'nothing-behind'
    | 'too-thick'
    | 'gap'
    | 'glancing'
    | 'moving'
    | 'cannot-fasten'
    | 'same-spot'
    | 'full'
    | 'limit';

/** Refusals in wire order: code 2 + index (code 0: no timber at the crosshair, 1: a nail would hold). */
export const REFUSALS: readonly NailRefusal[] = [
    'not-timber',
    'nothing-behind',
    'too-thick',
    'gap',
    'glancing',
    'moving',
    'cannot-fasten',
    'same-spot',
    'full',
    'limit'
];

/** The hammer's state as a small number (prompts, guests' HUD). */
export function nailCode(a: number, refusal: NailRefusal): number {
    if (a < 0) return 0;
    return refusal === 'none' ? 1 : 2 + REFUSALS.indexOf(refusal);
}

export function refusalOfCode(code: number): NailRefusal {
    return code >= 2 ? (REFUSALS[code - 2] ?? 'none') : 'none';
}

/** Plain-language reason a nail would not hold (prompts). */
export const REFUSAL_TEXT: Record<NailRefusal, string> = {
    none: '',
    'not-timber': 'only timber takes nails',
    'nothing-behind': 'nothing behind it to nail into',
    'too-thick': 'too thick to nail through here',
    gap: 'gap too wide: close them up first',
    glancing: 'nail it square on',
    moving: 'hold it still',
    'cannot-fasten': "can't nail into that",
    'same-spot': 'already nailed here',
    full: 'fully nailed',
    limit: 'out of nails'
};

export class JointGraph {
    private readonly byId = new Map<number, Connection>();
    private nextId = 1;
    /** Bumped on every topology or nail change (network sync sends only on change). */
    version = 0;

    get size(): number {
        return this.byId.size;
    }

    connections(): IterableIterator<Connection> {
        return this.byId.values();
    }

    get(id: number): Connection | undefined {
        return this.byId.get(id);
    }

    /** Total nails in the world. */
    get nailCount(): number {
        let n = 0;
        for (const c of this.byId.values()) n += c.nails.length;
        return n;
    }

    /**
     * The connection between two bodies (either order), if any. Ground is not one place: an anchor
     * matches only near `at` (world), so a beam nailed down at both ends has two anchors.
     */
    find(a: number, b: number, at?: Vec3): Connection | undefined {
        for (const c of this.byId.values()) {
            if (!((c.a === a && c.b === b) || (c.a === b && c.b === a))) continue;
            if (c.b === GROUND && at) {
                const d = Math.hypot(c.anchorB.x - at.x, c.anchorB.y - at.y, c.anchorB.z - at.z);
                if (d > NAIL.anchorSite) continue;
            }
            return c;
        }
        return undefined;
    }

    /** Every connection touching a body. */
    of(id: number): Connection[] {
        const out: Connection[] = [];
        for (const c of this.byId.values()) if (c.a === id || c.b === id) out.push(c);
        return out;
    }

    /**
     * Adds a connection. Refuses (returns null) a link from a body to itself, a duplicate pair, or a
     * ground-to-ground link.
     */
    add(c: Omit<Connection, 'id' | 'fatigue' | 'strength'> & { strength?: number }): Connection | null {
        if (c.a === c.b || c.a === GROUND || this.find(c.a, c.b, c.anchorB)) return null;
        const conn: Connection = {
            ...c,
            id: this.nextId++,
            anchorA: { ...c.anchorA },
            anchorB: { ...c.anchorB },
            rel: { ...c.rel },
            nails: c.nails.map((n) => ({ ...n })),
            axis: c.axis ? { ...c.axis } : undefined,
            behind: c.behind,
            strength: c.strength ?? NAIL.strength * Math.max(1, c.nails.length),
            fatigue: 0
        };
        this.byId.set(conn.id, conn);
        this.version++;
        return conn;
    }

    /**
     * Adds a nail (in `a`'s frame of the connection) to an existing connection: refused at the
     * same spot as one already there, or past the per-joint limit.
     */
    addNail(id: number, local: Vec3): NailRefusal {
        const c = this.byId.get(id);
        if (!c) return 'cannot-fasten';
        const r = this.nailRefusal(c, local);
        if (r !== 'none') return r;
        c.nails.push({ ...local });
        c.strength = NAIL.strength * c.nails.length;
        this.version++;
        return 'none';
    }

    /** Why another nail at `local` (a's frame) would not add to this connection ('none' if it would). */
    nailRefusal(c: Connection, local: Vec3): NailRefusal {
        if (c.nails.length >= NAIL.maxPerJoint) return 'full';
        for (const n of c.nails)
            if (Math.hypot(n.x - local.x, n.y - local.y, n.z - local.z) < NAIL.spacing) return 'same-spot';
        return 'none';
    }

    remove(id: number): Connection | undefined {
        const c = this.byId.get(id);
        if (!c) return undefined;
        this.byId.delete(id);
        this.version++;
        return c;
    }

    clear(): void {
        if (this.byId.size) this.version++;
        this.byId.clear();
    }

    /**
     * Bodies joined to `id` through any chain of connections (itself included; ground excluded),
     * and whether that group is anchored to ground somewhere.
     */
    group(id: number): { bodies: Set<number>; anchored: boolean } {
        const bodies = new Set<number>([id]);
        let anchored = false;
        const todo = [id];
        while (todo.length) {
            const cur = todo.pop()!;
            for (const c of this.of(cur)) {
                const other = c.a === cur ? c.b : c.a;
                if (other === GROUND) anchored = true;
                else if (!bodies.has(other)) {
                    bodies.add(other);
                    todo.push(other);
                }
            }
        }
        return { bodies, anchored };
    }
}
