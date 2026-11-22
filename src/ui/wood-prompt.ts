/**
 * Prompts for logging (Epic 6): what a grab does at a stand tree or, with the axe in hand, at a
 * log, with the tree's cut so far. The cut comes from the stand marker in the snapshots, so a guest
 * sees the same number as the host.
 */

export type PromptInput = 'mouse' | 'pad' | 'touch';

/** Names for the HUD ("Holding the axe", "Grab short log"). */
export function woodLabel(name: string): string | null {
    if (name === 'axe') return 'axe';
    if (name.startsWith('felled-log')) return 'log (heavy)';
    if (name.startsWith('short-log')) return 'short log';
    if (/^tree-\d+$/.test(name)) return 'pine';
    if (name === 'sawmill') return 'sawmill lever';
    return null;
}

const isLog = (name: string) => name === 'log' || name.startsWith('extra-log') || name.startsWith('felled-log');

/**
 * The prompt for a stand tree or a log being cut, or null when the generic prompt applies.
 * `cut(name)` is a stand tree's cut so far (0-1). `names` are the player's bound grab and drop
 * controls (remappable, see input/bindings.ts); the defaults when omitted.
 */
export function woodPrompt(
    it: { holding: string | null; target: string | null },
    input: PromptInput,
    cut: (marker: string) => number,
    sawBeams = false,
    names?: { press: string; drop: string }
): string | null {
    const t = it.target;
    if (!t) return null;
    const press = names?.press ?? (input === 'mouse' ? 'Click' : input === 'pad' ? 'RT' : 'Grab');
    if (t === 'sawmill' && !it.holding)
        return sawBeams
            ? `Saw set to beams (one per log) · ${press} to set it to planks`
            : `Saw set to planks (three per log) · ${press} to set it to beams`;
    const drop = names?.drop ?? (input === 'mouse' ? 'Q' : input === 'pad' ? 'B' : 'drop');
    const tree = /^tree-\d+$/.test(t);
    const pct = tree ? Math.round(cut(t) * 100) : 0;
    const so = tree && pct > 0 ? ` · cut ${pct}%` : '';
    if (it.holding === 'axe') {
        if (tree) return `${press} to chop the pine${so} · ${drop} to put the axe down`;
        if (isLog(t)) return `${press} to buck the log into two short logs · ${drop} to put the axe down`;
        return null;
    }
    if (!it.holding && tree) return `${press} to chew the pine${so} · the axe is quicker`;
    return null;
}
