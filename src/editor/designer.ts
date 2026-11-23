/**
 * Level designer (v1). Edits a LevelData draft (src/levels/data.ts) in place:
 * pick a tool, click the ground to place; select to move (arrow keys), rotate (Q / E), delete
 * (Delete), or edit numbers in the side panel. Edits show as outlines at once; "Build" saves the
 * draft and rebuilds the voxel world (a reload: the world is built per level), "Play" playtests it.
 * The draft lives in local storage; "Copy JSON" / "Import" move levels in and out (send one to
 * Claude to add it to the game).
 */

import { Color, Vec3 } from 'playcanvas';
import type { AppBase, Entity, Layer } from 'playcanvas';

import { BEAM_HALF, plankHalfOf } from '../assets/props.ts';
import { MATERIAL_NAMES, dataHeight, parseLevelData } from '../levels/data.ts';
import type { GroundFeature, LevelData, MaterialName, PieceData } from '../levels/data.ts';
import { starterLevel } from '../levels/starter.ts';

export { starterLevel };

export const DESIGN_KEY = 'uncivil.design';
const CAM_KEY = 'uncivil.design.camera';

export function loadDraft(): LevelData {
    try {
        const raw = localStorage.getItem(DESIGN_KEY);
        if (raw) return parseLevelData(JSON.parse(raw));
    } catch {
        // corrupt or blocked: start fresh
    }
    return starterLevel();
}

export function saveDraft(d: LevelData): void {
    try {
        localStorage.setItem(DESIGN_KEY, JSON.stringify(d));
    } catch {
        // storage blocked: the draft lives only in this page
    }
}

/** Prop entity pools (the entity catalogue's fixed sets). */
const PROP_POOLS: Record<string, string[]> = {
    plank: ['plank', 'extra-plank-0', 'extra-plank-1', 'extra-plank-2', 'extra-plank-3', 'extra-plank-4'],
    beam: ['beam-0', 'beam-1'],
    log: ['log', 'extra-log-0', 'extra-log-1'],
    crate: ['cube'],
    ball: ['sphere'],
    bucket: ['bucket']
};

type Tool =
    | 'select'
    | 'box'
    | 'post'
    | 'pine'
    | 'oak'
    | 'rock'
    | 'ditch'
    | 'mound'
    | 'plank'
    | 'beam'
    | 'log'
    | 'crate'
    | 'ball'
    | 'bucket'
    | 'spawn'
    | 'goal';
const TOOLS: { id: Tool; label: string }[] = [
    { id: 'select', label: 'Select' },
    { id: 'box', label: 'Box' },
    { id: 'post', label: 'Post' },
    { id: 'pine', label: 'Pine' },
    { id: 'oak', label: 'Oak' },
    { id: 'rock', label: 'Rock' },
    { id: 'ditch', label: 'Ditch' },
    { id: 'mound', label: 'Hill' },
    { id: 'plank', label: 'Plank' },
    { id: 'beam', label: 'Beam' },
    { id: 'log', label: 'Log' },
    { id: 'crate', label: 'Crate' },
    { id: 'ball', label: 'Ball' },
    { id: 'bucket', label: 'Bucket' },
    { id: 'spawn', label: 'Start' },
    { id: 'goal', label: 'Goal' }
];

type Sel =
    | { kind: 'piece' | 'tree' | 'rock' | 'prop' | 'feature'; index: number }
    | { kind: 'spawn' | 'goal'; index: 0 }
    | null;

export interface DesignerHost {
    app: AppBase;
    camera: Entity;
    layer: Layer;
    canvas: HTMLCanvasElement;
    /** Saves and rebuilds (reload into the designer). */
    rebuild(d: LevelData): void;
    /** Saves and playtests (reload, first person, the player's own voxel size). */
    play(d: LevelData): void;
    exit(): void;
    toast(text: string): void;
}

const COL = {
    piece: new Color(1, 0.75, 0.3),
    sel: new Color(0.3, 1, 0.5),
    tree: new Color(0.4, 0.9, 0.4),
    prop: new Color(0.5, 0.8, 1),
    goal: new Color(1, 0.4, 0.2),
    spawn: new Color(1, 1, 0.4),
    ditch: new Color(0.6, 0.45, 0.3)
};

export class Designer {
    readonly el: HTMLDivElement;
    d: LevelData;
    private height: (x: number, z: number) => number;
    private tool: Tool = 'select';
    private sel: Sel = null;
    private pendingDitch: { x: number; z: number } | null = null;
    private dirty = false;
    private readonly host: DesignerHost;
    private readonly batches = new Map<Color, Vec3[]>();
    private down: { x: number; y: number; t: number } | null = null;

    constructor(host: DesignerHost, d: LevelData) {
        this.host = host;
        this.d = d;
        this.height = dataHeight(d);
        const el = document.createElement('div');
        el.className = 'designer';
        for (const ev of ['pointerdown', 'mousedown', 'wheel', 'click', 'keydown', 'touchstart'])
            el.addEventListener(ev, (e) => e.stopPropagation());
        document.body.append(el);
        this.el = el;
        host.canvas.addEventListener(
            'pointerdown',
            (e) => (this.down = { x: e.clientX, y: e.clientY, t: performance.now() })
        );
        host.canvas.addEventListener('pointerup', (e) => {
            const d0 = this.down;
            this.down = null;
            // a click (not an orbit drag) places or selects
            if (
                d0 &&
                Math.hypot(e.clientX - d0.x, e.clientY - d0.y) < 6 &&
                performance.now() - d0.t < 500 &&
                e.button === 0
            )
                this.click(e.clientX, e.clientY);
        });
        window.addEventListener('keydown', (e) => this.key(e));
        this.restoreCamera();
        this.render();
    }

    // ------------------------------------------------------------------------------- input

    private pick(sx: number, sy: number): { x: number; z: number } | null {
        const cam = this.host.camera.camera!;
        const rect = this.host.canvas.getBoundingClientRect();
        const x = sx - rect.left;
        const y = sy - rect.top;
        const a = cam.screenToWorld(x, y, cam.nearClip);
        const b = cam.screenToWorld(x, y, cam.farClip);
        const dir = b.clone().sub(a).normalize();
        // march along the ray until it goes under the ground, then refine
        let prev = 0;
        for (let t = 0; t < 250; t += 0.25) {
            const px = a.x + dir.x * t;
            const py = a.y + dir.y * t;
            const pz = a.z + dir.z * t;
            if (py < this.height(px, pz)) {
                let lo = prev;
                let hi = t;
                for (let i = 0; i < 20; i++) {
                    const m = (lo + hi) / 2;
                    if (a.y + dir.y * m < this.height(a.x + dir.x * m, a.z + dir.z * m)) hi = m;
                    else lo = m;
                }
                return { x: round(a.x + dir.x * hi), z: round(a.z + dir.z * hi) };
            }
            prev = t;
        }
        return null;
    }

    private click(sx: number, sy: number): void {
        const p = this.pick(sx, sy);
        if (!p) return;
        const d = this.d;
        const t = this.tool;
        const yawFromView = () => {
            const f = this.host.camera.forward;
            return Math.atan2(-f.x, -f.z);
        };
        switch (t) {
            case 'select':
                this.sel = this.nearest(p.x, p.z);
                break;
            case 'box':
            case 'post': {
                const piece: PieceData =
                    t === 'box'
                        ? {
                              shape: { type: 'box', hx: 0.5, hy: 0.5, hz: 0.5 },
                              x: p.x,
                              y: 0.5,
                              z: p.z,
                              material: 'timber'
                          }
                        : {
                              shape: { type: 'box', hx: 0.08, hy: 0.6, hz: 0.08 },
                              x: p.x,
                              y: 0.6,
                              z: p.z,
                              material: 'dark-timber'
                          };
                d.pieces.push(piece);
                this.sel = { kind: 'piece', index: d.pieces.length - 1 };
                break;
            }
            case 'pine':
            case 'oak':
                d.trees.push({ x: p.x, z: p.z, scale: 1.1, yaw: Math.random() * 6.28, kind: t });
                this.sel = { kind: 'tree', index: d.trees.length - 1 };
                break;
            case 'rock':
                d.rocks.push({ x: p.x, z: p.z, size: 0.5, yaw: Math.random() * 3 });
                this.sel = { kind: 'rock', index: d.rocks.length - 1 };
                break;
            case 'mound':
                d.features.push({ type: 'mound', x: p.x, z: p.z, r: 5, h: 1.5 });
                this.sel = { kind: 'feature', index: d.features.length - 1 };
                break;
            case 'ditch':
                if (!this.pendingDitch) {
                    this.pendingDitch = p;
                    this.host.toast('Ditch: now click where it ends');
                    return this.render();
                }
                d.features.push({
                    type: 'ditch',
                    x1: this.pendingDitch.x,
                    z1: this.pendingDitch.z,
                    x2: p.x,
                    z2: p.z,
                    width: 1.8,
                    depth: 1.1
                });
                this.pendingDitch = null;
                this.sel = { kind: 'feature', index: d.features.length - 1 };
                break;
            case 'spawn':
                d.spawn = { x: p.x, z: p.z, yaw: yawFromView() };
                this.sel = { kind: 'spawn', index: 0 };
                break;
            case 'goal':
                d.goal = { minX: p.x - 2, maxX: p.x + 2, minZ: p.z - 2, maxZ: p.z + 2 };
                this.sel = { kind: 'goal', index: 0 };
                break;
            default: {
                const pool = PROP_POOLS[t] ?? [];
                const used = new Set(d.props.map((x) => x.name));
                const name = pool.find((n) => !used.has(n));
                if (!name) {
                    this.host.toast(`No more ${t}s (at most ${pool.length})`);
                    return;
                }
                d.props.push({ name, x: p.x, z: p.z, yaw: yawFromView() + Math.PI / 2 });
                this.sel = { kind: 'prop', index: d.props.length - 1 };
            }
        }
        this.changed();
    }

    private nearest(x: number, z: number): Sel {
        const d = this.d;
        let best: Sel = null;
        let bd = 1.5;
        const consider = (sel: Sel, px: number, pz: number, r = 0) => {
            const dist = Math.max(0, Math.hypot(px - x, pz - z) - r);
            if (dist < bd) {
                bd = dist;
                best = sel;
            }
        };
        d.pieces.forEach((p, i) =>
            consider(
                { kind: 'piece', index: i },
                p.x,
                p.z,
                p.shape.type === 'box' ? Math.min(p.shape.hx, p.shape.hz) : 0.3
            )
        );
        d.trees.forEach((t, i) => consider({ kind: 'tree', index: i }, t.x, t.z, 0.3));
        d.rocks.forEach((r, i) => consider({ kind: 'rock', index: i }, r.x, r.z, r.size));
        d.props.forEach((p, i) => consider({ kind: 'prop', index: i }, p.x, p.z, 0.3));
        d.features.forEach((f, i) => {
            if (f.type === 'mound') consider({ kind: 'feature', index: i }, f.x, f.z, 0.5);
            if (f.type === 'ditch') consider({ kind: 'feature', index: i }, (f.x1 + f.x2) / 2, (f.z1 + f.z2) / 2, 0.5);
        });
        consider({ kind: 'spawn', index: 0 }, d.spawn.x, d.spawn.z);
        if (d.goal)
            consider({ kind: 'goal', index: 0 }, (d.goal.minX + d.goal.maxX) / 2, (d.goal.minZ + d.goal.maxZ) / 2, 1);
        return best;
    }

    private key(e: KeyboardEvent): void {
        if (
            e.target instanceof HTMLInputElement ||
            e.target instanceof HTMLSelectElement ||
            e.target instanceof HTMLTextAreaElement
        )
            return;
        if (!this.sel) return;
        const step = e.shiftKey ? 1 : 0.25;
        let dx = 0;
        let dz = 0;
        let rot = 0;
        if (e.code === 'ArrowLeft') dx = -step;
        else if (e.code === 'ArrowRight') dx = step;
        else if (e.code === 'ArrowUp') dz = -step;
        else if (e.code === 'ArrowDown') dz = step;
        else if (e.code === 'KeyQ') rot = Math.PI / 12;
        else if (e.code === 'KeyE') rot = -Math.PI / 12;
        else if (e.code === 'Delete' || e.code === 'Backspace') {
            this.remove();
            e.preventDefault();
            return;
        } else return;
        e.preventDefault();
        this.nudge(dx, dz, rot);
    }

    private nudge(dx: number, dz: number, rot: number): void {
        const d = this.d;
        const s = this.sel;
        if (!s) return;
        const move = (o: { x: number; z: number }) => {
            o.x = round(o.x + dx);
            o.z = round(o.z + dz);
        };
        if (s.kind === 'piece') {
            const p = d.pieces[s.index];
            move(p);
            p.yaw = (p.yaw ?? 0) + rot;
        } else if (s.kind === 'tree') {
            move(d.trees[s.index]);
            d.trees[s.index].yaw += rot;
        } else if (s.kind === 'rock') {
            move(d.rocks[s.index]);
            d.rocks[s.index].yaw += rot;
        } else if (s.kind === 'prop') {
            const p = d.props[s.index];
            move(p);
            p.yaw = (p.yaw ?? 0) + rot;
        } else if (s.kind === 'spawn') {
            move(d.spawn);
            d.spawn.yaw += rot;
        } else if (s.kind === 'goal' && d.goal) {
            d.goal = { minX: d.goal.minX + dx, maxX: d.goal.maxX + dx, minZ: d.goal.minZ + dz, maxZ: d.goal.maxZ + dz };
        } else if (s.kind === 'feature') {
            const f = d.features[s.index];
            if (f.type === 'mound') move(f);
            else if (f.type === 'ditch') {
                f.x1 += dx;
                f.x2 += dx;
                f.z1 += dz;
                f.z2 += dz;
            }
        }
        this.changed();
    }

    private remove(): void {
        const d = this.d;
        const s = this.sel;
        if (!s) return;
        if (s.kind === 'piece') d.pieces.splice(s.index, 1);
        else if (s.kind === 'tree') d.trees.splice(s.index, 1);
        else if (s.kind === 'rock') d.rocks.splice(s.index, 1);
        else if (s.kind === 'prop') d.props.splice(s.index, 1);
        else if (s.kind === 'feature') d.features.splice(s.index, 1);
        else if (s.kind === 'goal') d.goal = undefined;
        else return; // the start cannot be deleted
        this.sel = null;
        this.changed();
    }

    private changed(): void {
        this.dirty = true;
        this.height = dataHeight(this.d);
        saveDraft(this.d);
        this.render();
    }

    // ------------------------------------------------------------------------------- outlines

    /** Draws every element as outlines (call each frame). */
    draw(): void {
        for (const arr of this.batches.values()) arr.length = 0;
        const d = this.d;
        const h = this.height;
        const isSel = (k: string, i: number) => this.sel?.kind === k && this.sel.index === i;
        d.pieces.forEach((p, i) => {
            const g = h(p.x, p.z);
            const s = p.shape;
            const [hx, hy, hz] =
                s.type === 'box'
                    ? [s.hx, s.hy, s.hz]
                    : s.type === 'cylinder'
                      ? s.axis === 'x'
                          ? [s.half, s.r, s.r]
                          : s.axis === 'z'
                            ? [s.r, s.r, s.half]
                            : [s.r, s.half, s.r]
                      : [s.rx, s.ry, s.rz];
            this.box(p.x, g + p.y, p.z, hx, hy, hz, p.yaw ?? 0, isSel('piece', i) ? COL.sel : COL.piece);
        });
        d.trees.forEach((t, i) => {
            const g = h(t.x, t.z);
            const c = isSel('tree', i) ? COL.sel : COL.tree;
            this.line(t.x, g, t.z, t.x, g + 3.5 * t.scale, t.z, c);
            this.circle(t.x, g + 2.2 * t.scale, t.z, 1.1 * t.scale, c);
        });
        d.rocks.forEach((r, i) =>
            this.circle(r.x, h(r.x, r.z) + 0.1, r.z, r.size * 1.2, isSel('rock', i) ? COL.sel : COL.piece)
        );
        d.props.forEach((p, i) => {
            const long = p.name.includes('plank')
                ? plankHalfOf(p.name).x
                : p.name.startsWith('beam')
                  ? BEAM_HALF.x
                  : p.name.includes('log')
                    ? 1
                    : 0.25;
            this.box(
                p.x,
                h(p.x, p.z) + 0.15,
                p.z,
                long,
                0.12,
                long > 0.3 ? 0.12 : 0.25,
                p.yaw ?? 0,
                isSel('prop', i) ? COL.sel : COL.prop
            );
        });
        d.features.forEach((f, i) => {
            const c = isSel('feature', i) ? COL.sel : COL.ditch;
            if (f.type === 'mound') this.circle(f.x, h(f.x, f.z) + 0.1, f.z, f.r, c);
            if (f.type === 'ditch') {
                const len = Math.hypot(f.x2 - f.x1, f.z2 - f.z1) || 1;
                const nx = (-(f.z2 - f.z1) / len) * (f.width / 2);
                const nz = ((f.x2 - f.x1) / len) * (f.width / 2);
                const y = this.d.ground.base + 0.05;
                this.line(f.x1 + nx, y, f.z1 + nz, f.x2 + nx, y, f.z2 + nz, c);
                this.line(f.x1 - nx, y, f.z1 - nz, f.x2 - nx, y, f.z2 - nz, c);
            }
        });
        const sp = d.spawn;
        const sg = h(sp.x, sp.z);
        const sc = isSel('spawn', 0) ? COL.sel : COL.spawn;
        this.circle(sp.x, sg + 0.05, sp.z, 0.4, sc);
        this.line(sp.x, sg + 0.05, sp.z, sp.x - Math.sin(sp.yaw) * 1.2, sg + 0.05, sp.z - Math.cos(sp.yaw) * 1.2, sc);
        this.line(sp.x, sg, sp.z, sp.x, sg + 1.4, sp.z, sc);
        if (d.goal) {
            const g = d.goal;
            const y = h((g.minX + g.maxX) / 2, (g.minZ + g.maxZ) / 2) + 0.08;
            const c = isSel('goal', 0) ? COL.sel : COL.goal;
            this.line(g.minX, y, g.minZ, g.maxX, y, g.minZ, c);
            this.line(g.maxX, y, g.minZ, g.maxX, y, g.maxZ, c);
            this.line(g.maxX, y, g.maxZ, g.minX, y, g.maxZ, c);
            this.line(g.minX, y, g.maxZ, g.minX, y, g.minZ, c);
        }
        if (this.pendingDitch)
            this.circle(
                this.pendingDitch.x,
                h(this.pendingDitch.x, this.pendingDitch.z) + 0.1,
                this.pendingDitch.z,
                0.3,
                COL.ditch
            );
        for (const [c, arr] of this.batches)
            if (arr.length >= 2) this.host.app.drawLines(arr, c, false, this.host.layer);
    }

    private line(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, c: Color): void {
        let arr = this.batches.get(c);
        if (!arr) {
            arr = [];
            this.batches.set(c, arr);
        }
        arr.push(new Vec3(x1, y1, z1), new Vec3(x2, y2, z2));
    }

    private circle(x: number, y: number, z: number, r: number, c: Color): void {
        const n = 20;
        for (let i = 0; i < n; i++) {
            const a0 = (i / n) * Math.PI * 2;
            const a1 = ((i + 1) / n) * Math.PI * 2;
            this.line(x + Math.cos(a0) * r, y, z + Math.sin(a0) * r, x + Math.cos(a1) * r, y, z + Math.sin(a1) * r, c);
        }
    }

    private box(x: number, y: number, z: number, hx: number, hy: number, hz: number, yaw: number, c: Color): void {
        const cs = Math.cos(yaw);
        const sn = Math.sin(yaw);
        const corner = (sx: number, sy: number, sz: number): [number, number, number] => {
            const lx = sx * hx;
            const lz = sz * hz;
            return [x + lx * cs + lz * sn, y + sy * hy, z - lx * sn + lz * cs];
        };
        const P = [
            corner(-1, -1, -1),
            corner(1, -1, -1),
            corner(1, -1, 1),
            corner(-1, -1, 1),
            corner(-1, 1, -1),
            corner(1, 1, -1),
            corner(1, 1, 1),
            corner(-1, 1, 1)
        ];
        const E = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
        for (let i = 0; i < E.length; i += 2) this.line(...P[E[i]], ...P[E[i + 1]], c);
    }

    // ------------------------------------------------------------------------------- panel

    private saveCamera(): void {
        try {
            const p = this.host.camera.getPosition();
            const f = this.host.camera.forward;
            sessionStorage.setItem(CAM_KEY, JSON.stringify({ p: [p.x, p.y, p.z], f: [f.x, f.y, f.z] }));
        } catch {
            // no session storage: the camera starts at the level's default
        }
    }

    /** The camera position saved before the last rebuild, if any. */
    savedCamera(): { pos: [number, number, number]; focus: [number, number, number] } | null {
        try {
            const raw = sessionStorage.getItem(CAM_KEY);
            if (!raw) return null;
            const o = JSON.parse(raw) as { p: number[]; f: number[] };
            return {
                pos: [o.p[0], o.p[1], o.p[2]],
                focus: [o.p[0] + o.f[0] * 8, o.p[1] + o.f[1] * 8, o.p[2] + o.f[2] * 8]
            };
        } catch {
            return null;
        }
    }

    private restoreCamera(): void {
        // (applied by the caller through savedCamera(); nothing to do here)
    }

    render(): void {
        const el = this.el;
        el.replaceChildren();
        const title = document.createElement('div');
        title.className = 'online-title';
        title.textContent = 'Level designer';
        el.append(title);
        const name = document.createElement('input');
        name.className = 'designer-name';
        name.value = this.d.name;
        name.addEventListener('change', () => {
            this.d.name = name.value.slice(0, 48) || 'My level';
            this.changed();
        });
        el.append(name);
        const tools = document.createElement('div');
        tools.className = 'designer-tools';
        for (const t of TOOLS) {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = t.label;
            b.className = t.id === this.tool ? 'on' : '';
            b.addEventListener('click', () => {
                this.tool = t.id;
                this.pendingDitch = null;
                this.render();
            });
            tools.append(b);
        }
        el.append(tools);
        const help = document.createElement('p');
        help.className = 'online-note';
        help.textContent =
            this.tool === 'select'
                ? 'Click a thing to select it. Arrows move (Shift: 1 m), Q / E turn, Delete removes. Drag to orbit, right-drag to pan, wheel to zoom.'
                : this.tool === 'ditch'
                  ? 'Click where the ditch starts, then where it ends.'
                  : 'Click the ground to place. Props face across your view.';
        el.append(help);
        this.properties(el);
        const row = document.createElement('div');
        row.className = 'designer-actions';
        const action = (label: string, fn: () => void, cls = '') => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = label;
            if (cls) b.className = cls;
            b.addEventListener('click', fn);
            row.append(b);
        };
        action(
            this.dirty ? 'Build (apply changes)' : 'Build',
            () => {
                this.saveCamera();
                this.host.rebuild(this.d);
            },
            this.dirty ? 'online-primary' : ''
        );
        action('Play', () => this.host.play(this.d));
        action('Copy JSON', () => this.exportJson());
        action('Import', () => this.importJson());
        action('New', () => {
            if (!confirm('Start a new level? The current draft is replaced.')) return;
            this.d = starterLevel();
            this.sel = null;
            this.changed();
        });
        action('Exit', () => this.host.exit());
        el.append(row);
        const counts = document.createElement('p');
        counts.className = 'online-note';
        counts.textContent = `${this.d.pieces.length} pieces · ${this.d.trees.length} trees · ${this.d.rocks.length} rocks · ${this.d.props.length} props · ${this.d.features.length} ground features${this.dirty ? ' · not built yet' : ''}`;
        el.append(counts);
    }

    private properties(el: HTMLElement): void {
        const s = this.sel;
        if (!s) return;
        const d = this.d;
        const box = document.createElement('div');
        box.className = 'designer-props';
        const field = (label: string, value: number, set: (v: number) => void, step = 0.05) => {
            const l = document.createElement('label');
            l.textContent = label;
            const i = document.createElement('input');
            i.type = 'number';
            i.step = String(step);
            i.value = String(Math.round(value * 1000) / 1000);
            i.addEventListener('change', () => {
                const v = Number(i.value);
                if (Number.isFinite(v)) {
                    set(v);
                    this.changed();
                }
            });
            l.append(i);
            box.append(l);
        };
        const head = document.createElement('div');
        head.className = 'designer-sel';
        box.append(head);
        if (s.kind === 'piece') {
            const p = d.pieces[s.index];
            head.textContent = `Piece ${s.index + 1}`;
            field('x', p.x, (v) => (p.x = v));
            field('z', p.z, (v) => (p.z = v));
            field('height above ground', p.y, (v) => (p.y = v));
            if (p.shape.type === 'box') {
                const sh = p.shape;
                field('half width (x)', sh.hx, (v) => (sh.hx = Math.max(0.025, v)));
                field('half height', sh.hy, (v) => (sh.hy = Math.max(0.025, v)));
                field('half depth (z)', sh.hz, (v) => (sh.hz = Math.max(0.025, v)));
            }
            field('turn (deg)', ((p.yaw ?? 0) * 180) / Math.PI, (v) => (p.yaw = (v * Math.PI) / 180), 5);
            field('tilt (deg)', ((p.pitch ?? 0) * 180) / Math.PI, (v) => (p.pitch = (v * Math.PI) / 180), 5);
            const l = document.createElement('label');
            l.textContent = 'material';
            const sel = document.createElement('select');
            for (const m of Object.keys(MATERIAL_NAMES)) {
                const o = document.createElement('option');
                o.value = m;
                o.textContent = m;
                sel.append(o);
            }
            sel.value = p.material;
            sel.addEventListener('change', () => {
                p.material = sel.value as MaterialName;
                this.changed();
            });
            l.append(sel);
            box.append(l);
        } else if (s.kind === 'tree') {
            const t = d.trees[s.index];
            head.textContent = `${t.kind === 'oak' ? 'Oak' : 'Pine'} ${s.index + 1}`;
            field('x', t.x, (v) => (t.x = v));
            field('z', t.z, (v) => (t.z = v));
            field('size', t.scale, (v) => (t.scale = Math.max(0.4, Math.min(2.5, v))));
        } else if (s.kind === 'rock') {
            const r = d.rocks[s.index];
            head.textContent = `Rock ${s.index + 1}`;
            field('x', r.x, (v) => (r.x = v));
            field('z', r.z, (v) => (r.z = v));
            field('size', r.size, (v) => (r.size = Math.max(0.15, Math.min(3, v))));
        } else if (s.kind === 'prop') {
            const p = d.props[s.index];
            head.textContent = `Prop: ${p.name}`;
            field('x', p.x, (v) => (p.x = v));
            field('z', p.z, (v) => (p.z = v));
            field('turn (deg)', ((p.yaw ?? 0) * 180) / Math.PI, (v) => (p.yaw = (v * Math.PI) / 180), 15);
        } else if (s.kind === 'feature') {
            const f = d.features[s.index] as GroundFeature;
            if (f.type === 'mound') {
                head.textContent = 'Hill';
                field('x', f.x, (v) => (f.x = v));
                field('z', f.z, (v) => (f.z = v));
                field('radius', f.r, (v) => (f.r = Math.max(0.5, v)));
                field('height (negative: a hollow)', f.h, (v) => (f.h = v));
            } else if (f.type === 'ditch') {
                head.textContent = 'Ditch';
                field('width', f.width, (v) => (f.width = Math.max(0.3, v)));
                field('depth', f.depth, (v) => (f.depth = Math.max(0.1, v)));
            }
        } else if (s.kind === 'spawn') {
            head.textContent = 'Start';
            field('x', d.spawn.x, (v) => (d.spawn.x = v));
            field('z', d.spawn.z, (v) => (d.spawn.z = v));
            field('facing (deg)', (d.spawn.yaw * 180) / Math.PI, (v) => (d.spawn.yaw = (v * Math.PI) / 180), 15);
        } else if (s.kind === 'goal' && d.goal) {
            head.textContent = 'Goal (bucket rests here)';
            const g = d.goal;
            field('size', g.maxX - g.minX, (v) => {
                const cx = (g.minX + g.maxX) / 2;
                const cz = (g.minZ + g.maxZ) / 2;
                const h = Math.max(0.5, v) / 2;
                d.goal = { minX: cx - h, maxX: cx + h, minZ: cz - h, maxZ: cz + h };
            });
        }
        el.append(box);
    }

    private exportJson(): void {
        const text = JSON.stringify(this.d, null, 1);
        const done = () => this.host.toast('Level JSON copied: paste it to Claude to add it to the game');
        navigator.clipboard?.writeText(text).then(done, () => this.showText(text));
        if (!navigator.clipboard) this.showText(text);
    }

    private showText(text: string): void {
        const ta = document.createElement('textarea');
        ta.className = 'designer-json';
        ta.value = text;
        ta.readOnly = true;
        this.el.append(ta);
        ta.select();
        this.host.toast('Copy the JSON from the box');
    }

    private importJson(): void {
        const ta = document.createElement('textarea');
        ta.className = 'designer-json';
        ta.placeholder = 'Paste level JSON here, then press Load';
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = 'Load';
        b.addEventListener('click', () => {
            try {
                this.d = parseLevelData(JSON.parse(ta.value));
                this.d.id = 'custom';
                this.sel = null;
                this.changed();
                this.host.toast('Level loaded: press Build');
            } catch (err) {
                this.host.toast(`Not a level: ${err instanceof Error ? err.message : 'invalid JSON'}`);
            }
        });
        this.el.append(ta, b);
    }
}

function round(v: number): number {
    return Math.round(v * 20) / 20;
}
