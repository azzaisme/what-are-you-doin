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

import { GRAB, clampHold, effectiveMassAlong, grabForce, throwImpulse, viewDir, wristTorque } from './grab.ts';
import type { GrabForceResult, Quat, Vec3Like, WristResult } from './grab.ts';

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

const HEIGHT_CACHE = new WeakMap<(x: number, z: number) => number, Map<string, Float32Array>>();

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
    /** Body-local point always used as the grab anchor (a bucket is held by its handle). */
    grabPoint?: { x: number; y: number; z: number };
    /** Wrist strength for this body (N m), instead of GRAB.maxTorque (long timber is braced). */
    wristTorque?: number;
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
    /** Average projected area (m^2) the wind acts on (surface area / 4 for convex shapes). */
    windArea: number;
    /** Body-local grab anchor override (see BodyOptions.grabPoint). */
    grabPoint?: { x: number; y: number; z: number };
    /** See BodyOptions.wristTorque. */
    wristTorque?: number;
    /** Never sleeps (the ute): left out of the active-body count, which tracks things settling. */
    alwaysAwake?: boolean;
}

/**
 * After a release, the body's speed is bounded for this many ticks to max(RELEASE_MIN_CAP, 1.2 x its
 * speed at release, plus any throw). A grab that snags can leave a body pressed into a tree or rock;
 * without this, Rapier's penetration recovery could fling it (measured: a plank at 21 m/s).
 */
export const RELEASE_GUARD_TICKS = 30;
export const RELEASE_MIN_CAP = 8;

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
    /** Post-release speed bounds applied (cumulative; see RELEASE_GUARD_TICKS). */
    releaseClamps: number;
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

const EMPTY_STATE: CharacterState = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, grounded: false };

/** What a player holds, for animation (see PhysicsWorld.heldInfo). */
export interface HeldInfo {
    x: number;
    y: number;
    z: number;
    mass: number;
    halfWidth: number;
    strain: number;
}

/** One player's physical presence: capsule, controller and what they hold. */
export class Rig {
    held: PhysBody | null = null;
    heldLocal = { x: 0, y: 0, z: 0 };
    holdDist = 1.5;
    /** The hold distance was set with the wheel: it no longer eases in to the comfortable carry. */
    holdSet = false;
    /**
     * Wrist: the held body's orientation relative to the player's facing when the grip took hold;
     * the wrist turns it back towards that (see GRAB.maxTorque).
     */
    wristRel: Quat = { x: 0, y: 0, z: 0, w: 1 };
    wristValid = false;
    /** Twist the wrist wants over what it can give (1 or more: tipping), and the angle off (rad). */
    wristLoad = 0;
    wristAngle = 0;
    stretchTime = 0;
    prevTarget = { x: 0, y: 0, z: 0 };
    hasPrevTarget = false;
    grabError = 0;
    grabForce = 0;
    readonly body: RAPIER.RigidBody;
    readonly collider: RAPIER.Collider;
    readonly controller: RAPIER.KinematicCharacterController;
    readonly state: CharacterState;

    constructor(
        body: RAPIER.RigidBody,
        collider: RAPIER.Collider,
        controller: RAPIER.KinematicCharacterController,
        state: CharacterState
    ) {
        this.body = body;
        this.collider = collider;
        this.controller = controller;
        this.state = state;
    }
}

const _wristTarget: Quat = { x: 0, y: 0, z: 0, w: 1 };
const _wrist: WristResult = { tx: 0, ty: 0, tz: 0, angle: 0, load: 0 };
const AXIS_X = { x: 1, y: 0, z: 0 };
const AXIS_Y = { x: 0, y: 1, z: 0 };
const AXIS_Z = { x: 0, y: 0, z: 1 };

/**
 * The distance along the view (from the eye, at `pitch`) to a point `reach` from the shoulders,
 * which are `drop` below the eye: where the hands are with the arms out towards where you look.
 */
export function handsHold(reach: number, drop: number, pitch: number): number {
    const s = Math.sin(pitch);
    const c = Math.cos(pitch);
    return -drop * s + Math.sqrt(Math.max(0, reach * reach - drop * drop * c * c));
}

export class PhysicsWorld {
    /** Bodies outside this box (or below LIMITS.killY) go back to their spawn; levels may widen it. */
    killBox: { minX: number; maxX: number; minZ: number; maxZ: number } = {
        minX: LIMITS.minX,
        maxX: LIMITS.maxX,
        minZ: LIMITS.minZ,
        maxZ: LIMITS.maxZ
    };
    /**
     * How far from the shoulders held things are carried (m): in the player's hands. Things grabbed
     * from further away are drawn in to it. Infinity keeps the grab distance.
     */
    holdReach = Infinity;
    /** How far the shoulders are below the eye (m). */
    shoulderDrop = 0.2;
    /** With a finite holdReach: the nearest the eye things in your hands come (m). */
    holdMin: number = GRAB.minHold;
    /** The grab lets go when stretched this far for GRAB.breakTime, or at once beyond snapDistance (m). */
    breakDistance: number = GRAB.breakDistance;
    snapDistance: number = GRAB.snapDistance;
    readonly world: RAPIER.World;
    readonly bodies = new Map<number, PhysBody>();
    private readonly byCollider = new Map<number, PhysBody>();
    readonly stats: PhysicsStats = {
        stepMs: 0,
        tickMs: 0,
        activeBodies: 0,
        enabledBodies: 0,
        linClamps: 0,
        angClamps: 0,
        recovered: 0,
        releaseClamps: 0,
        holding: -1,
        grabError: 0,
        grabForce: 0,
        grabSaturated: false,
        maxHeldSpeed: 0,
        grabBreaks: 0
    };
    /** One rig per player: capsule, character controller, grab state. Player 0 is the default. */
    readonly rigs: Rig[] = [];
    private terrainHandle = -1;
    /** How many rigs hold each body (two beavers can carry one log; forces add, each bounded). */
    private readonly holdCount = new Map<number, number>();
    // a just-released body may be pressed into geometry (a snag); bound the energy it can pick up
    private readonly releasedGuards: { pb: PhysBody; ticks: number; cap: number }[] = [];

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
    addTerrain(
        height: (x: number, z: number) => number,
        minX: number,
        maxX: number,
        minZ: number,
        maxZ: number,
        cells: number
    ): void {
        const cols = cells;
        const rows = cells;
        // sampled once per level and size (a big level's heightfield is a million samples; the sim
        // rebuilds its physics on every reset)
        const key = `${minX},${maxX},${minZ},${maxZ},${cells}`;
        let byKey = HEIGHT_CACHE.get(height);
        if (!byKey) HEIGHT_CACHE.set(height, (byKey = new Map()));
        let heights = byKey.get(key);
        if (!heights) {
            heights = new Float32Array((rows + 1) * (cols + 1));
            for (let c = 0; c <= cols; c++) {
                const x = minX + (c * (maxX - minX)) / cols;
                for (let r = 0; r <= rows; r++) {
                    const z = minZ + (r * (maxZ - minZ)) / rows;
                    heights[r + c * (rows + 1)] = height(x, z);
                }
            }
            byKey.set(key, heights);
        }
        const desc = RAPIER.ColliderDesc.heightfield(
            rows,
            cols,
            heights,
            { x: maxX - minX, y: 1, z: maxZ - minZ },
            RAPIER.HeightFieldFlags.FIX_INTERNAL_EDGES
        )
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
            grabPoint: o.grabPoint,
            wristTorque: o.wristTorque,
            spawn: { p: { ...spawn.p }, q: { ...spawn.q } },
            baseAngularDamping: o.angularDamping ?? 0.3,
            enabled: true,
            windArea: windArea(shape)
        };
        this.bodies.set(id, pb);
        this.byCollider.set(col.handle, pb);
        return pb;
    }

    /**
     * A dynamic body built from several shapes, each with its own density (a vehicle: a heavy
     * chassis, a light cab). Not grabbable; the wind leaves it alone.
     */
    addDynamicCompound(
        id: number,
        shapes: { shape: ShapeSpec; x: number; y: number; z: number; density: number }[],
        spawn: Pose,
        o: { friction?: number; linearDamping?: number; angularDamping?: number; canSleep?: boolean }
    ): PhysBody {
        const body = this.world.createRigidBody(
            RAPIER.RigidBodyDesc.dynamic()
                .setTranslation(spawn.p.x, spawn.p.y, spawn.p.z)
                .setRotation({ ...spawn.q })
                .setLinearDamping(o.linearDamping ?? 0.05)
                .setAngularDamping(o.angularDamping ?? 0.3)
                .setCcdEnabled(true)
                .setCanSleep(o.canSleep ?? true)
        );
        const colliders: RAPIER.Collider[] = [];
        for (const s of shapes) {
            const d = this.colliderDesc(s.shape);
            const t = d.translation;
            d.setTranslation(t.x + s.x, t.y + s.y, t.z + s.z)
                .setDensity(s.density)
                .setFriction(o.friction ?? 0.6)
                .setRestitution(0.05)
                .setCollisionGroups(groups(LAYER.prop, ALL));
            colliders.push(this.world.createCollider(d, body));
        }
        const pb: PhysBody = {
            id,
            body,
            colliders,
            kind: 'dynamic',
            grabbable: false,
            spawn: { p: { ...spawn.p }, q: { ...spawn.q } },
            baseAngularDamping: o.angularDamping ?? 0.3,
            enabled: true,
            windArea: 0,
            alwaysAwake: o.canSleep === false
        };
        this.bodies.set(id, pb);
        for (const c of colliders) this.byCollider.set(c.handle, pb);
        return pb;
    }

    /** The body a collider belongs to, if it is one of ours. */
    bodyOfCollider(handle: number): PhysBody | undefined {
        return this.byCollider.get(handle);
    }

    /** A kinematic body that follows scripted poses (beaver, ute). Pushes props, is not pushed. */
    addKinematic(id: number, shapes: { shape: ShapeSpec; x: number; y: number; z: number }[], spawn: Pose): PhysBody {
        const body = this.world.createRigidBody(
            RAPIER.RigidBodyDesc.kinematicPositionBased()
                .setTranslation(spawn.p.x, spawn.p.y, spawn.p.z)
                .setRotation({ ...spawn.q })
        );
        const colliders: RAPIER.Collider[] = [];
        for (const s of shapes) {
            const d = this.colliderDesc(s.shape);
            const t = d.translation;
            d.setTranslation(t.x + s.x, t.y + s.y, t.z + s.z)
                .setFriction(0.8)
                .setCollisionGroups(groups(LAYER.kinematic, ALL));
            colliders.push(this.world.createCollider(d, body));
        }
        const pb: PhysBody = {
            id,
            body,
            colliders,
            kind: 'kinematic',
            grabbable: false,
            spawn: { p: { ...spawn.p }, q: { ...spawn.q } },
            baseAngularDamping: 0,
            enabled: true,
            windArea: 0
        };
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
        if (!enabled) this.releaseBody(b);
        b.enabled = enabled;
        b.body.setEnabled(enabled);
    }

    /** Puts a body at a pose with a velocity (spawning, scripted tests, recovery). */
    place(id: number, p: Pose, lin: Vec3Like = { x: 0, y: 0, z: 0 }, ang: Vec3Like = { x: 0, y: 0, z: 0 }): void {
        const b = this.bodies.get(id);
        if (!b) return;
        this.releaseBody(b);
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

    /** Player 0's character state (back-compatible accessor). */
    get character(): CharacterState {
        return this.rigs[0]?.state ?? EMPTY_STATE;
    }

    /**
     * Kinematic capsule driven by Rapier's character controller (step-up, slopes, ground snap) for a
     * player index (0, 1, ...). Players bump into each other but never push each other's held props.
     */
    createCharacter(x: number, y: number, z: number, p = 0): void {
        const C = CHARACTER;
        const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(x, y, z));
        const cd = RAPIER.ColliderDesc.capsule(C.half, C.radius)
            .setTranslation(0, C.half + C.radius, 0)
            .setCollisionGroups(groups(LAYER.player, LAYER.static | LAYER.prop | LAYER.kinematic | LAYER.player))
            // no contact forces with props: the controller pushes them with bounded impulses instead
            .setSolverGroups(groups(LAYER.player, 0));
        const collider = this.world.createCollider(cd, body);
        const k = this.world.createCharacterController(0.02);
        // dynamic bodies count as steps: you walk up onto beams and planks you have laid down
        k.enableAutostep(C.stepHeight, C.stepMinWidth, true);
        k.enableSnapToGround(C.snap);
        k.setMaxSlopeClimbAngle(C.maxClimb);
        k.setMinSlopeSlideAngle(C.minSlide);
        k.setApplyImpulsesToDynamicBodies(true);
        k.setCharacterMass(C.pushMass);
        k.setSlideEnabled(true);
        this.rigs[p] = new Rig(body, collider, k, { x, y, z, vx: 0, vy: 0, vz: 0, grounded: false });
    }

    rig(p = 0): Rig | undefined {
        return this.rigs[p];
    }

    setCharacterEnabled(enabled: boolean, p = 0): void {
        const r = this.rigs[p];
        if (!r) return;
        if (!enabled) this.release(p);
        r.body.setEnabled(enabled);
    }

    placeCharacter(x: number, y: number, z: number, p = 0): void {
        const r = this.rigs[p];
        if (!r) return;
        r.body.setTranslation({ x, y, z }, true);
        r.body.setNextKinematicTranslation({ x, y, z });
        Object.assign(r.state, { x, y, z, vx: 0, vy: 0, vz: 0, grounded: false });
    }

    /**
     * Moves a character for one tick from a desired horizontal velocity (world space) and a jump
     * request. Gravity, step-up and sliding are handled here; the controller never enters statics.
     */
    moveCharacter(wishX: number, wishZ: number, jump: boolean, p = 0): void {
        const r = this.rigs[p];
        if (!r) return;
        const k = r.controller;
        const body = r.body;
        const C = CHARACTER;
        const s = r.state;
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
        const heldHandle = r.held ? r.held.body.handle : -1;
        k.computeColliderMovement(
            r.collider,
            { x: s.vx * dt, y: s.vy * dt, z: s.vz * dt },
            RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
            groups(LAYER.player, LAYER.static | LAYER.prop | LAYER.kinematic | LAYER.player),
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

    /** Id of the body player 0 holds, or -1. */
    get heldId(): number {
        return this.heldIdOf(0);
    }

    heldIdOf(p: number): number {
        const r = this.rigs[p];
        return r?.held ? r.held.id : -1;
    }

    /** Number of players holding a body. */
    holders(id: number): number {
        return this.holdCount.get(id) ?? 0;
    }

    private castView(eye: Vec3Like, yaw: number, pitch: number, p: number): { pb: PhysBody; toi: number } | null {
        const d = viewDir(yaw, pitch, _dir);
        const ray = new RAPIER.Ray({ x: eye.x, y: eye.y, z: eye.z }, { x: d.x, y: d.y, z: d.z });
        // ignore every player capsule (yours and the other beaver's) and what any player holds is
        // still grabbable: two beavers can hold the same log
        const hit = this.world.castRay(
            ray,
            GRAB.reach,
            true,
            RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
            groups(ALL, ALL & ~LAYER.player),
            this.rigs[p]?.collider
        );
        if (!hit) return null;
        const pb = this.byCollider.get(hit.collider.handle);
        if (!pb || pb.kind !== 'dynamic' || !pb.grabbable || !pb.enabled) return null;
        return { pb, toi: hit.timeOfImpact };
    }

    /** Read-only: id of any body (grabbable or not: the ute) the view ray hits within reach, or -1. */
    probeAny(eye: Vec3Like, yaw: number, pitch: number, p = 0): number {
        const d = viewDir(yaw, pitch, _dir);
        const ray = new RAPIER.Ray({ x: eye.x, y: eye.y, z: eye.z }, { x: d.x, y: d.y, z: d.z });
        const hit = this.world.castRay(
            ray,
            GRAB.reach,
            true,
            RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
            groups(ALL, ALL & ~LAYER.player),
            this.rigs[p]?.collider
        );
        return hit ? (this.byCollider.get(hit.collider.handle)?.id ?? -1) : -1;
    }

    /** Raycasts from the eye along the view; grabs the first grabbable dynamic body within reach. */
    tryGrab(eye: Vec3Like, yaw: number, pitch: number, p = 0): boolean {
        const r = this.rigs[p];
        if (!r || r.held) return false;
        const hit = this.castView(eye, yaw, pitch, p);
        if (!hit) return false;
        const d = viewDir(yaw, pitch, _dir);
        this.grabAt(
            hit.pb,
            { x: eye.x + d.x * hit.toi, y: eye.y + d.y * hit.toi, z: eye.z + d.z * hit.toi },
            hit.toi,
            p
        );
        return true;
    }

    /** Read-only: id of the grabbable body the view ray hits within reach, or -1 (for UI prompts). */
    probe(eye: Vec3Like, yaw: number, pitch: number, p = 0): number {
        const hit = this.castView(eye, yaw, pitch, p);
        return hit && hit.pb !== this.rigs[p]?.held ? hit.pb.id : -1;
    }

    /** Grabs a body at a world point (used by tryGrab and by "put the plank in my hands"). */
    grabAt(pb: PhysBody, point: Vec3Like, holdDistance: number, p = 0): void {
        const r = this.rigs[p];
        if (!r) return;
        if (r.held) this.release(p);
        // anchor in body-local coordinates
        const t = pb.body.translation();
        const q = pb.body.rotation();
        if (pb.grabPoint) {
            r.heldLocal.x = pb.grabPoint.x;
            r.heldLocal.y = pb.grabPoint.y;
            r.heldLocal.z = pb.grabPoint.z;
        } else inverseRotate(q, point.x - t.x, point.y - t.y, point.z - t.z, r.heldLocal);
        r.held = pb;
        r.holdDist = clampHold(holdDistance);
        r.holdSet = false;
        r.wristValid = false;
        r.wristLoad = 0;
        r.wristAngle = 0;
        r.stretchTime = 0;
        r.hasPrevTarget = false;
        const n = (this.holdCount.get(pb.id) ?? 0) + 1;
        this.holdCount.set(pb.id, n);
        if (n === 1) {
            pb.body.setAngularDamping(pb.grabPoint ? GRAB.hangingAngularDamping : GRAB.heldAngularDamping);
            for (const c of pb.colliders) c.setCollisionGroups(groups(LAYER.held, ALL & ~LAYER.player));
        }
        pb.body.wakeUp();
        if (p === 0) this.stats.holding = pb.id;
    }

    grabById(id: number, point: Vec3Like, holdDistance: number, p = 0): void {
        const pb = this.bodies.get(id);
        if (pb && pb.kind === 'dynamic' && pb.enabled) this.grabAt(pb, point, holdDistance, p);
    }

    /**
     * Read-only, for animation: where a player's grip is on what they hold (world), the body's mass,
     * a rough half width (from its wind area) and how hard the grab is pulling (0-1 of the cap).
     * Returns false when the player holds nothing.
     */
    heldInfo(p: number, out: HeldInfo): boolean {
        const r = this.rigs[p];
        const pb = r?.held;
        if (!r || !pb) return false;
        const t = pb.body.translation();
        rotate(pb.body.rotation(), r.heldLocal.x, r.heldLocal.y, r.heldLocal.z, _v);
        out.x = t.x + _v.x;
        out.y = t.y + _v.y;
        out.z = t.z + _v.z;
        out.mass = pb.body.mass();
        out.halfWidth = Math.min(0.6, Math.sqrt(Math.max(0, pb.windArea)) * 0.5);
        out.strain = Math.min(1, Math.max(r.grabForce / GRAB.maxForce, r.wristLoad));
        return true;
    }

    /** Releases whatever a player holds. */
    release(p = 0): void {
        const r = this.rigs[p];
        const pb = r?.held;
        if (!r || !pb) return;
        r.held = null;
        const n = (this.holdCount.get(pb.id) ?? 1) - 1;
        if (n <= 0) {
            this.holdCount.delete(pb.id);
            pb.body.setAngularDamping(pb.baseAngularDamping);
            for (const c of pb.colliders) c.setCollisionGroups(groups(LAYER.prop, ALL));
            const v = pb.body.linvel();
            this.releasedGuards.push({
                pb,
                ticks: RELEASE_GUARD_TICKS,
                cap: Math.max(RELEASE_MIN_CAP, 1.2 * Math.hypot(v.x, v.y, v.z))
            });
        } else {
            this.holdCount.set(pb.id, n);
        }
        if (p === 0) {
            this.stats.holding = -1;
            this.stats.grabError = 0;
            this.stats.grabForce = 0;
            this.stats.grabSaturated = false;
        }
    }

    /** Every player lets go of a body (it is being moved, disabled or respawned). */
    private releaseBody(pb: PhysBody): void {
        for (let p = 0; p < this.rigs.length; p++) if (this.rigs[p]?.held === pb) this.release(p);
    }

    /** Releases with a bounded impulse along the view. */
    throwHeld(yaw: number, pitch: number, p = 0): void {
        const pb = this.rigs[p]?.held;
        if (!pb) return;
        this.release(p);
        const d = viewDir(yaw, pitch, _dir);
        const j = throwImpulse(pb.body.mass());
        pb.body.applyImpulse({ x: d.x * j, y: d.y * j + j * 0.15, z: d.z * j }, true);
        // the throw itself is allowed: raise the post-release bound by the throw speed
        const g = this.releasedGuards.find((x) => x.pb === pb);
        if (g) g.cap += j / Math.max(pb.body.mass(), 1e-3);
    }

    adjustHold(delta: number, p = 0): void {
        const r = this.rigs[p];
        if (!r) return;
        r.holdDist = clampHold(r.holdDist + delta);
        r.holdSet = true;
    }

    /** Applies this tick's bounded grab force for a player. Call once per tick before step(). */
    applyGrab(eye: Vec3Like, yaw: number, pitch: number, p = 0): void {
        const r = this.rigs[p];
        const pb = r?.held;
        if (!r || !pb) return;
        const d = viewDir(yaw, pitch, _dir);
        // carried in your hands: the hold distance follows arm's length from the shoulders for where
        // you look (things grabbed from further away are drawn in at 3 m/s; the mouse wheel can only
        // bring them nearer). Not while shared: two carriers at either end of a log would pull it
        // apart
        if (Number.isFinite(this.holdReach) && (this.holdCount.get(pb.id) ?? 1) === 1) {
            const want = Math.max(
                this.holdMin,
                Math.min(GRAB.maxHold, handsHold(this.holdReach, this.shoulderDrop, pitch))
            );
            if (r.holdSet) r.holdDist = Math.min(r.holdDist, want);
            else if (r.holdDist > want) r.holdDist = Math.max(want, r.holdDist - 3 * SIM_DT);
            else r.holdDist = Math.min(want, r.holdDist + 1 * SIM_DT);
        }
        _target.x = eye.x + d.x * r.holdDist;
        _target.y = eye.y + d.y * r.holdDist;
        _target.z = eye.z + d.z * r.holdDist;
        const b = pb.body;
        const t = b.translation();
        const q = b.rotation();
        rotate(q, r.heldLocal.x, r.heldLocal.y, r.heldLocal.z, _v);
        const anchor = { x: t.x + _v.x, y: t.y + _v.y, z: t.z + _v.z };
        const av = b.velocityAtPoint(anchor);
        // the hold point's own velocity: walking plus swinging round with the view
        if (r.hasPrevTarget) {
            _tv.x = (_target.x - r.prevTarget.x) / SIM_DT;
            _tv.y = (_target.y - r.prevTarget.y) / SIM_DT;
            _tv.z = (_target.z - r.prevTarget.z) / SIM_DT;
        } else {
            _tv.x = _tv.y = _tv.z = 0;
        }
        r.prevTarget.x = _target.x;
        r.prevTarget.y = _target.y;
        r.prevTarget.z = _target.z;
        r.hasPrevTarget = true;
        // with two holders, each supports half the weight (each force stays under its own cap)
        const share = 1 / Math.max(1, this.holdCount.get(pb.id) ?? 1);
        // the spring acts on the effective mass at the anchor (held by the rim, a light bucket
        // mostly spins), which keeps the explicit spring stable for small props
        const com = b.worldCom();
        const lever = { x: anchor.x - com.x, y: anchor.y - com.y, z: anchor.z - com.z };
        const invI = b.effectiveWorldInvInertia();
        const m = b.mass();
        const springMass = {
            x: effectiveMassAlong(m, lever, invI, AXIS_X) * share,
            y: effectiveMassAlong(m, lever, invI, AXIS_Y) * share,
            z: effectiveMassAlong(m, lever, invI, AXIS_Z) * share
        };
        const f = grabForce(
            {
                mass: b.mass() * share,
                springMass,
                gravity: GRAVITY,
                anchor,
                anchorVelocity: av,
                target: _target,
                targetVelocity: _tv
            },
            _force
        );
        b.applyImpulseAtPoint({ x: f.fx * SIM_DT, y: f.fy * SIM_DT, z: f.fz * SIM_DT }, anchor, true);
        r.grabError = f.error;
        r.grabForce = Math.hypot(f.fx, f.fy, f.fz);
        this.applyWrist(r, pb, yaw);
        const s = this.stats;
        if (p === 0) {
            s.grabError = f.error;
            s.grabForce = r.grabForce;
            s.grabSaturated = f.saturated;
        }
        const lv = b.linvel();
        s.maxHeldSpeed = Math.max(s.maxHeldSpeed, Math.hypot(lv.x, lv.y, lv.z));
        // snagged or too heavy to follow: let go rather than build up energy
        r.stretchTime = f.error > this.breakDistance ? r.stretchTime + SIM_DT : 0;
        if (r.stretchTime > GRAB.breakTime || f.error > this.snapDistance) {
            s.grabBreaks++;
            this.release(p);
        }
    }

    /**
     * The wrist: a capped torque holding the body at the angle it was picked up at, relative to the
     * player's facing. Where you grip it decides how much twist its weight puts on the wrist, so
     * held near its balance point it stays level, and held far off it, it tips about your hand.
     * Not for bodies with a fixed grab point (the bucket hangs from its handle). Shared, each grip
     * gives its share of one wrist's strength: two grips balance it between them and stop it
     * rolling in their hands.
     */
    private applyWrist(r: Rig, pb: PhysBody, yaw: number): void {
        r.wristLoad = 0;
        r.wristAngle = 0;
        if (pb.grabPoint) {
            r.wristValid = false;
            return;
        }
        // shared: each grip gives its share, so two wrists that disagree (the carriers turn
        // differently) only ever fight within one wrist's strength
        const share = 1 / Math.max(1, this.holdCount.get(pb.id) ?? 1);
        const b = pb.body;
        const q = b.rotation();
        const sy = Math.sin(yaw / 2);
        const cy = Math.cos(yaw / 2);
        if (!r.wristValid) {
            // rel = conj(yawQ) * q
            r.wristRel.x = cy * q.x - sy * q.z;
            r.wristRel.y = cy * q.y - sy * q.w;
            r.wristRel.z = cy * q.z + sy * q.x;
            r.wristRel.w = cy * q.w + sy * q.y;
            r.wristValid = true;
        }
        // target = yawQ * rel
        const rel = r.wristRel;
        _wristTarget.x = cy * rel.x + sy * rel.z;
        _wristTarget.y = cy * rel.y + sy * rel.w;
        _wristTarget.z = cy * rel.z - sy * rel.x;
        _wristTarget.w = cy * rel.w - sy * rel.y;
        const t = wristTorque(
            q,
            _wristTarget,
            b.angvel(),
            b.effectiveWorldInvInertia(),
            _wrist,
            (pb.wristTorque ?? GRAB.maxTorque) * share
        );
        b.applyTorqueImpulse({ x: t.tx * SIM_DT, y: t.ty * SIM_DT, z: t.tz * SIM_DT }, true);
        r.wristLoad = t.load;
        r.wristAngle = t.angle;
    }

    /**
     * Wind drag on every awake dynamic body for one tick: F = 1/2 rho Cd A |dv| dv (horizontal, with
     * rho Cd / 2 ~ 0.6), capped at 0.6 g per body so gusts push things around but never launch them.
     * Sleeping and resting bodies (slower than 0.25 m/s, not held) are left alone, so props settle
     * and sleep. Returns the largest force applied (N).
     */
    applyWind(wx: number, wz: number, dt: number): number {
        let maxF = 0;
        for (const pb of this.bodies.values()) {
            if (pb.kind !== 'dynamic' || !pb.enabled || pb.windArea <= 0) continue;
            const b = pb.body;
            if (b.isSleeping()) continue;
            const v = b.linvel();
            // resting props are left alone, so they settle and sleep; wind acts on what moves, falls
            // or is carried
            if (Math.hypot(v.x, v.y, v.z) < 0.25 && this.holders(pb.id) === 0) continue;
            const rx = wx - v.x;
            const rz = wz - v.z;
            const rel = Math.hypot(rx, rz);
            if (rel < 1e-3) continue;
            let f = 0.6 * pb.windArea * rel * rel;
            const cap = 0.6 * b.mass() * GRAVITY;
            if (f > cap) f = cap;
            maxF = Math.max(maxF, f);
            b.applyImpulse({ x: (rx / rel) * f * dt, y: 0, z: (rz / rel) * f * dt }, false);
        }
        return maxF;
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
            if (!pb.alwaysAwake) active++;
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
            const lost =
                !Number.isFinite(p.x + p.y + p.z) ||
                p.y < LIMITS.killY ||
                p.x < this.killBox.minX ||
                p.x > this.killBox.maxX ||
                p.z < this.killBox.minZ ||
                p.z > this.killBox.maxZ;
            if (lost) {
                this.place(pb.id, pb.spawn);
                s.recovered++;
            }
        }
        for (let i = this.releasedGuards.length - 1; i >= 0; i--) {
            const g = this.releasedGuards[i];
            const b = g.pb.body;
            const lv = b.linvel();
            const ls = Math.hypot(lv.x, lv.y, lv.z);
            if (ls > g.cap) {
                const k = g.cap / ls;
                b.setLinvel({ x: lv.x * k, y: lv.y * k, z: lv.z * k }, true);
                s.releaseClamps++;
            }
            if (--g.ticks <= 0 || this.holders(g.pb.id) > 0) this.releasedGuards.splice(i, 1);
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
        const hit = this.world.castRay(
            new RAPIER.Ray({ x, y: fromY, z }, { x: 0, y: -1, z: 0 }),
            200,
            true,
            undefined,
            groups(ALL, LAYER.static)
        );
        return hit ? fromY - hit.timeOfImpact : null;
    }
}

function now(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function rotate(
    q: { x: number; y: number; z: number; w: number },
    x: number,
    y: number,
    z: number,
    out: Vec3Like
): Vec3Like {
    // v' = v + 2w(q x v) + 2 q x (q x v)
    const tx = 2 * (q.y * z - q.z * y);
    const ty = 2 * (q.z * x - q.x * z);
    const tz = 2 * (q.x * y - q.y * x);
    out.x = x + q.w * tx + (q.y * tz - q.z * ty);
    out.y = y + q.w * ty + (q.z * tx - q.x * tz);
    out.z = z + q.w * tz + (q.x * ty - q.y * tx);
    return out;
}

function inverseRotate(
    q: { x: number; y: number; z: number; w: number },
    x: number,
    y: number,
    z: number,
    out: Vec3Like
): Vec3Like {
    return rotate({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, x, y, z, out);
}

/** Average projected area of a convex shape: a quarter of its surface area. */
function windArea(s: ShapeSpec): number {
    switch (s.type) {
        case 'box':
            return 2 * (s.hx * s.hy + s.hy * s.hz + s.hz * s.hx);
        case 'ball':
            return Math.PI * s.r * s.r;
        case 'cylinder':
            return (2 * Math.PI * s.r * s.r + 4 * Math.PI * s.r * s.half) / 4;
        case 'capsule':
            return (4 * Math.PI * s.r * s.r + 4 * Math.PI * s.r * s.half) / 4;
    }
}
