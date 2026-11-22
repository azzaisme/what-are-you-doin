/**
 * Every sound in the game, synthesized from code (Epic 8, issue #19): original, nothing to license
 * or attribute, nothing to download. Each generator returns mono samples in [-1, 1] at a sample
 * rate; the same name and seed always give the same samples. Engine-free (no Web Audio), so the
 * generators can be unit tested; src/audio/game-audio.ts turns them into PlayCanvas sound assets.
 */

export const SYNTH_RATE = 22050;

/** One sound: its samples and whether it loops (loops are made seamless). */
export interface SynthSound {
    samples: Float32Array;
    loop: boolean;
}

// ------------------------------------------------------------------------------- building blocks

/** Seeded uniform 0..1 (mulberry32). */
export function rng(seed: number): () => number {
    let a = seed >>> 0 || 1;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function noise(n: number, seed: number): Float32Array {
    const r = rng(seed);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = r() * 2 - 1;
    return out;
}

/** One-pole low-pass, cutoff in Hz (per sample: a function of the sample index allows sweeps). */
function lowpass(x: Float32Array, hz: number | ((i: number) => number), sr: number): Float32Array {
    const out = new Float32Array(x.length);
    let y = 0;
    for (let i = 0; i < x.length; i++) {
        const f = typeof hz === 'number' ? hz : hz(i);
        const a = 1 - Math.exp((-2 * Math.PI * f) / sr);
        y += (x[i] - y) * a;
        out[i] = y;
    }
    return out;
}

function highpass(x: Float32Array, hz: number, sr: number): Float32Array {
    const lp = lowpass(x, hz, sr);
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) out[i] = x[i] - lp[i];
    return out;
}

/** Resonant band-pass (RBJ biquad, constant peak gain); centre may sweep. */
function bandpass(x: Float32Array, hz: number | ((i: number) => number), q: number, sr: number): Float32Array {
    const out = new Float32Array(x.length);
    let x1 = 0,
        x2 = 0,
        y1 = 0,
        y2 = 0;
    for (let i = 0; i < x.length; i++) {
        const f = typeof hz === 'number' ? hz : hz(i);
        const w = (2 * Math.PI * Math.min(f, sr * 0.45)) / sr;
        const alpha = Math.sin(w) / (2 * q);
        const a0 = 1 + alpha;
        const b0 = alpha / a0;
        const a1 = (-2 * Math.cos(w)) / a0;
        const a2 = (1 - alpha) / a0;
        const y = b0 * x[i] - b0 * x2 - a1 * y1 - a2 * y2;
        x2 = x1;
        x1 = x[i];
        y2 = y1;
        y1 = y;
        out[i] = y;
    }
    return out;
}

/** Attack then exponential decay (seconds). */
function env(i: number, sr: number, attack: number, decay: number): number {
    const t = i / sr;
    if (t < attack) return t / attack;
    return Math.exp(-(t - attack) / decay);
}

function mix(...parts: [Float32Array, number][]): Float32Array {
    const n = Math.max(...parts.map((p) => p[0].length));
    const out = new Float32Array(n);
    for (const [x, g] of parts) for (let i = 0; i < x.length; i++) out[i] += x[i] * g;
    return out;
}

/** Scales to a peak and clips nothing: the loudest sample becomes `peak`. */
function normalize(x: Float32Array, peak = 0.9): Float32Array {
    let m = 0;
    for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
    if (m > 0) for (let i = 0; i < x.length; i++) x[i] *= peak / m;
    return x;
}

/** Short fades at both ends (no clicks). */
function fadeEnds(x: Float32Array, sr: number, s = 0.004): Float32Array {
    const n = Math.min(x.length >> 1, Math.round(s * sr));
    for (let i = 0; i < n; i++) {
        x[i] *= i / n;
        x[x.length - 1 - i] *= i / n;
    }
    return x;
}

/** Makes a loop seamless: the tail is cross-faded into the head (the result is shorter). */
function seamless(x: Float32Array, sr: number, fade = 0.25): Float32Array {
    const n = Math.round(fade * sr);
    const out = x.slice(0, x.length - n);
    for (let i = 0; i < n; i++) {
        const k = i / n;
        out[i] = out[i] * k + x[x.length - n + i] * (1 - k);
    }
    return out;
}

function sine(n: number, sr: number, hz: (t: number) => number): Float32Array {
    const out = new Float32Array(n);
    let ph = 0;
    for (let i = 0; i < n; i++) {
        ph += (2 * Math.PI * hz(i / sr)) / sr;
        out[i] = Math.sin(ph);
    }
    return out;
}

const len = (s: number, sr: number) => Math.max(1, Math.round(s * sr));

// ------------------------------------------------------------------------------- the sounds

/** Timber knocking on something: a hollow wooden tock. */
function knock(sr: number, seed: number): Float32Array {
    const n = len(0.32, sr);
    const r = rng(seed);
    const f = 330 + r() * 220;
    const body = bandpass(noise(n, seed), f, 9, sr);
    const tone = sine(n, sr, () => f * 0.5);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = (body[i] * 3 + tone[i] * 0.5) * env(i, sr, 0.001, 0.05 + r() * 0.03);
    return fadeEnds(normalize(out), sr);
}

/** The bucket hitting something: a tinny clank with a short ring. */
function clank(sr: number, seed: number): Float32Array {
    const n = len(0.6, sr);
    const r = rng(seed);
    const parts: [Float32Array, number][] = [];
    for (const m of [1, 2.76, 5.4]) {
        const f = (720 + r() * 120) * m;
        const s = sine(n, sr, () => f);
        for (let i = 0; i < n; i++) s[i] *= env(i, sr, 0.0005, 0.12 / m);
        parts.push([s, 1 / m]);
    }
    const hit = highpass(noise(n, seed + 1), 2000, sr);
    for (let i = 0; i < n; i++) hit[i] *= env(i, sr, 0.0005, 0.01);
    parts.push([hit, 0.6]);
    return fadeEnds(normalize(mix(...parts)), sr);
}

/** Something heavy landing (a log, a person, a full crate): a low thump. */
function thud(sr: number, seed: number): Float32Array {
    const n = len(0.45, sr);
    const tone = sine(n, sr, (t) => 55 + 90 * Math.exp(-t * 30));
    const dirt = lowpass(noise(n, seed), 700, sr);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = tone[i] * env(i, sr, 0.002, 0.11) + dirt[i] * 2.5 * env(i, sr, 0.001, 0.05);
    return fadeEnds(normalize(out), sr);
}

/** Into the water: a plop and a spray of droplets; `big` for a person or a beam. */
function splash(sr: number, seed: number, big: boolean): Float32Array {
    const n = len(big ? 1.3 : 0.7, sr);
    const r = rng(seed);
    const spray = bandpass(noise(n, seed), (i) => 1400 + 1800 * Math.exp(-i / sr / 0.3), 1.2, sr);
    for (let i = 0; i < n; i++) spray[i] *= env(i, sr, 0.004, big ? 0.35 : 0.18);
    const plop = sine(n, sr, (t) => (big ? 140 : 260) + (big ? 500 : 900) * Math.exp(-t * 25));
    for (let i = 0; i < n; i++) plop[i] *= env(i, sr, 0.001, big ? 0.08 : 0.04);
    const out = mix([spray, 1], [plop, big ? 0.9 : 0.6]);
    // droplets falling back
    for (let d = 0; d < (big ? 14 : 6); d++) {
        const at = Math.round((0.12 + r() * (big ? 0.8 : 0.4)) * sr);
        const f = 900 + r() * 1600;
        for (let i = 0; i < len(0.05, sr) && at + i < n; i++)
            out[at + i] += Math.sin(2 * Math.PI * f * (1 + i / sr / 0.05) * (i / sr)) * 0.25 * env(i, sr, 0.001, 0.012);
    }
    return fadeEnds(normalize(out, 0.85), sr);
}

/** Taking hold of something: a soft grip-and-scuff. */
function grab(sr: number, seed: number): Float32Array {
    const n = len(0.18, sr);
    const s = bandpass(noise(n, seed), 900, 1.5, sr);
    for (let i = 0; i < n; i++) s[i] *= env(i, sr, 0.008, 0.04);
    return fadeEnds(normalize(s, 0.7), sr);
}

/** A throw: a quick rising whoosh. */
function whoosh(sr: number, seed: number, seconds: number, from: number, to: number): Float32Array {
    const n = len(seconds, sr);
    const s = bandpass(noise(n, seed), (i) => from + (to - from) * (i / n), 0.9, sr);
    for (let i = 0; i < n; i++) s[i] *= Math.sin((Math.PI * i) / n) ** 2;
    return fadeEnds(normalize(s, 0.8), sr);
}

/** A footstep on gravel: a short crunch. */
function step(sr: number, seed: number): Float32Array {
    const n = len(0.14, sr);
    const r = rng(seed);
    const s = bandpass(noise(n, seed), 1600 + r() * 900, 0.8, sr);
    const lo = lowpass(noise(n, seed + 7), 300, sr);
    for (let i = 0; i < n; i++) {
        const e = env(i, sr, 0.003, 0.03);
        s[i] = (s[i] + lo[i] * 2) * e * (0.6 + 0.4 * r());
    }
    return fadeEnds(normalize(s, 0.6), sr);
}

/** The ute's door: a latch click and a thunk. */
function door(sr: number, seed: number): Float32Array {
    const n = len(0.4, sr);
    const t = thud(sr, seed);
    const click = highpass(noise(n, seed + 3), 2500, sr);
    for (let i = 0; i < n; i++) click[i] *= env(i, sr, 0.0005, 0.006);
    return fadeEnds(normalize(mix([t.slice(0, n), 0.8], [click, 0.5])), sr);
}

/** The ute's engine: a four-cylinder burble (loop; pitch follows the revs). */
function engine(sr: number, seed: number): Float32Array {
    const n = len(2.25, sr);
    const out = new Float32Array(n);
    const fire = 33.33; // firings per second at idle (a loop of whole cycles)
    const rough = noise(n, seed);
    const lp = lowpass(rough, 400, sr);
    for (let i = 0; i < n; i++) {
        const t = i / sr;
        const ph = (t * fire) % 1;
        const pulse = Math.exp(-ph * 9) * (0.85 + 0.3 * Math.sin(t * fire * Math.PI * 0.5));
        out[i] = pulse * (0.6 + lp[i] * 3) + Math.sin(2 * Math.PI * fire * t) * 0.25;
    }
    return seamless(normalize(lowpass(out, 900, sr), 0.8), sr, 0.08);
}

/** The creek: a broadband rush with gurgles (loop). */
function river(sr: number, seed: number): Float32Array {
    const n = len(5, sr);
    const r = rng(seed);
    const rush = lowpass(highpass(noise(n, seed), 200, sr), 2500, sr);
    const out = rush.slice();
    for (let g = 0; g < 40; g++) {
        const at = Math.floor(r() * (n - sr * 0.1));
        const f = 300 + r() * 500;
        for (let i = 0; i < len(0.08, sr); i++)
            out[at + i] += Math.sin(2 * Math.PI * f * (1 + 2 * (i / sr)) * (i / sr)) * 0.2 * env(i, sr, 0.01, 0.025);
    }
    return seamless(normalize(out, 0.7), sr, 0.5);
}

/** Wind in the valley: a slowly breathing hiss (loop). */
function wind(sr: number, seed: number): Float32Array {
    const n = len(6, sr);
    const s = bandpass(noise(n, seed), (i) => 500 + 300 * Math.sin((2 * Math.PI * i) / n), 0.7, sr);
    for (let i = 0; i < n; i++) s[i] *= 0.7 + 0.3 * Math.sin((4 * Math.PI * i) / n);
    return seamless(normalize(s, 0.7), sr, 0.6);
}

/** The flood coming: a deep rolling rumble (loop). */
function rumble(sr: number, seed: number): Float32Array {
    const n = len(4, sr);
    const s = lowpass(noise(n, seed), 90, sr);
    const boom = sine(n, sr, (t) => 38 + 6 * Math.sin(t * 1.7));
    return seamless(normalize(mix([s, 6], [boom, 0.4]), 0.85), sr, 0.5);
}

/** The flood siren: two rising and falling wails. */
function siren(sr: number): Float32Array {
    const n = len(5.2, sr);
    const out = new Float32Array(n);
    let ph = 0;
    for (let i = 0; i < n; i++) {
        const t = i / sr;
        const u = (t % 2.6) / 2.6;
        const f = 380 + 520 * Math.sin(Math.PI * u);
        ph += (2 * Math.PI * f) / sr;
        const a = Math.min(1, t / 0.3) * Math.min(1, (5.2 - t) / 0.6);
        out[i] = (Math.sin(ph) + 0.35 * Math.sin(2 * ph) + 0.15 * Math.sin(3 * ph)) * a;
    }
    return fadeEnds(normalize(out, 0.75), sr);
}

/** A bird call: two or three quick chirps. */
function bird(sr: number, seed: number): Float32Array {
    const r = rng(seed);
    const n = len(0.7, sr);
    const out = new Float32Array(n);
    const chirps = 2 + Math.floor(r() * 2);
    const base = 2600 + r() * 1500;
    for (let c = 0; c < chirps; c++) {
        const at = Math.round(c * (0.14 + r() * 0.06) * sr);
        const d = 0.06 + r() * 0.04;
        let ph = 0;
        for (let i = 0; i < len(d, sr) && at + i < n; i++) {
            const t = i / sr / d;
            ph += (2 * Math.PI * base * (1 + 0.35 * Math.sin(Math.PI * t))) / sr;
            out[at + i] += Math.sin(ph) * Math.sin(Math.PI * t);
        }
    }
    return fadeEnds(normalize(out, 0.5), sr);
}

/** A cheerful two-note ding (a step done) or a little three-note fanfare (the goal). */
function chime(sr: number, notes: number[]): Float32Array {
    const each = 0.16;
    const n = len(each * notes.length + 0.9, sr);
    const out = new Float32Array(n);
    notes.forEach((f, k) => {
        const at = Math.round(k * each * sr);
        for (let i = 0; at + i < n; i++) {
            const t = i / sr;
            const e = env(i, sr, 0.004, 0.35);
            if (i > sr * 0.01 && e < 1e-4) break;
            out[at + i] += (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t)) * e;
        }
    });
    return fadeEnds(normalize(out, 0.7), sr);
}

/** Timber under load: a groaning creak (for joints and bridges, Epic 5). */
function creak(sr: number, seed: number): Float32Array {
    const r = rng(seed);
    const n = len(0.5 + r() * 0.4, sr);
    const out = new Float32Array(n);
    // stick-slip: a train of clicks whose rate wanders, through a woody resonance
    let next = 0;
    const rate = 70 + r() * 60;
    for (let i = 0; i < n; i++) {
        if (i >= next) {
            out[i] = 1;
            const t = i / n;
            next = i + Math.max(1, Math.round(sr / (rate * (0.7 + 0.6 * Math.sin(Math.PI * t)) * (0.9 + 0.2 * r()))));
        }
    }
    const res = mix([bandpass(out, 620 + r() * 300, 6, sr), 1], [bandpass(out, 1500 + r() * 400, 8, sr), 0.5]);
    for (let i = 0; i < n; i++) res[i] *= Math.sin((Math.PI * i) / n);
    return fadeEnds(normalize(res, 0.8), sr);
}

/** Timber breaking: a sharp crack and splinters (Epic 5). */
function snap(sr: number, seed: number): Float32Array {
    const n = len(0.7, sr);
    const r = rng(seed);
    const crack = highpass(noise(n, seed), 900, sr);
    for (let i = 0; i < n; i++) crack[i] *= env(i, sr, 0.0005, 0.03);
    const out = mix([crack, 1], [thud(sr, seed + 1).slice(0, n), 0.5]);
    for (let s = 0; s < 8; s++) {
        const at = Math.round((0.03 + r() * 0.3) * sr);
        for (let i = 0; i < len(0.02, sr) && at + i < n; i++) out[at + i] += (r() * 2 - 1) * 0.6 * env(i, sr, 0, 0.004);
    }
    return fadeEnds(normalize(out), sr);
}

/** Every sound by name. Variants (`-0`, `-1`, ...) are picked at random when played. */
export const SOUND_NAMES = [
    'knock-0',
    'knock-1',
    'knock-2',
    'clank-0',
    'clank-1',
    'thud-0',
    'thud-1',
    'splash-small',
    'splash-big',
    'grab',
    'drop',
    'throw',
    'step-0',
    'step-1',
    'step-2',
    'step-3',
    'door',
    'engine',
    'river',
    'wind',
    'rumble',
    'siren',
    'gust-warn',
    'gust',
    'bird-0',
    'bird-1',
    'bird-2',
    'ding',
    'fanfare',
    'creak-0',
    'creak-1',
    'creak-2',
    'snap'
] as const;
export type SoundName = (typeof SOUND_NAMES)[number];

/** The loops (played continuously, their volume and pitch follow the game). */
export const LOOPS: ReadonlySet<SoundName> = new Set<SoundName>(['engine', 'river', 'wind', 'rumble']);

export function synthesize(name: SoundName, sr = SYNTH_RATE): SynthSound {
    const v = Number(name.split('-').pop());
    const k = Number.isFinite(v) ? v : 0;
    const loop = LOOPS.has(name);
    let samples: Float32Array;
    if (name.startsWith('knock')) samples = knock(sr, 11 + k * 7);
    else if (name.startsWith('clank')) samples = clank(sr, 21 + k * 5);
    else if (name.startsWith('thud')) samples = thud(sr, 31 + k * 3);
    else if (name.startsWith('step')) samples = step(sr, 41 + k * 13);
    else if (name.startsWith('bird')) samples = bird(sr, 51 + k * 17);
    else if (name.startsWith('creak')) samples = creak(sr, 61 + k * 19);
    else
        switch (name) {
            case 'splash-small':
                samples = splash(sr, 71, false);
                break;
            case 'splash-big':
                samples = splash(sr, 72, true);
                break;
            case 'grab':
                samples = grab(sr, 81);
                break;
            case 'drop':
                samples = thud(sr, 82).map((x) => x * 0.6);
                break;
            case 'throw':
                samples = whoosh(sr, 83, 0.35, 500, 2200);
                break;
            case 'door':
                samples = door(sr, 84);
                break;
            case 'engine':
                samples = engine(sr, 85);
                break;
            case 'river':
                samples = river(sr, 86);
                break;
            case 'wind':
                samples = wind(sr, 87);
                break;
            case 'rumble':
                samples = rumble(sr, 88);
                break;
            case 'siren':
                samples = siren(sr);
                break;
            case 'gust-warn':
                samples = whoosh(sr, 89, 1.2, 300, 1100);
                break;
            case 'gust':
                samples = whoosh(sr, 90, 2.6, 250, 900);
                break;
            case 'ding':
                samples = chime(sr, [784, 1047]);
                break;
            case 'fanfare':
                samples = chime(sr, [523, 659, 784, 1047]);
                break;
            case 'snap':
                samples = snap(sr, 91);
                break;
            default:
                samples = new Float32Array(1);
        }
    return { samples, loop };
}
