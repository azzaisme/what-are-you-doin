/**
 * The ute as a vehicle (design doc §2.7, Epic 4): a dynamic chassis on four raycast wheels (Rapier's
 * DynamicRayCastVehicleController), with arcade throttle, steering and brakes.
 *
 * Wheels load what holds them up (§2.6, the Epic 4 gate): Rapier pushes only the chassis, so each tick
 * the opposite of every wheel's suspension and friction impulse goes into the dynamic body the wheel
 * stands on (a plank, a beam bridge, a platform), at the contact point.
 *
 * Body origin = the ute asset's root (ground under the chassis, +z forward, +y up); the wheels sit at
 * the asset's wheel centres when the suspension carries its share of the weight.
 */

import type RAPIER from '@dimforge/rapier3d-compat';

import { UTE_TRACK_HALF, UTE_WHEEL_RADIUS, UTE_WHEELBASE_HALF } from '../../assets/ute.ts';
import type { Pose } from '../../voxels/math.ts';
import { SIM_DT } from '../clock.ts';

import { GRAVITY, LAYER, groups } from './world.ts';
import type { PhysBody, PhysicsWorld } from './world.ts';

/** Tuning (SI units). */
export const UTE = {
    /** Wheel hard points above the root, and suspension rest length below them. */
    hardY: 0.55,
    restLength: 0.25,
    maxTravel: 0.2,
    /** Suspension spring and dampers per unit chassis mass (Rapier's convention). */
    stiffness: 60,
    compression: 4.4,
    relaxation: 5.5,
    /** Largest suspension force per wheel (N): about three times its share of the weight. */
    maxSuspension: 6000,
    /** Tyre grip (a friction coefficient: the largest friction impulse per suspension impulse). */
    grip: 1.4,
    /** Engine force (N) shared by the two rear wheels, top speeds (m/s). */
    engine: 3200,
    topSpeed: 10,
    topReverse: 4,
    /** Brake and rolling resistance (largest impulse per wheel per tick, N s). */
    brake: 22,
    rolling: 1.2,
    /** Front wheel lock (rad) at a standstill and at top speed; how fast it turns (rad/s). */
    steerMax: 0.55,
    steerAtTop: 0.2,
    steerRate: 2.4
} as const;

export interface DriveInput {
    /** -1 (reverse) .. 1 (forward). */
    throttle: number;
    /** -1 (left) .. 1 (right). */
    steer: number;
    brake: boolean;
}

export const NO_DRIVE: DriveInput = { throttle: 0, steer: 0, brake: false };

/** Wheel order: front left, front right, rear left, rear right (the ute asset's order). */
const WHEEL_XZ: readonly [number, number][] = [
    [UTE_TRACK_HALF, UTE_WHEELBASE_HALF],
    [-UTE_TRACK_HALF, UTE_WHEELBASE_HALF],
    [UTE_TRACK_HALF, -UTE_WHEELBASE_HALF],
    [-UTE_TRACK_HALF, -UTE_WHEELBASE_HALF]
];

/** What the wheels hit: the ground, props, scripted bodies; never players or held things. */
const WHEEL_FILTER = groups(0xffff, LAYER.static | LAYER.prop | LAYER.kinematic);

export class UteVehicle {
    readonly pb: PhysBody;
    private readonly pw: PhysicsWorld;
    private readonly ctrl: RAPIER.DynamicRayCastVehicleController;
    /** Current front wheel angle (rad, + turns left). */
    steer = 0;
    /** Wheel spin (rad), for the render pose. */
    spin = 0;
    /** Total reaction impulse handed to dynamic bodies under the wheels last tick (N s, debug/tests). */
    lastGroundImpulse = 0;
    /** Ids of the dynamic bodies the wheels stood on last tick (one per wheel, -1 for none). */
    readonly groundIds: number[] = [-1, -1, -1, -1];

    constructor(pw: PhysicsWorld, id: number, spawn: Pose) {
        this.pw = pw;
        // ~760 kg, shaped like the voxel ute (heights above the ground at rest): a lower body with a low
        // ballast (centre of mass ~0.6 m up), the hood, the cab, and an open cargo bed (#44) with a floor,
        // sides and a tailgate, so loads ride in it
        this.pb = pw.addDynamicCompound(
            id,
            [
                // the lower body rides 0.45 m up (the voxel skirts hang lower): a ute clears a beam end
                // or a kerb its wheels can climb
                { shape: { type: 'box', hx: 0.8, hy: 0.215, hz: 1.84 }, x: 0, y: 0.665, z: 0, density: 150 },
                { shape: { type: 'box', hx: 0.6, hy: 0.05, hz: 1.4 }, x: 0, y: 0.5, z: 0, density: 800 },
                { shape: { type: 'box', hx: 0.77, hy: 0.05, hz: 0.55 }, x: 0, y: 0.92, z: 1.24, density: 60 },
                { shape: { type: 'box', hx: 0.76, hy: 0.3, hz: 0.55 }, x: 0, y: 1.18, z: 0.15, density: 60 },
                // the bed: floor (top at 0.97 m), sides and tailgate (top at 1.25 m); the cab closes the front
                { shape: { type: 'box', hx: 0.78, hy: 0.05, hz: 0.7 }, x: 0, y: 0.92, z: -1.1, density: 60 },
                { shape: { type: 'box', hx: 0.05, hy: 0.15, hz: 0.86 }, x: 0.75, y: 1.1, z: -0.94, density: 60 },
                { shape: { type: 'box', hx: 0.05, hy: 0.15, hz: 0.86 }, x: -0.75, y: 1.1, z: -0.94, density: 60 },
                { shape: { type: 'box', hx: 0.8, hy: 0.15, hz: 0.05 }, x: 0, y: 1.1, z: -1.77, density: 60 }
            ],
            spawn,
            // never asleep: its wheels are rays, not contacts, so nothing would wake it when the ground
            // under it moves (a bridge giving way), and Rapier's controller drifts a sleeping chassis
            { friction: 0.5, angularDamping: 0.5, linearDamping: 0.02, canSleep: false }
        );
        const c = pw.world.createVehicleController(this.pb.body);
        c.indexUpAxis = 1;
        c.setIndexForwardAxis = 2;
        for (const [x, z] of WHEEL_XZ) {
            c.addWheel(
                { x, y: UTE.hardY, z },
                { x: 0, y: -1, z: 0 },
                { x: -1, y: 0, z: 0 },
                UTE.restLength,
                UTE_WHEEL_RADIUS
            );
        }
        for (let i = 0; i < 4; i++) {
            c.setWheelMaxSuspensionTravel(i, UTE.maxTravel);
            c.setWheelSuspensionStiffness(i, UTE.stiffness);
            c.setWheelSuspensionCompression(i, UTE.compression);
            c.setWheelSuspensionRelaxation(i, UTE.relaxation);
            c.setWheelMaxSuspensionForce(i, UTE.maxSuspension);
            c.setWheelFrictionSlip(i, UTE.grip);
            c.setWheelSideFrictionStiffness(i, 1);
        }
        this.ctrl = c;
    }

    get id(): number {
        return this.pb.id;
    }

    /** Forward speed (m/s, + forward). */
    speed(): number {
        return this.ctrl.currentVehicleSpeed();
    }

    /** How far each wheel hangs below its loaded rest position (m, + down), for the render pose. */
    wheelDrop(i: number): number {
        const len = this.ctrl.wheelSuspensionLength(i) ?? UTE.restLength;
        // loaded rest: the wheel centre at UTE_WHEEL_RADIUS above the root
        return len - (UTE.hardY - UTE_WHEEL_RADIUS);
    }

    wheelInContact(i: number): boolean {
        return this.ctrl.wheelIsInContact(i);
    }

    /**
     * One tick, before the world steps: steering, engine and brakes from `input`, the suspension and
     * tyres (Rapier), then the reaction into whatever dynamic bodies the wheels stand on.
     */
    drive(input: DriveInput, dt = SIM_DT): void {
        const c = this.ctrl;
        const v = this.speed();
        const throttle = Math.max(-1, Math.min(1, Number.isFinite(input.throttle) ? input.throttle : 0));
        const steerIn = Math.max(-1, Math.min(1, Number.isFinite(input.steer) ? input.steer : 0));
        // steering: less lock at speed, eased towards the wanted angle
        const lock = UTE.steerMax + (UTE.steerAtTop - UTE.steerMax) * Math.min(1, Math.abs(v) / UTE.topSpeed);
        const want = -steerIn * lock;
        const step = UTE.steerRate * dt;
        this.steer += Math.max(-step, Math.min(step, want - this.steer));
        // throttle against the motion brakes first; past a crawl it drives the other way
        const against = (throttle > 0 && v < -0.5) || (throttle < 0 && v > 0.5);
        let force = 0;
        if (!against && throttle !== 0) {
            const top = throttle > 0 ? UTE.topSpeed : UTE.topReverse;
            const fade = Math.max(0, 1 - Math.abs(v) / top);
            force = (throttle * UTE.engine * fade) / 2;
        }
        const brake = input.brake || against ? UTE.brake : throttle === 0 ? UTE.rolling * 2 : UTE.rolling;
        for (let i = 0; i < 4; i++) {
            c.setWheelSteering(i, i < 2 ? this.steer : 0);
            c.setWheelEngineForce(i, i >= 2 ? force : 0);
            c.setWheelBrake(i, brake);
        }
        if (throttle !== 0 || input.brake || Math.abs(steerIn) > 0) this.pb.body.wakeUp();
        // Rapier's controller changes the chassis velocity directly: its change is everything the
        // wheels did to the chassis this tick (gravity comes later, in the world step)
        const body = this.pb.body;
        const v0 = body.linvel();
        c.updateVehicle(dt, undefined, WHEEL_FILTER);
        const v1 = body.linvel();
        const m = body.mass();
        this.spin = 0;
        for (let i = 0; i < 4; i++) this.spin += (c.wheelRotation(i) ?? 0) / 4;
        this.loadGround(m * (v1.x - v0.x), m * (v1.y - v0.y), m * (v1.z - v0.z), dt);
    }

    /**
     * Hands the opposite of the wheels' impulse on the chassis (jx, jy, jz) to the dynamic bodies
     * under them. Each wheel's own suspension impulse is exact; the tyre friction (the rest of the
     * total) is shared between the wheels by their load, as grip is.
     */
    private loadGround(jx: number, jy: number, jz: number, dt: number): void {
        const c = this.ctrl;
        const susp = [0, 0, 0, 0];
        let sx = 0;
        let sy = 0;
        let sz = 0;
        let sum = 0;
        for (let i = 0; i < 4; i++) {
            if (!c.wheelIsInContact(i)) continue;
            const n = c.wheelContactNormal(i);
            if (!n) continue;
            const f = Math.max(0, (c.wheelSuspensionForce(i) ?? 0) * dt);
            susp[i] = f;
            sx += n.x * f;
            sy += n.y * f;
            sz += n.z * f;
            sum += f;
        }
        // tyre friction: what is left of the total after the suspension
        const fx = jx - sx;
        const fy = jy - sy;
        const fz = jz - sz;
        let total = 0;
        for (let i = 0; i < 4; i++) {
            this.groundIds[i] = -1;
            if (susp[i] <= 0) continue;
            const col = c.wheelGroundObject(i);
            const parent = col?.parent();
            if (!col || !parent || !parent.isDynamic()) continue;
            const ground = this.pw.bodyOfCollider(col.handle);
            if (ground) this.groundIds[i] = ground.id;
            const n = c.wheelContactNormal(i)!;
            const p = c.wheelContactPoint(i);
            if (!p) continue;
            const share = susp[i] / sum;
            const ix = -(n.x * susp[i] + fx * share);
            const iy = -(n.y * susp[i] + fy * share);
            const iz = -(n.z * susp[i] + fz * share);
            parent.applyImpulseAtPoint({ x: ix, y: iy, z: iz }, p, true);
            total += Math.hypot(ix, iy, iz);
        }
        this.lastGroundImpulse = total;
    }

    /** The ute's weight (N): what its wheels should put on the ground at rest. */
    weight(): number {
        return this.pb.body.mass() * GRAVITY;
    }
}
