/**
 * Structural debug overlay (Epic 5, #51): what each joint carries and the contacts the stress
 * meter reads, as line segments to draw. A debug view, not the game's UI: in play a structure
 * speaks through movement, creaks and its nail heads.
 *
 * - Each connection: a cross at its joint anchor, sized and coloured by its utilization (calm,
 *   creaking, groaning, at capacity), and a line along the force it puts on its piece.
 * - Each contact on a jointed piece: a line along its force, cyan when it belongs to a joint
 *   (folded into that joint's load), grey when it is a free contact such as a beam's seat.
 *
 * Pure: it reads loads and returns segments, so it costs nothing while the overlay is off.
 */

import type { JointSystem } from '../sim/joints/joints.ts';
import type { StressContact } from '../sim/joints/stress.ts';

/** Utilization bands (the creak and groan levels, then capacity): calm, creak, groan, at capacity. */
export const STRAIN_BANDS = [0.55, 0.8, 1] as const;
/** Line length per newton of force (m/N): 1 kN draws 0.25 m. */
export const FORCE_SCALE = 0.25 / 1000;
/** Contacts carrying less than this are left out (N). */
const MIN_CONTACT = 5;

export interface StructureLines {
    /** Joint crosses per band (flat x, y, z pairs): 0 calm, 1 creak, 2 groan, 3 at capacity. */
    bands: [number[], number[], number[], number[]];
    /** Joint force lines. */
    forces: number[];
    /** Contacts folded into a joint. */
    folded: number[];
    /** Free contacts (seats, the ground, other pieces). */
    free: number[];
}

export const emptyLines = (): StructureLines => ({ bands: [[], [], [], []], forces: [], folded: [], free: [] });

export function bandOf(util: number): number {
    let b = 0;
    while (b < STRAIN_BANDS.length && util >= STRAIN_BANDS[b]) b++;
    return b;
}

function cross(out: number[], x: number, y: number, z: number, r: number): void {
    out.push(x - r, y, z, x + r, y, z, x, y - r, z, x, y + r, z, x, y, z - r, x, y, z + r);
}

function line(out: number[], x: number, y: number, z: number, fx: number, fy: number, fz: number): void {
    out.push(x, y, z, x + fx * FORCE_SCALE, y + fy * FORCE_SCALE, z + fz * FORCE_SCALE);
}

/** One frame's lines from a joint system (and the contacts its meter recorded), into `out`. */
export function structureLines(
    js: Pick<JointSystem, 'graph' | 'stress' | 'health'>,
    contacts: readonly StressContact[],
    out: StructureLines = emptyLines()
): StructureLines {
    for (const b of out.bands) b.length = 0;
    out.forces.length = 0;
    out.folded.length = 0;
    out.free.length = 0;
    for (const c of js.graph.connections()) {
        const [x, y, z] = js.stress.anchorWorld(c);
        const util = js.health.states.get(c.id)?.util ?? 0;
        cross(out.bands[bandOf(util)], x, y, z, 0.04 + 0.08 * Math.min(1.5, util));
        const l = js.stress.loads.get(c.id);
        if (l) line(out.forces, x, y, z, l.fx, l.fy, l.fz);
    }
    for (const k of contacts) {
        if (Math.hypot(k.fx, k.fy, k.fz) < MIN_CONTACT) continue;
        line(k.folded ? out.folded : out.free, k.x, k.y, k.z, k.fx, k.fy, k.fz);
    }
    return out;
}
