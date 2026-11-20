/** Level registry. */

import type { LevelDef, LevelId } from './level.ts';
import { riverLabLevel } from './river-lab.ts';
import { timberYardLevel } from './timber-yard.ts';

export const LEVELS: Record<LevelId, LevelDef> = { yard: timberYardLevel, lab: riverLabLevel };

export function getLevel(id: string | null | undefined): LevelDef {
    return id === 'lab' ? riverLabLevel : id === 'yard' ? timberYardLevel : timberYardLevel;
}

export type { LevelDef, LevelId };
