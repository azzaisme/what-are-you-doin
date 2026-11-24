import { beforeAll, describe, expect, it, vi } from 'vitest';

import { roadT, routeToWorld, valleyLevel } from '../../src/levels/valley.ts';
import { viewDistance } from '../../src/levels/view-distance.ts';
import { VoxelClient } from '../../src/render/voxel-pipeline.ts';
import type { LaneSpec } from '../../src/render/voxel-pipeline.ts';
import type { VoxelRenderer } from '../../src/render/voxel-renderer.ts';
import { createLabEntities } from '../../src/sim/lab-entities.ts';
import { LabSim } from '../../src/sim/lab-sim.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { STATIC_REGION } from '../../src/voxels/dirty.ts';
import { GRID_SIZE } from '../../src/voxels/grid.ts';
import { STATE_STRIDE } from '../../src/workers/protocol.ts';
import type { FromWorker, ToWorker, UnitMesh } from '../../src/workers/protocol.ts';
import { VoxelService } from '../../src/workers/voxel-service.ts';

beforeAll(() => initPhysics());

const stream = valleyLevel.stream!;

describe('view distance follows the quality preset', () => {
    it('High builds the level radius, Low its lowRadius, the fog starting inside it', () => {
        expect(viewDistance(stream, 'high')).toEqual({ radius: 36, fogStart: 30 });
        expect(viewDistance(stream, 'low')).toEqual({ radius: 24, fogStart: 18 });
        // a level without a low radius keeps its own
        expect(viewDistance({ ...stream, lowRadius: undefined }, 'low').radius).toBe(36);
    });

    it('the voxel client sends the radius with every frame to the near world lane only', () => {
        const sent: { lane: string; msg: ToWorker }[] = [];
        const fake = (name: string) =>
            ({
                postMessage: (msg: ToWorker) => sent.push({ lane: name, msg }),
                onmessage: null,
                onerror: null
            }) as unknown as Worker;
        const renderer = { apply: () => ({ units: 0, uploadMs: 0 }) } as unknown as VoxelRenderer;
        const lanes: LaneSpec[] = [
            { worker: fake('near'), renderer, cellCm: 5, world: true },
            { worker: fake('fine'), renderer, cellCm: 1, world: false, objects: [960] },
            { worker: fake('far'), renderer, cellCm: 40, world: true, far: true }
        ];
        const client = new VoxelClient(lanes, new LabSim({ level: valleyLevel }));
        client.focus = () => new Float32Array([0, 0]);
        client.nearRadius = viewDistance(stream, 'low').radius;
        client.request(1, 0);
        const frames = sent.filter((s) => s.msg.type === 'frame');
        expect(frames.map((f) => f.lane).sort()).toEqual(['far', 'fine', 'near']);
        const radiusOf = (lane: string) => {
            const m = frames.find((f) => f.lane === lane)!.msg;
            return m.type === 'frame' ? m.nearRadius : 'not a frame';
        };
        expect(radiusOf('near')).toBe(24);
        // the far lattice (with every landmark and the summit flower) and object lanes are not
        // affected by the view distance
        expect(radiusOf('far')).toBeUndefined();
        expect(radiusOf('fine')).toBeUndefined();
    });

    it('the voxel worker passes the radius on: its near world follows it, frame by frame', async () => {
        // the real worker module, with a stand-in for its global scope
        const replies: FromWorker[] = [];
        const scope = {
            postMessage: (m: FromWorker) => replies.push(m),
            onmessage: null as null | ((e: { data: ToWorker }) => unknown)
        };
        vi.stubGlobal('self', scope);
        try {
            vi.resetModules();
            await import('../../src/workers/voxel-worker.ts');
            await scope.onmessage!({ data: { type: 'init', cellCm: GRID_SIZE * 100, seed: 1, level: 'valley' } });
            expect(replies.some((r) => r.type === 'ready')).toBe(true);
            const count = createLabEntities().entities.filter((e) => e.asset.parts.length > 0).length;
            const states = () => new Float64Array(count * STATE_STRIDE);
            const size = STATIC_REGION.x * GRID_SIZE;
            const w = valleyLevel.spawn;
            const farthest = (r: number, frames: number) => {
                let tiles: Int32Array | null = null;
                for (let f = 0; f < frames; f++) {
                    replies.length = 0;
                    void scope.onmessage!({
                        data: {
                            type: 'frame',
                            frame: f,
                            time: 0,
                            policy: 'coverage50',
                            reference: false,
                            states: states(),
                            focus: new Float32Array([w.x, w.z]),
                            nearRadius: r
                        }
                    });
                    const fr = replies.find((x) => x.type === 'frame');
                    if (fr?.type === 'frame' && fr.tiles) tiles = fr.tiles.tiles;
                }
                let d = 0;
                for (let n = 0; tiles && n + 1 < tiles.length; n += 2)
                    d = Math.max(d, Math.hypot((tiles[n] + 0.5) * size - w.x, (tiles[n + 1] + 0.5) * size - w.z));
                return { d, count: tiles ? tiles.length / 2 : 0 };
            };
            const low = farthest(24, 160);
            expect(low.d).toBeLessThan(24 + size);
            const high = farthest(36, 160);
            expect(high.d).toBeGreaterThan(24 + size);
            expect(high.count).toBeGreaterThan(low.count * 1.6);
        } finally {
            vi.unstubAllGlobals();
            vi.resetModules();
        }
    }, 300_000);

    // The bench behind the numbers in docs/progress.md: the near world at a fixed camera, settled,
    // on High and on Low. Meshes are what the renderer draws, one per surface class of each unit
    // (static draw calls for one camera pass before culling); triangles are their index counts / 3.
    it('bench: Low builds about half the near world of High at the forest and the works', () => {
        const count = createLabEntities().entities.filter((e) => e.asset.parts.length > 0).length;
        const states = new Float64Array(count * STATE_STRIDE);
        const measure = (u: number, radius: number) => {
            const svc = new VoxelService();
            const units = new Map<number, UnitMesh>();
            const keep = (list: UnitMesh[]) => {
                for (const m of list) {
                    if (m.mode !== 'static') continue;
                    if (m.quads === 0) units.delete(m.key);
                    else units.set(m.key, m);
                }
            };
            keep(svc.build(1, 'valley').units);
            const w = routeToWorld(u, roadT(u));
            const focus = new Float32Array([w.x, w.z]);
            for (let f = 0; f < 400; f++)
                keep(svc.frame(f, 0, 'coverage50', false, states, undefined, 0, focus, undefined, 0, radius).units);
            let meshes = 0;
            let tris = 0;
            for (const m of units.values())
                for (const c of m.classes) {
                    if (c.indexCount === 0) continue;
                    meshes++;
                    tris += c.indexCount / 3;
                }
            return { tiles: svc.builtTiles.length, cells: svc.world.staticCellCount(), meshes, tris };
        };
        const rows: string[] = [];
        for (const [name, u] of [
            ['forest', 30],
            ['works', 110]
        ] as const) {
            const high = measure(u, stream.radius);
            const low = measure(u, stream.lowRadius!);
            rows.push(
                `${name}: tiles ${high.tiles} -> ${low.tiles}, cells ${high.cells} -> ${low.cells}, meshes ${high.meshes} -> ${low.meshes}, triangles ${high.tris} -> ${low.tris}`
            );
            expect(low.tiles).toBeLessThan(high.tiles * 0.6);
            expect(low.meshes).toBeLessThan(high.meshes * 0.6);
            expect(low.tris).toBeLessThan(high.tris * 0.6);
        }
        console.log(`view-distance bench (${GRID_SIZE * 100} cm):\n${rows.join('\n')}`);
    }, 600_000);
});
