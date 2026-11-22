/**
 * The sawmill (Epic 6, design doc §2.5): one log at a time in, planks out, never twice.
 *
 * - Feed: a log (or a short log) lying still in the infeed guide, roughly along it and held by
 *   nobody, for half a second, is taken. From then on it belongs to the machine: its body is out
 *   of the world (nobody can grab it, nothing can push it, the guide can take nothing else) and the
 *   sim moves it through the blade. That is the feed interlock: a piece is processed exactly once.
 * - Safety interlocks: the blade stops while anyone stands in its guard zone, and planks only come
 *   out where the outfeed rack is clear of other bodies and players (else the machine waits).
 * - Output: a log makes PLANKS_PER_LOG planks, a short log one. Sawn planks are ordinary planks.
 * - The machine shows what it is doing: the blade turns while it saws, a lamp (green ready, orange
 *   sawing, red stopped) and a progress bar (the `sawmill` entity's channels), and sawdust flies.
 *
 * Deterministic, fixed ticks, host only; guests see it through the snapshots.
 */

import RAPIER from '@dimforge/rapier3d-compat';

import {
    SAW_BEAM,
    SAW_CUTTING,
    SAW_MODE,
    SAW_PLANKS,
    SAW_PROGRESS,
    SAW_READY,
    SAW_SPIN,
    SAW_STATE,
    SAW_STOPPED
} from '../assets/forestry.ts';
import { BEAM_HALF } from '../assets/props.ts';
import { SAWMILL, sawmillToWorld, worldToSawmill } from '../levels/forestry.ts';
import type { SawmillSpot } from '../levels/forestry.ts';
import { pose, quatFromYawPitchRoll, quatMul, quatRotate, quatSlerp } from '../voxels/math.ts';
import type { Pose } from '../voxels/math.ts';

import type { Forestry, WoodKind } from './forestry.ts';
import type { SimEntity } from './lab-entities.ts';
import { GRAB, viewDir } from './physics/grab.ts';
import { LAYER, groups } from './physics/world.ts';
import type { PhysicsWorld } from './physics/world.ts';

export const SAW = {
    /** A piece must lie still in the guide this long before the machine takes it (ticks). */
    settleTicks: 30,
    /** ...moving slower than this (m/s) and turning slower than this (rad/s)... */
    still: 0.35,
    stillSpin: 0.8,
    /** ...and lying within this angle of the guide's axis (rad). */
    alignment: (30 * Math.PI) / 180,
    /** Sawing one piece takes this long (ticks) with the blade running. */
    cutTicks: 240,
    /** Blade speed while sawing (rad/s). */
    bladeSpeed: 22
} as const;

export const PLANKS_PER_LOG = 3;
const YIELD: Record<WoodKind, number> = { log: PLANKS_PER_LOG, short: 1 };

export type SawPhase = 'ready' | 'cutting' | 'output';
/** What the sawmill makes from a whole log: three planks, or one beam (set with its lever). */
export type SawMode = 'planks' | 'beam';

export class Sawmill {
    readonly spot: SawmillSpot;
    readonly entity: SimEntity;
    private readonly wood: Forestry;
    private pw!: PhysicsWorld;
    phase: SawPhase = 'ready';
    mode: SawMode = 'planks';
    /** What the piece being sawn comes out as. */
    private out: 'plank' | 'beam' = 'plank';
    /** The piece being sawn (entity), its kind, and where it lay when taken. */
    private piece: SimEntity | null = null;
    private kind: WoodKind = 'log';
    private readonly from = pose();
    progress = 0;
    /** Planks still to come out for the piece just sawn. */
    private pending = 0;
    private candidate = -1;
    private settled = 0;
    private spin = 0;
    /** Why it is stopped right now ('' when it is not). */
    stopped: '' | 'guard' | 'outfeed' = '';
    private toldFull = false;
    /** Totals (tests): pieces taken, planks made, each piece's id when taken. */
    readonly stats = { taken: 0, planks: 0, guardStops: 0, outfeedWaits: 0, takenIds: [] as number[] };

    constructor(spot: SawmillSpot, entity: SimEntity, wood: Forestry) {
        this.spot = spot;
        this.entity = entity;
        this.wood = wood;
    }

    build(pw: PhysicsWorld): void {
        this.pw = pw;
        this.phase = 'ready';
        this.mode = 'planks';
        this.out = 'plank';
        this.piece = null;
        this.progress = 0;
        this.pending = 0;
        this.candidate = -1;
        this.settled = 0;
        this.spin = 0;
        this.stopped = '';
        this.toldFull = false;
        Object.assign(this.stats, { taken: 0, planks: 0, guardStops: 0, outfeedWaits: 0, takenIds: [] });
        this.publish();
    }

    /**
     * One tick, after the physics step and after the sim has read every prop's pose. `players`
     * are the feet of the players in the world (for the blade guard).
     */
    step(players: readonly { x: number; z: number }[]): void {
        if (this.phase === 'ready') this.watchGuide();
        else if (this.phase === 'cutting') this.saw(players);
        if (this.phase === 'output') this.output();
        // the piece being sawn is drawn where the machine has it (its body is out of the world)
        if (this.piece && this.phase === 'cutting') this.placePiece();
        this.publish();
    }

    private watchGuide(): void {
        const pw = this.pw;
        const G = SAWMILL.guide;
        const mid = (G.x0 + G.x1) / 2;
        let found = -1;
        for (const e of this.wood.sawable) {
            const b = pw.bodies.get(e.id);
            if (!b || !b.enabled || this.wood.isFalling(e.id)) continue;
            const l = worldToSawmill(this.spot, e.pose.p.x, e.pose.p.y, e.pose.p.z);
            if (Math.abs(l.x - mid) > SAWMILL.guideSlack || Math.abs(l.z) > G.halfZ || l.y > 0.7) continue;
            // along the guide: the piece's long axis (+x) close to the machine's x axis
            quatRotate(e.pose.q, 1, 0, 0, _v);
            const ax = worldToSawmill(this.spot, this.spot.x + _v.x, this.spot.y + _v.y, this.spot.z + _v.z);
            if (Math.abs(ax.x) < Math.cos(SAW.alignment)) continue;
            if (pw.holders(e.id) > 0) continue;
            const lv = b.body.linvel();
            const av = b.body.angvel();
            if (Math.hypot(lv.x, lv.y, lv.z) > SAW.still || Math.hypot(av.x, av.y, av.z) > SAW.stillSpin) continue;
            found = e.id;
            break;
        }
        if (found < 0 || found !== this.candidate) {
            this.candidate = found;
            this.settled = 0;
            return;
        }
        if (++this.settled < SAW.settleTicks) return;
        const kind = this.wood.woodKind(found)!;
        // a beam takes a whole log; a short log only ever makes a plank
        const out = this.mode === 'beam' && kind === 'log' ? 'beam' : 'plank';
        const count = out === 'beam' ? 1 : YIELD[kind];
        if (this.wood.freeSawn(out) < count) {
            if (!this.toldFull) {
                this.toldFull = true;
                this.wood.say(`The sawmill waits: too many sawn ${out}s lying about. Use some first.`);
            }
            return;
        }
        this.toldFull = false;
        // the feed interlock: the piece leaves the world and belongs to the machine
        const e = this.wood.sawable.find((x) => x.id === found)!;
        this.piece = e;
        this.kind = kind;
        this.out = out;
        this.from.p.x = e.pose.p.x;
        this.from.p.y = e.pose.p.y;
        this.from.p.z = e.pose.p.z;
        this.from.q.x = e.pose.q.x;
        this.from.q.y = e.pose.q.y;
        this.from.q.z = e.pose.q.z;
        this.from.q.w = e.pose.q.w;
        pw.setEnabled(found, false);
        this.phase = 'cutting';
        this.progress = 0;
        this.candidate = -1;
        this.settled = 0;
        this.stats.taken++;
        this.stats.takenIds.push(found);
        this.wood.say(kind === 'log' ? 'The sawmill takes the log.' : 'The sawmill takes the short log.');
    }

    private saw(players: readonly { x: number; z: number }[]): void {
        // the blade guard: anyone at the blade stops it
        const g = SAWMILL.guard;
        const blocked = players.some((p) => {
            const l = worldToSawmill(this.spot, p.x, this.spot.y, p.z);
            return Math.abs(l.x) < g.halfX && Math.abs(l.z) < g.halfZ;
        });
        if (blocked) {
            if (this.stopped !== 'guard') {
                this.stopped = 'guard';
                this.stats.guardStops++;
                this.wood.say('Safety stop: someone is at the blade. Stand clear and it carries on.');
            }
            return;
        }
        this.stopped = '';
        this.spin += SAW.bladeSpeed / 60;
        this.progress = Math.min(1, this.progress + 1 / SAW.cutTicks);
        if (this.progress < 1) return;
        // sawn: the piece is gone for good (a pooled piece back to its pool)
        const id = this.piece!.id;
        this.wood.take(id);
        this.piece!.visible = false;
        this.piece = null;
        this.pending = this.out === 'beam' ? 1 : YIELD[this.kind];
        this.phase = 'output';
    }

    /**
     * Puts out the planks still due, one a tick (the clearance query sees last tick's bodies), each
     * where the rack is clear; waits while it is not.
     */
    private output(): void {
        if (this.pending > 0) {
            const at = this.freeSpot(this.out);
            if (!at) {
                if (this.stopped !== 'outfeed') {
                    this.stopped = 'outfeed';
                    this.stats.outfeedWaits++;
                    this.wood.say('Outfeed blocked: clear the rack and the sawmill finishes.');
                }
                return;
            }
            if (!this.wood.spawnPlank(at, this.out)) return;
            this.pending--;
            this.stats.planks++;
            this.stopped = '';
            if (this.pending > 0) return;
        }
        this.stopped = '';
        this.phase = 'ready';
        this.progress = 0;
        this.wood.say(this.out === 'beam' ? 'A fresh beam on the rack.' : 'Fresh planks on the rack.');
    }

    /** The first clear place on the rack for a plank or a beam (three lanes, two layers), or null. */
    private freeSpot(out: 'plank' | 'beam'): Pose | null {
        const O = SAWMILL.outfeed;
        const flat = quatMul(quatFromYawPitchRoll(this.spot.yaw, 0, 0), quatFromYawPitchRoll(0, Math.PI / 2, 0));
        // half thickness lying flat (plank 0.1 m, beam 0.15 m)
        const half = out === 'beam' ? BEAM_HALF.z : 0.05;
        for (let layer = 0; layer < 2; layer++)
            for (const z of O.laneZ) {
                const w = sawmillToWorld(this.spot, O.x, O.barTop + half + 0.003 + layer * (2 * half + 0.005), z);
                if (this.clear(w, flat, out)) return pose(w.x, w.y, w.z, flat);
            }
        return null;
    }

    /** True when a plank (or beam) at this pose would touch no body or player (static geometry aside). */
    private clear(
        p: { x: number; y: number; z: number },
        q: { x: number; y: number; z: number; w: number },
        out: 'plank' | 'beam'
    ): boolean {
        let hit = false;
        // a little longer and wider than the piece, so new pieces never start pressed into anything
        const shape =
            out === 'beam'
                ? new RAPIER.Cuboid(BEAM_HALF.x + 0.04, BEAM_HALF.y + 0.02, BEAM_HALF.z - 0.005)
                : new RAPIER.Cuboid(1.24, 0.12, 0.045);
        this.pw.world.intersectionsWithShape(
            p,
            q,
            shape,
            () => {
                hit = true;
                return false;
            },
            undefined,
            groups(0xffff, LAYER.prop | LAYER.player | LAYER.kinematic | LAYER.held)
        );
        return !hit;
    }

    /** The piece being sawn: from where it lay, along the guide, through the blade. */
    private placePiece(): void {
        const e = this.piece!;
        const G = SAWMILL.guide;
        const k = Math.min(1, this.progress * 1.25);
        // first settle onto the feed line, then travel to just past the blade
        const s = Math.min(1, k * 4);
        const x = (G.x0 + G.x1) / 2 + ((this.kind === 'log' ? -1.2 : -0.8) - (G.x0 + G.x1) / 2) * k;
        const w = sawmillToWorld(this.spot, x, SAWMILL.feedY, 0);
        const along = quatFromYawPitchRoll(this.spot.yaw, 0, 0);
        // keep its roll about its own axis as it was (it does not spin round)
        e.pose.p.x = this.from.p.x + (w.x - this.from.p.x) * s;
        e.pose.p.y = this.from.p.y + (w.y - this.from.p.y) * s;
        e.pose.p.z = this.from.p.z + (w.z - this.from.p.z) * s;
        if (s >= 1) {
            e.pose.p.x = w.x;
            e.pose.p.y = w.y;
            e.pose.p.z = w.z;
        }
        quatSlerp(this.alignedFrom(along), along, s, e.pose.q);
        e.visible = true;
    }

    /** The piece's starting orientation, turned end for end if it lay the other way round. */
    private alignedFrom(along: { x: number; y: number; z: number; w: number }): {
        x: number;
        y: number;
        z: number;
        w: number;
    } {
        quatRotate(this.from.q, 1, 0, 0, _v);
        quatRotate(along, 1, 0, 0, _v2);
        if (_v.x * _v2.x + _v.y * _v2.y + _v.z * _v2.z >= 0) return this.from.q;
        return quatMul(this.from.q, FLIP, _q);
    }

    private publish(): void {
        const e = this.entity;
        e.visible = true;
        e.pose.p.x = this.spot.x;
        e.pose.p.y = this.spot.y;
        e.pose.p.z = this.spot.z;
        quatFromYawPitchRoll(this.spot.yaw, 0, 0, e.pose.q);
        e.anim[SAW_SPIN] = this.spin;
        e.anim[SAW_PROGRESS] = this.phase === 'cutting' ? this.progress : this.phase === 'output' ? 1 : 0;
        e.anim[SAW_STATE] = this.stopped ? SAW_STOPPED : this.phase === 'ready' ? SAW_READY : SAW_CUTTING;
        e.anim[SAW_MODE] = this.mode === 'beam' ? SAW_BEAM : SAW_PLANKS;
    }

    /** True when the view ray from the eye meets the mode lever within reach. */
    aimLever(eye: { x: number; y: number; z: number }, yaw: number, pitch: number): boolean {
        const L = SAWMILL.lever;
        const c = sawmillToWorld(this.spot, L.x, L.y + 0.12, L.z);
        const d = viewDir(yaw, pitch, _v);
        const ox = c.x - eye.x;
        const oy = c.y - eye.y;
        const oz = c.z - eye.z;
        const t = ox * d.x + oy * d.y + oz * d.z;
        if (t < 0 || t > GRAB.reach) return false;
        const px = ox - d.x * t;
        const py = oy - d.y * t;
        const pz = oz - d.z * t;
        return px * px + py * py + pz * pz < 0.22 * 0.22;
    }

    /** A grab at the lever: switches between planks and a beam (the piece being sawn keeps its own). */
    pressLever(eye: { x: number; y: number; z: number }, yaw: number, pitch: number): boolean {
        if (!this.aimLever(eye, yaw, pitch)) return false;
        this.mode = this.mode === 'planks' ? 'beam' : 'planks';
        this.wood.say(
            this.mode === 'beam'
                ? 'The sawmill is set to beams: one 3.2 m beam from each whole log.'
                : 'The sawmill is set to planks: three planks from each log.'
        );
        this.publish();
        return true;
    }

    /** True while the blade turns (sawdust). */
    get running(): boolean {
        return this.phase === 'cutting' && !this.stopped;
    }
}

const _v = { x: 0, y: 0, z: 0 };
const _v2 = { x: 0, y: 0, z: 0 };
const _q = { x: 0, y: 0, z: 0, w: 1 };
/** Half a turn about +y (end for end). */
const FLIP = { x: 0, y: 1, z: 0, w: 0 };
