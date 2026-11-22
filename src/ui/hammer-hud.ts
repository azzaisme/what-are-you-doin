/**
 * The hammer's part of the context prompt (Epic 5, #48): what F (LB, the Nail button) would do with
 * the timber at the crosshair, from the sim's nail preview code (src/sim/joints/graph.ts nailCode).
 */

import { REFUSAL_TEXT, refusalOfCode } from '../sim/joints/graph.ts';

export type HintInput = 'mouse' | 'pad' | 'touch';

const KEY: Record<HintInput, string> = { mouse: 'F', pad: 'LB', touch: 'Nail' };

/** '' when there is no timber in view, else e.g. "F to nail" or "nail: gap too wide". */
export function hammerHint(code: number, input: HintInput): string {
    if (code <= 0) return '';
    if (code === 1) return `${KEY[input]} to nail`;
    const r = refusalOfCode(code);
    // not timber at all: say nothing (the grab prompt covers it)
    if (r === 'not-timber' || r === 'none') return '';
    return `no nail: ${REFUSAL_TEXT[r]}`;
}

/** Joins a prompt and the hammer hint. */
export function withHammer(prompt: string, code: number, input: HintInput): string {
    const h = hammerHint(code, input);
    if (!h) return prompt;
    return prompt ? `${prompt} · ${h}` : h;
}
