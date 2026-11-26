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

import {
    BEAVER_ANIM_CHANNELS,
    BEAVER_ARM_RAISE,
    BEAVER_ARM_REACH,
    BEAVER_ARM_SPREAD,
    BEAVER_HEAD_PITCH,
    BEAVER_LEAN,
    BEAVER_CARRY,
    BEAVER_FIRST_PERSON,
    BEAVER_HEAD_YAW,
    BEAVER_WALK_AMOUNT,
    BEAVER_WALK_PHASE
} from '../assets/beaver.ts';
import { BODY } from '../assets/player-body.ts';
import { BUCKET_HANDLE_TOP, BUCKET_LITRES, LOG_RADIUS } from '../assets/props.ts';
import {
    UTE_ANIM_CHANNELS,
    UTE_DROP_0,
    UTE_PITCH,
    UTE_ROLL,
    UTE_STEER,
    UTE_SUSPENSION,
    UTE_WHEELBASE_HALF,
    UTE_WHEEL_RADIUS,
    UTE_WHEEL_SPIN
} from '../assets/ute.ts';
import { windAt } from '../fx/wind.ts';
import type { WindSample } from '../fx/wind.ts';
import type { LevelDef, LevelStage } from '../levels/level.ts';
import { BEAVER_LOOP, PLATEAU_Y, UTE_TRACK, groundSurfaceY, riverLabLevel } from '../levels/river-lab.ts';
import {
    composePose,
    pose,
    quatFromAxisAngle,
    quatFromYawPitchRoll,
    quatMul,
    quatRotate,
    quatSlerp,
    vec3
} from '../voxels/math.ts';
import type { Vec3 } from '../voxels/math.ts';

import { BucketWaterState } from './bucket-water.ts';
import { SIM_DT } from './clock.ts';
import {
    ACTION_DROP,
    ACTION_DROP_TEST,
    ACTION_NAIL,
    ACTION_POUR,
    ACTION_RAGDOLL,
    ACTION_RESET_PROPS,
    neutralCommand,
    sanitizeCommand
} from './commands.ts';
import type { PlayerCommand } from './commands.ts';
import { Forestry } from './forestry.ts';
import { HazardDirector, PHASE } from './hazards.ts';
import type { JointEvent } from './joints/breaking.ts';
import { GROUND, nailCode } from './joints/graph.ts';
import { JointSystem } from './joints/joints.ts';
import type { NailPreview } from './joints/joints.ts';
import { RopeSystem } from './joints/rope.ts';
import { MAX_PLAYERS, MAX_STRESS, createLabEntities } from './lab-entities.ts';
import type { SimEntity } from './lab-entities.ts';
import { addDummy, addLabKinematics, buildLabPhysics, launchDummy, propBody, stressDef } from './lab-physics.ts';
import { NO_DRIVE, UteVehicle } from './physics/vehicle.ts';
import type { DriveInput } from './physics/vehicle.ts';
import { CHARACTER } from './physics/world.ts';
import type { HeldInfo, PhysicsWorld } from './physics/world.ts';
import { PlayerAnimator } from './player-anim.ts';
import type { AnimEvents, AnimOutput } from './player-anim.ts';
import { Sawmill } from './sawmill.ts';
import { ANIM_MAX, SnapshotRing, writeEntity } from './snapshots.ts';
import { WATER } from './water.ts';
import { Winch } from './winch.ts';
import type { WinchEvent, WinchEventKind } from './winch.ts';

export type { PlayerCommand, SimEntity };
export { MAX_PLAYERS, MAX_STRESS };

/**
 * Where player slot i (1..) stands relative to player 1, in metres: rows of four to player 1's
 * right (slots 1-4 on player 1's row, 5-7 a row behind), so eight players stay close together.
 */
export function slotOffset(i: number): { right: number; back: number } {
    if (i <= 0) return { right: 0, back: 0 };
    return { right: 1.2 * (((i - 1) % 4) + 1), back: 1.2 * Math.floor((i - 1) / 4) };
}
export type PropsMode = 'physics' | 'scripted';

/** The player body's eye height (beavers 1.22 m; the former stand-in people 1.86 m). */
export const EYE_HEIGHT = BODY.eyeHeight;
/** The farthest apart (feet, across the ground, m) two beavers can be to pass the bucket hand to hand. */
export const HANDOVER_REACH = 1.9;
/** Along a hand-over, ground every this far (m) between the two beavers' feet... */
export const HANDOVER_STEP = 0.15;
/** ...no lower than this (m) under the lower end: a gap between them refuses it. */
export const HANDOVER_DROP = 0.5;
/** ...but not within this far (m) of either end: what stands or rests there is held up already. */
export const HANDOVER_END = 0.3;
/** Said the first time a beaver reaches for the bucket across a gap or from too far (resting, or in another's hands). */
export const HANDOVER_TEXT = 'Can’t take the bucket across a gap or from far off: stand close, or build the crossing.';
/** Said the first time a beaver tries to jump holding the bucket (or grab it in mid-air). */
export const HEAVY_JUMP_TEXT = 'Too heavy to jump with the bucket: build the crossing to get it over.';
/** Stress bodies get a deterministic upward kick this often (ticks), so 25 bodies keep moving. */
export const STRESS_KICK_TICKS = 150;

export interface LabSimOptions {
    props?: PropsMode;
    /** The level to simulate (default: the River Lab test scene). */
    level?: LevelDef;
    /** The game's hazard seed (the host picks one per game); default: the level's. */
    hazardSeed?: number;
    /** False: the level's hazards are off (tests of other mechanics). Default true. */
    hazards?: boolean;
}

/** Something the player should be told (objective reached, fell in the creek, ...). */
export interface SimEvent {
    tick: number;
    kind:
        | 'goal'
        | 'fell'
        | 'recovered'
        | 'step'
        | 'ute'
        | 'water'
        | 'hazard'
        | 'wood'
        | 'creak'
        | 'break'
        | 'hint'
        | 'winch';
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
    /** This tick's wind (zero in calm levels) and the largest wind force on a body (N). */
    readonly wind: WindSample = { x: 0, z: 0, speed: 0, gustiness: 0 };
    windForce = 0;
    /** Wall time of the last fixed tick's physics work (ms), for the debug panel. */
    physicsMs = 0;

    // scripted state
    private beaverDist = 0;
    private beaverTheta = 0;
    private uteTheta = 0;
    private uteSpin = 0;
    /** What is nailed to what (Epic 5), rebuilt with the physics world. */
    joints!: JointSystem;
    /** Ropes (#52; hazards, #75): rebuilt with the physics. */
    ropes!: RopeSystem;
    /** The level's hand winch, if it has one (#52): rebuilt with the physics. */
    winch: Winch | null = null;
    private readonly winchEvents: WinchEvent[] = [];
    /** The drivable ute's physics (levels whose ute is 'drivable'), or null. */
    vehicle: UteVehicle | null = null;
    /** Recovery: the last place the ute stood level on solid ground, and how long it has lain tipped. */
    private readonly uteSafe = pose();
    private uteSafeYaw = 0;
    private uteSafeSet = false;
    private uteTipped = 0;
    /** Who sits where: [driver, passenger], player indices or -1. */
    readonly seats: number[] = [-1, -1];
    /** Player index in the driver's seat, or -1. */
    get driver(): number {
        return this.seats[0];
    }
    /** The seat a player sits in (0 driver, 1 passenger), or -1. */
    seatOf(i: number): number {
        return this.seats.indexOf(i);
    }
    private driveInput: DriveInput = { ...NO_DRIVE };

    // player state (feet position; `eyeLift` smooths step-ups for the camera). Player 1 is `player`.
    readonly players: PlayerState[] = Array.from({ length: MAX_PLAYERS }, (_, i) => newPlayerState(i * 1.2, 6.5));
    /** Body animation per player (grab, carry, throw, landing): src/sim/player-anim.ts. */
    private readonly animators = Array.from({ length: MAX_PLAYERS }, () => new PlayerAnimator());
    private readonly animEvents: AnimEvents[] = Array.from({ length: MAX_PLAYERS }, () => ({
        grabbed: false,
        missed: false,
        thrown: false,
        dropped: false,
        balked: false
    }));
    /** Each player's jump key last tick (a refused jump reacts on the press, not while held). */
    private readonly jumpWas = new Uint8Array(MAX_PLAYERS);
    /** Said once a run: no jumping with the bucket. */
    private heavyNoticed = false;
    /** Ticks each player has been off the ground. */
    private readonly airTicks = new Uint16Array(MAX_PLAYERS);
    /** Said once a run: the bucket is handed over only standing close. */
    private farNoticed = false;
    private readonly landingVy = new Float64Array(MAX_PLAYERS);
    readonly player = this.players[0];
    /**
     * Which slots play (slot 0 follows `fpActive`). Local split screen uses slot 1; networked guests
     * take any free slot. Extra players are always in first person.
     */
    private readonly slotActive: boolean[] = Array.from({ length: MAX_PLAYERS }, () => false);
    private readonly lastCmds: PlayerCommand[] = Array.from({ length: MAX_PLAYERS }, () => neutralCommand());
    private lastCmd: PlayerCommand = neutralCommand();
    private heldInit = false;
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
    readonly windsock: SimEntity;
    readonly avatars: SimEntity[];
    /** Your own limbs in first person, drawn by the renderer only (never visible in snapshots). */
    readonly fpBody: SimEntity;
    readonly player2Entity: SimEntity;
    /** Every player's eye entity, by slot. */
    readonly eyes: SimEntity[];
    readonly level: LevelDef;
    /** The world fighting back (Epic 8): the flood and the aimed gust (src/sim/hazards.ts). */
    readonly hazards: HazardDirector;
    /** Level progress (rules): the objective, once reached, stays reached until reset. */
    readonly progress = { goalReached: false, goalTick: -1, falls: 0, recoveries: 0, step: 0 };
    private lookAccum = 0;
    private lastLookYaw: number | null = null;
    private jumped = false;
    /** Events since reset, newest last (the client shows them as toasts). */
    readonly events: SimEvent[] = [];
    private lostTicks = 0;
    private goalTicks = 0;
    /** Ticks the tutorial's long plank has lain in the ditch (applyRules). */
    private plankDownTicks = 0;
    /** The tutorial's long plank (only the tutorial places it). */
    private readonly longPlank: SimEntity;
    /** Not voxelized: carries the walker's pose through the snapshot ring for interpolation. */
    readonly playerEntity: SimEntity;
    /** The bucket's water (Epic 7): volume, slosh, refills, the flower. */
    readonly water: BucketWaterState;
    /** Who is pouring the bucket they hold (ACTION_POUR toggles it). */
    readonly pouring: boolean[] = Array.from({ length: MAX_PLAYERS }, () => false);
    /** The bucket sat in the goal without enough water (said once per visit). */
    private dryNoticed = false;
    /** Logging (Epic 6): the stand's trees, felled logs, the axe (src/sim/forestry.ts). */
    readonly forestry: Forestry;
    /** The level's sawmill, if it has one (src/sim/sawmill.ts). */
    readonly sawmill: Sawmill | null;

    constructor(opts: LabSimOptions = {}) {
        this.level = opts.level ?? riverLabLevel;
        this.hazards = new HazardDirector(this.level, opts.hazards ?? true);
        if (opts.hazardSeed !== undefined) this.hazards.seed = opts.hazardSeed >>> 0;
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
        this.longPlank = c.extras.find((e) => e.name === 'long-plank')!;
        this.windsock = c.windsock;
        this.avatars = c.avatars;
        this.fpBody = c.fpBody;
        this.playerEntity = c.player;
        this.player2Entity = c.player2;
        this.eyes = c.eyes;
        this.water = new BucketWaterState(this.level);
        this.water.stageDone = (k) => `the ${this.level.rules?.stages?.[k]?.name ?? `stage ${k + 1}`} stage`;
        const levelLogs = c.entities.filter((e) => e.name === 'log' || e.name.startsWith('extra-log'));
        this.forestry = new Forestry(this.level, c.forestry, levelLogs);
        const saw = this.level.forestry?.sawmill;
        this.sawmill = saw ? new Sawmill(saw, c.forestry.sawmill, this.forestry) : null;
        const sp = this.level.spawn;
        this.player.x = sp.x;
        this.player.z = sp.z;
        this.player.y = this.level.terrainHeight(sp.x, sp.z);
        this.player.yaw = sp.yaw;
        for (let i = 1; i < MAX_PLAYERS; i++) {
            const pi = this.players[i];
            // rows to player 1's right
            const o = slotOffset(i);
            pi.x = sp.x + Math.cos(sp.yaw) * o.right + Math.sin(sp.yaw) * o.back;
            pi.z = sp.z - Math.sin(sp.yaw) * o.right + Math.cos(sp.yaw) * o.back;
            pi.y = this.level.terrainHeight(pi.x, pi.z);
            pi.yaw = sp.yaw;
        }
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
        this.player.prevCarry = false;
        this.stressEnabled.fill(-1);
        Object.assign(this.progress, { goalReached: false, goalTick: -1, falls: 0, recoveries: 0, step: 0 });
        this.lookAccum = 0;
        this.lastLookYaw = null;
        this.jumped = false;
        this.events.length = 0;
        // (tick starts again at 0: a hint given before the reset must not hold the next one back)
        this.looseHintTick = -Infinity;
        this.lostTicks = this.goalTicks = this.plankDownTicks = 0;
        this.water.reset();
        // the first snapshot already shows a full bucket
        this.bucket.anim[BUCKET_LITRES] = this.water.volume;
        this.pouring.fill(false);
        this.dryNoticed = false;
        this.heavyNoticed = false;
        this.farNoticed = false;
        this.jumpWas.fill(0);
        this.airTicks.fill(0);
        for (const pl of this.players) {
            pl.fallTicks = 0;
            pl.safe.valid = false;
        }
        this.ring.clear();
        this.hazards.reset();
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
        return [
            this.plank,
            this.log,
            this.cube,
            this.sphere,
            this.bucket,
            this.held,
            ...this.extras,
            ...this.forestry.props,
            ...this.stress,
            ...this.dummy
        ];
    }

    private buildPhysics(): void {
        this.physics?.free();
        const pw = buildLabPhysics(this.level);
        const ute = this.level.actors.ute;
        const drivable = ute.mode === 'drivable' && this.physicsProps;
        addLabKinematics(pw, this.beaver.id, drivable ? -1 : this.ute.id, this.beaver.pose, this.ute.pose);
        this.vehicle = drivable ? new UteVehicle(pw, this.ute.id, ute.pose) : null;
        this.joints = new JointSystem(pw);
        this.ropes = new RopeSystem(pw);
        // (its hook never goes into the bucket: the bucket crosses only over what is built, #132)
        this.winch = this.level.winch
            ? new Winch(pw, this.ropes, this.level.winch, (id) => id !== this.bucket.id)
            : null;
        this.seats.fill(-1);
        this.uteSafeSet = false;
        this.uteTipped = 0;
        if (this.physicsProps) {
            // the level places its props by entity name; entities it does not place stay hidden
            for (const placement of this.level.props) {
                const e = this.entities.find((x) => x.name === placement.name);
                const body = propBody(placement.name);
                if (e && body) pw.addDynamic(e.id, body.shape, placement.pose, body.opts);
            }
            pw.setEnabled(this.held.id, false);
            for (const e of [this.plank, this.log, this.cube, this.sphere, this.bucket, ...this.extras])
                if (!pw.bodies.has(e.id)) e.visible = false;
            this.forestry.build(pw);
            this.sawmill?.build(pw);
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
        this.players.forEach((pl, i) => pw.createCharacter(pl.x, pl.y, pl.z, i));
        pw.setCharacterEnabled(this.fpActive, 0);
        for (let i = 1; i < MAX_PLAYERS; i++) pw.setCharacterEnabled(this.slotActive[i], i);
        pw.holdReach = BODY.holdReach;
        pw.shoulderDrop = BODY.eyeHeight - BODY.shoulderHeight;
        pw.holdMin = BODY.holdMin;
        pw.breakDistance = BODY.breakDistance;
        pw.breakTime = BODY.breakTime;
        pw.snapDistance = BODY.snapDistance;
        this.physics = pw;
    }

    /** Runs the simulation up to (at least) a tick, for deterministic seeking. */
    runTo(tick: number): void {
        if (tick < this.tick) this.reset();
        // replay holds the look and carry state but repeats no edge-triggered request
        const c = this.lastCmd;
        const others = this.lastCmds.slice(1).map((x) => neutralCommand(x.seq, x.yaw, x.pitch));
        while (this.tick < tick)
            this.step({ ...neutralCommand(c.seq, c.yaw, c.pitch), carry: c.carry }, others[0], others.slice(1));
    }

    /**
     * One fixed tick. `input2` is slot 1's command, `rest` slots 2.. (each ignored when its slot is
     * not playing; a missing command means "no input, keep looking the same way").
     */
    step(input: PlayerCommand, input2?: PlayerCommand, rest: (PlayerCommand | undefined)[] = []): void {
        const cmds: PlayerCommand[] = [sanitizeCommand(input)];
        for (let i = 1; i < MAX_PLAYERS; i++) {
            const raw = i === 1 ? input2 : rest[i - 2];
            const p = this.players[i];
            cmds.push(sanitizeCommand(raw ?? neutralCommand(0, p.yaw, p.pitch)));
        }
        const cmd = cmds[0];
        this.lastCmd = cmd;
        for (let i = 1; i < MAX_PLAYERS; i++) {
            this.lastCmds[i] = cmds[i];
            this.players[i].yaw = cmds[i].yaw;
            this.players[i].pitch = cmds[i].pitch;
        }
        this.tick++;
        this.integrate(cmd);
        this.evaluate();
        this.stepPhysics(cmds);
        this.publish();
    }

    /** Number of players playing (slot 0 counts when in first person). */
    get playerCount(): number {
        let n = 1;
        for (let i = 1; i < MAX_PLAYERS; i++) if (this.slotActive[i]) n++;
        return n;
    }

    isSlotActive(i: number): boolean {
        return i === 0 ? this.fpActive : !!this.slotActive[i];
    }

    /** First free slot (1..), or -1. */
    freeSlot(): number {
        for (let i = 1; i < MAX_PLAYERS; i++) if (!this.slotActive[i]) return i;
        return -1;
    }

    /** Starts or stops a player slot (1..); a starting player appears beside player 1. */
    setSlotActive(i: number, active: boolean): void {
        if (i < 1 || i >= MAX_PLAYERS || this.slotActive[i] === active) return;
        this.slotActive[i] = active;
        const pw = this.physics;
        if (active) {
            const p1 = this.player;
            const pi = this.players[i];
            // their spot in the rows, or the next one nobody is standing on (players who walked off
            // leave theirs free; two characters placed into each other stick together)
            let x = 0;
            let z = 0;
            for (let k = i; k < i + 4 * MAX_PLAYERS; k++) {
                const o = slotOffset(k);
                x = p1.x + Math.cos(p1.yaw) * o.right + Math.sin(p1.yaw) * o.back;
                z = p1.z - Math.sin(p1.yaw) * o.right + Math.cos(p1.yaw) * o.back;
                let clear = true;
                for (let j = 0; j < MAX_PLAYERS && clear; j++) {
                    if (j === i || !this.isSlotActive(j)) continue;
                    clear = Math.hypot(this.players[j].x - x, this.players[j].z - z) > 0.9;
                }
                if (clear) break;
            }
            this.placePlayer(x, z, p1.yaw, i);
            pi.pitch = p1.pitch;
            pi.walkDist = 0;
            pw.setCharacterEnabled(true, i);
        } else {
            pw.setCharacterEnabled(false, i);
        }
    }

    /** Local split screen: 1 or 2 players (slot 1 on or off). */
    setPlayerCount(n: number): void {
        this.setSlotActive(1, n >= 2);
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

    private stepPhysics(cmds: PlayerCommand[]): void {
        const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const pw = this.physics;
        const cmd = cmds[0];
        // kinematic colliders follow this tick's scripted poses
        pw.setKinematicTarget(this.beaver.id, this.beaver.pose);
        if (!this.vehicle) pw.setKinematicTarget(this.ute.id, this.ute.pose);

        if (this.fpActive !== this.prevFp) {
            pw.setCharacterEnabled(this.fpActive, 0);
            if (!this.fpActive) this.player.prevCarry = false;
            this.prevFp = this.fpActive;
        }
        for (let i = 0; i < this.players.length; i++) {
            if (this.playerActive(i)) this.stepPlayer(i, cmds[i]);
        }

        if (this.physicsProps) {
            if (cmd.action === ACTION_RAGDOLL) this.launchRagdoll();
            else if (cmd.action === ACTION_DROP_TEST) this.dropTest();
            else if (cmd.action === ACTION_RESET_PROPS) {
                for (const e of this.propEntities) pw.respawn(e.id);
                if (this.vehicle) pw.respawn(this.vehicle.id);
                this.water.teleported();
                this.water.refillSources();
                this.forestry.resetProps();
                this.sawmill?.build(pw);
            }
            this.updateStress();
        }

        if (this.level.wind && this.physicsProps) {
            windAt(this.tick * SIM_DT, this.level.wind, this.wind);
            this.windForce = pw.applyWind(this.wind.x, this.wind.z, SIM_DT);
        }
        // a player who left (disconnected, or back out of first person) frees their seat
        for (let k = 0; k < this.seats.length; k++) {
            if (this.seats[k] >= 0 && !this.playerActive(this.seats[k])) {
                this.seats[k] = -1;
                if (k === 0) this.driveInput = { ...NO_DRIVE };
            }
        }
        if (this.winch) {
            this.winch.step(
                (k) =>
                    this.playerActive(k)
                        ? { x: this.players[k].x, y: this.players[k].y + EYE_HEIGHT, z: this.players[k].z }
                        : null,
                this.winchEvents
            );
            this.winchMessages();
        }
        if (this.physicsProps) this.hazards.step(this);
        // nobody driving: the handbrake is on
        // (unless the handbrake prank has let it off: src/sim/hazards.ts)
        this.vehicle?.drive(this.driver >= 0 ? this.driveInput : this.hazards.handbrakeOff ? NO_DRIVE : PARKED);
        pw.step();
        this.jointEvents(this.joints.update(this.tick));
        this.readPhysics();
        this.readVehicle();
        this.looseBeamHint();
        this.stepWater();
        this.watchUte();
        if (this.physicsProps) this.stepWood();
        this.applyRules();
        const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
        this.physicsMs = t1 - t0;
    }

    /** Clicks of the winch's stalled ratchet so far (its sound). */
    winchClicks = 0;
    /** The winch's doings as player events (its ratchet's clicks are counted, not told). */
    private winchMessages(): void {
        const TEXT: Partial<Record<WinchEventKind, string>> = {
            take: "You take the winch rope's hook. Grab a log or a beam to hook it in.",
            hook: 'Hooked. Crank the winch (grab it) to haul it in.',
            crank: 'You crank the winch.',
            stop: 'You let go of the crank: the ratchet holds.',
            release: "The winch's pawl lifts: the rope runs free and the hook comes back.",
            drop: 'The hook goes back to the winch.'
        };
        for (const e of this.winchEvents.splice(0)) {
            if (e.kind === 'click') {
                // (a sound, not a message: counted on the winch)
                this.winchClicks++;
                continue;
            }
            const text = TEXT[e.kind];
            if (text) this.events.push({ tick: this.tick, kind: 'winch', text });
        }
        const snapped = this.ropes.events().length;
        for (let k = 0; k < snapped; k++)
            this.events.push({ tick: this.tick, kind: 'break', text: 'Snap! The rope parted' });
    }

    private lastCreakTick = -1e9;
    /** Joint warnings and breaks as player events (creaks at most every 2 s). */
    private jointEvents(evs: JointEvent[]): void {
        for (const e of evs) {
            const anchor = e.conn.type === 'anchor';
            if (e.kind === 'break') {
                this.events.push({
                    tick: this.tick,
                    kind: 'break',
                    text: anchor ? 'Crack! A nailed piece tore loose from the stone' : 'Crack! A nailed joint gave way'
                });
            } else if (this.tick - this.lastCreakTick >= 2 / SIM_DT) {
                this.lastCreakTick = this.tick;
                this.events.push({
                    tick: this.tick,
                    kind: 'creak',
                    text:
                        e.kind === 'groan'
                            ? '⚠ The bridge groans: a joint is close to breaking'
                            : '⚠ Creak: a joint is straining'
                });
            }
        }
    }

    private playerActive(i: number): boolean {
        return this.isSlotActive(i);
    }

    /** Movement, carry, grab, throw for one player (first person). */
    private stepPlayer(i: number, cmd: PlayerCommand): void {
        const pw = this.physics;
        const p = this.players[i];
        const seat = this.seatOf(i);
        if (seat >= 0) {
            // in the ute: grab gets out; the driver's W/S throttle, A/D steer, jump brakes
            if (cmd.grab) this.leaveUte(i);
            else if (seat === 0 && cmd.action === ACTION_DROP) this.recoverUte();
            else if (seat === 0) {
                this.driveInput.throttle = cmd.moveZ;
                this.driveInput.steer = cmd.moveX;
                this.driveInput.brake = cmd.jump;
            }
            return;
        }
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
        const vyBefore = p.vy;
        // no jumping while holding the bucket (Epic 9): too heavy and awkward to hop with, so it
        // can't be carried over a crossing a beaver could jump; a press gets a dip and, once, a toast
        let jump = cmd.jump;
        if (jump && pw.heldIdOf(i) === this.bucket.id) {
            jump = false;
            if (!this.jumpWas[i] && p.grounded) {
                this.animEvents[i].balked = true;
                if (!this.heavyNoticed) {
                    this.heavyNoticed = true;
                    this.events.push({ tick: this.tick, kind: 'hint', text: HEAVY_JUMP_TEXT });
                }
            }
        }
        this.jumpWas[i] = cmd.jump ? 1 : 0;
        pw.moveCharacter((fx * mz + rx * mx) * run, (fz * mz + rz * mx) * run, jump, i);
        const c = pw.rig(i)!.state;
        this.landingVy[i] = vyBefore;
        // smooth step-ups (and only step-ups) for the camera
        const dy = c.y - p.y;
        p.eyeLift = c.grounded && dy > 0.04 && dy < CHARACTER.stepHeight + 0.05 ? p.eyeLift - dy : p.eyeLift;
        p.eyeLift *= Math.exp(-SIM_DT * 14);
        if (Math.abs(p.eyeLift) < 1e-4) p.eyeLift = 0;
        p.walkDist += Math.hypot(c.x - p.x, c.z - p.z);
        p.speed = Math.hypot(c.vx, c.vz);
        p.x = c.x;
        p.y = c.y;
        p.z = c.z;
        p.vy = c.vy;
        p.grounded = c.grounded;
        this.airTicks[i] = p.grounded ? 0 : Math.min(this.airTicks[i] + 1, 60000);

        if (!this.physicsProps) return;
        const ev = this.animEvents[i];
        const heldBefore = pw.heldIdOf(i);
        // carry (G, player 1): the rising edge puts the carry plank in your grip, the falling edge drops it
        if (i === 0) {
            if (cmd.carry && !p.prevCarry) this.summonCarryPlank();
            else if (!cmd.carry && p.prevCarry && pw.heldIdOf(0) === this.held.id) pw.release(0);
            p.prevCarry = cmd.carry;
        }
        if (cmd.reach) pw.adjustHold(cmd.reach, i);
        // pour (R): tip the bucket you hold forward, or let it hang again
        if (cmd.action === ACTION_POUR) this.pouring[i] = pw.setPour(!this.pouring[i], i);
        const eye = { x: p.x, y: p.y + EYE_HEIGHT, z: p.z };
        if (cmd.action === ACTION_DROP && !this.winch?.drop(i, eye, cmd.yaw, cmd.pitch, this.winchEvents))
            pw.release(i);
        if (cmd.action === ACTION_NAIL) this.joints.nail(eye, cmd.yaw, cmd.pitch, i, this.tick);
        if (cmd.throw) {
            if (pw.heldIdOf(i) >= 0) ev.thrown = true;
            pw.throwHeld(cmd.yaw, cmd.pitch, i);
        } else if (cmd.grab) {
            // holding the axe, a grab at a tree or a log is a blow; with empty hands, at a tree, a bite;
            // a hanging bucket is set down rather than dropped (letGo), again while lowering drops it
            const held = pw.heldIdOf(i);
            if (this.winch?.grab(i, eye, cmd.yaw, cmd.pitch, held, this.winchEvents)) {
                // the winch: its hook taken, hooked into a piece, or its crank turned or let go
            } else if (held >= 0) {
                if (this.forestry.strike(i, eye, p, cmd.yaw, cmd.pitch, held)) ev.missed = true;
                else pw.letGo(i);
            } else if (pw.tryGrab(eye, cmd.yaw, cmd.pitch, i)) {
                // grabbed
            } else if (this.sawmill?.pressLever(eye, cmd.yaw, cmd.pitch)) ev.grabbed = true;
            else if (this.forestry.strike(i, eye, p, cmd.yaw, cmd.pitch, -1)) ev.missed = true;
            else if (!this.enterUte(i, eye, cmd)) ev.missed = true;
        }
        pw.applyGrab(eye, cmd.yaw, cmd.pitch, i);
        // no taking hold of the bucket in mid-air (Epic 9): jumped empty-handed and grabbed on the
        // way up, it would be carried over a crossing all the same
        const air = !p.grounded && (p.vy > 0.5 || this.airTicks[i] >= 3);
        if (air && heldBefore !== this.bucket.id && pw.heldIdOf(i) === this.bucket.id) {
            pw.release(i);
            if (!this.heavyNoticed) {
                this.heavyNoticed = true;
                this.events.push({ tick: this.tick, kind: 'hint', text: HEAVY_JUMP_TEXT });
            }
        }
        // the bucket passes hand to hand only between beavers standing close, with ground between
        // them (Epic 9): reaching it out of another's hands across a gap would get it over a
        // crossing nobody built (a built span is ground: along a bridge, it passes)
        if (heldBefore !== this.bucket.id && pw.heldIdOf(i) === this.bucket.id) {
            // reaching for it at all: ground from your feet to where it is (not across a gap: set
            // down on one side, it can't be taken from the other)
            if (!this.groundBetween(p, this.bucket.pose.p)) {
                pw.release(i);
                if (!this.farNoticed) {
                    this.farNoticed = true;
                    this.events.push({ tick: this.tick, kind: 'hint', text: HANDOVER_TEXT });
                }
            }
        }
        // hand to hand, also feet within HANDOVER_REACH with ground between them (defensive: in the
        // Valley the reach check above refuses first, and no test fails with this alone switched off)
        if (heldBefore !== this.bucket.id && pw.heldIdOf(i) === this.bucket.id) {
            for (let j = 0; j < this.players.length; j++) {
                if (j === i || pw.heldIdOf(j) !== this.bucket.id) continue;
                const o = this.players[j];
                if (Math.hypot(o.x - p.x, o.z - p.z) <= HANDOVER_REACH && this.groundBetween(p, o)) continue;
                pw.release(i);
                if (!this.farNoticed) {
                    this.farNoticed = true;
                    this.events.push({ tick: this.tick, kind: 'hint', text: HANDOVER_TEXT });
                }
                break;
            }
        }
        const heldAfter = pw.heldIdOf(i);
        if (heldAfter !== this.bucket.id) this.pouring[i] = false;
        if (heldAfter >= 0 && heldAfter !== heldBefore) ev.grabbed = true;
        if (heldBefore >= 0 && heldAfter < 0 && !ev.thrown) ev.dropped = true;
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
        for (let i = 0; i < this.players.length; i++) {
            if (!this.playerActive(i) || this.seatOf(i) >= 0) continue;
            const p = this.players[i];
            if (p.grounded && p.y > rules.fallY + 0.3 && rules.isSafe(p.x, p.z)) {
                p.safe.x = p.x;
                p.safe.z = p.z;
                p.safe.valid = true;
            }
            p.fallTicks = p.y < rules.fallY ? p.fallTicks + 1 : 0;
            if (p.fallTicks > 45) {
                p.fallTicks = 0;
                this.progress.falls++;
                const st = this.stage;
                const sp = p.safe.valid
                    ? p.safe
                    : st
                      ? { x: st.start.x + slotOffset(i).right, z: st.start.z + slotOffset(i).back }
                      : { x: this.level.spawn.x + slotOffset(i).right, z: this.level.spawn.z + slotOffset(i).back };
                this.placePlayer(sp.x, sp.z, p.yaw, i);
                const who = this.playerCount > 1 ? `Player ${i + 1}: splash!` : 'Splash!';
                this.events.push({
                    tick: this.tick,
                    kind: 'fell',
                    text: `${who} Fished out and put back on the bank.`
                });
            }
        }
        // the tutorial's long plank, dropped into the ditch (out of reach from the bank), comes back
        // to where it started after 1.5 s
        const lp = this.longPlank;
        if (pw.bodies.has(lp.id)) {
            const q = lp.pose.p;
            const down =
                !rules.isSafe(q.x, q.z) && q.y < this.level.terrainHeight(q.x, q.z) + 0.3 && pw.holders(lp.id) === 0;
            this.plankDownTicks = down ? this.plankDownTicks + 1 : 0;
            if (this.plankDownTicks > 90) {
                this.plankDownTicks = 0;
                pw.respawn(lp.id);
                this.events.push({
                    tick: this.tick,
                    kind: 'recovered',
                    text: 'The plank fell in. It is back where it was: carry it toward the ditch and let go a step before the edge.'
                });
            }
        }
        const bk = this.bucket;
        const body = pw.bodies.get(bk.id);
        if (!body) {
            this.applySteps(rules);
            return;
        }
        // essential item: lost in the creek for 1.5 s -> back on its stump (in a flood, afloat in it)
        const p0 = bk.pose.p;
        const lost =
            p0.y < rules.lostY ||
            (this.hazards.rise > 0 && p0.y < rules.lostY + this.hazards.rise && !rules.isSafe(p0.x, p0.z));
        this.lostTicks = lost && pw.holders(bk.id) === 0 ? this.lostTicks + 1 : 0;
        if (this.lostTicks > 90) {
            this.lostTicks = 0;
            this.progress.recoveries++;
            const st = this.stage;
            const spare = st?.spareLitres ?? 0;
            this.water.bucketLost(spare);
            this.water.teleported();
            this.water.refillSources();
            if (st) {
                // journeys: the bucket comes back at the last checkpoint reached
                pw.place(bk.id, pose(st.bucket.x, st.bucket.y, st.bucket.z));
                this.events.push({
                    tick: this.tick,
                    kind: 'recovered',
                    text: spare
                        ? `The bucket fell in. A spare bucket (${spare} L) is waiting at the ${st.name} start.`
                        : `The bucket fell in. A spare (empty) one is waiting at the ${st.name} start.`
                });
            } else {
                pw.respawn(bk.id);
                this.events.push({
                    tick: this.tick,
                    kind: 'recovered',
                    text: this.water.sources.length
                        ? 'The bucket floated off. A spare one is back on the stump: fill it at the water butt.'
                        : 'The bucket floated off. A spare one is back on the stump.'
                });
            }
        }
        if (rules.stages) this.applyStages(rules.stages, bk.pose.p, body.body.linvel(), pw.holders(bk.id));
        else if (!this.progress.goalReached) {
            const g = rules.goal;
            const v = body.body.linvel();
            const inside = bk.pose.p.x > g.minX && bk.pose.p.x < g.maxX && bk.pose.p.z > g.minZ && bk.pose.p.z < g.maxZ;
            const resting = Math.hypot(v.x, v.y, v.z) < 0.4 && pw.holders(bk.id) === 0;
            this.goalTicks = inside && resting ? this.goalTicks + 1 : 0;
            if (!inside) this.dryNoticed = false;
            // Epic 7: a level may ask for water in it, not just the bucket
            const wet = this.water.volume >= (rules.minLitres ?? 0);
            if (this.goalTicks > 30 && !wet && !this.dryNoticed) {
                this.dryNoticed = true;
                this.events.push({
                    tick: this.tick,
                    kind: 'water',
                    text: 'The bucket made it, but it is empty. Fill it at the water butt and bring it back.'
                });
            }
            if (this.goalTicks > 30 && wet) {
                this.progress.goalReached = true;
                this.progress.goalTick = this.tick;
                const steps = rules.steps;
                const litres = this.water.volume.toFixed(1);
                this.events.push({
                    tick: this.tick,
                    kind: 'goal',
                    text: steps
                        ? 'Bucket delivered!'
                        : rules.minLitres
                          ? `Bucket delivered across the creek with ${litres} L of water!${waterPraise(this.water.volume)}`
                          : 'Bucket delivered across the creek!'
                });
            }
        }
        this.applySteps(rules);
    }

    /**
     * Ground all along the line between two points (a player's feet, another's or where the bucket
     * rests), sampled every HANDOVER_STEP: something to stand on (the ground, a prop, a built span)
     * no lower than HANDOVER_DROP under the lower end. A gap between them, a crossing nobody built,
     * says no.
     */
    private groundBetween(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): boolean {
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        const n = Math.max(1, Math.ceil(len / HANDOVER_STEP));
        // (across a beaver's width too: one standing on two beams side by side is on the bridge)
        const sx = len > 1e-6 ? (-(b.z - a.z) / len) * 0.15 : 0;
        const sz = len > 1e-6 ? ((b.x - a.x) / len) * 0.15 : 0;
        // (down to HANDOVER_DROP under the lower end: a step down to a crate or off a wall's top is
        // ground, a crossing's gap metres deep is not)
        const floor = Math.min(a.y, b.y) - HANDOVER_DROP;
        for (let k = 0; k <= n; k++) {
            const f = k / n;
            // (not right under either end: a beaver standing at an edge has its middle over the
            // drop, held up by its feet's width, and a bucket's base is 0.16 m round its middle)
            if (len > 0 && (f * len < HANDOVER_END || (1 - f) * len < HANDOVER_END)) continue;
            const x = a.x + (b.x - a.x) * f;
            const y = a.y + (b.y - a.y) * f + 0.3;
            const z = a.z + (b.z - a.z) * f;
            const r = y - floor;
            const pw = this.physics;
            if (
                pw.supportY(x, z, y, r) === null &&
                pw.supportY(x + sx, z + sz, y, r) === null &&
                pw.supportY(x - sx, z - sz, y, r) === null
            )
                return false;
        }
        return true;
    }

    /** Journey levels: the stage being played (the last one once all are done), or null. */
    get stage(): LevelStage | null {
        const st = this.level.rules?.stages;
        if (!st || st.length === 0) return null;
        return st[Math.min(this.progress.step, st.length - 1)];
    }

    /**
     * Journey stages (the Valley): the bucket resting inside the current stage's goal for 0.5 s
     * completes it; the last one is the level's goal.
     */
    private applyStages(
        stages: LevelStage[],
        p: { x: number; z: number },
        v: { x: number; y: number; z: number },
        holders: number
    ): void {
        const k = this.progress.step;
        if (k >= stages.length) return;
        if (stages[k].flower) {
            this.applyFlower(stages, k);
            return;
        }
        const g = stages[k].goal;
        const inside = p.x > g.minX && p.x < g.maxX && p.z > g.minZ && p.z < g.maxZ;
        const resting = Math.hypot(v.x, v.y, v.z) < 0.4 && holders === 0;
        this.goalTicks = inside && resting ? this.goalTicks + 1 : 0;
        if (!inside) this.dryNoticed = false;
        if (this.goalTicks <= 30) return;
        // the flag wants water in the bucket (a thrown bucket arrives empty)
        const need = stages[k].minLitres ?? 0;
        if (this.water.volume < need) {
            if (!this.dryNoticed) {
                this.dryNoticed = true;
                this.events.push({
                    tick: this.tick,
                    kind: 'water',
                    text: `The bucket made it, but it needs at least ${need} L of water in it. Carry it over the crossing, don't throw it.`
                });
            }
            return;
        }
        this.goalTicks = 0;
        this.progress.step++;
        const last = this.progress.step >= stages.length;
        if (last) {
            this.progress.goalReached = true;
            this.progress.goalTick = this.tick;
        }
        this.events.push({
            tick: this.tick,
            kind: last ? 'goal' : 'step',
            text: last
                ? 'The bucket made it to the flower! The valley is yours.'
                : `✓ ${stages[k].name} done! Next: ${stages[k + 1].name}`
        });
    }

    /**
     * The flower stage (Epic 7): done once enough water has been poured into the flower and the pour
     * has stopped (so the praise can say how much it got). Fires once.
     */
    private applyFlower(stages: LevelStage[], k: number): void {
        const w = this.water;
        if (w.poured < WATER.minDelivery || w.pourQuiet < 0) return;
        if (w.pourQuiet < POUR_DONE_TICKS) return;
        this.progress.step++;
        const last = this.progress.step >= stages.length;
        if (last) {
            this.progress.goalReached = true;
            this.progress.goalTick = this.tick;
        }
        this.events.push({
            tick: this.tick,
            kind: last ? 'goal' : 'step',
            text: last
                ? `The flower drank ${w.poured.toFixed(1)} L!${waterPraise(w.poured)} The valley is yours.`
                : `✓ ${stages[k].name} done! Next: ${stages[k + 1].name}`
        });
    }

    /** The bucket's water for one tick (after the physics step): slosh, spill, refill, the flower. */
    private stepWater(): void {
        const bk = this.bucket;
        if (!this.physicsProps) {
            bk.anim[BUCKET_LITRES] = WATER.capacity;
            return;
        }
        const pb = this.physics.bodies.get(bk.id);
        if (!pb) return;
        const st = this.stage;
        // the flower stage, and after the win too (more water is welcome)
        const flower = st?.flower ?? null;
        this.water.goalMet = this.progress.goalReached;
        this.water.stage = this.progress.step;
        for (const text of this.water.step(pb, bk.pose, bk.anim, flower))
            this.events.push({ tick: this.tick, kind: 'water', text });
    }

    /** The current tutorial step's text ("" when the level has none or all are done). */
    get stepText(): string {
        const steps = this.level.rules?.steps;
        if (!steps || this.progress.step >= steps.length) return '';
        return steps[this.progress.step].text;
    }

    /** Tutorial steps, in order, judged on player 1 (and any player for reach/jump/grab). */
    private applySteps(rules: NonNullable<LevelDef['rules']>): void {
        const steps = rules.steps;
        if (!steps || this.progress.step >= steps.length) return;
        const p = this.player;
        if (this.fpActive) {
            if (this.lastLookYaw !== null) this.lookAccum += Math.abs(p.yaw - this.lastLookYaw) + 0;
            this.lastLookYaw = p.yaw;
            if (!p.grounded && p.y > this.level.terrainHeight(p.x, p.z) + 0.35) this.jumped = true;
        }
        const st = steps[this.progress.step];
        const inRect = (r: { minX: number; maxX: number; minZ: number; maxZ: number }, x: number, z: number) =>
            x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ;
        const anyPlayer = (f: (i: number) => boolean) => this.players.some((_, i) => this.playerActive(i) && f(i));
        let done = false;
        switch (st.kind) {
            case 'look':
                done = this.lookAccum > 1.2;
                break;
            case 'reach':
                done = anyPlayer((i) => inRect(st.rect, this.players[i].x, this.players[i].z));
                break;
            case 'jump':
                done = this.jumped;
                break;
            case 'grab': {
                const want = st.entity ? this.entities.find((e) => e.name === st.entity)?.id : undefined;
                done = anyPlayer((i) => {
                    const h = this.physics.heldIdOf(i);
                    return h >= 0 && (want === undefined || h === want);
                });
                break;
            }
            case 'place': {
                const e = this.entities.find((x) => x.name === st.entity);
                const b = e ? this.physics.bodies.get(e.id) : undefined;
                if (e && b) {
                    const v = b.body.linvel();
                    done =
                        inRect(st.rect, e.pose.p.x, e.pose.p.z) &&
                        Math.hypot(v.x, v.y, v.z) < 0.5 &&
                        this.physics.holders(e.id) === 0;
                }
                break;
            }
            case 'goal':
                done = this.progress.goalReached;
                break;
        }
        if (!done) return;
        this.progress.step++;
        const last = this.progress.step >= steps.length;
        this.events.push({
            tick: this.tick,
            kind: last ? 'goal' : 'step',
            text: last ? 'Tutorial complete! Now try the Valley.' : `✓ ${st.text.replace(/\.$/, '')}`
        });
        this.jumped = false;
    }

    // ------------------------------------------------------------------------------- wood

    /** Logging and the sawmill, after the physics step (src/sim/forestry.ts, sawmill.ts). */
    private stepWood(): void {
        const feet: { x: number; z: number }[] = [];
        for (let i = 0; i < this.players.length; i++)
            if (this.playerActive(i) && this.seatOf(i) < 0) feet.push(this.players[i]);
        const props = this.propEntities;
        this.forestry.step(this.tick, (x, z, r) => {
            for (const f of feet) if (Math.hypot(f.x - x, f.z - z) < r) return true;
            for (const e of props) if (e.visible && Math.hypot(e.pose.p.x - x, e.pose.p.z - z) < r) return true;
            return false;
        });
        this.sawmill?.step(feet);
        for (const text of this.forestry.drain()) this.events.push({ tick: this.tick, kind: 'wood', text });
    }

    // ------------------------------------------------------------------------------- the ute

    /** The ute entity's pose and wheel animation from the vehicle; the driver rides in the seat. */
    private readVehicle(): void {
        const v = this.vehicle;
        if (!v) return;
        const u = this.ute;
        this.physics.readPose(u.id, u.pose);
        u.anim[UTE_WHEEL_SPIN] = v.spin;
        u.anim[UTE_STEER] = v.steer;
        u.anim[UTE_SUSPENSION] = 0;
        u.anim[UTE_PITCH] = 0;
        u.anim[UTE_ROLL] = 0;
        for (let w = 0; w < 4; w++) u.anim[UTE_DROP_0 + w] = Math.max(-0.15, Math.min(0.2, v.wheelDrop(w)));
        u.visible = true;
        for (let k = 0; k < this.seats.length; k++) if (this.seats[k] >= 0) this.seatPlayer(this.seats[k], k);
    }

    /**
     * Recovery (#46): an overturned or stuck ute never loses the run. Each tick it stands level on
     * all four wheels on solid ground, the spot is kept as its safe point; tipped over and still
     * for a moment, it rights itself where it is; the driver's drop (Q, B, the drop button) puts
     * it back on its safe point. Out of the world, the physics puts it back at its spawn.
     */
    private watchUte(): void {
        const v = this.vehicle;
        if (!v) return;
        const body = v.pb.body;
        const q = this.ute.pose.q;
        // the ute's up axis, y component
        const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
        const lv = body.linvel();
        const still = Math.hypot(lv.x, lv.y, lv.z) < 1;
        let level = upY > 0.95;
        for (let w = 0; w < 4 && level; w++) level = v.wheelInContact(w) && v.groundIds[w] < 0;
        if (level && Math.abs(v.speed()) < 4) {
            this.uteSafe.p.x = this.ute.pose.p.x;
            this.uteSafe.p.y = this.ute.pose.p.y;
            this.uteSafe.p.z = this.ute.pose.p.z;
            this.uteSafeYaw = uteYaw(q);
            this.uteSafeSet = true;
        }
        this.uteTipped = upY < 0.5 && still ? this.uteTipped + 1 : 0;
        if (this.uteTipped >= UTE_RIGHTING_TICKS) {
            this.uteTipped = 0;
            const p = this.ute.pose.p;
            this.physics.place(v.id, pose(p.x, p.y + 0.8, p.z, quatFromYawPitchRoll(uteYaw(q), 0, 0)));
            this.events.push({ tick: this.tick, kind: 'ute', text: 'The ute is back on its wheels.' });
        }
    }

    /** The driver asked: the ute goes back to the last place it stood level on solid ground. */
    private recoverUte(): void {
        const v = this.vehicle;
        if (!v) return;
        if (this.uteSafeSet) {
            const p = this.uteSafe.p;
            this.physics.place(v.id, pose(p.x, p.y + 0.3, p.z, quatFromYawPitchRoll(this.uteSafeYaw, 0, 0)));
        } else this.physics.respawn(v.id);
        this.uteTipped = 0;
        this.events.push({ tick: this.tick, kind: 'ute', text: 'The ute is back where it last stood on firm ground.' });
    }

    /** Ute-local point to world. */
    private uteToWorld(lx: number, ly: number, lz: number, out: { x: number; y: number; z: number }) {
        const q = this.ute.pose.q;
        quatRotate(q, lx, ly, lz, out);
        out.x += this.ute.pose.p.x;
        out.y += this.ute.pose.p.y;
        out.z += this.ute.pose.p.z;
        return out;
    }

    /** Puts a seated player's body in their seat (the eye where a sitting beaver's would be). */
    private seatPlayer(i: number, seat: number): void {
        const p = this.players[i];
        const st = UTE_SEATS[seat];
        const e = this.uteToWorld(st.x, st.eyeY, st.z, _v);
        p.x = e.x;
        p.y = e.y - EYE_HEIGHT;
        p.z = e.z;
        p.vy = 0;
        p.speed = 0;
        p.grounded = true;
        p.eyeLift = 0;
        p.fallTicks = 0;
    }

    /**
     * Grab with nothing grabbable in view, looking at the ute: get in. You take the seat on your side
     * (the driver's on the ute's right), or the other one if yours is taken.
     */
    private enterUte(i: number, eye: { x: number; y: number; z: number }, cmd: PlayerCommand): boolean {
        if (!this.vehicle || !this.seats.includes(-1)) return false;
        if (this.physics.probeAny(eye, cmd.yaw, cmd.pitch, i) !== this.ute.id) return false;
        // which side of the ute you stand on: its local x (+ left, - right)
        const u = this.ute.pose;
        const q = u.q;
        quatRotate({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, eye.x - u.p.x, 0, eye.z - u.p.z, _v);
        const want = _v.x < 0 ? 0 : 1;
        return this.takeSeat(i, this.seats[want] < 0 ? want : 1 - want);
    }

    /** Tick the loose-beam hint was last given (it repeats at most every 30 s). */
    private looseHintTick = -Infinity;

    /**
     * Driving onto a beam that is nailed down nowhere (Epic 5): one line saying a bare beam bridge
     * wants nailing. Loose, the wheels shove a beam aside where it meets the bank's lip.
     */
    private looseBeamHint(): void {
        const v = this.vehicle;
        if (!v || this.driver < 0 || this.tick - this.looseHintTick < 30 * 60) return;
        for (const id of v.groundIds) {
            if (id < 0) continue;
            const e = this.entities.find((x) => x.id === id);
            if (!e || !/^beam-\d+$/.test(e.name)) continue;
            if (this.joints.graph.of(id).some((c) => c.b === GROUND)) continue;
            this.looseHintTick = this.tick;
            this.events.push({
                tick: this.tick,
                kind: 'ute',
                text: 'Loose beams shift under the ute: nail each beam down at both ends to drive across.'
            });
            return;
        }
    }

    /** Puts a player in the driver's seat (if it is free); also for tests and scripted starts. */
    takeDriverSeat(i: number): boolean {
        return this.takeSeat(i, 0);
    }

    /** Puts a player in a seat (0 driver, 1 passenger) if it is free. */
    takeSeat(i: number, seat: number): boolean {
        if (!this.vehicle || this.seats[seat] !== -1 || this.seatOf(i) >= 0 || !this.playerActive(i)) return false;
        this.physics.release(i);
        this.seats[seat] = i;
        if (seat === 0) this.driveInput = { ...NO_DRIVE };
        this.physics.setCharacterEnabled(false, i);
        this.seatPlayer(i, seat);
        const who = this.playerCount > 1 ? `Player ${i + 1}: ` : '';
        this.events.push({
            tick: this.tick,
            kind: 'ute',
            text: seat === 0 ? `${who}In the driver’s seat. E to get out.` : `${who}Riding along. E to get out.`
        });
        return true;
    }

    /** Gets out on your seat's side, onto the ground beside the door. */
    private leaveUte(i: number): void {
        const st = UTE_SEATS[Math.max(0, this.seatOf(i))];
        const d = this.uteToWorld(st.exitX, 0, st.z, _v);
        const yaw = this.players[i].yaw;
        this.vacateSeat(i);
        this.placePlayer(d.x, d.z, yaw, i);
    }

    private vacateSeat(i: number): void {
        const seat = this.seatOf(i);
        if (seat < 0) return;
        this.seats[seat] = -1;
        if (seat === 0) this.driveInput = { ...NO_DRIVE };
        if (this.playerActive(i)) this.physics.setCharacterEnabled(true, i);
    }

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
        if (actors.beaver.mode === 'none') {
            const b = this.beaver;
            b.visible = false;
            b.pose.p.x = 0;
            b.pose.p.y = -100;
            b.pose.p.z = 0;
        }
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
            b.anim[BEAVER_WALK_PHASE] = (this.beaverDist / BODY.stride) * Math.PI * 2;
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

            const hand = BODY.leftHand(b.pose, b.anim, _hand);
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
        this.evaluateWindsock(t);
        if (!this.physicsProps) this.evaluateScriptedProps(t);
    }

    /** The windsock turns downwind and lifts with the wind speed (limp when calm). */
    private evaluateWindsock(t: number): void {
        const ws = this.windsock;
        const spot = this.level.windsock;
        ws.visible = !!spot && !!this.level.wind;
        if (!spot || !this.level.wind) return;
        const w = windAt(t, this.level.wind, _windTmp);
        let a = Math.atan2(w.z, w.x) + 0.06 * Math.sin(t * 5.3) * w.gustiness;
        let droop = (1 - Math.min(1, w.speed / 5.5)) * 1.15 + 0.04 * Math.sin(t * 7.1);
        // the aimed gust's tell: the sock swings round to it and stands out, flapping
        const hz = this.hazards;
        if (hz.gustPhase !== PHASE.idle) {
            const k = Math.min(1, hz.gustT / 30);
            const ga = Math.atan2(hz.gustDirZ, hz.gustDirX);
            let d = ga - a;
            d = Math.atan2(Math.sin(d), Math.cos(d));
            a += d * k + 0.15 * Math.sin(t * 13) * k;
            droop = droop * (1 - k) + 0.05 * k;
        }
        ws.pose.p.x = spot.x;
        ws.pose.p.y = this.level.terrainHeight(spot.x, spot.z) + spot.height;
        ws.pose.p.z = spot.z;
        // +X points downwind (a rotation of -a about Y), then the tip droops (about local Z)
        quatFromAxisAngle(0, 1, 0, -a, _q);
        quatFromAxisAngle(0, 0, 1, -droop, _q2);
        quatMul(_q, _q2, ws.pose.q);
    }

    private evaluateUte(t: number): void {
        const ute = this.level.actors.ute;
        // the vehicle's pose comes from its physics (readVehicle)
        if (this.vehicle) return;
        if (ute.mode === 'none') {
            this.ute.visible = false;
            this.ute.pose.p.x = 0;
            this.ute.pose.p.y = -100;
            this.ute.pose.p.z = 0;
            return;
        }
        if (ute.mode === 'parked' || ute.mode === 'drivable') {
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
        const eyes = this.eyes;
        for (let i = 0; i < MAX_PLAYERS; i++) {
            const p = this.players[i];
            const e = eyes[i];
            e.pose.p.x = p.x;
            e.pose.p.y = p.y + p.eyeLift + EYE_HEIGHT;
            e.pose.p.z = p.z;
            e.visible = this.playerActive(i);
            // voxel beaver bodies, your own included: each device draws its own player's beaver
            // without the head (BEAVER_FIRST_PERSON, set by the renderer), so you see your body,
            // arms and hands. In split screen the heads stay: from inside your own head every face
            // points away, so it never blocks your view.
            const a = this.avatars[i];
            a.visible = this.playerActive(i);
            if (!a.visible) continue;
            a.pose.p.x = p.x;
            a.pose.p.y = p.y;
            a.pose.p.z = p.z;
            // the beaver faces +Z at yaw 0, the camera -Z
            quatFromYawPitchRoll(p.yaw + Math.PI, 0, 0, a.pose.q);
            const walk = Math.min(1, p.speed / CHARACTER.walk);
            a.anim[BEAVER_WALK_PHASE] = (p.walkDist / BODY.stride) * Math.PI * 2;
            a.anim[BEAVER_WALK_AMOUNT] = p.grounded ? walk : 0.3;
            const holding = this.physics.heldInfo(i, _held);
            a.anim[BEAVER_CARRY] = holding ? 1 : 0;
            // arms aim at the grip, lunge, dip under weight, fling on throws (player-anim.ts)
            const ev = this.animEvents[i];
            const o = this.animators[i].step(
                {
                    x: p.x,
                    y: p.y,
                    z: p.z,
                    yaw: p.yaw,
                    pitch: p.pitch,
                    grounded: p.grounded,
                    vy: this.landingVy[i],
                    walkAmount: walk,
                    walkPhase: a.anim[BEAVER_WALK_PHASE],
                    held: holding ? _held : null,
                    events: ev
                },
                SIM_DT,
                _animOut
            );
            ev.grabbed = ev.missed = ev.thrown = ev.dropped = ev.balked = false;
            a.anim[BEAVER_ARM_RAISE] = o.raise;
            a.anim[BEAVER_ARM_REACH] = o.reach;
            a.anim[BEAVER_ARM_SPREAD] = o.spread;
            a.anim[BEAVER_LEAN] = o.lean;
            a.anim[BEAVER_HEAD_PITCH] = o.headPitch;
            a.anim[BEAVER_FIRST_PERSON] = 0;
            a.anim[BEAVER_HEAD_YAW] = 0;
        }
    }

    private publish(): void {
        this.publishPlayer();
        const buf = this.ring.beginWrite(this.tick);
        for (const e of this.entities) writeEntity(buf, e.slot, e.pose, e.visible, e.anim, ANIM_MAX);
    }

    /** Places the character (e.g. when entering first-person mode), on the ground, inside the play area. */
    placePlayer(x: number, z: number, yaw: number, i = 0): void {
        if (this.seatOf(i) >= 0) this.vacateSeat(i);
        const p = this.players[i];
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
        this.physics.placeCharacter(p.x, p.y, p.z, i);
        if (i === 0) this.lastCmd = { ...this.lastCmd, yaw };
        else this.lastCmds[i] = { ...this.lastCmds[i], yaw };
    }

    /** Read-only, for UI: what the player is holding and what the crosshair would grab. */
    interaction(i = 0): {
        holding: string | null;
        target: string | null;
        shared: boolean;
        driving: boolean;
        seat: number;
        nail: number;
    } {
        const ids = this.interactionIds(i);
        const name = (id: number) => (id < 0 ? null : (this.entities.find((e) => e.id === id)?.name ?? null));
        return {
            holding: name(ids.held),
            target: name(ids.target),
            shared: ids.shared,
            driving: ids.driving,
            seat: ids.seat,
            nail: ids.nail
        };
    }

    /** What a hammer blow by player i would do now (read-only; a 'none' refusal with a >= 0 means it holds). */
    nailPreview(i = 0): NailPreview | null {
        if (!this.playerActive(i) || !this.physicsProps || this.seatOf(i) >= 0) return null;
        const p = this.players[i];
        return this.joints.preview({ x: p.x, y: p.y + EYE_HEIGHT, z: p.z }, p.yaw, p.pitch, i);
    }

    /**
     * Like `interaction`, as entity ids (-1 for none): what the host sends to guests for their
     * prompts. The target is what a grab would do: a grabbable thing, or the ute (get in) when its
     * driver's seat is free.
     */
    interactionIds(i: number): {
        held: number;
        target: number;
        shared: boolean;
        driving: boolean;
        seat: number;
        /** The hammer (nailCode) and where its nail would go. */
        nail: number;
        nailAt: Vec3 | null;
    } {
        const none = { held: -1, target: -1, shared: false, driving: false, seat: -1, nail: 0, nailAt: null };
        if (!this.playerActive(i) || !this.physicsProps) return none;
        const seat = this.seatOf(i);
        if (seat >= 0) return { ...none, driving: seat === 0, seat };
        const pw = this.physics;
        const p = this.players[i];
        const held = pw.heldIdOf(i);
        const eye = { x: p.x, y: p.y + EYE_HEIGHT, z: p.z };
        let target = held >= 0 ? -1 : pw.probe(eye, p.yaw, p.pitch, i);
        // what a grab would cut (a stand tree with empty hands; a tree or a log with the axe)
        if (target < 0) target = this.forestry.aim(eye, p.yaw, p.pitch, i, held);
        // the sawmill's mode lever (with empty hands)
        if (target < 0 && held < 0 && this.sawmill?.aimLever(eye, p.yaw, p.pitch)) target = this.sawmill.entity.id;
        if (
            held < 0 &&
            target < 0 &&
            this.vehicle &&
            this.seats.includes(-1) &&
            pw.probeAny(eye, p.yaw, p.pitch, i) === this.ute.id
        )
            target = this.ute.id;
        const pv = this.nailPreview(i);
        return {
            held,
            target,
            shared: held >= 0 && pw.holders(held) > 1,
            driving: false,
            seat: -1,
            nail: pv ? nailCode(pv.a, pv.refusal) : 0,
            nailAt: pv && pv.a >= 0 && pv.refusal !== 'not-timber' ? { ...pv.head } : null
        };
    }

    /** True when the voxelized dummy is in the world. */
    get dummyActive(): boolean {
        return this.dummy[0].visible;
    }
}

/** How long the flower waits after the last water reaches it before it counts the pour (ticks). */
export const POUR_DONE_TICKS = 45;

/** Positive feedback for arriving with more water (design doc §2.8). */
function waterPraise(litres: number): string {
    if (litres >= 8) return ' Hardly a drop spilled.';
    if (litres >= 4) return ' A good drink.';
    if (litres >= 1) return ' Every drop counts.';
    return ' Just enough.';
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
const _windTmp: WindSample = { x: 0, z: 0, speed: 0, gustiness: 0 };
const _q = { x: 0, y: 0, z: 0, w: 1 };
const _q2 = { x: 0, y: 0, z: 0, w: 1 };
const _v = vec3();
const _target = pose();
const _offset = pose();

export { BEAVER_ANIM_CHANNELS, UTE_ANIM_CHANNELS };

const _held: HeldInfo = { x: 0, y: 0, z: 0, mass: 0, halfWidth: 0, strain: 0 };
const _animOut: AnimOutput = { raise: 0, reach: 0, spread: 0, lean: 0, headPitch: 0 };

export interface PlayerState {
    x: number;
    y: number;
    z: number;
    vy: number;
    yaw: number;
    pitch: number;
    grounded: boolean;
    eyeLift: number;
    /** Horizontal speed and distance walked (for the voxel beaver's walk cycle). */
    speed: number;
    walkDist: number;
    prevCarry: boolean;
    fallTicks: number;
    safe: { x: number; z: number; valid: boolean };
}

function newPlayerState(x: number, z: number): PlayerState {
    return {
        x,
        y: 0.5,
        z,
        vy: 0,
        yaw: 0,
        pitch: 0,
        grounded: true,
        eyeLift: 0,
        speed: 0,
        walkDist: 0,
        prevCarry: false,
        fallTicks: 0,
        safe: { x, z, valid: false }
    };
}

/** The handbrake (nobody in the driver's seat). */
const PARKED: DriveInput = { throttle: 0, steer: 0, brake: true };

/**
 * The seats in the ute's frame (+z forward): the driver on the right (right-hand drive, -x), a
 * passenger on the left; the eye under the cab roof (1.48 m); you get out a step beyond your door.
 */
export const UTE_SEATS = [
    { x: -0.36, eyeY: 1.32, z: 0.12, exitX: -1.45 },
    { x: 0.36, eyeY: 1.32, z: 0.12, exitX: 1.45 }
] as const;
/** How long a tipped-over ute lies still before it rights itself (ticks). */
export const UTE_RIGHTING_TICKS = 90;

/** Heading of a ute pose (rad, about +y; 0 faces +z). */
function uteYaw(q: { x: number; y: number; z: number; w: number }): number {
    return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
}

/** The driver's seat. */
export const UTE_SEAT = UTE_SEATS[0];
