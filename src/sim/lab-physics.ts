/**
 * River Lab physics content (Epic 2): static terrain, trees, rocks and boundary walls; kinematic
 * colliders following the scripted beaver and ute; dynamic props, the ragdoll dummy and stress
 * bodies. Built from the analytic level description (never from voxels), engine-free.
 */

import RAPIER from '@dimforge/rapier3d-compat';

import { DUMMY_PARTS, dummyRestPose } from '../assets/dummy.ts';
import { BUCKET_HEIGHT, LOG_RADIUS } from '../assets/props.ts';
import { LAB_MAX_X, LAB_MAX_Z, LAB_MIN_X, LAB_MIN_Z, PINE_TIERS, PINE_TRUNK_HEIGHT, ROCK_CENTRE_LIFT, labLayout, pineTrunkRadius, terrainHeight } from '../levels/river-lab.ts';
import { pose, quatFromYawPitchRoll } from '../voxels/math.ts';
import type { Pose } from '../voxels/math.ts';

import { CHARACTER, PhysicsWorld } from './physics/world.ts';
import type { BodyOptions, ShapeSpec } from './physics/world.ts';

/** Player-reachable area (the Epic 1 walker clamp, now as walls). */
export const PLAY_AREA = { minX: -26, maxX: 26, minZ: -20, maxZ: 13 };
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

const ground = (x: number, z: number) => terrainHeight(x, z);

/** Physics props on the near bank, in front of where first-person play starts. */
export function labPropDefs(ids: { plank: number; log: number; cube: number; sphere: number; bucket: number; heldPlank: number }): PropDef[] {
    const at = (x: number, z: number, lift: number, yaw = 0, pitch = 0, roll = 0) => pose(x, ground(x, z) + lift, z, quatFromYawPitchRoll(yaw, pitch, roll));
    return [
        // 2.4 x 0.2 x 0.1 m pine plank, ~24 kg
        { id: ids.plank, shape: { type: 'box', hx: 1.2, hy: 0.1, hz: 0.05 }, opts: { density: 500, friction: 0.7, restitution: 0.1, ccd: true }, spawn: at(0.6, 3.6, 0.08, 0.35, Math.PI / 2) },
        // 2 m log, r 0.2 m, ~113 kg: too heavy to lift alone, can be dragged and rolled
        { id: ids.log, shape: { type: 'cylinder', axis: 'x', r: LOG_RADIUS, half: 1.0 }, opts: { density: 450, friction: 0.8, restitution: 0.05, angularDamping: 0.4 }, spawn: at(-1.6, 3.2, LOG_RADIUS + 0.03, 0.1) },
        // 0.5 m crate, ~25 kg
        { id: ids.cube, shape: { type: 'box', hx: 0.25, hy: 0.25, hz: 0.25 }, opts: { density: 200, friction: 0.7, restitution: 0.1 }, spawn: at(-3.2, 4.4, 0.27, 0.5) },
        // 0.3 m bouncy ball, ~2.3 kg
        { id: ids.sphere, shape: { type: 'ball', r: 0.3 }, opts: { density: 20, friction: 0.6, restitution: 0.78, angularDamping: 0.1, ccd: true }, spawn: at(2.8, 3.9, 0.9) },
        // empty ~10 L bucket proxy, ~1.5 kg (water arrives in Epic 7); origin at its base
        { id: ids.bucket, shape: { type: 'cylinder', axis: 'y', r: 0.15, half: BUCKET_HEIGHT / 2, offsetY: BUCKET_HEIGHT / 2 }, opts: { density: 70, friction: 0.6, restitution: 0.1, ccd: true }, spawn: at(1.6, 4.8, 0.02) },
        // the first-person carry plank (G): parked until summoned into the player's grip
        { id: ids.heldPlank, shape: { type: 'box', hx: 1.2, hy: 0.1, hz: 0.05 }, opts: { density: 500, friction: 0.7, restitution: 0.1, ccd: true }, spawn: at(-5, 6, 0.08, 0, Math.PI / 2) }
    ];
}

const STRESS_SHAPES: { shape: ShapeSpec; opts: BodyOptions }[] = [
    { shape: { type: 'box', hx: 1.2, hy: 0.1, hz: 0.05 }, opts: { density: 500, ccd: true } },
    { shape: { type: 'box', hx: 0.2, hy: 0.2, hz: 0.2 }, opts: { density: 250 } },
    { shape: { type: 'cylinder', axis: 'x', r: LOG_RADIUS, half: 1.0 }, opts: { density: 450 } }
];

/** Stress body kinds match the scripted stress assets: plank, 0.4 m cube, log. */
export function stressDef(id: number, n: number): PropDef {
    const k = STRESS_SHAPES[n % 3];
    const col = n % 5;
    const row = Math.floor(n / 5);
    const x = -4 + col * 2.1;
    const z = 1.5 + row * 1.1;
    return { id, shape: k.shape, opts: k.opts, spawn: pose(x, Math.max(ground(x, z), 0) + 2.5 + (n % 3) * 0.8, z, quatFromYawPitchRoll(n * 0.7, n * 0.3, n * 1.1)) };
}

export function buildLabPhysics(): PhysicsWorld {
    const pw = new PhysicsWorld();
    pw.addTerrain(ground, LAB_MIN_X, LAB_MAX_X, LAB_MIN_Z, LAB_MAX_Z, TERRAIN_CELLS);

    // trees: trunk cylinder plus the four needle cones (the same layout the voxel build uses)
    const layout = labLayout(1);
    for (const t of layout.trees) {
        if (t.x < LAB_MIN_X || t.x > LAB_MAX_X || t.z < LAB_MIN_Z || t.z > LAB_MAX_Z) continue;
        const base = ground(t.x, t.z);
        const s = t.scale;
        const trunkH = PINE_TRUNK_HEIGHT * s;
        pw.addStatic(RAPIER.ColliderDesc.cylinder(trunkH / 2, pineTrunkRadius(s)).setTranslation(t.x, base + trunkH / 2 - 0.05, t.z).setFriction(0.8));
        for (const tier of PINE_TIERS) {
            const h = tier.h * s;
            pw.addStatic(RAPIER.ColliderDesc.cone(h / 2, tier.r * s).setTranslation(t.x, base + tier.y * s + h / 2, t.z).setFriction(0.6));
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

    // invisible walls around the play area (the Epic 1 walker had the same limits as a clamp)
    const A = PLAY_AREA;
    const H = 6;
    const cx = (A.minX + A.maxX) / 2;
    const cz = (A.minZ + A.maxZ) / 2;
    const hx = (A.maxX - A.minX) / 2;
    const hz = (A.maxZ - A.minZ) / 2;
    pw.addStatic(RAPIER.ColliderDesc.cuboid(hx + 0.5, H, 0.5).setTranslation(cx, 2, A.minZ - 0.5));
    pw.addStatic(RAPIER.ColliderDesc.cuboid(hx + 0.5, H, 0.5).setTranslation(cx, 2, A.maxZ + 0.5));
    pw.addStatic(RAPIER.ColliderDesc.cuboid(0.5, H, hz + 0.5).setTranslation(A.minX - 0.5, 2, cz));
    pw.addStatic(RAPIER.ColliderDesc.cuboid(0.5, H, hz + 0.5).setTranslation(A.maxX + 0.5, 2, cz));
    return pw;
}

/** Kinematic colliders for the scripted beaver (origin at its feet) and ute (origin at road level). */
export function addLabKinematics(pw: PhysicsWorld, beaverId: number, uteId: number, beaverPose: Pose, utePose: Pose): void {
    pw.addKinematic(beaverId, [{ shape: { type: 'capsule', half: CHARACTER.half, r: CHARACTER.radius }, x: 0, y: CHARACTER.half + CHARACTER.radius, z: 0 }], beaverPose);
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
        pw.addDynamic(ids[n], { type: 'box', hx: p.hx, hy: p.hy, hz: p.hz }, rest, { density: 400, friction: 0.8, restitution: 0.05, angularDamping: 0.8, linearDamping: 0.1 });
    }
    for (let n = 1; n < DUMMY_PARTS.length; n++) {
        const p = DUMMY_PARTS[n];
        const parent = DUMMY_PARTS[p.parent];
        const a = pw.bodies.get(ids[p.parent])!.body;
        const b = pw.bodies.get(ids[n])!.body;
        const j = pw.world.createImpulseJoint(RAPIER.JointData.spherical({ x: p.jx - parent.x, y: p.jy - parent.y, z: p.jz - parent.z }, { x: p.jx - p.x, y: p.jy - p.y, z: p.jz - p.z }), a, b, true);
        j.setContactsEnabled(false);
    }
    for (const id of ids) pw.setEnabled(id, false);
}

/** Places and launches the dummy: feet at (x, y, z), thrown along a yaw. */
export function launchDummy(pw: PhysicsWorld, ids: readonly number[], x: number, y: number, z: number, yaw: number, speed: number): void {
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
