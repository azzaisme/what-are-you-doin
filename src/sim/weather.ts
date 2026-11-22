/**
 * Weather along the journey (design doc §2.9 and §8, Epic 9, #88): authored weather for each area of
 * a long level, scheduled by the hazard director (src/sim/hazards.ts) so it shares its one-at-a-time
 * budget, quiet spells and seed. Deterministic: it runs in the host's simulation and guests get its
 * state through the director's net state.
 *
 * Each area has one kind of weather, which comes once, a seeded moment after the first player
 * reaches the area: a tell (it gathers), the weather itself, then it clears. The rules are the same
 * every time:
 * - rain (the Forest Road): the river rises a little while it rains (`riverRise`), and falls back;
 * - mist (the Gorge): spray off the waterfall closes the view in;
 * - fog (the Mountain Approach): a fog bank closes the view right in;
 * - snow (the Mountain Approach, above it): a flurry, with a crosswind (`wind`) that pushes carried
 *   pieces (light ones) like a weak gust: lower them or carry them together.
 *
 * Pure module (no engine).
 */

/** Weather kinds, as they travel in the net state. */
export const WEATHER = { none: 0, rain: 1, mist: 2, fog: 3, snow: 4 } as const;
export type WeatherKind = (typeof WEATHER)[keyof typeof WEATHER];

export interface WeatherZone {
    /** Shown in the event messages. */
    name: string;
    kind: WeatherKind;
    /** Is (x, z) in this zone's area? */
    contains: (x: number, z: number) => boolean;
    /** Seconds: gathering (the tell), the weather itself, clearing. */
    tellS: number;
    activeS: number;
    clearS: number;
    /** Seconds after the first player arrives before it gathers, plus up to `delayJitterS` (seeded). */
    delayS: number;
    delayJitterS: number;
    /** At full strength: how far the river rises (m), and its current then (m/s, downstream). */
    riverRise?: number;
    current?: { x: number; z: number };
    /** At full strength: the fog's end (m), the far edge of what you can see. */
    fogEnd?: number;
    /** At full strength: the crosswind's push on a carried piece (N), and its direction (rad, 0 = +X). */
    wind?: { force: number; dir: number };
    /** Said when it starts gathering, and when it clears (not for atmosphere). */
    tell: string;
    clear: string;
    /**
     * Atmosphere, not a hazard: it comes whatever else is going on, takes no part in the hazard
     * director's one-at-a-time budget (nothing waits for it), and says nothing.
     */
    atmosphere?: boolean;
    /**
     * A veil (mist, a fog bank): at full strength the fog closes in to the near world's edge at
     * most, so the coarse far lattice behind it never shows through (see `weatherFog`).
     */
    veil?: boolean;
}

export interface WeatherSpec {
    zones: WeatherZone[];
}

export const W_PHASE = { idle: 0, tell: 1, active: 2, clear: 3 } as const;

/** What the director needs from the world each tick. */
export interface WeatherInput {
    tick: number;
    hz: number;
    /** Where the active players stand. */
    players: readonly { x: number; z: number }[];
    /** May a new hazard start now (the director's budget and quiet spells)? */
    canStart: boolean;
    /** Deterministic noise in 0..1 for a key (the director's seeded random). */
    rand: (key: number) => number;
}

const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

export class WeatherScheduler {
    readonly spec: WeatherSpec;
    /** The zone whose weather is on (-1: none), its phase, and ticks in that phase. */
    zone = -1;
    phase: number = W_PHASE.idle;
    t = 0;
    /** Per zone: the tick it was first reached (-1: not yet), and whether its weather has been. */
    private readonly reached: number[];
    private readonly done: boolean[];

    constructor(spec: WeatherSpec) {
        this.spec = spec;
        this.reached = spec.zones.map(() => -1);
        this.done = spec.zones.map(() => false);
    }

    reset(): void {
        this.zone = -1;
        this.phase = W_PHASE.idle;
        this.t = 0;
        this.reached.fill(-1);
        this.done.fill(false);
    }

    get busy(): boolean {
        return this.phase !== W_PHASE.idle;
    }

    /** Busy with weather that is a hazard (atmosphere does not count). */
    get hazardBusy(): boolean {
        return this.busy && !this.spec.zones[this.zone]?.atmosphere;
    }

    /** 0..1: how strong the weather is now (rises through the tell, holds, falls as it clears). */
    get strength(): number {
        if (this.zone < 0) return 0;
        const z = this.spec.zones[this.zone];
        if (this.phase === W_PHASE.tell) return 0.35 * smooth(this.t / Math.max(1, z.tellS * 60));
        if (this.phase === W_PHASE.active) return 0.35 + 0.65 * smooth(this.t / Math.max(1, 0.15 * z.activeS * 60));
        if (this.phase === W_PHASE.clear) return 1 - smooth(this.t / Math.max(1, z.clearS * 60));
        return 0;
    }

    get kind(): WeatherKind {
        return this.zone >= 0 && this.phase !== W_PHASE.idle ? this.spec.zones[this.zone].kind : WEATHER.none;
    }

    /** The river's rise now (m). */
    get riverRise(): number {
        return this.zone >= 0 ? (this.spec.zones[this.zone].riverRise ?? 0) * this.strength : 0;
    }

    /** The river's current at full strength (m/s), downstream. */
    get current(): { x: number; z: number } {
        return (this.zone >= 0 ? this.spec.zones[this.zone].current : undefined) ?? { x: 0, z: 0 };
    }

    /** The crosswind now: push (N) and direction, or null. */
    get wind(): { force: number; dir: number } | null {
        if (this.zone < 0) return null;
        const w = this.spec.zones[this.zone].wind;
        return w && this.phase !== W_PHASE.idle ? { force: w.force * this.strength, dir: w.dir } : null;
    }

    /**
     * Zone `n`'s weather now, at full strength, as if it had come and built up (tests and the
     * screenshots, where waiting for it in a software-rendered browser takes minutes). It then runs
     * out its time and clears as usual.
     */
    startNow(n: number, hz: number): void {
        const z = this.spec.zones[n];
        if (!z) return;
        this.zone = n;
        this.phase = W_PHASE.active;
        this.t = Math.ceil(0.15 * z.activeS * hz);
        this.done[n] = true;
        if (this.reached[n] < 0) this.reached[n] = 0;
    }

    /** One tick. Returns a message to say, if any. */
    step(i: WeatherInput): string | null {
        const zones = this.spec.zones;
        // who has got where
        for (let n = 0; n < zones.length; n++) {
            if (this.reached[n] >= 0) continue;
            if (i.players.some((p) => zones[n].contains(p.x, p.z))) this.reached[n] = i.tick;
        }
        const S = (s: number) => Math.round(s * i.hz);
        if (this.phase === W_PHASE.idle) {
            for (let n = 0; n < zones.length; n++) {
                if (this.done[n] || this.reached[n] < 0) continue;
                const z = zones[n];
                // a hazard waits for the director's budget; atmosphere does not
                if (!z.atmosphere && !i.canStart) continue;
                const wait = S(z.delayS + z.delayJitterS * i.rand(401 + n));
                if (i.tick - this.reached[n] < wait) continue;
                this.zone = n;
                this.phase = W_PHASE.tell;
                this.t = 0;
                this.done[n] = true;
                return z.atmosphere ? null : z.tell;
            }
            return null;
        }
        const z = zones[this.zone];
        this.t++;
        if (this.phase === W_PHASE.tell && this.t >= S(z.tellS)) {
            this.phase = W_PHASE.active;
            this.t = 0;
        } else if (this.phase === W_PHASE.active && this.t >= S(z.activeS)) {
            this.phase = W_PHASE.clear;
            this.t = 0;
            return z.atmosphere ? null : z.clear;
        } else if (this.phase === W_PHASE.clear && this.t >= S(z.clearS)) {
            this.phase = W_PHASE.idle;
            this.t = 0;
            this.zone = -1;
        }
        return null;
    }
}

/**
 * The fog for a weather state, as one viewer sees it: the level's own (`base`), closing in to the
 * zone's `fogEnd` at full strength. `strength` is the weather's times how far the viewer is inside
 * its zone (0..1; see `weatherCovers`), so mist and fog hang over their own area only: the summit
 * stays clear while the road below it is in fog. A veil closes in to `nearRadius` at most (the
 * near world's edge on this device's preset), so at full strength the edge is fully fogged and the
 * coarse far lattice never shows through; the start keeps its share of the end.
 */
export function weatherFog(
    spec: WeatherSpec | undefined,
    zone: number,
    strength: number,
    base: { start: number; end: number },
    nearRadius = Infinity
): { start: number; end: number } {
    const z = spec && zone >= 0 ? spec.zones[zone] : undefined;
    const k = Math.max(0, Math.min(1, strength));
    if (!z?.fogEnd || k === 0) return { start: base.start, end: base.end };
    const target = Math.min(base.end, z.fogEnd, z.veil ? nearRadius : Infinity);
    const end = base.end + (target - base.end) * k;
    return { start: (base.start * end) / base.end, end };
}

/** Linear fog's opacity at distance `d` (0 clear, 1 the fog colour), as the renderer draws it. */
export function fogOpacity(f: { start: number; end: number }, d: number): number {
    return Math.max(0, Math.min(1, (d - f.start) / Math.max(1e-6, f.end - f.start)));
}

/** Is a viewer at (x, z) under a zone's weather? */
export function weatherCovers(spec: WeatherSpec | undefined, zone: number, x: number, z: number): boolean {
    const w = spec && zone >= 0 ? spec.zones[zone] : undefined;
    return !!w && w.contains(x, z);
}
