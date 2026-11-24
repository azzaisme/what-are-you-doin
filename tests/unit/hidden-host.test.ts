/**
 * A host whose page is hidden for minutes (#103). Browsers throttle a hidden page's timers (after 5
 * minutes, chained timers run about once a minute) and draw it no frames, so its simulation and its
 * sends stop. What happens to its guests then depends on the transport's own timeout:
 *
 * - peer to peer (itch.io): Trystero drops a peer only when its WebRTC connection fails or closes;
 *   the browser keeps that connection alive itself, timers or not. Our channel has no timeout of its
 *   own, so guests keep waiting, however long the host is away. If the connection does close (the
 *   browser discards the tab, the network drops), guests hear "reconnecting", then leave after 20 s.
 * - local test transport (BroadcastChannel, ?net=local): a heartbeat every second, peers forgotten
 *   after 10 s of silence; a page that says it is hidden is kept for 10 minutes instead.
 *
 * Trystero is replaced here by an in-memory stand-in with its room API (makeAction, onPeerJoin,
 * onPeerLeave, leave), so the p2p channel runs unchanged on fake timers.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { timberYardLevel } from '../../src/levels/timber-yard.ts';
import { GuestSession, HOST_GRACE_MS, HostSession, listGames } from '../../src/net/session.ts';
import { HIDDEN_PEER_TIMEOUT_MS, PEER_TIMEOUT_MS, localTransport } from '../../src/net/transport.ts';
import { neutralCommand } from '../../src/sim/commands.ts';
import { LabSim } from '../../src/sim/lab-sim.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';

const fake = vi.hoisted(() => {
    type Handler = (data: unknown, ctx: { peerId: string }) => void;
    class FakeRoom {
        static rooms = new Set<FakeRoom>();
        readonly actions = new Map<string, { onMessage: Handler | null }>();
        onPeerJoin: (id: string) => void = () => undefined;
        onPeerLeave: (id: string) => void = () => undefined;
        constructor(
            readonly name: string,
            readonly id: string
        ) {
            const others = [...FakeRoom.rooms].filter((r) => r.name === name);
            FakeRoom.rooms.add(this);
            // the library announces peers once their connection is up (after joinRoom returns)
            queueMicrotask(() => {
                for (const o of others) {
                    o.onPeerJoin(id);
                    this.onPeerJoin(o.id);
                }
            });
        }
        makeAction(n: string) {
            const a = {
                onMessage: null as Handler | null,
                send: async (data: unknown, opts?: { target?: string }) => {
                    for (const r of FakeRoom.rooms) {
                        if (r === this || r.name !== this.name || (opts?.target && opts.target !== r.id)) continue;
                        r.actions.get(n)?.onMessage?.(JSON.parse(JSON.stringify(data)), { peerId: this.id });
                    }
                }
            };
            this.actions.set(n, a);
            return a;
        }
        getPeers() {
            return Object.fromEntries(
                [...FakeRoom.rooms].filter((r) => r !== this && r.name === this.name).map((r) => [r.id, {}])
            );
        }
        /** The WebRTC connection between this page and the others closed (the tab was discarded). */
        async leave() {
            FakeRoom.rooms.delete(this);
            for (const r of FakeRoom.rooms) if (r.name === this.name) r.onPeerLeave(this.id);
        }
    }
    return { FakeRoom, me: 'nobody' };
});

vi.mock('trystero/nostr', () => ({
    get selfId() {
        return fake.me;
    },
    joinRoom: (_config: unknown, name: string) => new fake.FakeRoom(name, fake.me),
    getRelaySockets: () => ({})
}));

const { p2pTransport } = await import('../../src/net/p2p.ts');

beforeAll(() => initPhysics());

const flush = () => new Promise<void>((r) => setImmediate(r));

describe('a host hidden for minutes, peer to peer (the itch.io transport)', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] });
        fake.FakeRoom.rooms.clear();
    });
    afterEach(() => vi.useRealTimers());

    it('keeps the guest in the game however long the host sends nothing; a closed connection ends it after 20 s', async () => {
        const host = new LabSim({ level: timberYardLevel });
        host.step(neutralCommand(0));
        host.fpActive = true;
        fake.me = 'host';
        const hostNet = p2pTransport({ relays: ['wss://relay.test'] });
        const hs = await HostSession.start(hostNet, host, 'yard', 'hide');
        fake.me = 'guest';
        const guestNet = p2pTransport({ relays: ['wss://relay.test'] });
        await flush();
        await vi.advanceTimersByTimeAsync(100);
        const ad = listGames(guestNet.lobby).find((g) => g.code === 'hide')!;
        expect(ad).toBeDefined();
        fake.me = 'guest';
        const gs = await GuestSession.join(guestNet, new LabSim({ level: timberYardLevel }), ad, {
            now: () => Date.now()
        });
        await flush();
        for (let n = 0; n < 30; n++) {
            host.step(neutralCommand(n));
            hs.afterStep((s) => host.interactionIds(s));
            await vi.advanceTimersByTimeAsync(17);
        }
        expect(gs.slot).toBe(1);
        expect(gs.received).toBeGreaterThan(0);
        // the host's page is hidden: it says so, then stops stepping and sending (no frames, timers
        // throttled to a minute at best). Fifteen minutes pass.
        hs.setAway(true);
        await vi.advanceTimersByTimeAsync(100);
        expect(gs.hostAway).toBe(true);
        const received = gs.received;
        await vi.advanceTimersByTimeAsync(15 * 60_000);
        expect(gs.received).toBe(received); // nothing came: everything waited
        expect(gs.reconnecting).toBe(false);
        expect(gs.hostGone).toBe(false);
        expect(gs.slot).toBe(1);
        // the browser discards the hidden tab: its WebRTC connections close
        for (const r of [...fake.FakeRoom.rooms]) if (r.id === 'host') await r.leave();
        expect(gs.reconnecting).toBe(true);
        expect(gs.hostGone).toBe(false);
        await vi.advanceTimersByTimeAsync(HOST_GRACE_MS + 100);
        expect(gs.hostGone).toBe(true);
    });
});

describe('a host hidden for minutes, local test transport (BroadcastChannel)', () => {
    afterEach(() => {
        vi.useRealTimers();
        delete (globalThis as { document?: unknown }).document;
    });

    it('forgets a silent visible page after 10 s, but keeps one that said it is hidden for 10 minutes', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] });
        const listen = localTransport().lobby;
        // a page that is visible, then goes quiet (crashed without a goodbye)
        const quiet = localTransport().lobby;
        quiet.setState({ hi: 1 });
        await vi.advanceTimersByTimeAsync(50);
        await flush();
        expect(listen.peers().some((p) => p.id === quiet.me)).toBe(true);
        (quiet as unknown as { timer: ReturnType<typeof setInterval> }).timer &&
            clearInterval((quiet as unknown as { timer: ReturnType<typeof setInterval> }).timer);
        (quiet as unknown as { bc: BroadcastChannel }).bc.close();
        await vi.advanceTimersByTimeAsync(PEER_TIMEOUT_MS + 2000);
        expect(listen.peers().some((p) => p.id === quiet.me)).toBe(false);
        // a page that is hidden: it says so, then its throttled timers send nothing for 9 minutes
        (globalThis as { document?: unknown }).document = {
            visibilityState: 'hidden',
            addEventListener: () => undefined,
            removeEventListener: () => undefined
        };
        const hidden = localTransport().lobby;
        hidden.setState({ hi: 2 });
        await vi.advanceTimersByTimeAsync(50);
        await flush();
        expect(listen.peers().some((p) => p.id === hidden.me)).toBe(true);
        clearInterval((hidden as unknown as { timer: ReturnType<typeof setInterval> }).timer);
        (hidden as unknown as { bc: BroadcastChannel }).bc.close();
        await vi.advanceTimersByTimeAsync(9 * 60_000);
        expect(listen.peers().some((p) => p.id === hidden.me)).toBe(true);
        await vi.advanceTimersByTimeAsync(HIDDEN_PEER_TIMEOUT_MS - 9 * 60_000 + 2000);
        expect(listen.peers().some((p) => p.id === hidden.me)).toBe(false);
        listen.leave();
    });
});
