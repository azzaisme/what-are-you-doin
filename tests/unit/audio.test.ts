import { describe, expect, it } from 'vitest';

import { soundBodies } from '../../src/audio/game-audio.ts';
import { sfx } from '../../src/audio/sfx.ts';
import type { SfxName } from '../../src/audio/sfx.ts';
import { LOOPS, SOUND_NAMES, SYNTH_RATE, synthesize } from '../../src/audio/synth.ts';
import type { SoundName, SynthSound } from '../../src/audio/synth.ts';

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
