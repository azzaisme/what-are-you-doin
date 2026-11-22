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
    /** Steepest angle off the face normal a nail is driven at (cosine): no glancing blows. */
    minCos: 0.45,
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
    /** Strength of one nail (N): shear capacity before a calibrated break (#49). */
    strength: 4000,
    /** Relative stiffness of a nailed joint (1 = rigid weld); anchors to ground are stiffer. */
    stiffness: 0.8,
    anchorStiffness: 1
} as const;

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
