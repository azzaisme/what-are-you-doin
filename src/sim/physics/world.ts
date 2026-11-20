/**
 * Physics adapter (design doc §6.1, ADR 0008). Rapier owns a continuous world with simplified
 * colliders; the simulation reads body poses into its entities each fixed tick and publishes them
 * as snapshots. Nothing here knows about rendering or voxels: collision never comes from voxel
 * occupancy, and nothing from the renderer flows back in.
 *
 * Engine-free (no PlayCanvas). Rapier must be initialized first (initPhysics).
 */

import RAPIER from '@dimforge/rapier3d-compat';

import type { Pose } from '../../voxels/math.ts';
import { SIM_DT } from '../clock.ts';

import { GRAB, clampHold, grabForce, throwImpulse, viewDir } from './grab.ts';
import type { GrabForceResult, Vec3Like } from './grab.ts';

let ready: Promise<void> | null = null;

/** Loads the Rapier WASM module once. Must be awaited before creating a PhysicsWorld. */
export function initPhysics(): Promise<void> {
    if (!ready) {
        // Rapier 0.21 logs a deprecation notice for its own internal init call; keep the console clean
        const warn = console.warn;
        console.warn = (...a: unknown[]) => {
            if (typeof a[0] === 'string' && a[0].includes('deprecated parameters')) return;
            warn(...a);
        };
        ready = RAPIER.init().finally(() => {
            console.warn = warn;
        });
    }
    return ready;
}

export const GRAVITY = 9.81;

/** Collision layers (membership << 16 | filter). */
export const LAYER = {
    static: 1,
    prop: 2,
    player: 4,
    kinematic: 8,
    held: 16
} as const;
const ALL = 0xffff;
export const groups = (member: number, filter: number) => ((member & 0xffff) << 16) | (filter & 0xffff);

/** Safety bounds applied after every step (design doc §6.1: bound angular velocity etc.). */
export const LIMITS = {
    maxLinvel: 30,
    maxAngvel: 30,
    /** Bodies below this height or outside the box are put back at their spawn pose. */
    killY: -6,
    minX: -30,
    maxX: 30,
    minZ: -44,
    maxZ: 16
} as const;

export type ShapeSpec =
    | { type: 'box'; hx: number; hy: number; hz: number }
    | { type: 'ball'; r: number }
    /** Cylinder along an axis, centred, optionally offset along Y (bucket origin at its base). */
    | { type: 'cylinder'; axis: 'x' | 'y' | 'z'; r: number; half: number; offsetY?: number }
    | { type: 'capsule'; half: number; r: number; offsetY?: number };

export interface BodyOptions {
    density: number;
    friction?: number;
    restitution?: number;
    linearDamping?: number;
    angularDamping?: number;
    ccd?: boolean;
    grabbable?: boolean;
}

export interface PhysBody {
    /** Entity id this body drives. */
    id: number;
    body: RAPIER.RigidBody;
    colliders: RAPIER.Collider[];
    kind: 'dynamic' | 'kinematic';
    grabbable: boolean;
    spawn: Pose;
    baseAngularDamping: number;
    enabled: boolean;
}

export interface PhysicsStats {
    /** Wall time of the last Rapier step and of everything this adapter does around it (ms). */
    stepMs: number;
    tickMs: number;
    activeBodies: number;
    enabledBodies: number;
    /** Velocity clamps applied (cumulative) - a rising count means something is fighting. */
    linClamps: number;
    angClamps: number;
    /** Bodies put back after falling out of the world (cumulative). */
    recovered: number;
    /** Grab telemetry. */
    holding: number;
    grabError: number;
    grabForce: number;
    grabSaturated: boolean;
    maxHeldSpeed: number;
    grabBreaks: number;
}

export interface CharacterState {
    x: number;
    y: number;
    z: number;
    vx: number;
    vy: number;
    vz: number;
    grounded: boolean;
}

export const CHARACTER = {
    radius: 0.3,
    /** Capsule half height of the cylindrical part: total height 2 * (half + radius) = 1.4 m. */
    half: 0.4,
    walk: 2.2,
    run: 4.2,
    jump: 4.2,
    accelGround: 14,
    accelAir: 3,
    stepHeight: 0.32,
    stepMinWidth: 0.12,
    snap: 0.3,
    maxClimb: (50 * Math.PI) / 180,
    minSlide: (55 * Math.PI) / 180,
    /** Mass used to push dynamic props (bounded pushing, no infinite-mass shoves). */
    pushMass: 60
} as const;

const _v = { x: 0, y: 0, z: 0 };
const _dir = { x: 0, y: 0, z: 0 };
const _target = { x: 0, y: 0, z: 0 };
const _tv = { x: 0, y: 0, z: 0 };
const _force: GrabForceResult = { fx: 0, fy: 0, fz: 0, requested: 0, error: 0, saturated: false };

export class PhysicsWorld {
    readonly world: RAPIER.World;
    readonly bodies = new Map<number, PhysBody>();
    private readonly byCollider = new Map<number, PhysBody>();
    readonly stats: PhysicsStats = { stepMs: 0, tickMs: 0, activeBodies: 0, enabledBodies: 0, linClamps: 0, angClamps: 0, recovered: 0, holding: -1, grabError: 0, grabForce: 0, grabSaturated: false, maxHeldSpeed: 0, grabBreaks: 0 };
    readonly character: CharacterState = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, grounded: false };

    private player: RAPIER.RigidBody | null = null;
    private playerCollider: RAPIER.Collider | null = null;
    private controller: RAPIER.KinematicCharacterController | null = null;
    private terrainHandle = -1;

    // grab state
    private held: PhysBody | null = null;
    private heldLocal = { x: 0, y: 0, z: 0 };
    private holdDist = 1.5;
    private stretchTime = 0;

    constructor() {
        this.world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
        this.world.integrationParameters.dt = SIM_DT;
    }

    free(): void {
        this.world.free();
        this.bodies.clear();
        this.byCollider.clear();
    }

    // ------------------------------------------------------------------------------- static

    /**
     * Static terrain from an analytic height function sampled on a regular grid (never from voxels).
     * Rapier heightfields take (rows + 1) x (cols + 1) heights in column-major order; rows run along
     * Z and columns along X, centred on the collider.
     */
    addTerrain(height: (x: number, z: number) => number, minX: number, maxX: number, minZ: number, maxZ: number, cells: number): void {
        const cols = cells;
        const rows = cells;
        const heights = new Float32Array((rows + 1) * (cols + 1));
        for (let c = 0; c <= cols; c++) {
            const x = minX + (c * (maxX - minX)) / cols;
            for (let r = 0; r <= rows; r++) {
                const z = minZ + (r * (maxZ - minZ)) / rows;
                heights[r + c * (rows + 1)] = height(x, z);
            }
        }
        const desc = RAPIER.ColliderDesc.heightfield(rows, cols, heights, { x: maxX - minX, y: 1, z: maxZ - minZ }, RAPIER.HeightFieldFlags.FIX_INTERNAL_EDGES)
            .setTranslation((minX + maxX) / 2, 0, (minZ + maxZ) / 2)
            .setFriction(0.9)
            .setCollisionGroups(groups(LAYER.static, ALL));
        this.terrainHandle = this.world.createCollider(desc).handle;
    }

    addStatic(desc: RAPIER.ColliderDesc): RAPIER.Collider {
        return this.world.createCollider(desc.setCollisionGroups(groups(LAYER.static, ALL)));
    }

    // ------------------------------------------------------------------------------- bodies

    private colliderDesc(s: ShapeSpec): RAPIER.ColliderDesc {
        switch (s.type) {
            case 'box':
                return RAPIER.ColliderDesc.cuboid(s.hx, s.hy, s.hz);
            case 'ball':
                return RAPIER.ColliderDesc.ball(s.r);
            case 'capsule':
                return RAPIER.ColliderDesc.capsule(s.half, s.r).setTranslation(0, s.offsetY ?? 0, 0);
            case 'cylinder': {
                const d = RAPIER.ColliderDesc.cylinder(s.half, s.r).setTranslation(0, s.offsetY ?? 0, 0);
                const h = Math.SQRT1_2;
                // Rapier cylinders run along Y; rotate them onto X or Z
                if (s.axis === 'x') d.setRotation({ x: 0, y: 0, z: h, w: h });
                else if (s.axis === 'z') d.setRotation({ x: h, y: 0, z: 0, w: h });
                return d;
            }
        }
    }

    addDynamic(id: number, shape: ShapeSpec, spawn: Pose, o: BodyOptions): PhysBody {
        const bd = RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(spawn.p.x, spawn.p.y, spawn.p.z)
            .setRotation({ ...spawn.q })
            .setLinearDamping(o.linearDamping ?? 0.05)
            .setAngularDamping(o.angularDamping ?? 0.3)
            .setCcdEnabled(o.ccd ?? false);
        const body = this.world.createRigidBody(bd);
        const cd = this.colliderDesc(shape)
            .setDensity(o.density)
            .setFriction(o.friction ?? 0.7)
            .setRestitution(o.restitution ?? 0.15)
            .setCollisionGroups(groups(LAYER.prop, ALL));
        const col = this.world.createCollider(cd, body);
        const pb: PhysBody = {
            id,
            body,
            colliders: [col],
            kind: 'dynamic',
            grabbable: o.grabbable ?? true,
            spawn: { p: { ...spawn.p }, q: { ...spawn.q } },
            baseAngularDamping: o.angularDamping ?? 0.3,
            enabled: true
        };
        this.bodies.set(id, pb);
        this.byCollider.set(col.handle, pb);
        return pb;
    }

    /** A kinematic body that follows scripted poses (beaver, ute). Pushes props, is not pushed. */
    addKinematic(id: number, shapes: { shape: ShapeSpec; x: number; y: number; z: number }[], spawn: Pose): PhysBody {
        const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn.p.x, spawn.p.y, spawn.p.z).setRotation({ ...spawn.q }));
        const colliders: RAPIER.Collider[] = [];
        for (const s of shapes) {
            const d = this.colliderDesc(s.shape);
            const t = d.translation;
            d.setTranslation(t.x + s.x, t.y + s.y, t.z + s.z).setFriction(0.8).setCollisionGroups(groups(LAYER.kinematic, ALL));
            colliders.push(this.world.createCollider(d, body));
        }
        const pb: PhysBody = { id, body, colliders, kind: 'kinematic', grabbable: false, spawn: { p: { ...spawn.p }, q: { ...spawn.q } }, baseAngularDamping: 0, enabled: true };
        this.bodies.set(id, pb);
        for (const c of colliders) this.byCollider.set(c.handle, pb);
        return pb;
    }

    setKinematicTarget(id: number, p: Pose): void {
        const b = this.bodies.get(id);
        if (!b || b.kind !== 'kinematic') return;
        b.body.setNextKinematicTranslation(p.p);
        b.body.setNextKinematicRotation(p.q);
    }

    setEnabled(id: number, enabled: boolean): void {
        const b = this.bodies.get(id);
        if (!b || b.enabled === enabled) return;
        if (!enabled && this.held === b) this.release();
        b.enabled = enabled;
        b.body.setEnabled(enabled);
    }

    /** Puts a body at a pose with a velocity (spawning, scripted tests, recovery). */
    place(id: number, p: Pose, lin: Vec3Like = { x: 0, y: 0, z: 0 }, ang: Vec3Like = { x: 0, y: 0, z: 0 }): void {
        const b = this.bodies.get(id);
        if (!b) return;
        if (this.held === b) this.release();
        b.body.setTranslation(p.p, true);
        b.body.setRotation(p.q, true);
        b.body.setLinvel(lin, true);
        b.body.setAngvel(ang, true);
    }

    respawn(id: number): void {
        const b = this.bodies.get(id);
        if (b) this.place(id, b.spawn);
    }

    readPose(id: number, out: Pose): boolean {
        const b = this.bodies.get(id);
        if (!b) return false;
        const t = b.body.translation();
        const q = b.body.rotation();
        out.p.x = t.x;
        out.p.y = t.y;
        out.p.z = t.z;
        out.q.x = q.x;
        out.q.y = q.y;
        out.q.z = q.z;
        out.q.w = q.w;
        return true;
    }

    // ------------------------------------------------------------------------------- character

    /** Kinematic capsule driven by Rapier's character controller (step-up, slopes, ground snap). */
    createCharacter(x: number, y: number, z: number): void {
        const C = CHARACTER;
        this.player = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(x, y, z));
        const cd = RAPIER.ColliderDesc.capsule(C.half, C.radius)
            .setTranslation(0, C.half + C.radius, 0)
            .setCollisionGroups(groups(LAYER.player, LAYER.static | LAYER.prop | LAYER.kinematic))
            // no contact forces with props: the controller pushes them with bounded impulses instead
            .setSolverGroups(groups(LAYER.player, 0));
        this.playerCollider = this.world.createCollider(cd, this.player);
        const k = this.world.createCharacterController(0.02);
        k.enableAutostep(C.stepHeight, C.stepMinWidth, false);
        k.enableSnapToGround(C.snap);
        k.setMaxSlopeClimbAngle(C.maxClimb);
        k.setMinSlopeSlideAngle(C.minSlide);
        k.setApplyImpulsesToDynamicBodies(true);
        k.setCharacterMass(C.pushMass);
        k.setSlideEnabled(true);
        this.controller = k;
        Object.assign(this.character, { x, y, z, vx: 0, vy: 0, vz: 0, grounded: false });
    }

    setCharacterEnabled(enabled: boolean): void {
        if (!this.player) return;
        if (!enabled) this.release();
        this.player.setEnabled(enabled);
    }

    placeCharacter(x: number, y: number, z: number): void {
        if (!this.player) return;
        this.player.setTranslation({ x, y, z }, true);
        this.player.setNextKinematicTranslation({ x, y, z });
        Object.assign(this.character, { x, y, z, vx: 0, vy: 0, vz: 0, grounded: false });
    }

    /**
     * Moves the character for one tick from a desired horizontal velocity (world space) and a jump
     * request. Gravity, step-up and sliding are handled here; the controller never enters statics.
     */
    moveCharacter(wishX: number, wishZ: number, jump: boolean): void {
        const k = this.controller;
        const body = this.player;
        const col = this.playerCollider;
        if (!k || !body || !col) return;
        const C = CHARACTER;
        const s = this.character;
        const dt = SIM_DT;
        const a = Math.min(1, dt * (s.grounded ? C.accelGround : C.accelAir));
        s.vx += (wishX - s.vx) * a;
        s.vz += (wishZ - s.vz) * a;
        if (s.grounded && jump) {
            s.vy = C.jump;
            s.grounded = false;
        }
        s.vy -= GRAVITY * dt;
        if (s.grounded && s.vy < -1) s.vy = -1; // keep pressing into the ground, never accumulate
        const heldHandle = this.held ? this.held.body.handle : -1;
        k.computeColliderMovement(
            col,
            { x: s.vx * dt, y: s.vy * dt, z: s.vz * dt },
            RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
            groups(LAYER.player, LAYER.static | LAYER.prop | LAYER.kinematic),
            // never collide with (or climb onto) what you are holding: no grab/body feedback loop
            heldHandle < 0 ? undefined : (c: RAPIER.Collider) => c.parent()?.handle !== heldHandle
        );
        const m = k.computedMovement();
        const t = body.translation();
        const nx = t.x + m.x;
        const ny = t.y + m.y;
        const nz = t.z + m.z;
        body.setNextKinematicTranslation({ x: nx, y: ny, z: nz });
        const grounded = k.computedGrounded();
        if (grounded && s.vy < 0) s.vy = 0;
        if (!grounded && s.vy > 0 && m.y < s.vy * dt * 0.5) s.vy = 0; // bumped the head
        // horizontal velocity follows what actually happened (walls stop you, no stored push)
        if (Math.abs(m.x) < Math.abs(s.vx * dt) * 0.5) s.vx = m.x / dt;
        if (Math.abs(m.z) < Math.abs(s.vz * dt) * 0.5) s.vz = m.z / dt;
        s.grounded = grounded;
        s.x = nx;
        s.y = ny;
        s.z = nz;
    }

    // ------------------------------------------------------------------------------- grab

    get heldId(): number {
        return this.held ? this.held.id : -1;
    }

    /** Raycasts from the eye along the view; grabs the first grabbable dynamic body within reach. */
    tryGrab(eye: Vec3Like, yaw: number, pitch: number): boolean {
        if (this.held) return false;
        const d = viewDir(yaw, pitch, _dir);
        const ray = new RAPIER.Ray({ x: eye.x, y: eye.y, z: eye.z }, { x: d.x, y: d.y, z: d.z });
        const hit = this.world.castRay(ray, GRAB.reach, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, groups(ALL, ALL & ~LAYER.player), this.playerCollider ?? undefined);
        if (!hit) return false;
        const pb = this.byCollider.get(hit.collider.handle);
        if (!pb || pb.kind !== 'dynamic' || !pb.grabbable || !pb.enabled) return false;
        const px = eye.x + d.x * hit.timeOfImpact;
        const py = eye.y + d.y * hit.timeOfImpact;
        const pz = eye.z + d.z * hit.timeOfImpact;
        this.grabAt(pb, { x: px, y: py, z: pz }, hit.timeOfImpact);
        return true;
    }

    /** Read-only: id of the grabbable body the view ray hits within reach, or -1 (for UI prompts). */
    probe(eye: Vec3Like, yaw: number, pitch: number): number {
        const d = viewDir(yaw, pitch, _dir);
        const ray = new RAPIER.Ray({ x: eye.x, y: eye.y, z: eye.z }, { x: d.x, y: d.y, z: d.z });
        const hit = this.world.castRay(ray, GRAB.reach, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, groups(ALL, ALL & ~LAYER.player), this.playerCollider ?? undefined);
        const pb = hit ? this.byCollider.get(hit.collider.handle) : undefined;
        return pb && pb.kind === 'dynamic' && pb.grabbable && pb.enabled && pb !== this.held ? pb.id : -1;
    }

    /** Grabs a body at a world point (used by tryGrab and by "put the plank in my hands"). */
    grabAt(pb: PhysBody, point: Vec3Like, holdDistance: number): void {
        if (this.held) this.release();
        // anchor in body-local coordinates
        const t = pb.body.translation();
        const q = pb.body.rotation();
        inverseRotate(q, point.x - t.x, point.y - t.y, point.z - t.z, this.heldLocal);
        this.held = pb;
        this.holdDist = clampHold(holdDistance);
        this.stretchTime = 0;
        pb.body.setAngularDamping(GRAB.heldAngularDamping);
        for (const c of pb.colliders) c.setCollisionGroups(groups(LAYER.held, ALL & ~LAYER.player));
        pb.body.wakeUp();
        this.stats.holding = pb.id;
    }

    grabById(id: number, point: Vec3Like, holdDistance: number): void {
        const pb = this.bodies.get(id);
        if (pb && pb.kind === 'dynamic' && pb.enabled) this.grabAt(pb, point, holdDistance);
    }

    release(): void {
        const pb = this.held;
        if (!pb) return;
        pb.body.setAngularDamping(pb.baseAngularDamping);
        for (const c of pb.colliders) c.setCollisionGroups(groups(LAYER.prop, ALL));
        this.held = null;
        this.stats.holding = -1;
        this.stats.grabError = 0;
        this.stats.grabForce = 0;
        this.stats.grabSaturated = false;
    }

    /** Releases with a bounded impulse along the view. */
    throwHeld(yaw: number, pitch: number): void {
        const pb = this.held;
        if (!pb) return;
        this.release();
        const d = viewDir(yaw, pitch, _dir);
        const j = throwImpulse(pb.body.mass());
        pb.body.applyImpulse({ x: d.x * j, y: d.y * j + j * 0.15, z: d.z * j }, true);
    }

    adjustHold(delta: number): void {
        this.holdDist = clampHold(this.holdDist + delta);
    }

    /** Applies this tick's bounded grab force. Call once per tick before step(). */
    applyGrab(eye: Vec3Like, yaw: number, pitch: number, eyeVel: Vec3Like): void {
        const pb = this.held;
        if (!pb) return;
        const d = viewDir(yaw, pitch, _dir);
        _target.x = eye.x + d.x * this.holdDist;
        _target.y = eye.y + d.y * this.holdDist;
        _target.z = eye.z + d.z * this.holdDist;
        const b = pb.body;
        const t = b.translation();
        const q = b.rotation();
        rotate(q, this.heldLocal.x, this.heldLocal.y, this.heldLocal.z, _v);
        const anchor = { x: t.x + _v.x, y: t.y + _v.y, z: t.z + _v.z };
        const av = b.velocityAtPoint(anchor);
        _tv.x = eyeVel.x;
        _tv.y = eyeVel.y;
        _tv.z = eyeVel.z;
        const f = grabForce({ mass: b.mass(), gravity: GRAVITY, anchor, anchorVelocity: av, target: _target, targetVelocity: _tv }, _force);
        b.applyImpulseAtPoint({ x: f.fx * SIM_DT, y: f.fy * SIM_DT, z: f.fz * SIM_DT }, anchor, true);
        const s = this.stats;
        s.grabError = f.error;
        s.grabForce = Math.hypot(f.fx, f.fy, f.fz);
        s.grabSaturated = f.saturated;
        const lv = b.linvel();
        s.maxHeldSpeed = Math.max(s.maxHeldSpeed, Math.hypot(lv.x, lv.y, lv.z));
        // snagged or too heavy to follow: let go rather than build up energy
        this.stretchTime = f.error > GRAB.breakDistance ? this.stretchTime + SIM_DT : 0;
        if (this.stretchTime > GRAB.breakTime || f.error > GRAB.snapDistance) {
            s.grabBreaks++;
            this.release();
        }
    }

    // ------------------------------------------------------------------------------- step

    step(): void {
        const t0 = now();
        this.world.step();
        const t1 = now();
        // bound velocities and recover lost bodies
        let active = 0;
        let enabled = 0;
        const s = this.stats;
        for (const pb of this.bodies.values()) {
            if (pb.kind !== 'dynamic' || !pb.enabled) continue;
            enabled++;
            const b = pb.body;
            if (b.isSleeping()) continue;
            active++;
            const lv = b.linvel();
            const ls = Math.hypot(lv.x, lv.y, lv.z);
            if (ls > LIMITS.maxLinvel) {
                const k = LIMITS.maxLinvel / ls;
                b.setLinvel({ x: lv.x * k, y: lv.y * k, z: lv.z * k }, true);
                s.linClamps++;
            }
            const w = b.angvel();
            const ws = Math.hypot(w.x, w.y, w.z);
            if (ws > LIMITS.maxAngvel) {
                const k = LIMITS.maxAngvel / ws;
                b.setAngvel({ x: w.x * k, y: w.y * k, z: w.z * k }, true);
                s.angClamps++;
            }
            const p = b.translation();
            const lost = !Number.isFinite(p.x + p.y + p.z) || p.y < LIMITS.killY || p.x < LIMITS.minX || p.x > LIMITS.maxX || p.z < LIMITS.minZ || p.z > LIMITS.maxZ;
            if (lost) {
                this.place(pb.id, pb.spawn);
                s.recovered++;
            }
        }
        s.activeBodies = active;
        s.enabledBodies = enabled;
        s.stepMs = t1 - t0;
        s.tickMs = now() - t0;
    }

    /** Debug wireframe of every collider except the terrain (lines as xyz pairs). */
    debugLines(): Float32Array {
        const th = this.terrainHandle;
        return this.world.debugRender(undefined, (c) => c.handle !== th).vertices;
    }

    /** Raycast against static geometry only (used for placing things on the ground). */
    groundY(x: number, z: number, fromY = 50): number | null {
        const hit = this.world.castRay(new RAPIER.Ray({ x, y: fromY, z }, { x: 0, y: -1, z: 0 }), 200, true, undefined, groups(ALL, LAYER.static));
        return hit ? fromY - hit.timeOfImpact : null;
    }
}

function now(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function rotate(q: { x: number; y: number; z: number; w: number }, x: number, y: number, z: number, out: Vec3Like): Vec3Like {
    // v' = v + 2w(q x v) + 2 q x (q x v)
    const tx = 2 * (q.y * z - q.z * y);
    const ty = 2 * (q.z * x - q.x * z);
    const tz = 2 * (q.x * y - q.y * x);
    out.x = x + q.w * tx + (q.y * tz - q.z * ty);
    out.y = y + q.w * ty + (q.z * tx - q.x * tz);
    out.z = z + q.w * tz + (q.x * ty - q.y * tx);
    return out;
}

function inverseRotate(q: { x: number; y: number; z: number; w: number }, x: number, y: number, z: number, out: Vec3Like): Vec3Like {
    return rotate({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, x, y, z, out);
}
