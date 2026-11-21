/** The level designer's starting point for a new level. */

import { LEVEL_DATA_VERSION } from './data.ts';
import type { LevelData } from './data.ts';

/** A small starter: a meadow, a ditch, a plank, the bucket, and a goal across. */
export function starterLevel(): LevelData {
    return {
        v: LEVEL_DATA_VERSION,
        id: 'custom',
        name: 'My level',
        size: { minX: -28, maxX: 28, minZ: -42, maxZ: 14 },
        ground: { base: 0.3, noise: 0.3, seed: 3 },
        features: [{ type: 'ditch', x1: -5, z1: -2, x2: 5, z2: -2, width: 1.8, depth: 1.1 }],
        pieces: [],
        trees: [
            { x: -7, z: 4, scale: 1.2, yaw: 0.4, kind: 'oak' },
            { x: 8, z: -6, scale: 1.1, yaw: 1.3 }
        ],
        rocks: [{ x: 5, z: 5, size: 0.5, yaw: 0.6 }],
        props: [
            { name: 'plank', x: 1.5, z: 1.2, yaw: Math.PI / 2 },
            { name: 'bucket', x: -1.5, z: 2.5 }
        ],
        spawn: { x: 0, z: 8, yaw: 0 },
        goal: { minX: -2, maxX: 2, minZ: -10, maxZ: -6 },
        objective: 'Get the bucket to the goal',
        sun: { elevation: 18, azimuth: 130 },
        wind: { dir: 0.8, base: 1, gust: 2 }
    };
}
