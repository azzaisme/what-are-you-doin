/** Level registry. */

import { levelFromData } from './data.ts';
import type { LevelDef, LevelId } from './level.ts';
import { riverLabLevel } from './river-lab.ts';
import { timberYardLevel } from './timber-yard.ts';
import { TUTORIAL_DATA } from './tutorial.ts';
import { valleyLevel } from './valley.ts';

export const tutorialLevel = levelFromData(TUTORIAL_DATA);

export const LEVELS: Record<string, LevelDef> = {
    tutorial: tutorialLevel,
    valley: valleyLevel,
    yard: timberYardLevel,
    lab: riverLabLevel
};

/** The levels a player picks from, in order. */
export const LEVEL_MENU: { id: string; name: string; note: string }[] = [
    { id: 'tutorial', name: 'Tutorial', note: 'Learn to move, grab, throw and bridge a gap' },
    {
        id: 'valley',
        name: 'The Valley · the whole journey',
        note: 'Seven areas, one map: from the Timber Yard to the flower on the summit'
    },
    { id: 'yard', name: 'Timber Yard (on its own)', note: 'Get the bucket across the creek' },
    { id: 'lab', name: 'River Lab', note: 'Tech demo and physics sandbox' }
];

export function getLevel(id: string | null | undefined): LevelDef {
    return (id && LEVELS[id]) || timberYardLevel;
}

export type { LevelDef, LevelId };
