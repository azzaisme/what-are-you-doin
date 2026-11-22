/**
 * Online play under bad networks, with eight players, garbage input and drops (#92, #93, #94):
 * the in-memory transport wrapped in the latency / jitter / loss shim on a virtual clock.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { timberYardLevel } from '../../src/levels/timber-yard.ts';
import { VirtualClock, degradedTransport, parseConditions } from '../../src/net/netsim.ts';
import type { NetConditions } from '../../src/net/netsim.ts';
import { GuestSession, HOST_GRACE_MS, HostSession, NET_PROTOCOL } from '../../src/net/session.ts';
import type { GameAd } from '../../src/net/session.ts';
import { MemoryHub } from '../../src/net/transport.ts';
import type { NetTransport } from '../../src/net/transport.ts';
import { ACTION_DROP_TEST, ACTION_RESET_PROPS, neutralCommand } from '../../src/sim/commands.ts';
import type { PlayerCommand } from '../../src/sim/commands.ts';
import { EYE_HEIGHT, LabSim, MAX_PLAYERS } from '../../src/sim/lab-sim.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';

beforeAll(() => initPhysics());

const cmd = (n: number, c: Partial<PlayerCommand> = {}): PlayerCommand => ({ ...neutralCommand(n), ...c });
const TICK_MS = 1000 / 60;
/** Bad home internet: 100-300 ms one way, 10 % of updates lost. */
const BAD: NetConditions = { latencyMs: 100, jitterMs: 200, loss: 0.1 };

/** A host and its world, with guests that join over a (possibly degraded) in-memory network. */
class Game {
    readonly hub = new MemoryHub();
    readonly clock = new VirtualClock();
    readonly sim = new LabSim({ level: timberYardLevel });
    hs!: HostSession;
    readonly inputs = new Map<GuestSession, PlayerCommand>();
    hostCmd: PlayerCommand = cmd(0);
    n = 0;
    /** Real time per host tick: more than 1/60 s is a host falling behind (a slow page). */
    msPerTick = TICK_MS;
    private seed = 1;

    constructor(readonly cond: NetConditions | null) {}

    net(id: string): NetTransport {
        const t = this.hub.transport(id);
        return this.cond ? degradedTransport(t, { ...this.cond, seed: this.seed++ }, this.clock) : t;
    }

    async start(): Promise<this> {
        this.sim.step(cmd(0));
        this.sim.fpActive = true;
        this.hs = await HostSession.start(this.net('host'), this.sim, 'yard', 'abcd', () => this.clock.now());
        return this;
    }

    get ad(): GameAd {
        return { code: 'abcd', level: 'yard', host: 'host', players: 1, max: MAX_PLAYERS, v: NET_PROTOCOL };
    }

    async join(id: string, token?: string): Promise<GuestSession> {
        const g = await GuestSession.join(this.net(id), new LabSim({ level: timberYardLevel }), this.ad, {
            now: () => this.clock.now(),
            token
        });
        this.inputs.set(g, cmd(0));
        return g;
    }

    /** One host tick: guests send, the host steps and publishes, the network moves on 1/60 s. */
    tick(): void {
        for (const [g, c] of this.inputs) g.sendInput({ ...c, seq: this.n });
        const c: (PlayerCommand | undefined)[] = [];
        for (let s = 1; s < MAX_PLAYERS; s++) c[s] = this.hs.commandFor(s);
        this.sim.step({ ...this.hostCmd, seq: this.n }, c[1], c.slice(2));
        // edge-triggered requests are one tick long
        this.hostCmd = { ...this.hostCmd, grab: false, jump: false, throw: false, action: 0 };
        this.hs.afterStep((s) => this.sim.interactionIds(s));
        this.clock.advance(this.msPerTick);
        this.n++;
    }

    run(ticks: number, each?: (k: number) => void): void {
        for (let k = 0; k < ticks; k++) {
            each?.(k);
            this.tick();
        }
    }

    /** Ticks until a condition holds (or fails after `max`). */
    until(ok: () => boolean, max = 600): number {
        for (let k = 0; k < max; k++) {
            if (ok()) return k;
            this.tick();
        }
        throw new Error('condition never held');
    }
}

/** Look from player i's eye at a point. */
function aim(s: LabSim, i: number, x: number, y: number, z: number): { yaw: number; pitch: number } {
    const p = s.players[i];
    const dx = x - p.x;
    const dz = z - p.z;
    return { yaw: Math.atan2(-dx, -dz), pitch: -Math.atan2(p.y + EYE_HEIGHT - y, Math.hypot(dx, dz)) };
}

describe('network conditions shim', () => {
    it('parses ?netsim and keeps one sender in order, losing some updates but never the last state', () => {
        expect(parseConditions('200,100,0.1')).toEqual({ latencyMs: 200, jitterMs: 100, loss: 0.1 });
        expect(parseConditions('x')).toBeNull();
        expect(parseConditions(null)).toBeNull();
        const hub = new MemoryHub();
        const clock = new VirtualClock();
        const a = degradedTransport(hub.transport('a'), { ...BAD, loss: 0.3, seed: 7 }, clock).lobby;
        const b = hub.channel('lobby', 'b');
        const seen: number[] = [];
        b.onChange(() => {
            const v = b.peers().find((p) => p.id === 'a')?.state.v;
            if (typeof v === 'number' && v !== seen[seen.length - 1]) seen.push(v);
        });
        for (let v = 1; v <= 200; v++) {
            a.setState({ v });
            clock.advance(TICK_MS);
        }
        expect(seen.length).toBeLessThan(200); // some were lost
        expect(seen.length).toBeGreaterThan(80);
        expect([...seen].sort((x, y) => x - y)).toEqual(seen); // in order
        clock.advance(2000);
        expect(seen[seen.length - 1]).toBe(200); // the newest state got there
        expect(b.peers().find((p) => p.id === 'a')?.state.v).toBe(200);
        // nothing arrives sooner than the latency
        a.setState({ v: 201 });
        clock.advance(BAD.latencyMs - 1);
        expect(b.peers().find((p) => p.id === 'a')?.state.v).toBe(200);
    });
});

// several full worlds stepping at once: ~2 s here, more on a busy runner
describe('online play under 100-300 ms latency and 10 % loss', { timeout: 30_000 }, () => {
    it('a guest joins, walks, and every jump press lands exactly once', async () => {
        const g = await new Game(BAD).start();
        const gs = await g.join('guest');
        g.until(() => gs.slot === 1 && gs.received > 0);
        const start = { ...g.sim.players[1] };
        // a take-off is the vertical speed passing 2 m/s upwards (walking off a step is not one)
        let jumps = 0;
        let rising = false;
        // three jump presses, each a single frame, while walking
        g.inputs.set(gs, cmd(0, { moveZ: 1, yaw: Math.PI }));
        g.run(360, (k) => {
            g.inputs.set(gs, cmd(0, { moveZ: 1, yaw: Math.PI, jump: k === 20 || k === 140 || k === 260 }));
            const up = g.sim.players[1].vy > 2;
            if (up && !rising) jumps++;
            rising = up;
        });
        g.run(120);
        expect(g.sim.players[1].z - start.z).toBeGreaterThan(5);
        expect(jumps).toBe(3);
        // the guest sees itself through snapshots, and both sides know the round trip
        expect(gs.received).toBeGreaterThan(50);
        const lag = g.hs.lagMs(1)!;
        expect(lag).toBeGreaterThan(200);
        expect(lag).toBeLessThan(1000);
        expect(gs.lagMs).not.toBeNull();
        expect(Math.abs(gs.lagMs! - lag)).toBeLessThan(500);
    });

    it('measures the round trip in real time, even on a host falling behind (one tick per 50 ms)', async () => {
        const g = await new Game({ latencyMs: 150, jitterMs: 100, loss: 0.1 }).start();
        g.msPerTick = 50;
        const gs = await g.join('guest');
        g.until(() => gs.slot === 1 && gs.received > 0);
        g.run(120);
        const lag = g.hs.lagMs(1)!;
        // two one-way trips of 150-250 ms each
        expect(lag).toBeGreaterThanOrEqual(300);
        expect(lag).toBeLessThan(1200);
    });

    it('still measures a round trip of many seconds (a guest page too busy to answer quickly)', async () => {
        const g = await new Game({ latencyMs: 6000, jitterMs: 0, loss: 0 }).start();
        g.msPerTick = 100;
        const gs = await g.join('guest');
        g.until(() => gs.slot === 1 && gs.received > 0);
        g.run(200);
        expect(g.hs.lagMs(1)).toBeGreaterThanOrEqual(12_000);
        expect(g.hs.lagMs(1)).toBeLessThan(13_000);
        expect(gs.lagMs).not.toBeNull();
    });

    it('a host and a guest lift the 113 kg log together, and the guest can let go', async () => {
        const g = await new Game(BAD).start();
        const gs = await g.join('guest');
        g.until(() => gs.slot === 1);
        const s = g.sim;
        const log = s.log;
        const { x: lx, y: ly, z: lz } = log.pose.p;
        for (const e of s.extras) {
            const d = Math.hypot(e.pose.p.x - lx, e.pose.p.z - lz);
            if (e.visible && e.pose.p.y > ly + 0.2 && d < 1) s.physics.setEnabled(e.id, false);
        }
        s.placePlayer(lx - 0.9, lz + 2.3, 0, 0);
        s.placePlayer(lx - 0.9, lz - 2.3, Math.PI, 1);
        g.run(10);
        const a = aim(s, 0, lx, ly, lz + 0.75);
        const b = aim(s, 1, lx, ly, lz - 0.75);
        g.hostCmd = cmd(0, { ...a, grab: true });
        g.inputs.set(gs, cmd(0, { ...b }));
        g.run(40); // the guest's look arrives
        g.inputs.set(gs, cmd(0, { ...b, grab: true }));
        g.tick();
        g.inputs.set(gs, cmd(0, { ...b }));
        g.until(() => s.physics.holders(log.id) === 2);
        const lift = (i: number) =>
            Math.asin(
                Math.max(-1, Math.min(1, (ly + 1.16 - (s.players[i].y + EYE_HEIGHT)) / s.physics.rig(i)!.holdDist))
            );
        g.hostCmd = cmd(0, { yaw: a.yaw, pitch: lift(0) });
        g.inputs.set(gs, cmd(0, { yaw: b.yaw, pitch: lift(1) }));
        g.run(200);
        expect(s.physics.holders(log.id)).toBe(2);
        expect(log.pose.p.y).toBeGreaterThan(ly + 0.4);
        // one press lets go, even if updates are lost on the way
        g.inputs.set(gs, cmd(0, { yaw: b.yaw, pitch: lift(1), grab: true }));
        g.tick();
        g.inputs.set(gs, cmd(0, { yaw: b.yaw, pitch: lift(1) }));
        g.until(() => s.physics.holders(log.id) === 1);
        g.run(120);
        expect(s.physics.heldIdOf(1)).toBe(-1);
    });

    it('refuses garbage and forbidden requests from a guest; the world stays finite', async () => {
        const g = await new Game(BAD).start();
        const evil = await g.net('evil').join('ue-abcd');
        const send = (input: unknown, extra: Record<string, unknown> = {}) =>
            evil.setState({ role: 'guest', v: NET_PROTOCOL, in: input, ...extra });
        send(
            {
                mx: 1e9,
                mz: NaN,
                y: Infinity,
                p: 1e30,
                sp: 'yes',
                j: 1e300,
                g: -5,
                t: 'x',
                a: ACTION_RESET_PROPS,
                an: 1
            },
            {
                rj: '../../../etc',
                ak: 'soon'
            }
        );
        g.until(() => g.hs.slots.has('evil'));
        const slot = g.hs.slots.get('evil')!;
        const garbage: unknown[] = [
            'garbage',
            [1, 2, 3],
            null,
            { mx: -1e9, mz: 1e9, y: -1e308, p: 7, a: ACTION_DROP_TEST, an: 2 },
            { mx: 0.5, a: ACTION_RESET_PROPS, an: 3, j: 2, g: 4 },
            { mx: 1, mz: 1, y: 1, p: -9, a: 9999, an: 4, j: -1 }
        ];
        const ticks = g.sim.tick;
        for (let k = 0; k < 240; k++) {
            if (k % 40 === 0) send(garbage[(k / 40) % garbage.length], { ak: -1e9 });
            g.tick();
        }
        const p = g.sim.players[slot];
        for (const v of [p.x, p.y, p.z, p.yaw, p.pitch]) expect(Number.isFinite(v)).toBe(true);
        expect(Math.abs(p.pitch)).toBeLessThan(Math.PI / 2 + 1e-6);
        // no reset or drop test ran: the tick count went on and the world was not reset
        expect(g.sim.tick).toBe(ticks + 240);
        expect(g.sim.progress.goalReached).toBe(false);
        for (const e of g.sim.entities) expect(Number.isFinite(e.pose.p.x + e.pose.p.y + e.pose.p.z)).toBe(true);
        // lag is unknown, not negative or huge, from a nonsense echo
        expect(g.hs.lagMs(slot)).toBeNull();
    });
});

describe('reconnect', { timeout: 30_000 }, () => {
    it('a dropped guest keeps their player for a while and gets it back with their token', async () => {
        const g = await new Game(BAD).start();
        const a = await g.join('guest-a', 'tokenaaaa1');
        const b = await g.join('guest-b', 'tokenbbbb2');
        g.until(() => a.slot > 0 && b.slot > 0);
        const slotA = a.slot;
        g.inputs.set(a, cmd(0, { moveX: 1 }));
        g.run(60);
        g.inputs.set(a, cmd(0));
        g.run(30);
        const where = { x: g.sim.players[slotA].x, z: g.sim.players[slotA].z };
        const events: string[] = [];
        g.hs.onGuestsChanged = (joined, left, dropped, back) =>
            events.push(
                ...joined.map((s) => `joined ${s}`),
                ...left.map((s) => `left ${s}`),
                ...dropped.map((s) => `dropped ${s}`),
                ...back.map((s) => `back ${s}`)
            );
        // the tab closes (or its network drops)
        g.inputs.delete(a);
        a.leave();
        g.run(30);
        expect(events).toEqual([`dropped ${slotA}`]);
        expect(g.sim.isSlotActive(slotA)).toBe(true);
        expect(g.hs.droppedSlots()).toEqual([slotA]);
        // someone new arrives meanwhile: they do not get the held player
        const c = await g.join('guest-c', 'tokencccc3');
        g.until(() => c.slot > 0);
        expect(c.slot).not.toBe(slotA);
        // a stranger reusing a connected guest's token gets no one else's player
        const copy = await g.join('guest-copy', 'tokenbbbb2');
        g.run(300);
        expect(copy.slot).toBe(-1); // waits: b might be a page that just reloaded
        g.until(() => copy.slot > 0, 900);
        expect(copy.slot).not.toBe(b.slot);
        expect(copy.slot).not.toBe(slotA);
        // newcomers appear clear of everyone, the held player included
        for (const s of [c.slot, copy.slot])
            expect(Math.hypot(g.sim.players[s].x - where.x, g.sim.players[s].z - where.z)).toBeGreaterThan(0.9);
        // the guest comes back after a reload (a new peer id, the same token): same player, same place
        g.run(600);
        const again = await g.join('guest-a2', 'tokenaaaa1');
        g.until(() => again.slot > 0);
        expect(again.slot).toBe(slotA);
        expect(events).toContain(`back ${slotA}`);
        expect(Math.hypot(g.sim.players[slotA].x - where.x, g.sim.players[slotA].z - where.z)).toBeLessThan(0.3);
        expect(g.hs.droppedSlots()).toEqual([]);
        // and plays on
        g.inputs.set(again, cmd(0, { moveZ: 1 }));
        g.run(90);
        expect(g.sim.players[slotA].z).toBeLessThan(where.z - 1);
    });

    it('a reloaded page that arrives before its old one has gone gets its player back', async () => {
        const g = await new Game(BAD).start();
        const old = await g.join('guest-old', 'tokenaaaa1');
        g.until(() => old.slot > 0);
        const slot = old.slot;
        // the new page is in the room while the host still sees the old one (a missed goodbye)
        const fresh = await g.join('guest-new', 'tokenaaaa1');
        g.run(120);
        expect(fresh.slot).toBe(-1);
        g.inputs.delete(old);
        old.leave();
        g.until(() => fresh.slot > 0);
        expect(fresh.slot).toBe(slot);
        expect(g.hs.droppedSlots()).toEqual([]);
    });

    it('a dropped player lets go of what they carried (the bucket); past the grace period their slot frees', async () => {
        const g = await new Game(null).start();
        const a = await g.join('guest-a', 'tokenaaaa1');
        g.until(() => a.slot === 1);
        const s = g.sim;
        const plank = s.bucket;
        expect(plank.visible).toBe(true);
        s.placePlayer(plank.pose.p.x, plank.pose.p.z + 1.4, 0, 1);
        g.run(5);
        const look = aim(s, 1, plank.pose.p.x, plank.pose.p.y, plank.pose.p.z);
        g.inputs.set(a, cmd(0, { ...look }));
        g.run(5);
        g.inputs.set(a, cmd(0, { ...look, grab: true }));
        g.tick();
        g.inputs.set(a, cmd(0, { ...look }));
        g.until(() => s.physics.heldIdOf(1) === plank.id);
        g.inputs.delete(a);
        a.leave();
        g.tick();
        g.tick();
        expect(s.physics.heldIdOf(1)).toBe(-1);
        expect(s.isSlotActive(1)).toBe(true);
        const left: number[] = [];
        g.hs.onGuestsChanged = (_j, l) => left.push(...l);
        g.hs.rejoinGraceTicks = 300;
        g.run(310);
        expect(left).toEqual([1]);
        expect(s.isSlotActive(1)).toBe(false);
        // too late: back as a new player in the first free slot
        const again = await g.join('guest-a2', 'tokenaaaa1');
        g.until(() => again.slot > 0);
        expect(again.slot).toBe(1);
    });

    it('a guest waits for a host that went quiet, and leaves at once when the host ends the game', async () => {
        const g = await new Game(null).start();
        const gs = await g.join('guest');
        g.until(() => gs.received > 0);
        // the host's connection drops: its peer disappears from the room, then comes back
        const hostCh = (g.hs as unknown as { ch: { leave(): void } }).ch;
        hostCh.leave();
        g.run(60);
        expect(gs.reconnecting).toBe(true);
        expect(gs.hostGone).toBe(false);
        g.clock.advance(HOST_GRACE_MS + 100);
        expect(gs.hostGone).toBe(true);

        const g2 = await new Game(null).start();
        const gs2 = await g2.join('guest');
        g2.until(() => gs2.received > 0);
        g2.hs.stop();
        expect(gs2.hostGone).toBe(true);
    });
});

describe('eight players', { timeout: 30_000 }, () => {
    it('seven guests and the host play at once; the host state stays well inside presence limits', async () => {
        const g = await new Game(BAD).start();
        const guests: GuestSession[] = [];
        for (let i = 0; i < MAX_PLAYERS - 1; i++) guests.push(await g.join(`guest-${i}`, `token${i}xxxxx`));
        g.until(() => guests.every((x) => x.slot > 0 && x.received > 0));
        expect(new Set(guests.map((x) => x.slot)).size).toBe(MAX_PLAYERS - 1);
        expect(g.sim.playerCount).toBe(MAX_PLAYERS);
        // everyone walks forward together, the way player 1 faces
        const start = g.sim.players.map((p) => ({ x: p.x, z: p.z }));
        const yaw = timberYardLevel.spawn.yaw;
        for (const x of guests) g.inputs.set(x, cmd(0, { moveZ: 1, yaw }));
        g.hostCmd = cmd(0, { moveZ: 1, yaw });
        g.run(180);
        for (let s = 0; s < MAX_PLAYERS; s++)
            expect(Math.hypot(g.sim.players[s].x - start[s].x, g.sim.players[s].z - start[s].z)).toBeGreaterThan(2);
        // what the host publishes: the room capability allows 4 KiB per participant
        const hostState = g.hub
            .channel('room-ue-abcd', 'probe')
            .peers()
            .find((p) => p.id === 'host')!.state;
        const bytes = JSON.stringify(hostState).length;
        expect(bytes).toBeLessThan(4096);
        // one more is told the game is full and watches
        const late = await g.join('late', 'tokenlatexxx');
        g.run(60);
        expect(late.slot).toBe(-1);
        expect(late.received).toBeGreaterThan(0);
    });
});
