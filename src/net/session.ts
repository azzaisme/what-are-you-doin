/**
 * Online co-op over presence (design doc §6.2, Epic 3). One device hosts: it runs the only
 * simulation, owns physics, grabs and the level rules, and publishes snapshots. Guests run no
 * physics: they send their input and render the host's snapshots through the same interpolation
 * and voxel pipeline as everyone else. Commands stay plain sequenced data; the host validates every
 * number (sanitizeCommand) and lets guests request only safe actions.
 *
 * Input travels as absolute state with edge COUNTERS (jumps, grabs, throws, actions), so a
 * coalesced or dropped presence update never loses or repeats a press.
 */

import { SIM_HZ } from '../sim/clock.ts';
import { ACTION_DROP, ACTION_NONE, ACTION_RAGDOLL, neutralCommand } from '../sim/commands.ts';
import type { PlayerCommand } from '../sim/commands.ts';
import { packHazardNet, readHazardNet } from '../sim/hazards.ts';
import type { HazardNet } from '../sim/hazards.ts';
import type { LabSim } from '../sim/lab-sim.ts';

import { SnapshotDecoder, encodeSnapshot, fromBase64Chunks, snapshotTick, toBase64Chunks } from './codec.ts';
import type { NetChannel, NetPeer, NetTransport } from './transport.ts';

export const NET_PROTOCOL = 1;
/** The host publishes a snapshot every this many ticks (20 Hz). */
export const SNAPSHOT_EVERY = 3;
/** Guests render this many ticks behind the newest snapshot (150 ms) to ride out jitter. */
export const GUEST_DELAY_TICKS = 9;

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

export function listGames(lobby: NetChannel): (GameAd & { full: boolean })[] {
    const out: (GameAd & { full: boolean })[] = [];
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
        out.push({ ...ad, full: ad.players >= ad.max });
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
    private readonly unsub: () => void;
    private readonly levelId: string;
    private lastEventCount = 0;
    private recent: NetEvent[] = [];
    /** Bytes of the last snapshot (for the debug panel). */
    lastSnapshotBytes = 0;
    onGuestsChanged: (joined: number[], left: number[]) => void = () => undefined;

    private constructor(sim: LabSim, ch: NetChannel, lobby: NetChannel, code: string, levelId: string) {
        this.sim = sim;
        this.ch = ch;
        this.lobby = lobby;
        this.code = code;
        this.levelId = levelId;
        this.unsub = ch.onChange(() => this.reconcile());
        this.advertise();
    }

    static async start(transport: NetTransport, sim: LabSim, levelId: string, code = makeCode()): Promise<HostSession> {
        const ch = await transport.join(`ue-${code}`);
        ch.setState({ role: 'host', v: NET_PROTOCOL, level: levelId, slots: {} });
        return new HostSession(sim, ch, transport.lobby, code, levelId);
    }

    private advertise(): void {
        const ad: GameAd = {
            code: this.code,
            level: this.levelId,
            host: this.ch.me,
            players: this.sim.playerCount,
            max: 4,
            v: NET_PROTOCOL
        };
        this.lobby.setState({ game: ad });
    }

    /** Assigns free slots to new guests and frees the slots of guests who left. */
    private reconcile(): void {
        const guests = this.ch.peers().filter((p) => !p.isMe && p.state.role === 'guest' && p.state.v === NET_PROTOCOL);
        const ids = new Set(guests.map((g) => g.id));
        const joined: number[] = [];
        const left: number[] = [];
        for (const [id, slot] of this.slots) {
            if (ids.has(id)) continue;
            this.slots.delete(id);
            this.seen.delete(id);
            this.sim.setSlotActive(slot, false);
            left.push(slot);
        }
        for (const g of guests) {
            if (this.slots.has(g.id)) continue;
            const slot = this.sim.freeSlot();
            if (slot < 0) continue; // full: they stay watching
            this.slots.set(g.id, slot);
            this.seen.set(g.id, readInput(g.state.in) ?? emptyInput());
            this.sim.setSlotActive(slot, true);
            joined.push(slot);
        }
        if (joined.length || left.length) {
            this.ch.setState({ slots: Object.fromEntries(this.slots) });
            this.advertise();
            this.onGuestsChanged(joined, left);
        }
    }

    /** Slots driven by remote guests. */
    remoteSlots(): Set<number> {
        return new Set(this.slots.values());
    }

    /** The next command for a remote slot, from that guest's latest input; undefined if not remote. */
    commandFor(slot: number): PlayerCommand | undefined {
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
        if (sim.tick % SNAPSHOT_EVERY !== 0) return;
        const bytes = encodeSnapshot(sim.tick, sim.entities);
        this.lastSnapshotBytes = bytes.length;
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
            hz: packHazardNet(sim.hazards.net())
        });
    }

    get guestCount(): number {
        return this.slots.size;
    }

    stop(): void {
        this.unsub();
        for (const slot of this.slots.values()) this.sim.setSlotActive(slot, false);
        this.slots.clear();
        this.lobby.setState({ game: null });
        this.ch.leave();
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
    /** The host's hazards (water height, flood and gust phases). */
    hazard: HazardNet;
    hostGone = false;
    /** Snapshots applied (for the debug panel). */
    received = 0;
    private readonly now: () => number;

    private constructor(sim: LabSim, ch: NetChannel, code: string, hostId: string, now: () => number) {
        this.sim = sim;
        this.ch = ch;
        this.code = code;
        this.hostId = hostId;
        this.now = now;
        this.decoder = new SnapshotDecoder(sim.entities.length);
        this.hazard = readHazardNet(null, sim.level.water.y);
        sim.ring.clear();
        this.unsub = ch.onChange(() => this.receive());
        ch.setState({ role: 'guest', v: NET_PROTOCOL, in: this.input });
        this.receive();
    }

    static async join(
        transport: NetTransport,
        sim: LabSim,
        ad: GameAd,
        now: () => number = () => performance.now()
    ): Promise<GuestSession> {
        const ch = await transport.join(`ue-${ad.code}`);
        return new GuestSession(sim, ch, ad.code, ad.host, now);
    }

    private host(): NetPeer | undefined {
        return this.ch.peers().find((p) => p.id === this.hostId && p.state.role === 'host');
    }

    private receive(): void {
        const h = this.host();
        if (!h) {
            // the host may not have answered yet; only a host that was here and left is "gone"
            if (this.newestTick >= 0) this.hostGone = true;
            return;
        }
        const st = h.state;
        const slots = st.slots && typeof st.slots === 'object' ? (st.slots as Record<string, unknown>) : {};
        const mine = slots[this.ch.me];
        this.slot = typeof mine === 'number' && mine >= 1 && mine < this.sim.players.length ? mine : -1;
        this.goal = st.goal === true;
        this.step = num(st.step);
        this.hazard = readHazardNet(st.hz, this.sim.level.water.y);
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
