/**
 * Network transports. The game only needs "presence": each participant keeps one small JSON state
 * object current; everyone in the same room sees everyone's latest state; it disappears when they
 * leave. Two implementations:
 *
 * - RoomTransport: the claude.ai artifact `room` capability (presence, coalesced ~30 Hz, 4 KiB per
 *   participant, named rooms per game). No server of ours.
 * - LocalTransport: BroadcastChannel between tabs of one browser (development and browser tests;
 *   `?net=local`), with the same semantics.
 * - MemoryHub: in-process (unit tests).
 *
 * Everything received is untrusted input from another device.
 */

export type NetState = Record<string, unknown>;

export interface NetPeer {
    /** Stable for the life of that page; the same label in the lobby and in every named room. */
    id: string;
    state: NetState;
    isMe: boolean;
}

export interface NetChannel {
    readonly me: string;
    /** Merges a patch into this participant's state (top-level fields; null removes one). */
    setState(patch: NetState): void;
    peers(): NetPeer[];
    onChange(cb: () => void): () => void;
    leave(): void;
}

export interface NetTransport {
    readonly kind: 'room' | 'local' | 'memory';
    /** The shared lobby everyone with the page open is in (games are advertised here). */
    readonly lobby: NetChannel;
    join(name: string): Promise<NetChannel>;
}

// ------------------------------------------------------------------------------------- room

interface RoomPeer {
    peer: string;
    isMe: boolean;
    sameTab: boolean;
    presence: Readonly<Record<string, unknown>>;
}
interface RoomLike {
    presence(patch: Record<string, unknown>): Promise<void>;
    peers(): readonly RoomPeer[];
    onPeers(handler: (c: unknown) => void, onError?: (e: { code: string }) => void): () => void;
    leave?: () => Promise<void>;
}
interface RoomApi extends RoomLike {
    join(name: string): Promise<RoomLike>;
}

class RoomChannel implements NetChannel {
    me = '';
    private readonly room: RoomLike;
    private readonly listeners = new Set<() => void>();
    private readonly unsub: () => void;

    constructor(room: RoomLike) {
        this.room = room;
        this.unsub = room.onPeers(
            () => {
                const mine = room.peers().find((p) => p.isMe && p.sameTab);
                if (mine) this.me = mine.peer;
                for (const l of this.listeners) l();
            },
            () => undefined
        );
    }

    setState(patch: NetState): void {
        this.room.presence(patch).catch(() => undefined);
    }

    peers(): NetPeer[] {
        return this.room.peers().map((p) => ({ id: p.peer, state: p.presence as NetState, isMe: p.isMe && p.sameTab }));
    }

    onChange(cb: () => void): () => void {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    leave(): void {
        this.unsub();
        this.listeners.clear();
        this.room.leave?.().catch(() => undefined);
    }
}

/** The artifact room, or null when this page is not in a claude.ai viewer that grants it. */
export async function roomTransport(): Promise<NetTransport | null> {
    const claude = (globalThis as unknown as { claude?: { use?: (n: string) => Promise<unknown> } }).claude;
    if (!claude?.use) return null;
    let room: RoomApi | null = null;
    try {
        room = (await claude.use('room')) as RoomApi | null;
    } catch {
        room = null;
    }
    if (!room) return null;
    const api = room;
    return {
        kind: 'room',
        lobby: new RoomChannel(api),
        async join(name: string) {
            return new RoomChannel(await api.join(name));
        }
    };
}

// ------------------------------------------------------------------------------------- local

const PEER_TIMEOUT_MS = 10_000;

type LocalMsg = { t: 'state'; id: string; state: NetState } | { t: 'bye'; id: string } | { t: 'hello'; id: string };

class LocalChannel implements NetChannel {
    readonly me: string;
    private state: NetState = {};
    private readonly others = new Map<string, { state: NetState; seen: number }>();
    private readonly listeners = new Set<() => void>();
    private readonly bc: BroadcastChannel;
    private pending = false;
    private lastSent = 0;
    private readonly timer: ReturnType<typeof setInterval>;

    constructor(name: string, me: string) {
        this.me = me;
        this.bc = new BroadcastChannel(`ue-net-${name}`);
        this.bc.onmessage = (e: MessageEvent<LocalMsg>) => this.receive(e.data);
        this.bc.postMessage({ t: 'hello', id: me } satisfies LocalMsg);
        // heartbeat, and forget peers that went quiet (a closed tab may not say bye). Generous: a
        // tab busy rendering (software GL in tests: 2 s frames) must not be mistaken for gone.
        this.timer = setInterval(() => {
            this.send();
            const now = Date.now();
            let changed = false;
            for (const [id, p] of this.others) {
                if (now - p.seen > PEER_TIMEOUT_MS) {
                    this.others.delete(id);
                    changed = true;
                }
            }
            if (changed) this.emit();
        }, 1000);
        addEventListener('pagehide', () => this.leave());
    }

    private receive(m: LocalMsg): void {
        if (!m || typeof m !== 'object' || m.id === this.me) return;
        if (m.t === 'bye') {
            if (this.others.delete(m.id)) this.emit();
            return;
        }
        if (m.t === 'hello') {
            this.send();
            return;
        }
        if (m.t === 'state' && m.state && typeof m.state === 'object') {
            this.others.set(m.id, { state: m.state, seen: Date.now() });
            this.emit();
        }
    }

    private emit(): void {
        for (const l of this.listeners) l();
    }

    private send(): void {
        this.lastSent = Date.now();
        this.bc.postMessage({ t: 'state', id: this.me, state: this.state } satisfies LocalMsg);
    }

    setState(patch: NetState): void {
        const next = { ...this.state };
        for (const [k, v] of Object.entries(patch)) {
            if (v === null) delete next[k];
            else next[k] = v;
        }
        this.state = next;
        this.emit();
        // coalesce to ~30 Hz like the platform's presence
        if (this.pending) return;
        const wait = Math.max(0, 33 - (Date.now() - this.lastSent));
        this.pending = true;
        setTimeout(() => {
            this.pending = false;
            this.send();
        }, wait);
    }

    peers(): NetPeer[] {
        const out: NetPeer[] = [{ id: this.me, state: this.state, isMe: true }];
        for (const [id, p] of this.others) out.push({ id, state: p.state, isMe: false });
        return out;
    }

    onChange(cb: () => void): () => void {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    leave(): void {
        clearInterval(this.timer);
        try {
            this.bc.postMessage({ t: 'bye', id: this.me } satisfies LocalMsg);
            this.bc.close();
        } catch {
            // already closed
        }
        this.listeners.clear();
    }
}

export function localTransport(): NetTransport {
    const me = Math.random().toString(36).slice(2, 10);
    return {
        kind: 'local',
        lobby: new LocalChannel('lobby', me),
        async join(name: string) {
            return new LocalChannel(`room-${name}`, me);
        }
    };
}

// ------------------------------------------------------------------------------------- memory

/** In-process presence hub for unit tests: synchronous delivery, explicit `flush` not needed. */
export class MemoryHub {
    private readonly rooms = new Map<string, Map<string, { state: NetState; listeners: Set<() => void> }>>();

    transport(me: string): NetTransport {
        return { kind: 'memory', lobby: this.channel('lobby', me), join: async (name) => this.channel(`room-${name}`, me) };
    }

    channel(room: string, me: string): NetChannel {
        let r = this.rooms.get(room);
        if (!r) {
            r = new Map();
            this.rooms.set(room, r);
        }
        const members = r;
        members.set(me, { state: {}, listeners: new Set() });
        const notify = () => {
            for (const m of members.values()) for (const l of m.listeners) l();
        };
        return {
            me,
            setState(patch) {
                const m = members.get(me);
                if (!m) return;
                const next = { ...m.state };
                for (const [k, v] of Object.entries(patch)) {
                    if (v === null) delete next[k];
                    else next[k] = JSON.parse(JSON.stringify(v)) as unknown;
                }
                m.state = next;
                notify();
            },
            peers: () => [...members.entries()].map(([id, m]) => ({ id, state: m.state, isMe: id === me })),
            onChange(cb) {
                members.get(me)?.listeners.add(cb);
                return () => members.get(me)?.listeners.delete(cb);
            },
            leave() {
                members.delete(me);
                notify();
            }
        };
    }
}
