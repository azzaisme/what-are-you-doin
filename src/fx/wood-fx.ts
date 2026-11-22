/**
 * Wood effects (Epic 6, #58): chips when a tree is bitten or chopped and a log bucked, a burst of
 * needles when a felled tree's crown breaks off or a stump regrows, and sawdust while the sawmill
 * saws. Bounded, pooled voxel particles (ParticleFX bursts), never rigid bodies.
 *
 * Like the other effects, every device works them out itself from the interpolated snapshots: the
 * sim counts each bite and each crown on two effect entities (the count in a channel, the place in
 * the pose), and the sawmill's state is in its own channels. Nothing extra is networked.
 *
 * The same moments make their sounds (Epic 8, #82, through `sfx`, so nothing until the game's audio
 * runs): a chop at every bite or blow, a heavy thud when a felled tree's crown breaks off, and the
 * sawmill's motor held on while its blade runs, a little higher as the cut goes through.
 *
 * A hazard's sway (the falling tree, #74, on each stand tree's marker): the crown shakes, shedding
 * needles on the side it leans to, further out as the sway grows, with a creak at each shake.
 */

import { SAW_CUTTING, SAW_PROGRESS, SAW_STATE, TREE_SWAY, TREE_SWAY_YAW } from '../assets/forestry.ts';
import { sfx } from '../audio/sfx.ts';
import { SAWMILL, sawmillToWorld } from '../levels/forestry.ts';
import type { SawmillSpot } from '../levels/forestry.ts';
import { ANIM_MAX } from '../sim/snapshots.ts';
import type { SnapshotRing } from '../sim/snapshots.ts';
import { pose } from '../voxels/math.ts';

export type WoodBurst = 'chips' | 'needles' | 'sawdust';

export interface WoodSlots {
    chips: number;
    needles: number;
    sawmill: number;
    /** The stand trees' markers (their sway); none: no sway shown. */
    markers?: readonly number[];
}

/** A swaying crown sheds needles this often (s), this high over the tree's foot (m), this far out. */
export const SWAY_FX = { every: 0.5, crownY: 4.5, out0: 0.6, out1: 1.6 } as const;

/** Sawdust puffs this often while the blade runs (s). */
const SAWDUST_EVERY = 0.2;

export class WoodFX {
    private readonly slots: WoodSlots;
    private readonly spot: SawmillSpot | null;
    private lastChips = NaN;
    private lastNeedles = NaN;
    private lastPuff = -1;
    private readonly lastShake: number[] = [];
    private readonly p = pose();
    private readonly anim = new Float64Array(ANIM_MAX);

    constructor(slots: WoodSlots, spot: SawmillSpot | null) {
        this.slots = slots;
        this.spot = spot;
    }

    /** Forget the counters (a seek or reset): the next sample only sets them. */
    reset(): void {
        this.lastChips = this.lastNeedles = NaN;
        this.lastPuff = -1;
        this.lastShake.length = 0;
    }

    /** Spawns the bursts due at this voxel time. */
    update(time: number, ring: SnapshotRing, burst: (kind: WoodBurst, x: number, y: number, z: number) => void): void {
        if (ring.sample(this.slots.chips, time, this.p, this.anim)) {
            const c = Math.floor(this.anim[0] + 1e-6);
            if (c > this.lastChips) {
                burst('chips', this.p.p.x, this.p.p.y, this.p.p.z);
                sfx.play('chop', this.p.p, { gain: 0.9 });
            }
            this.lastChips = c;
        }
        if (ring.sample(this.slots.needles, time, this.p, this.anim)) {
            const c = Math.floor(this.anim[0] + 1e-6);
            if (c > this.lastNeedles) {
                burst('needles', this.p.p.x, this.p.p.y, this.p.p.z);
                sfx.play('thud', this.p.p, { gain: 1.2, pitch: 0.7 });
            }
            this.lastNeedles = c;
        }
        const markers = this.slots.markers ?? [];
        for (let n = 0; n < markers.length; n++) {
            if (!ring.sample(markers[n], time, this.p, this.anim)) continue;
            const amount = this.anim[TREE_SWAY];
            if (!(amount > 0.01)) continue;
            const k = Math.floor(time / SWAY_FX.every);
            if (k === this.lastShake[n]) continue;
            this.lastShake[n] = k;
            // shed on the side it leans to, further out as it goes
            const yaw = this.anim[TREE_SWAY_YAW];
            const out = SWAY_FX.out0 + (SWAY_FX.out1 - SWAY_FX.out0) * Math.min(1, amount);
            const x = this.p.p.x + Math.sin(yaw) * out;
            const y = this.p.p.y + SWAY_FX.crownY;
            const z = this.p.p.z + Math.cos(yaw) * out;
            burst('needles', x, y, z);
            sfx.creak({ x, y, z }, 0.4 + 0.6 * Math.min(1, amount));
        }
        if (this.spot && ring.sample(this.slots.sawmill, time, this.p, this.anim)) {
            // the blade is in the wood while cutting: the state stays "cutting" while the pieces
            // come out (progress 1), which can be a while when the rack or the plank pool is full
            const progress = this.anim[SAW_PROGRESS];
            const sawing = Math.round(this.anim[SAW_STATE]) === SAW_CUTTING && progress < 1;
            if (sawing) {
                const at = sawmillToWorld(this.spot, 0, SAWMILL.feedY, 0);
                sfx.hold(`sawmill-${this.slots.sawmill}`, 'saw', at, { gain: 0.8, pitch: 0.92 + 0.12 * progress });
            }
            const k = Math.floor(time / SAWDUST_EVERY);
            if (sawing && k !== this.lastPuff) {
                // out of the blade's back, low over the outfeed side
                const w = sawmillToWorld(this.spot, -0.35, SAWMILL.feedY + 0.1, 0);
                burst('sawdust', w.x, w.y, w.z);
            }
            this.lastPuff = k;
        }
    }
}
