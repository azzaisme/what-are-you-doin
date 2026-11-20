# ADR 0008 — Rapier physics in the engine-free sim layer

Status: accepted (Epic 2) · Date: 2026-11-20

## Context

Epic 2 needs a physical sandbox: a controllable character, grab / release / throw with bounded
forces, dynamic logs and planks, a bucket proxy, a ragdoll experiment, static terrain collision.
The brief (§4.1, §6.1) recommends Rapier and forbids running the engine's Ammo bodies alongside
it. The scaffold has no physics skill, and PlayCanvas' built-in physics is Ammo, so the engine is
not involved at all.

## Decision

- **Package:** `@dimforge/rapier3d-compat` pinned to exactly **0.21.0** (`--save-exact`). The compat
  build inlines its WASM, so it loads the same way in the browser, in Vitest and in Node scripts
  with one `await RAPIER.init()` (`initPhysics()`). APIs were taken from the installed
  `dist/*.d.ts`.
- **Location:** `src/sim/physics/` (generic adapter: world, terrain, bodies, character, grab, limits)
  and `src/sim/lab-physics.ts` (River Lab content). Neither imports PlayCanvas, so the same code can
  run on the Epic 3 server. `src/sim/lab-entities.ts` holds the entity catalogue without physics,
  so the voxel worker never loads Rapier.
- **Ownership and data flow:** the fixed 60 Hz tick (`LabSim.step`) runs scripted animation →
  kinematic targets → character → grab forces → `world.step()` → velocity limits / recovery →
  copies body poses into entities → publishes a snapshot. The main thread samples snapshots at the
  voxel time and the worker rasterizes them (unchanged from Epic 1). Nothing from rendering or the
  voxel grid flows back; the only main-thread reads of the physics world are read-only (collider
  wireframes in debug, the crosshair prompt ray).
- **Collision never comes from voxels.** Terrain is a Rapier heightfield sampled from the analytic
  `terrainHeight` (251 × 251 cells, 0.223 m; within ~1 cm of the analytic surface). Trees (trunk
  cylinder + four cones) and rocks (convex hulls of their ellipsoids) come from `labLayout()`, the
  same placement data the voxel build uses. The visible voxel surface lies 0–1 cell above the
  analytic height, so resting props can look up to one cell sunk at coarse cell sizes; physics does
  not depend on the per-player cell size.
- **Character:** a kinematic capsule (1.4 m) driven by Rapier's `KinematicCharacterController`:
  autostep 0.32 m, snap-to-ground 0.3 m, climb ≤ 50°, slide ≥ 55°. Its collider has solver groups
  that produce no contact forces with props; the controller pushes props with bounded impulses
  (character mass 60 kg). Step-ups are smoothed for the camera only (`eyeLift`).
- **Grab (§2.4):** raycast from the eye (reach 2.6 m), anchor stored in body space, a mass-normalized
  spring-damper (3.2 Hz, ζ = 1) with gravity compensation applied as an impulse at the anchor once
  per tick, magnitude capped at **450 N**. Release on click, Q, throw, or a snag (error > 1.25 m
  for 0.75 s, or > 2.2 m at once). While held, the body's colliders leave the player's collision
  layer and the controller ignores it, so you cannot stand on or shove what you hold (no feedback
  loop). Throw: impulse `min(m · 9 m/s, 45 N·s)`. The 113 kg log cannot be lifted alone (needs
    > 1,100 N) but can be dragged — deliberate, for Epic 3's two-player carry.
- **Safety bounds:** after each step |v| ≤ 30 m/s and |ω| ≤ 30 rad/s (counted when applied); bodies
  that leave the world or go non-finite are put back at their spawn pose (counted).
- **Commands** (`src/sim/commands.ts`) are plain sequenced data with edge-triggered requests (grab,
  throw, action codes) and are sanitized before the sim sees them.
- **Determinism:** same commands → identical states (unit tested, including grabs, throws and the
  ragdoll). Reset rebuilds the Rapier world, so seeking replays exactly. Cross-platform bit
  determinism is not claimed (that needs Rapier's enhanced-determinism build; revisit for Epic 3).
- **Scripted props stay** as a mode (`?props=scripted` or the panel) for Epic 1 comparisons.
- **Bundles:** `npm run build` bundles Rapier (+4.4 MB raw / ~1.7 MB gzip, mostly base64 WASM);
  `npm run build:publish` loads it from jsDelivr through the import map, like PlayCanvas.

## Rapier quirk found

Rapier 0.21 heightfield ray casts miss when the ray lands exactly on a cell boundary (seen with
0.2 m cells at x = 0.6). The cell count is therefore chosen so the spacing is not a round number.
`ColliderDesc.heightfield(rows, cols, …)` needs `(rows + 1) × (cols + 1)` heights, column-major,
rows along Z; a shorter array aborts the WASM module.

## Consequences

Measured on the sandbox CPU (progress.md, gate 2): physics 0.47 ms p50 / 0.83 ms p95 per tick in
the default scene and 1.6 / 2.5 ms with 25 moving bodies; no tick over the 16.7 ms budget in a
10-minute soak. A post-release speed bound was added after the soak caught a snag-released plank
leaving a tree trunk at 21 m/s. Physics props resting on the terrain overlap the voxel ground by up
to one cell, and each such overlap re-meshes a static region, which makes 25 bodies 2.4× as costly
to mesh as Epic 1's scripted ones. Physics runs on the main thread; moving it next to the voxel worker or onto a
server is possible later because it is engine-free and talks only through commands and snapshots.
