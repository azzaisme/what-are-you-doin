# ADR 0007 — Voxel cell size as a player quality setting; reconstruction in a worker

Status: accepted (owner request after gate 1) · Date: 2026-11-19

## Context
After approving gate 1 at 10 cm, the owner asked for 5 cm voxels, then for the cell size to be a
quality slider (asked range 0.5–10 cm). Rendering is never gameplay authority (design doc §4.2), so
the reconstruction lattice can differ per player; gameplay snapping (§2.4) is a separate, fixed grid.

## Decision
- `GRID_SIZE` is read once at startup from (in order): the value injected into the voxel worker,
  `UE_CELL_CM` (Node), a `#cellNN` hash (`#cell75` = 7.5 cm; works in sandboxed pages), local
  storage, default **5 cm**. Changing it saves and reloads, because many sizes derive from it at
  module load. Range **5–10 cm in 0.5 cm steps**.
- **Not below 5 cm.** Measured static cost on the sandbox CPU (Node): 10 cm 1.4 s / 25 MB / 0.47 M
  triangles; 5 cm 7.3 s / 99 MB / 1.49 M; 4 cm 13 s / 157 MB / 2.2 M; 2.5 cm 47 s / 418 MB / 5.2 M.
  0.5 cm would be ~8,000× the cells of 10 cm. Phones cannot hold the finer worlds.
- Physical sizes are kept constant across cell sizes: static render regions 6.4 × 3.2 × 6.4 m,
  dynamic render units 1.6 m, so draw-call counts do not grow as cells shrink. Static regions are
  meshed in 1.6 m sub-blocks (empty ones skipped); dynamic ones in 0.8 m chunks.
- **Phase C adopted:** the voxel world, static build, rasterization, compositing and meshing run in a
  Web Worker (`src/workers/`). The main thread samples interpolated poses at each voxel time, sends
  them, and uploads returned buffers (transferred, not copied). One frame in flight; if the worker
  is busy the newest due frame replaces any waiting one (counted as skipped), so slow devices get a
  lower effective voxel rate, never growing latency or main-thread stalls. A finished frame is
  applied by the frame director, all units at once, before any pass renders.
- Rasterizer interior fast path: a cell whose centre and six face-neighbour centres are inside is
  accepted without sub-samples (identical occupancy measured: 45,865 cells either way at 5 cm).
- Unit tests are written in terms of the cell size and run at both 5 and 10 cm (Vitest projects).

## Consequences
At 5 cm the worker needs ~50 ms (Node) / ~76 ms (browser, contended) per voxel frame on the sandbox
CPU, so moving props update at roughly 13–20 Hz depending on the device; main-thread upload is a
median 3.6 ms. Shown voxel frames lag the requested voxel time by about one worker round trip.
