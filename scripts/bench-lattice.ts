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
 *        BENCH_PRESET=low node scripts/bench-lattice.ts   (the Low quality preset's mask budget)
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';

type Place = [name: string, x: number, y: number, z: number];
interface Scenario {
    name: string;
    cm: number;
    draws: string[];
    places: Place[];
    /** Your limbs carrying the bucket from a real grab (scripts/lattice-scenes.ts): fp-body and
     * bucket take that pose (the places give the other objects, relative to your limbs' root). */
    carry?: boolean;
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
/** The real fine lane (main.ts): every fine-tier object but your limbs (they have their own). */
const FINE = ['@fine'];

export const SCENARIOS: Scenario[] = [
    { name: '1 cm fine lane: the bucket, alone', cm: 1, draws: FINE, places: [['bucket', 0, 0.45, 0]] },
    {
        name: '1 cm fine lane: the bucket, the beaver and the held plank touching it',
        cm: 1,
        draws: FINE,
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
        // a real first-person grab, looking 0.4 rad down (as tests/unit/hands.test.ts grabs it)
        carry: true,
        places: [
            ['avatar-1', 0.55, 0, 0],
            ['avatar-2', -0.55, 0, 0],
            ['avatar-3', 0, 0, -0.55]
        ]
    },
    {
        name: '1 cm fine lane: the ragdoll standing, the beaver touching its head from above',
        cm: 1,
        draws: FINE,
        places: [...RAGDOLL, ['beaver', 0, 0.9, 0]]
    },
    {
        name: '1 cm fine lane: the ragdoll standing, the beaver deep inside it',
        cm: 1,
        draws: FINE,
        places: [...RAGDOLL, ['beaver', 0, 0.2, 0]]
    },
    {
        name: '1 cm fine lane: the ragdoll standing, three avatars 0.5 m away',
        cm: 1,
        draws: FINE,
        places: [...RAGDOLL, ['avatar-1', 0.5, 0, 0], ['avatar-2', -0.5, 0, 0], ['avatar-3', 0, 0, 0.5]]
    },
    {
        name: '1 cm fine lane: the ragdoll, the beaver and four avatars in it',
        cm: 1,
        draws: FINE,
        places: [
            ...RAGDOLL,
            ['beaver', 0, 0.3, 0],
            ['avatar-0', 0.3, 0.3, 0],
            ['avatar-1', -0.3, 0.3, 0],
            ['avatar-2', 0, 0.3, 0.3],
            ['avatar-3', 0, 0.3, -0.3]
        ]
    },
    {
        name: '1 cm fine lane: pile-up, the beaver and eight avatars deep in the ragdoll',
        cm: 1,
        draws: FINE,
        places: [
            ...RAGDOLL,
            ['beaver', 0, 0.2, 0],
            ...[0, 1, 2, 3, 4, 5, 6, 7].map((n): Place => [`avatar-${n}`, 0.15 * Math.cos(n), 0.2, 0.15 * Math.sin(n)])
        ]
    },
    {
        name: '1 cm fine lane: the ragdoll at rest, its 5 cm body at the joints',
        cm: 1,
        draws: FINE,
        places: RAGDOLL
    }
];

async function run(s: Scenario): Promise<void> {
    (globalThis as { __UE_CELL_CM__?: number }).__UE_CELL_CM__ = s.cm;
    const { createLabEntities } = await import('../src/sim/lab-entities.ts');
    const { VoxelService } = await import('../src/workers/voxel-service.ts');
    const { STATE_STRIDE } = await import('../src/workers/protocol.ts');
    const ents = createLabEntities().entities.filter((e) => e.asset.parts.length > 0);
    type Posed = { p: { x: number; y: number; z: number }; q: { x: number; y: number; z: number; w: number } };
    const posed: { name: string; pose: Posed; anim?: Float64Array }[] = [];
    let origin = { x: 0, y: 0, z: 0 };
    if (s.carry) {
        const { initPhysics } = await import('../src/sim/physics/world.ts');
        const { realBucketCarry } = await import('./lattice-scenes.ts');
        await initPhysics();
        const c = realBucketCarry(-0.4);
        if (!c.held) throw new Error('the grab did not hold the bucket');
        posed.push({ name: 'fp-body', pose: c.body, anim: c.anim }, { name: 'bucket', pose: c.bucket });
        origin = c.body.p;
    }
    const byName = (n: string) => {
        const e = ents.find((x) => x.name === n);
        if (!e) throw new Error(`no entity ${n}`);
        return e;
    };
    // masks off and on, framed alternately so drift and other load fall on both alike
    const { assetTier } = await import('../src/assets/cell-tier.ts');
    const names = s.draws.flatMap((n) =>
        n === '@fine'
            ? ents.filter((e) => assetTier(e.asset) === 'fine' && e.name !== 'fp-body').map((e) => e.name)
            : [n]
    );
    const draws = new Set(names.map((n) => byName(n).id));
    const svcs = [new VoxelService(draws, false), new VoxelService(draws, true)];
    for (const svc of svcs) svc.build(1, 'yard', undefined, false);
    // BENCH_PRESET=low: the Low quality preset's mask budget (BENCH_BUDGET overrides its cells)
    const preset = process.env.BENCH_PRESET === 'low' ? 'low' : 'high';
    svcs[1].setMaskPreset(preset);
    if (process.env.BENCH_BUDGET) svcs[1].maskBudget = Number(process.env.BENCH_BUDGET);
    const times: number[][] = [[], []];
    const tele = { masks: 0, skipped: 0, cells: 0, hidden: 0, rejected: 0, limit: 0, peak: 0 };
    const FRAMES = 200;
    for (let f = 0; f < FRAMES + 10; f++) {
        const st = new Float64Array(ents.length * STATE_STRIDE);
        const all = [
            ...posed,
            ...s.places.map(([name, x, y, z]) => ({
                name,
                pose: { p: { x: origin.x + x, y: origin.y + y, z: origin.z + z }, q: { x: 0, y: 0, z: 0, w: 1 } },
                anim: undefined as Float64Array | undefined
            }))
        ];
        for (const { name, pose: p, anim } of all) {
            const o = ents.indexOf(byName(name)) * STATE_STRIDE;
            st.set([1, p.p.x + f * 0.002, p.p.y, p.p.z, p.q.x, p.q.y, p.q.z, p.q.w], o);
            if (anim) for (let c = 0; c < anim.length; c++) st[o + 8 + c] = anim[c];
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
            tele.cells += svc.maskStats.cells - svc.maskStats.clears;
            tele.limit = Math.max(tele.limit, r.stats.maskLimit);
            tele.peak = Math.max(tele.peak, svc.maskStats.cells - svc.maskStats.clears);
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
            ` | masks ${(tele.masks / k).toFixed(1)}, skipped ${(tele.skipped / k).toFixed(1)}, work ${Math.round(tele.cells / k)} (peak ${tele.peak}, limit ${tele.limit}), hidden ${Math.round(tele.hidden / k)}, rejected ${tele.rejected}`
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
