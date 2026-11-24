/**
 * The sound API other features call (no engine import, safe anywhere on the client): a one-shot
 * at a world position, or without one for a sound heard everywhere. It does nothing until the
 * game's audio is running (after the first user gesture), so callers never have to check.
 *
 * Epic 5 (bridges and joints) plays its creaks and breaks through this:
 *
 *     sfx.creak({ x, y, z }, strain); // strain 0..1: louder and lower as a joint nears breaking
 *     sfx.snap({ x, y, z });          // a joint or a piece gives way
 *
 * Epic 6 (sawmill, chopping) and Epic 7 (water):
 *
 *     sfx.hold('mill', 'saw', pos, { gain: 0.8, pitch: 0.8 + load * 0.4 }); // every frame it runs
 *     sfx.play('chop', pos, { gain: 0.9 });
 *     sfx.play('slosh', bucketPos, { gain: sloshAmount });
 *     sfx.hold('fill', 'pour', tapPos);                                        // every frame it pours
 *
 * The full list of sounds and when to use them: docs/sound.md.
 *
 * Sounds are client-side: call these from code every device runs (from what the snapshots and the
 * host's state show), so guests hear them too.
 */

import type { SoundName } from './synth.ts';

export interface Vec3Like {
    x: number;
    y: number;
    z: number;
}

/** A sound name, or a family whose variants are picked at random (`knock` -> `knock-0..2`). */
export type SfxName = SoundName | 'knock' | 'clank' | 'thud' | 'step' | 'bird' | 'creak';

export interface SfxOptions {
    /** Loudness, 0..1 and more (times the effects volume). */
    gain?: number;
    /** Playback rate (1 = as recorded; lower is deeper). */
    pitch?: number;
}

export interface SfxSink {
    play(name: SfxName, at: Vec3Like | null, opts?: SfxOptions): void;
    hold(key: string, name: SfxName, at: Vec3Like | null, opts?: SfxOptions): void;
}

let sink: SfxSink | null = null;

export const sfx = {
    play(name: SfxName, at: Vec3Like | null = null, opts: SfxOptions = {}): void {
        sink?.play(name, at, opts);
    },
    /** Timber under load: `strain` 0..1. */
    creak(at: Vec3Like, strain: number): void {
        const s = Math.max(0, Math.min(1, strain));
        sink?.play('creak', at, { gain: 0.25 + 0.75 * s, pitch: 1.15 - 0.35 * s });
    },
    /**
     * A loop that plays while you keep calling this every frame (a sawmill running, water pouring),
     * moving with `at`; stop calling and it fades out within a quarter of a second. `key` names one
     * source (two sawmills need two keys). Loops: 'saw', 'pour' (and the game's own: 'engine', ...).
     */
    hold(key: string, name: SfxName, at: Vec3Like | null = null, opts: SfxOptions = {}): void {
        sink?.hold(key, name, at, opts);
    },
    /** Something breaks. */
    snap(at: Vec3Like): void {
        sink?.play('snap', at, { gain: 1 });
    },
    /** The game's audio installs itself here once it runs (src/audio/game-audio.ts). */
    setSink(s: SfxSink | null): void {
        sink = s;
    }
};
