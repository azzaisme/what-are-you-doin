/**
 * Hazard (#74): a tree falls towards the ute. Bite or chop a stand tree while the ute stands within
 * its reach, and the pine cracks and leans towards the ute: it will fall its way.
 *
 * - **Trigger:** a bite or blow on that tree this tick (its cut count went up), not an old partial
 *   cut: a tree bitten during the quiet start, or left half cut, says nothing until someone cuts it
 *   again.
 * - **Tell:** a crack and a toast the moment the cut lands, and the tree leans over towards the ute
 *   (shaking, shedding needles on that side) more and more over TREE.tellS: its marker draws it
 *   tilted while the voxel worker takes the static tree away, so guests see it too, a guest joining
 *   mid-tell as well. It stays leaning until it falls, and stands back up (static again) if the
 *   ute is moved out of reach or the hazard is given up with it standing. The tree cannot fall during the tell, however fast it is
 *   chewed or chopped (it hangs on its last fibres): that is the time to react.
 * - **What happens:** while the ute is in reach, the tree's weight is shifted towards the ute: its
 *   own lean is replaced by a lean of TREE.lean towards the ute. Cut from anywhere but the ute's
 *   side and it comes down on or towards the ute.
 * - **Counterplay, true of every stand tree:** move the ute out of reach (the tree's own lean comes
 *   back: it falls the way it was cut, as if nothing happened), or cut from the ute's side: the
 *   cut's push away from the cutter (0.07) beats TREE.lean whatever the tree's own lean, so it falls
 *   straight away from the ute. (A rope waits for ropes.)
 * - **Budget:** the director's: one hazard at a time, a quiet spell after each, at most TREE.max,
 *   TREE.cooldownS apart.
 *
 * Host only, like the rest of the director: guests see the lean and the fall in the snapshots and
 * get the tell's toast with the level's events (its crack plays from that toast). A guest who joins
 * mid-tell has missed the toast and its crack, but sees the lean.
 */

import type { Forestry } from './forestry.ts';

const S = (s: number) => Math.round(s * 60);

export const TREE = {
    /** The ute within this far (m, horizontally, trunk to the ute's nearest end) is within reach. */
    reach: 5.5,
    /**
     * From the crack, the tree cannot fall for this long (s). A player at the tree needs 5 s to
     * walk to the ute, get in and drive it out of reach (tested, by input): 2 s more to read it.
     */
    tellS: 7,
    /**
     * The lean towards the ute (rad) that replaces the tree's own: less than a cut's push (0.07), so
     * cutting from the ute's side leaves 0.035 away from it, twice what the forestry calls balanced.
     */
    lean: 0.035,
    /**
     * How the tree is drawn leaning over the tell (rad): from its own lean to this far towards the
     * ute, with a shake of this much at 2 Hz (its top, 7 m up, moves about 1.4 m).
     */
    shown: 0.2,
    shake: 0.02,
    /** With the tree still standing this long after the crack (nobody finishing it), it is over. */
    giveUpS: 60,
    cooldownS: 60,
    max: 2
} as const;

/** The ute's half length (m): reach is measured to its nearer end. */
const UTE_HALF = 1.84;

export const TREE_PHASE = { idle: 0, tell: 1, active: 2 } as const;

/** The tell's toast (every device plays its crack from it: src/audio/game-audio.ts). */
export const TREE_TELL =
    '🌲 Crack! The pine is leaning towards the ute! Move the ute, or cut from its side so it falls away.';

export interface TreeHazardHost {
    readonly tick: number;
    readonly forestry: Pick<
        Forestry,
        'def' | 'treeCount' | 'treeState' | 'fallBias' | 'holdFall' | 'sway' | 'fallDirection'
    >;
    /** Where the ute's body is (null: no drivable ute). */
    readonly utePos: { x: number; z: number } | null;
    say(text: string): void;
    /** How it ended, for the playtest log (host only, not sent). */
    outcome?(text: string): void;
}

export class TreeHazard {
    phase: number = TREE_PHASE.idle;
    /** The tree it is aimed at (-1: none), and when its crack came. */
    tree = -1;
    since = 0;
    count = 0;
    /** When the last one ended (its tick), for the cooldown. */
    ended = -1e9;
    /** Each tree's cut count at the last step: a fresh bite is a rise. */
    private seen: number[] = [];
    private host: TreeHazardHost | null = null;
    /** While it stands: was the ute in reach, and would it fall towards the ute (for the outcome)? */
    private lastInReach = false;
    private lastTowards = false;

    reset(): void {
        this.phase = TREE_PHASE.idle;
        this.tree = -1;
        this.since = this.count = 0;
        this.ended = -1e9;
        this.seen = [];
    }

    get busy(): boolean {
        return this.phase !== TREE_PHASE.idle;
    }

    /** How far the ute is from tree n's trunk (to its nearer end, m), Infinity without a ute. */
    private uteDistance(h: TreeHazardHost, n: number): number {
        const t = h.forestry.def?.trees[n];
        if (!t || !h.utePos) return Infinity;
        return Math.max(0, Math.hypot(h.utePos.x - t.x, h.utePos.z - t.z) - UTE_HALF);
    }

    /** One tick; `mayStart` is the director's budget (no other hazard, the quiet spell over). */
    step(h: TreeHazardHost, mayStart: boolean): void {
        const f = h.forestry;
        if (!f.def) return;
        this.install(h);
        // which trees took a bite or blow since the last step (the first step only learns the counts)
        let bitten = -1;
        for (let n = 0; n < f.treeCount; n++) {
            const cuts = f.treeState(n).cuts;
            const was = this.seen[n];
            if (was !== undefined && cuts > was && bitten < 0) bitten = n;
            this.seen[n] = cuts;
        }
        if (this.phase === TREE_PHASE.idle) {
            if (bitten < 0 || !mayStart || this.count >= TREE.max || h.tick - this.ended < S(TREE.cooldownS)) return;
            const st = f.treeState(bitten);
            if (st.phase !== 'standing' || this.uteDistance(h, bitten) > TREE.reach) return;
            this.phase = TREE_PHASE.tell;
            this.tree = bitten;
            this.since = h.tick;
            this.count++;
            h.say(TREE_TELL);
            return;
        }
        if (this.phase === TREE_PHASE.tell && h.tick - this.since >= S(TREE.tellS)) this.phase = TREE_PHASE.active;
        // where it would go, while it still stands (the outcome is told from the last of these)
        if (f.treeState(this.tree).phase === 'standing') {
            const t = f.def.trees[this.tree];
            this.lastInReach = this.uteDistance(h, this.tree) <= TREE.reach;
            if (t && h.utePos) {
                const d = f.fallDirection(this.tree);
                this.lastTowards = d.x * (h.utePos.x - t.x) + d.z * (h.utePos.z - t.z) > 0;
            }
        }
        const st = f.treeState(this.tree);
        // over once it is down (or nobody finished it for a long while)
        if (st.phase !== 'standing' || h.tick - this.since >= S(TREE.giveUpS)) {
            h.outcome?.(
                st.phase === 'standing'
                    ? 'left standing'
                    : !this.lastInReach
                      ? 'the ute moved out of reach'
                      : this.lastTowards
                        ? 'fell towards the ute'
                        : 'cut from the ute’s side: fell away from it'
            );
            this.phase = TREE_PHASE.idle;
            this.tree = -1;
            this.ended = h.tick;
        }
    }

    /** The hooks into the forestry: the pull towards the ute, the hold during the tell, the drawn lean. */
    private install(h: TreeHazardHost): void {
        this.host = h;
        const f = h.forestry;
        if (f.fallBias) return;
        f.fallBias = (n) => this.bias(n);
        f.holdFall = (n) => this.phase === TREE_PHASE.tell && n === this.tree;
        f.sway = (n) => this.swayOf(n);
    }

    /** The unit direction from tree n to the ute, while it is the hazard's tree and the ute in reach. */
    private toUte(n: number): { x: number; z: number } | null {
        const h = this.host;
        const t = h?.forestry.def?.trees[n];
        if (!h || !t || !h.utePos || this.phase === TREE_PHASE.idle || n !== this.tree) return null;
        // moved out of reach: no pull
        if (this.uteDistance(h, n) > TREE.reach) return null;
        const dx = h.utePos.x - t.x;
        const dz = h.utePos.z - t.z;
        const len = Math.hypot(dx, dz);
        return len < 1e-6 ? null : { x: dx / len, z: dz / len };
    }

    /** The extra tilt on the fall: the tree's own lean taken away, TREE.lean towards the ute put in. */
    private bias(n: number): { x: number; z: number } | null {
        const u = this.toUte(n);
        const own = this.host?.forestry.def?.trees[n].lean;
        if (!u) return null;
        return { x: u.x * TREE.lean - (own?.x ?? 0), z: u.z * TREE.lean - (own?.z ?? 0) };
    }

    /**
     * The lean drawn from the crack until it falls (or is given up): growing to 1 over the tell,
     * towards the ute, and the tree's whole tilt (from its own lean to TREE.shown towards the ute,
     * shaking). Out of the ute's reach, none: it stands back up.
     */
    private swayOf(n: number): { amount: number; yaw: number; tilt: { x: number; z: number } } | null {
        const u = this.toUte(n);
        const h = this.host;
        if (!u || !h) return null;
        const t = h.tick - this.since + 1;
        const a = Math.min(1, t / S(TREE.tellS));
        const own = h.forestry.def?.trees[n].lean;
        const towards = a * TREE.shown + a * TREE.shake * Math.sin((2 * Math.PI * t) / 30);
        return {
            amount: a,
            yaw: Math.atan2(u.x, u.z),
            tilt: { x: (own?.x ?? 0) * (1 - a) + u.x * towards, z: (own?.z ?? 0) * (1 - a) + u.z * towards }
        };
    }
}
