/**
 * The host's state stays inside the room's 4 KiB however much moves (NET_PROTOCOL 3): snapshots list
 * what moved lately and refresh the rest in turn, within what the rest of the state leaves. Measured
 * here: the worst case (every entity visible and moving, long events, eight players, stand-ins for
 * the entities coming next), normal play, how long any entity waits under that load, that a guest
 * which missed updates or joined late still ends up with every pose, the protocol version check and
 * the time the host spends encoding.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { timberYardLevel } from '../../src/levels/timber-yard.ts';
import { valleyLevel } from '../../src/levels/valley.ts';
import type { EncodableEntity } from '../../src/net/codec.ts';
import {
    REFRESH_SNAPSHOTS,
    SnapshotDecoder,
    SnapshotEncoder,
    encodeSnapshot,
    fromBase64Chunks,
    toBase64Chunks
} from '../../src/net/codec.ts';
import { GuestSession, HostSession, NET_PROTOCOL, PRESENCE_LIMIT, layoutHash } from '../../src/net/session.ts';
import { MemoryHub } from '../../src/net/transport.ts';
import { neutralCommand } from '../../src/sim/commands.ts';
import type { SimEntity } from '../../src/sim/lab-entities.ts';
import { LabSim, MAX_PLAYERS } from '../../src/sim/lab-sim.ts';
import { ANIM_MAX, SnapshotRing } from '../../src/sim/snapshots.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { pose } from '../../src/voxels/math.ts';

beforeAll(() => initPhysics());

/** The entity indices a snapshot lists. */
function listed(bytes: Uint8Array): number[] {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = dv.getUint16(5, true);
    let o = 7 + Math.ceil(n / 8);
    const count = dv.getUint16(o, true);
    o += 2;
    const out: number[] = [];
    for (let c = 0; c < count; c++) {
        out.push(dv.getUint16(o, true));
        const flags = dv.getUint8(o + 2);
        o += 15;
        if (flags & 4) o += 1 + 2 * dv.getUint8(o);
    }
    return out;
}

const hostState = (hub: MemoryHub, room: string) =>
    hub
        .channel(room, 'probe')
        .peers()
        .find((p) => p.id === 'host')!.state;

/**
 * The Valley with eight players and stand-ins for entities still to come (a goose with every
 * animation channel, a long plank and a road closure's two pieces), hosted.
 */
async function valleyHost(extra = true) {
    const hub = new MemoryHub();
    const sim = new LabSim({ level: valleyLevel });
    if (extra) {
        const animated = sim.entities.find((e) => e.asset.animChannels >= 4)!;
        const plain = sim.entities.find((e) => e.asset.animChannels === 0)!;
        const add = (src: SimEntity, channels: number) =>
            (sim.entities as SimEntity[]).push({
                ...src,
                id: 9000 + sim.entities.length,
                slot: sim.entities.length,
                asset: { ...src.asset, animChannels: channels },
                anim: new Float64Array(ANIM_MAX)
            });
        add(animated, ANIM_MAX); // the goose
        add(plain, 0);
        add(plain, 0);
        add(plain, 0);
    }
    sim.step(neutralCommand(0));
    sim.fpActive = true;
    const hs = await HostSession.start(hub.transport('host'), sim, 'valley', 'size');
    for (let i = 1; i < MAX_PLAYERS; i++) sim.setSlotActive(i, true);
    return { hub, sim, hs };
}

/** Every entity visible and moving (on the wire: a few mm and every animation channel). */
function allMoving(sim: LabSim, k: number): void {
    for (const e of sim.entities) {
        e.visible = true;
        e.pose.p.x += k % 2 ? 0.01 : -0.01;
        for (let c = 0; c < ANIM_MAX; c++) e.anim[c] = (k * 0.37 + c) % 5;
    }
}

describe('host state size (NET_PROTOCOL 3)', { timeout: 60_000 }, () => {
    it('stays inside 4 KiB with every entity visible and moving, long events and eight players; no entity waits more than 2 snapshots', async () => {
        const { hub, sim, hs } = await valleyHost();
        let worst = 0;
        const lastSeen = new Map<number, number>();
        let longestWait = 0;
        let snaps = 0;
        for (let k = 0; k < 300; k++) {
            sim.step(neutralCommand(k));
            allMoving(sim, k);
            sim.events.push({ tick: sim.tick, kind: 'info', text: 'x'.repeat(200) });
            hs.afterStep((s) => ({ ...sim.interactionIds(s), held: 999, target: 999, shared: true, seat: 1 }));
            if (sim.tick % 3 !== 0) continue;
            snaps++;
            const st = hostState(hub, 'room-ue-size');
            worst = Math.max(worst, JSON.stringify(st).length);
            for (const i of listed(fromBase64Chunks(st.s as string[]))) {
                if (snaps > 2) longestWait = Math.max(longestWait, snaps - (lastSeen.get(i) ?? 0));
                lastSeen.set(i, snaps);
            }
        }
        // after the first snapshots, every entity was listed, and none waited long
        expect(lastSeen.size).toBe(sim.entities.length);
        for (const [, at] of lastSeen) expect(snaps - at).toBeLessThanOrEqual(2);
        console.info(
            `worst case, all ${sim.entities.length} entities moving: ${worst} bytes; longest wait ${longestWait} snapshots`
        );
        expect(worst).toBeLessThanOrEqual(PRESENCE_LIMIT);
        expect(longestWait).toBeLessThanOrEqual(2);
    });

    it('normal play (the Valley, eight players walking) is far under it', async () => {
        const { hub, sim, hs } = await valleyHost(false);
        const sizes: number[] = [];
        for (let t = 1; t <= 900; t++) {
            sim.step({ ...neutralCommand(t), moveZ: 1, yaw: t / 60 });
            hs.afterStep((s) => sim.interactionIds(s));
            if (t > 300 && t % 3 === 0) sizes.push(JSON.stringify(hostState(hub, 'room-ue-size')).length);
        }
        sizes.sort((a, b) => a - b);
        console.info(`normal play: median ${sizes[sizes.length >> 1]} bytes, most ${sizes[sizes.length - 1]}`);
        expect(sizes[sizes.length - 1]).toBeLessThan(1200);
    });

    it('encoding takes the host well under a millisecond per snapshot (all entities moving)', async () => {
        const { sim } = await valleyHost();
        const enc = new SnapshotEncoder();
        const times: number[] = [];
        for (let k = 0; k < 600; k++) {
            allMoving(sim, k);
            const t0 = performance.now();
            enc.encode(k * 3, sim.entities, 2900, (i) => i);
            times.push(performance.now() - t0);
        }
        times.sort((a, b) => a - b);
        const mean = times.reduce((a, b) => a + b, 0) / times.length;
        console.info(
            `encode, ${sim.entities.length} entities: mean ${(mean * 1000).toFixed(0)} µs, 99th percentile ${(times[Math.floor(times.length * 0.99)] * 1000).toFixed(0)} µs`
        );
        expect(mean).toBeLessThan(1);
    });
});

/** A few entities on their own (no sim): `n` boxes and one animated. */
function boxes(n: number): EncodableEntity[] {
    return Array.from({ length: n }, (_, i) => ({
        pose: pose(),
        anim: new Float64Array(ANIM_MAX),
        visible: true,
        asset: { animChannels: i === 0 ? 3 : 0 }
    }));
}

/** Where the guest draws entity i at tick t (null: hidden). */
function drawn(ring: SnapshotRing, i: number, t: number) {
    const p = pose();
    return ring.sample(i, t * (1 / 60), p, new Float64Array(ANIM_MAX)) ? p.p : null;
}

describe('a guest that misses updates, or joins late, still gets every pose', () => {
    it('an entity that stops while updates are lost ends where the host has it', () => {
        for (const lost of [
            [25, 45], // the stop falls inside the gap; the last moves are listed again after it
            [25, 70] // the gap outlasts that: the refresh brings it within a second
        ]) {
            const es = boxes(30);
            const enc = new SnapshotEncoder();
            const dec = new SnapshotDecoder(es.length);
            const ring = new SnapshotRing(es.length);
            let last = 0;
            for (let n = 1; n <= lost[1] + REFRESH_SNAPSHOTS + 2; n++) {
                if (n <= 30) es[7].pose.p.x = n * 0.1; // moves, then rests at 3 m
                const bytes = enc.encode(n * 3, es);
                if (n >= lost[0] && n <= lost[1]) continue;
                dec.apply(bytes, ring);
                last = n * 3;
            }
            expect(drawn(ring, 7, last)!.x, `lost ${lost.join('-')}`).toBeCloseTo(3, 2);
        }
    });

    it('a guest joining late draws every visible entity within a second, and nothing before its pose arrives', () => {
        const es = boxes(40);
        es.forEach((e, i) => (e.pose.p.z = i));
        es[5].visible = false;
        const enc = new SnapshotEncoder();
        for (let n = 1; n <= 100; n++) enc.encode(n * 3, es);
        const dec = new SnapshotDecoder(es.length);
        const ring = new SnapshotRing(es.length);
        // the first snapshot it sees lists only what moved lately (nothing) and the refresh's share
        dec.apply(enc.encode(101 * 3, es), ring);
        const first = es.map((_, i) => drawn(ring, i, 101 * 3) !== null).filter(Boolean).length;
        expect(first).toBeLessThan(10);
        for (let n = 102; n < 101 + REFRESH_SNAPSHOTS; n++) dec.apply(enc.encode(n * 3, es), ring);
        const t = (100 + REFRESH_SNAPSHOTS) * 3;
        for (let i = 0; i < es.length; i++) {
            const p = drawn(ring, i, t);
            if (i === 5) expect(p).toBeNull();
            else expect(p?.z, `entity ${i}`).toBeCloseTo(i, 2);
        }
    });

    it('a snapshot within budget lists the stalest entities first and defers the rest', () => {
        const es = boxes(30);
        const enc = new SnapshotEncoder();
        const full = encodeSnapshot(3, es).length;
        const small = enc.encode(3, es, full / 2);
        expect(small.length).toBeLessThanOrEqual(full / 2);
        expect(enc.deferred).toBeGreaterThan(0);
        // the next one lists those left out first (as many as fit), then the third the rest
        const first = new Set(listed(small));
        const missed = es.map((_, i) => i).filter((i) => !first.has(i));
        es.forEach((e) => (e.pose.p.y += 1));
        const next = listed(enc.encode(6, es, full / 2));
        expect(next.length).toBeGreaterThan(0);
        for (const i of next) expect(missed).toContain(i);
        es.forEach((e) => (e.pose.p.y += 1));
        const third = new Set(listed(enc.encode(9, es, full / 2)));
        for (const i of missed.filter((i) => !next.includes(i))) expect(third.has(i)).toBe(true);
    });
});

describe('protocol version 3 against 2', () => {
    it("a guest of this version facing a version 2 host says it's another version, and applies nothing", async () => {
        const hub = new MemoryHub();
        const sim = new LabSim({ level: timberYardLevel });
        const host = await hub.transport('host').join('ue-oldv');
        // a version 2 host: same world, its snapshots in the old layout (version byte 2)
        const old = encodeSnapshot(30, sim.entities);
        old[0] = 2;
        host.setState({ role: 'host', v: 2, layout: layoutHash(sim.entities), level: 'yard', slots: {} });
        const g = await GuestSession.join(hub.transport('guest'), sim, {
            code: 'oldv',
            level: 'yard',
            host: 'host',
            players: 1,
            max: MAX_PLAYERS,
            v: 2
        });
        host.setState({ s: toBase64Chunks(old), hud: [] });
        expect(g.incompatible).toBe(true);
        expect(g.received).toBe(0);
        expect(NET_PROTOCOL).toBe(3);
        // and the decoder alone refuses the old layout instead of drawing garbage
        const dec = new SnapshotDecoder(sim.entities.length);
        expect(dec.apply(old, new SnapshotRing(sim.entities.length))).toBe(false);
    });
});
