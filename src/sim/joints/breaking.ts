/**
 * When connections give way (Epic 5, #49 #50): each connection's measured load (stress.ts) against
 * what its nails hold. A connection warns before it fails:
 *
 * - utilization u = sqrt((F / F_cap)^2 + (M / M_cap)^2), smoothed over ~0.1 s, with the capacity
 *   worn down by fatigue;
 * - u past CREAK creaks, past GROAN groans (events, rate limited per connection);
 * - sustained u past 1 breaks it; so does a blow past IMPACT (a dropped log, a hard landing), which
 *   cracks it: it gives way after the tell, whatever it carries then;
 * - never without warning: a connection breaks only after it has creaked for TELL (a load that
 *   comes on fast creaks the moment it passes 1 and breaks TELL later, if it is still there);
 * - time spent past FATIGUE_FROM wears it (fatigue 0..1 takes up to 60 % off its capacity), so a
 *   bridge that holds a load at the edge for long enough lets go.
 *
 * Breaks are applied after the physics step (JointSystem.update), never inside it.
 */

import { SIM_DT } from '../clock.ts';

import { NAIL } from './graph.ts';
import type { Connection } from './graph.ts';
import type { JointLoad } from './stress.ts';

export const BREAK = {
    /** Smoothing time of the utilization (s). */
    smoothing: 0.1,
    creak: 0.55,
    groan: 0.8,
    /** A single step's utilization past this breaks at once (impacts). */
    impact: 2.5,
    fatigueFrom: 0.5,
    /** Fatigue gained per second per unit of utilization past fatigueFrom. */
    fatigueRate: 0.25,
    /** Capacity lost at full fatigue. */
    fatigueLoss: 0.6,
    /** A connection creaks at least this long (s) before it can break. */
    tell: 0.5,
    /** A connection warns at most this often (s). */
    warnEvery: 1.5,
    /**
     * A new joint settles for this long (s) before it can fail: its first steps carry the snap of
     * the joint taking hold, not a load.
     */
    settle: 0.25
} as const;

export type JointEventKind = 'creak' | 'groan' | 'break';

export interface JointEvent {
    kind: JointEventKind;
    /** The connection (its last state, for a break). */
    conn: Connection;
    util: number;
}

export interface JointHealthState {
    /** Smoothed utilization (1 = at capacity). */
    util: number;
    /** This step's utilization, unsmoothed. */
    raw: number;
    /** 0 calm, 1 creaking, 2 groaning. */
    level: number;
    /** Tick of the last warning. */
    warned: number;
    /** The previous step's utilization was past BREAK.impact (an impact must last two steps). */
    hit: boolean;
    /** Tick it started creaking (-1: calm); it can break BREAK.tell after. */
    creaked: number;
    /** Cracked by an impact: it gives way once the tell is over. */
    cracked: boolean;
}

/**
 * What a connection holds before fatigue: shear and withdrawal (N) of its nails, and bending
 * moment (N m): the nails' shear at a lever of NAIL.lever plus half their spread.
 */
export function capacity(c: Connection): { shear: number; pull: number; moment: number } {
    let spread = 0;
    for (let i = 0; i < c.nails.length; i++)
        for (let j = i + 1; j < c.nails.length; j++) {
            const a = c.nails[i];
            const b = c.nails[j];
            spread = Math.max(spread, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
        }
    const n = Math.max(1, c.nails.length);
    return {
        shear: NAIL.strength * n,
        pull: NAIL.withdrawal * n,
        moment: NAIL.strength * n * (NAIL.lever + spread / 2)
    };
}

/**
 * How much of its capacity a connection is using (1: at the limit): EN 1995-1-1 8.3.3 (8.28),
 * the combined shear and withdrawal of nails, (F_ax / F_ax,R)^2 + (F_v / F_v,R)^2, with the
 * bending moment as a third term; worn down by fatigue.
 */
export function utilization(c: Connection, load: JointLoad): number {
    const cap = capacity(c);
    const wear = 1 - BREAK.fatigueLoss * c.fatigue;
    return Math.hypot(load.shear / cap.shear, load.pull / cap.pull, load.moment / cap.moment) / wear;
}

export class JointHealth {
    readonly states = new Map<number, JointHealthState>();

    /** Updates every connection from its load; returns warnings and the connections to break. */
    update(conns: Iterable<Connection>, loads: ReadonlyMap<number, JointLoad>, tick: number): JointEvent[] {
        const out: JointEvent[] = [];
        const k = 1 - Math.exp(-SIM_DT / BREAK.smoothing);
        const live = new Set<number>();
        for (const c of conns) {
            live.add(c.id);
            let s = this.states.get(c.id);
            if (!s)
                this.states.set(
                    c.id,
                    (s = { util: 0, raw: 0, level: 0, warned: -1e9, hit: false, creaked: -1, cracked: false })
                );
            const load = loads.get(c.id);
            // asleep (no load measured): it keeps what it last carried
            if (!load) continue;
            // settling: not rated yet
            if ((tick - c.tick) * SIM_DT < BREAK.settle) continue;
            const raw = utilization(c, load);
            s.raw = raw;
            s.util += (raw - s.util) * k;
            if (s.util > BREAK.fatigueFrom)
                c.fatigue = Math.min(1, c.fatigue + (s.util - BREAK.fatigueFrom) * BREAK.fatigueRate * SIM_DT);
            if (raw >= BREAK.impact && s.hit) s.cracked = true;
            s.hit = raw >= BREAK.impact;
            if (s.util >= 1 || s.cracked) {
                if (s.creaked < 0) {
                    // past its limit with no warning yet: the tell starts now
                    out.push({ kind: 'creak', conn: c, util: Math.max(s.util, raw) });
                    s.creaked = s.warned = tick;
                    s.level = Math.max(s.level, 1);
                } else if ((tick - s.creaked) * SIM_DT >= BREAK.tell - 1e-9) {
                    out.push({ kind: 'break', conn: c, util: Math.max(s.util, raw) });
                    continue;
                }
            }
            const level = s.util >= BREAK.groan ? 2 : s.util >= BREAK.creak ? 1 : 0;
            if (level >= 1 && s.creaked < 0) s.creaked = tick;
            if (level > s.level && (tick - s.warned) * SIM_DT >= BREAK.warnEvery) {
                out.push({ kind: level === 2 ? 'groan' : 'creak', conn: c, util: s.util });
                s.warned = tick;
            }
            // calm down with some hysteresis
            if (s.cracked) continue;
            s.level =
                level > s.level
                    ? level
                    : s.util < BREAK.creak * 0.8
                      ? 0
                      : s.util < BREAK.groan * 0.85
                        ? Math.min(1, s.level)
                        : s.level;
            if (s.level === 0) s.creaked = -1;
        }
        for (const id of [...this.states.keys()]) if (!live.has(id)) this.states.delete(id);
        return out;
    }
}
