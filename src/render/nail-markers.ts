/**
 * Nail heads and the hammer's preview (Epic 5, #48). A nail is a data connection, not a body; it
 * is drawn as one dark cell of the base lattice where its head is (a grid-aware thickened proxy,
 * design doc §5.1 rule 5), following the piece it is driven into. The preview marker is UI (an
 * approved exception): the outline of the cell where the next nail would go, green if it would
 * hold, red if not, drawn into the layer of that player's own view only (split screen).
 */

import { Color, Entity, StandardMaterial } from 'playcanvas';
import type { AppBase, Layer } from 'playcanvas';

import { sfx } from '../audio/sfx.ts';
import type { NailMark } from '../sim/joints/wire.ts';
import type { SnapshotRing } from '../sim/snapshots.ts';
import { ANIM_MAX } from '../sim/snapshots.ts';
import { pose, quatRotate, vec3 } from '../voxels/math.ts';

const _pose = pose();
const _anim = new Float64Array(ANIM_MAX);
const _v = vec3();

function metal(r: number, g: number, b: number, glow = 0): StandardMaterial {
    const m = new StandardMaterial();
    m.diffuse = new Color(r, g, b);
    if (glow) {
        m.emissive = new Color(r, g, b);
        m.emissiveIntensity = glow;
    }
    m.useMetalness = true;
    m.metalness = 0.6;
    m.gloss = 0.5;
    m.update();
    return m;
}

const OK = new Color(0.35, 1, 0.45);
const BAD = new Color(1, 0.35, 0.3);
/** The 12 edges of a unit cube, as corner index pairs (corner bits: x 1, y 2, z 4). */
const EDGES = [0, 1, 2, 3, 4, 5, 6, 7, 0, 2, 1, 3, 4, 6, 5, 7, 0, 4, 1, 5, 2, 6, 3, 7];
const _lines: number[] = new Array<number>(EDGES.length * 3).fill(0);

export class NailMarkers {
    private readonly root = new Entity('NailMarkers');
    private readonly heads: Entity[] = [];
    private readonly layer: Layer;
    private readonly views: readonly Layer[];
    private readonly app: AppBase;
    /** Nail heads by strain: calm iron, creaking (amber), groaning (red): a warning in colour too. */
    private readonly heads3 = [metal(0.16, 0.16, 0.18), metal(0.95, 0.6, 0.1, 0.5), metal(0.95, 0.15, 0.1, 0.9)];
    /** Nail heads placed by the last update. */
    drawn = 0;
    /** Tests: false hides the hammer outlines (to tell their pixels from the rest of the frame). */
    showOutlines = true;
    /** Per local view, the player slots whose hammer outline the last update drew into it. */
    outlineSlots: number[][] = [];

    /** `layer` draws the nail heads, `views` (one immediate layer per local view) the outlines. */
    constructor(app: AppBase, layer: Layer, views: readonly Layer[]) {
        this.app = app;
        this.layer = layer;
        this.views = views;
        app.root.addChild(this.root);
    }

    /** Each connection's strain and where it is, last frame (sounds: creak on rising strain, snap when it goes). */
    private readonly heard = new Map<string, { level: number; x: number; y: number; z: number; next: number }>();

    /**
     * Joint sounds from what every device sees (the host's graph, or what it sent a guest): a creak
     * as a connection's strain rises and every 1.5 s while it stays strained (louder and lower when
     * groaning), a snap where a strained connection disappears (it broke). Epic 8's sfx plays them.
     */
    private sound(marks: readonly NailMark[], ring: SnapshotRing, time: number): void {
        const now = new Map<string, { level: number; x: number; y: number; z: number }>();
        for (const m of marks) {
            // one connection: its piece pair and the site of its nails (anchor sites are 0.5 m apart)
            const key = `${m.a}:${m.b}:${Math.round(m.x / 0.8)}:${Math.round(m.y / 0.8)}:${Math.round(m.z / 0.8)}`;
            const was = now.get(key);
            if (was && was.level >= m.strain) continue;
            if (!ring.sample(m.a, time, _pose, _anim)) continue;
            quatRotate(_pose.q, m.x, m.y, m.z, _v);
            now.set(key, { level: m.strain, x: _pose.p.x + _v.x, y: _pose.p.y + _v.y, z: _pose.p.z + _v.z });
        }
        for (const [key, c] of now) {
            const before = this.heard.get(key);
            const strain = c.level >= 2 ? 0.9 : 0.5;
            if (c.level >= 1 && (!before || c.level > before.level || time >= before.next)) {
                sfx.creak(c, strain);
                this.heard.set(key, { ...c, next: time + 1.5 });
            } else this.heard.set(key, { ...c, next: before?.next ?? 0 });
        }
        for (const [key, c] of this.heard) {
            if (now.has(key)) continue;
            if (c.level >= 1) sfx.snap(c);
            this.heard.delete(key);
        }
    }

    private cube(m: StandardMaterial): Entity {
        const e = new Entity('nail');
        e.addComponent('render', { type: 'box', material: m, layers: [this.layer.id], castShadows: false });
        this.root.addChild(e);
        return e;
    }

    /**
     * Places the nail heads on their pieces at this render time, and each local player's preview
     * in that player's view (`view`: 0 the main camera, 1 player 2's). `cell` is the base
     * lattice's cell size (m).
     */
    update(
        marks: readonly NailMark[],
        ring: SnapshotRing,
        time: number,
        cell: number,
        previews: readonly { x: number; y: number; z: number; ok: boolean; slot: number; view: number }[]
    ): void {
        const snap = (v: number) => (Math.floor(v / cell) + 0.5) * cell;
        let n = 0;
        for (const m of marks) {
            if (!ring.sample(m.a, time, _pose, _anim)) continue;
            quatRotate(_pose.q, m.x, m.y, m.z, _v);
            let e = this.heads[n];
            if (!e) this.heads.push((e = this.cube(this.heads3[0])));
            const mat = this.heads3[Math.max(0, Math.min(2, m.strain))];
            if (e.render!.material !== mat) e.render!.material = mat;
            e.enabled = true;
            // a hair larger than a cell, so it shows over the piece's own cell there
            e.setLocalScale(cell * 1.04, cell * 1.04, cell * 1.04);
            e.setPosition(snap(_pose.p.x + _v.x), snap(_pose.p.y + _v.y), snap(_pose.p.z + _v.z));
            n++;
        }
        for (let i = n; i < this.heads.length; i++) this.heads[i].enabled = false;
        this.drawn = n;
        this.sound(marks, ring, time);
        this.outlineSlots = this.views.map((_, v) => previews.filter((p) => p.view === v).map((p) => p.slot));
        for (const preview of previews) {
            const view = this.views[preview.view];
            if (!view || !this.showOutlines) continue;
            const h = cell * 0.56;
            const x = snap(preview.x);
            const y = snap(preview.y);
            const z = snap(preview.z);
            EDGES.forEach((c, i) => {
                _lines[i * 3] = c & 1 ? x + h : x - h;
                _lines[i * 3 + 1] = c & 2 ? y + h : y - h;
                _lines[i * 3 + 2] = c & 4 ? z + h : z - h;
            });
            this.app.drawLineArrays(_lines, preview.ok ? OK : BAD, false, view);
        }
    }
}
