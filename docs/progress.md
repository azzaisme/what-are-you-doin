# Progress log

## Owner approval of Epic 1 (2026-11-20)

Aaron approved the River Lab ("Game looks fantastic", "I think this is going to work") after testing
the 5 cm build on an Android phone: Adreno 840, canvas 768 × 1408, High preset, 59.8 fps, frame
avg 16.7 ms / p95 19.1 ms / max 31.3 ms, 2,252 draw calls, 350 drawables, 1.5 M triangles, voxel
worker 28 ms per frame (raster 11.9, resolve 3.3, mesh 12.8), main-thread upload 1.1 ms, lag 1
frame, 0 skipped voxel frames. Known: in portrait the voxel-size box overlaps the debug panel.
Next: see `START_HERE.md` (mobile layout fix, then Epic 2).


## Gate 1b — voxel size as a quality setting, 5 cm default, worker reconstruction (2026-11-19)

Owner feedback on gate 1: frame rate fine on their phone, look approved. Requests: 5 cm voxels, then
a voxel-size slider (asked 0.5–10 cm). See ADR 0007.

- **Done:** cell size is a per-player setting, 5–10 cm in 0.5 cm steps, default 5 cm, bottom-left
  slider (saves, reloads), `#cell75`-style hash. Everything derives from it; physical render-unit
  sizes are constant so draw calls stay ~350 drawables.
- **Not done, by measurement:** below 5 cm. Static world cost on this CPU: 10 cm 1.4 s / 25 MB /
  0.47 M tris; 5 cm 7.3 s / 99 MB / 1.49 M; 4 cm 13 s / 157 MB / 2.2 M; 2.5 cm 47 s / 418 MB /
  5.2 M. 0.5 cm is ~8,000× the 10 cm cell count.
- **Phase C adopted** (needed for 5 cm): voxel world in a Web Worker. Browser measurements
  (software GL, 2 vCPU, low preset): 5 cm — worker build 3.4 s + static mesh 2.4 s, upload 0.2 s,
  1.52 M triangles, 352 drawables, voxel frame 76 ms median in the worker, **main-thread upload 3.6 ms
  median / 18.5 ms max**, heap 138 MB. 10 cm — 1.0 + 0.5 s, 0.47 M triangles, worker 16 ms,
  upload 1.4 ms median.
- At 5 cm on slower devices, moving props update at a lower effective voxel rate (~13 Hz here)
  rather than stalling frames; the debug panel shows lag and skipped voxel frames.
- Rasterizer interior fast path and empty-space skipping in meshing: identical output, 72 → 50 ms
  per voxel frame at 5 cm in Node.
- Beaver hat dome trimmed so the standing beaver is exactly 1.40 m at every cell size.
- Tests: 47 unit tests × 2 cell sizes = 94 pass; 7 browser tests pass (2 new: `#cell100` loads the
  10 cm world; default 5 cm with slider range 5–10).
- Screenshots in `docs/screenshots` are now at 5 cm; `docs/screenshots/10cm/` keeps three 10 cm
  references. The video `docs/media/river-lab.mp4` is still the 10 cm capture.


## Gate 1 — Epic 0 + Epic 1 "River Lab" (2026-11-19)

**Status: built and verified to the extent this environment allows. Waiting on the owner's visual
approval (an explicit gate). No later epic has been started.**

### Environment used for every number below

| | |
|---|---|
| CPU | Intel Xeon @ 2.10 GHz, 2 vCPU (cloud sandbox) |
| GPU | **none** — Chrome 1xx headless, ANGLE → Mesa llvmpipe (software WebGL2) |
| Node | 22.23.5 |
| Browser tests | system Google Chrome via Playwright 1.65.1, `--use-angle=swiftshader` |
| Viewport | 1280 × 720 (screenshots), 960 × 540 (video) |
| Packages (lockfile) | playcanvas 2.24.2, vite 8.3.8, typescript 6.0.3, vitest 5.1.1, @playwright/test 1.65.1 |
| Scaffold | `npm create playcanvas@latest uncivil-engineers -- -f engine` (create-playcanvas 0.17.0, minimal engine starter, defaults) |

Because there is no GPU, **no frame-rate target in §7.4 has been measured**. Browser frame times
below are software-rendering times and must not be read as performance results. CPU-side voxel
reconstruction was measured headlessly in Node, which is representative of the main-thread cost on
a comparable desktop core (a fast desktop core will typically be quicker than this 2.1 GHz vCPU).

### Commands

```sh
npm install && npm run check        # typecheck, lint, 47 unit tests, production build
npm run test:e2e                    # 5 browser tests (builds must exist: npm run build)
node --expose-gc scripts/bench-voxels.ts 10 20
node scripts/bench-static.ts
npm run start & node scripts/capture.mjs --video
```

### What was built

- Epic 0: official scaffold kept (strict TS, ESLint, Prettier, Vite), Vitest + Playwright added,
  `npm run test`, `test:e2e`, `check`, lockfile committed, design doc in `docs/GAME_DESIGN.md`, ADRs.
- Grid contract (§5.1): 10 cm cells, fixed origin, `floor` indexing, half-open cells, signed integer
  indices, sparse 16³ chunks with small-integer keys.
- CPU reference rasterizer (§5.3): conservative world AABB → candidate cells → inverse-pose centre /
  sub-sample tests → per-object occupancy → deterministic composite → dirty chunks → greedy exposed-face
  meshes → one atomic commit before any pass renders. Four sampling policies switchable live.
- Assets from analytic volumes (§5.2): beaver on a joint rig with walk cycle and paddle tail (14 cells
  tall), ute with steered/spinning/suspended wheels, 2.4 × 0.2 × 0.1 m plank, 0.4 m × 2 m log, ~10 L
  bucket with handle, test cube and sphere, pines, rocks, reeds, flowers, terrain with river and a
  terraced ridge.
- Scripted motion only (no physics, §7.2 step 3): beaver walks a loop carrying the bucket and pauses to
  look around; ute laps an oval track; plank hovers, translates and tumbles; log rolls without slip;
  cube slides diagonally while turning; sphere bounces and rolls; 0/1/10/25 extra stress objects.
- Lighting and water (§5.6–5.8): dynamic sky at golden hour driving the sun colour and IBL, PCF5
  cascaded shadows, ACES tone mapping with a light warm grade, fog matched to the horizon, bloom,
  vignette, per-vertex voxel AO (ambient only); engine `Water` script for planar reflection with
  oblique clipping, refraction, depth tint, shoreline foam and caustics on the riverbed.
- Cameras: orbit (engine CameraControls) and a first-person walker with interpolated position,
  display-rate look, FOV and sensitivity; optional carried plank voxelized in world space.
- Debug panel (§7.3) and a test API used by Playwright and the capture script.

### Test results (actual)

- Unit (Vitest): **47 / 47 pass**. Covers negative coordinates and chunk seams, translation 0 → 0.1 m
  (exactly one transition), rotations 0°/15°/45°/89°/90° under all four policies, same-pose hash
  identity with zero dirty cells, overlap winners and restore-on-leave, static never erased, full-turn
  thin geometry for plank/log/wheel (never disappears under any policy), mesher vs brute force across
  seams (static and dynamic rules), no coplanar duplicates, greedy == per-face coverage, 100% vertices
  on grid planes, CCW winding, axis-aligned normals, AO, clock and snapshot interpolation, sim
  determinism, beaver height = 14 cells, both eyes visible (1–3 exposed cells each) plus teeth, nose,
  hat, vest, tail at 72 headings × 4 phases, wheels on the ground and visibly spinning, 3,000-frame
  long run with periodic hash identity and no chunk growth.
- Browser (Playwright, production build): **5 / 5 pass** — boot with no console errors and a
  colour-sane non-blank frame; every uploaded vertex on the grid and every render unit at identity;
  deterministic reconstruction per time; reference mode, all voxel rates, all policies and 25 stress
  objects without errors or rejected parts; first-person carry.
- `npm run typecheck`, `npm run lint`, `npm run build`: pass.

Bugs found by these checks and fixed during the gate: a crash from re-assigning render mesh instances
(the engine destroys previously assigned instances), and voxels rendering white because instances
were created before their meshes had a vertex-colour stream. The second passed every functional test
and was caught only by looking at screenshots; a pixel colour check now guards it.

### Measurements (actual)

**Static scene** (Node, `scripts/bench-static.ts`; browser at load in brackets):
313,600 terrain columns, ~1.14 M static cells, 2,611 chunks, ~35 MB typed arrays; rasterize
0.9–1.0 s [0.68–0.87 s]; mesh 268 regions 1.16 s [1.12–1.33 s]; 232k quads / 464k triangles.
Optimisation history: 1.32 M → 632k triangles (merge-friendly colour patches) → 464k (implicit
bedrock + terraced ridge, ADR 0005).

**Voxel reconstruction CPU cost per voxel frame** (Node, 20 Hz, scripted scene, after the two
output-identical optimisations in ADR 0002/0004; ms p50 / p95):

| Policy | Extra objects | Frames | Raster | Resolve | Mesh | **Total** | Max | Samples | Cells | Dyn chunks meshed |
|---|---|---|---|---|---|---|---|---|---|---|
| center | 0 | 300 | 1.4 / 2.0 | 0.6 / 0.8 | 5.6 / 9.0 | **7.6 / 11.7** | 22.8 | 7.5k | 5,332 | 29.8 |
| **coverage50 (default)** | 0 | 300 | 4.0 / 6.0 | 0.6 / 0.9 | 5.8 / 10.4 | **10.5 / 16.1** | 27.7 | 89.5k | 6,006 | 30.4 |
| coverage25 | 0 | 300 | 4.2 / 6.0 | 0.7 / 1.1 | 5.8 / 11.1 | **10.9 / 16.1** | 26.1 | 89.5k | 6,975 | 31.4 |
| conservative | 0 | 300 | 3.6 / 5.5 | 0.7 / 1.1 | 10.5 / 16.9 | **14.9 / 22.0** | 31.8 | 57.5k | 8,794 | 32.6 |
| coverage50 | 10 | 300 | 5.4 / 7.3 | 1.4 / 1.8 | 10.5 / 15.5 | **17.3 / 22.4** | 29.8 | 110.8k | 7,200 | 61.4 |
| coverage50 | 25 | 300 | 7.4 / 11.5 | 3.2 / 4.5 | 16.9 / 26.6 | **27.7 / 42.2** | 50.8 | 144.1k | 9,107 | 100.4 |
| coverage50, 10 min | 0 | 12,000 | 3.9 / 5.4 | 0.6 / 0.8 | 5.5 / 10.0 | **10.0 / 15.4** | 31.7 | 89.4k | 6,003 | 31 |

Raw output: `node --expose-gc scripts/bench-voxels.ts 10 20` (also saved locally as
`artifacts/bench-voxels.txt`, not committed).

Before those two optimisations the default was p50 12.6 / p95 16.9 ms (231k samples per frame).
**The §7.4 first-pass budget of ~4 ms raster + mesh is not met:** the default is about 2.5× over it
on this CPU (p50 10.0 ms over 10 minutes). Raster is ~4 ms, meshing ~5.5 ms (≈30 dynamic 16³ chunks
re-meshed per frame); GPU upload adds ~3–5 ms in the browser. There were no periodic >50 ms stalls
in the base scene (max 31.7 ms over 12,000 frames); 25 extra objects reach 50.8 ms.

**Browser** (software WebGL; for scale only): 409 drawables, ~3,700 draw calls per frame across the
main pass, depth pass, 3 shadow cascades, reflection and refraction; ~0.8 fps at 1280 × 720.
Heap ~90–120 MB.

**Memory / stability:** 10 simulated minutes at 20 Hz (12,000 voxel frames) in Node: heap flat at
7.3–7.7 MB after GC, chunk count +8 over the run (first visits of a quasi-periodic path), zero
rejected parts. The 3,000-frame unit test shows no chunk growth for strictly periodic motion.

### Known issues and limitations

1. **CPU budget over target** (above). Options for the owner: accept 12 Hz for distant/cheap objects,
   move rasterization + meshing to a worker with transferable buffers (Phase C, §5.5), reduce
   per-chunk fill cost (incremental padded-occupancy updates), or per-object meshes for isolated
   objects. Not done yet because Phase C should follow this measured gate.
2. **No GPU measurement.** 60 FPS at 1080p is unverified. Draw calls (~3,700) are the likely first
   GPU-side cost on real hardware; mitigations: larger static render regions, fewer cascades, culling
   the far ridge from the refraction pass, static batching.
3. Static shadows are re-rendered every frame (all cascades); a cached static cascade would help.
4. Fog colour is sampled from the sky once per sun change and only towards −Z.
5. Bucket water surface (smooth exception) is not implemented yet (Epic 7); the bucket is empty.
6. The first-person walker follows the analytic terrain height, not physics, and has no collisions
   with trees, props or the ute (Epic 2).
7. Firefox and other browsers not tested yet (Chromium only).
8. Water ripple normal map and caustics are procedural and tileable; they are a first pass.
9. The beaver face reads at 14 cells but needs owner judgement: under the hard-hat brim's shadow the
   eye row can read like goggles, and the teeth row is wide at some offsets.

### Owner gate — please judge

1. Beaver cuteness and legibility at 14 cells (screenshots 02, 03; video).
2. Size of the 10 cm voxels relative to characters, props and the world.
3. Diagonal turning: the stepped plank, log and ute (screenshots 05/06 voxel vs reference at the same
   instant; 10 rotation strip). Is the cell flicker acceptable at 20 Hz? Try 12/30/60 Hz live.
4. First-person comfort with a carried plank (screenshot 09; try `V` then `G` live).
5. Water: reflection of reconstructed objects, shallow colour, foam (screenshots 01, 08).
6. Golden-hour palette and atmosphere.
7. Sampling default (coverage50) vs alternatives.
8. Whether to proceed with the CPU optimisation path or Phase C workers before Epic 2.

### Evidence

`docs/screenshots/` (01–11) and `docs/media/river-lab.mp4` (deterministic, 24 fps, 20 Hz voxel
clock, continuously moving camera: the camera glides every frame while cells update only on voxel
frames). `docs/screenshots/stats-at-capture.json` holds the live stats at the end of capture.
