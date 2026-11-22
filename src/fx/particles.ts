/**
 * Particle effects as voxel cells (design doc §3.3: droplets, debris and solid particles stay on the
 * global grid). Every device computes them itself at the voxel time from data it already has, so
 * nothing extra is networked and host and guests see the same effects:
 *
 * - falling leaves: a deterministic schedule per leaf slot from the level's oak crowns, falling with
 *   a flutter and drifting with the integrated wind, resting on the ground (or floating on water)
 *   until their slot recycles;
 * - dust and chips when a prop lands hard, and splashes when anything (a player too) drops into the
 *   water, detected from the interpolated poses (a sudden stop, or crossing the water surface);
 * - the bucket's water (Epic 7): droplets leaving its rim while it spills or pours, and a stream
 *   from the tap while it fills, from its litres and surface channels. Decorative only: the volume
 *   is the simulation's, never the droplet count.
 *
 * Engine-free; output is a flat buffer of x, y, z, voxel value per cell for the voxel worker.
 */

import { BUCKET_LITRES, BUCKET_SLOPE_X, BUCKET_SLOPE_Z } from '../assets/props.ts';
import { sfx } from '../audio/sfx.ts';
import type { TreeSpot } from '../levels/common.ts';
import { oakCrown } from '../levels/common.ts';
import type { LevelDef } from '../levels/level.ts';
import { ANIM_MAX } from '../sim/snapshots.ts';
import type { SnapshotRing } from '../sim/snapshots.ts';
import { GRID_SIZE } from '../voxels/grid.ts';
import { pose, quatRotate } from '../voxels/math.ts';
import { M, voxel } from '../voxels/palette.ts';
import { hash3 } from '../voxels/volumes.ts';

import { CALM, windTravel } from './wind.ts';
import type { WindSpec } from './wind.ts';
import type { WoodFX } from './wood-fx.ts';

/**
 * Leaf slots. Each falling leaf dirties one dynamic chunk per voxel frame (re-meshed), so the number
 * falling at once is what costs: ~4 s falling in a 14-24 s cycle keeps about a dozen in the air.
 */
export const LEAF_SLOTS = 60;
/** Only crowns this close to the viewer shed leaves (the rest would never be seen). */
const LEAF_RANGE = 30;

/**
 * Centre of the first empty cell above the voxel ground at (x, z). Particles resting on the ground
 * go there: a particle inside a ground cell would make the voxel compositor re-mesh a whole static
 * region (measured: 15 regions and 175 ms of meshing per voxel frame with leaves on the analytic
 * ground).
 */
function restY(h: number): number {
    return (Math.floor(h / GRID_SIZE - 1e-9) + 1.5) * GRID_SIZE;
}

/** The voxel ground column takes its height at the cell centre: sample the same point. */
function cellCentre(v: number): number {
    return (Math.floor(v / GRID_SIZE) + 0.5) * GRID_SIZE;
}
export const MAX_PARTICLES = 700;
/** Live bursts at most (oldest go first): bounds the bucket's droplets too. */
const MAX_BURSTS = 32;
const _lip = { x: 0, y: 0, z: 0 };
const LEAF_MATS = [M.Leaf, M.LeafGold, M.LeafGold, M.LeafRed];

const u = (a: number, b: number, c: number) => hash3(a, b, c, 911) / 4294967296;

interface Crown {
    x: number;
    y: number;
    z: number;
    r: number;
}

type BurstKind = 'dust' | 'chips' | 'splash' | 'needles' | 'sawdust' | 'gust' | 'pour' | 'fill';

interface Burst {
    t0: number;
    x: number;
    y: number;
    z: number;
    kind: BurstKind;
    /** Pour and gust: the direction droplets or leaves travel in (horizontal, unit). */
    dx?: number;
    dz?: number;
    n: number;
    seed: number;
}

/** What the effects watch: entity slots with a rough "size" (for landing detection) and material. */
export interface WatchedEntity {
    slot: number;
    /** Distance from the entity origin to its lowest point when resting (m). */
    bottom: number;
    timber: boolean;
    /** Players' eye entities: their feet are this far below. */
    eyeHeight?: number;
}

export class ParticleFX {
    readonly buffer = new Float32Array(MAX_PARTICLES * 4);
    count = 0;
    enabled = true;
    private readonly crowns: Crown[];
    private readonly wind: WindSpec;
    private readonly level: LevelDef;
    private readonly watched: WatchedEntity[];
    private readonly prev = new Map<number, { y: number; vy: number; vx: number; vz: number; visible: boolean }>();
    private bursts: Burst[] = [];
    private lastTime = -1;
    private viewer: { x: number; z: number } | null = null;
    private burstSeq = 0;
    private readonly p = pose();
    private readonly anim = new Float64Array(ANIM_MAX);
    /** Effects spawned (cumulative, for tests and the debug panel). */
    readonly spawned = { dust: 0, chips: 0, splash: 0, needles: 0, sawdust: 0, gust: 0, pour: 0, fill: 0 };
    /** Logging effects (levels with a logging stand or a sawmill): chips, needles, sawdust. */
    wood: WoodFX | null = null;
    /** The bucket's entity slot (-1: none) and its litres at the last sample. */
    bucketSlot = -1;
    private bucketLitres = -1;
    /** When the bucket's water last sloshed (s, sample time): once as a spill starts, then now and then. */
    private waterSoundAt = -1;
    /** The bucket lost water at the last sample (a spill under way: no new slosh yet). */
    private spilling = false;

    /** The water surface now (it rises in a flood). */
    waterY: number;

    constructor(level: LevelDef, watched: WatchedEntity[]) {
        this.level = level;
        this.waterY = level.water.y;
        this.wind = level.wind ?? CALM;
        this.watched = watched;
        const trees: TreeSpot[] = level.layout(1).trees.filter((t) => t.kind === 'oak');
        this.crowns = trees.flatMap((t) => oakCrown(t, level.terrainHeight(t.x, t.z)));
    }

    /** Recomputes every particle for a voxel time; returns the cell count in `buffer`. */
    update(time: number, ring: SnapshotRing, viewer?: { x: number; z: number }): number {
        this.viewer = viewer ?? null;
        this.count = 0;
        if (!this.enabled) return 0;
        if (time < this.lastTime - 1e-6) {
            // seek or reset: forget motion history and live bursts
            this.prev.clear();
            this.bursts = [];
            this.wood?.reset();
        }
        const dt = this.lastTime >= 0 ? time - this.lastTime : 0;
        this.lastTime = time;
        this.leaves(time);
        if (dt > 0 && dt < 0.5) {
            this.detect(time, dt, ring);
            this.bucketWater(time, ring);
        } else this.bucketLitres = -1;
        this.wood?.update(time, ring, (kind, x, y, z) =>
            this.spawn(time, x, y, z, kind, kind === 'needles' ? 40 : kind === 'sawdust' ? 6 : 8)
        );
        this.drawBursts(time);
        return this.count;
    }

    private push(x: number, y: number, z: number, value: number): void {
        if (this.count >= MAX_PARTICLES) return;
        const o = this.count * 4;
        this.buffer[o] = x;
        this.buffer[o + 1] = y;
        this.buffer[o + 2] = z;
        this.buffer[o + 3] = value;
        this.count++;
    }

    // ------------------------------------------------------------------------------- leaves

    private leaves(t: number): void {
        const crowns = this.crowns;
        if (!crowns.length) return;
        const water = this.level.water;
        for (let i = 0; i < LEAF_SLOTS; i++) {
            const period = 14 + 10 * u(i, 0, 1);
            const phase = u(i, 0, 2) * period;
            const k = Math.floor((t + phase) / period);
            const age = t + phase - k * period;
            const c = crowns[Math.floor(u(i, k, 3) * crowns.length) % crowns.length];
            if (this.viewer && Math.hypot(c.x - this.viewer.x, c.z - this.viewer.z) > LEAF_RANGE) continue;
            // start just under the crown (inside it the leaf would overlap the static crown cells)
            const a = u(i, k, 4) * Math.PI * 2;
            const rr = c.r * (0.25 + 0.65 * u(i, k, 5));
            const x0 = c.x + Math.cos(a) * rr;
            const z0 = c.z + Math.sin(a) * rr;
            const y0 = c.y - c.r * (0.95 + 0.2 * u(i, k, 6));
            const vs = 0.45 + 0.35 * u(i, k, 7);
            const ground0 = this.level.terrainHeight(x0, z0);
            const landAge = Math.max(0, (y0 - ground0) / vs);
            const fallAge = Math.min(age, landAge);
            // drift with the wind (leaves follow the air at ~80 %) and flutter
            const tSpawn = t - age;
            const d = windTravel(tSpawn, tSpawn + fallAge, this.wind, 0.5);
            const fl = u(i, k, 8) * 6;
            let x = x0 + d.x * 0.8 + 0.18 * Math.sin(fallAge * 3.1 + fl);
            let z = z0 + d.z * 0.8 + 0.18 * Math.cos(fallAge * 2.3 + fl);
            let y = y0 - vs * fallAge;
            const g = this.level.terrainHeight(cellCentre(x), cellCentre(z));
            const inWater =
                g < this.waterY && Math.abs(x - water.cx) < water.halfX && Math.abs(z - water.cz) < water.halfZ;
            if (age >= landAge || y <= restY(g)) {
                if (inWater) {
                    // float on the creek and keep drifting slowly downwind
                    const d2 = windTravel(tSpawn + landAge, t, this.wind, 0.5);
                    x += d2.x * 0.15;
                    z += d2.z * 0.15;
                    y = this.waterY + 0.01;
                } else {
                    y = restY(g);
                }
            }
            // the last half second of a slot: gone (it "blew away")
            if (period - age < 0.5) continue;
            const mat = LEAF_MATS[Math.floor(u(i, k, 9) * LEAF_MATS.length)];
            const v = voxel(mat, i & 3);
            this.push(x, y, z, v);
            // a leaf is ~10 cm: two cells at 5 cm (lying along X or Z), one at coarser sizes
            if (GRID_SIZE < 0.075) {
                if (u(i, k, 10) < 0.5) this.push(x + GRID_SIZE, y, z, v);
                else this.push(x, y, z + GRID_SIZE, v);
            }
        }
    }

    // ------------------------------------------------------------------------------- impacts

    private detect(t: number, dt: number, ring: SnapshotRing): void {
        const water = this.level.water;
        for (const w of this.watched) {
            const vis = ring.sample(w.slot, t, this.p, this.anim);
            const y = this.p.p.y - (w.eyeHeight ?? 0);
            const prev = this.prev.get(w.slot);
            if (!vis) {
                this.prev.delete(w.slot);
                continue;
            }
            const x = this.p.p.x;
            const z = this.p.p.z;
            if (prev && prev.visible) {
                const vy = (y - prev.y) / dt;
                // landed hard: was falling fast, now (nearly) stopped, close to the ground
                const g = this.level.terrainHeight(cellCentre(x), cellCentre(z));
                const nearGround = y - w.bottom - g < 0.25;
                if (prev.vy < -2.2 && vy > -0.6 && nearGround && !w.eyeHeight)
                    this.spawn(t, x, restY(g), z, w.timber ? 'chips' : 'dust', w.timber ? 14 : 10);
                // dropped into the water
                const inWaterArea =
                    Math.abs(x - water.cx) < water.halfX && Math.abs(z - water.cz) < water.halfZ && g < this.waterY;
                if (
                    inWaterArea &&
                    prev.y - (w.eyeHeight ? 0 : w.bottom) > this.waterY &&
                    y - (w.eyeHeight ? 0 : w.bottom) <= this.waterY &&
                    prev.vy < -0.8
                ) {
                    this.spawn(t, x, this.waterY, z, 'splash', w.eyeHeight ? 26 : 18);
                }
                this.prev.set(w.slot, { y, vy, vx: 0, vz: 0, visible: true });
            } else {
                this.prev.set(w.slot, { y, vy: 0, vx: 0, vz: 0, visible: true });
            }
        }
    }

    /** Droplets from the bucket: over the rim when it loses water, from above when it fills. */
    private bucketWater(t: number, ring: SnapshotRing): void {
        if (this.bucketSlot < 0) return;
        if (!ring.sample(this.bucketSlot, t, this.p, this.anim)) {
            this.bucketLitres = -1;
            return;
        }
        const litres = this.anim[BUCKET_LITRES];
        const prev = this.bucketLitres;
        this.bucketLitres = litres;
        if (prev < 0) return;
        const d = litres - prev;
        const q = this.p.q;
        if (d < -0.004) {
            // over the rim where the surface stands highest
            const sx = this.anim[BUCKET_SLOPE_X];
            const sz = this.anim[BUCKET_SLOPE_Z];
            const s = Math.hypot(sx, sz);
            const lx = s > 1e-3 ? (0.15 * sx) / s : 0.15;
            const lz = s > 1e-3 ? (0.15 * sz) / s : 0;
            const lip = quatRotate(q, lx, 0.3, lz, _lip);
            const h = Math.hypot(lip.x, lip.z) || 1;
            const n = Math.min(8, 2 + Math.round(-d * 20));
            this.spawn(t, this.p.p.x + lip.x, this.p.p.y + lip.y, this.p.p.z + lip.z, 'pour', n, lip.x / h, lip.z / h);
            // water leaving: a pour loop at the rim while it runs (Epic 8's `sfx.hold`), a slosh as a
            // spill starts, and a splash for a gush (a drop, a hard knock)
            const at = { x: this.p.p.x + lip.x, y: this.p.p.y + lip.y, z: this.p.p.z + lip.z };
            sfx.hold('bucket-water', 'pour', at, { gain: Math.min(1, 0.3 - d * 4), pitch: 1 });
            if (!this.spilling || t - this.waterSoundAt > 0.6 || t < this.waterSoundAt) {
                this.waterSoundAt = t;
                sfx.play('slosh', at, { gain: Math.min(1, 0.3 - d * 3) });
            }
            if (-d > 0.5) sfx.play('splash-big', at, { gain: Math.min(1, -d) });
            this.spilling = true;
        } else if (d > 0.004) {
            const m = quatRotate(q, 0, 0.3, 0, _lip);
            this.spawn(t, this.p.p.x + m.x, this.p.p.y + m.y + 0.25, this.p.p.z + m.z, 'fill', 5);
            // filling under the tap: the pour loop, higher (a filling vessel rises in pitch)
            const at = { x: this.p.p.x + m.x, y: this.p.p.y + m.y, z: this.p.p.z + m.z };
            sfx.hold('bucket-water', 'pour', at, { gain: 0.5, pitch: 1.1 + 0.03 * litres });
            this.spilling = false;
        } else this.spilling = false;
    }

    /**
     * The aimed gust's warning (Epic 8): a stream of leaves blowing past (x, z), along (dx, dz), from
     * upwind of it. Every device starts it from the host's hazard state, so all see it.
     */
    gust(t0: number, x: number, y: number, z: number, dx: number, dz: number): void {
        this.spawn(t0, x, y, z, 'gust', GUST_LEAVES, dx, dz);
    }

    private spawn(t0: number, x: number, y: number, z: number, kind: BurstKind, n: number, dx = 0, dz = 0): void {
        this.spawned[kind]++;
        this.bursts.push({ t0, x, y, z, kind, n, seed: ++this.burstSeq, dx, dz });
        if (this.bursts.length > MAX_BURSTS) this.bursts.shift();
    }

    private drawBursts(t: number): void {
        const live: Burst[] = [];
        for (const b of this.bursts) {
            const age = t - b.t0;
            const life =
                b.kind === 'splash'
                    ? 0.7
                    : b.kind === 'chips'
                      ? 0.8
                      : b.kind === 'needles'
                        ? 1.6
                        : b.kind === 'sawdust'
                          ? 0.6
                          : b.kind === 'pour'
                            ? 0.6
                            : b.kind === 'fill'
                              ? 0.25
                              : b.kind === 'gust'
                                ? 2.6
                                : 1.1;
            if (age < 0 || age > life) continue;
            live.push(b);
            if (b.kind === 'gust') {
                this.drawGust(b, age);
                continue;
            }
            if (b.kind === 'needles' || b.kind === 'sawdust') {
                this.drawWood(b, age);
                continue;
            }
            if (b.kind === 'pour' || b.kind === 'fill') {
                this.drawWater(b, age);
                continue;
            }
            for (let i = 0; i < b.n; i++) {
                const a = u(b.seed, i, 1) * Math.PI * 2;
                const sp = b.kind === 'dust' ? 0.5 + 0.6 * u(b.seed, i, 2) : 1.0 + 1.6 * u(b.seed, i, 2);
                const up = b.kind === 'dust' ? 0.3 + 0.5 * u(b.seed, i, 3) : 2.0 + 2.0 * u(b.seed, i, 3);
                // dust hangs in the air and spreads; chips and droplets fly and fall
                const g = b.kind === 'dust' ? -0.4 : 9.81;
                const drag = b.kind === 'dust' ? Math.exp(-age * 2.5) : 1;
                const x = b.x + Math.cos(a) * sp * age * drag;
                const z = b.z + Math.sin(a) * sp * age * drag;
                const y = b.y + up * age - 0.5 * g * age * age;
                if (y < b.y - 0.05 && b.kind !== 'dust') continue;
                const mat =
                    b.kind === 'splash' ? M.Splash : b.kind === 'chips' ? (i % 3 ? M.TimberEnd : M.Dust) : M.Dust;
                this.push(x, y, z, voxel(mat, i & 3));
            }
        }
        this.bursts = live;
    }

    /** Bucket droplets: falling off the rim (pour) or down the tap's stream into it (fill). */
    private drawWater(b: Burst, age: number): void {
        const ground = this.level.terrainHeight(cellCentre(b.x), cellCentre(b.z));
        for (let i = 0; i < b.n; i++) {
            const t = age - u(b.seed, i, 4) * 0.12;
            if (t < 0) continue;
            let x = b.x;
            let y = b.y;
            let z = b.z;
            if (b.kind === 'pour') {
                const sp = 0.3 + 0.5 * u(b.seed, i, 2);
                const side = (u(b.seed, i, 3) - 0.5) * 0.3;
                x += ((b.dx ?? 0) * sp - (b.dz ?? 0) * side) * t;
                z += ((b.dz ?? 0) * sp + (b.dx ?? 0) * side) * t;
                y -= 0.5 * 9.81 * t * t;
                if (y < ground) continue;
            } else {
                y -= 1.2 * t + 0.5 * 9.81 * t * t;
                if (y < b.y - 0.28) continue;
            }
            this.push(x, y, z, voxel(M.BucketWater, i & 3));
        }
    }

    /** Leaves streaming with the gust: from 4 m upwind, through and past the target, fluttering. */
    private drawGust(b: Burst, age: number): void {
        const dx = b.dx ?? 1;
        const dz = b.dz ?? 0;
        for (let i = 0; i < b.n; i++) {
            const start = u(b.seed, i, 4) * 0.8; // they come in over the first 0.8 s
            const a = age - start;
            if (a < 0) continue;
            const speed = 4.5 + 3 * u(b.seed, i, 5);
            const along = -4 + speed * a;
            const side = (u(b.seed, i, 6) - 0.5) * 3 + 0.25 * Math.sin(a * 9 + i);
            const x = b.x + dx * along - dz * side;
            const z = b.z + dz * along + dx * side;
            const y = b.y - 1.2 + 2.4 * u(b.seed, i, 7) + 0.3 * Math.sin(a * 6 + i * 1.7);
            const mat = LEAF_MATS[Math.floor(u(b.seed, i, 8) * LEAF_MATS.length)];
            this.push(x, y, z, voxel(mat, i & 3));
        }
    }

    /**
     * Needles: a cloud from a crown, drifting down slowly and spreading (about the crown's size).
     * Sawdust: a short low spray out of the blade.
     */
    private drawWood(b: Burst, age: number): void {
        const needles = b.kind === 'needles';
        for (let i = 0; i < b.n; i++) {
            const a = u(b.seed, i, 1) * Math.PI * 2;
            const r0 = needles ? 1.4 * Math.sqrt(u(b.seed, i, 2)) : 0;
            const sp = needles ? 0.4 + 0.5 * u(b.seed, i, 3) : 0.8 + 1.2 * u(b.seed, i, 3);
            const x = b.x + Math.cos(a) * (r0 + sp * age);
            const z = b.z + Math.sin(a) * (r0 + sp * age);
            const y0 = b.y + (needles ? (u(b.seed, i, 4) - 0.5) * 1.6 : 0);
            const y = needles ? y0 - (0.7 + 0.5 * u(b.seed, i, 5)) * age : y0 + 1.2 * age - 4.9 * age * age;
            const g = this.level.terrainHeight(cellCentre(x), cellCentre(z));
            const yy = Math.max(y, restY(g));
            const mat = needles ? (i % 3 ? M.Needle : M.NeedleLight) : i % 2 ? M.TimberEnd : M.Dust;
            this.push(x, yy, z, voxel(mat, i & 3));
        }
    }
}

/** Leaves in the gust's warning stream. */
const GUST_LEAVES = 40;
