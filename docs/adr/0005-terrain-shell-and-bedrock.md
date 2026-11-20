# ADR 0005 — Terrain shell storage with implicit bedrock

Status: accepted (Epic 1) · Date: 2026-11-19

## Decision
Terrain columns store only a shell (top cell down to one below the lowest neighbour). Cells below
each column's stored bottom are **implicit bedrock**: solid for face exposure and AO, never stored
and never drawn. Border columns are filled to a cut base so the lab edge reads as a diorama cut.

## Measured effect (Node, River Lab)
Static triangles 1.32M → 0.46M overall together with merge-friendly colour patches and a terraced
distant ridge (unit faces 1.22M → 0.70M; downward faces 57k → 18k). 2,611 chunks, ~35 MB of typed
arrays.

## Consequences
Bedrock is static-only and lab-scoped. Destructible terrain (a non-goal) would need real storage.
