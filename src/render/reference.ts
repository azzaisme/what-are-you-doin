/**
 * Debug-only conventional reference mode (design doc §7.2 step 2, §7.3): draws the continuous
 * source volumes of every dynamic object as ordinary smooth rotating primitives at the continuous
 * render-time pose, for side-by-side comparison with the voxel reconstruction. Never used in final
 * presentation. Also draws source bounds (oriented boxes) as debug lines.
 */

import { Color, Entity, Quat, StandardMaterial, Vec3   } from 'playcanvas';
import type { AppBase, Layer } from 'playcanvas';

import type { LabSim } from '../sim/lab-sim.ts';
import { ANIM_MAX } from '../sim/snapshots.ts';
import { pose, quatRotate  } from '../voxels/math.ts';
import type { Pose } from '../voxels/math.ts';

interface RefPart {
    holder: Entity;
}

interface RefObject {
    slot: number;
    root: Pose;
    anim: Float64Array;
    poses: Pose[];
    parts: RefPart[];
    evaluate: (root: Pose, anim: ArrayLike<number>, out: Pose[]) => void;
    bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }[];
}

export class ReferenceRenderer {
    private readonly objects: RefObject[] = [];
    private readonly root = new Entity('ReferenceMode');
    private readonly sim: LabSim;
    private readonly app: AppBase;
    private readonly immediate: Layer;
    private _enabled = false;
    showBounds = false;

    constructor(app: AppBase, sim: LabSim, layer: Layer, immediate: Layer) {
        this.app = app;
        this.sim = sim;
        this.immediate = immediate;
        app.root.addChild(this.root);
        this.root.enabled = false;
        const mats = new Map<number, StandardMaterial>();
        const material = (rgb: number) => {
            let m = mats.get(rgb);
            if (!m) {
                m = new StandardMaterial();
                m.diffuse = new Color(((rgb >> 16) & 255) / 255, ((rgb >> 8) & 255) / 255, (rgb & 255) / 255);
                m.gloss = 0.4;
                m.useMetalness = true;
                m.metalness = 0;
                m.update();
                mats.set(rgb, m);
            }
            return m;
        };
        for (const e of sim.entities) {
            if (e.asset.parts.length === 0) continue;
            const parts: RefPart[] = [];
            for (const p of e.asset.parts) {
                const holder = new Entity(`ref-${e.name}-${p.name}`);
                const child = new Entity('shape');
                const s = p.volume.shape;
                const b = p.volume.bounds;
                let type: 'box' | 'sphere' | 'cylinder' | 'cone' = 'box';
                if (s.type === 'box') {
                    child.setLocalScale(s.hx * 2, s.hy * 2, s.hz * 2);
                } else if (s.type === 'ellipsoid') {
                    type = 'sphere';
                    child.setLocalScale(s.rx * 2, s.ry * 2, s.rz * 2);
                } else if (s.type === 'cylinder') {
                    type = 'cylinder';
                    child.setLocalScale(s.radius * 2, s.halfLength * 2, s.radius * 2);
                    if (s.axis === 'x') child.setLocalEulerAngles(0, 0, 90);
                    if (s.axis === 'z') child.setLocalEulerAngles(90, 0, 0);
                } else if (s.type === 'cone') {
                    type = 'cone';
                    child.setLocalScale(s.radius * 2, s.height, s.radius * 2);
                    child.setLocalPosition(0, s.height / 2, 0);
                } else {
                    child.setLocalScale(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ);
                    child.setLocalPosition((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2);
                }
                child.addComponent('render', { type, material: material(p.refColor), layers: [layer.id], castShadows: true, receiveShadows: true });
                holder.addChild(child);
                this.root.addChild(holder);
                parts.push({ holder });
            }
            this.objects.push({
                slot: e.slot,
                root: pose(),
                anim: new Float64Array(ANIM_MAX),
                poses: e.asset.parts.map(() => pose()),
                parts,
                evaluate: e.asset.evaluate.bind(e.asset),
                bounds: e.asset.parts.map((p) => p.volume.bounds)
            });
        }
    }

    get enabled(): boolean {
        return this._enabled;
    }

    set enabled(v: boolean) {
        this._enabled = v;
        this.root.enabled = v;
    }

    /** Called every render frame with the continuous render time. */
    update(renderTime: number): void {
        if (!this._enabled && !this.showBounds) return;
        for (const o of this.objects) {
            const visible = this.sim.ring.sample(o.slot, renderTime, o.root, o.anim);
            if (visible) o.evaluate(o.root, o.anim, o.poses);
            for (let i = 0; i < o.parts.length; i++) {
                const h = o.parts[i].holder;
                h.enabled = visible && this._enabled;
                if (!visible) continue;
                const p = o.poses[i];
                if (this._enabled) {
                    _v.set(p.p.x, p.p.y, p.p.z);
                    _q.set(p.q.x, p.q.y, p.q.z, p.q.w);
                    h.setPosition(_v);
                    h.setRotation(_q);
                }
                if (this.showBounds) this.drawBounds(p, o.bounds[i]);
            }
        }
    }

    private drawBounds(p: Pose, b: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }): void {
        const xs = [b.minX, b.maxX];
        const ys = [b.minY, b.maxY];
        const zs = [b.minZ, b.maxZ];
        let n = 0;
        for (let ix = 0; ix < 2; ix++)
            for (let iy = 0; iy < 2; iy++)
                for (let iz = 0; iz < 2; iz++) {
                    quatRotate(p.q, xs[ix], ys[iy], zs[iz], _w);
                    _corners[n++].set(p.p.x + _w.x, p.p.y + _w.y, p.p.z + _w.z);
                }
        let k = 0;
        for (const [a, c] of EDGES) {
            _lines[k++].copy(_corners[a]);
            _lines[k++].copy(_corners[c]);
        }
        this.app.drawLines(_lines, BOUNDS_COLOR, false, this.immediate);
    }
}

// corner index = ix * 4 + iy * 2 + iz
const EDGES: [number, number][] = [
    [0, 1],
    [2, 3],
    [4, 5],
    [6, 7],
    [0, 2],
    [1, 3],
    [4, 6],
    [5, 7],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7]
];
const _corners = Array.from({ length: 8 }, () => new Vec3());
const _lines = Array.from({ length: 24 }, () => new Vec3());
const _v = new Vec3();
const _q = new Quat();
const _w = { x: 0, y: 0, z: 0 };
const BOUNDS_COLOR = new Color(0.2, 1, 0.9);
