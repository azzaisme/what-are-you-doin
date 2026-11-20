# (Un)civil Engineers — River Lab (Epics 0–2)

> **Picking this up with Claude Code? Read [`START_HERE.md`](START_HERE.md).**

*Civil engineering. Uncivil physics.* — a world where matter is pixelated, but light isn't.

This repository contains the project described in [`docs/GAME_DESIGN.md`](docs/GAME_DESIGN.md) up
to its third gate: the project foundation (Epic 0), the River Lab visual technology demo (Epic 1)
and the offline physical sandbox (Epic 2: Rapier physics, a first-person character, grab / carry /
throw, a ragdoll dummy) — plus **level 1, the Timber Yard**: carry beams across a creek whose
footbridge has collapsed and get the bucket to the far bank. No networking, fastening or driving
yet; those are later epics.

What the demo proves:

- **One world grid.** Every visible solid lies on a single global, axis-aligned lattice (5 cm by
  default; the **Voxel size** slider, bottom-left, sets 5–10 cm per player). Moving
  objects (beaver, ute, plank, log, bucket, test cube/sphere) are **re-rasterized into the world
  grid** every voxel frame from continuous poses. Cubes never rotate or slide; there is no entity per
  voxel; render meshes never move.
- **Continuous light.** Golden-hour sun with cascaded soft shadows, a dynamic sky providing
  image-based ambient light, tone mapping, fog, and a **real planar river reflection** (mirrored
  camera with oblique clipping) that reflects the same reconstructed cells. No pixelation filter.
- **Separate clocks.** Fixed 60 Hz simulation, display-rate camera and lighting, and a global voxel
  clock (12/20/30/60 Hz, default 20 Hz).

See [`docs/progress.md`](docs/progress.md) for measured results, known issues and the questions for
the owner's visual-approval gate.

## Running it

Requires Node.js 22.23.2 or later.

```sh
npm install
npm run dev          # dev server with the PlayCanvas Inspector, http://localhost:5173
npm run build        # production build into dist/ (relative URLs, runs from any folder / itch.io)
npm run start        # serve the production build
```

Query parameters (handy for comparisons and screenshots):

| Parameter | Effect |
|---|---|
| `?debug` or `#debug` | show the debug panel in a production build (always shown in `npm run dev`) |
| `#cell75` | voxel size 7.5 cm (any 50–100, i.e. 5–10 cm); the slider saves the choice and reloads |
| `?quality=low` | low preset: no MSAA, 1024 shadows, 2 cascades, 25% reflection, no refraction |
| `?hz=12\|20\|30\|60` | voxel reconstruction rate |
| `?t=4.5` | start paused at an exact simulation time |
| `?view=fp` | start in first person |
| `?noui` | hide all UI |
| `?level=lab` | the River Lab test scene instead of level 1, the Timber Yard |
| `?view=orbit` | start the Timber Yard in the orbit view instead of first person |
| `?props=scripted` | River Lab only: Epic 1 scripted prop motion instead of physics props (also in the debug panel) |

## Controls

| Input | Action |
|---|---|
| Drag / right-drag / wheel | orbit / pan / zoom (orbit view) |
| `V` | toggle orbit / first-person view |
| Click, then mouse | look (first person; `Esc` releases the pointer) |
| `W A S D`, `Shift`, `Space` | walk, run, jump (first person; steps up 0.3 m, slides on steep slopes) |
| Left click or `E` | grab what the crosshair points at / release it (the prompt says what) |
| Right click | throw what you hold |
| Mouse wheel | hold closer / further |
| `Q` | drop |
| `G` | put a plank in your hands (scripted mode: the Epic 1 comfort-test plank) |
| `T` | launch the ragdoll dummy |
| **Gamepad** | press **A** to join (first pad: player 1, second pad: player 2 → split screen) |
| left / right stick | move / look |
| A · LT or L3 · RT · RB · B · X · Y · D-pad | jump · sprint · grab / release · throw · drop · ragdoll · plank · reach |
| `P` / `N` | pause / step exactly one voxel frame |
| `Backspace` | reset the scene |
| `H` | hide all UI (for screenshots) |
| `F3` or the corner chip | debug panel |

The debug panel (design doc §7.3) has: pause, step voxel frame, reset, voxel rate, sampling policy
(center / coverage50 / coverage25 / conservative), grid-line overlay, continuous source bounds,
conventional smooth reference mode, 0/1/10/25 extra moving objects, sun elevation and azimuth,
reflection on/off, refraction, reflection resolution, quality preset, view, FOV and mouse
sensitivity, and a Physics section (props physics / scripted, launch ragdoll, drop test, reset
props, collider wireframes) — plus live stats (frame time avg/p95/max, draw calls, triangles, active cells, sample
calls, dirty chunks, overlaps, raster/resolve/mesh/upload times, heap, physics tick time, active bodies, held object, grab force, safety clamps, dropped ticks).

## Checks

```sh
npm run typecheck    # strict TypeScript
npm run lint         # ESLint (PlayCanvas config)
npm run test         # 71 Vitest unit tests, each run at 5 cm and 10 cm cells (142 runs)
npm run build
npm run test:e2e     # 9 Playwright browser tests against the production build (headless Chrome)
npm run check        # typecheck + lint + unit tests + build
```

Measurement and evidence scripts:

```sh
node --expose-gc scripts/bench-voxels.ts 10 20   # headless CPU benchmark, 10 simulated minutes at 20 Hz
UE_CELL_CM=10 node scripts/bench-static.ts       # any script or test at a specific cell size
node scripts/bench-static.ts                     # static scene build and meshing cost
node scripts/soak-physics.ts 10                  # 10 simulated minutes of scripted play: physics cost and stability
node scripts/drop-test.ts                        # deterministic drop test, voxel captures into docs/screenshots/epic2
npm run build && npm run start &                 # then:
node scripts/capture.mjs --video                 # screenshots into docs/screenshots, video into docs/media
```

Playwright uses `CHROME_PATH` if set, else `/usr/bin/google-chrome` with SwiftShader software WebGL
(Linux without a GPU), else its bundled Chromium (`npx playwright install chromium`). Software-GL frame
rates say nothing about real hardware.

## Layout

```
src/
  voxels/     engine-free core: grid contract, math, palette, volumes, rasterizer, world/compositor,
              mesher, dirty tracking
  assets/     beaver, ute, plank, log, bucket, test props (analytic volumes on small rigs)
  levels/     level descriptions (level.ts), the Timber Yard (level 1), the River Lab (test scene),
              shared terrain rasterizer, pines and rocks
  sim/        fixed-step clock, voxel clock, snapshot ring, commands, lab simulation, entity catalogue,
              drop test; sim/physics: Rapier adapter (world, character, grab force law)
  workers/    voxel worker: owns the voxel world; static build, rasterize, composite, mesh
  render/     PlayCanvas scene, lighting, water, mesh uploads, worker client, reference mode
  input/      first-person input
  debug/      debug panel
  main.ts     app state, frame director, HUD, test API
tests/unit    Vitest
tests/e2e     Playwright
scripts/      benchmarks and evidence capture
docs/         design doc, progress log, ADRs, screenshots, media
```

`src/voxels`, `src/assets`, `src/levels` and `src/sim` (Rapier included) never import the engine, so they can move into
a shared package for the server and workers later (design doc §4.3).

## Licences

All assets are original and generated in code (terrain, models, palette, water ripple normal map
and caustics pattern). The scaffold is the official `create-playcanvas` engine template; PlayCanvas
is MIT-licensed; Rapier (`@dimforge/rapier3d-compat` 0.21.0) is Apache-2.0. No third-party art is
included.
