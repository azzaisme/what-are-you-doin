/**
 * The hazard director (design doc §2.9, Epic 8, issues #71-#73): the world answers attempts at
 * success. It runs inside the simulation on the host, so it is deterministic and seeded, and it
 * schedules authored events from gameplay conditions, never random per-frame destruction:
 *
 * - **Rising river** (#72): a piece laid across the crossing ("the bridge is finished") sets off
 *   the flood. Tell: a siren, the gauge post's marks going under, an upstream rumble. The water
 *   rises, floats timber and runs fast downstream. Counterplay: get the bucket across before the
 *   peak, weigh the bridge down (stand on it, hold it, load it), or raise its ends on packing.
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

export interface HazardSpec {
    seed: number;
    flood?: FloodSpec;
    gust?: GustSpec;
}

/** Timings (seconds) and budgets. */
export const HAZARD = {
    /** No hazard this early in a run. */
    graceS: 20,
    /** Quiet spell after any hazard ends. */
    safeS: 15,
    flood: { holdToTrigger: 1, delayS: 3, tellS: 8, riseS: 10, holdS: 14, fallS: 12, cooldownS: 75, max: 2 },
    gust: {
        carryS: 1.5,
        tearS: 0.35,
        tellS: 2.2,
        blowS: 2.0,
        cooldownS: 40,
        max: 3,
        nearWater: 4,
        maxMass: 30,
        minPlanks: 3
    }
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
    private floodPending = -1;
    private readonly carryTicks: number[] = [];
    /** Bodies the flood touched this time (washed up when it ends). */
    private readonly floodTouched = new Set<number>();
    /** Telemetry: the largest push the gust gave (N) and pieces the flood moved. */
    lastGustForce = 0;
    floodMoved = 0;
    private gustOver = 0;

    constructor(level: LevelDef) {
        this.spec = level.hazards;
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
        this.spanTicks = 0;
        this.floodPending = -1;
        this.carryTicks.length = 0;
        this.floodTouched.clear();
        this.lastGustForce = 0;
        this.floodMoved = 0;
        this.gustOver = 0;
    }

    /** Is any hazard telling or running? */
    get busy(): boolean {
        return this.floodPhase !== PHASE.idle || this.gustPhase !== PHASE.idle || this.floodPending >= 0;
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
            gustSlot: this.gustSlot
        };
    }

    /** One tick, before the physics step. */
    step(h: HazardHost): void {
        const spec = this.spec;
        if (!spec) return;
        const tick = h.tick;
        if (spec.flood) this.stepFlood(h, spec.flood, tick);
        if (spec.gust) this.stepGust(h, spec.gust, tick, spec.seed);
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
            const spanned = this.crossingSpanned(pw, f);
            this.spanTicks = spanned ? this.spanTicks + 1 : 0;
            const bucketAcross = h.bucket.pose.p.z < f.crossing.z1;
            if (
                this.spanTicks >= S(F.holdToTrigger) &&
                this.floodCount < F.max &&
                tick - this.floodEnded >= S(F.cooldownS) &&
                !bucketAcross &&
                this.canStart(h, tick)
            ) {
                this.floodPending = tick + S(F.delayS);
                this.spanTicks = 0;
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

    /** A resting, unheld timber piece lying across the crossing. */
    crossingSpanned(pw: PhysicsWorld, f: FloodSpec): boolean {
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
            if (t.z + ez > c.z0 && t.z - ez < c.z1) return true;
        }
        return false;
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
                const light = !!pb && pb.windArea > 0 && pb.body.mass() < G.maxMass;
                this.carryTicks[i] = light && Math.hypot(dx, dz) < G.nearWater ? (this.carryTicks[i] ?? 0) + 1 : 0;
                if (!ready || !pb || this.carryTicks[i] < S(G.carryS) || this.planksLeft(h) < G.minPlanks) continue;
                // aim: across the water from where the piece is, with a seeded wobble
                const t = pb.body.translation();
                const along = area.halfX > area.halfZ;
                const sign = along ? Math.sign(area.cz - t.z) || 1 : Math.sign(area.cx - t.x) || 1;
                const a = (rand(seed, this.gustCount, tick) - 0.5) * 0.7;
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

    /** Light pieces (planks) still out of the creek: the gust's severity budget. */
    private planksLeft(h: HazardHost): number {
        const lostY = h.level.rules?.lostY ?? this.baseY;
        let n = 0;
        for (const pb of h.physics.bodies.values()) {
            if (pb.kind !== 'dynamic' || !pb.enabled || !pb.grabbable || pb.windArea <= 0) continue;
            if (pb.body.mass() >= HAZARD.gust.maxMass) continue;
            if (pb.body.translation().y > lostY) n++;
        }
        return n;
    }
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
        gustSlot: Math.round(n(a[4], -1))
    };
}

/** The host's compact form of `net()`. */
export function packHazardNet(h: HazardNet): number[] {
    return [Math.round(h.waterY * 1000) / 1000, h.flood, h.gust, Math.round(h.gustDir * 100) / 100, h.gustSlot];
}
