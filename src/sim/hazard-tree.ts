/**
 * Hazard (#74): a tree falls towards the ute. Start cutting a stand tree while the ute stands within
 * its reach, and the pine cracks and leans towards the ute: it will fall its way.
 *
 * - **Tell:** a crack and a toast the moment the cut starts, and the tree cannot fall for TREE.tellS
 *   after it, however fast it is chewed or chopped (it hangs on its last fibres). That is the time to
 *   react.
 * - **What happens:** when it falls, a lean towards the ute (TREE.lean) joins the cut's push and the
 *   tree's own lean. Cut from anywhere but the ute's side and it comes down on or towards the ute.
 * - **Counterplay:** move the ute out of reach (no lean, it falls the way it was cut), or cut from
 *   the ute's side: the cut's push away from the cutter is stronger than the lean, so it falls away
 *   from the ute. (A rope waits for ropes.)
 * - **Budget:** the director's: one hazard at a time, a quiet spell after each, at most TREE.max,
 *   TREE.cooldownS apart.
 *
 * Host only, like the rest of the director: guests see the fall in the snapshots and get the tell's
 * toast with the level's events (its crack plays from that toast).
 */

import type { Forestry } from './forestry.ts';

const S = (s: number) => Math.round(s * 60);

export const TREE = {
    /** The ute within this far (m, horizontally, trunk to the ute's nearest end) is within reach. */
    reach: 5.5,
    /** From the crack, the tree cannot fall for this long (s). */
    tellS: 4,
    /** The lean towards the ute (rad): less than a cut's push (0.07), so cutting from its side wins. */
    lean: 0.06,
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
    readonly forestry: Pick<Forestry, 'def' | 'treeCount' | 'treeState' | 'fallBias' | 'holdFall'>;
    /** Where the ute's body is (null: no drivable ute). */
    readonly utePos: { x: number; z: number } | null;
    say(text: string): void;
}

export class TreeHazard {
    phase: number = TREE_PHASE.idle;
    /** The tree it is aimed at (-1: none), and when its crack came. */
    tree = -1;
    since = 0;
    count = 0;
    private ended = -1e9;
    private host: TreeHazardHost | null = null;

    reset(): void {
        this.phase = TREE_PHASE.idle;
        this.tree = -1;
        this.since = this.count = 0;
        this.ended = -1e9;
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
        if (this.phase === TREE_PHASE.idle) {
            if (!mayStart || this.count >= TREE.max || h.tick - this.ended < S(TREE.cooldownS)) return;
            for (let n = 0; n < f.treeCount; n++) {
                const st = f.treeState(n);
                if (st.phase !== 'standing' || st.cut <= 0 || this.uteDistance(h, n) > TREE.reach) continue;
                this.phase = TREE_PHASE.tell;
                this.tree = n;
                this.since = h.tick;
                this.count++;
                h.say(TREE_TELL);
                return;
            }
            return;
        }
        if (this.phase === TREE_PHASE.tell && h.tick - this.since >= S(TREE.tellS)) this.phase = TREE_PHASE.active;
        const st = f.treeState(this.tree);
        // over once it is down (or nobody finished it for a long while)
        if (st.phase !== 'standing' || h.tick - this.since >= S(TREE.giveUpS)) {
            this.phase = TREE_PHASE.idle;
            this.tree = -1;
            this.ended = h.tick;
        }
    }

    /** The hooks into the forestry: the lean towards the ute, and the hold during the tell. */
    private install(h: TreeHazardHost): void {
        this.host = h;
        const f = h.forestry;
        if (f.fallBias) return;
        f.fallBias = (n) => this.bias(n);
        f.holdFall = (n) => this.phase === TREE_PHASE.tell && n === this.tree;
    }

    private bias(n: number): { x: number; z: number } | null {
        const h = this.host;
        const t = h?.forestry.def?.trees[n];
        if (!h || !t || !h.utePos || this.phase === TREE_PHASE.idle || n !== this.tree) return null;
        // moved out of reach: no pull
        if (this.uteDistance(h, n) > TREE.reach) return null;
        const dx = h.utePos.x - t.x;
        const dz = h.utePos.z - t.z;
        const len = Math.hypot(dx, dz);
        return len < 1e-6 ? null : { x: (dx / len) * TREE.lean, z: (dz / len) * TREE.lean };
    }
}
