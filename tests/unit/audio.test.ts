import { afterEach, describe, expect, it } from 'vitest';

import { eventSounds, soundBodies } from '../../src/audio/game-audio.ts';
import { HOLD_FADE, HeldLoops } from '../../src/audio/held-loops.ts';
import { sfx } from '../../src/audio/sfx.ts';
import type { SfxName } from '../../src/audio/sfx.ts';
import { LOOPS, SOUND_NAMES, SYNTH_RATE, synthesize } from '../../src/audio/synth.ts';
import type { SoundName, SynthSound } from '../../src/audio/synth.ts';
import { timberYardLevel } from '../../src/levels/timber-yard.ts';
import { valleyLevel } from '../../src/levels/valley.ts';
import { TREE_TELL } from '../../src/sim/hazard-tree.ts';

// a test that installs an sfx sink never leaves it installed for later tests, even on a failure
afterEach(() => sfx.setSink(null));

/** Each sound synthesized once for all the tests here (about 0.2 s in all). */
const cache = new Map<SoundName, SynthSound>();
const synth = (n: SoundName) => {
    let s = cache.get(n);
    if (!s) {
        s = synthesize(n);
        cache.set(n, s);
    }
    return s;
};

describe('sound: every sound is synthesized (original, nothing to license)', () => {
    it('each sound is finite, in range, audible and not too long', () => {
        for (const name of SOUND_NAMES) {
            const { samples } = synth(name);
            expect(samples.length, name).toBeGreaterThan(SYNTH_RATE * 0.1);
            expect(samples.length, name).toBeLessThan(SYNTH_RATE * 7);
            let peak = 0;
            let energy = 0;
            let finite = true;
            for (const x of samples) {
                finite &&= Number.isFinite(x);
                peak = Math.max(peak, Math.abs(x));
                energy += x * x;
            }
            expect(finite, name).toBe(true);
            expect(peak, name).toBeLessThanOrEqual(0.91);
            expect(peak, name).toBeGreaterThan(0.3);
            expect(Math.sqrt(energy / samples.length), name).toBeGreaterThan(0.01);
        }
    });

    it('the same name gives the same samples (deterministic), variants differ', () => {
        expect(synthesize('knock-1').samples).toEqual(synthesize('knock-1').samples);
        expect(synthesize('knock-0').samples).not.toEqual(synthesize('knock-1').samples);
    });

    it('one-shots start and end silent (no clicks); loops join without a jump', () => {
        for (const name of SOUND_NAMES) {
            const { samples, loop } = synth(name);
            const first = samples[0];
            const last = samples[samples.length - 1];
            if (loop) {
                // the cross-faded seam: the step from the last sample to the first is ordinary
                let maxStep = 0;
                for (let i = 1; i < samples.length; i++)
                    maxStep = Math.max(maxStep, Math.abs(samples[i] - samples[i - 1]));
                expect(Math.abs(first - last), name).toBeLessThanOrEqual(maxStep + 1e-6);
            } else {
                expect(Math.abs(first), name).toBeLessThan(0.02);
                expect(Math.abs(last), name).toBeLessThan(0.02);
            }
        }
        expect(LOOPS.has('river')).toBe(true);
        expect(synth('river').loop).toBe(true);
        expect(synth('siren').loop).toBe(false);
    });

    it('the sfx API is safe before the audio runs, and forwards to the game once it does', () => {
        sfx.creak({ x: 0, y: 0, z: 0 }, 0.5); // nothing installed: a no-op
        const got: [SfxName, number | undefined, number | undefined][] = [];
        const held: string[] = [];
        sfx.setSink({ play: (n, _at, o) => got.push([n, o?.gain, o?.pitch]), hold: (k, n) => held.push(`${k}:${n}`) });
        sfx.creak({ x: 0, y: 1, z: 0 }, 1);
        sfx.creak({ x: 0, y: 1, z: 0 }, 0);
        sfx.snap({ x: 0, y: 1, z: 0 });
        sfx.hold('mill', 'saw', { x: 0, y: 1, z: 0 }, { pitch: 0.9 });
        sfx.setSink(null);
        sfx.hold('mill', 'saw'); // nothing installed again: a no-op
        expect(held).toEqual(['mill:saw']);
        expect(got[0][0]).toBe('creak');
        // more strain: louder and deeper
        expect(got[0][1]!).toBeGreaterThan(got[1][1]!);
        expect(got[0][2]!).toBeLessThan(got[1][2]!);
        expect(got[2][0]).toBe('snap');
    });

    it('sfx.hold: a loop sounds while held, fades once not held for 250 ms, then stops and is removed', () => {
        const made: string[] = [];
        const destroyed: string[] = [];
        const loops = new HeldLoops<{ key: string; name: string }>(
            (key, name) => {
                made.push(`${key}:${name}`);
                return { key, name };
            },
            (e) => destroyed.push(`${e.key}:${e.name}`)
        );
        const FRAME = 1000 / 60;
        const K = 3 * (1 - Math.exp(-3 / 60)); // the per-frame ease GameAudio gives held loops at 60 fps
        let now = 0;
        // held every frame for 1 s: one emitter, rising to the held gain
        for (let i = 0; i < 60; i++, now += FRAME) {
            loops.hold('mill', 'saw', true, 0.8, 0.9, now);
            loops.update(now, K);
        }
        expect(made).toEqual(['mill:saw']);
        expect(loops.gainOf('mill')).toBeCloseTo(0.8, 2);
        const live = loops.update(now, K);
        expect(live.map((l) => [l.name, l.pitch])).toEqual([['saw', 0.9]]);
        // the calls stop: for 250 ms it still sounds at full gain
        const lastHold = now - FRAME;
        while (now - lastHold <= HOLD_FADE.letGoMs) {
            loops.update(now, K);
            now += FRAME;
        }
        expect(loops.gainOf('mill')).toBeCloseTo(0.8, 2);
        expect(destroyed).toEqual([]);
        // then it fades: lower each frame, still there
        const g0 = loops.gainOf('mill');
        loops.update(now, K);
        now += FRAME;
        expect(loops.gainOf('mill')).toBeLessThan(g0);
        expect(loops.has('mill')).toBe(true);
        // and once silent it is stopped: the emitter destroyed, the entry gone
        let frames = 0;
        while (loops.has('mill') && frames++ < 200) {
            loops.update(now, K);
            now += FRAME;
        }
        expect(frames).toBeLessThan(60); // under a second
        expect(destroyed).toEqual(['mill:saw']);
        expect(loops.size).toBe(0);
        expect(loops.update(now, K)).toEqual([]);
        // holding the key with another sound swaps the emitter
        loops.hold('pump', 'pour', false, 1, 1, now);
        loops.hold('pump', 'slosh', false, 1, 1, now);
        expect(made.slice(1)).toEqual(['pump:pour', 'pump:slosh']);
        expect(destroyed.slice(1)).toEqual(['pump:pour']);
        expect(loops.size).toBe(1);
    });

    it('events sound everywhere: a ding for a step, a fanfare at the goal, the falling tree’s crack from its toast', () => {
        expect(eventSounds('step', '').map((x) => x.name)).toEqual(['ding']);
        expect(eventSounds('goal', '').map((x) => x.name)).toEqual(['fanfare']);
        expect(eventSounds('hazard', TREE_TELL).map((x) => x.name)).toEqual(['snap', 'creak']);
        // other hazard toasts sound from their state (the siren, the gust), not their text
        expect(eventSounds('hazard', 'The handbrake is off! The ute is rolling.')).toEqual([]);
        expect(eventSounds('fell', 'Splash!')).toEqual([]);
    });

    it('the Valley’s waterfall is heard from where it falls (its sound spot is the waterfall piece)', () => {
        const spots = valleyLevel.sounds?.waterfalls ?? [];
        expect(spots).toHaveLength(1);
        const fall = valleyLevel.layout(1).pieces.find((p) => p.name === 'waterfall')!;
        expect(fall).toBeDefined();
        const at = spots[0];
        expect(Math.hypot(at.x - fall.pose.p.x, at.y - fall.pose.p.y, at.z - fall.pose.p.z)).toBeLessThan(0.01);
        // the yard has none
        expect(timberYardLevel.sounds?.waterfalls ?? []).toHaveLength(0);
    });

    it('props sound like what they are made of', () => {
        const kinds = soundBodies([
            { name: 'plank', slot: 1 },
            { name: 'beam-0', slot: 2 },
            { name: 'bucket', slot: 3 },
            { name: 'log', slot: 4 },
            { name: 'windsock', slot: 5 }
        ]).map((w) => w.kind);
        expect(kinds).toEqual(['timber', 'beam', 'metal', 'heavy']);
    });
});
