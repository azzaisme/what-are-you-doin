/**
 * Hazard (#78): a goose goes for the bucket. A goose keeps a patch of bank by the creek; carry the
 * bucket near it and it sees the bucket, honks, and comes for it.
 *
 * - **Trigger:** a player carrying the bucket within GOOSE.notice of its patch, the goose at home.
 *   Through the director's budget (one hazard at a time, the quiet start and spells), at most
 *   GOOSE.max a run, GOOSE.cooldownS apart.
 * - **Tell:** a honk and a toast, and the goose rears up: neck tall, wings spread, beak open, for
 *   GOOSE.tellS without moving. Only then does it come, at a goose's run (faster than a walk,
 *   slower than a beaver's run), turning only so fast: the tell is always at least GOOSE.tellS
 *   before it could peck.
 * - **What happens:** reaching the bucket in its bearer's hands (GOOSE.peck), it pecks: the bucket
 *   is knocked out of their hands with a shove, and spills what the bucket's own water spills.
 *   Water and time, never the run. Then it waddles home.
 * - **Counterplay:** put the bucket down (a bucket nobody holds is no business of the goose's: it
 *   honks once and goes home); distract it (another player, not carrying the bucket, who comes
 *   within GOOSE.distract of it draws it off for GOOSE.distractS, harmlessly, and then it goes
 *   home); or dodge it (outrun it, or sidestep: it turns slowly). It gives up at the edge of its
 *   territory, or after GOOSE.chaseS.
 * - **Over** when it is back on its patch. No timer on the player.
 *
 * The goose has no physics body: the sim moves it over the ground (it cannot shove props or be
 * launched), within its territory (the level says where it may go: never into the water). Host
 * only, like the rest of the director: guests see it (an entity: its pose and channels) in the
 * snapshots and hear the honk from the toasts (src/audio/game-audio.ts).
 */

import type { Pose } from '../voxels/math.ts';

import type { PhysicsWorld } from './physics/world.ts';

const S = (s: number) => Math.round(s * 60);
const DT = 1 / 60;

export const GOOSE = {
    /** A bucket carried within this far (m) of the patch is noticed (from its stump, 4.3 m in the yard). */
    notice: 5,
    /** Rearing up and honking, standing still (s): the tell. */
    tellS: 2,
    /**
     * A goose's run (m/s): more than a walk (2.2), less than a beaver running with the bucket
     * (measured by input: 3.8-4.2 alone, 3.6-4.1 carrying it together). And going home.
     */
    speed: 3.2,
    homeSpeed: 1.4,
    accel: 6,
    /** How fast it turns (rad/s): a sidestep makes it overshoot. */
    turn: 2.6,
    /** Its beak within this far (m, horizontally) of the carried bucket: a peck. */
    peck: 0.7,
    /** The shove the bucket gets (m/s, away from the goose and up). */
    shove: 1,
    lift: 0.5,
    /** Another player within this far (m) of it, not carrying the bucket, draws it off, for this long. */
    distract: 2,
    distractS: 4,
    /** It gives up chasing after this long (s), or at the edge of its territory. */
    chaseS: 8,
    /** Home within this far (m) of the patch. */
    home: 0.3,
    cooldownS: 60,
    max: 2
} as const;

export const GOOSE_PHASE = { idle: 0, tell: 1, chase: 2, distracted: 3, home: 4 } as const;

/** The toasts (every device plays the honk from them: src/audio/game-audio.ts). */
export const GOOSE_TELL = '🪿 HONK! The goose has seen your bucket. Put it down, dodge, or get someone to distract it!';
export const GOOSE_PECK = '🪿 Peck! The goose knocked the bucket out of your hands.';
export const GOOSE_BORED = '🪿 Honk. The goose has lost interest.';
export const GOOSE_DECOY = '🪿 HONK! The goose has turned on someone else.';

/** The goose's channels: its gait (a walk cycle, 0..1 repeating), neck up, wings spread, beak open. */
export const GOOSE_GAIT = 0;
export const GOOSE_NECK = 1;
export const GOOSE_WINGS = 2;
export const GOOSE_BEAK = 3;

/** Where it lives, in the level's own terms. */
export interface GooseSpec {
    /** Its patch (where it sits, m) and the way it faces there (rad, yaw). */
    x: number;
    z: number;
    yaw: number;
    /** Where it may go (its territory: dry ground near its patch). */
    allowed: (x: number, z: number) => boolean;
    /** The ground's height there. */
    ground: (x: number, z: number) => number;
}

export interface GooseEntity {
    pose: Pose;
    anim: Float64Array;
    visible: boolean;
}

export interface GooseHost {
    readonly tick: number;
    readonly physics: PhysicsWorld;
    readonly goose: GooseEntity;
    readonly bucketId: number;
    /** Players on their feet (slot, where), and the body each holds (-1: none). */
    readonly players: readonly { slot: number; x: number; z: number; held: number }[];
    say(text: string): void;
}

export class GooseHazard {
    phase: number = GOOSE_PHASE.idle;
    count = 0;
    /** Where it is, which way it faces and how fast it goes. */
    x = 0;
    z = 0;
    yaw = 0;
    speed = 0;
    /** Who it is after (player slot, -1: nobody), since when (tick). */
    target = -1;
    since = 0;
    /** Telemetry for the tests: when the tell came and the last peck. */
    tellTick = -1;
    peckTick = -1;
    private ended = -1e9;
    private gait = 0;
    private neck = 0;
    private wings = 0;
    private beak = 0;
    private readonly spec: GooseSpec;

    constructor(spec: GooseSpec) {
        this.spec = spec;
        this.reset();
    }

    reset(): void {
        this.phase = GOOSE_PHASE.idle;
        this.count = 0;
        this.x = this.spec.x;
        this.z = this.spec.z;
        this.yaw = this.spec.yaw;
        this.speed = 0;
        this.target = -1;
        this.since = 0;
        this.tellTick = this.peckTick = -1;
        this.ended = -1e9;
        this.gait = this.neck = this.wings = this.beak = 0;
    }

    get busy(): boolean {
        return this.phase !== GOOSE_PHASE.idle;
    }

    /** One tick; `mayStart` is the director's budget. */
    step(h: GooseHost, mayStart: boolean): void {
        const sp = this.spec;
        const t = h.tick;
        const bearer = h.players.find((p) => p.held === h.bucketId);
        // at rest it stands alert (neck half up)
        let wantNeck = 0.5;
        let wantWings = 0;
        let beak = 0;
        let moveTo: { x: number; z: number } | null = null;
        let top = 0;

        if (this.phase === GOOSE_PHASE.idle) {
            if (
                mayStart &&
                bearer &&
                this.count < GOOSE.max &&
                t - this.ended >= S(GOOSE.cooldownS) &&
                Math.hypot(bearer.x - sp.x, bearer.z - sp.z) <= GOOSE.notice
            ) {
                this.phase = GOOSE_PHASE.tell;
                this.since = t;
                this.target = bearer.slot;
                this.tellTick = t;
                this.count++;
                h.say(GOOSE_TELL);
            }
        }
        if (this.phase === GOOSE_PHASE.tell) {
            // rear up, facing the bucket, honking (beak open and shut)
            const who = h.players.find((p) => p.slot === this.target);
            if (who) this.face(who.x, who.z);
            wantNeck = 1;
            wantWings = 1;
            beak = Math.sin(((t - this.since) / 60) * Math.PI * 4) > 0 ? 1 : 0;
            if (t - this.since >= S(GOOSE.tellS)) {
                this.phase = GOOSE_PHASE.chase;
                this.since = t;
            }
        }
        if (this.phase === GOOSE_PHASE.chase) {
            const who = h.players.find((p) => p.slot === this.target);
            // someone else close by, not carrying the bucket, draws it off
            const decoy = h.players.find(
                (p) => p.slot !== this.target && p.held !== h.bucketId && this.dist(p.x, p.z) <= GOOSE.distract
            );
            if (decoy) {
                this.phase = GOOSE_PHASE.distracted;
                this.target = decoy.slot;
                this.since = t;
                h.say(GOOSE_DECOY);
            } else if (!who || who.held !== h.bucketId) {
                // put down (or handed over): no business of the goose's
                this.goHome(h, true);
            } else if (t - this.since >= S(GOOSE.chaseS) || !sp.allowed(who.x, who.z)) {
                this.goHome(h, true);
            } else {
                moveTo = who;
                top = GOOSE.speed;
                wantNeck = 0.6;
                wantWings = 0.5;
                beak = 1;
                // the peck: its beak, ahead of it, at the bucket
                const bp = h.physics.bodies.get(h.bucketId)?.body.translation();
                if (bp) {
                    const bx = this.x + Math.sin(this.yaw) * 0.35;
                    const bz = this.z + Math.cos(this.yaw) * 0.35;
                    if (Math.hypot(bp.x - bx, bp.z - bz) <= GOOSE.peck) this.peckBucket(h, bp);
                }
            }
        }
        if (this.phase === GOOSE_PHASE.distracted) {
            const who = h.players.find((p) => p.slot === this.target);
            if (!who || t - this.since >= S(GOOSE.distractS)) this.goHome(h, false);
            else {
                moveTo = who;
                top = GOOSE.speed;
                wantNeck = 0.6;
                wantWings = 0.7;
                beak = 1;
            }
        }
        if (this.phase === GOOSE_PHASE.home) {
            if (this.dist(sp.x, sp.z) <= GOOSE.home) {
                this.phase = GOOSE_PHASE.idle;
                this.ended = t;
                this.target = -1;
                this.speed = 0;
            } else {
                moveTo = sp;
                top = GOOSE.homeSpeed;
            }
        }
        if (this.phase === GOOSE_PHASE.idle && !moveTo) this.turnTowards(sp.yaw);

        // move: turn so fast, speed up so fast, only where it may go
        if (moveTo) {
            this.face(moveTo.x, moveTo.z, GOOSE.turn * DT);
            this.speed = Math.min(top, this.speed + GOOSE.accel * DT);
        } else this.speed = Math.max(0, this.speed - GOOSE.accel * DT);
        if (this.speed > 0) {
            const nx = this.x + Math.sin(this.yaw) * this.speed * DT;
            const nz = this.z + Math.cos(this.yaw) * this.speed * DT;
            if (sp.allowed(nx, nz)) {
                this.x = nx;
                this.z = nz;
            } else if (sp.allowed(nx, this.z)) this.x = nx;
            else if (sp.allowed(this.x, nz)) this.z = nz;
            else this.speed = 0;
        }

        // the entity
        const k = 1 / S(0.25);
        this.neck += Math.max(-k, Math.min(k, wantNeck - this.neck));
        this.wings += Math.max(-k, Math.min(k, wantWings - this.wings));
        this.beak = beak;
        this.gait = (this.gait + this.speed * DT * 1.6) % 1;
        const g = h.goose;
        g.pose.p.x = this.x;
        g.pose.p.y = sp.ground(this.x, this.z);
        g.pose.p.z = this.z;
        const half = this.yaw / 2;
        g.pose.q.x = 0;
        g.pose.q.y = Math.sin(half);
        g.pose.q.z = 0;
        g.pose.q.w = Math.cos(half);
        g.anim[GOOSE_GAIT] = this.gait;
        g.anim[GOOSE_NECK] = this.neck;
        g.anim[GOOSE_WINGS] = this.wings;
        g.anim[GOOSE_BEAK] = this.beak;
        g.visible = true;
    }

    private dist(x: number, z: number): number {
        return Math.hypot(x - this.x, z - this.z);
    }

    /** Turn towards a point, at most `max` (rad) this tick (no limit: at once). */
    private face(x: number, z: number, max = Infinity): void {
        if (Math.hypot(x - this.x, z - this.z) < 1e-3) return;
        this.turnTowards(Math.atan2(x - this.x, z - this.z), max);
    }

    private turnTowards(yaw: number, max = GOOSE.turn * DT): void {
        let d = yaw - this.yaw;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        this.yaw += Math.max(-max, Math.min(max, d));
        this.yaw = Math.atan2(Math.sin(this.yaw), Math.cos(this.yaw));
    }

    private goHome(h: GooseHost, honk: boolean): void {
        this.phase = GOOSE_PHASE.home;
        this.target = -1;
        if (honk) h.say(GOOSE_BORED);
    }

    /**
     * Knock the bucket out of its bearer's hands: away from the goose, and up; never out over ground
     * the goose may not go on (the water): then straight down. The bearer is not touched.
     */
    private peckBucket(h: GooseHost, bp: { x: number; y: number; z: number }): void {
        const pw = h.physics;
        pw.releaseAll(h.bucketId);
        const b = pw.bodies.get(h.bucketId)?.body;
        if (b) {
            let dx = bp.x - this.x;
            let dz = bp.z - this.z;
            const l = Math.hypot(dx, dz) || 1;
            dx /= l;
            dz /= l;
            if (!this.spec.allowed(bp.x + dx * 1.2, bp.z + dz * 1.2)) dx = dz = 0;
            const v = b.linvel();
            b.setLinvel({ x: v.x + dx * GOOSE.shove, y: v.y + GOOSE.lift, z: v.z + dz * GOOSE.shove }, true);
        }
        this.peckTick = h.tick;
        h.say(GOOSE_PECK);
        this.goHome(h, false);
    }
}
