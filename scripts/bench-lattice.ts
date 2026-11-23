/**
 * Lattice priority (#107): what masks cost a lattice's voxel worker. Each scenario runs one
 * lattice's service (its cell size, the objects it draws) with every other object placed as listed,
 * moving everything 2 mm a frame so every object re-rasterizes each frame. Masks off and on run
 * side by side, framed alternately (which goes first alternates too). Reports the median frame
 * time over 200 frames (after 10 warm-up frames) with masks off (as before #107) and on, and the
 * masks' telemetry (rasterized, skipped over the budget, candidate cells, cells hidden).
 *
 * Usage: node scripts/bench-lattice.ts     (each scenario runs in its own process: the cell size is
 *                                           fixed per process, ADR 0007)
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';

type Place = [name: string, x: number, y: number, z: number];
interface Scenario {
    name: string;
    cm: number;
    draws: string[];
    places: Place[];
}

// the ragdoll standing at the origin, its parts where the sim puts them at rest (DUMMY_PARTS)
const RAGDOLL: Place[] = [
    ['dummy-body', 0, 0.62, 0],
    ['dummy-head', 0, 1.08, 0.02],
    ['dummy-armL', 0.27, 0.72, 0],
    ['dummy-armR', -0.27, 0.72, 0],
    ['dummy-legL', 0.11, 0.16, 0],
    ['dummy-legR', -0.11, 0.16, 0],
    ['dummy-tail', 0, 0.36, -0.36]
];
const FINE_DUMMY = ['dummy-head', 'dummy-armL', 'dummy-armR', 'dummy-legL', 'dummy-legR', 'dummy-tail'];

export const SCENARIOS: Scenario[] = [
    { name: '1 cm bucket, alone', cm: 1, draws: ['bucket'], places: [['bucket', 0, 0.45, 0]] },
    {
        name: '1 cm bucket, the beaver and the held plank touching it',
        cm: 1,
        draws: ['bucket'],
        places: [
            ['bucket', 0, 0.45, 0],
            ['beaver', 0, 0, 0.1],
            ['held-plank', 0, 0.75, 0]
        ]
    },
    {
        name: '5 cm beaver, the 1 cm bucket in it',
        cm: 5,
        draws: ['beaver'],
        places: [
            ['beaver', 0, 0, 0],
            ['bucket', 0, 0.45, 0]
        ]
    },
    {
        name: '1 cm first-person limbs, holding the bucket, three avatars 0.55 m away',
        cm: 1,
        draws: ['fp-body'],
        places: [
            ['fp-body', 0, 0, 0],
            ['bucket', 0, 0.45, 0.3],
            ['avatar-1', 0.55, 0, 0],
            ['avatar-2', -0.55, 0, 0],
            ['avatar-3', 0, 0, -0.55]
        ]
    },
    {
        name: '1 cm ragdoll head, the beaver standing inside it',
        cm: 1,
        draws: ['dummy-head'],
        places: [
            ['dummy-head', 0, 0.5, 0],
            ['beaver', 0, 0, 0]
        ]
    },
    {
        name: '1 cm ragdoll head, three avatars 0.5 m away',
        cm: 1,
        draws: ['dummy-head'],
        places: [
            ['dummy-head', 0, 0.5, 0],
            ['avatar-1', 0.5, 0, 0],
            ['avatar-2', -0.5, 0, 0],
            ['avatar-3', 0, 0, 0.5]
        ]
    },
    {
        name: '1 cm ragdoll head, crowded: the beaver and four avatars around it',
        cm: 1,
        draws: ['dummy-head'],
        places: [
            ['dummy-head', 0, 0.5, 0],
            ['beaver', 0, 0, 0],
            ['avatar-0', 0.35, 0, 0],
            ['avatar-1', -0.35, 0, 0],
            ['avatar-2', 0, 0, 0.35],
            ['avatar-3', 0, 0, -0.35]
        ]
    },
    {
        name: '1 cm ragdoll limbs and head, its 5 cm body at the joints',
        cm: 1,
        draws: FINE_DUMMY,
        places: RAGDOLL
    }
];

async function run(s: Scenario): Promise<void> {
    (globalThis as { __UE_CELL_CM__?: number }).__UE_CELL_CM__ = s.cm;
    const { createLabEntities } = await import('../src/sim/lab-entities.ts');
    const { VoxelService } = await import('../src/workers/voxel-service.ts');
    const { STATE_STRIDE } = await import('../src/workers/protocol.ts');
    const ents = createLabEntities().entities.filter((e) => e.asset.parts.length > 0);
    const byName = (n: string) => {
        const e = ents.find((x) => x.name === n);
        if (!e) throw new Error(`no entity ${n}`);
        return e;
    };
    // masks off and on, framed alternately so drift and other load fall on both alike
    const draws = new Set(s.draws.map((n) => byName(n).id));
    const svcs = [new VoxelService(draws, false), new VoxelService(draws, true)];
    for (const svc of svcs) svc.build(1, 'yard', undefined, false);
    const times: number[][] = [[], []];
    const tele = { masks: 0, skipped: 0, cells: 0, hidden: 0, rejected: 0 };
    const FRAMES = 200;
    for (let f = 0; f < FRAMES + 10; f++) {
        const st = new Float64Array(ents.length * STATE_STRIDE);
        for (const [n, x, y, z] of s.places) {
            const o = ents.indexOf(byName(n)) * STATE_STRIDE;
            st[o] = 1;
            st[o + 1] = x + f * 0.002;
            st[o + 2] = y;
            st[o + 3] = z;
            st[o + 7] = 1;
        }
        // which goes first alternates too
        for (const k of f % 2 ? [1, 0] : [0, 1]) {
            const svc = svcs[k];
            const r = svc.frame(f, f / 20, 'coverage50', false, st);
            if (f < 10) continue;
            times[k].push(r.stats.totalMs);
            if (k === 0) continue;
            tele.masks += r.stats.latticeMasks;
            tele.skipped += r.stats.maskSkipped;
            tele.cells += r.stats.maskCells;
            tele.hidden += r.stats.latticeHidden;
            tele.rejected += r.stats.maskRejected;
        }
    }
    const median = (t: number[]) => [...t].sort((x, y) => x - y)[t.length >> 1];
    const [off, on] = times.map(median);
    const k = FRAMES;
    const out = [
        `${off.toFixed(2)} ms`,
        `${on.toFixed(2)} ms (${on - off >= 0 ? '+' : '-'}${Math.abs(on - off).toFixed(2)})` +
            ` | masks ${(tele.masks / k).toFixed(1)}, skipped ${(tele.skipped / k).toFixed(1)}, cells ${Math.round(tele.cells / k)}, hidden ${Math.round(tele.hidden / k)}, rejected ${tele.rejected}`
    ];
    console.log(`${s.name} | off ${out[0]} | on ${out[1]}`);
}

const only = process.env.BENCH_SCENARIO;
if (only !== undefined) await run(SCENARIOS[Number(only)]);
else {
    console.log(`CPU: ${os.cpus()[0]?.model ?? 'unknown'}`);
    console.log('scenario | masks off: median ms | masks on: median ms | telemetry per frame');
    for (let n = 0; n < SCENARIOS.length; n++)
        execFileSync(process.execPath, [process.argv[1]], {
            env: { ...process.env, BENCH_SCENARIO: String(n) },
            stdio: 'inherit'
        });
}
