/**
 * Smooth meshes for "Voxels: Off": the source geometry the voxelizer works from, as ordinary
 * triangles. No engine imports, so it runs in a worker and in Node tests.
 *
 * - Analytic volumes (box, ellipsoid, cylinder, cone) become their tessellated primitive.
 * - Volumes with no primitive ('custom': a hollow bucket, a vest) are polygonized from their own
 *   sample() with marching tetrahedra on a grid of `customStep` metres.
 * - Ground is a heightfield of the level's continuous height.
 *
 * Every vertex takes its colour from the volume's own material field, sampled just inside the
 * surface, so bark, cut ends, needles and paint come out where the voxels put them. Output is split
 * by surface class (rough, satin, metal) like the voxel meshes, so the same three materials draw it.
 */

import { mat34, poseToMat34 } from '../voxels/math.ts';
import type { Mat34, Pose } from '../voxels/math.ts';
import { SURFACE_CLASS_COUNT, VALUE_COUNT, VALUE_RGB, VALUE_SURFACE } from '../voxels/palette.ts';
import type { Volume } from '../voxels/volumes.ts';
import type { ClassMesh } from '../workers/protocol.ts';

/** Growable buffers for one surface class. */
class ClassBuilder {
    positions: number[] = [];
    normals: number[] = [];
    colors: number[] = [];
    indices: number[] = [];
    get vertexCount(): number {
        return this.positions.length / 3;
    }
    toMesh(): ClassMesh {
        return {
            positions: new Float32Array(this.positions),
            normals: new Float32Array(this.normals),
            colors: new Uint8Array(this.colors),
            indices: new Uint32Array(this.indices),
            vertexCount: this.vertexCount,
            indexCount: this.indices.length
        };
    }
}

export class SmoothBuilder {
    readonly classes: ClassBuilder[] = Array.from({ length: SURFACE_CLASS_COUNT }, () => new ClassBuilder());
    triangles = 0;

    /** One triangle, flat or with given normals; colour from a voxel value per corner. */
    tri(cls: number, p: ArrayLike<number>, n: ArrayLike<number>, values: readonly [number, number, number]): void {
        const b = this.classes[cls];
        const base = b.vertexCount;
        for (let v = 0; v < 3; v++) {
            b.positions.push(p[v * 3], p[v * 3 + 1], p[v * 3 + 2]);
            b.normals.push(n[v * 3], n[v * 3 + 1], n[v * 3 + 2]);
            const rgb = VALUE_RGB[values[v]] ?? 0xffffff;
            b.colors.push(rgb & 255, (rgb >> 8) & 255, (rgb >> 16) & 255, 255);
        }
        b.indices.push(base, base + 1, base + 2);
        this.triangles++;
    }

    get empty(): boolean {
        return this.triangles === 0;
    }

    toMeshes(): ClassMesh[] {
        return this.classes.map((c) => c.toMesh());
    }
}

/** A voxel value's surface class (rough when the value is out of range). */
export function surfaceOf(value: number): number {
    return value > 0 && value < VALUE_COUNT ? VALUE_SURFACE[value] : 0;
}

// ------------------------------------------------------------------------------- local meshes

/** A triangle soup in a volume's local frame (positions, normals per corner). */
interface Soup {
    positions: number[];
    normals: number[];
}

const SEG = 16;

function pushTri(s: Soup, a: number[], b: number[], c: number[], na: number[], nb: number[], nc: number[]): void {
    s.positions.push(...a, ...b, ...c);
    s.normals.push(...na, ...nb, ...nc);
}

function flatNormal(a: number[], b: number[], c: number[]): number[] {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    return [nx / l, ny / l, nz / l];
}

function quad(s: Soup, a: number[], b: number[], c: number[], d: number[]): void {
    const n = flatNormal(a, b, c);
    pushTri(s, a, b, c, n, n, n);
    pushTri(s, a, c, d, n, n, n);
}

function boxSoup(hx: number, hy: number, hz: number): Soup {
    const s: Soup = { positions: [], normals: [] };
    const P = (x: number, y: number, z: number) => [x * hx, y * hy, z * hz];
    quad(s, P(1, -1, -1), P(1, 1, -1), P(1, 1, 1), P(1, -1, 1));
    quad(s, P(-1, -1, 1), P(-1, 1, 1), P(-1, 1, -1), P(-1, -1, -1));
    quad(s, P(-1, 1, -1), P(-1, 1, 1), P(1, 1, 1), P(1, 1, -1));
    quad(s, P(-1, -1, 1), P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1));
    quad(s, P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1));
    quad(s, P(1, -1, -1), P(-1, -1, -1), P(-1, 1, -1), P(1, 1, -1));
    return s;
}

function ellipsoidSoup(rx: number, ry: number, rz: number): Soup {
    const s: Soup = { positions: [], normals: [] };
    const rings = SEG / 2;
    const at = (i: number, j: number) => {
        const th = (i / rings) * Math.PI;
        const ph = (j / SEG) * Math.PI * 2;
        const ux = Math.sin(th) * Math.cos(ph);
        const uy = Math.cos(th);
        const uz = Math.sin(th) * Math.sin(ph);
        const p = [ux * rx, uy * ry, uz * rz];
        const n = [ux / rx, uy / ry, uz / rz];
        const l = Math.hypot(n[0], n[1], n[2]) || 1;
        return { p, n: [n[0] / l, n[1] / l, n[2] / l] };
    };
    for (let i = 0; i < rings; i++)
        for (let j = 0; j < SEG; j++) {
            const a = at(i, j);
            const b = at(i + 1, j);
            const c = at(i + 1, j + 1);
            const d = at(i, j + 1);
            if (i > 0) pushTri(s, a.p, d.p, c.p, a.n, d.n, c.n);
            if (i < rings - 1) pushTri(s, a.p, c.p, b.p, a.n, c.n, b.n);
        }
    return s;
}

/** A cylinder along y, centred; turned to its axis afterwards. */
function cylinderSoupY(r: number, h: number): Soup {
    const s: Soup = { positions: [], normals: [] };
    for (let j = 0; j < SEG; j++) {
        const a0 = (j / SEG) * Math.PI * 2;
        const a1 = ((j + 1) / SEG) * Math.PI * 2;
        const c0 = Math.cos(a0);
        const s0 = Math.sin(a0);
        const c1 = Math.cos(a1);
        const s1 = Math.sin(a1);
        const n0 = [c0, 0, s0];
        const n1 = [c1, 0, s1];
        pushTri(s, [r * c0, -h, r * s0], [r * c1, h, r * s1], [r * c1, -h, r * s1], n0, n1, n1);
        pushTri(s, [r * c0, -h, r * s0], [r * c0, h, r * s0], [r * c1, h, r * s1], n0, n0, n1);
        pushTri(s, [0, h, 0], [r * c1, h, r * s1], [r * c0, h, r * s0], [0, 1, 0], [0, 1, 0], [0, 1, 0]);
        pushTri(s, [0, -h, 0], [r * c0, -h, r * s0], [r * c1, -h, r * s1], [0, -1, 0], [0, -1, 0], [0, -1, 0]);
    }
    return s;
}

function coneSoup(r: number, h: number): Soup {
    const s: Soup = { positions: [], normals: [] };
    const k = r / h;
    for (let j = 0; j < SEG; j++) {
        const a0 = (j / SEG) * Math.PI * 2;
        const a1 = ((j + 1) / SEG) * Math.PI * 2;
        const am = (a0 + a1) / 2;
        const nl = Math.hypot(1, k);
        const n = (a: number) => [Math.cos(a) / nl, k / nl, Math.sin(a) / nl];
        const p0 = [r * Math.cos(a0), 0, r * Math.sin(a0)];
        const p1 = [r * Math.cos(a1), 0, r * Math.sin(a1)];
        pushTri(s, p0, [0, h, 0], p1, n(a0), n(am), n(a1));
        pushTri(s, [0, 0, 0], p0, p1, [0, -1, 0], [0, -1, 0], [0, -1, 0]);
    }
    return s;
}

// Marching tetrahedra: a cube split into six tetrahedra along its main diagonal.
const CUBE = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
    [0, 1, 1]
];
const TETS = [
    [0, 5, 1, 6],
    [0, 1, 2, 6],
    [0, 2, 3, 6],
    [0, 3, 7, 6],
    [0, 7, 4, 6],
    [0, 4, 5, 6]
];

/**
 * Polygonizes a volume from its sample() (inside where it is not 0) on a grid of `step` metres over
 * its bounds (one empty cell of margin), with marching tetrahedra. Edge crossings are refined by
 * bisection, so the surface follows the true shape to a few millimetres.
 */
export function customSoup(volume: Volume, step: number): Soup {
    const s: Soup = { positions: [], normals: [] };
    const b = volume.bounds;
    const nx = Math.ceil((b.maxX - b.minX) / step) + 2;
    const ny = Math.ceil((b.maxY - b.minY) / step) + 2;
    const nz = Math.ceil((b.maxZ - b.minZ) / step) + 2;
    const x0 = b.minX - step;
    const y0 = b.minY - step;
    const z0 = b.minZ - step;
    const inside = new Uint8Array((nx + 1) * (ny + 1) * (nz + 1));
    const idx = (i: number, j: number, k: number) => i + (nx + 1) * (j + (ny + 1) * k);
    for (let k = 0; k <= nz; k++)
        for (let j = 0; j <= ny; j++)
            for (let i = 0; i <= nx; i++)
                inside[idx(i, j, k)] = volume.sample(x0 + i * step, y0 + j * step, z0 + k * step) !== 0 ? 1 : 0;
    const crossing = (a: number[], c: number[]): number[] => {
        // a inside, c outside: bisect
        let lo = a;
        let hi = c;
        for (let it = 0; it < 6; it++) {
            const m = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
            if (volume.sample(m[0], m[1], m[2]) !== 0) lo = m;
            else hi = m;
        }
        return [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    };
    const corner = [0, 0, 0, 0];
    const pts: number[][] = [[], [], [], []];
    for (let k = 0; k < nz; k++)
        for (let j = 0; j < ny; j++)
            for (let i = 0; i < nx; i++) {
                let any = 0;
                for (let c = 0; c < 8; c++) any += inside[idx(i + CUBE[c][0], j + CUBE[c][1], k + CUBE[c][2])];
                if (any === 0 || any === 8) continue;
                for (const t of TETS) {
                    let mask = 0;
                    for (let v = 0; v < 4; v++) {
                        const c = CUBE[t[v]];
                        corner[v] = inside[idx(i + c[0], j + c[1], k + c[2])];
                        pts[v] = [x0 + (i + c[0]) * step, y0 + (j + c[1]) * step, z0 + (k + c[2]) * step];
                        if (corner[v]) mask |= 1 << v;
                    }
                    if (mask === 0 || mask === 15) continue;
                    const ins = [0, 1, 2, 3].filter((v) => corner[v]);
                    const outs = [0, 1, 2, 3].filter((v) => !corner[v]);
                    // a point just inside, to orient the faces outward
                    const cin = [0, 0, 0];
                    for (const v of ins) for (let a = 0; a < 3; a++) cin[a] += pts[v][a] / ins.length;
                    const emit = (a: number[], bb: number[], c: number[]) => {
                        let n = flatNormal(a, bb, c);
                        const toIn = [cin[0] - a[0], cin[1] - a[1], cin[2] - a[2]];
                        if (n[0] * toIn[0] + n[1] * toIn[1] + n[2] * toIn[2] > 0) {
                            n = [-n[0], -n[1], -n[2]];
                            pushTri(s, a, c, bb, n, n, n);
                        } else pushTri(s, a, bb, c, n, n, n);
                    };
                    if (ins.length === 1 || ins.length === 3) {
                        const lone = ins.length === 1 ? ins[0] : outs[0];
                        const others = [0, 1, 2, 3].filter((v) => v !== lone);
                        const e = others.map((o) =>
                            ins.length === 1 ? crossing(pts[lone], pts[o]) : crossing(pts[o], pts[lone])
                        );
                        emit(e[0], e[1], e[2]);
                    } else {
                        const [a, bb] = ins;
                        const [c, d] = outs;
                        const ac = crossing(pts[a], pts[c]);
                        const ad = crossing(pts[a], pts[d]);
                        const bc = crossing(pts[bb], pts[c]);
                        const bd = crossing(pts[bb], pts[d]);
                        emit(ac, ad, bd);
                        emit(ac, bd, bc);
                    }
                }
            }
    return s;
}

/** Local triangles of a volume (cached per volume and step). */
const soups = new WeakMap<Volume, Map<number, Soup>>();
export function volumeSoup(volume: Volume, customStep: number): Soup {
    let m = soups.get(volume);
    if (!m) {
        m = new Map();
        soups.set(volume, m);
    }
    const key = volume.shape.type === 'custom' ? customStep : 0;
    let s = m.get(key);
    if (!s) {
        const sh = volume.shape;
        if (sh.type === 'box') s = boxSoup(sh.hx, sh.hy, sh.hz);
        else if (sh.type === 'ellipsoid') s = ellipsoidSoup(sh.rx, sh.ry, sh.rz);
        else if (sh.type === 'cone') s = coneSoup(sh.radius, sh.height);
        else if (sh.type === 'cylinder') {
            s = cylinderSoupY(sh.radius, sh.halfLength);
            if (sh.axis !== 'y') {
                // y -> x: (x, y, z) -> (y, -x, z); y -> z: (x, y, z) -> (x, -z, y)
                const turn = (a: number[], o: number) => {
                    for (let i = o; i < a.length; i += 3) {
                        const x = a[i];
                        const y = a[i + 1];
                        const z = a[i + 2];
                        if (sh.axis === 'x') {
                            a[i] = y;
                            a[i + 1] = -x;
                        } else {
                            a[i + 1] = -z;
                            a[i + 2] = y;
                        }
                    }
                };
                turn(s.positions, 0);
                turn(s.normals, 0);
            }
        } else s = customSoup(volume, customStep);
        m.set(key, s);
    }
    return s;
}

/** How far inside the surface a vertex's colour is read (m). */
const COLOUR_DEPTH = 0.012;

/**
 * Adds a volume at a world pose (identity: its local frame). Each corner's colour is the volume's
 * own value just inside the surface there (the centre's when that point is outside it).
 */
export function addVolume(out: SmoothBuilder, volume: Volume, p: Pose | null, customStep: number): void {
    const s = volumeSoup(volume, customStep);
    const m = p ? poseToMat34(p, _m) : null;
    const b = volume.bounds;
    const centre = volume.sample((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2);
    const tp = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const tn = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const vals: [number, number, number] = [0, 0, 0];
    for (let t = 0; t < s.positions.length; t += 9) {
        let cls = -1;
        for (let v = 0; v < 3; v++) {
            const o = t + v * 3;
            const lx = s.positions[o];
            const ly = s.positions[o + 1];
            const lz = s.positions[o + 2];
            const nx = s.normals[o];
            const ny = s.normals[o + 1];
            const nz = s.normals[o + 2];
            let val = volume.sample(lx - nx * COLOUR_DEPTH, ly - ny * COLOUR_DEPTH, lz - nz * COLOUR_DEPTH);
            if (val === 0) val = centre;
            vals[v] = val;
            if (cls < 0 && val !== 0) cls = surfaceOf(val);
            if (m) {
                tp[v * 3] = m[0] * lx + m[1] * ly + m[2] * lz + m[3];
                tp[v * 3 + 1] = m[4] * lx + m[5] * ly + m[6] * lz + m[7];
                tp[v * 3 + 2] = m[8] * lx + m[9] * ly + m[10] * lz + m[11];
                tn[v * 3] = m[0] * nx + m[1] * ny + m[2] * nz;
                tn[v * 3 + 1] = m[4] * nx + m[5] * ny + m[6] * nz;
                tn[v * 3 + 2] = m[8] * nx + m[9] * ny + m[10] * nz;
            } else {
                tp[v * 3] = lx;
                tp[v * 3 + 1] = ly;
                tp[v * 3 + 2] = lz;
                tn[v * 3] = nx;
                tn[v * 3 + 1] = ny;
                tn[v * 3 + 2] = nz;
            }
        }
        out.tri(Math.max(0, cls), tp, tn, vals);
    }
}
const _m: Mat34 = mat34();

/** A small axis-aligned box (a single voxel cell written cell by cell: reeds, flowers). */
export function addCellBox(out: SmoothBuilder, x0: number, y0: number, z0: number, size: number, value: number): void {
    const s = boxSoup(size / 2, size / 2, size / 2);
    const tp = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const tn = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const cls = surfaceOf(value);
    for (let t = 0; t < s.positions.length; t += 9) {
        for (let v = 0; v < 9; v += 3) {
            tp[v] = s.positions[t + v] + x0 + size / 2;
            tp[v + 1] = s.positions[t + v + 1] + y0 + size / 2;
            tp[v + 2] = s.positions[t + v + 2] + z0 + size / 2;
            tn[v] = s.normals[t + v];
            tn[v + 1] = s.normals[t + v + 1];
            tn[v + 2] = s.normals[t + v + 2];
        }
        out.tri(cls, tp, tn, [value, value, value]);
    }
}

/**
 * Ground: a heightfield of `height` over [x0, x1] x [z0, z1] at `step`, coloured by `value` (the
 * terrain's own surface material there, given the height and its slope along x and z).
 */
export function addHeightfield(
    out: SmoothBuilder,
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    step: number,
    height: (x: number, z: number) => number,
    value: (x: number, z: number, h: number, dhdx: number, dhdz: number) => number
): void {
    const nx = Math.max(1, Math.round((x1 - x0) / step));
    const nz = Math.max(1, Math.round((z1 - z0) / step));
    const sx = (x1 - x0) / nx;
    const sz = (z1 - z0) / nz;
    const H = new Float64Array((nx + 3) * (nz + 3));
    const W = nx + 3;
    for (let k = -1; k <= nz + 1; k++)
        for (let i = -1; i <= nx + 1; i++) H[i + 1 + (k + 1) * W] = height(x0 + i * sx, z0 + k * sz);
    const h = (i: number, k: number) => H[i + 1 + (k + 1) * W];
    const slope = [0, 0];
    const normal = (i: number, k: number) => {
        const dx = (h(i + 1, k) - h(i - 1, k)) / (2 * sx);
        const dz = (h(i, k + 1) - h(i, k - 1)) / (2 * sz);
        slope[0] = dx;
        slope[1] = dz;
        const l = Math.hypot(dx, 1, dz);
        return [-dx / l, 1 / l, -dz / l];
    };
    const tp = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const tn = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const vals: [number, number, number] = [0, 0, 0];
    const corner = (slot: number, i: number, k: number) => {
        const x = x0 + i * sx;
        const z = z0 + k * sz;
        tp[slot * 3] = x;
        tp[slot * 3 + 1] = h(i, k);
        tp[slot * 3 + 2] = z;
        const n = normal(i, k);
        tn[slot * 3] = n[0];
        tn[slot * 3 + 1] = n[1];
        tn[slot * 3 + 2] = n[2];
        vals[slot] = value(x, z, h(i, k), slope[0], slope[1]);
    };
    for (let k = 0; k < nz; k++)
        for (let i = 0; i < nx; i++) {
            corner(0, i, k);
            corner(1, i, k + 1);
            corner(2, i + 1, k + 1);
            out.tri(surfaceOf(vals[0]), tp, tn, vals);
            corner(0, i, k);
            corner(1, i + 1, k + 1);
            corner(2, i + 1, k);
            out.tri(surfaceOf(vals[0]), tp, tn, vals);
        }
}
