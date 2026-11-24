import { beforeAll, describe, expect, it } from 'vitest';

import { BRIDGE, CREEK_WATER_Y } from '../../src/levels/timber-yard.ts';
import {
    CREVASSE,
    DITCH,
    GORGE,
    ROUTE_YAW,
    VALLEY_STAGES,
    WALL,
    roadT,
    routeT,
    routeToWorld,
    routeU,
    valleyHeight,
    valleyLevel
} from '../../src/levels/valley.ts';
import { SnapshotDecoder, encodeSnapshot } from '../../src/net/codec.ts';
import { neutralCommand } from '../../src/sim/commands.ts';
import type { PlayerCommand } from '../../src/sim/commands.ts';
import { LabSim } from '../../src/sim/lab-sim.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { SnapshotRing } from '../../src/sim/snapshots.ts';
import { STATIC_REGION } from '../../src/voxels/dirty.ts';
import { CHUNK_SIZE, GRID_SIZE } from '../../src/voxels/grid.ts';
import { pose, quatFromYawPitchRoll } from '../../src/voxels/math.ts';
import { VoxelWorld } from '../../src/voxels/world.ts';
import { VoxelService } from '../../src/workers/voxel-service.ts';

beforeAll(() => initPhysics());

const cmd = (n: number, c: Partial<PlayerCommand> = {}): PlayerCommand => ({ ...neutralCommand(n), ...c });
const hAt = (u: number, t: number) => {
    const w = routeToWorld(u, t);
    return valleyHeight(w.x, w.z);
};

describe('the Valley: one map, seven areas', () => {
    it('the route frame round-trips', () => {
        for (const [u, t] of [
            [0, 0],
            [100, -20],
            [-30, 12]
        ]) {
            const w = routeToWorld(u, t);
            expect(routeU(w.x, w.z)).toBeCloseTo(u, 9);
            expect(routeT(w.x, w.z)).toBeCloseTo(t, 9);
        }
        // the whole route lies inside the map, below the fine lattice's 18 m ceiling
        for (let u = -30; u <= 210; u += 2) {
            const w = routeToWorld(u, roadT(u));
            expect(Math.abs(w.x)).toBeLessThan(105);
            expect(Math.abs(w.z)).toBeLessThan(105);
            expect(hAt(u, roadT(u))).toBeLessThan(15);
        }
    });

    it('each crossing runs right across the valley, too wide to jump, spannable by a beam', () => {
        // across the whole width of the map at that point, the crossing floor is below the fall line
        for (let t = -60; t <= 60; t += 3) {
            expect(hAt(DITCH.u + 0.6 * Math.sin(0.11 * t), t)).toBeLessThan(valleyLevel.rules!.fallY);
            expect(hAt(GORGE.u + 1.2 * Math.sin(0.06 * t), t)).toBeLessThan(valleyLevel.rules!.fallY);
            expect(hAt(CREVASSE.u + 0.8 * Math.sin(0.07 * t), t)).toBeLessThan(valleyLevel.rules!.fallY);
        }
        // the creek crossing is the Timber Yard's (same gap)
        expect(BRIDGE.gap).toBeGreaterThan(2.3);
        // culvert, gorge spans either side of the pier, crevasse: under a 3.2 m beam with bearing
        for (const gap of [DITCH.hw * 2, GORGE.hw - GORGE.pierHalfU, CREVASSE.hw * 2]) {
            expect(gap).toBeGreaterThan(2.0);
            expect(gap).toBeLessThan(3.2 - 0.4);
        }
        // the works' retaining wall: too high to jump (about 0.86 m)
        expect(hAt(WALL.u + 1, 0) - hAt(WALL.u - 1, 0)).toBeGreaterThan(1.3);
        // the road climbs: the summit is the highest point of the route
        expect(hAt(202, 0)).toBeGreaterThan(hAt(150, roadT(150)) + 5);
    });

    it('a beam laid across each crossing rests on both banks (and on the gorge pier)', () => {
        const s = new LabSim({ level: valleyLevel });
        s.step(cmd(0));
        const fall = valleyLevel.rules!.fallY;
        const beams = s.entities.filter((e) => e.name.startsWith('beam-')).slice(0, 6);
        let used = 0;
        const placed: { id: number; u: number; t: number; rim: number }[] = [];
        for (const c of [DITCH.u, GORGE.u, CREVASSE.u]) {
            const t = roadT(c);
            // the gaps along the road: runs of ground below the fall line
            const gaps: [number, number][] = [];
            let start = NaN;
            for (let u = c - 6; u <= c + 6; u += 0.02) {
                const low = hAt(u, t) < fall;
                if (low && Number.isNaN(start)) start = u;
                if (!low && !Number.isNaN(start)) {
                    gaps.push([start, u]);
                    start = NaN;
                }
            }
            expect(gaps.length, `crossing at ${c}`).toBe(1);
            // the gorge's stone pier (a static piece) splits it in two spans
            if (c === GORGE.u) {
                const [a, b] = gaps.pop()!;
                gaps.push([a, GORGE.u - GORGE.pierHalfU], [GORGE.u + GORGE.pierHalfU, b]);
            }
            for (const [a, b] of gaps) {
                expect(b - a, `gap at ${c}`).toBeGreaterThan(1.9); // too far to step or jump
                expect(b - a, `gap at ${c}`).toBeLessThan(2.9); // a 3.2 m beam bears on both sides
                const m = (a + b) / 2;
                const rim = Math.max(hAt(a - 0.3, t), hAt(b + 0.3, t));
                const w = routeToWorld(m, t);
                const e = beams[used++];
                // long axis along the route (u), lying flat
                s.physics.place(e.id, {
                    p: { x: w.x, y: rim + 0.2, z: w.z },
                    q: quatFromYawPitchRoll(ROUTE_YAW + Math.PI / 2, Math.PI / 2, 0)
                });
                placed.push({ id: e.id, u: m, t, rim });
            }
        }
        for (let n = 0; n < 180; n++) s.step(cmd(n + 1));
        for (const p of placed) {
            const e = s.entities.find((x) => x.id === p.id)!;
            expect(e.pose.p.y, `beam over u=${p.u.toFixed(1)}`).toBeGreaterThan(p.rim - 0.25);
            expect(Math.abs(routeU(e.pose.p.x, e.pose.p.z) - p.u)).toBeLessThan(0.5);
        }
    }, 120_000);

    it('a tile builds the same whether its neighbours are built or not', () => {
        const T = STATIC_REGION.x;
        // the tile with the old bridge in it, and one in the forest
        for (const [u, t] of [
            [0, 0],
            [30, 8]
        ]) {
            const p = routeToWorld(u, t);
            const ti = Math.floor(p.x / (T * GRID_SIZE));
            const tk = Math.floor(p.z / (T * GRID_SIZE));
            const tile = (w: VoxelWorld, a: number, b: number) => {
                const r = { i0: a * T, i1: a * T + T - 1, k0: b * T, k1: b * T + T - 1 };
                w.clip = r;
                valleyLevel.stream!.buildTile(w, 1, r, { ti: a, tk: b });
                w.clip = null;
            };
            const alone = new VoxelWorld();
            alone.tileCells = T;
            tile(alone, ti, tk);
            const block = new VoxelWorld();
            block.tileCells = T;
            for (let b = tk - 1; b <= tk + 1; b++) for (let a = ti - 1; a <= ti + 1; a++) tile(block, a, b);
            let cells = 0;
            let differ = 0;
            for (let k = tk * T; k < tk * T + T; k += 3)
                for (let i = ti * T; i < ti * T + T; i += 3)
                    for (let j = Math.floor(-2 / GRID_SIZE); j < Math.floor(14 / GRID_SIZE); j++) {
                        const v = alone.staticAt(i, j, k);
                        if (v) cells++;
                        if (v !== block.staticAt(i, j, k)) differ++;
                    }
            expect(cells).toBeGreaterThan(1000);
            expect(differ).toBe(0);
            // nothing outside the tile was written
            for (const c of alone.chunks) {
                if (!c.stat) continue;
                expect(c.cx * CHUNK_SIZE).toBeGreaterThanOrEqual(ti * T);
                expect(c.cx * CHUNK_SIZE).toBeLessThan(ti * T + T);
            }
        }
    }, 120_000);

    it('the near world streams around the camera and lets go of what it leaves behind', () => {
        const s = new VoxelService();
        s.build(1, 'valley');
        const first = s.builtTiles.length;
        expect(first).toBeGreaterThan(10);
        const states = new Float64Array(s.trackedCount * 18);
        const at = (u: number) => {
            const p = routeToWorld(u, roadT(u));
            return new Float32Array([p.x, p.z]);
        };
        // walk 80 m up the forest road, then come back
        let frame = 0;
        let chunksMid = 0;
        for (let u = -10; u <= 70; u += 1.5) s.frame(frame++, 0, 'coverage50', false, states, undefined, 0, at(u));
        for (let n = 0; n < 200; n++) s.frame(frame++, 0, 'coverage50', false, states, undefined, 0, at(70));
        chunksMid = s.world.chunkCount;
        const tiles = s.builtTiles;
        // only tiles near the camera are built, and every one of them within the radius plus slack
        const p = at(70);
        const size = STATIC_REGION.x * GRID_SIZE;
        for (const t of tiles) {
            const d = Math.hypot((t.ti + 0.5) * size - p[0], (t.tk + 0.5) * size - p[1]);
            expect(d).toBeLessThan(valleyLevel.stream!.radius + size * 3);
        }
        // and the start (80 m back) has been let go
        const start = at(-10);
        expect(tiles.some((t) => Math.hypot((t.ti + 0.5) * size - start[0], (t.tk + 0.5) * size - start[1]) < 10)).toBe(
            false
        );
        // memory stays bounded: chunks are released and their ids reused
        for (let u = 70; u >= -10; u -= 1.5) s.frame(frame++, 0, 'coverage50', false, states, undefined, 0, at(u));
        for (let n = 0; n < 200; n++) s.frame(frame++, 0, 'coverage50', false, states, undefined, 0, at(-10));
        expect(s.world.chunkCount).toBeLessThan(chunksMid * 1.5);
    }, 300_000);

    it('the Low preset builds a smaller near world, and shrinking it lets go of the outer tiles', () => {
        const w = routeToWorld(110, 0);
        const focus = new Float32Array([w.x, w.z]);
        const size = STATIC_REGION.x * GRID_SIZE;
        const s = new VoxelService();
        s.build(1, 'valley');
        const states = new Float64Array(s.trackedCount * 18);
        const settle = (svc: VoxelService, radius: number) => {
            for (let n = 0; n < 400; n++)
                svc.frame(n, 0, 'coverage50', false, states, undefined, 0, focus, undefined, 0, radius);
            return svc.builtTiles;
        };
        const far = (tiles: { ti: number; tk: number }[]) =>
            Math.max(...tiles.map((t) => Math.hypot((t.ti + 0.5) * size - w.x, (t.tk + 0.5) * size - w.z)));
        const { radius, lowRadius } = valleyLevel.stream!;
        const high = settle(s, radius).length;
        // switched to Low: the outer tiles go
        const shrunk = settle(s, lowRadius!);
        expect(far(shrunk)).toBeLessThan(lowRadius! * 1.35 + size);
        // arriving somewhere on Low: about (24 / 36)^2 of the tiles
        const fresh = new VoxelService();
        fresh.build(1, 'valley');
        const low = settle(fresh, lowRadius!);
        expect(low.length).toBeLessThan(high * 0.6);
        expect(far(low)).toBeLessThan(lowRadius! + size);
        // the ground at the camera is built
        expect(low.some((t) => Math.hypot((t.ti + 0.5) * size - w.x, (t.tk + 0.5) * size - w.z) < size)).toBe(true);
    }, 300_000);

    it('stages: the bucket at each checkpoint in turn completes them, in order, then the journey', () => {
        const s = new LabSim({ level: valleyLevel });
        s.step(cmd(0));
        expect(s.progress.step).toBe(0);
        // a checkpoint further on does not count before its turn
        const g2 = VALLEY_STAGES[2].goal;
        const put = (g: { minX: number; maxX: number; minZ: number; maxZ: number }) => {
            const x = (g.minX + g.maxX) / 2;
            const z = (g.minZ + g.maxZ) / 2;
            s.physics.place(s.bucket.id, pose(x, valleyHeight(x, z) + 0.3, z));
        };
        put(g2);
        for (let n = 0; n < 90; n++) s.step(cmd(n));
        expect(s.progress.step).toBe(0);
        let n = 100;
        const last = VALLEY_STAGES.length - 1;
        for (let k = 0; k < last; k++) {
            put(VALLEY_STAGES[k].goal);
            for (let i = 0; i < 90; i++) s.step(cmd(n++));
            expect(s.progress.step).toBe(k + 1);
        }
        // the flower (Epic 7): setting the bucket down by it is not enough, the water has to go in
        // (a rules check with teleports; tests/unit/water-play.test.ts plays it with commands)
        put(VALLEY_STAGES[last].goal);
        for (let i = 0; i < 120; i++) s.step(cmd(n++));
        expect(s.progress.step).toBe(last);
        expect(s.progress.goalReached).toBe(false);
        const f = VALLEY_STAGES[last].flower!;
        const at = { x: f.x + 1.2 * Math.cos(ROUTE_YAW), z: f.z - 1.2 * Math.sin(ROUTE_YAW) };
        const before = s.water.volume;
        // seven half-metre drops onto the checkpoints splashed a little out
        expect(before).toBeGreaterThan(5);
        // tipped over inside the ring of stones: it empties into the flower's bed
        s.physics.place(s.bucket.id, pose(at.x, valleyHeight(at.x, at.z) + 0.5, at.z, quatFromYawPitchRoll(0, 2.2, 0)));
        for (let i = 0; i < 300; i++) s.step(cmd(n++));
        expect(s.progress.goalReached).toBe(true);
        expect(s.water.poured).toBeGreaterThan(0.25);
        expect(s.events.filter((e) => e.kind === 'step')).toHaveLength(VALLEY_STAGES.length - 1);
        expect(s.events.filter((e) => e.kind === 'goal')).toHaveLength(1);
        expect(s.events.at(-1)!.text).toContain('The flower drank');
        // the win fires once: more water later is welcome, but no second win
        s.water.water.reset(5);
        s.physics.place(s.bucket.id, pose(at.x, valleyHeight(at.x, at.z) + 0.5, at.z, quatFromYawPitchRoll(0, 2.2, 0)));
        for (let i = 0; i < 300; i++) s.step(cmd(n++));
        expect(s.events.filter((e) => e.kind === 'goal')).toHaveLength(1);
    }, 120_000);

    it('a bucket lost in a crossing comes back at the last checkpoint reached', () => {
        const s = new LabSim({ level: valleyLevel });
        s.step(cmd(0));
        // reach stage 3 (the forest road), then drop the bucket into the culvert
        for (let k = 0; k < 2; k++) {
            const g = VALLEY_STAGES[k].goal;
            const x = (g.minX + g.maxX) / 2;
            const z = (g.minZ + g.maxZ) / 2;
            s.physics.place(s.bucket.id, pose(x, valleyHeight(x, z) + 0.3, z));
            for (let i = 0; i < 90; i++) s.step(cmd(10 + k * 100 + i));
        }
        expect(s.progress.step).toBe(2);
        const c = routeToWorld(DITCH.u, 6);
        s.physics.place(s.bucket.id, pose(c.x, CREEK_WATER_Y + 0.4, c.z));
        for (let i = 0; i < 240; i++) s.step(cmd(400 + i));
        expect(s.progress.recoveries).toBe(1);
        const b = VALLEY_STAGES[2].bucket;
        expect(Math.hypot(s.bucket.pose.p.x - b.x, s.bucket.pose.p.z - b.z)).toBeLessThan(0.5);
        // its water went with it; the spare is empty (refills are only at the water butts)
        expect(s.water.volume).toBe(0);
        const w = s.water;
        expect(w.spilled + w.lost).toBeCloseTo(10, 6);
        expect(Math.abs(w.imbalance)).toBeLessThan(1e-9);
    }, 120_000);

    it('every prop has a body and is at rest on the ground after two seconds', () => {
        const s = new LabSim({ level: valleyLevel });
        for (let n = 0; n < 120; n++) s.step(cmd(n));
        for (const pl of valleyLevel.props) {
            if (pl.name === 'held-plank') continue; // summoned into the hands, hidden until then
            const e = s.entities.find((x) => x.name === pl.name);
            expect(e, pl.name).toBeDefined();
            expect(s.physics.bodies.has(e!.id), pl.name).toBe(true);
            const p = e!.pose.p;
            // nothing fell in or through the ground
            expect(p.y, pl.name).toBeGreaterThan(valleyHeight(p.x, p.z) - 0.3);
            expect(Math.hypot(p.x - pl.pose.p.x, p.z - pl.pose.p.z), pl.name).toBeLessThan(0.8);
        }
    }, 120_000);

    it('snapshots carry positions anywhere on the map', () => {
        const s = new LabSim({ level: valleyLevel });
        s.step(cmd(0));
        const far = routeToWorld(200, 0);
        s.physics.place(s.bucket.id, pose(far.x, 13, far.z));
        s.step(cmd(1));
        const src = s.bucket.pose.p;
        const ent = {
            pose: pose(src.x, src.y, src.z),
            visible: true,
            anim: new Float64Array(6),
            asset: { animChannels: 0 }
        };
        const ring = new SnapshotRing(1, 4);
        const dec = new SnapshotDecoder(1);
        expect(dec.apply(encodeSnapshot(60, [ent]), ring)).toBe(true);
        const out = pose();
        expect(ring.sample(0, 1, out, new Float64Array(6))).toBe(true);
        expect(Math.abs(src.x)).toBeGreaterThan(60);
        expect(Math.abs(out.p.x - src.x)).toBeLessThan(0.003);
        expect(Math.abs(out.p.z - src.z)).toBeLessThan(0.003);
    });
});
