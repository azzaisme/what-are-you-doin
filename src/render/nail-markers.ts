/**
 * Nail heads and the hammer's preview (Epic 5, #48). A nail is a data connection, not a body; it
 * is drawn as one dark cell of the base lattice where its head is (a grid-aware thickened proxy,
 * design doc §5.1 rule 5), following the piece it is driven into. The preview marker is UI (an
 * approved exception): the outline of the cell where the next nail would go, green if it would
 * hold, red if not.
 */

import { Color, Entity, StandardMaterial } from 'playcanvas';
import type { AppBase, Layer } from 'playcanvas';

import type { NailMark } from '../sim/joints/wire.ts';
import type { SnapshotRing } from '../sim/snapshots.ts';
import { ANIM_MAX } from '../sim/snapshots.ts';
import { pose, quatRotate, vec3 } from '../voxels/math.ts';

const _pose = pose();
const _anim = new Float64Array(ANIM_MAX);
const _v = vec3();

function iron(): StandardMaterial {
    const m = new StandardMaterial();
    m.diffuse = new Color(0.16, 0.16, 0.18);
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
    private readonly overlay: Layer;
    private readonly app: AppBase;
    private readonly iron = iron();
    /** Nail heads placed by the last update. */
    drawn = 0;

    /** `layer` draws the nail heads, `overlay` (an immediate layer) the preview outline. */
    constructor(app: AppBase, layer: Layer, overlay: Layer) {
        this.app = app;
        this.layer = layer;
        this.overlay = overlay;
        app.root.addChild(this.root);
    }

    private cube(m: StandardMaterial): Entity {
        const e = new Entity('nail');
        e.addComponent('render', { type: 'box', material: m, layers: [this.layer.id], castShadows: false });
        this.root.addChild(e);
        return e;
    }

    /**
     * Places the nail heads on their pieces at this render time, and the preview (null: none).
     * `cell` is the base lattice's cell size (m).
     */
    update(
        marks: readonly NailMark[],
        ring: SnapshotRing,
        time: number,
        cell: number,
        preview: { x: number; y: number; z: number; ok: boolean } | null
    ): void {
        const snap = (v: number) => (Math.floor(v / cell) + 0.5) * cell;
        let n = 0;
        for (const m of marks) {
            if (!ring.sample(m.a, time, _pose, _anim)) continue;
            quatRotate(_pose.q, m.x, m.y, m.z, _v);
            let e = this.heads[n];
            if (!e) this.heads.push((e = this.cube(this.iron)));
            e.enabled = true;
            // a hair larger than a cell, so it shows over the piece's own cell there
            e.setLocalScale(cell * 1.04, cell * 1.04, cell * 1.04);
            e.setPosition(snap(_pose.p.x + _v.x), snap(_pose.p.y + _v.y), snap(_pose.p.z + _v.z));
            n++;
        }
        for (let i = n; i < this.heads.length; i++) this.heads[i].enabled = false;
        this.drawn = n;
        if (preview) {
            const h = cell * 0.56;
            const x = snap(preview.x);
            const y = snap(preview.y);
            const z = snap(preview.z);
            EDGES.forEach((c, i) => {
                _lines[i * 3] = c & 1 ? x + h : x - h;
                _lines[i * 3 + 1] = c & 2 ? y + h : y - h;
                _lines[i * 3 + 2] = c & 4 ? z + h : z - h;
            });
            this.app.drawLineArrays(_lines, preview.ok ? OK : BAD, false, this.overlay);
        }
    }
}
