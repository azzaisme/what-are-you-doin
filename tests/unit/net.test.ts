import { beforeAll, describe, expect, it } from 'vitest';

import { timberYardLevel } from '../../src/levels/timber-yard.ts';
import { SnapshotDecoder, encodeSnapshot, fromBase64Chunks, toBase64Chunks } from '../../src/net/codec.ts';
import { GuestSession, HostSession, listGames, readInput } from '../../src/net/session.ts';
import { MemoryHub } from '../../src/net/transport.ts';
import { ACTION_DROP_TEST, ACTION_NONE, ACTION_RAGDOLL, neutralCommand } from '../../src/sim/commands.ts';
import type { PlayerCommand } from '../../src/sim/commands.ts';
import { LabSim } from '../../src/sim/lab-sim.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { SnapshotRing } from '../../src/sim/snapshots.ts';
import { pose, quatFromYawPitchRoll } from '../../src/voxels/math.ts';

beforeAll(() => initPhysics());

const cmd = (n: number, c: Partial<PlayerCommand> = {}): PlayerCommand => ({ ...neutralCommand(n), ...c });
const ent = (x: number, y: number, z: number, yaw: number, pitch: number, anim: number[] = []) => ({
    pose: pose(x, y, z, quatFromYawPitchRoll(yaw, pitch, 0.3)),
    anim: Float64Array.from([...anim, 0, 0, 0, 0, 0, 0].slice(0, 6)),
    visible: true,
    asset: { animChannels: anim.length }
});

describe('snapshot codec', () => {
    it('round-trips poses to 2 mm and orientations to well under a degree, in a few hundred bytes', () => {
        const es = [
            ent(-27.3, 9.81, -41.9, 2.1, 0.4),
            ent(0.001, -1.05, 13.2, -3, -1.2, [1.5, 0.25, 3]),
            { ...ent(5, 5, 5, 0, 0), visible: false }
        ];
        const bytes = encodeSnapshot(1234, es);
        expect(bytes.length).toBeLessThan(60);
        const ring = new SnapshotRing(3, 8);
        const dec = new SnapshotDecoder(3);
        expect(dec.apply(fromBase64Chunks(toBase64Chunks(bytes)), ring)).toBe(true);
        const out = pose();
        const anim = new Float64Array(6);
        for (const i of [0, 1]) {
            expect(ring.sample(i, 1234 / 60, out, anim)).toBe(true);
            const src = es[i].pose;
            expect(Math.hypot(out.p.x - src.p.x, out.p.y - src.p.y, out.p.z - src.p.z)).toBeLessThan(0.002);
            const dot = Math.abs(out.q.x * src.q.x + out.q.y * src.q.y + out.q.z * src.q.z + out.q.w * src.q.w);
            expect((2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI).toBeLessThan(0.1);
        }
        ring.sample(1, 1234 / 60, out, anim);
        expect(anim[0]).toBeCloseTo(1.5, 2);
        expect(ring.sample(2, 1234 / 60, out, anim)).toBe(false); // hidden entities stay hidden
    });

    it('keeps growing animation angles continuous across the wrap, ignores stale and garbage input', () => {
        const ring = new SnapshotRing(1, 16);
        const dec = new SnapshotDecoder(1);
        // real channels move ~0.4 rad per snapshot; steps must stay under half the wrap range
        const vals = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120];
        vals.forEach((v, n) => dec.apply(encodeSnapshot(n * 3 + 3, [ent(0, 0, 0, 0, 0, [v])]), ring));
        const out = pose();
        const anim = new Float64Array(6);
        ring.sample(0, (vals.length * 3) / 60, out, anim);
        expect(anim[0]).toBeCloseTo(120, 1);
        expect(dec.apply(encodeSnapshot(3, [ent(0, 0, 0, 0, 0)]), ring)).toBe(false); // older tick
        expect(dec.apply(new Uint8Array([1, 9, 9, 9, 9, 200, 200, 1]), ring)).toBe(false); // truncated
        expect(dec.apply(new Uint8Array([7, 0, 0]), ring)).toBe(false); // wrong version
    });
});

describe('online co-op sessions (in-memory transport)', () => {
    it('validates untrusted guest input', () => {
        expect(readInput(null)).toBeNull();
        expect(readInput({ mx: 'x', y: NaN, sp: 'yes', j: 3 })).toEqual({
            mx: 0,
            mz: 0,
            sp: false,
            y: 0,
            p: 0,
            j: 3,
            g: 0,
            t: 0,
            a: 0,
            an: 0
        });
    });

    it('a guest joins, gets a slot, walks on its own input, and sees the host world through snapshots', async () => {
        const hub = new MemoryHub();
        const host = new LabSim({ level: timberYardLevel });
        host.step(cmd(0));
        host.fpActive = true;
        const hs = await HostSession.start(hub.transport('host'), host, 'yard', 'abcd');
        const games = listGames(hub.channel('lobby', 'watcher'));
        expect(games.map((g) => g.code)).toEqual(['abcd']);

        let clock = 0;
        const guestSim = new LabSim({ level: timberYardLevel });
        const gs = await GuestSession.join(hub.transport('guest'), guestSim, games[0], () => clock);
        expect(hs.remoteSlots()).toEqual(new Set([1]));
        expect(host.isSlotActive(1)).toBe(true);
        expect(gs.slot).toBe(1);

        const start = { ...host.players[1] };
        // 119 steps: the host ends on tick 120, a snapshot tick
        for (let n = 0; n < 119; n++) {
            gs.sendInput(cmd(n, { moveZ: 1, yaw: Math.PI, jump: n === 30 }));
            host.step(cmd(n), hs.commandFor(1), [hs.commandFor(2), hs.commandFor(3)]);
            hs.afterStep(() => ({ held: -1, target: -1, shared: false }));
            clock += 1000 / 60;
        }
        // yaw pi faces +Z: the guest's player walked south on the host
        expect(host.players[1].z - start.z).toBeGreaterThan(2);
        expect(gs.received).toBeGreaterThan(30);
        // the guest's ring holds the host's poses (within the codec's precision) at the newest tick
        const out = pose();
        const anim = new Float64Array(6);
        const eye = guestSim.eyes[1];
        expect(guestSim.ring.sample(eye.slot, host.tick / 60, out, anim)).toBe(true);
        expect(Math.abs(out.p.z - host.eyes[1].pose.p.z)).toBeLessThan(0.01);
        // and the guest renders a little behind the newest snapshot
        const t = gs.renderTime();
        expect(t).toBeGreaterThan(host.tick / 60 - 0.5);
        expect(t).toBeLessThanOrEqual(host.tick / 60);
        // guests may launch the dummy but not run scene actions
        gs.sendInput(cmd(500, { action: ACTION_DROP_TEST }));
        expect(hs.commandFor(1)!.action).toBe(ACTION_NONE);
        gs.sendInput(cmd(501, { action: ACTION_RAGDOLL }));
        expect(hs.commandFor(1)!.action).toBe(ACTION_RAGDOLL);
        expect(hs.commandFor(1)!.action).toBe(ACTION_NONE); // one press, one action
        // leaving frees the slot
        gs.leave();
        expect(host.isSlotActive(1)).toBe(false);
        hs.stop();
        expect(listGames(hub.channel('lobby', 'watcher2'))).toEqual([]);
    });

    it('a full game leaves extra guests watching without a slot', async () => {
        const hub = new MemoryHub();
        const host = new LabSim({ level: timberYardLevel });
        host.step(cmd(0));
        host.fpActive = true;
        const hs = await HostSession.start(hub.transport('host'), host, 'yard', 'full');
        const ad = listGames(hub.channel('lobby', 'w'))[0];
        const guests = [];
        for (let i = 0; i < 4; i++)
            guests.push(await GuestSession.join(hub.transport(`g${i}`), new LabSim({ level: timberYardLevel }), ad));
        expect(guests.map((g) => g.slot).sort()).toEqual([-1, 1, 2, 3]);
        expect(host.playerCount).toBe(4);
        hs.stop();
    });
});
