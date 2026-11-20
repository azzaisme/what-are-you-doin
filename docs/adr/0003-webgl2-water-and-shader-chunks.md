# ADR 0003 — WebGL2 baseline, engine Water script, per-material GLSL chunks

Status: accepted (Epic 1) · Date: 2026-11-19

## Decision

- The device is pinned to WebGL2 (design doc §4.1). WebGPU is a later, measured option.
- The river uses the engine's shipped `Water` script (playcanvas 2.24.2 `scripts/esm/water.mjs`):
  `PlanarRenderer` mirrors the main camera about the water plane, clips with an oblique projection,
  and renders the same layers as the main camera — including the voxel meshes of the same voxel
  frame — into an offscreen texture. Refraction and depth-based shallow colour/foam are on in the
  high preset.
- Voxel materials override `litUserDeclarationPS` / `litUserMainEndPS` per material (GLSL only, which
  is why WebGL2 is pinned) for the debug grid overlay. Because this replaces the Water script's
  global chunk for those materials, its underwater caustics code is reproduced there.
- The Water script installs a global `fogPS`; it keeps standard fog for materials without
  `WATER_HEIGHT_FOG`, so ordinary distance fog is used and the dynamic sky's haze is not.

## Consequences

Moving to WebGPU needs WGSL versions of the two chunks. The water is the one smooth surface
exception, as listed in the design doc §3.3.
