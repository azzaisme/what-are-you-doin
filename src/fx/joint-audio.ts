/**
 * Structural warning sounds (Epic 5, #50): a wooden creak when a joint strains, a groan when it is
 * close to breaking, and a crack when it gives way. Synthesized with Web Audio (filtered noise and
 * a low thump), so there is no asset to license. Created on first use, after the player has
 * interacted with the page (browsers keep audio locked until then); silent if Web Audio is missing.
 */

let ctx: AudioContext | null = null;
let noise: AudioBuffer | null = null;

function audio(): AudioContext | null {
    if (ctx) return ctx;
    const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!Ctor) return null;
    try {
        ctx = new Ctor();
        const len = Math.floor(ctx.sampleRate * 0.6);
        noise = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = noise.getChannelData(0);
        // a fixed pseudo-random sequence (no Math.random in anything the game does)
        let seed = 12345;
        for (let i = 0; i < len; i++) {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            d[i] = (seed / 0x3fffffff - 1) * 0.8;
        }
    } catch {
        ctx = null;
    }
    return ctx;
}

/** Master volume 0..1 (the game's sound effects level, when it has one). */
export let jointVolume = 0.5;
export function setJointVolume(v: number): void {
    jointVolume = Math.max(0, Math.min(1, v));
}

function burst(a: AudioContext, start: number, dur: number, f0: number, f1: number, q: number, gain: number): void {
    if (!noise) return;
    const src = a.createBufferSource();
    src.buffer = noise;
    const bp = a.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = q;
    bp.frequency.setValueAtTime(f0, start);
    bp.frequency.exponentialRampToValueAtTime(f1, start + dur);
    const g = a.createGain();
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(gain * jointVolume, start + Math.min(0.02, dur / 4));
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    src.connect(bp).connect(g).connect(a.destination);
    src.start(start, 0, dur + 0.05);
}

/** A creak (strain), a lower longer groan (close to breaking), or a crack (it broke). */
export function playJoint(kind: 'creak' | 'groan' | 'break'): void {
    const a = audio();
    if (!a || jointVolume <= 0) return;
    if (a.state === 'suspended') void a.resume().catch(() => undefined);
    const t = a.currentTime + 0.01;
    if (kind === 'creak') {
        // a few stick-slip chirps of wood on wood
        for (let i = 0; i < 4; i++) burst(a, t + i * 0.07, 0.09, 700 + i * 60, 480, 18, 0.35);
    } else if (kind === 'groan') {
        burst(a, t, 0.6, 260, 140, 12, 0.5);
        burst(a, t + 0.15, 0.35, 520, 300, 14, 0.25);
    } else {
        burst(a, t, 0.05, 3000, 1200, 2, 0.9);
        burst(a, t + 0.02, 0.25, 400, 90, 3, 0.7);
        const o = a.createOscillator();
        const g = a.createGain();
        o.frequency.setValueAtTime(110, t);
        o.frequency.exponentialRampToValueAtTime(45, t + 0.3);
        g.gain.setValueAtTime(0.6 * jointVolume, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
        o.connect(g).connect(a.destination);
        o.start(t);
        o.stop(t + 0.4);
    }
}
