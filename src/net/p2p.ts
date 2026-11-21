/**
 * Peer-to-peer transport for builds outside claude.ai (itch.io): WebRTC data channels between the
 * players' browsers, set up through public Nostr relays (Trystero). No server of ours. The relays
 * only carry the connection handshake; game state goes browser to browser.
 *
 * Same presence semantics as the other transports: each participant keeps one small JSON state
 * current, everyone in the room sees everyone's latest state, and it disappears when they leave.
 * Everything received is untrusted input from another device.
 *
 * Loaded with a dynamic import, so the claude.ai build (which uses the room) does not carry it.
 */

import { joinRoom, selfId } from 'trystero/nostr';
import type { JoinRoomConfig, JsonValue, MessageAction, Room } from 'trystero/nostr';

import type { NetChannel, NetPeer, NetState, NetTransport } from './transport.ts';

/** Separates this game's rooms from every other Trystero app on the same relays. */
const APP_ID = 'uncivil-engineers.v1';
/** A state larger than this is dropped (the room capability allows 4 KiB). */
const MAX_STATE_BYTES = 16 * 1024;
/** Coalesce state sends to ~30 Hz, like the room's presence. */
const SEND_INTERVAL_MS = 33;

export interface P2POptions {
    /** Relay URLs (wss://… or ws://… for tests); the library's public list when omitted. */
    relays?: string[];
    /** No STUN servers: local candidates only (tests on one machine with no internet). */
    localOnly?: boolean;
}

class P2PChannel implements NetChannel {
    readonly me = selfId;
    private state: NetState = {};
    private readonly others = new Map<string, NetState>();
    private readonly listeners = new Set<() => void>();
    private readonly room: Room;
    private readonly action: MessageAction<JsonValue>;
    private pending = false;
    private lastSent = 0;
    private left = false;

    constructor(config: JoinRoomConfig, name: string) {
        this.room = joinRoom(config, name);
        this.action = this.room.makeAction<JsonValue>('state');
        this.action.onMessage = (data, ctx) => {
            if (this.left || !isState(data)) return;
            this.others.set(ctx.peerId, data);
            this.emit();
        };
        // a newcomer gets our current state straight away
        this.room.onPeerJoin = (peerId) => {
            if (!this.left) this.action.send(this.state as JsonValue, { target: peerId }).catch(() => undefined);
        };
        this.room.onPeerLeave = (peerId) => {
            if (this.others.delete(peerId)) this.emit();
        };
        addEventListener('pagehide', () => this.leave());
    }

    private emit(): void {
        for (const l of this.listeners) l();
    }

    private send(): void {
        if (this.left) return;
        this.lastSent = Date.now();
        this.action.send(this.state as JsonValue).catch(() => undefined);
    }

    setState(patch: NetState): void {
        const next = { ...this.state };
        for (const [k, v] of Object.entries(patch)) {
            if (v === null) delete next[k];
            else next[k] = v;
        }
        this.state = next;
        this.emit();
        if (this.pending) return;
        const wait = Math.max(0, SEND_INTERVAL_MS - (Date.now() - this.lastSent));
        this.pending = true;
        setTimeout(() => {
            this.pending = false;
            this.send();
        }, wait);
    }

    peers(): NetPeer[] {
        const out: NetPeer[] = [{ id: this.me, state: this.state, isMe: true }];
        for (const [id, state] of this.others) out.push({ id, state, isMe: false });
        return out;
    }

    /** Peers with an open connection (some may not have sent a state yet). */
    connected(): number {
        return Object.keys(this.room.getPeers()).length;
    }

    onChange(cb: () => void): () => void {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    leave(): void {
        if (this.left) return;
        this.left = true;
        this.listeners.clear();
        this.others.clear();
        this.room.leave().catch(() => undefined);
    }
}

function isState(v: unknown): v is NetState {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    try {
        return JSON.stringify(v).length <= MAX_STATE_BYTES;
    } catch {
        return false;
    }
}

export interface P2PTransport extends NetTransport {
    /** Players connected in the lobby right now (not counting this one). */
    lobbyPeers(): number;
}

export function p2pTransport(opts: P2POptions = {}): P2PTransport {
    const config: JoinRoomConfig = { appId: APP_ID, maxReceiveBytes: MAX_STATE_BYTES * 2 };
    if (opts.relays?.length) config.relayConfig = { urls: opts.relays, redundancy: opts.relays.length };
    if (opts.localOnly) config.rtcConfig = { iceServers: [] };
    const lobby = new P2PChannel(config, 'lobby');
    return {
        kind: 'p2p',
        lobby,
        lobbyPeers: () => lobby.connected(),
        async join(name: string) {
            return new P2PChannel(config, `room-${name}`);
        }
    };
}
