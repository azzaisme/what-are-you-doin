# ADR 0004 — Default sampling policy, material precedence, painted facial details

Status: proposed default, for owner review · Date: 2026-11-19

## Context

A 10 cm board at 45° can miss centre samples (§5.4). A 14-cell beaver has features smaller than a
cell (eyes, nose, teeth) that must neither vanish nor be drawn with smaller voxels.

## Decision

- Default policy **coverage50**: 2×2×2 sub-samples, a cell is occupied when ≥ 4 of 8 are inside.
  In tests it keeps the 10 cm plank in one 26-connected piece over a full turn about a skew axis,
  within 30–110 cells of a nominal 48. Per-part overrides: `coverage25` for the hat brim and tail,
  `conservative` for the bucket handle. All four policies stay selectable in the debug panel.
- **Material precedence** (palette): among the inside samples of a cell, the material with the
  highest precedence wins (eye > nose/tooth > lights > stripe > glass > hard hat > others). Detail
  materials therefore survive sub-cell placement deterministically.
- **Painted details:** eyes, nose and teeth are regions of the head/muzzle material fields, not
  separate boxes, so they always land on surface cells. The face is laid out by cell rows (dome,
  brim, eyes, muzzle+nose, teeth); the eye windows are 0.21 m apart so a fur cell always separates
  them. Unit test: at 72 headings × 4 walk phases, each eye has 1–3 exposed cells, and teeth, nose,
  hat, vest, tail and muzzle are present.
- A cheap, output-identical early-out skips candidates whose centre is farther outside the local
  bounds than any sub-sample can reach (231k → 90k samples per frame, same 6,006 cells).

## Open

Hysteresis was not adopted (history-dependent poses). Owner to judge flicker at 12/20/30/60 Hz.
