/**
 * The River Lab simulation (Epic 2): a Rapier physics world (static terrain, trees, rocks; dynamic
 * props, a ragdoll dummy and stress bodies; kinematic colliders for the scripted beaver and ute) and
 * a command-driven first-person character with grab / release / throw. The Epic 1 scripted prop
 * motion stays available as a mode (`props: 'scripted'`) for visual comparisons.
 *
 * Runs only in fixed ticks and publishes snapshots; it never touches the renderer, and nothing from
 * the renderer or the voxel grid flows back in. Commands are plain sequenced data (commands.ts) and
 * are sanitized before use, so a network adapter can carry them later.
 *
 * Rapier must be initialized (await initPhysics()) before constructing a LabSim.
 */

import { BEAVER_ANIM_CHANNELS, BEAVER_CARRY, BEAVER_HEAD_YAW, BEAVER_WALK_AMOUNT, BEAVER_WALK_PHASE, beaverLeftHand } from '../assets/beaver.ts';
import { BUCKET_HANDLE_TOP, LOG_RADIUS } from '../assets/props.ts';
import { UTE_ANIM_CHANNELS, UTE_PITCH, UTE_ROLL, UTE_STEER, UTE_SUSPENSION, UTE_WHEELBASE_HALF, UTE_WHEEL_RADIUS, UTE_WHEEL_SPIN } from '../assets/ute.ts';
import type { LevelDef } from '../levels/level.ts';
import { BEAVER_LOOP, PLATEAU_Y, UTE_TRACK, groundSurfaceY, riverLabLevel } from '../levels/river-lab.ts';
import { composePose, pose, quatFromAxisAngle, quatFromYawPitchRoll, quatMul, quatRotate, quatSlerp, vec3  } from '../voxels/math.ts';

import { SIM_DT } from './clock.ts';
import { ACTION_DROP, ACTION_DROP_TEST, ACTION_RAGDOLL, ACTION_RESET_PROPS, neutralCommand, sanitizeCommand } from './commands.ts';
import type { PlayerCommand } from './commands.ts';
import { MAX_STRESS, createLabEntities } from './lab-entities.ts';
import type { SimEntity } from './lab-entities.ts';
import { addDummy, addLabKinematics, buildLabPhysics, launchDummy, propBody, stressDef } from './lab-physics.ts';
import { CHARACTER } from './physics/world.ts';
import type { PhysicsWorld } from './physics/world.ts';
import { ANIM_MAX, SnapshotRing, writeEntity } from './snapshots.ts';


export type { PlayerCommand, SimEntity };
export { MAX_STRESS };
export type PropsMode = 'physics' | 'scripted';

export const EYE_HEIGHT = 1.22;
/** Stress bodies get a deterministic upward kick this often (ticks), so 25 bodies keep moving. */
export const STRESS_KICK_TICKS = 150;

export interface LabSimOptions {
    props?: PropsMode;
    /** The level to simulate (default: the River Lab test scene). */
    level?: LevelDef;
}

/** Something the player should be told (objective reached, fell in the creek, ...). */
export interface SimEvent {
    tick: number;
    kind: 'goal' | 'fell' | 'recovered';
    text: string;
}

export class LabSim {
    readonly entities: SimEntity[];
    readonly ring: SnapshotRing;
    tick = 0;
    stressCount = 0;
    fpActive = false;
    propsMode: PropsMode;
    /** The Rapier world; rebuilt on reset so replays are deterministic. */
    physics!: PhysicsWorld;
    /** Wall time of the last fixed tick's physics work (ms), for the debug panel. */
    physicsMs = 0;

    // scripted state
    private beaverDist = 0;
    private beaverTheta = 0;
    private uteTheta = 0;
    private uteSpin = 0;

    // player state (feet position; `eyeLift` smooths step-ups for the camera)
    readonly player = { x: 0, y: 0.5, z: 6.5, vy: 0, yaw: 0, pitch: 0, grounded: true, eyeLift: 0 };
    private lastCmd: PlayerCommand = neutralCommand();
    private heldInit = false;
    private prevCarry = false;
    private prevFp = false;
    /** Ticks at which stress bodies were enabled (their kick schedule starts there). */
    private readonly stressEnabled = new Int32Array(MAX_STRESS).fill(-1);

    readonly beaver: SimEntity;
    readonly bucket: SimEntity;
    readonly ute: SimEntity;
    readonly plank: SimEntity;
    readonly log: SimEntity;
    readonly cube: SimEntity;
    readonly sphere: SimEntity;
    readonly held: SimEntity;
    readonly stress: SimEntity[];
    readonly dummy: SimEntity[];
    readonly extras: SimEntity[];
    readonly level: LevelDef;
    /** Level progress (rules): the objective, once reached, stays reached until reset. */
    readonly progress = { goalReached: false, goalTick: -1, falls: 0, recoveries: 0 };
    /** Events since reset, newest last (the client shows them as toasts). */
    readonly events: SimEvent[] = [];
    private safeSpot = { x: 0, y: 0, z: 0, valid: false };
    private fallTicks = 0;
    private lostTicks = 0;
    private goalTicks = 0;
    /** Not voxelized: carries the walker's pose through the snapshot ring for interpolation. */
    readonly playerEntity: SimEntity;

    constructor(opts: LabSimOptions = {}) {
        this.level = opts.level ?? riverLabLevel;
        this.propsMode = this.level.scriptedProps ? (opts.props ?? 'physics') : 'physics';
        const c = createLabEntities();
        this.entities = c.entities;
        this.beaver = c.beaver;
        this.bucket = c.bucket;
        this.ute = c.ute;
        this.plank = c.plank;
        this.log = c.log;
        this.cube = c.cube;
        this.sphere = c.sphere;
        this.held = c.held;
        this.stress = c.stress;
        this.dummy = c.dummy;
        this.extras = c.extras;
        this.playerEntity = c.player;
        const sp = this.level.spawn;
        this.player.x = sp.x;
        this.player.z = sp.z;
        this.player.y = this.level.terrainHeight(sp.x, sp.z);
        this.player.yaw = sp.yaw;
        this.ring = new SnapshotRing(this.entities.length, 32);
        this.reset();
    }

    reset(): void {
        this.tick = 0;
        this.beaverDist = 0;
        this.beaverTheta = 0;
        this.uteTheta = 0;
        this.uteSpin = 0;
        this.heldInit = false;
        this.prevCarry = false;
        this.stressEnabled.fill(-1);
        Object.assign(this.progress, { goalReached: false, goalTick: -1, falls: 0, recoveries: 0 });
        this.events.length = 0;
        this.fallTicks = this.lostTicks = this.goalTicks = 0;
        this.ring.clear();
        this.evaluate();
        this.buildPhysics();
        this.readPhysics();
        this.publish();
    }

    /** Switches between physics props and the Epic 1 scripted props (resets the scene). */
    setPropsMode(mode: PropsMode): void {
        if (mode === this.propsMode || !this.level.scriptedProps) return;
        this.propsMode = mode;
        this.reset();
    }

    get physicsProps(): boolean {
        return this.propsMode === 'physics';
    }

    /** Physics-driven props (everything dynamic), in a fixed order. */
    private get propEntities(): SimEntity[] {
        return [this.plank, this.log, this.cube, this.sphere, this.bucket, this.held, ...this.extras, ...this.stress, ...this.dummy];
    }

    private buildPhysics(): void {
        this.physics?.free();
        const pw = buildLabPhysics(this.level);
        addLabKinematics(pw, this.beaver.id, this.ute.id, this.beaver.pose, this.ute.pose);
        if (this.physicsProps) {
            // the level places its props by entity name; entities it does not place stay hidden
            for (const placement of this.level.props) {
                const e = this.entities.find((x) => x.name === placement.name);
                const body = propBody(placement.name);
                if (e && body) pw.addDynamic(e.id, body.shape, placement.pose, body.opts);
            }
            pw.setEnabled(this.held.id, false);
            for (const e of [this.plank, this.log, this.cube, this.sphere, this.bucket, ...this.extras]) if (!pw.bodies.has(e.id)) e.visible = false;
            for (let n = 0; n < this.stress.length; n++) {
                const d = stressDef(this.level, this.stress[n].id, n);
                pw.addDynamic(d.id, d.shape, d.spawn, d.opts);
                pw.setEnabled(d.id, false);
            }
            addDummy(
                pw,
                this.dummy.map((e) => e.id)
            );
        }
        const p = this.player;
        pw.createCharacter(p.x, p.y, p.z);
        pw.setCharacterEnabled(this.fpActive);
        this.physics = pw;
    }

    /** Runs the simulation up to (at least) a tick, for deterministic seeking. */
    runTo(tick: number): void {
        if (tick < this.tick) this.reset();
        // replay holds the look and carry state but repeats no edge-triggered request
        const c = this.lastCmd;
        while (this.tick < tick) this.step({ ...neutralCommand(c.seq, c.yaw, c.pitch), carry: c.carry });
    }

    step(input: PlayerCommand): void {
        const cmd = sanitizeCommand(input);
        this.lastCmd = cmd;
        this.tick++;
        this.integrate(cmd);
        this.evaluate();
        this.stepPhysics(cmd);
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

        this.player.yaw = cmd.yaw;
        this.player.pitch = cmd.pitch;
    }

    // ------------------------------------------------------------------------------- physics

    private stepPhysics(cmd: PlayerCommand): void {
        const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const pw = this.physics;
        const p = this.player;
        // kinematic colliders follow this tick's scripted poses
        pw.setKinematicTarget(this.beaver.id, this.beaver.pose);
        pw.setKinematicTarget(this.ute.id, this.ute.pose);

        if (this.fpActive !== this.prevFp) {
            pw.setCharacterEnabled(this.fpActive);
            if (!this.fpActive) this.prevCarry = false;
            this.prevFp = this.fpActive;
        }

        if (this.fpActive) {
            const run = cmd.sprint ? CHARACTER.run : CHARACTER.walk;
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
            pw.moveCharacter((fx * mz + rx * mx) * run, (fz * mz + rz * mx) * run, cmd.jump);
            const c = pw.character;
            // smooth step-ups (and only step-ups) for the camera
            const dy = c.y - p.y;
            p.eyeLift = c.grounded && dy > 0.04 && dy < CHARACTER.stepHeight + 0.05 ? p.eyeLift - dy : p.eyeLift;
            p.eyeLift *= Math.exp(-SIM_DT * 14);
            if (Math.abs(p.eyeLift) < 1e-4) p.eyeLift = 0;
            p.x = c.x;
            p.y = c.y;
            p.z = c.z;
            p.vy = c.vy;
            p.grounded = c.grounded;

            if (this.physicsProps) {
                // carry (G): the rising edge puts the carry plank in your grip, the falling edge drops it
                if (cmd.carry && !this.prevCarry) this.summonCarryPlank();
                else if (!cmd.carry && this.prevCarry && pw.heldId === this.held.id) pw.release();
                this.prevCarry = cmd.carry;
                if (cmd.reach) pw.adjustHold(cmd.reach);
                const eye = { x: p.x, y: p.y + EYE_HEIGHT, z: p.z };
                if (cmd.action === ACTION_DROP) pw.release();
                if (cmd.throw) pw.throwHeld(cmd.yaw, cmd.pitch);
                else if (cmd.grab) {
                    if (pw.heldId >= 0) pw.release();
                    else pw.tryGrab(eye, cmd.yaw, cmd.pitch);
                }
                pw.applyGrab(eye, cmd.yaw, cmd.pitch);
            }
        }

        if (this.physicsProps) {
            if (cmd.action === ACTION_RAGDOLL) this.launchRagdoll();
            else if (cmd.action === ACTION_DROP_TEST) this.dropTest();
            else if (cmd.action === ACTION_RESET_PROPS) for (const e of this.propEntities) pw.respawn(e.id);
            this.updateStress();
        }

        pw.step();
        this.readPhysics();
        this.applyRules();
        const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
        this.physicsMs = t1 - t0;
    }

    /**
     * Level rules, once per tick after the physics step: the objective (bucket resting in the goal
     * area), falling into the creek (put back on the last safe ground), and losing the bucket in the
     * creek (it returns to its start). Pure sim state; the client only reads `events`.
     */
    private applyRules(): void {
        const rules = this.level.rules;
        if (!rules || !this.physicsProps) return;
        const pw = this.physics;
        const p = this.player;
        if (this.fpActive) {
            if (p.grounded && p.y > rules.fallY + 0.3 && rules.isSafe(p.x, p.z)) {
                this.safeSpot.x = p.x;
                this.safeSpot.y = p.y;
                this.safeSpot.z = p.z;
                this.safeSpot.valid = true;
            }
            this.fallTicks = p.y < rules.fallY ? this.fallTicks + 1 : 0;
            if (this.fallTicks > 45) {
                this.fallTicks = 0;
                this.progress.falls++;
                const sp = this.safeSpot.valid ? this.safeSpot : { x: this.level.spawn.x, z: this.level.spawn.z };
                this.placePlayer(sp.x, sp.z, p.yaw);
                this.events.push({ tick: this.tick, kind: 'fell', text: 'Splash! Fished out and put back on the bank.' });
            }
        }
        const bk = this.bucket;
        const body = pw.bodies.get(bk.id);
        if (!body) return;
        // essential item: lost in the creek for 1.5 s -> back on its stump
        this.lostTicks = bk.pose.p.y < rules.lostY && pw.heldId !== bk.id ? this.lostTicks + 1 : 0;
        if (this.lostTicks > 90) {
            this.lostTicks = 0;
            this.progress.recoveries++;
            pw.respawn(bk.id);
            this.events.push({ tick: this.tick, kind: 'recovered', text: 'The bucket floated off. A spare one is back on the stump.' });
        }
        if (!this.progress.goalReached) {
            const g = rules.goal;
            const v = body.body.linvel();
            const inside = bk.pose.p.x > g.minX && bk.pose.p.x < g.maxX && bk.pose.p.z > g.minZ && bk.pose.p.z < g.maxZ;
            const resting = Math.hypot(v.x, v.y, v.z) < 0.4 && pw.heldId !== bk.id;
            this.goalTicks = inside && resting ? this.goalTicks + 1 : 0;
            if (this.goalTicks > 30) {
                this.progress.goalReached = true;
                this.progress.goalTick = this.tick;
                this.events.push({ tick: this.tick, kind: 'goal', text: 'Bucket delivered across the creek!' });
            }
        }
    }

    /** Copies dynamic body poses into their entities (physics props mode). */
    private readPhysics(): void {
        if (!this.physicsProps) return;
        const pw = this.physics;
        for (const e of this.propEntities) {
            const b = pw.bodies.get(e.id);
            if (!b) {
                e.visible = false;
                continue;
            }
            e.visible = b.enabled;
            if (b.enabled) pw.readPose(e.id, e.pose);
        }
    }

    private summonCarryPlank(): void {
        const pw = this.physics;
        const p = this.player;
        const eyeY = p.y + EYE_HEIGHT;
        // across the body, 1.3 m ahead and 0.45 m below the eye
        const fx = -Math.sin(p.yaw);
        const fz = -Math.cos(p.yaw);
        const q = quatFromYawPitchRoll(p.yaw, Math.PI / 2, 0);
        const at = pose(p.x + fx * 1.3, eyeY - 0.45, p.z + fz * 1.3, q);
        pw.setEnabled(this.held.id, true);
        pw.place(this.held.id, at);
        pw.grabById(this.held.id, at.p, Math.hypot(1.3, 0.45));
    }

    private launchRagdoll(): void {
        const p = this.player;
        const ids = this.dummy.map((e) => e.id);
        if (this.fpActive) {
            const fx = -Math.sin(p.yaw);
            const fz = -Math.cos(p.yaw);
            launchDummy(this.physics, ids, p.x + fx * 1.6, p.y + 0.6, p.z + fz * 1.6, p.yaw, 6);
        } else {
            // from the near bank towards the river
            launchDummy(this.physics, ids, 0.5, 2.2, 5.2, 0, 5);
        }
    }

    /**
     * Scripted, deterministic drop test: the main plank is placed 2.5 m above the near bank with a
     * fixed tilt and spin and released. Used by the debug panel and by the drop test in tests/.
     */
    dropTest(): void {
        const x = 0.6;
        const z = 3.6;
        const at = pose(x, this.level.terrainHeight(x, z) + 2.5, z, quatFromYawPitchRoll(0.4, 0.6, 0.2));
        this.physics.setEnabled(this.plank.id, true);
        this.physics.place(this.plank.id, at, { x: 0, y: 0, z: 0 }, { x: 1.5, y: 3.0, z: 0.8 });
    }

    private updateStress(): void {
        const pw = this.physics;
        for (let n = 0; n < this.stress.length; n++) {
            const e = this.stress[n];
            const on = n < this.stressCount;
            const was = this.stressEnabled[n] >= 0;
            if (on && !was) {
                pw.setEnabled(e.id, true);
                pw.respawn(e.id);
                this.stressEnabled[n] = this.tick;
            } else if (!on && was) {
                pw.setEnabled(e.id, false);
                this.stressEnabled[n] = -1;
            }
            // a deterministic fountain keeps every stress body moving (for the 25-body measurement)
            if (on && (this.tick - this.stressEnabled[n]) % STRESS_KICK_TICKS === STRESS_KICK_TICKS - 1) {
                const b = pw.bodies.get(e.id)!.body;
                const m = b.mass();
                const a = n * 2.399;
                b.applyImpulse({ x: Math.cos(a) * m * 1.2, y: m * 5.5, z: Math.sin(a) * m * 1.2 }, true);
                b.applyTorqueImpulse({ x: m * 0.05, y: m * 0.08 * (n % 2 ? 1 : -1), z: 0 }, true);
            }
        }
    }

    // ------------------------------------------------------------------------------- evaluate

    private evaluate(): void {
        const t = this.tick * SIM_DT;

        const actors = this.level.actors;
        if (actors.beaver.mode === 'idle') {
            // a co-worker standing about, looking around
            const b = this.beaver;
            const ip = actors.beaver.pose;
            b.pose.p.x = ip.p.x;
            b.pose.p.y = ip.p.y;
            b.pose.p.z = ip.p.z;
            b.pose.q.x = ip.q.x;
            b.pose.q.y = ip.q.y;
            b.pose.q.z = ip.q.z;
            b.pose.q.w = ip.q.w;
            b.anim[BEAVER_WALK_PHASE] = 0;
            b.anim[BEAVER_WALK_AMOUNT] = 0;
            b.anim[BEAVER_CARRY] = 0;
            b.anim[BEAVER_HEAD_YAW] = 0.6 * Math.sin(t * 0.45) + 0.15 * Math.sin(t * 1.3);
            b.visible = true;
        }
        // ---- beaver + bucket
        if (actors.beaver.mode === 'loop') {
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
            // physics mode: the bucket is a free physics prop, so the beaver walks empty-handed
            b.anim[BEAVER_CARRY] = this.physicsProps ? 0 : 1;
            b.anim[BEAVER_HEAD_YAW] = (1 - amount) * 0.55 * Math.sin(t * 1.7);
            b.visible = true;
        }
        if (!this.physicsProps && actors.beaver.mode === 'loop') {
            const b = this.beaver;
            const th = this.beaverTheta;
            const dx = -Math.sin(th);
            const dz = Math.cos(th);
            const amount = beaverWalkAmount(t);

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

        this.evaluateUte(t);
        if (!this.physicsProps) this.evaluateScriptedProps(t);
    }

    private evaluateUte(t: number): void {
        const ute = this.level.actors.ute;
        if (ute.mode === 'parked') {
            const u = this.ute;
            u.pose.p.x = ute.pose.p.x;
            u.pose.p.y = ute.pose.p.y;
            u.pose.p.z = ute.pose.p.z;
            u.pose.q.x = ute.pose.q.x;
            u.pose.q.y = ute.pose.q.y;
            u.pose.q.z = ute.pose.q.z;
            u.pose.q.w = ute.pose.q.w;
            for (const c of [UTE_WHEEL_SPIN, UTE_STEER, UTE_SUSPENSION, UTE_PITCH, UTE_ROLL]) u.anim[c] = 0;
            u.visible = true;
            return;
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
    }

    /** Epic 1 scripted motion for the props (the `scripted` comparison mode). */
    private evaluateScriptedProps(t: number): void {
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
        e.pose.p.y = this.player.y + this.player.eyeLift + EYE_HEIGHT;
        e.pose.p.z = this.player.z;
        e.visible = this.fpActive;
    }

    private publish(): void {
        this.publishPlayer();
        const buf = this.ring.beginWrite(this.tick);
        for (const e of this.entities) writeEntity(buf, e.slot, e.pose, e.visible, e.anim, ANIM_MAX);
    }

    /** Places the character (e.g. when entering first-person mode), on the ground, inside the play area. */
    placePlayer(x: number, z: number, yaw: number): void {
        const p = this.player;
        const A = this.level.playArea;
        p.x = Math.max(A.minX + 0.5, Math.min(A.maxX - 0.5, x));
        p.z = Math.max(A.minZ + 0.5, Math.min(A.maxZ - 0.5, z));
        // cast from just above the terrain, so roofs and tree tops are never "the ground"
        const th = this.level.terrainHeight(p.x, p.z);
        const g = this.physics.groundY(p.x, p.z, th + 0.6) ?? th;
        p.y = g + 0.05;
        p.vy = 0;
        p.yaw = yaw;
        p.grounded = true;
        p.eyeLift = 0;
        this.physics.placeCharacter(p.x, p.y, p.z);
        this.lastCmd = { ...this.lastCmd, yaw };
    }

    /** Read-only, for UI: what the player is holding and what the crosshair would grab. */
    interaction(): { holding: string | null; target: string | null } {
        if (!this.fpActive || !this.physicsProps) return { holding: null, target: null };
        const pw = this.physics;
        const p = this.player;
        const name = (id: number) => (id < 0 ? null : (this.entities.find((e) => e.id === id)?.name ?? null));
        const holding = name(pw.heldId);
        const target = holding ? null : name(pw.probe({ x: p.x, y: p.y + EYE_HEIGHT, z: p.z }, p.yaw, p.pitch));
        return { holding, target };
    }

    /** True when the voxelized dummy is in the world. */
    get dummyActive(): boolean {
        return this.dummy[0].visible;
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


const _hand = pose();
const _q = { x: 0, y: 0, z: 0, w: 1 };
const _q2 = { x: 0, y: 0, z: 0, w: 1 };
const _v = vec3();
const _target = pose();
const _offset = pose();

export { BEAVER_ANIM_CHANNELS, UTE_ANIM_CHANNELS };
