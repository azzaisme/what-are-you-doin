# START HERE — instructions for Claude Code

You are taking over **(Un)civil Engineers**, a cooperative first-person physics construction game
for the browser (PlayCanvas, TypeScript). Epics 0 and 1 are done and **approved by the owner**
(Aaron). Your job in this session:

1. **Fix the mobile portrait layout bug** (small, do it first, see Task 1).
2. **Plan, then build Epic 2 — Physical sandbox (offline)** (Task 2), and stop at its gate.

Do not start Epic 3 or later. Do not rewrite working Epic 1 systems unless a task needs it.

---

## Read first, in this order

1. This file.
2. `docs/GAME_DESIGN.md` — the full brief. §0 (workflow rules), §4 (architecture), §5 (voxel
   renderer spec), §6.1 (physics model), §8 Epic 2 (scope and gate), §10 (validation).
3. `docs/progress.md` — what exists, real measurements, known issues. Gate 1b is the latest state.
4. `docs/adr/0001`–`0007` — why things are the way they are. ADR 0006 (frame ordering) and
   ADR 0007 (cell size setting + voxel worker) matter most for Epic 2.
5. `AGENTS.md` / `CLAUDE.md` and `.claude/skills/` — the official PlayCanvas scaffold guidance and
   engine skills (inspect-runtime, verify-pixels, reduce-draw-calls, light-scene, etc.).
6. `README.md` — commands, controls, layout.

## Owner decisions made after the design doc (these override it)

- **Voxel size is a per-player quality setting, 5–10 cm, default 5 cm** (slider bottom-left,
  `#cell75` hash, saved in local storage, applied by reload). The design doc's fixed 10 cm is
  superseded for _rendering_. Gameplay snapping (§2.4) is a separate grid and still 10 cm unless the
  owner says otherwise. Below 5 cm was measured as infeasible (ADR 0007) — don't extend the range.
- **Epic 1 approved** on 2026-11-20. The owner tests on an **Android phone (Adreno 840)**: 5 cm,
  High preset ran at ~60 fps (p95 19 ms), voxel worker 28 ms per frame, no skipped voxel frames.
  Keep the demo working and fast on that phone as you add features; check it there, not only on
  desktop.
- The voxel world runs in a **Web Worker** (Phase C adopted). Keep reconstruction off the main thread.
- Live demo (owner-only link, managed from claude.ai, not from here):
  https://claude.ai/artifact/WTJ5AK6TWJUHT6yUWvaJgo — built with `npm run build:publish`, which
  loads PlayCanvas from jsDelivr through an import map. `npm run build` is the self-contained build
  for itch.io.

## Setup and checks

```sh
git init && git add -A && git commit -m "Import Epic 1 hand-over"   # only if there is no .git yet
node --version              # needs 22.23.2 or later
npm install
npx playwright install chromium   # once, unless CHROME_PATH points at a Chrome
npm run check               # typecheck + lint + 94 unit test runs (47 tests x 5 cm and 10 cm) + build
npm run build && npm run test:e2e # 7 browser tests against the production build
npm run dev                 # http://localhost:5173 (Inspector + debug panel); use --host to open on the phone
```

All of these passed at hand-over. The previous environment had **no GPU** (software WebGL), so no
desktop GPU numbers exist yet. You do have real hardware: measure on it and record the numbers.

---

## Task 1 — mobile portrait layout (do first)

On the owner's phone in portrait (canvas 768 × 1408), the bottom-left **Voxel size** box overlaps the
bottom of the **debug panel** stats, and the HUD title/help text is clipped behind the panel.

Fix so that nothing overlaps in portrait or landscape, on phones and desktop:

- narrow screens: collapse the debug panel to the bottom sheet or make it toggle full-height above
  the voxel box; wrap or shorten the HUD help; keep touch targets ≥ 40 px;
- keep `H` (hide all UI) and the F3 / corner-chip toggle working.
  Verify with Playwright screenshots at 390 × 844, 768 × 1408 (DPR 1) and 1280 × 720 (add a test
  that checks the boxes' bounding rectangles do not intersect). Commit separately.

## Task 2 — Epic 2: Physical sandbox (offline)

Scope, from `docs/GAME_DESIGN.md` §8 and §6.1:

- Install a **pinned** Rapier package (the brief's default; `@dimforge/rapier3d-compat` is the usual
  browser build). The scaffold has no physics skill, and the engine's built-in physics uses Ammo, so
  use Rapier directly in the engine-free sim layer and record the choice in an ADR.
- Connect it to the existing **fixed 60 Hz step** (`src/sim/clock.ts`, `src/sim/lab-sim.ts`) and the
  existing pose path: the sim publishes snapshots → main thread samples them at the voxel time → the
  voxel worker rasterizes. **Physics must not depend on render, and render must never feed back
  into physics.** Never use voxel occupancy as collision (§3.3, §6.1).
- Controllable first-person character with safe contact and step behaviour (replace the current
  terrain-height walker in `lab-sim.ts`), basic **grab / release** with bounded forces, throwable
  logs and planks, bounce/throw tests, a ragdoll experiment, static terrain collision (heightfield
  or trimesh from the analytic terrain in `src/levels/river-lab.ts`, not from voxels), dynamic
  bodies, a bucket proxy.
- Keep the scripted props available as a toggle so the visual comparisons from Epic 1 still work.
- Commands stay plain sequenced data (`PlayerCommand`) so Epic 3 networking can carry them.
- Touch controls are not in scope unless the owner asks; keyboard/mouse first.

**Gate** (report actual numbers, not estimates):

- 10-minute interactive playground: responsive movement, held props never explode, stable fixed tick
  (record dropped ticks), no physics/render coupling;
- a scripted, deterministic physics test that moves and drops an object and captures the voxel grid
  output at several rotations;
- `npm run check` and `npm run test:e2e` green; new unit tests for the physics adapter, command
  handling and force bounds;
- frame time on the owner's phone and on desktop, with 1 and 25 moving bodies;
- updated `docs/progress.md` (new "Gate 2" section at the top) and ADRs.

Then **stop and ask the owner to try it**. Do not begin Epic 3.

## Working rules (from the brief, still in force)

- Plan briefly, then build one runnable slice at a time; commit at each green step.
- Use the installed library versions' real APIs (check `node_modules/*/build/*.d.ts`); don't invent.
- Tests for math, state ownership and rules; real screenshots for visual checks — and **look at
  them**. In Epic 1 a white-out bug passed every functional test and was caught only by eye.
- Record hardware, browser, commands, measurements and known issues in `docs/progress.md`.
- Keep the engine-free boundary: `src/voxels`, `src/assets`, `src/levels`, `src/sim`, `src/workers`
  must not import PlayCanvas (physics may live in `src/sim` only if it is engine-independent).
- All visible solids keep going through the global voxel reconstruction; the water surface,
  atmosphere and UI are the only smooth exceptions.
