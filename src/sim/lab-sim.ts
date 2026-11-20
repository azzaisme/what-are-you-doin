/**
 * The River Lab simulation: deterministic scripted motion for the test props (no physics yet -
 * Epic 2), plus a command-driven first-person walker and a spring-held plank for the first-person
 * comfort test. Runs only in fixed ticks and publishes snapshots; it never touches the renderer.
 *
 * Commands are plain data (sequenced input), shaped so a network adapter can carry them later.
 */

import type { VoxelAsset } from '../assets/asset.ts';
import { BEAVER_ANIM_CHANNELS, BEAVER_CARRY, BEAVER_HEAD_YAW, BEAVER_WALK_AMOUNT, BEAVER_WALK_PHASE, beaverAsset, beaverLeftHand } from '../assets/beaver.ts';
import { BUCKET_HANDLE_TOP, LOG_RADIUS, bucketAsset, cubeAsset, logAsset, plankAsset, sphereAsset } from '../assets/props.ts';
import { UTE_ANIM_CHANNELS, UTE_PITCH, UTE_ROLL, UTE_STEER, UTE_SUSPENSION, UTE_WHEELBASE_HALF, UTE_WHEEL_RADIUS, UTE_WHEEL_SPIN, uteAsset } from '../assets/ute.ts';
import { BEAVER_LOOP, PLATEAU_Y, UTE_TRACK, groundSurfaceY, terrainHeight } from '../levels/river-lab.ts';
import { composePose, pose, quatFromAxisAngle, quatFromYawPitchRoll, quatMul, quatRotate, quatSlerp, vec3  } from '../voxels/math.ts';
import type { Pose } from '../voxels/math.ts';
import { M } from '../voxels/palette.ts';

import { SIM_DT } from './clock.ts';
import { ANIM_MAX, SnapshotRing, writeEntity } from './snapshots.ts';

export interface SimEntity {
    /** Stable identity, also the voxel object id. */
    id: number;
    name: string;
    asset: VoxelAsset;
    /** Cross-object overlap priority (higher wins). */
    priority: number;
    pose: Pose;
    anim: Float64Array;
    visible: boolean;
    /** Index in snapshot buffers. */
    slot: number;
}

export interface PlayerCommand {
    seq: number;
    /** Desired move in player space: x right, z forward, each -1..1. */
    moveX: number;
    moveZ: number;
    sprint: boolean;
    jump: boolean;
    /** Look yaw/pitch in radians (absolute, from the client's mouse look). */
    yaw: number;
    pitch: number;
    carry: boolean;
}

export const MAX_STRESS = 25;
export const EYE_HEIGHT = 1.22;

export class LabSim {
    readonly entities: SimEntity[] = [];
    readonly ring: SnapshotRing;
    tick = 0;
    stressCount = 0;
    fpActive = false;

    // scripted state
    private beaverDist = 0;
    private beaverTheta = 0;
    private uteTheta = 0;
    private uteSpin = 0;

    // player state
    readonly player = { x: 0, y: 0.5, z: 6.5, vy: 0, yaw: 0, pitch: 0, grounded: true };
    private lastCmd: PlayerCommand = { seq: 0, moveX: 0, moveZ: 0, sprint: false, jump: false, yaw: 0, pitch: 0, carry: false };
    private heldInit = false;

    readonly beaver: SimEntity;
    readonly bucket: SimEntity;
    readonly ute: SimEntity;
    readonly plank: SimEntity;
    readonly log: SimEntity;
    readonly cube: SimEntity;
    readonly sphere: SimEntity;
    readonly held: SimEntity;
    readonly stress: SimEntity[] = [];
    /** Not voxelized: carries the walker's pose through the snapshot ring for interpolation. */
    readonly playerEntity: SimEntity;

    constructor() {
        this.beaver = this.add(1, 'beaver', beaverAsset, 3);
        this.bucket = this.add(2, 'bucket', bucketAsset(), 4);
        this.ute = this.add(3, 'ute', uteAsset, 2);
        this.plank = this.add(4, 'plank', plankAsset(), 1);
        this.log = this.add(5, 'log', logAsset(), 1);
        this.cube = this.add(6, 'cube', cubeAsset(), 1);
        this.sphere = this.add(7, 'sphere', sphereAsset(), 1);
        this.held = this.add(8, 'held-plank', plankAsset('held-plank'), 5);
        for (let n = 0; n < MAX_STRESS; n++) {
            const kind = n % 3;
            const asset = kind === 0 ? plankAsset(`stress-plank-${n}`) : kind === 1 ? cubeAsset(0.4, n % 2 ? M.TestBlue : M.TestOrange) : logAsset();
            this.stress.push(this.add(100 + n, `stress-${n}`, asset, 0));
        }
        this.playerEntity = this.add(900, 'player', EMPTY_ASSET, 0);
        this.ring = new SnapshotRing(this.entities.length, 32);
        this.reset();
    }

    private add(id: number, name: string, asset: VoxelAsset, priority: number): SimEntity {
        if (asset.animChannels > ANIM_MAX) throw new Error(`${name}: too many animation channels`);
        const e: SimEntity = { id, name, asset, priority, pose: pose(), anim: new Float64Array(ANIM_MAX), visible: true, slot: this.entities.length };
        this.entities.push(e);
        return e;
    }

    reset(): void {
        this.tick = 0;
        this.beaverDist = 0;
        this.beaverTheta = 0;
        this.uteTheta = 0;
        this.uteSpin = 0;
        this.heldInit = false;
        this.ring.clear();
        this.evaluate();
        this.publish();
    }

    /** Runs the simulation up to (at least) a tick, for deterministic seeking. */
    runTo(tick: number): void {
        if (tick < this.tick) this.reset();
        while (this.tick < tick) this.step(this.lastCmd);
    }

    step(cmd: PlayerCommand): void {
        this.lastCmd = cmd;
        this.tick++;
        this.integrate(cmd);
        this.evaluate();
        this.publish();
    }

    get time(): number {
        return this.tick * SIM_DT;
    }

    // ------------------------------------------------------------------------------- integrate

    private integrate(cmd: PlayerCommand): void {
        const dt = SIM_DT;
        const t = this.tick * dt;

        // beaver: walks 7.5 s, pauses 2.5 s to look around, repeats
        const amount = beaverWalkAmount(t);
        const speed = 0.72 * amount;
        this.beaverDist += speed * dt;
        this.beaverTheta += (speed / BEAVER_LOOP.r) * dt;

        // ute: varying speed around its oval, integrated in arc length
        const v = 2.0 + 0.7 * Math.sin(t * 0.31);
        const dpdtheta = Math.hypot(UTE_TRACK.rx * Math.sin(this.uteTheta), UTE_TRACK.rz * Math.cos(this.uteTheta));
        this.uteTheta += (v / dpdtheta) * dt;
        this.uteSpin += (v / UTE_WHEEL_RADIUS) * dt;

        // first-person walker (camera control for Epic 1; not physics)
        const p = this.player;
        p.yaw = cmd.yaw;
        p.pitch = cmd.pitch;
        if (this.fpActive) {
            const run = cmd.sprint ? 4.2 : 2.2;
            let mx = cmd.moveX;
            let mz = cmd.moveZ;
            const len = Math.hypot(mx, mz);
            if (len > 1) {
                mx /= len;
                mz /= len;
            }
            // camera looks along -Z at yaw 0 (engine convention); forward = (-sin yaw, -cos yaw)
            const fx = -Math.sin(p.yaw);
            const fz = -Math.cos(p.yaw);
            const rx = Math.cos(p.yaw);
            const rz = -Math.sin(p.yaw);
            p.x += (fx * mz + rx * mx) * run * dt;
            p.z += (fz * mz + rz * mx) * run * dt;
            p.x = Math.max(-26, Math.min(26, p.x));
            p.z = Math.max(-20, Math.min(13, p.z));
            const ground = Math.max(terrainHeight(p.x, p.z), -0.62);
            if (p.grounded && cmd.jump) {
                p.vy = 4.2;
                p.grounded = false;
            }
            p.vy -= 12 * dt;
            p.y += p.vy * dt;
            if (p.y <= ground) {
                // step-up is smoothed so stepped terrain does not jolt the camera
                p.y = p.grounded ? p.y + (ground - p.y) * Math.min(1, dt * 14) : ground;
                if (ground - p.y < 0.01) p.y = ground;
                p.vy = 0;
                p.grounded = true;
            } else if (p.grounded && p.y - ground < 0.35) {
                p.y += (ground - p.y) * Math.min(1, dt * 14);
                p.vy = 0;
            } else {
                p.grounded = false;
            }
        }
    }

    // ------------------------------------------------------------------------------- evaluate

    private evaluate(): void {
        const t = this.tick * SIM_DT;

        // ---- beaver + bucket
        {
            const b = this.beaver;
            const th = this.beaverTheta;
            const x = BEAVER_LOOP.cx + BEAVER_LOOP.r * Math.cos(th);
            const z = BEAVER_LOOP.cz + BEAVER_LOOP.r * Math.sin(th);
            const dx = -Math.sin(th);
            const dz = Math.cos(th);
            b.pose.p.x = x;
            b.pose.p.y = PLATEAU_Y;
            b.pose.p.z = z;
            quatFromYawPitchRoll(Math.atan2(dx, dz), 0, 0, b.pose.q);
            const amount = beaverWalkAmount(t);
            b.anim[BEAVER_WALK_PHASE] = (this.beaverDist / 0.95) * Math.PI * 2;
            b.anim[BEAVER_WALK_AMOUNT] = amount;
            b.anim[BEAVER_CARRY] = 1;
            b.anim[BEAVER_HEAD_YAW] = (1 - amount) * 0.55 * Math.sin(t * 1.7);
            b.visible = true;

            const hand = beaverLeftHand(b.pose, b.anim, _hand);
            const swing = 0.16 * amount * Math.sin(b.anim[BEAVER_WALK_PHASE] + 0.9) + 0.03 * Math.sin(t * 2.3);
            const yaw = Math.atan2(dx, dz);
            quatFromYawPitchRoll(yaw, swing, 0.05 * Math.sin(t * 1.3), _q);
            // hang the bucket from its handle top at the hand
            quatRotate(_q, 0, BUCKET_HANDLE_TOP - 0.02, 0, _v);
            const bk = this.bucket;
            bk.pose.p.x = hand.p.x - _v.x;
            bk.pose.p.y = Math.max(PLATEAU_Y + 0.02, hand.p.y - _v.y);
            bk.pose.p.z = hand.p.z - _v.z;
            bk.pose.q.x = _q.x;
            bk.pose.q.y = _q.y;
            bk.pose.q.z = _q.z;
            bk.pose.q.w = _q.w;
            bk.visible = true;
        }

        // ---- ute on its oval
        {
            const u = this.ute;
            const th = this.uteTheta;
            const tr = UTE_TRACK;
            const x = tr.cx + tr.rx * Math.cos(th);
            const z = tr.cz + tr.rz * Math.sin(th);
            const dx = -tr.rx * Math.sin(th);
            const dz = tr.rz * Math.cos(th);
            const ddx = -tr.rx * Math.cos(th);
            const ddz = -tr.rz * Math.sin(th);
            const speed2 = dx * dx + dz * dz;
            const curvature = (dx * ddz - dz * ddx) / Math.pow(speed2, 1.5);
            const v = 2.0 + 0.7 * Math.sin(t * 0.31);
            u.pose.p.x = x;
            u.pose.p.y = PLATEAU_Y + 0.002;
            u.pose.p.z = z;
            quatFromYawPitchRoll(Math.atan2(dx, dz), 0, 0, u.pose.q);
            u.anim[UTE_WHEEL_SPIN] = this.uteSpin;
            u.anim[UTE_STEER] = -Math.atan(2 * UTE_WHEELBASE_HALF * curvature);
            u.anim[UTE_SUSPENSION] = 0.012 * Math.sin(t * 7.1) + 0.008 * Math.sin(t * 11.3);
            u.anim[UTE_PITCH] = 0.012 * Math.sin(t * 0.31 + 1.4);
            u.anim[UTE_ROLL] = Math.max(-0.07, Math.min(0.07, -curvature * v * v * 0.035));
            u.visible = true;
        }

        // ---- plank: a hovering specimen, translating and continuously rotating
        {
            const p = this.plank;
            p.pose.p.x = 0.4 + 1.5 * Math.sin(t * 0.33);
            p.pose.p.y = 1.55 + 0.25 * Math.sin(t * 0.71);
            p.pose.p.z = -3.4 + 0.3 * Math.sin(t * 0.23);
            quatFromAxisAngle(0.35, 1, 0.22, t * 0.62, _q);
            quatFromAxisAngle(1, 0, 0, t * 0.41, _q2);
            quatMul(_q, _q2, p.pose.q);
            p.visible = true;
        }

        // ---- log: rolls back and forth (no slip: angle = -x / r), axis along Z
        {
            const l = this.log;
            const x = 0.9 + 1.25 * Math.sin(t * 0.45);
            l.pose.p.x = x;
            l.pose.p.y = PLATEAU_Y + LOG_RADIUS;
            l.pose.p.z = -5.7;
            quatFromAxisAngle(0, 1, 0, Math.PI / 2 + 0.12 * Math.sin(t * 0.3), _q);
            quatFromAxisAngle(1, 0, 0, x / LOG_RADIUS, _q2);
            quatMul(_q, _q2, l.pose.q);
            l.visible = true;
        }

        // ---- cube: slides diagonally on the near bank while turning
        {
            const c = this.cube;
            const s = 0.5 + 0.5 * Math.sin(t * 0.4);
            const x = -3.4 + 3.6 * s;
            const z = 3.1 + 1.6 * s;
            c.pose.p.x = x;
            c.pose.p.z = z;
            c.pose.p.y = groundSurfaceY(x, z) + 0.25 + 0.001;
            quatFromAxisAngle(0, 1, 0, t * 0.7, c.pose.q);
            c.visible = true;
        }

        // ---- sphere: bounces and rolls
        {
            const s = this.sphere;
            const x = 3.2 + 0.9 * Math.sin(t * 0.37);
            const z = 3.6;
            s.pose.p.x = x;
            s.pose.p.z = z;
            s.pose.p.y = groundSurfaceY(x, z) + 0.3 + 0.9 * Math.abs(Math.sin(t * 2.1));
            quatFromAxisAngle(0, 0, 1, -x / 0.3, s.pose.q);
            s.visible = true;
        }

        // ---- stress objects orbit above the river
        for (let n = 0; n < this.stress.length; n++) {
            const e = this.stress[n];
            e.visible = n < this.stressCount;
            if (!e.visible) continue;
            const ring = n % 5;
            const r = 4 + ring * 1.4;
            const w = 0.18 + 0.05 * (n % 4);
            const a = t * w + n * 2.399;
            e.pose.p.x = Math.cos(a) * r;
            e.pose.p.y = 2.3 + 0.6 * Math.sin(t * 0.5 + n) + (n % 3) * 0.7;
            e.pose.p.z = -1.5 + Math.sin(a) * r * 0.55;
            quatFromYawPitchRoll(t * (0.5 + 0.03 * n), t * (0.3 + 0.02 * n), n, e.pose.q);
        }

        // ---- held plank: damped spring towards a carry pose in front of the player
        {
            const h = this.held;
            const pl = this.player;
            const carry = this.fpActive && this.lastCmd.carry;
            h.visible = carry;
            if (carry) {
                const eyeY = pl.y + EYE_HEIGHT;
                quatFromYawPitchRoll(pl.yaw, 0, 0, _q);
                _target.p.x = pl.x;
                _target.p.y = eyeY;
                _target.p.z = pl.z;
                _target.q.x = _q.x;
                _target.q.y = _q.y;
                _target.q.z = _q.z;
                _target.q.w = _q.w;
                // carried across the body, 1.3 m ahead and 0.45 m below the eye, slightly tilted
                _offset.p.x = 0;
                _offset.p.y = -0.45 + 0.4 * Math.max(-0.6, Math.min(0.6, pl.pitch));
                _offset.p.z = -1.3;
                quatFromYawPitchRoll(0, 0.25, 0, _offset.q);
                composePose(_target, _offset, _target);
                if (!this.heldInit) {
                    h.pose.p.x = _target.p.x;
                    h.pose.p.y = _target.p.y;
                    h.pose.p.z = _target.p.z;
                    h.pose.q.x = _target.q.x;
                    h.pose.q.y = _target.q.y;
                    h.pose.q.z = _target.q.z;
                    h.pose.q.w = _target.q.w;
                    this.heldInit = true;
                } else {
                    const k = 1 - Math.exp(-SIM_DT * 16);
                    h.pose.p.x += (_target.p.x - h.pose.p.x) * k;
                    h.pose.p.y += (_target.p.y - h.pose.p.y) * k;
                    h.pose.p.z += (_target.p.z - h.pose.p.z) * k;
                    quatSlerp(h.pose.q, _target.q, 1 - Math.exp(-SIM_DT * 12), h.pose.q);
                }
            } else {
                this.heldInit = false;
            }
        }
    }

    private publishPlayer(): void {
        const e = this.playerEntity;
        e.pose.p.x = this.player.x;
        e.pose.p.y = this.player.y + EYE_HEIGHT;
        e.pose.p.z = this.player.z;
        e.visible = this.fpActive;
    }

    private publish(): void {
        this.publishPlayer();
        const buf = this.ring.beginWrite(this.tick);
        for (const e of this.entities) writeEntity(buf, e.slot, e.pose, e.visible, e.anim, ANIM_MAX);
    }

    /** Places the walker (e.g. when entering first-person mode). */
    placePlayer(x: number, z: number, yaw: number): void {
        const p = this.player;
        p.x = x;
        p.z = z;
        p.y = Math.max(terrainHeight(x, z), -0.62);
        p.vy = 0;
        p.yaw = yaw;
        p.grounded = true;
        this.lastCmd = { ...this.lastCmd, yaw };
    }
}

export function beaverWalkAmount(t: number): number {
    const cycle = 10;
    const u = ((t % cycle) + cycle) % cycle;
    const ramp = 0.45;
    if (u < ramp) return smooth(u / ramp);
    if (u < 7.5 - ramp) return 1;
    if (u < 7.5) return smooth((7.5 - u) / ramp);
    return 0;
}

function smooth(x: number): number {
    return x * x * (3 - 2 * x);
}

const EMPTY_ASSET: VoxelAsset = {
    schema: 1,
    name: 'empty',
    parts: [],
    animChannels: 0,
    evaluate() {
        // no parts to pose
    }
};

const _hand = pose();
const _q = { x: 0, y: 0, z: 0, w: 1 };
const _q2 = { x: 0, y: 0, z: 0, w: 1 };
const _v = vec3();
const _target = pose();
const _offset = pose();

export { BEAVER_ANIM_CHANNELS, UTE_ANIM_CHANNELS };
