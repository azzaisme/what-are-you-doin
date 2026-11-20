# ADR 0001 — Engine-free voxel core and one-way data boundaries

Status: accepted (Epic 1) · Date: 2026-11-19

## Context
The design doc (§4.2–4.3) requires renderer and simulation to communicate through shared data, never
engine objects, so the simulation can later run on a Node server and reconstruction in workers.

## Decision
- `src/voxels`, `src/assets`, `src/levels`, `src/sim` import nothing from PlayCanvas. Poses are plain
  `{p, q}` objects; occupancy is typed arrays.
- The simulation publishes snapshots (pose + small animation vector + visibility) into a ring buffer.
  The voxel pipeline samples that ring at the voxel clock; the renderer only consumes mesh buffers.
- Kept as a single app (the official scaffold) until Epic 2/3, as the design doc asks; no empty
  packages were scaffolded.

## Consequences
Unit tests run the whole reconstruction path in Node. The headless benchmark measures CPU cost
without a GPU. Extracting `packages/sim` later is a move, not a rewrite.
