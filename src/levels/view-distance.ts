/**
 * How far around the cameras a streamed level builds its near world, for a quality preset: the High
 * preset uses the level's `radius`, Low its `lowRadius` (about half the tiles; measured in
 * tests/unit/view-distance.test.ts). The fog starts a little inside it, so the fine ground thins into
 * it before the coarse far lattice takes over. (It is light there: linear fog to the level's fog end,
 * a few percent at the near world's edge.)
 *
 * Pure module (no engine).
 */

import type { LevelStream } from './level.ts';

export function viewDistance(stream: LevelStream, quality: 'high' | 'low'): { radius: number; fogStart: number } {
    const radius = quality === 'low' ? (stream.lowRadius ?? stream.radius) : stream.radius;
    return { radius, fogStart: Math.min(stream.fog.start, radius - 6) };
}
