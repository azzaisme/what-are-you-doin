# ADR 0013 — One big map: a streamed near world and a coarse far lattice

Status: accepted (owner request, 2026-11-22: "Let's do the rest of the levels (one big map). Make
sure it works for multiplayer and single player") · Date: 2026-11-22 · Amends: ADR 0011

## Context

The Timber Yard is 56 × 56 m and is built whole at load: about 300,000 columns at 5 cm. The Valley
holds all seven areas of the world map (Timber Yard, Shallow Creek, Forest Road, Gorge, Old
Industrial Works, Mountain Approach, Flower Summit) on one 224 × 224 m map. That is 16 times the
area. Built whole at 5 cm, it takes minutes and several gigabytes, and it draws far more than a
player can see.

## Decision

- **Near tiles.** The base lattice holds only the tiles near the cameras.
    - A tile is one static region's footprint (6.4 × 6.4 m). The level supplies
      `stream.buildTile(world, seed, rect, tile)`.
    - Tiles within `stream.radius` (36 m) of any local camera are built, nearest first, at most one
      per voxel frame.
    - The ring around the spawn (18 m) is built before the level opens.
    - A tile further than `radius + 2 × tile` from every camera is cleared: its columns are emptied
      cell-exactly, then its chunks are released and their ids reused.
- **Tiles build independently.** A tile writes only inside its own columns, and its build is the
  same whether its neighbours exist or not:
    - the rasterizer clips to the tile;
    - terrain tops come with a one-column margin;
    - slope comes from neighbouring column tops, not from neighbouring cells;
    - meshing does not touch neighbour chunks when a tile appears or goes.
- **The far lattice.** A fourth worker draws the whole map at 40 cm, with no objects.
    - It leaves out the columns under built near tiles, and rebuilds them with the same
      `buildTile` when the near tile goes.
    - It is sunk one cell and casts no shadows, so the near world always draws on top of it at the
      seam.
    - Its static regions are 25.6 m across (not 6.4 m), so the whole map is about 2,500 chunks in a
      few hundred draw calls.
    - Fog (30–260 m in the Valley) hides the far lattice's edge.
- **Each device streams for its own cameras.** The sim does not depend on what is drawn: physics
  uses the level's continuous height function and its static pieces, everywhere. So a guest builds
  the tiles around its own player, a split-screen device builds around both cameras, and the host
  never needs the guest's tiles.
- **Wider ranges.**
    - Snapshot positions use a 4 mm unit (±131 m; `SNAPSHOT_VERSION` 2).
    - Chunk coordinates have 11 bits on x / z and 8 on y.
    - The fine 1 cm lattice therefore reaches ±160 m across and ±18 m up; the route stays below
      16 m.
    - The physics safety box (`PhysicsWorld.killBox`) grows to the level's bounds. It used to be a
      fixed 60 × 60 m box that sent props beyond it back to their spawn.
- **Stages.** `rules.stages` lists the journey, in order:
    - Each stage has a goal square, a restart point for players and a spare-bucket point.
    - The bucket resting in the current stage's goal for half a second completes it.
    - `progress.step` counts the completed stages and is already in the host's state, so guests'
      objectives follow without a protocol change.

## Consequences

- A camera moving at walking pace never sees a missing tile: one tile per frame outpaces 5 m/s.
  A teleport shows the far lattice for a few seconds while the tiles nearby are built.
- Memory stays bounded wherever players go (the unit test walks 80 m out and back).
- Small levels are unchanged: without `stream` they build whole, as before.
