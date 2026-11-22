# ADR 0014 — Logging and the sawmill: static trees until felled, pooled pieces, state in snapshots

Status: proposed (Epic 6, issue #13) · Date: 2026-11-22

## Context

Epic 6 needs trees that can be cut down, logs that two beavers can move, a sawmill that turns a log
into planks exactly once, resources that come back, simple tools and a way to do it alone. Until
now every tree was static scenery: voxels in the static layer, fixed colliders. The world must stay
deterministic (60 Hz host simulation), guests run no physics, the voxel world is rebuilt per device
from snapshots, and a moving object is re-rasterized every voxel frame.

## Decision

- **Only a stand can be cut** (no full ecosystem destructibility). A level lists its stand in
  `LevelDef.forestry` (`src/levels/forestry.ts`): six pines in the Timber Yard (and the Valley's copy
  of it), 3 m apart on levelled ground, each with a hi-vis band. The rest of the forest stays
  scenery.
- **A standing stand tree stays static.** Drawn into the static layer by the level build (free to
  render), with one trunk collider and no foliage collision (§2.5: "remove or simplify foliage
  collision"; needle cones also blocked view rays and snagged falling trunks).
- **The cut is sim state, shown and shared through a marker entity.** One `tree-N` entity per stand
  tree sits at its foot. Its animation channels carry the cut (0–1) and the state (standing or
  felled); its parts draw the growing pale band of the cut. It travels in the snapshots like any
  entity, so guests and the voxel worker learn of a felled or regrown tree with no new message.
- **The worker re-draws one tree.** When a marker's state changes, the base lane clears that tree's
  cells from the static layer (tree materials only, inside the tree's own volumes:
  `clearStandTree`, using the new `VoxelWorld.clearStatic`/`forEachCell`) and draws a stump, or
  draws the tree again. A streamed tile redraws its stand trees standing when built, then the
  marker state is applied again. The far lattice keeps showing stand trees standing.
- **Felling switches to physics once.** The trunk above the 0.3 m cut is exactly the props' log
  (r 0.2 m, 2 m), so the felled trunk is a pooled log body placed where the trunk stood and given a
  slow start. Its starting tilt is the tree's lean (its weight: `StandTree.lean`, drawn leaning,
  up to about 6°) plus a 4° push away from the side it was cut from, so the fall is predictable and
  the toast can say where (measured: within 1.4° of the prediction from eight sides). A tree leaning
  more than the push falls its own way. Once down (the crown has broken off) the log's spin
  damping goes from 0.4 to 20, so it stops rolling within about 2 s instead of drifting sideways
  for many seconds (a cylinder on flat ground has no rolling resistance). The crown is a separate non-colliding entity that
  rides the log and breaks off (a needle burst) once the trunk has tipped 62°. It is drawn on the
  coarse lattice (ADR 0011) because of its size, so it costs little for the second it exists.
- **Pools, not spawning.** Felled logs (6, each with a crown), short logs (6) and sawn planks (15)
  are entities created up front with disabled bodies. Enabling one never reorders the physics world,
  the entity table is the same on every device, and snapshots stay small (pieces not in use are
  hidden, so they are not sent). Sawn planks are named `extra-plank-12` on: ordinary planks to
  everything else (fastening, effects, prompts).
- **The sawmill's interlock is the body leaving the world.** A log lying still, aligned and unheld in
  the guide for 0.5 s is taken: its body is disabled at once, so nothing can grab, push or feed it
  again, and the sim moves its entity through the blade. Safety: the blade stops while a player is
  in its guard zone; planks only come out where a box query finds the rack clear (one per tick, so
  each query sees the last). A log makes 3 planks, a short log 1. A lever on the machine switches
  it to beams: one 3.2 m beam (`beam-12` on) from a whole log.
- **Resources come back.** A stump regrows after 45 s once its log is 3 m away (or sawn) and nobody
  stands there; the level's own logs come back to their pile 20 s after being sawn; pooled pieces
  lost in the creek return to their pool.
- **Solo.** A whole log (113 kg) still needs two beavers (650 N each). With the axe, one beaver
  bucks a lying log into two 57 kg short logs and carries them to the sawmill.

## Consequences

- No full-level rebuild and no per-frame cost for standing trees; a felling re-meshes a few static
  regions once.
- Snapshot size: +193 bytes in the Valley at rest (927 bytes; 1,896 base64 characters with every
  pooled piece out), well inside the 4 KiB presence budget.
- Pools can run out: with 15 sawn planks lying about the sawmill waits ("use some first"), and with
  six felled logs lying about no tree can be felled until one is sawn. Players are told why.
- A 2 m log is sawn into 2.4 m planks or a 3.2 m beam (the game's sizes, not a sawyer's). The
  yard's 2.6 m creek gap needs beams, which the planks deck.
- The gate is tested by player input only (`tests/unit/forestry-gate.test.ts`), including online
  through the real host and guest sessions.
