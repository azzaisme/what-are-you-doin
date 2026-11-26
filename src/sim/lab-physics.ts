/**
 * Level physics content (Epic 2): static terrain, trees, rocks, scenery pieces and walls; kinematic
 * colliders following the scripted beaver and ute; dynamic props, the ragdoll dummy and stress
 * bodies. Built from the analytic level description (never from voxels), engine-free.
 */

import RAPIER from '@dimforge/rapier3d-compat';

import { DOLLY, DOLLY_SHAPES } from '../assets/dolly.ts';
import { DUMMY_PARTS, dummyRestPose } from '../assets/dummy.ts';
import { AXE, SHORT_LOG_HALF } from '../assets/forestry.ts';
import {
    BEAM_HALF,
    BUCKET_HANDLE_TOP,
    BUCKET_HEIGHT,
    LOG_RADIUS,
    LONG_PLANK_LENGTH,
    PLANK_HALF,
    PLANK_LENGTH
} from '../assets/props.ts';
import { OAK, PINE_TIERS, PINE_TRUNK_HEIGHT, ROCK_CENTRE_LIFT, oakCrown, pineTrunkRadius } from '../levels/common.ts';
import type { LevelDef } from '../levels/level.ts';
import { pose, quatFromYawPitchRoll, quatMul } from '../voxels/math.ts';
import type { Pose } from '../voxels/math.ts';

import { GRAB } from './physics/grab.ts';
import { CHARACTER, PhysicsWorld } from './physics/world.ts';
import type { BodyOptions, PhysBody, ShapeSpec } from './physics/world.ts';

/**
 * Heightfield cells per side (56 m / 251 = 0.223 m). Deliberately not a round spacing: Rapier 0.21
 * misses ray casts that land exactly on a heightfield cell boundary (measured with 0.2 m cells at
 * x = 0.6), and round coordinates are common in scripts and tests.
 */
export const TERRAIN_CELLS = 251;

export interface PropDef {
    id: number;
    shape: ShapeSpec;
    opts: BodyOptions;
    spawn: Pose;
}

/**
 * Every plank's own throw (only planks: the general cap, GRAB.maxThrowImpulse, and so every other
 * throw, the bucket's included, is unchanged). A plank leaves your hands at PLANK_THROW_SPEED (the
 * 24 kg plank at 2.9 m/s instead of 45 / 24 = 1.9 m/s) and lets go clean: no spin from the grip and
 * no sideways swing in your hands, so it flies flat along your view. It keeps the way you were moving,
 * like anything else you throw (tests/unit/throw.test.ts).
 */
export const PLANK_THROW_SPEED = 2.9;
const PLANK_DENSITY = 500;

/**
 * The tutorial's long plank is carried balanced (BodyOptions.carryAhead): wherever you grab it, your
 * grip slides to this far behind its middle, and it is held low in front of you whatever you look
 * at (CARRY_PITCH). Its middle rides 2.2 m ahead of where you stand, so the whole plank is ahead of
 * you; let go with your toes 0.4 to 1.0 m short of the tutorial ditch's edge and it lies 0.3 m or
 * more on each bank. Let go at the edge itself and its near end is already past it.
 */
export const LONG_PLANK_CARRY_AHEAD = 1.3;

/** A plank of a length: 0.2 x 0.1 m timber with the plank throw. */
function plankBody(length: number): { shape: ShapeSpec; opts: BodyOptions } {
    const mass = PLANK_DENSITY * length * 2 * PLANK_HALF.y * 2 * PLANK_HALF.z;
    const long = length > PLANK_LENGTH;
    return {
        shape: { type: 'box', hx: length / 2, hy: PLANK_HALF.y, hz: PLANK_HALF.z },
        opts: {
            density: PLANK_DENSITY,
            friction: 0.7,
            restitution: 0.1,
            ccd: true,
            nailable: true,
            // the long plank is shouldered like a beam (braced): it stays level held off its middle
            wristTorque: long ? GRAB.braceTorque : undefined,
            carryAhead: long ? LONG_PLANK_CARRY_AHEAD : undefined,
            throw: { maxImpulse: mass * PLANK_THROW_SPEED, steady: true }
        }
    };
}

const PLANK = plankBody(PLANK_LENGTH);
/** The tutorial's long plank (3.8 m, 38 kg). */
const LONG_PLANK = plankBody(LONG_PLANK_LENGTH);

/**
 * Collision shape and material for a prop entity, by name (the entity catalogue's naming):
 * plank 2.4 x 0.2 x 0.1 m ~24 kg (the tutorial's long plank 3.8 m ~38 kg); beam 3.2 x 0.2 x 0.15 m ~36 kg (liftable alone, just); log r 0.2
 * x 2 m ~113 kg (drag it); crate 0.5 m ~25 kg; bouncy ball; ~1.5 kg empty bucket (origin at base).
 */
/**
 * The log dolly (Epic 5, #52): its cradle, chocks and stop grip (timber), its casters slide (their
 * own low friction, the Min rule: averaged with the ground's they would not roll). Towed, not
 * carried: a grip only pulls it along the ground (PhysBody.towed).
 */
export function addDolly(pw: PhysicsWorld, id: number, at: Pose): PhysBody {
    return pw.addDynamicCompound(
        id,
        DOLLY_SHAPES.map((s) =>
            s.kind === 'caster'
                ? {
                      shape: { type: 'ball' as const, r: s.r },
                      x: s.x,
                      y: s.y,
                      z: s.z,
                      density: DOLLY.density,
                      friction: DOLLY.casterFriction,
                      slides: true
                  }
                : {
                      shape: { type: 'box' as const, hx: s.hx, hy: s.hy, hz: s.hz },
                      x: s.x,
                      y: s.y,
                      z: s.z,
                      density: DOLLY.density,
                      friction: DOLLY.timberFriction
                  }
        ),
        at,
        { grabbable: true, towed: true, angularDamping: 0.5 }
    );
}

export function propBody(name: string): { shape: ShapeSpec; opts: BodyOptions } | null {
    if (name === 'plank' || name === 'held-plank' || name.startsWith('extra-plank')) return PLANK;
    if (name === 'long-plank') return LONG_PLANK;
    if (name.startsWith('beam'))
        return {
            shape: { type: 'box', hx: BEAM_HALF.x, hy: BEAM_HALF.y, hz: BEAM_HALF.z },
            opts: {
                density: 380,
                friction: 0.75,
                restitution: 0.05,
                ccd: true,
                wristTorque: GRAB.braceTorque,
                nailable: true
            }
        };
    if (name.startsWith('short-log'))
        return {
            shape: { type: 'cylinder', axis: 'x', r: LOG_RADIUS, half: SHORT_LOG_HALF },
            opts: { density: 450, friction: 0.8, restitution: 0.05, angularDamping: 0.4 }
        };
    if (name === 'axe')
        // a 0.8 m handle with a steel head, ~2.5 kg
        return {
            shape: { type: 'box', hx: 0.05, hy: AXE.handleHalf, hz: 0.05 },
            opts: { density: 310, friction: 0.7, restitution: 0.1, ccd: true }
        };
    if (name === 'log' || name.startsWith('extra-log') || name.startsWith('felled-log'))
        return {
            shape: { type: 'cylinder', axis: 'x', r: LOG_RADIUS, half: 1.0 },
            opts: { density: 450, friction: 0.8, restitution: 0.05, angularDamping: 0.4, nailable: true }
        };
    if (name === 'cube' || name.startsWith('crate-'))
        return {
            shape: { type: 'box', hx: 0.25, hy: 0.25, hz: 0.25 },
            opts: { density: 200, friction: 0.7, restitution: 0.1, nailable: true }
        };
    if (name === 'sphere')
        return {
            shape: { type: 'ball', r: 0.3 },
            opts: { density: 20, friction: 0.6, restitution: 0.78, angularDamping: 0.1, ccd: true }
        };
    if (name === 'bucket')
        return {
            shape: { type: 'cylinder', axis: 'y', r: 0.15, half: BUCKET_HEIGHT / 2, offsetY: BUCKET_HEIGHT / 2 },
            // held by the top of its handle, so it hangs upright and swings gently
            opts: {
                density: 70,
                friction: 0.6,
                restitution: 0.1,
                ccd: true,
                grabPoint: { x: 0, y: BUCKET_HANDLE_TOP, z: 0 }
            }
        };
    return null;
}

const STRESS_SHAPES: { shape: ShapeSpec; opts: BodyOptions }[] = [
    PLANK,
    { shape: { type: 'box', hx: 0.2, hy: 0.2, hz: 0.2 }, opts: { density: 250 } },
    { shape: { type: 'cylinder', axis: 'x', r: LOG_RADIUS, half: 1.0 }, opts: { density: 450 } }
];

/** Stress body kinds match the scripted stress assets: plank, 0.4 m cube, log. */
export function stressDef(level: LevelDef, id: number, n: number): PropDef {
    const k = STRESS_SHAPES[n % 3];
    const col = n % 5;
    const row = Math.floor(n / 5);
    const x = -4 + col * 2.1;
    const z = (level.id === 'yard' ? 4.5 : 1.5) + row * 1.1;
    return {
        id,
        shape: k.shape,
        opts: k.opts,
        spawn: pose(
            x,
            Math.max(level.terrainHeight(x, z), 0) + 2.5 + (n % 3) * 0.8,
            z,
            quatFromYawPitchRoll(n * 0.7, n * 0.3, n * 1.1)
        )
    };
}

export function buildLabPhysics(level: LevelDef): PhysicsWorld {
    const pw = new PhysicsWorld();
    const B = level.bounds;
    const ground = level.terrainHeight;
    // the same spacing (about 0.223 m) whatever the level's size: the Valley needs about 1,000 cells
    const cells = Math.max(
        TERRAIN_CELLS,
        Math.round((TERRAIN_CELLS * Math.max(B.maxX - B.minX, B.maxZ - B.minZ)) / 56)
    );
    pw.addTerrain(ground, B.minX, B.maxX, B.minZ, B.maxZ, cells);
    // the safety box covers the level (with a margin), never less than the default box
    const k = pw.killBox;
    pw.killBox = {
        minX: Math.min(k.minX, B.minX - 2),
        maxX: Math.max(k.maxX, B.maxX + 2),
        minZ: Math.min(k.minZ, B.minZ - 2),
        maxZ: Math.max(k.maxZ, B.maxZ + 2)
    };

    // trees: trunk cylinder plus the four needle cones (the same layout the voxel build uses)
    const layout = level.layout(1);
    for (const t of layout.trees) {
        if (t.x < B.minX || t.x > B.maxX || t.z < B.minZ || t.z > B.maxZ) continue;
        const base = ground(t.x, t.z);
        const s = t.scale;
        if (t.kind === 'oak') {
            const th = OAK.trunkHeight * s;
            pw.addStatic(
                RAPIER.ColliderDesc.cylinder(th / 2, OAK.trunkRadius * s + 0.02)
                    .setTranslation(t.x, base + th / 2 - 0.05, t.z)
                    .setFriction(0.8),
                false
            );
            for (const b of oakCrown(t, base))
                pw.addStatic(
                    RAPIER.ColliderDesc.ball(b.r * 0.85)
                        .setTranslation(b.x, b.y, b.z)
                        .setFriction(0.5),
                    false
                );
            continue;
        }
        const trunkH = PINE_TRUNK_HEIGHT * s;
        pw.addStatic(
            RAPIER.ColliderDesc.cylinder(trunkH / 2, pineTrunkRadius(s))
                .setTranslation(t.x, base + trunkH / 2 - 0.05, t.z)
                .setFriction(0.8),
            false
        );
        for (const tier of PINE_TIERS) {
            const h = tier.h * s;
            pw.addStatic(
                RAPIER.ColliderDesc.cone(h / 2, tier.r * s)
                    .setTranslation(t.x, base + tier.y * s + h / 2, t.z)
                    .setFriction(0.6),
                false
            );
        }
    }

    // rocks: convex hulls of their ellipsoids
    for (const k of layout.rocks) {
        const pts: number[] = [];
        for (let a = 0; a < 10; a++) {
            const th = (a / 10) * Math.PI * 2;
            for (let b = -2; b <= 2; b++) {
                const ph = (b / 2.5) * (Math.PI / 2);
                const lx = Math.cos(ph) * Math.cos(th) * k.rx * 0.95;
                const ly = Math.sin(ph) * k.ry * 0.95;
                const lz = Math.cos(ph) * Math.sin(th) * k.rz * 0.95;
                pts.push(lx, ly, lz);
            }
        }
        pts.push(0, k.ry * 0.95, 0, 0, -k.ry * 0.95, 0);
        const desc = RAPIER.ColliderDesc.convexHull(new Float32Array(pts));
        if (!desc) continue;
        pw.addStatic(
            desc
                .setTranslation(k.x, ground(k.x, k.z) + k.ry * ROCK_CENTRE_LIFT, k.z)
                .setRotation(quatFromYawPitchRoll(k.yaw, 0, 0))
                .setFriction(0.9)
        );
    }

    // static scenery pieces (abutments, shed, saw bench, ...): the same shapes the voxels use
    for (const p of layout.pieces) {
        if (!p.collide) continue;
        const sh = p.shape;
        let d: RAPIER.ColliderDesc;
        if (sh.type === 'box') d = RAPIER.ColliderDesc.cuboid(sh.hx, sh.hy, sh.hz);
        else if (sh.type === 'ellipsoid') d = RAPIER.ColliderDesc.ball(Math.min(sh.rx, sh.ry, sh.rz));
        else {
            d = RAPIER.ColliderDesc.cylinder(sh.half, sh.r);
            const h = Math.SQRT1_2;
            const axisRot =
                sh.axis === 'x'
                    ? { x: 0, y: 0, z: h, w: h }
                    : sh.axis === 'z'
                      ? { x: h, y: 0, z: 0, w: h }
                      : { x: 0, y: 0, z: 0, w: 1 };
            d.setRotation(quatMul(p.pose.q, axisRot));
            pw.addStatic(d.setTranslation(p.pose.p.x, p.pose.p.y, p.pose.p.z).setFriction(0.8));
            continue;
        }
        pw.addStatic(
            d
                .setTranslation(p.pose.p.x, p.pose.p.y, p.pose.p.z)
                .setRotation({ ...p.pose.q })
                .setFriction(0.8)
        );
    }

    // invisible walls around the play area (the Epic 1 walker had the same limits as a clamp)
    const A = level.playArea;
    const H = 6;
    const cx = (A.minX + A.maxX) / 2;
    const cz = (A.minZ + A.maxZ) / 2;
    const hx = (A.maxX - A.minX) / 2;
    const hz = (A.maxZ - A.minZ) / 2;
    pw.addStatic(RAPIER.ColliderDesc.cuboid(hx + 0.5, H, 0.5).setTranslation(cx, 2, A.minZ - 0.5), false);
    pw.addStatic(RAPIER.ColliderDesc.cuboid(hx + 0.5, H, 0.5).setTranslation(cx, 2, A.maxZ + 0.5), false);
    pw.addStatic(RAPIER.ColliderDesc.cuboid(0.5, H, hz + 0.5).setTranslation(A.minX - 0.5, 2, cz), false);
    pw.addStatic(RAPIER.ColliderDesc.cuboid(0.5, H, hz + 0.5).setTranslation(A.maxX + 0.5, 2, cz), false);
    return pw;
}

/** Kinematic colliders for the scripted beaver (origin at its feet) and ute (origin at road level). */
export function addLabKinematics(
    pw: PhysicsWorld,
    beaverId: number,
    uteId: number,
    beaverPose: Pose,
    utePose: Pose
): void {
    pw.addKinematic(
        beaverId,
        [
            {
                shape: { type: 'capsule', half: CHARACTER.half, r: CHARACTER.radius },
                x: 0,
                y: CHARACTER.half + CHARACTER.radius,
                z: 0
            }
        ],
        beaverPose
    );
    // a drivable ute is a vehicle (UteVehicle), not a scripted body
    if (uteId < 0) return;
    pw.addKinematic(
        uteId,
        [
            { shape: { type: 'box', hx: 0.8, hy: 0.32, hz: 1.84 }, x: 0, y: 0.5, z: 0 },
            { shape: { type: 'box', hx: 0.76, hy: 0.3, hz: 0.55 }, x: 0, y: 1.0, z: 0.15 }
        ],
        utePose
    );
}

/** The seven-part dummy, joined by ball joints, disabled until launched. */
export function addDummy(pw: PhysicsWorld, ids: readonly number[]): void {
    const rest = pose();
    for (let n = 0; n < DUMMY_PARTS.length; n++) {
        const p = DUMMY_PARTS[n];
        dummyRestPose(n, -6, -3, 6, 0, rest);
        pw.addDynamic(ids[n], { type: 'box', hx: p.hx, hy: p.hy, hz: p.hz }, rest, {
            density: 400,
            friction: 0.8,
            restitution: 0.05,
            angularDamping: 0.8,
            linearDamping: 0.1
        });
    }
    for (let n = 1; n < DUMMY_PARTS.length; n++) {
        const p = DUMMY_PARTS[n];
        const parent = DUMMY_PARTS[p.parent];
        const a = pw.bodies.get(ids[p.parent])!.body;
        const b = pw.bodies.get(ids[n])!.body;
        const j = pw.world.createImpulseJoint(
            RAPIER.JointData.spherical(
                { x: p.jx - parent.x, y: p.jy - parent.y, z: p.jz - parent.z },
                { x: p.jx - p.x, y: p.jy - p.y, z: p.jz - p.z }
            ),
            a,
            b,
            true
        );
        j.setContactsEnabled(false);
    }
    for (const id of ids) pw.setEnabled(id, false);
}

/** Places and launches the dummy: feet at (x, y, z), thrown along a yaw. */
export function launchDummy(
    pw: PhysicsWorld,
    ids: readonly number[],
    x: number,
    y: number,
    z: number,
    yaw: number,
    speed: number
): void {
    const p = pose();
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    // tumble forward: spin about the right axis
    const spin = { x: Math.cos(yaw) * -4, y: 0.6, z: -Math.sin(yaw) * -4 };
    for (let n = 0; n < ids.length; n++) {
        pw.setEnabled(ids[n], true);
        dummyRestPose(n, x, y, z, yaw + Math.PI, p);
        pw.place(ids[n], p, { x: fx * speed, y: speed * 0.45, z: fz * speed }, spin);
    }
}
