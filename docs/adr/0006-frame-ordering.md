# ADR 0006 — Frame ordering: one director in postUpdate

Status: accepted (Epic 1) · Date: 2026-11-19

## Decision
A single `LabDirector` script does, in `postUpdate`: fixed-step simulation, first-person camera
placement, voxel-clock check, voxel reconstruction and mesh commit, reference-mode update. Engine
order is script `update` (orbit camera controls) → script `postUpdate` (director) → app `update`
event (Water script reads the final camera and updates its mirrored camera) → render. So the main,
shadow, reflection and refraction passes of a frame all see the same camera and the same completed
voxel frame; meshes are never half-updated.

Render time is one simulation tick behind the newest snapshot so it always interpolates between two
snapshots; the voxel frame time `floor(t·hz)/hz` is sampled from the same ring.
