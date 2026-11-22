/**
 * Online co-op over presence (design doc §6.2, Epic 3). One device hosts: it runs the only
 * simulation, owns physics, grabs and the level rules, and publishes snapshots. Guests run no
 * physics: they send their input and render the host's snapshots through the same interpolation
 * and voxel pipeline as everyone else. Commands stay plain sequenced data; the host validates every
 * number (sanitizeCommand) and lets guests request only safe actions.
 *
 * Input travels as absolute state with edge COUNTERS (jumps, grabs, throws, actions), so a
 * coalesced or dropped presence update never loses or repeats a press.
 *
 * Reconnect (#93): each guest carries a rejoin token (kept per browser tab). When a guest drops, the
 * host keeps their player in the world for REJOIN_GRACE_TICKS, letting go of whatever they held; a
 * guest who comes back with the same token, under the same or a new peer id, gets that player back.
 * Only a dropped player can be reclaimed, never one whose guest is still connected. Guests wait
 * HOST_GRACE_MS for a host that went quiet before they give up on the game.
 *
 * Lag (observability): guests echo the newest snapshot tick they applied (`ak`); the host's clock
 * now minus when it published that snapshot is the round trip (wall time: a host falling behind
 * real time runs fewer ticks than the clock), which the host shows and sends back to each guest.
 */

import { SIM_HZ } from '../sim/clock.ts';
import { ACTION_DROP, ACTION_NONE, ACTION_RAGDOLL, neutralCommand } from '../sim/commands.ts';
import type { PlayerCommand } from '../sim/commands.ts';
import { packHazardNet, readHazardNet } from '../sim/hazards.ts';
import type { HazardNet } from '../sim/hazards.ts';
import { MAX_PLAYERS } from '../sim/lab-entities.ts';
import type { LabSim } from '../sim/lab-sim.ts';

import { SnapshotDecoder, encodeSnapshot, fromBase64Chunks, snapshotTick, toBase64Chunks } from './codec.ts';
import type { NetChannel, NetPeer, NetTransport } from './transport.ts';

/** Bump whenever host and guest builds stop understanding each other (2: eight player slots). */
export const NET_PROTOCOL = 2;
/** The host publishes a snapshot every this many ticks (20 Hz). */
export const SNAPSHOT_EVERY = 3;
/** Guests render this many ticks behind the newest snapshot (150 ms) to ride out jitter. */
export const GUEST_DELAY_TICKS = 9;
/** A dropped guest's player stays in the world this long for them to come back (60 s). */
export const REJOIN_GRACE_TICKS = 60 * SIM_HZ;
/**
 * A newcomer whose token is still in use by a connected guest waits this long for that guest to
 * drop (a reloaded page can arrive before the host notices the old one went) before it gets a
 * place of its own (a duplicated tab carries the same token, and never takes a live player).
 */
export const TOKEN_WAIT_TICKS = 10 * SIM_HZ;
/**
 * Round trips up to this long are measured (longer reads as unknown). Generous: a guest page busy
 * building its world (a phone, or software GL) can take seconds to apply and echo a snapshot.
 */
export const LAG_WINDOW_MS = 30_000;
/** A guest waits this long for a host that went quiet before leaving the game. */
export const HOST_GRACE_MS = 20_000;

/**
 * The world's entity layout (ids in snapshot order) as a short hash. Snapshots index entities by
 * position, so a host and guest whose builds list different entities would garble each other even
 * on the same protocol: the guest compares the host's layout with its own and refuses a mismatch.
 */
export function layoutHash(entities: readonly { id: number }[]): string {
    let h = 0x811c9dc5;
    for (const e of entities) {
        h ^= e.id & 0xffff;
        h = Math.imul(h, 0x01000193) >>> 0;
        h ^= e.id >>> 16;
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `${entities.length}-${h.toString(36)}`;
}

/** A rejoin token: a short random string, unique per browser tab. */
export function makeToken(): string {
    let s = '';
    for (let i = 0; i < 16; i++) s += Math.floor(Math.random() * 36).toString(36);
    return s;
}

const readToken = (v: unknown) => (typeof v === 'string' && /^[a-z0-9]{8,32}$/.test(v) ? v : null);

/** A game advertised in the lobby. */
export interface GameAd {
    code: string;
    level: string;
    host: string;
    players: number;
    max: number;
    v: number;
}

/** What a guest sends: absolute input plus edge counters. */
export interface GuestInput {
    mx: number;
    mz: number;
    sp: boolean;
    y: number;
    p: number;
    j: number;
    g: number;
    t: number;
    a: number;
    an: number;
}

export interface HudSlot {
    held: number;
    target: number;
    shared: boolean;
    /** In the ute's driver's seat. */
    driving: boolean;
    /** The ute seat this player sits in (0 driver, 1 passenger), or -1. */
    seat: number;
}

export interface NetEvent {
    n: number;
    kind: string;
    text: string;
}

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function makeCode(): string {
    const a = 'abcdefghjkmnpqrstuvwxyz23456789';
    let s = '';
    for (let i = 0; i < 4; i++) s += a[Math.floor(Math.random() * a.length)];
    return s;
}

/** A game in the lobby, as listed: full, and whether this build can join it (same protocol). */
export type ListedGame = GameAd & { full: boolean; compatible: boolean };

export function listGames(lobby: NetChannel): ListedGame[] {
    const out: ListedGame[] = [];
    for (const p of lobby.peers()) {
        if (p.isMe) continue;
        const g = p.state.game as Partial<GameAd> | undefined;
        if (!g || typeof g.code !== 'string' || !/^[a-z0-9]{4}$/.test(g.code)) continue;
        const ad: GameAd = {
            code: g.code,
            level: String(g.level ?? ''),
            host: p.id,
            players: num(g.players),
            max: num(g.max),
            v: num(g.v)
        };
        out.push({ ...ad, full: ad.players >= ad.max, compatible: ad.v === NET_PROTOCOL });
    }
    return out;
}

// ------------------------------------------------------------------------------------- host

export class HostSession {
    readonly code: string;
    private readonly sim: LabSim;
    private readonly ch: NetChannel;
    private readonly lobby: NetChannel;
    /** guest peer id -> player slot */
    readonly slots = new Map<string, number>();
    private readonly seen = new Map<string, GuestInput>();
    /** Players whose guest dropped, kept for a rejoin: slot -> token, when, released yet. */
    private readonly dropped = new Map<number, { token: string; tick: number; released: boolean }>();
    /** guest peer id -> rejoin token */
    private readonly tokens = new Map<string, string>();
    /** newcomer peer id -> tick it first showed a token a connected guest holds */
    private readonly waiting = new Map<string, number>();
    /** guest peer id -> newest snapshot tick that guest applied */
    private readonly acks = new Map<string, number>();
    /** snapshot tick -> when it was published (this.now() ms), for the last LAG_WINDOW_MS */
    private readonly sentAt = new Map<number, number>();
    private readonly now: () => number;
    private readonly unsub: () => void;
    private readonly levelId: string;
    private lastEventCount = 0;
    private recent: NetEvent[] = [];
    /** Bytes of the last snapshot (for the debug panel). */
    lastSnapshotBytes = 0;
    /** How long a dropped guest's player is kept (tests shorten it). */
    rejoinGraceTicks = REJOIN_GRACE_TICKS;
    /** Slots that got a new guest, slots freed, slots whose guest dropped (held for a rejoin), slots rejoined. */
    onGuestsChanged: (joined: number[], left: number[], dropped: number[], back: number[]) => void = () => undefined;

    private constructor(
        sim: LabSim,
        ch: NetChannel,
        lobby: NetChannel,
        code: string,
        levelId: string,
        now: () => number
    ) {
        this.sim = sim;
        this.now = now;
        this.ch = ch;
        this.lobby = lobby;
        this.code = code;
        this.levelId = levelId;
        this.unsub = ch.onChange(() => this.reconcile());
        this.advertise();
    }

    static async start(
        transport: NetTransport,
        sim: LabSim,
        levelId: string,
        code = makeCode(),
        now: () => number = () => performance.now()
    ): Promise<HostSession> {
        const ch = await transport.join(`ue-${code}`);
        ch.setState({ role: 'host', v: NET_PROTOCOL, layout: layoutHash(sim.entities), level: levelId, slots: {} });
        return new HostSession(sim, ch, transport.lobby, code, levelId, now);
    }

    private advertise(): void {
        const ad: GameAd = {
            code: this.code,
            level: this.levelId,
            host: this.ch.me,
            players: this.sim.playerCount,
            max: MAX_PLAYERS,
            v: NET_PROTOCOL
        };
        this.lobby.setState({ game: ad });
    }

    /**
     * Assigns slots to new guests (their own player back when they rejoin), holds the players of
     * guests who dropped, and frees the ones held past the grace period.
     */
    private reconcile(): void {
        const guests = this.ch.peers().filter((p) => !p.isMe && p.state.role === 'guest' && p.state.v === NET_PROTOCOL);
        const ids = new Set(guests.map((g) => g.id));
        const joined: number[] = [];
        const left: number[] = [];
        const dropped: number[] = [];
        const back: number[] = [];
        for (const g of guests) {
            const ak = g.state.ak;
            if (typeof ak === 'number' && Number.isInteger(ak) && ak >= 0) this.acks.set(g.id, ak);
        }
        for (const [id, slot] of this.slots) {
            if (ids.has(id)) continue;
            this.slots.delete(id);
            this.seen.delete(id);
            this.acks.delete(id);
            const token = this.tokens.get(id);
            this.tokens.delete(id);
            if (token) {
                this.dropped.set(slot, { token, tick: this.sim.tick, released: false });
                dropped.push(slot);
            } else {
                this.sim.setSlotActive(slot, false);
                left.push(slot);
            }
        }
        for (const id of this.waiting.keys()) if (!ids.has(id)) this.waiting.delete(id);
        const inUse = new Set(this.tokens.values());
        for (const g of guests) {
            if (this.slots.has(g.id)) continue;
            const token = readToken(g.state.rj);
            if (token && inUse.has(token)) {
                const since = this.waiting.get(g.id) ?? this.sim.tick;
                this.waiting.set(g.id, since);
                if (this.sim.tick - since < TOKEN_WAIT_TICKS) continue;
            }
            this.waiting.delete(g.id);
            let slot = -1;
            for (const [s, d] of this.dropped) {
                if (token && d.token === token) slot = s;
            }
            if (slot >= 0) {
                this.dropped.delete(slot);
                back.push(slot);
            } else {
                slot = this.sim.freeSlot();
                if (slot < 0) continue; // full: they stay watching
                this.sim.setSlotActive(slot, true);
                joined.push(slot);
            }
            this.slots.set(g.id, slot);
            // a second holder of a token (a duplicated tab) plays without one: it can't rejoin by it
            if (token && !inUse.has(token)) this.tokens.set(g.id, token);
            this.seen.set(g.id, readInput(g.state.in) ?? emptyInput());
        }
        this.expire(left);
        this.changed(joined, left, dropped, back);
    }

    /** Frees held players whose guest did not come back in time. */
    private expire(left: number[]): void {
        for (const [slot, d] of this.dropped) {
            if (this.sim.tick - d.tick < this.rejoinGraceTicks) continue;
            this.dropped.delete(slot);
            this.sim.setSlotActive(slot, false);
            left.push(slot);
        }
    }

    private changed(joined: number[], left: number[], dropped: number[], back: number[]): void {
        if (!joined.length && !left.length && !dropped.length && !back.length) return;
        this.ch.setState({ slots: Object.fromEntries(this.slots) });
        this.advertise();
        this.onGuestsChanged(joined, left, dropped, back);
    }

    /** Slots held for a guest who dropped. */
    droppedSlots(): number[] {
        return [...this.dropped.keys()];
    }

    /** Round trip to the guest playing a slot, ms (null when unknown). */
    lagMs(slot: number): number | null {
        for (const [id, s] of this.slots) {
            if (s !== slot) continue;
            const ak = this.acks.get(id);
            // an echo of a snapshot never sent (or sent over LAG_WINDOW_MS ago) is nonsense, or a stalled guest
            const at = ak === undefined ? undefined : this.sentAt.get(ak);
            return at === undefined ? null : Math.round(this.now() - at);
        }
        return null;
    }

    /** Slots driven by remote guests. */
    remoteSlots(): Set<number> {
        return new Set(this.slots.values());
    }

    /** The next command for a remote slot, from that guest's latest input; undefined if not remote. */
    commandFor(slot: number): PlayerCommand | undefined {
        const d = this.dropped.get(slot);
        if (d) {
            if (d.released) return undefined;
            // a dropped player lets go of what they held (a partner may be carrying it with them) and
            // gets out of the ute (grab does that; drop would send the ute back to its safe spot)
            d.released = true;
            const p = this.sim.players[slot];
            const seated = this.sim.seatOf(slot) >= 0;
            return { ...neutralCommand(0, p.yaw, p.pitch), grab: seated, action: seated ? ACTION_NONE : ACTION_DROP };
        }
        for (const [id, s] of this.slots) {
            if (s !== slot) continue;
            const peer = this.ch.peers().find((p) => p.id === id);
            const input = peer ? readInput(peer.state.in) : null;
            if (!input) return undefined;
            const prev = this.seen.get(id) ?? input;
            this.seen.set(id, input);
            // counters: an increase is one press since the last command (any number collapses to one)
            const cmd: PlayerCommand = {
                ...neutralCommand(0, input.y, input.p),
                moveX: input.mx,
                moveZ: input.mz,
                sprint: input.sp,
                jump: input.j > prev.j,
                grab: input.g > prev.g,
                throw: input.t > prev.t,
                // guests may only drop or launch the dummy (no scene resets or drop tests)
                action:
                    input.an > prev.an && (input.a === ACTION_DROP || input.a === ACTION_RAGDOLL)
                        ? input.a
                        : ACTION_NONE
            };
            return cmd;
        }
        return undefined;
    }

    /** Call after every simulation step: publishes a snapshot every SNAPSHOT_EVERY ticks. */
    afterStep(hud: (slot: number) => HudSlot): void {
        const sim = this.sim;
        while (this.lastEventCount < sim.events.length) {
            const e = sim.events[this.lastEventCount++];
            this.recent = [...this.recent, { n: this.lastEventCount, kind: e.kind, text: e.text.slice(0, 120) }].slice(
                -3
            );
        }
        if (sim.events.length < this.lastEventCount) this.lastEventCount = sim.events.length; // reset
        // held places expire and waiting newcomers time out without any network event
        if (this.dropped.size || this.waiting.size) this.reconcile();
        if (sim.tick % SNAPSHOT_EVERY !== 0) return;
        const bytes = encodeSnapshot(sim.tick, sim.entities);
        this.lastSnapshotBytes = bytes.length;
        const now = this.now();
        this.sentAt.set(sim.tick, now);
        for (const [t, at] of this.sentAt) if (now - at > LAG_WINDOW_MS || t > sim.tick) this.sentAt.delete(t);
        const huds: [number, number, number, number][] = [];
        for (let s = 0; s < sim.players.length; s++) {
            const h = hud(s);
            huds.push([h.held, h.target, h.shared ? 1 : 0, h.seat + 1]);
        }
        this.ch.setState({
            s: toBase64Chunks(bytes),
            hud: huds,
            goal: sim.progress.goalReached,
            step: sim.progress.step,
            ev: this.recent,
            hz: packHazardNet(sim.hazards.net()),
            seed: sim.hazards.seed,
            lag: Array.from({ length: sim.players.length }, (_, s) => this.lagMs(s) ?? -1)
        });
    }

    get guestCount(): number {
        return this.slots.size;
    }

    stop(): void {
        this.unsub();
        for (const slot of this.slots.values()) this.sim.setSlotActive(slot, false);
        for (const slot of this.dropped.keys()) this.sim.setSlotActive(slot, false);
        this.slots.clear();
        this.dropped.clear();
        this.lobby.setState({ game: null });
        // tell guests the game is over (so they leave now, not after waiting for a reconnect), then go
        this.ch.setState({ end: true });
        const ch = this.ch;
        setTimeout(() => ch.leave(), 300);
    }
}

function emptyInput(): GuestInput {
    return { mx: 0, mz: 0, sp: false, y: 0, p: 0, j: 0, g: 0, t: 0, a: 0, an: 0 };
}

/** Validates a guest's input object (untrusted). */
export function readInput(v: unknown): GuestInput | null {
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    return {
        mx: num(o.mx),
        mz: num(o.mz),
        sp: o.sp === true,
        y: num(o.y),
        p: num(o.p),
        j: num(o.j),
        g: num(o.g),
        t: num(o.t),
        a: num(o.a),
        an: num(o.an)
    };
}

// ------------------------------------------------------------------------------------- guest

export interface GuestOptions {
    /** Clock in ms (tests use a fake one). */
    now?: () => number;
    /** Rejoin token: the same token gets this guest's player back after a drop. */
    token?: string;
}

export class GuestSession {
    readonly code: string;
    readonly hostId: string;
    private readonly sim: LabSim;
    private readonly ch: NetChannel;
    private readonly decoder: SnapshotDecoder;
    private readonly unsub: () => void;
    private lastChunks = '';
    private input: GuestInput = emptyInput();
    /** Host tick minus local clock (in ticks), smoothed. */
    private offset: number | null = null;
    private newestTick = -1;
    /** This guest's player slot (-1 until the host assigns one, e.g. while the game is full). */
    slot = -1;
    hud: HudSlot[] = [];
    goal = false;
    /** The host's tutorial step. */
    step = 0;
    events: NetEvent[] = [];
    /** The host's hazards (water height, flood and gust phases) and the game's hazard seed. */
    hazard: HazardNet;
    hazardSeed = 0;
    /** Snapshots applied (for the debug panel). */
    received = 0;
    /** Round trip to the host as the host measured it, ms (null until known). */
    lagMs: number | null = null;
    /** When the host went missing (this.now() time), or null while it is here. */
    private lostAt: number | null = null;
    /** The host ended the game. */
    private ended = false;
    /** The host runs a build with another entity layout (see layoutHash): the game can't be played. */
    incompatible = false;
    private readonly layout: string;
    private readonly now: () => number;

    private constructor(sim: LabSim, ch: NetChannel, code: string, hostId: string, opts: GuestOptions) {
        this.sim = sim;
        this.ch = ch;
        this.code = code;
        this.hostId = hostId;
        this.now = opts.now ?? (() => performance.now());
        this.decoder = new SnapshotDecoder(sim.entities.length);
        this.hazard = readHazardNet(null, sim.level.water.y);
        this.layout = layoutHash(sim.entities);
        sim.ring.clear();
        this.unsub = ch.onChange(() => this.receive());
        const token = opts.token && readToken(opts.token);
        ch.setState({ role: 'guest', v: NET_PROTOCOL, in: this.input, ...(token ? { rj: token } : {}) });
        this.receive();
    }

    static async join(
        transport: NetTransport,
        sim: LabSim,
        ad: GameAd,
        opts: GuestOptions = {}
    ): Promise<GuestSession> {
        const ch = await transport.join(`ue-${ad.code}`);
        return new GuestSession(sim, ch, ad.code, ad.host, opts);
    }

    /** The host has been missing (after having been here) for a moment: waiting for it to come back. */
    get reconnecting(): boolean {
        return this.lostAt !== null;
    }

    /** The host has been missing for longer than HOST_GRACE_MS: the game is over for this guest. */
    get hostGone(): boolean {
        return this.ended || (this.lostAt !== null && this.now() - this.lostAt > HOST_GRACE_MS);
    }

    private host(): NetPeer | undefined {
        return this.ch.peers().find((p) => p.id === this.hostId && p.state.role === 'host');
    }

    private receive(): void {
        const h = this.host();
        if (!h) {
            // the host may not have answered yet; only a host that was here and left is missing
            if (this.newestTick >= 0 && this.lostAt === null) this.lostAt = this.now();
            return;
        }
        this.lostAt = null;
        const st = h.state;
        if (st.end === true) this.ended = true;
        // another build's world: its snapshots would land on the wrong entities, so apply none
        if (st.layout !== this.layout) {
            this.incompatible = true;
            return;
        }
        const slots = st.slots && typeof st.slots === 'object' ? (st.slots as Record<string, unknown>) : {};
        const mine = slots[this.ch.me];
        this.slot = typeof mine === 'number' && mine >= 1 && mine < this.sim.players.length ? mine : -1;
        this.goal = st.goal === true;
        this.step = num(st.step);
        this.hazard = readHazardNet(st.hz, this.sim.level.water.y);
        this.hazardSeed = num(st.seed) >>> 0;
        const lag = Array.isArray(st.lag) && this.slot >= 0 ? num((st.lag as unknown[])[this.slot], -1) : -1;
        this.lagMs = lag >= 0 ? lag : null;
        if (Array.isArray(st.hud)) {
            this.hud = (st.hud as unknown[]).map((x) => {
                const a = Array.isArray(x) ? x : [];
                const seat = num(a[3], 0) - 1;
                return {
                    held: num(a[0], -1),
                    target: num(a[1], -1),
                    shared: a[2] === 1,
                    driving: seat === 0,
                    seat: seat === 0 || seat === 1 ? seat : -1
                };
            });
        }
        if (Array.isArray(st.ev)) {
            this.events = (st.ev as unknown[])
                .map((e) => e as Partial<NetEvent>)
                .filter((e) => typeof e.n === 'number' && typeof e.text === 'string')
                .map((e) => ({ n: e.n!, kind: String(e.kind ?? 'info'), text: String(e.text).slice(0, 160) }));
        }
        const chunks = Array.isArray(st.s) ? (st.s as unknown[]).filter((c): c is string => typeof c === 'string') : [];
        const key = chunks.join('');
        if (!chunks.length || key === this.lastChunks) return;
        this.lastChunks = key;
        let bytes: Uint8Array;
        try {
            bytes = fromBase64Chunks(chunks);
        } catch {
            return;
        }
        const tick = snapshotTick(bytes);
        if (!this.decoder.apply(bytes, this.sim.ring)) return;
        this.received++;
        this.newestTick = tick;
        this.ch.setState({ ak: tick });
        // clock: the host's tick now is about (tick) at this arrival time
        const est = tick - (this.now() / 1000) * SIM_HZ;
        if (this.offset === null || est - this.offset > 6 || this.offset - est > 30) this.offset = est;
        else this.offset += (est - this.offset) * 0.08;
    }

    /** Simulation time to render (seconds), behind the newest snapshot by the interpolation delay. */
    renderTime(): number {
        if (this.offset === null || this.newestTick < 0) return 0;
        const hostNow = (this.now() / 1000) * SIM_HZ + this.offset;
        const t = Math.min(hostNow - GUEST_DELAY_TICKS, this.newestTick);
        return Math.max(0, t) / SIM_HZ;
    }

    /** Publishes this guest's input: absolute state, with presses counted. */
    sendInput(cmd: PlayerCommand): void {
        const i = this.input;
        const next: GuestInput = {
            mx: Math.round(cmd.moveX * 100) / 100,
            mz: Math.round(cmd.moveZ * 100) / 100,
            sp: cmd.sprint,
            y: Math.round(cmd.yaw * 1000) / 1000,
            p: Math.round(cmd.pitch * 1000) / 1000,
            j: i.j + (cmd.jump ? 1 : 0),
            g: i.g + (cmd.grab ? 1 : 0),
            t: i.t + (cmd.throw ? 1 : 0),
            a: cmd.action ? cmd.action : i.a,
            an: i.an + (cmd.action ? 1 : 0)
        };
        const changed = Object.keys(next).some((k) => next[k as keyof GuestInput] !== i[k as keyof GuestInput]);
        this.input = next;
        if (changed) this.ch.setState({ in: next });
    }

    leave(): void {
        this.unsub();
        this.ch.leave();
    }
}
