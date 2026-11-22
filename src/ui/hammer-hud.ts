/**
 * The hammer's part of the context prompt (Epic 5, #48): what the nail control (F, LB and the Nail
 * button by default; remappable) would do with the timber at the crosshair, from the sim's nail
 * preview code (src/sim/joints/graph.ts nailCode).
 */

import { REFUSAL_TEXT, refusalOfCode } from '../sim/joints/graph.ts';

/**
 * '' when there is no timber in view, else e.g. "F to nail" or "no nail: gap too wide". `key` names
 * the control bound to nailing ('F', 'LB', 'Nail').
 */
export function hammerHint(code: number, key: string): string {
    if (code <= 0) return '';
    if (code === 1) return `${key} to nail`;
    const r = refusalOfCode(code);
    // not timber at all: say nothing (the grab prompt covers it)
    if (r === 'not-timber' || r === 'none') return '';
    return `no nail: ${REFUSAL_TEXT[r]}`;
}

/** Joins a prompt and the hammer hint. */
export function withHammer(prompt: string, code: number, key: string): string {
    const h = hammerHint(code, key);
    if (!h) return prompt;
    return prompt ? `${prompt} · ${h}` : h;
}
