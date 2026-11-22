/**
 * The bucket's water in the level (Epic 7): the authoritative volume (src/sim/water.ts) stepped
 * from the bucket's physics body each tick, refills from the level's clean sources, water poured
 * into the flower, the water's weight on the bucket, and what the renderer and guests need (the
 * bucket's animation channels: litres and the surface's slope).
 *
 * Runs on the host only, inside the fixed tick. Nothing here reads player commands: filling,
 * spilling and pouring all follow from where the bucket is and how it moves, so every device that
 * runs the same ticks agrees, and a guest cannot ask for water it has not earned. All water is
 * accounted for: in the bucket + left in the sources + spilled + lost with a bucket + poured into
 * the flower = what there was at the start (`total`).
 */

import { BUCKET_LITRES, BUCKET_SLOPE_X, BUCKET_SLOPE_Z } from '../assets/props.ts';
import type { FlowerTarget, LevelDef, WaterSource } from '../levels/level.ts';
import type { Pose } from '../voxels/math.ts';
import { quatRotate } from '../voxels/math.ts';

import { SIM_DT } from './clock.ts';
import type { PhysBody } from './physics/world.ts';
import { BucketWater, WATER, surfaceHeight } from './water.ts';

export class BucketWaterState {
    readonly water = new BucketWater(WATER.capacity);
    /** Litres left in each of the level's sources. */
    readonly sources: { def: WaterSource; litres: number }[];
    /** Where the water went (litres). */
    spilled = 0;
    lost = 0;
    poured = 0;
    /** The source filling the bucket (index), or -1. */
    filling = -1;
    private fillFrom = 0;
    /** Ticks since water last reached the flower (-1: none yet this pour). */
    pourQuiet = -1;
    /** Water mass currently added to the bucket's body (kg). */
    private massApplied = -1;

    constructor(level: LevelDef) {
        this.sources = (level.rules?.waterSources ?? []).map((def) => ({ def, litres: def.litres }));
    }

    /** All the water there is: the full bucket plus every source, at the start. */
    get total(): number {
        let t = WATER.capacity;
        for (const s of this.sources) t += s.def.litres;
        return t;
    }

    get volume(): number {
        return this.water.volume;
    }

    reset(): void {
        this.water.reset(WATER.capacity);
        for (const s of this.sources) s.litres = s.def.litres;
        this.spilled = this.lost = this.poured = 0;
        this.filling = -1;
        this.pourQuiet = -1;
        this.massApplied = -1;
    }

    /** The bucket fell in and is replaced by a spare: its water is gone with it, the spare is empty. */
    bucketLost(): void {
        this.lost += this.water.volume;
        this.water.reset(0);
        this.filling = -1;
    }

    /** The bucket was moved without travelling (recovery, reset): no acceleration from the jump. */
    teleported(): void {
        this.water.teleported();
    }

    /**
     * One tick, after the physics step. `flower` is where poured water counts (the current stage's,
     * or null). Returns messages for the players (a refill finished, a butt ran dry).
     */
    step(pb: PhysBody, bucket: Pose, anim: Float64Array, flower: FlowerTarget | null): string[] {
        const msgs: string[] = [];
        const body = pb.body;
        const w = this.water;
        const q = bucket.q;
        let toFlower = false;
        if (pb.enabled) {
            // the water's centre, half its depth above the floor
            const h = surfaceHeight(w.volume);
            quatRotate(q, 0, (WATER.floor + h) / 2, 0, _p);
            _p.x += bucket.p.x;
            _p.y += bucket.p.y;
            _p.z += bucket.p.z;
            const v = body.velocityAtPoint(_p);
            const av = body.angvel();
            _in.v.x = v.x;
            _in.v.y = v.y;
            _in.v.z = v.z;
            _in.w.x = av.x;
            _in.w.y = av.y;
            _in.w.z = av.z;
            _in.q = q;
            const out = w.step(_in, SIM_DT);
            if (out > 0) {
                // where it leaves the rim decides where it lands: in the flower, or on the ground
                quatRotate(q, w.lip.x, w.lip.y, w.lip.z, _p);
                const lx = bucket.p.x + _p.x;
                const lz = bucket.p.z + _p.z;
                if (flower && Math.hypot(lx - flower.x, lz - flower.z) < flower.r) {
                    this.poured += out;
                    toFlower = true;
                } else this.spilled += out;
            }
        }
        if (toFlower) this.pourQuiet = 0;
        else if (this.pourQuiet >= 0) this.pourQuiet++;
        this.refill(bucket, msgs);
        // the water's weight, updated in coarse steps so joints and grabs are not disturbed every tick
        const vol = w.volume;
        if (
            this.massApplied < 0 ||
            Math.abs(vol - this.massApplied) >= WATER.massStep ||
            (vol === 0 && this.massApplied !== 0) ||
            (vol === WATER.capacity && this.massApplied !== vol)
        ) {
            body.setAdditionalMass(vol, true);
            this.massApplied = vol;
        }
        anim[BUCKET_LITRES] = vol;
        anim[BUCKET_SLOPE_X] = w.local.x;
        anim[BUCKET_SLOPE_Z] = w.local.z;
        return msgs;
    }

    /** Fills an upright bucket whose mouth is under a source's tap. */
    private refill(bucket: Pose, msgs: string[]): void {
        const w = this.water;
        const q = bucket.q;
        // the bucket's up axis, y component, and its mouth (the rim's centre)
        const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
        quatRotate(q, 0, WATER.rim, 0, _p);
        const mx = bucket.p.x + _p.x;
        const my = bucket.p.y + _p.y;
        const mz = bucket.p.z + _p.z;
        let at = -1;
        if (upY > 0.85) {
            for (let n = 0; n < this.sources.length; n++) {
                const s = this.sources[n];
                const d = s.def;
                if (Math.hypot(mx - d.x, mz - d.z) < d.r && my > d.y && my < d.y + d.h) {
                    at = n;
                    break;
                }
            }
        }
        const src = at >= 0 ? this.sources[at] : null;
        const flowing = !!src && src.litres > 0 && w.volume < WATER.capacity;
        if (flowing) {
            if (this.filling !== at) {
                this.filling = at;
                this.fillFrom = w.volume;
            }
            const take = w.add(Math.min(WATER.fillRate * SIM_DT, src.litres));
            src.litres = Math.max(0, src.litres - take);
        }
        if (this.filling >= 0 && !flowing) {
            // a refill ends: say so once
            const s = this.sources[this.filling];
            const got = w.volume - this.fillFrom;
            this.filling = -1;
            if (got > 0.05) {
                const left =
                    s.litres > 0.05 ? `${s.def.name} has ${s.litres.toFixed(0)} L left` : `${s.def.name} is empty now`;
                msgs.push(`Filled up: ${w.volume.toFixed(1)} L in the bucket. The ${left}.`);
            }
        }
    }
}

const _p = { x: 0, y: 0, z: 0 };
const _in = { q: { x: 0, y: 0, z: 0, w: 1 }, v: { x: 0, y: 0, z: 0 }, w: { x: 0, y: 0, z: 0 } };
