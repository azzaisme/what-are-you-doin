# ADR 0002 — Composite policy, static/dynamic mesh split, chunk and region sizes

Status: accepted (Epic 1) · Date: 2026-11-19

## Decision
- **Storage:** sparse 16³-cell chunks, allocated on first write. Cell keys are small integers
  (chunk id × 4096 + local index) so hot maps never hold heap numbers.
- **Layers:** a static layer (written once) and a dynamic composite layer. Each dynamic object keeps
  its own occupancy map; changed cells are found by symmetric difference and re-resolved.
- **Winner policy:** within one object, higher part priority wins (hat over head), ties keep the
  first part. Across objects, higher object priority wins, then lower id. A dynamic cell overrides a
  static cell. When the winner leaves, the next contributor or the static voxel shows again; static
  voxels are never erased. Overlaps are counted as telemetry (debug panel).
- **Meshes:** static regions of 64×32×64 cells emit static cells not overridden by dynamic ones,
  exposed against the static layer only, so they rebuild only when static data or an override
  changes. Dynamic chunks (16³) emit dynamic cells exposed against the composite. This never emits
  the same position+direction twice (unit-tested); a static face pointing into a dynamic cell is
  enclosed and invisible.
- **Greedy merging** joins coplanar faces only with identical material, shade and AO pattern.
- **Render units** are created once with all three surface-class meshes and instances; the render
  component destroys instances when its list is replaced, so lists are assigned exactly once.
  Meshes get their full vertex format before an instance exists (the shader variant depends on it).

## Consequences
Typical moving content touches ~30 dynamic chunks per voxel frame (measured). Static meshing happens
at load (~1.1–1.3 s in Node / browser on the sandbox CPU).
