/**
 * The joint graph on the wire (Epic 5): the host sends its nails to guests whenever the graph
 * changes, so every device draws the same nail heads (and, later, the same structure overlay).
 * Guests run no physics, so this is display data: they never build joints from it.
 *
 * Layout (little endian): u8 version, u16 count, then per nail:
 *   u16 a: entity index (sim entity order, the same on every device running the same build)
 *   u16 b: entity index, or 0xffff for ground
 *   i16 x3 nail head in a's local frame, in millimetres (+-32 m)
 */

import type { JointGraph } from './graph.ts';
import { GROUND, NAIL } from './graph.ts';

export const NAILS_VERSION = 1;
const B_GROUND = 0xffff;
const MM = 0.001;

/** One nail head to draw: on entity index `a` (local frame), fastened to `b` (index, or -1 ground). */
export interface NailMark {
    a: number;
    b: number;
    x: number;
    y: number;
    z: number;
    /** How hard its connection is working: 0 calm, 1 creaking, 2 groaning (strainLevels). */
    strain: number;
}

/**
 * The marks of a graph, with entity ids turned into entity indices; `strainOf` gives each
 * connection's strain level (default calm).
 */
export function nailMarks(
    graph: JointGraph,
    indexOf: (id: number) => number,
    strainOf: (connectionId: number) => number = () => 0
): NailMark[] {
    const out: NailMark[] = [];
    for (const c of graph.connections()) {
        const a = indexOf(c.a);
        if (a < 0) continue;
        const b = c.b === GROUND ? -1 : indexOf(c.b);
        const strain = strainOf(c.id);
        for (const n of c.nails) out.push({ a, b, x: n.x, y: n.y, z: n.z, strain });
    }
    return out;
}

/** Strain levels of marks as a short string, one digit per mark (sent when it changes). */
export function encodeStrain(marks: readonly NailMark[]): string {
    let s = '';
    for (let i = 0; i < Math.min(marks.length, NAIL.maxTotal); i++)
        s += String(Math.max(0, Math.min(2, marks[i].strain)));
    return s;
}

/** Applies a strain string (untrusted) to decoded marks, in order. */
export function applyStrain(marks: NailMark[], s: unknown): void {
    const str = typeof s === 'string' ? s : '';
    for (let i = 0; i < marks.length; i++) {
        const d = str.charCodeAt(i) - 48;
        marks[i].strain = d >= 0 && d <= 2 ? d : 0;
    }
}

const clampI16 = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v)));

export function encodeNails(marks: readonly NailMark[]): Uint8Array {
    const n = Math.min(marks.length, NAIL.maxTotal);
    const bytes = new Uint8Array(3 + n * 10);
    const dv = new DataView(bytes.buffer);
    dv.setUint8(0, NAILS_VERSION);
    dv.setUint16(1, n, true);
    for (let i = 0; i < n; i++) {
        const m = marks[i];
        const o = 3 + i * 10;
        dv.setUint16(o, m.a, true);
        dv.setUint16(o + 2, m.b < 0 ? B_GROUND : m.b, true);
        dv.setInt16(o + 4, clampI16(m.x / MM), true);
        dv.setInt16(o + 6, clampI16(m.y / MM), true);
        dv.setInt16(o + 8, clampI16(m.z / MM), true);
    }
    return bytes;
}

/** Decodes untrusted bytes; null if malformed. Entity indices at or past `entityCount` are dropped. */
export function decodeNails(bytes: Uint8Array, entityCount: number): NailMark[] | null {
    if (bytes.length < 3) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint8(0) !== NAILS_VERSION) return null;
    const n = dv.getUint16(1, true);
    if (n > NAIL.maxTotal || bytes.length < 3 + n * 10) return null;
    const out: NailMark[] = [];
    for (let i = 0; i < n; i++) {
        const o = 3 + i * 10;
        const a = dv.getUint16(o, true);
        const rb = dv.getUint16(o + 2, true);
        const b = rb === B_GROUND ? -1 : rb;
        if (a >= entityCount || b >= entityCount) continue;
        out.push({
            a,
            b,
            x: dv.getInt16(o + 4, true) * MM,
            y: dv.getInt16(o + 6, true) * MM,
            z: dv.getInt16(o + 8, true) * MM,
            strain: 0
        });
    }
    return out;
}
