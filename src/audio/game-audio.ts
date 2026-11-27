/**
 * The game's sound (Epic 8, issue #19): PlayCanvas sound components playing the synthesized
 * sounds (src/audio/synth.ts), and a listener of the game that decides what to play each frame.
 *
 * - **Unlock:** browsers (and itch.io's embed) only allow audio after a user gesture. Nothing
 *   touches the Web Audio context before the first click, tap or key; then the context starts,
 *   the sounds are built and the listener goes on the camera.
 * - **Buses:** master (the sound manager's volume), effects and ambience, from the settings menu.
 * - **What plays:** everything is worked out on each device from what it already has (the snapshot
 *   ring, the host's HUD and hazard state), so host, guests and split screen hear the same world:
 *   impacts and landings scaled by speed, splashes, grabs and throws, footsteps, the ute's engine
 *   and doors, the creek, wind and birds, and the hazards' tells (siren and rumble, warning gust).
 */

import { Asset, Entity, Sound } from 'playcanvas';
import type { AppBase } from 'playcanvas';

import type { LevelDef } from '../levels/level.ts';
import { CLOSURE_OPEN, CLOSURE_SHUT, CLOSURE_TELL } from '../sim/hazard-road.ts';
import { TREE_TELL } from '../sim/hazard-tree.ts';
import { PHASE } from '../sim/hazards.ts';
import type { HazardNet } from '../sim/hazards.ts';
import type { SimEvent } from '../sim/lab-sim.ts';
import { ANIM_MAX } from '../sim/snapshots.ts';
import type { SnapshotRing } from '../sim/snapshots.ts';
import { pose } from '../voxels/math.ts';

import { HeldLoops } from './held-loops.ts';
import { sfx } from './sfx.ts';
import type { SfxName, SfxOptions, SfxSink, Vec3Like } from './sfx.ts';
import { HELD_LOOPS, LOOPS, SOUND_NAMES, SYNTH_RATE, synthesize } from './synth.ts';
import type { SoundName } from './synth.ts';

export interface AudioVolumes {
    master: number;
    effects: number;
    ambience: number;
}

/** What a watched body sounds like when it hits something. */
export type ImpactKind = 'timber' | 'beam' | 'metal' | 'heavy' | 'soft';

export interface WatchedBody {
    slot: number;
    kind: ImpactKind;
}

/** Per frame, from the game: who plays, what they hold, where they sit, and the hazards. */
export interface SoundFrame {
    /** Render time (s) the ring is sampled at. */
    time: number;
    listener: Vec3Like;
    hazard: HazardNet;
    windSpeed: number;
    players: { active: boolean; held: number; seat: number }[];
    /** Someone is in the ute's driver's seat. */
    uteDriven: boolean;
}

export interface AudioWorld {
    level: LevelDef;
    ring: SnapshotRing;
    watched: WatchedBody[];
    /** Snapshot slot of each player's eye, by player. */
    eyeSlots: number[];
    eyeHeight: number;
    /** Snapshot slot of the ute (-1: none). */
    uteSlot: number;
    /** Snapshot slot of an entity id (what a player holds), or -1. */
    slotOfId(id: number): number;
}

const AMBIENT: ReadonlySet<string> = new Set(['river', 'wind', 'rumble', 'bird-0', 'bird-1', 'bird-2']);
const VARIANTS: Partial<Record<SfxName, number>> = { knock: 3, clank: 2, thud: 2, step: 4, bird: 3, creak: 3 };
const EMITTERS = 12;
/** A waterfall's roar: the creek's loop, louder and deeper (heard out to the emitters' 60 m). */
const WATERFALL = { gain: 1.1, pitch: 0.72 } as const;

interface Track {
    x: number;
    y: number;
    z: number;
    vx: number;
    vy: number;
    vz: number;
    seen: boolean;
    quiet: number;
}

export class GameAudio implements SfxSink {
    started = false;
    /** Sounds played (tests, the debug panel and the playtest log). */
    played = 0;
    readonly recent: string[] = [];
    private readonly app: AppBase;
    private readonly listenerEntity: Entity;
    private readonly world: AudioWorld;
    private volumes: AudioVolumes = { master: 0.8, effects: 1, ambience: 0.7 };
    private readonly assets = new Map<SoundName, Asset>();
    private emitters: Entity[] = [];
    private nextEmitter = 0;
    private flat: Entity | null = null;
    private readonly loops = new Map<SoundName, { e: Entity; gain: number; target: number; pitch: number }>();
    /** The level's waterfalls, each a fixed loop where it falls. */
    private readonly falls: Entity[] = [];
    /** Loops held on by other features (`sfx.hold`), by their key (src/audio/held-loops.ts). */
    private readonly holds = new HeldLoops<Entity>(
        (key, name, positional) => {
            const e = this.emitter(`SfxHold-${key}`, positional);
            const asset = this.assets.get(name as SoundName)!;
            e.sound!.addSlot(name, { asset: asset.id, loop: true, volume: 0, autoPlay: false });
            e.sound!.play(name);
            return e;
        },
        (e) => e.destroy()
    );
    private prevBrake = 0;
    private readonly tracks = new Map<number, Track>();
    private readonly eyeTracks: Track[] = [];
    private readonly stepDist: number[] = [];
    private prevPlayers: { held: number; seat: number }[] = [];
    private prevFlood = 0;
    private prevGust = 0;
    private lastTime = -1;
    private startedAt = 0;
    private nextBird = 6;
    private readonly ute: Track = newTrack();
    private readonly pose = pose();
    private readonly anim = new Float64Array(ANIM_MAX);
    private readonly unlock = () => this.start();
    private ctx: AudioContext | null = null;
    private pending: SoundName[] = [];

    constructor(app: AppBase, listener: Entity, world: AudioWorld) {
        this.app = app;
        this.listenerEntity = listener;
        this.world = world;
    }

    /** Starts the sound on the first user gesture (pointer, touch or key), as browsers require. */
    armUnlock(): void {
        for (const ev of ['pointerdown', 'touchend', 'keydown'])
            window.addEventListener(ev, this.unlock, { capture: true, passive: true });
        document.addEventListener('visibilitychange', () => {
            if (!this.started) return;
            if (document.hidden) this.app.soundManager.suspend();
            else this.app.soundManager.resume();
        });
    }

    /** Creates the audio context (inside a user gesture), the sounds, the emitters and the loops. */
    start(): void {
        if (this.started) return;
        const ctx = this.app.soundManager?.context;
        if (!ctx) return;
        this.started = true;
        for (const ev of ['pointerdown', 'touchend', 'keydown'])
            window.removeEventListener(ev, this.unlock, { capture: true });
        if (ctx.state !== 'running') void ctx.resume().catch(() => undefined);
        this.ctx = ctx;
        this.listenerEntity.addComponent('audiolistener');
        for (let i = 0; i < EMITTERS; i++) this.emitters.push(this.emitter(`SfxEmitter${i}`, true));
        this.flat = this.emitter('SfxFlat', false);
        // the sounds are built a few per frame (about 0.2 s of work in all), the ambience first; a
        // one-shot wanted before its turn is built on the spot
        this.pending = [...SOUND_NAMES].sort((a, b) => Number(LOOPS.has(b)) - Number(LOOPS.has(a)));
        this.app.soundManager.volume = this.volumes.master;
        this.startedAt = this.lastTime;
        sfx.setSink(this);
    }

    /** Synthesizes one sound into an asset (and starts it, for a loop). */
    private build(name: SoundName): Asset | undefined {
        const have = this.assets.get(name);
        if (have || !this.ctx) return have;
        const { samples } = synthesize(name, SYNTH_RATE);
        const buf = this.ctx.createBuffer(1, samples.length, SYNTH_RATE);
        buf.getChannelData(0).set(samples);
        const asset = new Asset(`sfx-${name}`, 'audio');
        asset.resource = new Sound(buf);
        asset.loaded = true;
        this.app.assets.add(asset);
        this.assets.set(name, asset);
        this.pending = this.pending.filter((n) => n !== name);
        if (LOOPS.has(name) && !HELD_LOOPS.has(name)) {
            const positional = name === 'river' || name === 'engine';
            const e = this.emitter(`SfxLoop-${name}`, positional);
            e.sound!.addSlot(name, { asset: asset.id, loop: true, volume: 0, autoPlay: false });
            e.sound!.play(name);
            this.loops.set(name, { e, gain: 0, target: 0, pitch: 1 });
        }
        // the level's waterfalls (#80): the creek's water, deeper and louder, from where each falls
        if (name === 'river') {
            for (const at of this.world.level.sounds?.waterfalls ?? []) {
                const e = this.emitter('SfxWaterfall', true);
                e.setPosition(at.x, at.y, at.z);
                e.sound!.addSlot('falls', {
                    asset: asset.id,
                    loop: true,
                    volume: WATERFALL.gain * this.volumes.ambience,
                    pitch: WATERFALL.pitch,
                    autoPlay: false
                });
                e.sound!.play('falls');
                this.falls.push(e);
            }
        }
        return asset;
    }

    /** Sounds still to build (0 once all are ready). */
    get building(): number {
        return this.pending.length;
    }

    setVolumes(v: AudioVolumes): void {
        this.volumes = { ...v };
        for (const e of this.falls) {
            const slot = e.sound!.slot('falls');
            if (slot) slot.volume = WATERFALL.gain * v.ambience;
        }
        this.app.soundManager.volume = Math.max(0, Math.min(1, v.master));
    }

    private emitter(name: string, positional: boolean): Entity {
        const e = new Entity(name);
        e.addComponent('sound', {
            positional,
            refDistance: 2.5,
            maxDistance: 60,
            rollOffFactor: 1,
            distanceModel: 'inverse'
        });
        this.app.root.addChild(e);
        return e;
    }

    /** One-shot (the SfxSink the rest of the game calls through `sfx`). */
    play(name: SfxName, at: Vec3Like | null, opts: SfxOptions = {}): void {
        if (!this.started) return;
        const variants = VARIANTS[name];
        const sound = (variants ? `${name}-${Math.floor(Math.random() * variants)}` : name) as SoundName;
        const asset = this.build(sound);
        if (!asset) return;
        const e = at ? this.emitters[this.nextEmitter++ % this.emitters.length] : this.flat!;
        if (at) e.setPosition(at.x, at.y, at.z);
        if (!e.sound!.slot(sound)) e.sound!.addSlot(sound, { asset: asset.id, overlap: true, volume: 1 });
        const inst = e.sound!.play(sound);
        if (!inst) return;
        const bus = AMBIENT.has(sound) ? this.volumes.ambience : this.volumes.effects;
        inst.volume = Math.max(0, Math.min(1.5, (opts.gain ?? 1) * bus));
        inst.pitch = Math.max(0.3, Math.min(3, (opts.pitch ?? 1) * (0.96 + Math.random() * 0.08)));
        this.played++;
        this.recent.push(sound);
        if (this.recent.length > 24) this.recent.shift();
    }

    /** A loop that sounds while it is held on (called every frame), and fades when let go. */
    hold(key: string, name: SfxName, at: Vec3Like | null, opts: SfxOptions = {}): void {
        if (!this.started) return;
        const sound = name as SoundName;
        const asset = this.build(sound);
        if (!asset) return;
        const e = this.holds.hold(key, sound, !!at, opts.gain ?? 1, opts.pitch ?? 1, performance.now());
        if (at) e.setPosition(at.x, at.y, at.z);
    }

    /** A level event (a step done, the goal, a hazard's toast). */
    onEvent(kind: string, text = ''): void {
        for (const s of eventSounds(kind, text)) this.play(s.name, null, { gain: s.gain, pitch: s.pitch });
    }

    /** Every frame: what the world sounds like now. */
    update(f: SoundFrame): void {
        const dt = this.lastTime >= 0 ? f.time - this.lastTime : 0;
        this.lastTime = f.time;
        if (!this.started) return;
        if (this.startedAt < 0) this.startedAt = f.time;
        const t0 = performance.now();
        while (this.pending.length && performance.now() - t0 < 6) this.build(this.pending[0]);
        // the hazards' tells follow their state, not motion: heard even across a pause or a seek
        this.watchHazards(f);
        // a seek, a reset or a stall: forget motion history
        if (dt <= 0 || dt > 0.25) {
            for (const t of this.tracks.values()) t.seen = false;
            for (const t of this.eyeTracks) if (t) t.seen = false;
            this.ute.seen = false;
            this.updateLoops(f, 0.016);
            return;
        }
        const settled = f.time - this.startedAt > 1;
        this.watchBodies(f, dt, settled);
        this.watchPlayers(f, dt);
        this.watchUte(f, dt);
        this.ambience(f);
        this.updateLoops(f, dt);
    }

    private sample(slot: number, t: number): boolean {
        return slot >= 0 && this.world.ring.sample(slot, t, this.pose, this.anim);
    }

    /** Moves a track to where its slot is now; false when it is not visible. */
    private follow(tr: Track, slot: number, t: number, dt: number): boolean {
        if (!this.sample(slot, t)) {
            tr.seen = false;
            return false;
        }
        const p = this.pose.p;
        if (tr.seen) {
            const vx = (p.x - tr.x) / dt;
            const vy = (p.y - tr.y) / dt;
            const vz = (p.z - tr.z) / dt;
            tr.vx = vx;
            tr.vy = vy;
            tr.vz = vz;
        } else {
            tr.vx = tr.vy = tr.vz = 0;
        }
        tr.x = p.x;
        tr.y = p.y;
        tr.z = p.z;
        return true;
    }

    private inWater(x: number, z: number, waterY: number): boolean {
        const w = this.world.level.water;
        return (
            Math.abs(x - w.cx) < w.halfX &&
            Math.abs(z - w.cz) < w.halfZ &&
            this.world.level.terrainHeight(x, z) < waterY
        );
    }

    /** Impacts and splashes of the props, from their motion. */
    private watchBodies(f: SoundFrame, dt: number, settled: boolean): void {
        const waterY = f.hazard.waterY;
        for (const w of this.world.watched) {
            let tr = this.tracks.get(w.slot);
            if (!tr) {
                tr = newTrack();
                this.tracks.set(w.slot, tr);
            }
            const was = { vx: tr.vx, vy: tr.vy, vz: tr.vz, y: tr.y, seen: tr.seen };
            if (!this.follow(tr, w.slot, f.time, dt) || !was.seen) continue;
            tr.quiet = Math.max(0, tr.quiet - dt);
            if (!settled || tr.quiet > 0) continue;
            const dv = Math.hypot(tr.vx - was.vx, tr.vy - was.vy, tr.vz - was.vz);
            const at = { x: tr.x, y: tr.y, z: tr.z };
            if (this.inWater(tr.x, tr.z, waterY) && was.y > waterY && tr.y <= waterY && was.vy < -0.8) {
                const big = w.kind === 'beam' || w.kind === 'heavy';
                this.play(big ? 'splash-big' : 'splash-small', at, { gain: Math.min(1, 0.4 - was.vy * 0.12) });
                tr.quiet = 0.3;
                continue;
            }
            const landed = was.vy < -1.8 && tr.vy > -0.5;
            if (!landed && dv < 3) continue;
            if (tr.y < waterY && this.inWater(tr.x, tr.z, waterY)) continue; // under water: muffled
            const speed = landed ? -was.vy : dv;
            const gain = Math.max(0.12, Math.min(1, (speed - 1) / 6));
            const sound: SfxName =
                w.kind === 'metal' ? 'clank' : w.kind === 'heavy' || w.kind === 'soft' ? 'thud' : 'knock';
            const pitch = w.kind === 'beam' ? 0.7 : w.kind === 'soft' ? 1.3 : 1;
            this.play(sound, at, { gain, pitch });
            tr.quiet = 0.14;
        }
    }

    /** Footsteps, falling in, grabs, throws and the ute's doors, per player. */
    private watchPlayers(f: SoundFrame, dt: number): void {
        const waterY = f.hazard.waterY;
        const eh = this.world.eyeHeight;
        f.players.forEach((pl, i) => {
            const tr = (this.eyeTracks[i] ??= newTrack());
            const prev = this.prevPlayers[i] ?? { held: -1, seat: -1 };
            const was = { y: tr.y, vy: tr.vy, seen: tr.seen };
            if (!pl.active || !this.follow(tr, this.world.eyeSlots[i], f.time, dt)) {
                this.prevPlayers[i] = { held: -1, seat: -1 };
                return;
            }
            const feet = { x: tr.x, y: tr.y - eh, z: tr.z };
            // into the creek
            if (
                was.seen &&
                this.inWater(tr.x, tr.z, waterY) &&
                was.y - eh > waterY &&
                feet.y <= waterY &&
                was.vy < -0.8
            )
                this.play('splash-big', { x: tr.x, y: waterY, z: tr.z }, { gain: 1 });
            // footsteps: one per stride walked on the ground
            const h = Math.hypot(tr.vx, tr.vz);
            if (pl.seat < 0 && was.seen && Math.abs(tr.vy) < 0.8 && h > 0.6 && h < 9) {
                this.stepDist[i] = (this.stepDist[i] ?? 0) + h * dt;
                const stride = h > 4 ? 1.0 : 0.72;
                if (this.stepDist[i] >= stride) {
                    this.stepDist[i] = 0;
                    this.play('step', feet, { gain: 0.32 + Math.min(0.25, h * 0.04) });
                }
            } else this.stepDist[i] = 0;
            // grab, let go, throw
            if (pl.held !== prev.held) {
                const s = this.world.slotOfId(pl.held >= 0 ? pl.held : prev.held);
                const at = s >= 0 && this.sample(s, f.time) ? { ...this.pose.p } : feet;
                if (pl.held >= 0) this.play('grab', at, { gain: 0.7 });
                else {
                    const t = this.tracks.get(s);
                    const fast = t ? Math.hypot(t.vx, t.vy, t.vz) > 4 : false;
                    this.play(fast ? 'throw' : 'grab', at, fast ? { gain: 0.8 } : { gain: 0.4, pitch: 0.8 });
                }
            }
            // in or out of the ute
            if (pl.seat !== prev.seat && this.ute.seen) this.play('door', { ...this.ute }, { gain: 0.8 });
            this.prevPlayers[i] = { held: pl.held, seat: pl.seat };
        });
    }

    private watchUte(f: SoundFrame, dt: number): void {
        const engine = this.loops.get('engine');
        if (!engine) return;
        if (!this.follow(this.ute, this.world.uteSlot, f.time, dt)) {
            engine.target = 0;
            return;
        }
        engine.e.setPosition(this.ute.x, this.ute.y + 0.6, this.ute.z);
        const speed = Math.hypot(this.ute.vx, this.ute.vz);
        engine.target = f.uteDriven ? 0.45 + Math.min(0.35, speed * 0.04) : 0;
        engine.pitch = 0.8 + Math.min(1.3, speed * 0.11);
    }

    /** The hazards' tells: the siren and rumble of the flood, the warning gust. */
    private watchHazards(f: SoundFrame): void {
        const hz = f.hazard;
        const w = this.world.level.water;
        if (hz.flood === PHASE.tell && this.prevFlood === PHASE.idle) this.play('siren', null, { gain: 0.75 });
        // the handbrake prank: the ratchet creeping off, from the ute
        if (hz.brake !== this.prevBrake && hz.brake !== PHASE.idle) {
            const at = this.ute.seen ? { x: this.ute.x, y: this.ute.y + 0.8, z: this.ute.z } : null;
            this.play(hz.brake === PHASE.tell ? 'ratchet' : 'clank', at, { gain: hz.brake === PHASE.tell ? 1 : 0.6 });
        }
        this.prevBrake = hz.brake;
        if (hz.gust !== this.prevGust && hz.gust !== PHASE.idle) {
            // from upwind of the player it is aimed at
            const tr = this.eyeTracks[hz.gustSlot];
            const c = tr?.seen ? tr : { x: f.listener.x, y: f.listener.y, z: f.listener.z };
            const at = { x: c.x - Math.cos(hz.gustDir) * 4, y: c.y + 1, z: c.z - Math.sin(hz.gustDir) * 4 };
            if (hz.gust === PHASE.tell) this.play('gust-warn', at, { gain: 0.8 });
            else this.play('gust', at, { gain: 1 });
        }
        this.prevFlood = hz.flood;
        this.prevGust = hz.gust;
        const rumble = this.loops.get('rumble');
        if (rumble)
            rumble.target =
                hz.flood === PHASE.tell ? 0.55 : hz.flood === PHASE.active ? 0.85 : hz.flood === PHASE.recede ? 0.3 : 0;
        // the creek: from the nearest point of the water, louder in flood
        const river = this.loops.get('river');
        if (river) {
            if (w.y < -10) river.target = 0;
            else {
                const x = Math.max(w.cx - w.halfX, Math.min(w.cx + w.halfX, f.listener.x));
                const z = Math.max(w.cz - w.halfZ, Math.min(w.cz + w.halfZ, f.listener.z));
                river.e.setPosition(x, hz.waterY, z);
                const rise = Math.max(0, hz.waterY - w.y);
                river.target = 0.45 + Math.min(0.5, rise * 0.5);
                river.pitch = 1 + Math.min(0.25, rise * 0.2);
            }
        }
    }

    private ambience(f: SoundFrame): void {
        const wind = this.loops.get('wind');
        if (wind) {
            const gust = f.hazard.gust === PHASE.active ? 0.35 : 0;
            wind.target = Math.min(0.85, 0.1 + f.windSpeed / 7 + gust);
            wind.pitch = 0.9 + Math.min(0.3, f.windSpeed * 0.04);
        }
        // birds, now and then, in the trees around (quiet while the river floods)
        if (f.time > this.nextBird) {
            this.nextBird = f.time + 5 + Math.random() * 9;
            if (f.hazard.flood === PHASE.idle) {
                const a = Math.random() * Math.PI * 2;
                const r = 8 + Math.random() * 10;
                const l = f.listener;
                this.play(
                    'bird',
                    { x: l.x + Math.cos(a) * r, y: l.y + 3 + Math.random() * 4, z: l.z + Math.sin(a) * r },
                    {
                        gain: 0.35 + Math.random() * 0.25,
                        pitch: 0.9 + Math.random() * 0.25
                    }
                );
            }
        }
    }

    private updateLoops(_f: SoundFrame, dt: number): void {
        const k = 1 - Math.exp(-dt * 3);
        for (const [name, l] of this.loops) {
            l.gain += (l.target - l.gain) * k;
            const slot = l.e.sound!.slot(name);
            if (!slot) continue;
            const bus = name === 'engine' ? this.volumes.effects : this.volumes.ambience;
            slot.volume = l.gain * bus;
            slot.pitch = l.pitch;
        }
        // held loops: let go (not held for a moment) they fade out, then stop
        for (const h of this.holds.update(performance.now(), k * 3)) {
            const slot = h.e.sound!.slot(h.name);
            if (!slot) continue;
            slot.volume = h.volume * this.volumes.effects;
            slot.pitch = h.pitch;
        }
    }

    /** For tests and the debug panel. */
    status(): {
        started: boolean;
        context: string;
        played: number;
        recent: string[];
        loops: Record<string, number>;
        waterfalls: number;
    } {
        const loops: Record<string, number> = {};
        for (const [n, l] of this.loops) loops[n] = Math.round(l.gain * 100) / 100;
        return {
            started: this.started,
            context: this.started ? (this.app.soundManager.context?.state ?? 'none') : 'locked',
            played: this.played,
            recent: [...this.recent],
            loops,
            waterfalls: this.falls.length
        };
    }
}

function newTrack(): Track {
    return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, seen: false, quiet: 0 };
}

/** The props worth hearing, by what they are made of. */
export function soundBodies(entities: readonly { name: string; slot: number }[]): WatchedBody[] {
    const out: WatchedBody[] = [];
    for (const e of entities) {
        const n = e.name;
        let kind: ImpactKind | null = null;
        if (
            n === 'plank' ||
            n === 'held-plank' ||
            n === 'long-plank' ||
            n.startsWith('extra-plank') ||
            n.startsWith('crate-') ||
            n === 'cube'
        )
            kind = 'timber';
        else if (n.startsWith('beam-')) kind = 'beam';
        else if (n === 'log' || n.startsWith('extra-log')) kind = 'heavy';
        else if (n === 'bucket') kind = 'metal';
        else if (n === 'sphere' || n.startsWith('dummy')) kind = 'soft';
        if (kind) out.push({ slot: e.slot, kind });
    }
    return out;
}

type EventSound = { name: SfxName; gain: number; pitch: number };

/**
 * Event kinds whose sound is played somewhere else, where it is placed in the world: a nail's
 * creak and snap come from the nail markers (render/nail-markers.ts), and a fall into the creek
 * splashes when the body hits the water (`props`, below). Voicing them here too would double them.
 */
export const VOICED_ELSEWHERE: ReadonlySet<SimEvent['kind']> = new Set<SimEvent['kind']>(['creak', 'break', 'fell']);

const NONE: EventSound[] = [];
const soft = (name: SfxName, gain: number, pitch: number): EventSound[] => [{ name, gain, pitch }];

/**
 * What each kind of level event sounds like. A `Record` keyed on every kind, so a new kind does
 * not type-check until it has a sound (or is listed in VOICED_ELSEWHERE).
 */
const EVENT_SOUNDS: Record<SimEvent['kind'], (text: string) => EventSound[]> = {
    step: () => soft('ding', 0.6, 1),
    goal: () => soft('fanfare', 0.8, 1),
    recovered: () => soft('ding', 0.45, 0.75),
    // a rule about the bucket (too heavy to jump with it): a dull knock
    hint: () => soft('thud', 0.5, 0.8),
    hazard: (text) => {
        if (text === CLOSURE_TELL || text === CLOSURE_OPEN || text === CLOSURE_SHUT)
            return soft('clunk', 1, text === CLOSURE_TELL ? 1 : 1.1);
        if (text === TREE_TELL)
            return [
                { name: 'snap', gain: 1, pitch: 0.8 },
                { name: 'creak', gain: 1, pitch: 0.65 }
            ];
        // the flood, the gust and the handbrake sound from their state (update)
        return NONE;
    },
    // getting in or out already sounds the door (from the seat change); a ute put back on its
    // wheels sounds like anything recovered; a rule about it (nail the beams down) like a hint
    ute: (text) => {
        if (/seat|Riding along/.test(text)) return NONE;
        if (text.startsWith('The ute is back')) return soft('ding', 0.45, 0.75);
        return soft('thud', 0.5, 0.8);
    },
    // the bucket filled, or a gate's rule about it: a slosh
    water: () => soft('slosh', 0.6, 1),
    // the pine falls, a log is bucked, fresh logs arrive: a wooden knock
    wood: () => soft('knock', 0.6, 0.9),
    // the hand winch (Epic 5, #52): its rope snapping, or its hook, crank and pawl (a metal clank)
    winch: (text) => (text.startsWith('Snap!') ? soft('snap', 1, 0.9) : soft('clank', 0.5, 1)),
    creak: () => NONE,
    break: () => NONE,
    fell: () => NONE
};

/**
 * What a level event sounds like (heard everywhere): from the event itself, so a guest, who gets
 * the host's events, hears the same. Hazards whose tell is a state (the flood, the gust, the
 * handbrake) sound from that state instead (update); the falling tree's crack is its toast.
 */
export function eventSounds(kind: string, text: string): EventSound[] {
    const f = (EVENT_SOUNDS as Record<string, ((text: string) => EventSound[]) | undefined>)[kind];
    return f ? f(text) : NONE;
}
