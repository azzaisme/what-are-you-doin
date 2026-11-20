# ADR 0009 — Local co-op: two players, one world, split screen

Status: accepted (owner request: two players on a Steam Deck with two gamepads) · Date: 2026-11-20

## Context

The owner wants to test with two people on one Steam Deck, each on a gamepad. The design doc plans
local two-player as "two cameras/controllers against the same world/simulation, not duplicate
worlds" (§6.2) and calls split screen a separate gate because it doubles camera render cost
(§8 Epic 10). Epic 3 (online co-op) also needs a second beaver and shared grabs.

## Decision

- **One simulation, N players.** `PhysicsWorld` holds one `Rig` per player (capsule, Rapier
  character controller, grab state); every character and grab call takes a player index (default
  0, so single-player code is unchanged). `LabSim.step(cmd, cmd2)`; `setPlayerCount(1 | 2)`.
  Player capsules bump into each other; held props ignore every player capsule.
- **Shared grabs.** Two players may hold the same body. Holds are reference-counted; each holder's
  spring supports its share of the mass and stays under its own force cap, so forces add while each
  stays bounded. The cap is now **650 N per beaver**: up to ~66 kg alone; the 113 kg log needs two
  (2 × 650 N > 1,108 N) — the two-beaver carry of §2.4 and the Epic 3 gate, working locally now.
- **Voxel beaver bodies** for both players (two-player mode only), posed from the character
  (walk cycle from distance walked, carry pose when holding). They go through the global grid like
  everything else. A player's own camera sits inside their own head: every face of a voxel solid
  points outwards, so from inside it all faces are back faces and culled — no special exclusion
  needed (§2.2: own head excluded from the first-person camera).
- **Gamepads** via the browser Gamepad API, standard mapping. The first pad to press A drives player
  1 (merged with keyboard and mouse); the next pad joins as player 2 and turns on split screen; if
  it disconnects, player 2 leaves. Commands stay the same plain `PlayerCommand`.
- **Split screen** top/bottom (1280 × 400 per view on the Deck). Engine finding: `CameraFrame` (HDR,
  tone mapping, bloom, sky) ignores `camera.rect` — it renders the scene into a full-size target and
  composes over the whole back buffer, so the last camera covered both halves (measured). The
  working setup: both cameras keep a full rect with the half-screen aspect ratio, their scene targets
  are **half height** (no wasted pixels), and each compose pass gets its half as viewport and
  scissor with its clear off; re-applied every frame because the engine rebuilds passes on changes.
  Player 2's camera has its own `CameraFrame` and `DynamicSkyEffect` with `lighting = false` (only
  the main camera's sky lights the scene, as the engine documents).
- **Water in split screen** uses its sky reflection and no refraction: the engine's `Water` script
  renders its planar reflection and refraction for one camera only. Single-player keeps planar
  reflections. Per-player planar water would need a second water surface per camera layer and twice
  the reflection cost — an option to measure on the Deck first.

## Consequences

Split screen renders the world twice (shadows per camera, two frames); voxel reconstruction is
shared (one grid, one worker). The Deck's frame rate is unmeasured; start it on the Low preset and
7.5–10 cm voxels. The `CameraFrame` workaround touches engine internals (`renderPassCamera`,
`scenePass.scaleY`, `composePass.viewport`) and must be rechecked on engine upgrades; the split-screen
browser test catches a black half.
