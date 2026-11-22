/**
 * The hazard director (design doc §2.9, Epic 8, issues #71-#73): the world answers attempts at
 * success. It runs inside the simulation on the host, so it is deterministic and seeded, and it
 * schedules authored events from gameplay conditions, never random per-frame destruction:
 *
 * - **Rising river** (#72): a finished bridge (two pieces across the crossing, or one left across
 *   for 20 s) sets off the flood. Tell: a siren, the gauge post's marks going under, an upstream rumble. The water
 *   rises, floats timber and runs fast downstream. Counterplay: get the bucket across before the
 *   peak, or weigh the bridge down (a player standing on each beam, or holding them).
 *   Timber the flood takes is left on the bank downstream when the water goes down, so a flood
 *   costs time, never the run.
 * - **Gust at the carried plank** (#73): carrying a light piece near the water for a moment brings
 *   a gust aimed at it. Tell: the windsock swings round, a warning gust, leaves. The gust pushes the
 *   piece towards the water harder than one grip holds. Counterplay: lower it (the gust is weaker
 *   near the ground), carry it together (two grips hold), or put it down (resting things are left
 *   alone).
 *
 * Budget and safe windows: one hazard at a time, a quiet spell after each, a cooldown and a count
 * per hazard, nothing in the first seconds of a run or after the goal, and a gust only while
 * enough planks are still out of the creek. Guests get the state through the host (`net`).
 */

import type { LevelDef } from '../levels/level.ts';

import { SIM_HZ } from './clock.ts';
import type { SimEvent } from './lab-sim.ts';
import { GRAB } from './physics/grab.ts';
import { applyFlood, pressStanding } from './physics/water.ts';
import { GRAVITY } from './physics/world.ts';
import type { PhysicsWorld } from './physics/world.ts';

export interface FloodSpec {
    /** Water surface at the peak (m). */
    peakY: number;
    /** Current at the peak (m/s), downstream. */
    current: { x: number; z: number };
    /**
     * The crossing the flood answers (along Z): a resting, unheld piece whose ends reach past both
     * faces (z0 the near bank's, z1 the far's, z0 > z1) within `halfX` of `x` "finishes the bridge".
     */
    crossing: { x: number; halfX: number; z0: number; z1: number };
    /** Where timber the flood carried off is left when the water goes down (in order). */
    washup: { x: number; y: number; z: number }[];
}

export interface GustSpec {
    /** Push on a carried piece at full exposure (N); one grip gives 650 N, two give 1300 N. */
    force: number;
}

/** The handbrake prank (#75): a ute left parked on a slope gets its handbrake let off. */
export interface HandbrakeSpec {
    /** Least tilt (rad) that counts as a slope: the ute parked flatter than this is left alone. */
    slope: number;
}

export interface HazardSpec {
    seed: number;
    flood?: FloodSpec;
    gust?: GustSpec;
    handbrake?: HandbrakeSpec;
}

/** Timings (seconds) and budgets. */
export const HAZARD = {
    /** No hazard this early in a run. */
    graceS: 20,
    /** Quiet spell after any hazard ends. */
    safeS: 15,
    flood: {
        holdToTrigger: 1,
        /** One piece alone across the gap counts as a bridge after this long. */
        oneBeamS: 20,
        delayS: 3,
        /** Up to this much more delay, from the game's seed. */
        delayJitterS: 2,
        tellS: 8,
        riseS: 10,
        holdS: 14,
        fallS: 12,
        cooldownS: 75,
        max: 2
    },
    gust: {
        carryS: 1.5,
        /** Up to this much longer carrying, from the game's seed. */
        carryJitterS: 1,
        tearS: 0.35,
        tellS: 2.2,
        blowS: 2.0,
        cooldownS: 40,
        max: 3,
        nearWater: 4,
        maxMass: 30,
        minPlanks: 3
    },
    /** Parked (nobody driving, still) this long on a slope, the warning, how long it stays off. */
    handbrake: { parkedS: 6, tellS: 2.5, offS: 20, cooldownS: 60, max: 2 }
} as const;

export const PHASE = { idle: 0, tell: 1, active: 2, recede: 3 } as const;

/** What the host sends guests: everything the client needs to draw and sound the hazards. */
export interface HazardNet {
    /** Water surface now (m). */
    waterY: number;
    flood: number;
    gust: number;
    /** Gust direction (rad in XZ, 0 = +X) and its target player slot. */
    gustDir: number;
    gustSlot: number;
    /** The handbrake prank's phase (tell: the ratchet clicking; active: the brake is off). */
    brake: number;
}

/** The parts of the simulation the director reads and acts on. */
export interface HazardHost {
    readonly tick: number;
    readonly physics: PhysicsWorld;
    readonly level: LevelDef;
    readonly players: readonly { x: number; y: number; z: number; grounded: boolean }[];
    seatOf(i: number): number;
    readonly events: SimEvent[];
    readonly progress: { goalReached: boolean };
    readonly bucket: { id: number; pose: { p: { x: number; y: number; z: number } } };
    readonly entities: readonly { id: number; name: string }[];
    isSlotActive(i: number): boolean;
    /** The drivable ute (its body) and who drives it (-1: nobody). */
    readonly vehicle: { pb: { body: { rotation(): Quat4; linvel(): Vec3 } }; chocked(): boolean } | null;
    readonly driver: number;
}

interface Quat4 {
    x: number;
    y: number;
    z: number;
    w: number;
}
interface Vec3 {
    x: number;
    y: number;
    z: number;
}

const S = (s: number) => Math.round(s * SIM_HZ);
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

export class HazardDirector {
    readonly spec: HazardSpec | undefined;
    private readonly baseY: number;
    /** Surface height now and the flood's rise above normal. */
    waterY: number;
    rise = 0;
    /** Phase and ticks spent in it. */
    floodPhase: number = PHASE.idle;
    floodT = 0;
    floodCount = 0;
    gustPhase: number = PHASE.idle;
    gustT = 0;
    gustCount = 0;
    gustSlot = -1;
    gustBody = -1;
    gustDirX = 0;
    gustDirZ = 0;
    /** The last tick any hazard was running, and when each last ended. */
    private quietFrom = 0;
    private floodEnded = -1e9;
    private gustEnded = -1e9;
    /** Ticks a piece has lain across the crossing; ticks each player has carried near the water. */
    private spanTicks = 0;
    private spanOneTicks = 0;
    /**
     * The game's seed (the host picks one per game and sends it to guests): it varies the flood's
     * delay, how long a carry takes to bring a gust, and the gust's direction. Set before a reset.
     */
    seed: number;
    private floodPending = -1;
    private readonly carryTicks: number[] = [];
    /** Bodies the flood touched this time (washed up when it ends). */
    private readonly floodTouched = new Set<number>();
    /** Telemetry: the largest push the gust gave (N) and pieces the flood moved. */
    lastGustForce = 0;
    floodMoved = 0;
    private gustOver = 0;
    /** The handbrake prank: phase, ticks in it, count, how long the ute has stood parked. */
    brakePhase: number = PHASE.idle;
    brakeT = 0;
    brakeCount = 0;
    private brakeEnded = -1e9;
    private parkedTicks = 0;

    /** A prop stands against a downhill tyre (#75): the ute stays put with its handbrake off. */
    chocked = false;

    /** The ute's handbrake has been let off and nothing chocks it: it is driven with no brake. */
    get handbrakeOff(): boolean {
        return this.brakePhase === PHASE.active && !this.chocked;
    }

    /** `enabled` false: no hazards at all (tests of other mechanics in hazard levels). */
    constructor(level: LevelDef, enabled = true) {
        this.spec = enabled ? level.hazards : undefined;
        this.seed = level.hazards?.seed ?? 1;
        this.baseY = level.water.y;
        this.waterY = this.baseY;
    }

    reset(): void {
        this.waterY = this.baseY;
        this.rise = 0;
        this.floodPhase = this.gustPhase = PHASE.idle;
        this.floodT = this.gustT = 0;
        this.floodCount = this.gustCount = 0;
        this.gustSlot = this.gustBody = -1;
        this.quietFrom = 0;
        this.floodEnded = this.gustEnded = -1e9;
        this.spanTicks = this.spanOneTicks = 0;
        this.floodPending = -1;
        this.carryTicks.length = 0;
        this.floodTouched.clear();
        this.lastGustForce = 0;
        this.floodMoved = 0;
        this.gustOver = 0;
        this.brakePhase = PHASE.idle;
        this.brakeT = this.brakeCount = this.parkedTicks = 0;
        this.chocked = false;
        this.brakeEnded = -1e9;
    }

    /** Is any hazard telling or running? */
    get busy(): boolean {
        return (
            this.floodPhase !== PHASE.idle ||
            this.gustPhase !== PHASE.idle ||
            this.brakePhase !== PHASE.idle ||
            this.floodPending >= 0
        );
    }

    /** 0..1: the flood's strength (0 at normal level, 1 at the peak). */
    get floodLevel(): number {
        const f = this.spec?.flood;
        return f ? this.rise / Math.max(1e-6, f.peakY - this.baseY) : 0;
    }

    net(): HazardNet {
        return {
            waterY: this.waterY,
            flood: this.floodPhase,
            gust: this.gustPhase,
            gustDir: Math.atan2(this.gustDirZ, this.gustDirX),
            gustSlot: this.gustSlot,
            brake: this.brakePhase
        };
    }

    /** One tick, before the physics step. */
    step(h: HazardHost): void {
        const spec = this.spec;
        if (!spec) return;
        const tick = h.tick;
        if (spec.flood) this.stepFlood(h, spec.flood, tick);
        if (spec.gust) this.stepGust(h, spec.gust, tick, this.seed);
        if (spec.handbrake) this.stepHandbrake(h, spec.handbrake, tick);
        if (this.busy) this.quietFrom = tick + S(HAZARD.safeS);
    }

    /** May a new hazard start now? */
    private canStart(h: HazardHost, tick: number): boolean {
        return !h.progress.goalReached && tick >= S(HAZARD.graceS) && tick >= this.quietFrom && !this.busy;
    }

    private say(h: HazardHost, text: string): void {
        h.events.push({ tick: h.tick, kind: 'hazard', text });
    }

    // ------------------------------------------------------------------------------- flood

    private stepFlood(h: HazardHost, f: FloodSpec, tick: number): void {
        const F = HAZARD.flood;
        const pw = h.physics;
        // trigger: a piece lies across the crossing, still and let go, for a moment
        if (this.floodPhase === PHASE.idle && this.floodPending < 0) {
            // finished: two pieces across (the bridge you walk on), or one left across a while
            const spanned = this.crossingSpanned(pw, f);
            this.spanTicks = spanned >= 2 ? this.spanTicks + 1 : 0;
            this.spanOneTicks = spanned >= 1 ? this.spanOneTicks + 1 : 0;
            const bucketAcross = h.bucket.pose.p.z < f.crossing.z1;
            if (
                (this.spanTicks >= S(F.holdToTrigger) || this.spanOneTicks >= S(F.oneBeamS)) &&
                this.floodCount < F.max &&
                tick - this.floodEnded >= S(F.cooldownS) &&
                !bucketAcross &&
                this.canStart(h, tick)
            ) {
                // the siren's delay varies with the game's seed
                this.floodPending = tick + S(F.delayS + F.delayJitterS * rand(this.seed, 101 + this.floodCount, 0));
                this.spanTicks = this.spanOneTicks = 0;
            }
        }
        if (this.floodPending >= 0 && tick >= this.floodPending) {
            this.floodPending = -1;
            this.floodPhase = PHASE.tell;
            this.floodT = 0;
            this.floodCount++;
            this.floodTouched.clear();
            this.say(
                h,
                '🚨 A siren upstream! The creek is rising. Get the bucket over, or weigh the bridge down (stand on it, hold it)!'
            );
        }
        if (this.floodPhase === PHASE.idle) return;
        this.floodT++;
        const peak = f.peakY - this.baseY;
        const tellT = S(F.tellS);
        const riseT = S(F.riseS);
        const holdT = S(F.holdS);
        const fallT = S(F.fallS);
        const t = this.floodT;
        // the water starts creeping up during the tell (the gauge marks go under), then surges
        if (t < tellT) this.rise = peak * 0.12 * smooth(t / tellT);
        else if (t < tellT + riseT) {
            if (this.floodPhase !== PHASE.active) {
                this.floodPhase = PHASE.active;
                this.say(h, '🌊 Here it comes! Floodwater lifts loose timber.');
            }
            this.rise = peak * (0.12 + 0.88 * smooth((t - tellT) / riseT));
        } else if (t < tellT + riseT + holdT) this.rise = peak;
        else if (t < tellT + riseT + holdT + fallT) {
            if (this.floodPhase !== PHASE.recede) {
                this.floodPhase = PHASE.recede;
                this.say(h, 'The water is going down.');
            }
            this.rise = peak * (1 - smooth((t - tellT - riseT - holdT) / fallT));
        } else {
            this.rise = 0;
            this.floodPhase = PHASE.idle;
            this.floodEnded = tick;
            this.washUp(h, f);
        }
        this.waterY = this.baseY + this.rise;
        const strength = this.floodLevel;
        if (strength > 0) {
            const area = h.level.water;
            applyFlood(
                pw,
                area,
                { y: this.waterY, vx: f.current.x, vz: f.current.z, strength },
                h.level.terrainHeight,
                1 / SIM_HZ
            );
            const feet = h.players.filter((p, i) => h.isSlotActive(i) && p.grounded && h.seatOf(i) < 0);
            pressStanding(pw, feet, this.waterY, 1 / SIM_HZ);
            // remember what the water is carrying (moving pieces in the flood), to wash it up later
            for (const pb of pw.bodies.values()) {
                if (pb.kind !== 'dynamic' || !pb.enabled || !pb.shape || pb.id === h.bucket.id) continue;
                const p = pb.body.translation();
                const v = pb.body.linvel();
                if (
                    p.y < this.waterY + 0.1 &&
                    Math.abs(p.x - area.cx) < area.halfX &&
                    Math.abs(p.z - area.cz) < area.halfZ &&
                    Math.hypot(v.x, v.z) > 0.4
                )
                    this.floodTouched.add(pb.id);
            }
        }
    }

    /** How many resting, unheld timber pieces lie across the crossing. */
    crossingSpanned(pw: PhysicsWorld, f: FloodSpec): number {
        let n = 0;
        const c = f.crossing;
        for (const pb of pw.bodies.values()) {
            const s = pb.shape;
            if (pb.kind !== 'dynamic' || !pb.enabled || !pb.grabbable || !s || s.type !== 'box') continue;
            const b = pb.body;
            const t = b.translation();
            if (Math.abs(t.x - c.x) > c.halfX || t.z > c.z0 || t.z < c.z1) continue;
            const v = b.linvel();
            if (Math.hypot(v.x, v.y, v.z) > 0.3 || pw.holders(pb.id) > 0) continue;
            // the long axis in the world
            const q = b.rotation();
            const long = Math.max(s.hx, s.hy, s.hz);
            const ax = long === s.hx ? 1 : 0;
            const ay = long === s.hy ? 1 : 0;
            const az = ax || ay ? 0 : 1;
            const dz =
                2 * (q.x * q.z - q.w * q.y) * ax +
                2 * (q.y * q.z + q.w * q.x) * ay +
                (1 - 2 * (q.x * q.x + q.y * q.y)) * az;
            const ez = Math.abs(dz) * long;
            if (t.z + ez > c.z0 && t.z - ez < c.z1) n++;
        }
        return n;
    }

    /** The water goes down: timber it took is left on the bank downstream (in the spots' order). */
    private washUp(h: HazardHost, f: FloodSpec): void {
        const pw = h.physics;
        const lostY = h.level.rules?.lostY ?? this.baseY;
        const names: string[] = [];
        let n = 0;
        for (const id of [...this.floodTouched].sort((a, b) => a - b)) {
            const pb = pw.bodies.get(id);
            if (!pb) continue;
            const p = pb.body.translation();
            // still on the bridge, or come to rest on a bank: left where it is
            if (p.y > lostY + 0.25) continue;
            const spot = f.washup[n % f.washup.length];
            n++;
            // lying as it was stacked in the yard, one layer up for each lap of the spots
            const layer = Math.floor((n - 1) / f.washup.length);
            pw.place(id, { p: { x: spot.x, y: spot.y + 0.25 * layer, z: spot.z }, q: { ...pb.spawn.q } });
            names.push(h.entities.find((e) => e.id === id)?.name.replace(/^extra-|-\d+$/g, '') ?? 'piece');
        }
        this.floodTouched.clear();
        this.floodMoved += n;
        if (n > 0) {
            const what = n === 1 ? `the ${names[0]}` : `${n} pieces of timber`;
            this.say(h, `The flood left ${what} on the bank downstream.`);
        }
    }

    // ------------------------------------------------------------------------------- gust

    private stepGust(h: HazardHost, g: GustSpec, tick: number, seed: number): void {
        const G = HAZARD.gust;
        const pw = h.physics;
        const area = h.level.water;
        if (this.gustPhase === PHASE.idle) {
            const ready = this.gustCount < G.max && tick - this.gustEnded >= S(G.cooldownS) && this.canStart(h, tick);
            for (let i = 0; i < h.players.length; i++) {
                const held = h.isSlotActive(i) ? pw.heldIdOf(i) : -1;
                const pb = held >= 0 ? pw.bodies.get(held) : undefined;
                const p = h.players[i];
                const dx = Math.max(0, Math.abs(p.x - area.cx) - area.halfX);
                const dz = Math.max(0, Math.abs(p.z - area.cz) - area.halfZ);
                const light = !!pb && isPlank(pb);
                this.carryTicks[i] = light && Math.hypot(dx, dz) < G.nearWater ? (this.carryTicks[i] ?? 0) + 1 : 0;
                // how long a carry takes to bring the gust varies with the game's seed
                const carry = G.carryS + G.carryJitterS * rand(seed, 201 + this.gustCount, 0);
                if (!ready || !pb || this.carryTicks[i] < S(carry) || this.planksLeft(h) < G.minPlanks) continue;
                // aim: across the water from where the piece is; the seed picks straight across,
                // or slanting upstream or downstream, and a small wobble
                const t = pb.body.translation();
                const along = area.halfX > area.halfZ;
                const sign = along ? Math.sign(area.cz - t.z) || 1 : Math.sign(area.cx - t.x) || 1;
                const slant = [-0.6, 0, 0.6][Math.floor(rand(seed, 301 + this.gustCount, 0) * 3)];
                const a = slant + (rand(seed, this.gustCount, tick) - 0.5) * 0.4;
                const bx = along ? 0 : sign;
                const bz = along ? sign : 0;
                this.gustDirX = bx * Math.cos(a) - bz * Math.sin(a);
                this.gustDirZ = bx * Math.sin(a) + bz * Math.cos(a);
                this.gustSlot = i;
                this.gustBody = held;
                this.gustPhase = PHASE.tell;
                this.gustT = 0;
                this.gustCount++;
                this.carryTicks.fill(0);
                const who = h.players.filter((_, k) => h.isSlotActive(k)).length > 1 ? `Player ${i + 1}: ` : '';
                this.say(h, `💨 ${who}A gust is coming for your plank! Lower it (look down), or carry it together.`);
                break;
            }
            return;
        }
        this.gustT++;
        if (this.gustPhase === PHASE.tell && this.gustT >= S(G.tellS)) {
            this.gustPhase = PHASE.active;
            this.gustT = 0;
        }
        if (this.gustPhase === PHASE.active) {
            const blowT = S(G.blowS);
            if (this.gustT >= blowT) {
                this.gustPhase = PHASE.idle;
                this.gustEnded = tick;
                this.gustSlot = this.gustBody = -1;
                return;
            }
            const pb = pw.bodies.get(this.gustBody);
            if (!pb || !pb.enabled) return;
            const b = pb.body;
            const v = b.linvel();
            // like the wind: resting pieces are left alone (putting it down is a counterplay)
            if (pw.holders(pb.id) === 0 && Math.hypot(v.x, v.y, v.z) < 0.25) return;
            const t = b.translation();
            const env = smooth(this.gustT / S(0.3)) * smooth((blowT - this.gustT) / S(0.3));
            // in the hands it pushes as hard as it likes; torn free, it carries the piece off like a
            // strong wind (it lands in the creek, not on the far bank)
            const held = pw.holders(pb.id) > 0;
            const cap = held ? b.mass() * 60 : b.mass() * GRAVITY * 0.45;
            const f = Math.min(g.force * gustExposure(t.y - h.level.terrainHeight(t.x, t.z)) * env, cap);
            this.lastGustForce = Math.max(this.lastGustForce, f);
            // stronger than the grips on it for a moment: torn out of their hands
            this.gustOver = held && f > GRAB.maxForce * pw.holders(pb.id) ? this.gustOver + 1 : 0;
            if (this.gustOver >= S(HAZARD.gust.tearS)) {
                for (let i = 0; i < h.players.length; i++) if (pw.heldIdOf(i) === pb.id) pw.release(i);
                this.say(h, 'The gust tore it out of your hands!');
            }
            const dt = 1 / SIM_HZ;
            b.applyImpulse({ x: this.gustDirX * f * dt, y: 0, z: this.gustDirZ * f * dt }, true);
        }
    }

    // ------------------------------------------------------------------------------- handbrake

    /**
     * Left parked on a slope, the ute's handbrake clicks off (after a ratchet warning) and it rolls.
     * Park on the flat, chock a downhill wheel (a cube, a beam on edge, a log: not a flat plank), or
     * get in (a driver ends it). It catches again after a while. A chock is a rule (UteVehicle.
     * chocked): while one stands there the brake stays on and the parking lock holds the ute; the
     * ray wheels would otherwise roll over it.
     */
    private stepHandbrake(h: HazardHost, b: HandbrakeSpec, tick: number): void {
        const H = HAZARD.handbrake;
        const v = h.vehicle;
        if (!v) return;
        const body = v.pb.body;
        if (this.brakePhase === PHASE.idle) {
            const q = body.rotation();
            const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
            const lv = body.linvel();
            const parked = h.driver < 0 && Math.hypot(lv.x, lv.y, lv.z) < 0.1;
            this.parkedTicks = parked && upY > 0.5 && upY < Math.cos(b.slope) ? this.parkedTicks + 1 : 0;
            if (
                this.parkedTicks >= S(H.parkedS) &&
                this.brakeCount < H.max &&
                tick - this.brakeEnded >= S(H.cooldownS) &&
                this.canStart(h, tick)
            ) {
                this.brakePhase = PHASE.tell;
                this.brakeT = 0;
                this.brakeCount++;
                this.parkedTicks = 0;
                this.say(
                    h,
                    '🔧 Click… click… click… The ute’s handbrake is creeping off! Get in and hold the brake, or chock a downhill wheel.'
                );
            }
            return;
        }
        this.brakeT++;
        const wasChocked = this.chocked;
        this.chocked = v.chocked();
        if (this.brakePhase === PHASE.tell && this.brakeT >= S(H.tellS)) {
            this.brakePhase = PHASE.active;
            this.brakeT = 0;
            this.say(
                h,
                this.chocked
                    ? 'The handbrake is off, but the chock holds the ute.'
                    : 'The handbrake is off! The ute is rolling.'
            );
        } else if (this.brakePhase === PHASE.active && this.chocked && !wasChocked) {
            this.say(h, 'Chocked: the ute stops.');
        }
        // someone at the wheel pulls it back on; or after a while it catches by itself
        if (h.driver >= 0 || (this.brakePhase === PHASE.active && this.brakeT >= S(H.offS))) {
            this.brakePhase = PHASE.idle;
            this.chocked = false;
            this.brakeEnded = tick;
            this.say(h, h.driver >= 0 ? 'Handbrake back on.' : 'The handbrake caught again.');
        }
    }

    /** Light pieces (planks) still out of the creek: the gust's severity budget. */
    private planksLeft(h: HazardHost): number {
        const lostY = h.level.rules?.lostY ?? this.baseY;
        let n = 0;
        for (const pb of h.physics.bodies.values()) {
            if (pb.kind !== 'dynamic' || !pb.enabled || !isPlank(pb)) continue;
            if (pb.body.translation().y > lostY) n++;
        }
        return n;
    }
}

/**
 * A plank: long (a metre or more), light (under 30 kg) timber you carry in your hands. The gust
 * goes for these, never the bucket, a crate or a shouldered beam.
 */
function isPlank(pb: {
    kind: string;
    grabbable: boolean;
    shape?: { type: string };
    body: { mass(): number };
}): boolean {
    const s = pb.shape as { type: string; hx?: number; hy?: number; hz?: number } | undefined;
    if (pb.kind !== 'dynamic' || !pb.grabbable || !s || s.type !== 'box') return false;
    return Math.max(s.hx!, s.hy!, s.hz!) >= 0.5 && pb.body.mass() < HAZARD.gust.maxMass;
}

/**
 * How much of the gust a piece catches at a height above the ground (m): full at carrying height
 * (1.4 m and up), a fifth near the ground. Lowering a plank to the knees takes most of it away.
 */
export function gustExposure(height: number): number {
    return Math.max(0.2, Math.min(1, (height - 0.45) / 0.95));
}

/** Seeded 0..1 (deterministic: the same run gives the same gusts). */
function rand(seed: number, n: number, tick: number): number {
    let x = (seed * 374761393 + n * 668265263 + tick * 2246822519) >>> 0;
    x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) >>> 0;
    x = Math.imul(x ^ (x >>> 12), 0x297a2d39) >>> 0;
    return ((x ^ (x >>> 15)) >>> 0) / 4294967296;
}

/** Reads a guest's copy of the host's hazard state (untrusted). */
export function readHazardNet(v: unknown, baseY: number): HazardNet {
    const a = Array.isArray(v) ? v : [];
    const n = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
    return {
        waterY: Math.max(baseY - 1, Math.min(baseY + 3, n(a[0], baseY))),
        flood: Math.max(0, Math.min(3, Math.round(n(a[1], 0)))),
        gust: Math.max(0, Math.min(3, Math.round(n(a[2], 0)))),
        gustDir: n(a[3], 0),
        gustSlot: Math.round(n(a[4], -1)),
        brake: Math.max(0, Math.min(3, Math.round(n(a[5], 0))))
    };
}

/** The host's compact form of `net()`. */
export function packHazardNet(h: HazardNet): number[] {
    return [
        Math.round(h.waterY * 1000) / 1000,
        h.flood,
        h.gust,
        Math.round(h.gustDir * 100) / 100,
        h.gustSlot,
        h.brake
    ];
}
