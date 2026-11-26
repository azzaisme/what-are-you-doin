# ADR 0011 — Per-item cell sizes: a family of world-aligned lattices

Status: accepted (owner request, 2026-11-21: "big things have big blocks and small things have
small blocks, all the way down to 1x1x1") · Date: 2026-11-21 · Amends: design doc §2.4 and ADR 0007

## Context

Everything solid was drawn on one global lattice (5 cm by default, 5–10 cm per player). The bucket
is about 30 cm across, so at 5 cm it was six cells wide. Its wall had to be drawn 8 cm thick to show
up, which left an opening one or two cells wide, mostly hidden by the handle. The owner could not
tell whether it held water. It also held none: the asset had a water level but no water part.

## Decision

- **Three lattices, one origin.** Every object is drawn on one of these:
    - **fine**: 1 cm;
    - **base**: the player's voxel size setting, 5 cm by default (5–10 cm);
    - **coarse**: twice the base, up to 20 cm.

    All three share the world origin and axes. Cubes still never rotate or slide, there is no entity
    per voxel, and render meshes never move. The game now keeps one lattice per size class instead
    of one lattice in total.

- **The tier comes from size** (`src/assets/cell-tier.ts`), so a new asset needs no table entry:
    - **fine** when the asset's longest side at rest is at most 0.6 m and its bounding box holds at
      most 80,000 1 cm cells (it is re-rasterized every voxel frame). This covers the bucket and the
      ragdoll's head, arms, legs and tail.
    - **coarse** when its longest side is at least 3 m and its shortest at least 1 m. This covers the
      ute.
    - **base** for everything else: beavers, planks, beams, logs, the crate, the ball and the
      windsock.
- **The world stays on the base lattice.** Terrain, trees, rocks, static pieces and particles are
  not moved to a coarser grid: the owner asked for 5 cm, and the ground is what the player looks at
  most.
- **One voxel worker per lattice ("lane").** The cell size is a module-level constant fixed before
  any voxel module loads (ADR 0007), and each worker is its own module realm. So each lane is the
  existing worker run at its own size and given the list of entity ids it draws. Only the base lane
  builds the static world and draws particles. The voxel core is unchanged.
- **Frames land together.** The client sends each voxel frame to every lane with the same sampled
  states and applies the meshes only when every lane has returned it. A 1 cm bucket never lags the
  5 cm beaver carrying it. Stats are summed over lanes (counts) or taken from the slowest lane
  (times). Grid checks run per lattice; each renderer checks its own vertices against its own cell
  size.
- **Assets may draw themselves for their lattice.** The bucket's wall and handle are real
  thicknesses on the 1 cm lattice (1.5 cm wall) and exaggerated on 5–10 cm cells. It now has a
  water part in a new palette colour, `bucket-water`.
- `?tiers=off` draws everything on the base lattice (for comparison and debugging).

## Consequences

- The bucket reads as a bucket with water in it. The ute is chunkier at 10 cm.
- **Cost:** measured in the Timber Yard on SwiftShader, the median voxel frame was 26 ms with tiers
  on against 37 ms with them off: the lattices build in parallel. Each extra lane adds a worker
  (memory) and up to three more materials' draw calls for its meshes.
- **Overlaps across lattices resolve by priority** (amended 2026-11-22, #107). At first they did
  not: a fine object and a base object in the same space simply intersected, sorted by depth.
    - Each lattice's worker also rasterizes, at its own cell size, every object of another lattice
      that outranks one of its own: priority, then lower id, as within a lattice, except that your
      own first-person limbs win ties against other lattices' objects (with one lattice for
      everything, `?tiers=off`, there are no masks and the lower id wins, as before).
    - Such a mask tests only the cells this lattice's outranked objects hold, inside one box per
      part: where that part's bounds meet the bounds of the parts it outranks. It tests cell
      centres only, exactly as the rasterizer's 'center' sampling would.
    - Where a mask wins a cell, this lattice leaves the cell empty and only the winner's lattice
      draws it: the 1 cm bucket hanging in the 5 cm paw shows its handle, not the paw through it.
    - A cell gives way when its centre lies inside the winner, so the seam is within half a cell of
      the true surface.
    - Only objects take part: the static world stays on the base lattice, and dynamic-over-static
      still resolves there.
    - **Mask work** (amended 2026-11-26, after the audit of 6843c88) is counted in units: one per
      cell scanned (only the outranked objects whose bounds meet the mask's box, chunks outside it
      skipped), 4 per centre sample, 1,000 per chunk whose cells it changes. Calibrated on the 1 cm
      fine lane (Xeon, 2.1 GHz): 0.036–0.054 µs a unit across the scenes measured, samples (about
      0.2 µs each) most of it; meshing gets cheaper with masks, hidden cells have no faces.
    - **Budget, by quality preset** (`MASK_PRESETS`; 1 cm lattices exist at both, phones included):
      High `max(50,000, 4 × the lattice's own cells)`, capped at 150,000 units (about 8 ms of worker
      time on that machine); Low a fixed 50,000 (about 2.7 ms).
        - Masks are served highest priority first, each estimated by what it did last frame if it
          ran, else by the scan it certainly needs. One that would overrun what is left is skipped
          that frame (its object and this lattice's intersect again). Hysteresis: one that ran last
          frame, and at High the first served, may use the whole budget, any other new one 80 %.
        - The budget is enforced on the work as it is done: a mask that would go over it is
          abandoned, cleared, and waits 20 voxel frames. So a frame's mask work never exceeds it;
          clearing masks that drop out is counted apart.
        - The stats count skipped masks (`maskSkipped`), the work (`maskCells`), the budget
          (`maskLimit`, on lattices that can mask) and rejected mask parts (`maskRejected`).
    - **The trade-off:** a whole beaver deep in the 1 cm ragdoll costs more than the High cap (on
      the real fine lane about 11 ms touching its head, 23 ms with the head inside it). So at High,
      as at Low, such deep whole-beaver overlaps on the fine lane intersect as before. Frame cost
      matters more; only the debug stress scene and pile-ups make them. The small cases the
      priority is for (the 1 cm bucket in a 5 cm paw) cost a few thousand units and are kept.
    - **Cost** (`scripts/bench-lattice.ts`, everything moving, masks off and on side by side; the
      1 cm scenes on the real fine lane): at most +3.5 ms at High (three players beside the
      ragdoll, 3 masks), +1.1 ms at Low; the bucket in the paw +0.25 ms. The work is voxel-worker
      time: the main thread only uploads the remeshed cut (+0.2 ms median measured in the browser).
    - `?masks=off` turns it off, for comparisons.
- **The fine lattice reaches ±160 m across and ±18 m up** (its chunk coordinates are limited;
  widened from ±80 m for the Valley). Beyond that, a fine object is not drawn instead of crashing
  the worker. Levels stay within ±125 m across and below 18 m.
- The debug grid-line overlay still draws the base lattice on every surface.
