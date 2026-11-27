/**
 * "Voxels: Off": draws the world and every object as plain smooth meshes (src/smooth), with the
 * voxel materials (same lighting, colours from the same material fields).
 *
 * - Static units (ground chunks, scenery) are uploaded once. Stand trees and stumps are units of
 *   their own, shown by each tree's state, read from the same marker channels the voxel lane reads
 *   (standing; stump; neither while it leans, when the marker object draws the tree).
 * - Objects: one entity per part, posed every frame from the snapshot ring at the render time (no
 *   voxel clock), with the asset's own hidden parts. In first person your beaver gives way to your
 *   limbs, as in the voxel lanes.
 * - Particles (leaves, dust, chips, needles, sawdust, splashes) stay: one cube a particle, the base
 *   cell's size, in one mesh rebuilt each frame. Some are gameplay tells (a tree about to fall).
 */

import { BoundingBox, Entity, Mesh, MeshInstance, PRIMITIVE_TRIANGLES, Quat, Vec3 } from 'playcanvas';
import type { AppBase, Layer, StandardMaterial } from 'playcanvas';

import { TREE_STATE, TREE_SWAY } from '../assets/forestry.ts';
import type { LabSim } from '../sim/lab-sim.ts';
import { ANIM_MAX } from '../sim/snapshots.ts';
import type { SmoothBuild } from '../smooth/smooth-service.ts';
import { GRID_SIZE } from '../voxels/grid.ts';
import { pose } from '../voxels/math.ts';
import type { Pose } from '../voxels/math.ts';
import {
    MATERIALS,
    SURFACE_CLASS_COUNT,
    VALUE_COUNT,
    VALUE_RGB,
    VALUE_SURFACE,
    voxelMaterial
} from '../voxels/palette.ts';
import type { ClassMesh } from '../workers/protocol.ts';

interface PartEntity {
    entity: Entity;
}

interface SmoothObject {
    id: number;
    slot: number;
    root: Pose;
    anim: Float64Array;
    poses: Pose[];
    parts: PartEntity[];
    evaluate: (root: Pose, anim: ArrayLike<number>, out: Pose[]) => void;
    hidden?: (anim: ArrayLike<number>, part: number) => boolean;
    /** The part meshed full and scaled to its level (VoxelAsset.partFill), with its full level. */
    fill?: { part: number; floor: number; full: number; level: (anim: ArrayLike<number>) => number };
}

export class SmoothRenderer {
    readonly root = new Entity('SmoothMeshes');
    private readonly app: AppBase;
    private readonly layer: Layer;
    private readonly materials: StandardMaterial[];
    private readonly sim: LabSim;
    private readonly objects: SmoothObject[] = [];
    private readonly stand = new Map<number, { tree?: Entity; stump?: Entity; marker: number }>();
    private readonly particleMeshes: Mesh[] = [];
    private readonly particleInstances: MeshInstance[] = [];
    loaded = false;
    /** Uploaded static meshes and triangles (stats). */
    staticMeshes = 0;
    staticTriangles = 0;
    lastParticles = 0;
    /** Last frame's particles by material name (tests: a falling tree's needles still show). */
    readonly particleMaterials = new Map<string, number>();
    private readonly names = new Map<number, string>();

    constructor(app: AppBase, layer: Layer, materials: StandardMaterial[], sim: LabSim) {
        this.app = app;
        this.layer = layer;
        this.materials = materials;
        this.sim = sim;
        this.root.enabled = false;
        app.root.addChild(this.root);
    }

    private mesh(c: ClassMesh, dynamic = false): Mesh {
        const m = new Mesh(this.app.graphicsDevice);
        m.clear(dynamic, dynamic);
        m.setPositions(c.positions, 3, c.vertexCount);
        m.setNormals(c.normals, 3, c.vertexCount);
        m.setColors32(c.colors, c.vertexCount);
        m.setIndices(c.indices, c.indexCount);
        m.update(PRIMITIVE_TRIANGLES, true);
        return m;
    }

    private renderEntity(name: string, classes: ClassMesh[], meshes?: (Mesh | null)[]): Entity {
        const e = new Entity(name);
        const instances: MeshInstance[] = [];
        classes.forEach((c, cls) => {
            if (c.indexCount === 0) return;
            const mesh = meshes?.[cls] ?? this.mesh(c);
            instances.push(new MeshInstance(mesh, this.materials[cls]));
        });
        e.addComponent('render', {
            meshInstances: instances,
            layers: [this.layer.id],
            castShadows: true,
            receiveShadows: true
        });
        return e;
    }

    /** Uploads a smooth build (once). */
    load(build: SmoothBuild): void {
        for (const u of build.units) {
            const e = this.renderEntity(`smooth-${u.name}`, u.classes);
            this.root.addChild(e);
            this.staticMeshes += u.classes.filter((c) => c.indexCount > 0).length;
            this.staticTriangles += u.classes.reduce((n, c) => n + c.indexCount / 3, 0);
            const m = /^(stand|stump)-(\d+)$/.exec(u.name);
            if (m) {
                const n = Number(m[2]);
                const s = this.stand.get(n) ?? { marker: -1 };
                if (m[1] === 'stand') s.tree = e;
                else s.stump = e;
                this.stand.set(n, s);
            }
        }
        // stand trees read their marker's channels; stumps start hidden
        const markers = this.sim.entities.filter((x) => /^tree-\d+$/.test(x.name));
        for (const [n, s] of this.stand) {
            s.marker = markers.find((x) => x.name === `tree-${n}`)?.slot ?? -1;
            if (s.stump) s.stump.enabled = false;
        }
        // part meshes: one GPU mesh per distinct part and class, shared by every object using it
        const shared = build.partMeshes.map((classes) => classes.map((c) => (c.indexCount > 0 ? this.mesh(c) : null)));
        for (const e of this.sim.entities) {
            const map = build.entityParts[e.id];
            if (!map) continue;
            this.names.set(e.id, e.name);
            const o: SmoothObject = {
                id: e.id,
                slot: e.slot,
                root: pose(),
                anim: new Float64Array(ANIM_MAX),
                poses: e.asset.parts.map(() => pose()),
                parts: [],
                evaluate: e.asset.evaluate.bind(e.asset),
                hidden: e.asset.partHidden?.bind(e.asset)
            };
            const f = e.asset.partFill;
            if (f) o.fill = { part: f.part, floor: f.floor, full: f.level(f.full), level: f.level.bind(f) };
            map.forEach((mi, i) => {
                const ent = this.renderEntity(
                    `smooth-${e.name}-${e.asset.parts[i].name}`,
                    build.partMeshes[mi],
                    shared[mi]
                );
                ent.enabled = false;
                this.root.addChild(ent);
                o.parts.push({ entity: ent });
            });
            this.objects.push(o);
        }
        this.loaded = true;
    }

    setEnabled(v: boolean): void {
        this.root.enabled = v;
    }

    get enabled(): boolean {
        return this.root.enabled;
    }

    /**
     * Poses every object for the render time. `firstPersonSlot`: your beaver (hidden; your limbs,
     * `fpBodyId`, are drawn at its pose instead), or -1.
     */
    update(renderTime: number, firstPersonSlot: number, fpBodyId: number): void {
        if (!this.root.enabled || !this.loaded) return;
        const ring = this.sim.ring;
        for (const o of this.objects) {
            let visible: boolean;
            if (o.id === fpBodyId) {
                visible = firstPersonSlot >= 0 && ring.sample(firstPersonSlot, renderTime, o.root, o.anim);
            } else {
                visible = o.slot !== firstPersonSlot && ring.sample(o.slot, renderTime, o.root, o.anim);
            }
            if (visible) o.evaluate(o.root, o.anim, o.poses);
            for (let i = 0; i < o.parts.length; i++) {
                const e = o.parts[i].entity;
                const show = visible && !(o.hidden?.(o.anim, i) ?? false);
                e.enabled = show;
                if (!show) continue;
                const p = o.poses[i];
                _v.set(p.p.x, p.p.y, p.p.z);
                _q.set(p.q.x, p.q.y, p.q.z, p.q.w);
                if (o.fill?.part === i) {
                    // meshed full: scaled in the part's own up axis about its floor, to its level now
                    const f = o.fill;
                    const k = Math.max(0, Math.min(1, (f.level(o.anim) - f.floor) / (f.full - f.floor)));
                    _q.transformVector(_up.set(0, f.floor * (1 - k), 0), _up);
                    _v.add(_up);
                    e.setLocalScale(1, Math.max(k, 1e-4), 1);
                }
                e.setPosition(_v);
                e.setRotation(_q);
            }
        }
        // stand trees by state (a marker with no snapshot yet keeps the tree standing)
        for (const s of this.stand.values()) {
            if (s.marker < 0) continue;
            if (!ring.sample(s.marker, renderTime, _root, _anim)) continue;
            const stump = _anim[TREE_STATE] > 0.5;
            const lean = !stump && _anim[TREE_SWAY] > 0.001;
            if (s.tree) s.tree.enabled = !stump && !lean;
            if (s.stump) s.stump.enabled = stump;
        }
    }

    /** Particles as cubes: x, y, z (m) and a voxel value each; each fills the cell it lies in. */
    updateParticles(buffer: Float32Array, count: number): void {
        if (!this.root.enabled) return;
        const g = GRID_SIZE;
        // per surface class
        const per: number[][] = Array.from({ length: SURFACE_CLASS_COUNT }, () => []);
        for (let n = 0; n < count; n++) {
            const v = buffer[n * 4 + 3] & 0xffff;
            if (!(v > 0 && v < VALUE_COUNT)) continue;
            per[VALUE_SURFACE[v]].push(n);
        }
        this.lastParticles = count;
        this.particleMaterials.clear();
        for (let n = 0; n < count; n++) {
            const name = MATERIALS[voxelMaterial(buffer[n * 4 + 3] & 0xffff)]?.name ?? '?';
            this.particleMaterials.set(name, (this.particleMaterials.get(name) ?? 0) + 1);
        }
        if (this.particleInstances.length === 0) {
            for (let c = 0; c < SURFACE_CLASS_COUNT; c++) {
                const m = new Mesh(this.app.graphicsDevice);
                // the full vertex format (position, normal, colour) before any instance exists: the
                // shader variant is chosen from it (as in VoxelRenderer)
                m.clear(true, true, 24, 36);
                m.setPositions(new Float32Array(9), 3, 3);
                m.setNormals(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), 3, 3);
                m.setColors32(new Uint8Array(12), 3);
                m.setIndices(new Uint32Array([0, 1, 2]), 3);
                m.update(PRIMITIVE_TRIANGLES, false);
                this.particleMeshes.push(m);
                const mi = new MeshInstance(m, this.materials[c]);
                mi.visible = false;
                this.particleInstances.push(mi);
            }
            const e = new Entity('smooth-particles');
            e.addComponent('render', {
                meshInstances: this.particleInstances,
                layers: [this.layer.id],
                castShadows: false
            });
            this.root.addChild(e);
        }
        for (let c = 0; c < SURFACE_CLASS_COUNT; c++) {
            const list = per[c];
            const mi = this.particleInstances[c];
            if (list.length === 0) {
                mi.visible = false;
                continue;
            }
            const nv = list.length * 24;
            const pos = new Float32Array(nv * 3);
            const nor = new Float32Array(nv * 3);
            const col = new Uint8Array(nv * 4);
            const idx = new Uint32Array(list.length * 36);
            let minX = Infinity;
            let minY = Infinity;
            let minZ = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;
            let maxZ = -Infinity;
            list.forEach((n, q) => {
                const x0 = Math.floor(buffer[n * 4] / g) * g;
                const y0 = Math.floor(buffer[n * 4 + 1] / g) * g;
                const z0 = Math.floor(buffer[n * 4 + 2] / g) * g;
                const rgb = VALUE_RGB[buffer[n * 4 + 3] & 0xffff];
                minX = Math.min(minX, x0);
                minY = Math.min(minY, y0);
                minZ = Math.min(minZ, z0);
                maxX = Math.max(maxX, x0 + g);
                maxY = Math.max(maxY, y0 + g);
                maxZ = Math.max(maxZ, z0 + g);
                for (let f = 0; f < 6; f++) {
                    const b = q * 24 + f * 4;
                    for (let k = 0; k < 4; k++) {
                        const c3 = CUBE_FACES[f][k];
                        pos[(b + k) * 3] = x0 + c3[0] * g;
                        pos[(b + k) * 3 + 1] = y0 + c3[1] * g;
                        pos[(b + k) * 3 + 2] = z0 + c3[2] * g;
                        nor[(b + k) * 3] = FACE_NORMALS[f][0];
                        nor[(b + k) * 3 + 1] = FACE_NORMALS[f][1];
                        nor[(b + k) * 3 + 2] = FACE_NORMALS[f][2];
                        col[(b + k) * 4] = rgb & 255;
                        col[(b + k) * 4 + 1] = (rgb >> 8) & 255;
                        col[(b + k) * 4 + 2] = (rgb >> 16) & 255;
                        col[(b + k) * 4 + 3] = 255;
                    }
                    const o = q * 36 + f * 6;
                    idx.set([b, b + 1, b + 2, b, b + 2, b + 3], o);
                }
            });
            const m = this.particleMeshes[c];
            m.setPositions(pos, 3, nv);
            m.setNormals(nor, 3, nv);
            m.setColors32(col, nv);
            m.setIndices(idx, idx.length);
            m.update(PRIMITIVE_TRIANGLES, false);
            m.aabb = new BoundingBox(
                new Vec3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2),
                new Vec3((maxX - minX) / 2, (maxY - minY) / 2, (maxZ - minZ) / 2)
            );
            mi.visible = true;
        }
    }

    /** Parts of an object shown now (by entity name). */
    visibleParts(name: string): number {
        const o = this.objects.find((x) => this.names.get(x.id) === name);
        return o ? o.parts.filter((p) => p.entity.enabled).length : 0;
    }

    /** Triangles drawn now: every shown unit, object part and the particles (the debug stats). */
    drawnTriangles(): number {
        let n = 0;
        for (const e of this.root.children as Entity[]) {
            if (!e.enabled || !e.render) continue;
            for (const mi of e.render.meshInstances) if (mi.visible) n += (mi.mesh?.primitive[0]?.count ?? 0) / 3;
        }
        return n;
    }

    /** Particle cubes drawn now: the triangles of the particle meshes shown (12 a cube). */
    particleTriangles(): number {
        let n = 0;
        for (const mi of this.particleInstances) if (mi.visible) n += (mi.mesh?.primitive[0]?.count ?? 0) / 3;
        return n;
    }

    /** Static units shown now (ground chunks, scenery, stand trees and stumps) and their triangles. */
    staticShown(): { units: number; triangles: number } {
        let units = 0;
        let triangles = 0;
        for (const e of this.root.children as Entity[]) {
            if (!e.enabled || !e.render || !/^smooth-(chunk|stand|stump)/.test(e.name)) continue;
            units++;
            for (const mi of e.render.meshInstances) triangles += (mi.mesh?.primitive[0]?.count ?? 0) / 3;
        }
        return { units, triangles };
    }

    /** One object part now (tests): shown, its triangles, and its world box's bottom and top (m). */
    partInfo(name: string, part: number): { shown: boolean; triangles: number; minY: number; maxY: number } | null {
        const o = this.objects.find((x) => this.names.get(x.id) === name);
        const e = o?.parts[part]?.entity;
        if (!e?.render) return null;
        let triangles = 0;
        let minY = Infinity;
        let maxY = -Infinity;
        for (const mi of e.render.meshInstances) {
            triangles += (mi.mesh?.primitive[0]?.count ?? 0) / 3;
            const b = mi.aabb;
            minY = Math.min(minY, b.center.y - b.halfExtents.y);
            maxY = Math.max(maxY, b.center.y + b.halfExtents.y);
        }
        return { shown: e.enabled, triangles, minY, maxY };
    }

    /** A stand tree's units shown now. */
    standState(n: number): { tree: boolean; stump: boolean } {
        const s = this.stand.get(n);
        return { tree: !!s?.tree?.enabled, stump: !!s?.stump?.enabled };
    }

    /** Drawn smooth meshes now: static units shown, object parts shown (stats and tests). */
    totals(): { meshes: number; objectParts: number } {
        let meshes = 0;
        let objectParts = 0;
        for (const e of this.root.children as Entity[]) {
            if (!e.enabled || !e.render) continue;
            meshes += e.render.meshInstances.length;
            if (/^smooth-(?!chunk|stand|stump|particles)/.test(e.name)) objectParts++;
        }
        return { meshes, objectParts };
    }
}

// cube faces (corners in cell units, counter-clockwise from outside) and their normals
const CUBE_FACES = [
    [
        [1, 0, 0],
        [1, 1, 0],
        [1, 1, 1],
        [1, 0, 1]
    ],
    [
        [0, 0, 1],
        [0, 1, 1],
        [0, 1, 0],
        [0, 0, 0]
    ],
    [
        [0, 1, 0],
        [0, 1, 1],
        [1, 1, 1],
        [1, 1, 0]
    ],
    [
        [0, 0, 1],
        [0, 0, 0],
        [1, 0, 0],
        [1, 0, 1]
    ],
    [
        [0, 0, 1],
        [1, 0, 1],
        [1, 1, 1],
        [0, 1, 1]
    ],
    [
        [1, 0, 0],
        [0, 0, 0],
        [0, 1, 0],
        [1, 1, 0]
    ]
];
const FACE_NORMALS = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1]
];
const _v = new Vec3();
const _q = new Quat();
const _up = new Vec3();
const _root = pose();
const _anim = new Float64Array(ANIM_MAX);
