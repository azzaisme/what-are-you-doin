/**
 * Logging (Epic 6, design doc §2.5), the simulation side: the stand's trees, their cut state and
 * fall, the logs they become, bucking logs into short ones, the axe, regrowth, and the pools of
 * pieces the sawmill (sawmill.ts) consumes and fills.
 *
 * - A stand tree is static scenery with a simple collider (its trunk: no foliage collision) until it is cut.
 *   Chewing it (grab with empty hands, looking at the trunk) or chopping it (grab while holding
 *   the axe) advances its cut. Each bite or blow comes from the side the player stands on, and the
 *   tree falls away from that side, so the cutter is never under it. At 70 % it creaks and the
 *   players are warned.
 * - When the cut completes, the trunk above the cut becomes a physical log, once: a pooled log body
 *   is placed exactly where the trunk stood, tipped a little away from the cut and given a slow
 *   start. The crown rides on it (never colliding) and breaks off in a burst of needles when the
 *   tree has fallen. The stump stays, with a small collider.
 * - With the axe, a log on the ground can be bucked into two short logs, each light enough for one
 *   beaver: the solo way to the sawmill.
 * - Resources come back: a stump regrows into a full tree once its log has gone and nothing stands
 *   in the way; the level's own logs return to their pile after being sawn; a pooled piece lost in
 *   the creek returns to its pool.
 *
 * Everything here runs in fixed ticks on the host, from sanitized commands and physics state, and
 * publishes through entities (poses, visibility, animation channels): guests and the voxel worker
 * learn of a felled or regrown tree from the stand marker's channels in the snapshots.
 */

import RAPIER from '@dimforge/rapier3d-compat';

import { LOG_CENTRE_HEIGHT, TREE_CUT, TREE_DOWN, TREE_STANDING, TREE_STATE } from '../assets/forestry.ts';
import { LOG_RADIUS } from '../assets/props.ts';
import { CROWN_TRUNK_TOP, LOG_LENGTH, STUMP_HEIGHT } from '../levels/forestry.ts';
import type { ForestryDef } from '../levels/forestry.ts';
import type { LevelDef } from '../levels/level.ts';
import { pose, quatFromAxisAngle, quatFromYawPitchRoll, quatMul, quatRotate } from '../voxels/math.ts';
import type { Pose, Quat } from '../voxels/math.ts';

import type { ForestryEntities, SimEntity } from './lab-entities.ts';
import { propBody } from './lab-physics.ts';
import { GRAB, viewDir } from './physics/grab.ts';
import { LAYER, groups } from './physics/world.ts';
import type { PhysicsWorld } from './physics/world.ts';

/** Tuning (ticks at 60 Hz). */
export const WOOD = {
    /** Cut per bite (chewing) and per blow (the axe): 10 bites or 4 blows fell a tree. */
    bite: 1 / 10,
    blow: 1 / 4,
    /** Ticks between bites, and between blows, for one player. */
    biteTicks: 18,
    blowTicks: 27,
    /** Cut at which the tree creaks and players are warned. */
    warnAt: 0.7,
    /** How far you can reach a trunk to cut it (m from the eye). */
    reach: GRAB.reach,
    /** The felled trunk starts tipped this far (rad) and turning this fast (rad/s) away from the cut. */
    tilt0: 0.07,
    spin0: 0.55,
    /** The crown breaks off once the trunk has tipped this far from upright (rad), or after this long. */
    crownBreakTilt: (62 * Math.PI) / 180,
    crownMaxTicks: 240,
    /** Axe blows to buck a log into two short logs. */
    buckBlows: 3,
    /** A stump regrows this long after felling (ticks)... */
    regrowTicks: 45 * 60,
    /** ...once its log is at least this far away (or gone) and nothing is within this radius (m). */
    regrowLogClear: 3,
    regrowClear: 1.3,
    /** A pooled piece below the level's lost height this long goes back to its pool. */
    lostTicks: 180,
    /** The level's own logs come back to their pile this long after being sawn. */
    respawnTicks: 20 * 60
} as const;

export type TreePhase = 'standing' | 'down';

interface TreeState {
    phase: TreePhase;
    cut: number;
    /** Sum of the directions (unit, horizontal) from the trunk to whoever cut it. */
    dirX: number;
    dirZ: number;
    warned: boolean;
    /** Tick the tree was felled, and the felled-log slot its log took (-1 once that slot moved on). */
    downTick: number;
    slot: number;
    /** Told the players the pool is full (once per attempt). */
    blocked: boolean;
    colliders: RAPIER.Collider[];
}

interface Felled {
    used: boolean;
    /** The tree it came from (for the crown), or -1. */
    tree: number;
    fellTick: number;
    crown: boolean;
}

/** The kinds of wood the sawmill takes, with how many planks each makes. */
export type WoodKind = 'log' | 'short';

/** Where a bite or blow lands, and who struck it. */
export interface Strike {
    x: number;
    y: number;
    z: number;
}

export interface WoodEvent {
    kind: 'wood';
    text: string;
}

export class Forestry {
    readonly def: ForestryDef | null;
    readonly ents: ForestryEntities;
    /** The level's own logs (name 'log' and 'extra-log-*'), sawable and respawning. */
    readonly levelLogs: SimEntity[];
    private readonly level: LevelDef;
    private pw!: PhysicsWorld;
    private trees: TreeState[] = [];
    private felled: Felled[] = [];
    /** Axe blows into a lying log, by entity id. */
    private readonly buck = new Map<number, number>();
    /** Next tick each player may bite or swing again. */
    private readonly nextStrike: number[] = [];
    /** Lost-in-the-creek counters, by entity id. */
    private readonly lostTicks = new Map<number, number>();
    /** Level logs taken by the sawmill: entity id -> tick they come back. */
    private readonly respawnAt = new Map<number, number>();
    /** Wood events since the last call to `drain` (the sim turns them into toasts). */
    private readonly pending: string[] = [];
    /** Totals (tests, debug). */
    readonly stats = { bites: 0, blows: 0, felled: 0, bucked: 0, regrown: 0, returned: 0 };
    private tick = 0;
    private fxChips = 0;
    private fxNeedles = 0;

    constructor(level: LevelDef, ents: ForestryEntities, levelLogs: SimEntity[]) {
        this.level = level;
        this.def = level.forestry ?? null;
        this.ents = ents;
        this.levelLogs = levelLogs;
    }

    /** Pool entities with physics bodies (the sim reads their poses like any prop). */
    get props(): SimEntity[] {
        const e = this.ents;
        return [...e.felled, ...e.short, ...e.sawn, e.axe];
    }

    get treeCount(): number {
        return this.def ? Math.min(this.def.trees.length, this.ents.markers.length) : 0;
    }

    /** Phase and cut of a stand tree (tests, UI). */
    treeState(n: number): { phase: TreePhase; cut: number } {
        const t = this.trees[n];
        return { phase: t.phase, cut: t.cut };
    }

    /** The felled-log slot a tree's log took (-1 if none), for tests. */
    logOf(n: number): SimEntity | null {
        const t = this.trees[n];
        return t && t.slot >= 0 ? this.ents.felled[t.slot] : null;
    }

    /** Called from the sim's physics build (every reset): colliders, pool bodies, fresh state. */
    build(pw: PhysicsWorld): void {
        this.pw = pw;
        const e = this.ents;
        this.trees = [];
        this.felled = e.felled.map(() => ({ used: false, tree: -1, fellTick: -1, crown: false }));
        this.buck.clear();
        this.lostTicks.clear();
        this.respawnAt.clear();
        this.pending.length = 0;
        this.nextStrike.length = 0;
        this.tick = 0;
        this.fxChips = this.fxNeedles = 0;
        Object.assign(this.stats, { bites: 0, blows: 0, felled: 0, bucked: 0, regrown: 0, returned: 0 });
        const def = this.def;
        if (!def) return;
        const park = pose(0, -50, 0);
        // pool bodies exist from the start, disabled: enabling one never reorders the world
        for (const ent of [...e.felled, ...e.short, ...e.sawn]) {
            const b = propBody(ent.name)!;
            pw.addDynamic(ent.id, b.shape, park, b.opts);
            pw.setEnabled(ent.id, false);
        }
        if (def.axe) {
            const b = propBody('axe')!;
            pw.addDynamic(e.axe.id, b.shape, def.axe, b.opts);
        }
        for (let n = 0; n < this.treeCount; n++) {
            const t: TreeState = {
                phase: 'standing',
                cut: 0,
                dirX: 0,
                dirZ: 0,
                warned: false,
                downTick: -1,
                slot: -1,
                blocked: false,
                colliders: []
            };
            this.trees.push(t);
            this.addTreeColliders(n);
        }
        this.publish();
    }

    // ------------------------------------------------------------------------------- colliders

    private ground(n: number): number {
        const t = this.def!.trees[n];
        return this.level.terrainHeight(t.x, t.z);
    }

    private addTreeColliders(n: number): void {
        const pw = this.pw;
        const st = this.trees[n];
        for (const c of st.colliders) pw.world.removeCollider(c, false);
        st.colliders = [];
        const t = this.def!.trees[n];
        const g = this.ground(n);
        if (st.phase === 'down') {
            const half = STUMP_HEIGHT / 2;
            st.colliders.push(
                pw.addStatic(
                    RAPIER.ColliderDesc.cylinder(half + 0.025, LOG_RADIUS * 0.95)
                        .setTranslation(t.x, g + half - 0.025, t.z)
                        .setFriction(0.8)
                )
            );
            return;
        }
        const half = CROWN_TRUNK_TOP / 2;
        st.colliders.push(
            pw.addStatic(
                RAPIER.ColliderDesc.cylinder(half, LOG_RADIUS + 0.02)
                    .setTranslation(t.x, g + half - 0.05, t.z)
                    .setFriction(0.8)
            )
        );
        // no foliage collision (§2.5): the needles never block a view ray, snag a falling trunk
        // or stop a player; the trunk is what you bump into and cut
    }

    // ------------------------------------------------------------------------------- aiming

    /**
     * The standing stand tree whose trunk the view ray meets within reach (from the eye), or -1;
     * `hit` gets the point. Analytic (a vertical cylinder per tree), so it is cheap and exact.
     */
    aimTree(eye: { x: number; y: number; z: number }, yaw: number, pitch: number, hit?: Strike): number {
        if (!this.def) return -1;
        const d = viewDir(yaw, pitch, _dir);
        let best = -1;
        let bestT: number = WOOD.reach;
        const r = LOG_RADIUS + 0.06;
        for (let n = 0; n < this.treeCount; n++) {
            if (this.trees[n].phase !== 'standing') continue;
            const t = this.def.trees[n];
            // ray against the circle in the ground plane
            const ox = eye.x - t.x;
            const oz = eye.z - t.z;
            const a = d.x * d.x + d.z * d.z;
            if (a < 1e-9) continue;
            const b = ox * d.x + oz * d.z;
            const c = ox * ox + oz * oz - r * r;
            const disc = b * b - a * c;
            if (disc < 0) continue;
            const tt = c < 0 ? 0 : (-b - Math.sqrt(disc)) / a;
            if (tt < 0 || tt > bestT) continue;
            const y = eye.y + d.y * tt;
            const g = this.ground(n);
            if (y < g - 0.1 || y > g + LOG_CENTRE_HEIGHT + LOG_LENGTH / 2) continue;
            best = n;
            bestT = tt;
            if (hit) {
                hit.x = eye.x + d.x * tt;
                hit.y = y;
                hit.z = eye.z + d.z * tt;
            }
        }
        return best;
    }

    /**
     * The full-length log (a level log or a felled one, lying free) the view ray meets within reach,
     * looking past whatever the player holds (the axe), or -1.
     */
    aimLog(eye: { x: number; y: number; z: number }, yaw: number, pitch: number, holder: number, hit?: Strike): number {
        const pw = this.pw;
        const d = viewDir(yaw, pitch, _dir);
        const ray = new RAPIER.Ray({ x: eye.x, y: eye.y, z: eye.z }, { x: d.x, y: d.y, z: d.z });
        const rig = pw.rig(holder);
        const held = rig?.held?.body;
        const h = pw.world.castRay(
            ray,
            WOOD.reach,
            true,
            RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
            groups(0xffff, 0xffff & ~LAYER.player),
            rig?.collider,
            held
        );
        if (!h) return -1;
        const pb = pw.bodyOfCollider(h.collider.handle);
        if (!pb || !pb.enabled || !this.isFullLog(pb.id)) return -1;
        if (hit) {
            hit.x = eye.x + d.x * h.timeOfImpact;
            hit.y = eye.y + d.y * h.timeOfImpact;
            hit.z = eye.z + d.z * h.timeOfImpact;
        }
        return pb.id;
    }

    private isFullLog(id: number): boolean {
        if (this.levelLogs.some((e) => e.id === id)) return true;
        const k = this.ents.felled.findIndex((e) => e.id === id);
        return k >= 0 && !this.felled[k].crown;
    }

    /** What a player's grab would cut right now (for prompts): a stand marker or a log id, or -1. */
    aim(eye: { x: number; y: number; z: number }, yaw: number, pitch: number, holder: number, held: number): number {
        if (!this.def) return -1;
        const axe = held === this.ents.axe.id;
        if (held >= 0 && !axe) return -1;
        const n = this.aimTree(eye, yaw, pitch);
        if (n >= 0) return this.ents.markers[n].id;
        return axe ? this.aimLog(eye, yaw, pitch, holder) : -1;
    }

    // ------------------------------------------------------------------------------- cutting

    /**
     * A grab press that may be a bite or a blow: chewing with empty hands, chopping with the axe in
     * hand. Returns true when the press was used for cutting (the sim then neither grabs nor
     * releases). `feet` is where the player stands (the side the cut comes from).
     */
    strike(
        i: number,
        eye: { x: number; y: number; z: number },
        feet: { x: number; z: number },
        yaw: number,
        pitch: number,
        held: number
    ): boolean {
        if (!this.def) return false;
        const axe = held === this.ents.axe.id;
        if (held >= 0 && !axe) return false;
        const n = this.aimTree(eye, yaw, pitch, _hit);
        let log = -1;
        if (n < 0) {
            if (!axe) return false;
            log = this.aimLog(eye, yaw, pitch, i, _hit);
            if (log < 0) return false;
        }
        // a bite or a swing takes a moment; presses in between do nothing (but are still used up)
        if (this.tick < (this.nextStrike[i] ?? 0)) return true;
        this.nextStrike[i] = this.tick + (axe ? WOOD.blowTicks : WOOD.biteTicks);
        if (axe) this.stats.blows++;
        else this.stats.bites++;
        this.chips(_hit.x, _hit.y, _hit.z);
        if (n >= 0) this.cutTree(n, feet, axe ? WOOD.blow : WOOD.bite);
        else this.buckLog(log);
        return true;
    }

    private cutTree(n: number, feet: { x: number; z: number }, amount: number): void {
        const st = this.trees[n];
        const t = this.def!.trees[n];
        const dx = feet.x - t.x;
        const dz = feet.z - t.z;
        const len = Math.hypot(dx, dz);
        if (len > 1e-6) {
            st.dirX += dx / len;
            st.dirZ += dz / len;
        }
        // (ten bites of 0.1 add up to 0.999...: round to the bite)
        st.cut = Math.min(1, Math.round((st.cut + amount) * 1e6) / 1e6);
        if (st.cut >= WOOD.warnAt && !st.warned && st.cut < 1) {
            st.warned = true;
            this.say('The pine creaks and leans. It will fall away from the side you cut: stand clear!');
        }
        if (st.cut >= 1) this.fell(n);
    }

    /** The direction (unit, horizontal) a tree will fall: away from the side it was cut from. */
    fallDirection(n: number): { x: number; z: number } {
        const st = this.trees[n];
        const len = Math.hypot(st.dirX, st.dirZ);
        if (len < 1e-3) {
            // cut evenly from every side: it goes the way its crown leans (its yaw)
            const yaw = this.def!.trees[n].yaw;
            return { x: Math.sin(yaw), z: Math.cos(yaw) };
        }
        return { x: -st.dirX / len, z: -st.dirZ / len };
    }

    private fell(n: number): void {
        const st = this.trees[n];
        const k = this.felled.findIndex((f) => !f.used);
        if (k < 0) {
            st.cut = 0.95;
            if (!st.blocked) {
                st.blocked = true;
                this.say('Too many logs lying about: saw one at the mill before felling another.');
            }
            return;
        }
        const pw = this.pw;
        const t = this.def!.trees[n];
        const d = this.fallDirection(n);
        const g = this.ground(n);
        // the trunk becomes the log, once: upright where it stood (log axis +x up), tipped away
        const axis = { x: d.z, y: 0, z: -d.x }; // up x d: rotating about it tips the top towards d
        const tilt = quatFromAxisAngle(axis.x, axis.y, axis.z, WOOD.tilt0);
        const upright = quatFromAxisAngle(0, 0, 1, Math.PI / 2);
        const q = quatMul(tilt, upright);
        const pivotY = g + STUMP_HEIGHT + 0.02;
        quatRotate(q, LOG_LENGTH / 2, 0, 0, _v);
        const at = pose(t.x + _v.x, pivotY + _v.y, t.z + _v.z, q);
        // turning about the pivot: v = w x r
        const w = { x: axis.x * WOOD.spin0, y: 0, z: axis.z * WOOD.spin0 };
        const lin = { x: w.y * _v.z - w.z * _v.y, y: w.z * _v.x - w.x * _v.z, z: w.x * _v.y - w.y * _v.x };
        const log = this.ents.felled[k];
        const pb = pw.bodies.get(log.id)!;
        // lost (out of the world) while falling: it comes back lying beside the stump
        setPose(pb.spawn, t.x + d.x * 1.4, g + LOG_RADIUS + 0.05, t.z + d.z * 1.4, yawQuat(Math.atan2(-d.z, d.x)));
        pw.setEnabled(log.id, true);
        pw.place(log.id, at, lin, w);
        this.felled[k] = { used: true, tree: n, fellTick: this.tick, crown: true };
        st.phase = 'down';
        st.cut = 0;
        st.warned = false;
        st.blocked = false;
        st.downTick = this.tick;
        st.slot = k;
        this.addTreeColliders(n);
        this.stats.felled++;
        this.say(`Timber! The pine falls ${compass(d)}.`);
    }

    /** One axe blow into a lying log; the last one bucks it into two short logs. */
    private buckLog(id: number): void {
        const blows = (this.buck.get(id) ?? 0) + 1;
        if (blows < WOOD.buckBlows) {
            this.buck.set(id, blows);
            return;
        }
        const free: number[] = [];
        for (let k = 0; k < this.ents.short.length && free.length < 2; k++)
            if (!this.pw.bodies.get(this.ents.short[k].id)!.enabled) free.push(k);
        if (free.length < 2) {
            this.buck.set(id, blows - 1);
            this.say('No room for more short logs: saw the ones lying about first.');
            return;
        }
        this.buck.delete(id);
        const pw = this.pw;
        const b = pw.bodies.get(id)!.body;
        const p = b.translation();
        const q = b.rotation();
        const lv = b.linvel();
        const av = b.angvel();
        // the two halves lie where the log's two ends were
        for (let h = 0; h < 2; h++) {
            quatRotate(q, (h === 0 ? -1 : 1) * (LOG_LENGTH / 4 + 0.01), 0, 0, _v);
            const e = this.ents.short[free[h]];
            const at = pose(p.x + _v.x, p.y + _v.y, p.z + _v.z, { x: q.x, y: q.y, z: q.z, w: q.w });
            setPose(pw.bodies.get(e.id)!.spawn, at.p.x, at.p.y + 0.05, at.p.z, at.q);
            pw.setEnabled(e.id, true);
            pw.place(e.id, at, lv, av);
        }
        this.take(id);
        this.stats.bucked++;
        this.say('Bucked into two short logs: light enough to carry alone.');
    }

    // ------------------------------------------------------------------------------- pools

    /** Free pooled pieces of a kind. */
    freeSawn(): number {
        let n = 0;
        for (const e of this.ents.sawn) if (!this.pw.bodies.get(e.id)!.enabled) n++;
        return n;
    }

    /** What kind of sawable wood an entity is, or null. */
    woodKind(id: number): WoodKind | null {
        if (this.ents.short.some((e) => e.id === id)) return 'short';
        return this.isFullLog(id) ? 'log' : null;
    }

    /** The sawable pieces (level logs, felled logs, short logs). */
    get sawable(): SimEntity[] {
        return [...this.levelLogs, ...this.ents.felled, ...this.ents.short];
    }

    /**
     * Takes a piece out of the world for good (the sawmill consumed it, or it was bucked): a pooled
     * piece goes back to its pool, a level log comes back to its pile later.
     */
    take(id: number): void {
        const pw = this.pw;
        pw.setEnabled(id, false);
        this.buck.delete(id);
        this.lostTicks.delete(id);
        const k = this.ents.felled.findIndex((e) => e.id === id);
        if (k >= 0) {
            this.felled[k] = { used: false, tree: -1, fellTick: -1, crown: false };
            for (const t of this.trees) if (t.slot === k) t.slot = -1;
        }
        if (this.levelLogs.some((e) => e.id === id)) this.respawnAt.set(id, this.tick + WOOD.respawnTicks);
    }

    /** A free sawn plank, placed and enabled; returns its entity or null. */
    spawnPlank(at: Pose): SimEntity | null {
        const pw = this.pw;
        const e = this.ents.sawn.find((x) => !pw.bodies.get(x.id)!.enabled);
        if (!e) return null;
        const pb = pw.bodies.get(e.id)!;
        setPose(pb.spawn, at.p.x, at.p.y + 0.05, at.p.z, at.q);
        pw.setEnabled(e.id, true);
        pw.place(e.id, at);
        // in this tick's snapshot already (the props were read before the sawmill ran)
        setPose(e.pose, at.p.x, at.p.y, at.p.z, at.q);
        e.visible = true;
        return e;
    }

    /** Every pooled piece back in its pool, trees and the axe as they were (Reset props). */
    resetProps(): void {
        const pw = this.pw;
        for (const e of [...this.ents.felled, ...this.ents.short, ...this.ents.sawn]) this.take(e.id);
        for (const e of this.levelLogs) {
            this.respawnAt.delete(e.id);
            if (pw.bodies.has(e.id)) pw.setEnabled(e.id, true);
        }
        if (this.def?.axe) pw.respawn(this.ents.axe.id);
    }

    // ------------------------------------------------------------------------------- tick

    /**
     * After the physics step: crowns ride and break off, stumps regrow, lost pieces return, level
     * logs come back to their pile. `occupied(x, z, r)` says whether a player or a body stands
     * within r of a point (regrowth and respawns never trap anyone).
     */
    step(tick: number, occupied: (x: number, z: number, r: number) => boolean): void {
        this.tick = tick;
        if (!this.def) {
            this.publish();
            return;
        }
        const pw = this.pw;
        const e = this.ents;
        // crowns ride their logs until the tree is down
        for (let k = 0; k < this.felled.length; k++) {
            const f = this.felled[k];
            if (!f.used || !f.crown) continue;
            const log = e.felled[k];
            pw.readPose(log.id, log.pose);
            // the log's +x is the tree's up: its tilt is the angle of +x from vertical
            quatRotate(log.pose.q, 1, 0, 0, _v);
            const tilt = Math.acos(Math.max(-1, Math.min(1, _v.y)));
            if (tilt > WOOD.crownBreakTilt || tick - f.fellTick > WOOD.crownMaxTicks) {
                f.crown = false;
                const c = log.pose.p;
                this.needles(c.x + _v.x * 3.4, c.y + _v.y * 3.4, c.z + _v.z * 3.4);
            }
        }
        // stumps regrow
        for (let n = 0; n < this.trees.length; n++) {
            const st = this.trees[n];
            if (st.phase !== 'down' || tick - st.downTick < WOOD.regrowTicks) continue;
            const t = this.def.trees[n];
            if (st.slot >= 0) {
                const p = e.felled[st.slot].pose.p;
                if (Math.hypot(p.x - t.x, p.z - t.z) < WOOD.regrowLogClear) continue;
                st.slot = -1;
            }
            if (occupied(t.x, t.z, WOOD.regrowClear)) continue;
            st.phase = 'standing';
            st.cut = 0;
            st.dirX = st.dirZ = 0;
            this.addTreeColliders(n);
            this.stats.regrown++;
            this.needles(t.x, this.ground(n) + 3.4, t.z);
            this.say('A fresh pine has sprung up in the logging stand.');
        }
        // pooled pieces lost in the creek go back to their pools; the axe and level logs come home
        const lostY = this.level.rules?.lostY;
        if (lostY !== undefined) {
            for (const ent of [...e.felled, ...e.short, ...e.sawn, e.axe, ...this.levelLogs]) {
                const b = pw.bodies.get(ent.id);
                if (!b || !b.enabled) continue;
                const lost = ent.pose.p.y < lostY && pw.holders(ent.id) === 0;
                const n = lost ? (this.lostTicks.get(ent.id) ?? 0) + 1 : 0;
                if (n === 0) this.lostTicks.delete(ent.id);
                else this.lostTicks.set(ent.id, n);
                if (n <= WOOD.lostTicks) continue;
                this.lostTicks.delete(ent.id);
                this.stats.returned++;
                if (ent === e.axe || this.levelLogs.includes(ent)) pw.respawn(ent.id);
                else this.take(ent.id);
            }
        }
        // level logs come back to their pile once sawn (when nothing is in the way)
        for (const [id, at] of this.respawnAt) {
            if (tick < at) continue;
            const b = pw.bodies.get(id);
            if (!b) continue;
            if (occupied(b.spawn.p.x, b.spawn.p.z, 1.1)) continue;
            this.respawnAt.delete(id);
            pw.setEnabled(id, true);
            pw.respawn(id);
            this.say('Fresh logs have been delivered to the log pile.');
        }
        this.publish();
    }

    /** Entities from state: stand markers, crowns, the effect counters, the axe. */
    publish(): void {
        const e = this.ents;
        const def = this.def;
        for (let n = 0; n < e.markers.length; n++) {
            const m = e.markers[n];
            const st = this.trees[n];
            m.visible = !!def && n < this.treeCount;
            if (!m.visible || !st) continue;
            const t = def!.trees[n];
            m.pose.p.x = t.x;
            m.pose.p.y = def!.ground(t.x, t.z);
            m.pose.p.z = t.z;
            // the notch faces the side being cut
            const yaw = Math.hypot(st.dirX, st.dirZ) > 1e-6 ? Math.atan2(st.dirX, st.dirZ) : 0;
            quatFromYawPitchRoll(yaw, 0, 0, m.pose.q);
            m.anim[TREE_CUT] = st.phase === 'standing' ? st.cut : 0;
            m.anim[TREE_STATE] = st.phase === 'standing' ? TREE_STANDING : TREE_DOWN;
        }
        for (let k = 0; k < e.crowns.length; k++) {
            const c = e.crowns[k];
            const f = this.felled[k];
            c.visible = !!f && f.used && f.crown;
            if (!c.visible) continue;
            const log = e.felled[k].pose;
            c.pose.p.x = log.p.x;
            c.pose.p.y = log.p.y;
            c.pose.p.z = log.p.z;
            c.pose.q.x = log.q.x;
            c.pose.q.y = log.q.y;
            c.pose.q.z = log.q.z;
            c.pose.q.w = log.q.w;
        }
        e.chips.visible = !!def;
        e.chips.anim[0] = this.fxChips;
        e.needles.visible = !!def;
        e.needles.anim[0] = this.fxNeedles;
    }

    private chips(x: number, y: number, z: number): void {
        setPose(this.ents.chips.pose, x, y, z, IDENT_Q);
        this.fxChips++;
    }

    private needles(x: number, y: number, z: number): void {
        setPose(this.ents.needles.pose, x, y, z, IDENT_Q);
        this.fxNeedles++;
    }

    say(text: string): void {
        this.pending.push(text);
    }

    /** Wood messages since the last call. */
    drain(): string[] {
        return this.pending.splice(0, this.pending.length);
    }

    /** True while a felled log still carries its crown (it is falling: not grabbable as a log). */
    isFalling(id: number): boolean {
        const k = this.ents.felled.findIndex((e) => e.id === id);
        return k >= 0 && this.felled[k].crown;
    }
}

const IDENT_Q: Quat = { x: 0, y: 0, z: 0, w: 1 };
const _dir = { x: 0, y: 0, z: 0 };
const _v = { x: 0, y: 0, z: 0 };
const _hit: Strike = { x: 0, y: 0, z: 0 };

function setPose(p: Pose, x: number, y: number, z: number, q: Quat): void {
    p.p.x = x;
    p.p.y = y;
    p.p.z = z;
    p.q.x = q.x;
    p.q.y = q.y;
    p.q.z = q.z;
    p.q.w = q.w;
}

/** A log lying along a heading: its +x along (cos a, 0, -sin a)... a yaw about +y. */
function yawQuat(a: number): Quat {
    return quatFromAxisAngle(0, 1, 0, a);
}

/** "north", "south-east", ... for a horizontal direction (-z is north, +x east). */
export function compass(d: { x: number; z: number }): string {
    const names = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
    const a = Math.atan2(d.x, -d.z);
    const k = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
    return `to the ${names[k]}`;
}
