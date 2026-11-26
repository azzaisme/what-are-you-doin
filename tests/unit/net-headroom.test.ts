/**
 * The host's state stays inside the room's 4 KiB (UTF-8 bytes) however much moves (NET_PROTOCOL 3):
 * snapshots list what the guests playing haven't confirmed, within what the rest of the state leaves.
 * Measured here:
 * - the worst case: every entity visible and moving, the longest messages (emoji and typographic
 *   punctuation), 64 nails, every player aiming a nail, eight players, stand-ins for the entities to
 *   come;
 * - normal play, with guests that acknowledge;
 * - how long any entity waits under the worst case;
 * - that a guest which misses updates (any pattern, one in k for k = 2 to 40) or joins late still
 *   ends up with every pose, and right after the gap, not a refresh later;
 * - the protocol version check;
 * - the time the host spends encoding.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { timberYardLevel } from '../../src/levels/timber-yard.ts';
import { valleyLevel } from '../../src/levels/valley.ts';
import type { EncodableEntity } from '../../src/net/codec.ts';
import {
    SnapshotDecoder,
    SnapshotEncoder,
    encodeSnapshot,
    fromBase64Chunks,
    toBase64Chunks
} from '../../src/net/codec.ts';
import {
    GuestSession,
    HostSession,
    NET_PROTOCOL,
    PRESENCE_LIMIT,
    layoutHash,
    utf8Bytes
} from '../../src/net/session.ts';
import { MemoryHub } from '../../src/net/transport.ts';
import { neutralCommand } from '../../src/sim/commands.ts';
import type { SimEntity } from '../../src/sim/lab-entities.ts';
import { LabSim, MAX_PLAYERS } from '../../src/sim/lab-sim.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { ANIM_MAX, SnapshotRing } from '../../src/sim/snapshots.ts';
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

/** The longest message in the game, with emoji, an ellipsis and a typographic apostrophe. */
const LONG_MESSAGE =
    '🔧 Click… click… click… The ute’s handbrake is creeping off! Get in and hold the brake, or chock a downhill wheel.';

/**
 * The Valley with eight players (its real entities: the long plank of #134, the road closure's
 * barrier and sign of #131) and a stand-in for the goose still to come, with every animation
 * channel. Hosted, with seven guests seated and an eighth watching (the game is full), none of whom
 * acknowledges anything (every entity stays theirs to receive).
 */
async function valleyHost(extra = true) {
    const hub = new MemoryHub();
    const sim = new LabSim({ level: valleyLevel });
    if (extra) {
        const animated = sim.entities.find((e) => e.asset.animChannels >= 4)!;
        const add = (src: SimEntity, channels: number) =>
            (sim.entities as SimEntity[]).push({
                ...src,
                id: 9000 + sim.entities.length,
                slot: sim.entities.length,
                asset: { ...src.asset, animChannels: channels },
                anim: new Float64Array(ANIM_MAX)
            });
        add(animated, ANIM_MAX); // the goose
    }
    sim.step(neutralCommand(0));
    sim.fpActive = true;
    const hs = await HostSession.start(hub.transport('host'), sim, 'valley', 'size');
    // seven seated and an eighth watching (the game is full): none acknowledges anything
    for (let g = 1; g <= MAX_PLAYERS; g++) {
        const ch = await hub.transport(`guest-${g}`).join('ue-size');
        ch.setState({ role: 'guest', v: NET_PROTOCOL, in: {} });
    }
    return { hub, sim, hs };
}

/** 64 nails (the limit), four to a joint, between pairs of entities: the nail graph at its largest. */
function nailEverything(sim: LabSim): number {
    const ids = sim.entities.filter((e) => e.asset.animChannels === 0).map((e) => e.id);
    let nails = 0;
    for (let k = 0; k + 1 < ids.length && nails < 64; k += 2) {
        const v = (x: number) => ({ x, y: 0.03, z: -0.05 });
        const c = sim.joints.graph.add({
            a: ids[k],
            b: ids[k + 1],
            type: 'nail',
            anchorA: v(0),
            anchorB: v(0),
            rel: { x: 0, y: 0, z: 0, w: 1 },
            nails: [v(-0.31), v(-0.11), v(0.11), v(0.31)],
            stiffness: 1,
            tick: 0
        });
        if (c) nails += 4;
    }
    return nails;
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
    it('stays inside 4 KiB (UTF-8) with every entity moving, the longest messages, 64 nails, nail aims and eight players; no entity waits more than 2 snapshots', async () => {
        const { hub, sim, hs } = await valleyHost();
        const nails = nailEverything(sim);
        let worst = 0;
        let worstChars = 0;
        const lastSeen = new Map<number, number>();
        let longestWait = 0;
        let snaps = 0;
        let seated = 0;
        for (let k = 0; k < 300; k++) {
            sim.step(neutralCommand(k));
            allMoving(sim, k);
            sim.events.push({ tick: sim.tick, kind: 'hazard', text: LONG_MESSAGE });
            hs.afterStep(() => ({
                held: 999,
                target: 999,
                shared: true,
                driving: false,
                seat: 1,
                nail: 12,
                nailAt: { x: -123.45, y: 12.34, z: 123.45 }
            }));
            if (sim.tick % 3 !== 0) continue;
            snaps++;
            seated = hs.guestCount;
            const st = hostState(hub, 'room-ue-size');
            const json = JSON.stringify(st);
            worst = Math.max(worst, utf8Bytes(json));
            worstChars = Math.max(worstChars, json.length);
            for (const i of listed(fromBase64Chunks(st.s as string[]))) {
                if (snaps > 2) longestWait = Math.max(longestWait, snaps - (lastSeen.get(i) ?? 0));
                lastSeen.set(i, snaps);
            }
        }
        expect(seated).toBe(MAX_PLAYERS - 1);
        expect(nails).toBe(64);
        // after the first snapshots, every entity was listed, and none waited long
        expect(lastSeen.size).toBe(sim.entities.length);
        for (const [, at] of lastSeen) expect(snaps - at).toBeLessThanOrEqual(2);
        console.info(
            `worst case, all ${sim.entities.length} entities moving, ${nails} nails: ${worst} UTF-8 bytes (${worstChars} characters); longest wait ${longestWait} snapshots`
        );
        expect(worst).toBeLessThanOrEqual(PRESENCE_LIMIT);
        expect(longestWait).toBeLessThanOrEqual(2);
    });

    it('normal play (the Valley, the host walking, seven guests seated and acknowledging) is far under it', async () => {
        const hub = new MemoryHub();
        const sim = new LabSim({ level: valleyLevel });
        sim.step(neutralCommand(0));
        sim.fpActive = true;
        const hs = await HostSession.start(hub.transport('host'), sim, 'valley', 'size');
        const ad = { code: 'size', level: 'valley', host: 'host', players: 1, max: MAX_PLAYERS, v: NET_PROTOCOL };
        const guests: GuestSession[] = [];
        for (let g = 1; g < MAX_PLAYERS; g++)
            guests.push(await GuestSession.join(hub.transport(`g${g}`), new LabSim({ level: valleyLevel }), ad));
        const sizes: number[] = [];
        for (let t = 1; t <= 900; t++) {
            sim.step({ ...neutralCommand(t), moveZ: 1, yaw: t / 60 });
            hs.afterStep((s) => sim.interactionIds(s));
            if (t > 300 && t % 3 === 0) sizes.push(utf8Bytes(JSON.stringify(hostState(hub, 'room-ue-size'))));
        }
        expect(hs.guestCount).toBe(MAX_PLAYERS - 1);
        for (const g of guests) expect(g.received).toBeGreaterThan(200);
        sizes.sort((a, b) => a - b);
        console.info(`normal play: median ${sizes[sizes.length >> 1]} bytes, most ${sizes[sizes.length - 1]}`);
        expect(sizes[sizes.length - 1]).toBeLessThan(1200);
    });

    it('is counted in UTF-8 bytes: messages written entirely in 3-byte characters still fit', async () => {
        const { hub, sim, hs } = await valleyHost();
        let worst = 0;
        for (let k = 0; k < 60; k++) {
            sim.step(neutralCommand(k));
            allMoving(sim, k);
            sim.events.push({ tick: sim.tick, kind: 'hazard', text: '€'.repeat(120) });
            hs.afterStep((s) => sim.interactionIds(s));
            if (sim.tick % 3 === 0) worst = Math.max(worst, utf8Bytes(JSON.stringify(hostState(hub, 'room-ue-size'))));
        }
        console.info(`3-byte messages: ${worst} UTF-8 bytes`);
        expect(worst).toBeLessThanOrEqual(PRESENCE_LIMIT);
    });

    it('encoding takes the host well under a millisecond per snapshot (all entities moving)', async () => {
        const { sim } = await valleyHost();
        const enc = new SnapshotEncoder();
        const guests = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
        const times: number[] = [];
        for (let k = 0; k < 600; k++) {
            allMoving(sim, k);
            const t0 = performance.now();
            enc.encode(k * 3, sim.entities, guests, 2900, (i) => i);
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

/** A guest: decodes what reaches it and acknowledges each snapshot it applied. */
function guest(enc: SnapshotEncoder, n: number, id = 'g') {
    const dec = new SnapshotDecoder(n);
    const ring = new SnapshotRing(n);
    return {
        ring,
        receive(bytes: Uint8Array, tick: number) {
            if (dec.apply(bytes, ring)) enc.ack(id, tick);
        }
    };
}

describe('a guest that misses updates, or joins late, still gets every pose', () => {
    it('an entity that stops while updates are lost is right in the first snapshot after the gap', () => {
        for (const lost of [
            [25, 45], // the stop (at 30) inside the gap
            [31, 45], // the gap just after it: the last move was received, the stop wasn't
            [25, 90] // a long gap
        ]) {
            const es = boxes(30);
            const enc = new SnapshotEncoder();
            const g = guest(enc, es.length);
            for (let n = 1; n <= lost[1] + 1; n++) {
                if (n <= 30) es[7].pose.p.x = n * 0.1; // moves, then rests at 3 m
                const bytes = enc.encode(n * 3, es, ['g']);
                if (n >= lost[0] && n <= lost[1]) continue;
                g.receive(bytes, n * 3);
            }
            // the very first snapshot that got through after the gap
            expect(drawn(g.ring, 7, (lost[1] + 1) * 3)!.x, `lost ${lost.join('-')}`).toBeCloseTo(3, 2);
        }
    });

    it('an acknowledgement of an older pose does not count for the new one', () => {
        const es = boxes(5);
        const enc = new SnapshotEncoder();
        const old = enc.encode(3, es, ['g']); // lists all at the first pose
        expect(listed(old)).toContain(2);
        es[2].pose.p.x = 1; // moves
        const now = enc.encode(6, es, ['g']);
        expect(listed(now)).toContain(2);
        enc.ack('g', 3); // the guest only now reports the first snapshot
        expect(listed(enc.encode(9, es, ['g']))).toContain(2); // still to send at its new pose
        enc.ack('g', 9);
        expect(listed(enc.encode(12, es, ['g']))).not.toContain(2); // confirmed: not sent again
    });

    it('a guest that gets one snapshot in k (k = 2 to 40, coalesced updates, a slow host) gets every entity at the first that arrives', () => {
        for (let k = 2; k <= 40; k++) {
            const es = boxes(60);
            es.forEach((e, i) => (e.pose.p.z = i));
            const enc = new SnapshotEncoder();
            const g = guest(enc, es.length);
            // the guest joins at snapshot 50 and from then on gets only every k-th snapshot
            let first = 0;
            for (let n = 50; n <= 50 + 3 * k; n++) {
                es[3].pose.p.x = n * 0.01; // one entity keeps moving
                const bytes = enc.encode(n * 3, es, ['g']);
                if ((n - 50) % k !== 0 || n === 50) continue;
                g.receive(bytes, n * 3);
                if (!first) first = n;
                const missing = es.map((_, i) => i).filter((i) => drawn(g.ring, i, n * 3)?.z !== i);
                expect(missing, `one in ${k}, snapshot ${n}`).toEqual([]);
                expect(drawn(g.ring, 3, n * 3)!.x).toBeCloseTo(n * 0.01, 2);
            }
            expect(first).toBe(50 + k);
        }
    });

    it('within a budget, a late joiner has every entity after as many arriving snapshots as the budget takes, for one in k = 2 to 40', () => {
        for (let k = 2; k <= 40; k++) {
            const es = boxes(60);
            es.forEach((e, i) => (e.pose.p.z = i));
            const enc = new SnapshotEncoder();
            const half = encodeSnapshot(0, es).length / 2;
            // how many snapshots of that size it takes to carry them all
            const header = encodeSnapshot(0, es, []).length;
            const need = Math.ceil((encodeSnapshot(0, es).length - header) / Math.floor(half - header - 22));
            const g = guest(enc, es.length);
            let arrived = 0;
            let n = 0;
            for (n = 1; arrived < need; n++) {
                const bytes = enc.encode(n * 3, es, ['g'], half);
                if (n % k !== 0) continue;
                g.receive(bytes, n * 3);
                arrived++;
            }
            const t = (n - 1) * 3;
            const missing = es.map((_, i) => i).filter((i) => drawn(g.ring, i, t)?.z !== i);
            expect(missing, `one in ${k}, after ${need} arriving`).toEqual([]);
        }
    });

    it('nothing is drawn before its pose arrives, and one shown again waits for its new pose', () => {
        const es = boxes(40);
        es.forEach((e, i) => (e.pose.p.z = i));
        es[5].visible = false;
        const enc = new SnapshotEncoder();
        const g = guest(enc, es.length);
        // room for three entities: entity 0 (3 animation channels, 22 bytes) and two boxes (15 each)
        const tiny = encodeSnapshot(0, es, []).length + 22 + 2 * 15;
        g.receive(enc.encode(3, es, ['g'], tiny), 3);
        const shown = es.map((_, i) => i).filter((i) => drawn(g.ring, i, 3) !== null);
        expect(shown.length).toBe(3);
        for (let n = 2; n <= 20; n++) g.receive(enc.encode(n * 3, es, ['g']), n * 3);
        expect(drawn(g.ring, 5, 60)).toBeNull();
        expect(drawn(g.ring, 9, 60)!.z).toBeCloseTo(9, 2);
        // entity 9 is hidden, moved while hidden, then shown again in a snapshot too small to list it
        es[9].visible = false;
        g.receive(enc.encode(63, es, ['g']), 63);
        es[9].pose.p.z = 99;
        es[9].visible = true;
        g.receive(enc.encode(66, es, ['g'], encodeSnapshot(0, es, []).length), 66);
        expect(drawn(g.ring, 9, 66), 'not drawn at its old pose').toBeNull();
        g.receive(enc.encode(69, es, ['g']), 69);
        expect(drawn(g.ring, 9, 69)!.z).toBeCloseTo(99, 2);
    });

    it('a snapshot within budget lists the stalest entities first and defers the rest', () => {
        const es = boxes(30);
        const enc = new SnapshotEncoder();
        const full = encodeSnapshot(3, es).length;
        const small = enc.encode(3, es, ['g'], full / 2);
        expect(small.length).toBeLessThanOrEqual(full / 2);
        expect(enc.deferred).toBeGreaterThan(0);
        // the next one lists those left out first (as many as fit), then the third the rest
        const first = new Set(listed(small));
        const missed = es.map((_, i) => i).filter((i) => !first.has(i));
        es.forEach((e) => (e.pose.p.y += 1));
        const next = listed(enc.encode(6, es, ['g'], full / 2));
        expect(next.length).toBeGreaterThan(0);
        for (const i of next) expect(missed).toContain(i);
        es.forEach((e) => (e.pose.p.y += 1));
        const third = new Set(listed(enc.encode(9, es, ['g'], full / 2)));
        for (const i of missed.filter((i) => !next.includes(i))) expect(third.has(i)).toBe(true);
    });

    it('with no guest playing, nothing at rest is sent', () => {
        const es = boxes(30);
        const enc = new SnapshotEncoder();
        expect(listed(enc.encode(3, es, []))).toEqual([]);
    });
});

/** Where a guest session draws entity i now (null: hidden), at the host's last snapshot tick. */
function guestDraws(sim: LabSim, i: number, tick: number) {
    const p = pose();
    return sim.ring.sample(i, tick / 60, p, new Float64Array(ANIM_MAX)) ? p.p : null;
}

/** The yard, hosted, with `n` guest sessions; `step` runs the host (and the guests react at once). */
async function yardGame() {
    const hub = new MemoryHub();
    const sim = new LabSim({ level: timberYardLevel });
    sim.step(neutralCommand(0));
    sim.fpActive = true;
    const hs = await HostSession.start(hub.transport('host'), sim, 'yard', 'full');
    const ad = { code: 'full', level: 'yard', host: 'host', players: 1, max: MAX_PLAYERS, v: NET_PROTOCOL };
    const join = async (id: string, token?: string) => {
        const gsim = new LabSim({ level: timberYardLevel });
        return { sim: gsim, s: await GuestSession.join(hub.transport(id), gsim, ad, { token }) };
    };
    const step = (n: number) => {
        for (let k = 0; k < n; k++) {
            sim.step(neutralCommand(sim.tick));
            hs.afterStep((s) => sim.interactionIds(s));
        }
    };
    /** Host-visible entities the guest doesn't draw where the host has them (at the last snapshot). */
    const missing = (g: { sim: LabSim }) => {
        const t = Math.floor(sim.tick / 3) * 3;
        return sim.entities.flatMap((e, i) => {
            if (!e.visible) return [];
            const at = guestDraws(g.sim, i, t);
            return at && Math.hypot(at.x - e.pose.p.x, at.y - e.pose.p.y, at.z - e.pose.p.z) < 0.01 ? [] : [i];
        });
    };
    return { sim, hs, join, step, missing };
}

describe('every guest of this version is sent the world, playing or not', { timeout: 60_000 }, () => {
    it('a watcher who joins a full game late draws the whole world (after the others confirmed it all)', async () => {
        const g = await yardGame();
        const players = [];
        for (let k = 1; k < MAX_PLAYERS; k++) players.push(await g.join(`p${k}`));
        g.step(300);
        expect(g.hs.guestCount).toBe(MAX_PLAYERS - 1);
        for (const p of players) expect(g.missing(p)).toEqual([]);
        const watcher = await g.join('watcher');
        g.step(300);
        expect(g.hs.guestCount, 'the game is full: the eighth watches').toBe(MAX_PLAYERS - 1);
        expect(watcher.s.received).toBeGreaterThan(50);
        const visible = g.sim.entities.filter((e) => e.visible).length;
        expect(visible).toBeGreaterThan(30);
        expect(g.missing(watcher), `of ${visible} visible`).toEqual([]);
    });

    it('a guest waiting to rejoin (its token still held by a seated tab) draws the whole world while it waits', async () => {
        const g = await yardGame();
        const first = await g.join('tab-1', 'token0123456789a');
        g.step(300);
        expect(g.missing(first)).toEqual([]);
        // the same player in a second tab: it waits for the first to go before it may take the place
        const second = await g.join('tab-2', 'token0123456789a');
        g.step(120);
        expect(g.hs.guestCount, 'still waiting').toBe(1);
        expect(g.missing(second)).toEqual([]);
    });
});

describe('acknowledgements that arrive late', () => {
    it('still confirm what the snapshots they acknowledge listed, so normal play shrinks (acks 3 to 40 snapshots late)', () => {
        for (const late of [3, 10, 40]) {
            const es = boxes(30);
            es.forEach((e, i) => (e.pose.p.z = i));
            const enc = new SnapshotEncoder();
            const dec = new SnapshotDecoder(es.length);
            const ring = new SnapshotRing(es.length);
            const acks: number[] = [];
            for (let n = 1; n <= 120; n++) {
                es[4].pose.p.x = n * 0.01; // one keeps moving
                const bytes = enc.encode(n * 3, es, ['g']);
                if (dec.apply(bytes, ring)) acks.push(n * 3);
                // the guest's acknowledgement reaches the host `late` snapshots after it got the snapshot
                while (acks.length && acks[0] <= (n - late) * 3) enc.ack('g', acks.shift()!);
            }
            // only the moving one is still sent
            expect(enc.listed, `acks ${late} late`).toBe(1);
            for (let i = 0; i < es.length; i++) expect(drawn(ring, i, 360)!.z).toBeCloseTo(i, 2);
        }
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
