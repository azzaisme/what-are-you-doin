/**
 * The bookkeeping behind `sfx.hold` (engine-free, so it is tested on its own): a loop per key that
 * sounds while a feature keeps calling `hold` (every frame), fades out once the calls stop for
 * HOLD_FADE.letGoMs, and when silent is stopped, its emitter destroyed and its entry removed.
 *
 * GameAudio owns the emitters: `create` makes one (a looping sound already playing at volume 0,
 * positional or heard everywhere), `destroy` gets rid of it, and `update` returns the volume and
 * pitch to give each live one.
 */

export const HOLD_FADE = {
    /** No `hold` call for this long (ms): the loop is let go and fades out. */
    letGoMs: 250,
    /** Below this gain a fading loop is stopped and removed. */
    silent: 0.005
} as const;

interface Held<E> {
    e: E;
    name: string;
    gain: number;
    target: number;
    pitch: number;
    last: number;
}

export class HeldLoops<E> {
    private readonly map = new Map<string, Held<E>>();
    private readonly create: (key: string, name: string, positional: boolean) => E;
    private readonly destroy: (e: E) => void;

    constructor(create: (key: string, name: string, positional: boolean) => E, destroy: (e: E) => void) {
        this.create = create;
        this.destroy = destroy;
    }

    /** Holds `key`'s loop on (or starts it, or swaps its sound): returns its emitter, to place. */
    hold(key: string, name: string, positional: boolean, gain: number, pitch: number, now: number): E {
        let h = this.map.get(key);
        if (!h || h.name !== name) {
            if (h) this.destroy(h.e);
            h = { e: this.create(key, name, positional), name, gain: 0, target: 0, pitch: 1, last: now };
            this.map.set(key, h);
        }
        h.target = Math.max(0, Math.min(1.5, gain));
        h.pitch = Math.max(0.3, Math.min(3, pitch));
        h.last = now;
        return h.e;
    }

    /**
     * One frame: each loop eases towards its gain (or towards silence, let go), at rate `k` per
     * frame (0..1). Returns the live ones with what to set; the silent let-go ones are gone.
     */
    update(now: number, k: number): { e: E; name: string; volume: number; pitch: number }[] {
        const out: { e: E; name: string; volume: number; pitch: number }[] = [];
        for (const [key, h] of this.map) {
            const target = now - h.last > HOLD_FADE.letGoMs ? 0 : h.target;
            h.gain += (target - h.gain) * Math.max(0, Math.min(1, k));
            if (target === 0 && h.gain < HOLD_FADE.silent) {
                this.destroy(h.e);
                this.map.delete(key);
                continue;
            }
            out.push({ e: h.e, name: h.name, volume: h.gain, pitch: h.pitch });
        }
        return out;
    }

    has(key: string): boolean {
        return this.map.has(key);
    }

    get size(): number {
        return this.map.size;
    }

    /** The loop's current gain (0 when there is none). */
    gainOf(key: string): number {
        return this.map.get(key)?.gain ?? 0;
    }
}
