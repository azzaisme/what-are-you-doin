/**
 * A transport shim that makes a network worse on purpose (design doc §6.3): every state update a
 * participant sends arrives late (latency plus jitter) or not at all (loss). It wraps any
 * NetTransport, so the same sessions run over it as over the real thing.
 *
 * Presence layers deliver the latest state reliably and in order; a lost packet there shows up as
 * a late or skipped intermediate state, never as a final state that never arrives. The shim does the
 * same: a dropped update is gone, but a heartbeat resends the current state, so the newest state
 * always lands eventually. Updates from one sender keep their order.
 *
 * Used by unit tests (with a virtual clock) and in the browser with `?netsim=latency,jitter,loss`,
 * e.g. `?net=local&netsim=200,100,0.1` for 200-300 ms one way and 10 % loss.
 */

import type { NetChannel, NetPeer, NetState, NetTransport } from './transport.ts';

export interface NetConditions {
    /** Minimum one-way delay, ms. */
    latencyMs: number;
    /** Extra random delay on top, 0..jitterMs. */
    jitterMs: number;
    /** Chance (0..1) that an update is lost. */
    loss: number;
    /** Resend the current state this often when the last update may not have arrived (ms). */
    heartbeatMs?: number;
    seed?: number;
}

export interface Scheduler {
    now(): number;
    setTimeout(fn: () => void, ms: number): void;
}

export const realScheduler: Scheduler = {
    now: () => performance.now(),
    setTimeout: (fn, ms) => void setTimeout(fn, ms)
};

/** A clock for tests: time moves only when `advance` is called; due timers run in time order. */
export class VirtualClock implements Scheduler {
    private t = 0;
    private seq = 0;
    private queue: { at: number; seq: number; fn: () => void }[] = [];

    now(): number {
        return this.t;
    }

    setTimeout(fn: () => void, ms: number): void {
        this.queue.push({ at: this.t + Math.max(0, ms), seq: this.seq++, fn });
    }

    advance(ms: number): void {
        const end = this.t + ms;
        for (;;) {
            let next = -1;
            for (let i = 0; i < this.queue.length; i++) {
                const q = this.queue[i];
                if (q.at > end) continue;
                if (
                    next < 0 ||
                    q.at < this.queue[next].at ||
                    (q.at === this.queue[next].at && q.seq < this.queue[next].seq)
                )
                    next = i;
            }
            if (next < 0) break;
            const [job] = this.queue.splice(next, 1);
            this.t = Math.max(this.t, job.at);
            job.fn();
        }
        this.t = end;
    }
}

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Parses `latency,jitter,loss` (ms, ms, 0..1); null when absent or malformed. */
export function parseConditions(s: string | null): NetConditions | null {
    if (!s) return null;
    const [l, j, p] = s.split(',').map(Number);
    if (![l, j ?? 0, p ?? 0].every(Number.isFinite)) return null;
    return {
        latencyMs: Math.max(0, Math.min(5000, l)),
        jitterMs: Math.max(0, Math.min(5000, j ?? 0)),
        loss: Math.max(0, Math.min(0.9, p ?? 0))
    };
}

class DegradedChannel implements NetChannel {
    readonly me: string;
    private readonly inner: NetChannel;
    private readonly cond: NetConditions;
    private readonly random: () => number;
    private readonly sched: Scheduler;
    private state: NetState = {};
    /** JSON of the last state that was put on the wire (it may still be lost). */
    private lastSent = '{}';
    /** Delivery time of the newest update in flight (keeps one sender's updates in order). */
    private lastAt = 0;
    private left = false;
    /** Updates sent and lost (for tests and the debug panel). */
    sent = 0;
    lost = 0;

    constructor(inner: NetChannel, cond: NetConditions, random: () => number, sched: Scheduler) {
        this.inner = inner;
        this.me = inner.me;
        this.cond = cond;
        this.random = random;
        this.sched = sched;
        this.heartbeat();
    }

    private heartbeat(): void {
        if (this.left) return;
        if (JSON.stringify(this.state) !== this.lastSent) this.transmit();
        this.sched.setTimeout(() => this.heartbeat(), this.cond.heartbeatMs ?? 250);
    }

    private transmit(): void {
        const json = JSON.stringify(this.state);
        this.lastSent = json;
        this.sent++;
        if (this.random() < this.cond.loss) {
            this.lost++;
            return;
        }
        const now = this.sched.now();
        const at = Math.max(now + this.cond.latencyMs + this.random() * this.cond.jitterMs, this.lastAt);
        this.lastAt = at;
        this.sched.setTimeout(() => this.deliver(JSON.parse(json) as NetState), at - now);
    }

    private deliver(next: NetState): void {
        if (this.left) return;
        const cur = this.inner.peers().find((p) => p.isMe)?.state ?? {};
        const patch: NetState = { ...next };
        for (const k of Object.keys(cur)) if (!(k in next)) patch[k] = null;
        this.inner.setState(patch);
    }

    setState(patch: NetState): void {
        const next = { ...this.state };
        for (const [k, v] of Object.entries(patch)) {
            if (v === null) delete next[k];
            else next[k] = v;
        }
        this.state = next;
        this.transmit();
    }

    peers(): NetPeer[] {
        // others as they arrived; our own state as we set it
        return this.inner.peers().map((p) => (p.isMe ? { ...p, state: this.state } : p));
    }

    onChange(cb: () => void): () => void {
        return this.inner.onChange(cb);
    }

    leave(): void {
        this.left = true;
        this.inner.leave();
    }
}

/** Wraps a transport so everything this participant sends is delayed and sometimes lost. */
export function degradedTransport(
    inner: NetTransport,
    cond: NetConditions,
    sched: Scheduler = realScheduler
): NetTransport {
    const random = rng(cond.seed ?? 1);
    return {
        kind: inner.kind,
        lobby: new DegradedChannel(inner.lobby, cond, random, sched),
        async join(name: string) {
            return new DegradedChannel(await inner.join(name), cond, random, sched);
        }
    };
}
