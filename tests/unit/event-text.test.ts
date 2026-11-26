/**
 * Every message the game can show as a toast reaches guests whole: the host sends each event's text
 * cut to 120 characters (`HostSession`), so no message in the game may be longer.
 *
 * The messages are written in the simulation and the level definitions (src/sim, src/levels), as
 * string and template literals, some joined with `+`. This reads every one there: a template's
 * `${...}` counts as 20 characters (a stage, player or prop name), so a message passes only with
 * room for that.
 *
 * An assumption, not checked here: no value put into a message is longer than 20 characters. The
 * longest today are stage names, put into messages such as "a spare is waiting at the … start": the
 * longest is "Old Industrial Works", exactly 20. A longer one could make a message that passes here
 * arrive cut.
 */

import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const EVENT_TEXT_MAX = 120;
/** What a `${...}` in a message is taken to add. */
const SUBSTITUTION = 20;

function files(dir: string): string[] {
    return fs.readdirSync(dir).flatMap((f) => {
        const p = path.join(dir, f);
        return fs.statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
    });
}

/** A literal's longest text (null: not a string literal or a `+` of them). */
function text(n: ts.Node): string | null {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
    if (ts.isTemplateExpression(n))
        return n.head.text + n.templateSpans.map((s) => 'x'.repeat(SUBSTITUTION) + s.literal.text).join('');
    if (ts.isParenthesizedExpression(n)) return text(n.expression);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const a = text(n.left);
        const b = text(n.right);
        if (a !== null || b !== null) return (a ?? 'x'.repeat(SUBSTITUTION)) + (b ?? 'x'.repeat(SUBSTITUTION));
    }
    return null;
}

/** Every message-like literal (words with spaces) in the files, longest form, with where it is. */
function messages(dirs: string[]): { at: string; text: string }[] {
    const out: { at: string; text: string }[] = [];
    for (const f of dirs.flatMap(files)) {
        const sf = ts.createSourceFile(f, fs.readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true);
        const visit = (n: ts.Node): void => {
            const t = text(n);
            if (t !== null) {
                // the whole expression: its parts are not visited again
                if (/\s/.test(t))
                    out.push({ at: `${f}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`, text: t });
                return;
            }
            ts.forEachChild(n, visit);
        };
        visit(sf);
    }
    return out;
}

describe('toast messages fit what the host sends', () => {
    const all = messages(['src/sim', 'src/levels']);

    it('reads the game’s messages (the long hazard warnings among them)', () => {
        expect(all.length).toBeGreaterThan(100);
        expect(all.some((m) => m.text.includes('The creek is rising'))).toBe(true);
        expect(all.some((m) => m.text.includes('handbrake is creeping off'))).toBe(true);
    });

    it(`no message is longer than ${EVENT_TEXT_MAX} characters`, () => {
        const long = all
            .filter((m) => m.text.length > EVENT_TEXT_MAX)
            .map((m) => `${m.at} (${m.text.length}): ${m.text}`);
        expect(long).toEqual([]);
    });
});
