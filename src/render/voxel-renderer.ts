/**
 * GPU side of the voxel meshes: receives finished unit meshes (from the voxel worker) and uploads
 * them. Static units are 6.4 x 3.2 x 6.4 m, dynamic units 1.6 m cubes; every vertex is in world
 * space on grid planes and render entities never move or rotate (design doc §5.5).
 *
 * All units of one voxel frame are applied together inside the frame director, before any camera,
 * shadow or reflection pass renders, so every pass sees the same completed voxel frame.
 */

import {
    BoundingBox,
    Entity,
    Mesh,
    MeshInstance,
    PRIMITIVE_TRIANGLES,
    SHADERLANGUAGE_GLSL,
    StandardMaterial,
    Vec3
} from 'playcanvas';
import type { AppBase, Layer } from 'playcanvas';

import { GRID_SIZE } from '../voxels/grid.ts';
import type { MeshMode } from '../voxels/mesher.ts';
import { SURFACE_CLASS_COUNT } from '../voxels/palette.ts';
import type { ClassMesh, UnitMesh } from '../workers/protocol.ts';

import { VOXEL_LIT_DECLARATIONS_GLSL, VOXEL_LIT_MAIN_END_GLSL } from './shader-chunks.ts';

interface Unit {
    key: number;
    mode: MeshMode;
    /** Footprint (m), for hiding far units under built near tiles. */
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    entity: Entity;
    meshes: Mesh[];
    instances: MeshInstance[];
    caps: number[];
    quads: number;
    triangles: number;
}

export interface UploadStats {
    units: number;
    uploadMs: number;
}

export class VoxelRenderer {
    readonly materials: StandardMaterial[] = [];
    private readonly app: AppBase;
    private readonly layer: Layer;
    private readonly root = new Entity('VoxelMeshes');
    private readonly staticUnits = new Map<number, Unit>();
    private readonly dynUnits = new Map<number, Unit>();
    readonly last: UploadStats = { units: 0, uploadMs: 0 };
    /** Every uploaded vertex is checked against the grid on arrival (§7.4). */
    verifiedVertices = 0;
    misalignedVertices = 0;
    dynamicVisible = true;

    /** Cell size of the lattice this renderer draws (per-item sizes: one renderer per lattice). */
    readonly cellSize: number;

    /** The far lattice of a streamed level: no shadows, sunk one cell, hidden under near tiles. */
    readonly far: boolean;
    /** Far units are shown only where this says the near world is not built. */
    private staticFilter: ((minX: number, maxX: number, minZ: number, maxZ: number) => boolean) | null = null;

    constructor(app: AppBase, layer: Layer, cellSize = GRID_SIZE, far = false) {
        this.app = app;
        this.layer = layer;
        this.cellSize = cellSize;
        this.far = far;
        // sunk by one of its own cells (still on its lattice): where far and near meet, the coarse
        // ground stays under the fine one instead of poking through it
        if (far) this.root.setLocalPosition(0, -cellSize, 0);
        app.root.addChild(this.root);
        this.createMaterials();
    }

    private createMaterials(): void {
        // surface classes: rough (timber, fur, grass), satin (mud, paint, plastic), metal
        const gloss = [0.2, 0.52, 0.66];
        const metal = [0, 0, 0.92];
        for (let c = 0; c < SURFACE_CLASS_COUNT; c++) {
            const m = new StandardMaterial();
            m.name = `voxel-${['rough', 'satin', 'metal'][c]}`;
            m.useMetalness = true;
            m.metalness = metal[c];
            m.gloss = gloss[c];
            m.diffuse.set(1, 1, 1);
            m.diffuseVertexColor = true;
            m.diffuseVertexColorChannel = 'rgb';
            m.vertexColorGamma = true;
            m.aoVertexColor = true;
            m.aoVertexColorChannel = 'a';
            m.shaderChunksVersion = '2.24';
            const chunks = m.getShaderChunks(SHADERLANGUAGE_GLSL);
            chunks.set('litUserDeclarationPS', VOXEL_LIT_DECLARATIONS_GLSL);
            chunks.set('litUserMainEndPS', VOXEL_LIT_MAIN_END_GLSL);
            m.setDefine('VOXEL_GRID', true);
            m.setDefine('WATER_CAUSTICS', true);
            m.update();
            this.materials.push(m);
        }
    }

    /** Uploads a batch of unit meshes (one voxel frame, or the initial static world). */
    apply(units: UnitMesh[]): UploadStats {
        const t0 = performance.now();
        for (const m of units) {
            const map = m.mode === 'static' ? this.staticUnits : this.dynUnits;
            let u = map.get(m.key);
            // streamed levels: a static unit that went empty (its tile left view) is dropped
            if (m.mode === 'static' && m.quads === 0) {
                if (u) {
                    u.entity.destroy();
                    map.delete(m.key);
                }
                continue;
            }
            if (!u) {
                u = this.createUnit(m);
                map.set(m.key, u);
                if (m.mode === 'dynamic') u.entity.enabled = this.dynamicVisible;
                else if (this.staticFilter) u.entity.enabled = this.staticFilter(u.minX, u.maxX, u.minZ, u.maxZ);
            }
            for (let c = 0; c < SURFACE_CLASS_COUNT; c++) this.upload(u, c, m.classes[c]);
            u.quads = m.quads;
            u.triangles = m.classes.reduce((n, c) => n + c.indexCount / 3, 0);
        }
        this.last.units = units.length;
        this.last.uploadMs = performance.now() - t0;
        return this.last;
    }

    private createUnit(m: UnitMesh): Unit {
        const entity = new Entity(`${m.mode}-${Math.round(this.cellSize * 1000) / 10}cm-${m.minI},${m.minJ},${m.minK}`);
        // One mesh + instance per surface class, created once and assigned once: the render
        // component destroys previously assigned instances whenever its list is replaced.
        const cs = this.cellSize;
        const half = new Vec3((m.sx * cs) / 2, (m.sy * cs) / 2, (m.sz * cs) / 2);
        const center = new Vec3(m.minI * cs + half.x, m.minJ * cs + half.y, m.minK * cs + half.z);
        const meshes: Mesh[] = [];
        const instances: MeshInstance[] = [];
        const dynamic = m.mode === 'dynamic';
        for (let c = 0; c < SURFACE_CLASS_COUNT; c++) {
            const mesh = new Mesh(this.app.graphicsDevice);
            // Establish the full vertex format (position, normal, colour) before any instance
            // exists: the shader variant is chosen from the mesh's format, so an instance created
            // on a format-less mesh would compile without vertex colours.
            mesh.clear(dynamic, dynamic, INITIAL_CAPACITY, INITIAL_CAPACITY * 1.5);
            mesh.setPositions(ZERO3, 3, 3);
            mesh.setNormals(UP3, 3, 3);
            mesh.setColors32(ZERO4, 3);
            mesh.setIndices(TRI, 3);
            mesh.update(PRIMITIVE_TRIANGLES, false);
            mesh.aabb = new BoundingBox(center, half);
            const mi = new MeshInstance(mesh, this.materials[c]);
            mi.visible = false;
            meshes.push(mesh);
            instances.push(mi);
        }
        entity.addComponent('render', {
            meshInstances: instances,
            layers: [this.layer.id],
            castShadows: !this.far,
            receiveShadows: true
        });
        this.root.addChild(entity);
        return {
            key: m.key,
            mode: m.mode,
            minX: m.minI * cs,
            maxX: (m.minI + m.sx) * cs,
            minZ: m.minK * cs,
            maxZ: (m.minK + m.sz) * cs,
            entity,
            meshes,
            instances,
            caps: new Array(SURFACE_CLASS_COUNT).fill(INITIAL_CAPACITY),
            quads: 0,
            triangles: 0
        };
    }

    private upload(u: Unit, cls: number, b: ClassMesh): void {
        const mi = u.instances[cls];
        if (b.vertexCount === 0) {
            mi.visible = false;
            return;
        }
        // grid check on arrival: every coordinate must be a multiple of the cell size
        const p = b.positions;
        for (let v = 0; v < b.vertexCount * 3; v++) {
            const g = p[v] / this.cellSize;
            if (Math.abs(g - Math.round(g)) > 1e-3) this.misalignedVertices++;
        }
        this.verifiedVertices += b.vertexCount;
        const mesh = u.meshes[cls];
        if (b.vertexCount > u.caps[cls]) {
            // grow capacity: buffers are reused until it is exceeded
            const cap = Math.max(INITIAL_CAPACITY, Math.ceil(b.vertexCount * (u.mode === 'dynamic' ? 1.6 : 1.0)));
            mesh.clear(u.mode === 'dynamic', u.mode === 'dynamic', cap, Math.ceil(cap * 1.5));
            u.caps[cls] = cap;
        }
        mesh.setPositions(b.positions, 3, b.vertexCount);
        mesh.setNormals(b.normals, 3, b.vertexCount);
        mesh.setColors32(b.colors, b.vertexCount);
        mesh.setIndices(b.indices, b.indexCount);
        mesh.update(PRIMITIVE_TRIANGLES, false);
        mi.visible = true;
    }

    /** Shows a static unit only where `show` says so (re-evaluated now and for new units). */
    setStaticFilter(show: ((minX: number, maxX: number, minZ: number, maxZ: number) => boolean) | null): void {
        this.staticFilter = show;
        for (const u of this.staticUnits.values())
            u.entity.enabled = show ? show(u.minX, u.maxX, u.minZ, u.maxZ) : true;
    }

    /** Shows or hides everything this lattice draws ("Voxels: Off" hides every lattice). */
    setVisible(v: boolean): void {
        this.root.enabled = v;
    }

    get visible(): boolean {
        return this.root.enabled;
    }

    setDynamicVisible(v: boolean): void {
        this.dynamicVisible = v;
        for (const u of this.dynUnits.values()) u.entity.enabled = v;
    }

    totals(): {
        staticUnits: number;
        dynamicUnits: number;
        quads: number;
        quadsDynamic: number;
        triangles: number;
        drawables: number;
    } {
        let quads = 0;
        let quadsDynamic = 0;
        let triangles = 0;
        let drawables = 0;
        for (const u of this.staticUnits.values()) {
            if (!u.entity.enabled) continue;
            quads += u.quads;
            triangles += u.triangles;
            for (const m of u.instances) if (m.visible) drawables++;
        }
        for (const u of this.dynUnits.values()) {
            quadsDynamic += u.quads;
            triangles += u.triangles;
            for (const m of u.instances) if (m.visible) drawables++;
        }
        return {
            staticUnits: this.staticUnits.size,
            dynamicUnits: this.dynUnits.size,
            quads: quads + quadsDynamic,
            quadsDynamic,
            triangles,
            drawables
        };
    }

    /**
     * Moves this lattice's meshes as one rigid body: a turn of `yaw` (radians, about Y) then a
     * shift. Only for a lane that draws nothing but your own first-person limbs, between voxel
     * frames (see VoxelClient.lockBody); the units themselves stay at identity.
     */
    setRootTransform(x: number, y: number, z: number, yaw: number): void {
        this.root.setLocalPosition(x, y, z);
        this.root.setLocalEulerAngles(0, (yaw * 180) / Math.PI, 0);
    }

    /** Render units must stay at the origin with identity rotation. */
    unitsAtIdentity(): boolean {
        for (const u of [...this.dynUnits.values(), ...this.staticUnits.values()]) {
            const p = u.entity.getLocalPosition();
            const r = u.entity.getLocalRotation();
            if (p.x !== 0 || p.y !== 0 || p.z !== 0 || r.w !== 1) return false;
        }
        return true;
    }
}

const INITIAL_CAPACITY = 1024;
const ZERO3 = new Float32Array(9);
const UP3 = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]);
const ZERO4 = new Uint8Array(12);
const TRI = new Uint32Array([0, 1, 2]);
