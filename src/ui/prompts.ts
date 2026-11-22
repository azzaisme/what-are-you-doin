/**
 * The words hints and prompts use for controls, from the player's bindings (input/bindings.ts):
 * "Click to grab the bucket", "Holding the plank · click to release …", "Driving · W/S throttle …".
 * With the default bindings the text is what it always was. Pure functions of the bindings, so
 * tests can check what a rebind does to them.
 */

import { actionForKey, keyLabel, padText } from '../input/bindings.ts';
import type { Action, Bindings, PadAction } from '../input/bindings.ts';

export interface ControlNames {
    /** The first key bound to an action, as a prompt says it ('Click', 'E', 'Space'). */
    keyVerb(a: Action): string;
    /** Every key bound to an action, joined ('click or E'). */
    keysVerb(a: Action): string;
    /** The pad buttons bound to an action ('RT', 'A or X'). */
    padVerb(a: PadAction): string;
    /** The four move keys as one word when they are letters ('WASD'), else listed. */
    moveKeys(): string;
    /** 'Click' → 'click' (for the middle of a sentence). */
    lower(s: string): string;
    /** A key name in <kbd>, escaped. */
    kbd(s: string): string;
    /** A fixed hotkey's hint (' · V orbit'), or nothing while that key is bound to a game action. */
    hotkey(code: string, what: string, markup?: boolean): string;
}

/** Names that follow the bindings as they change (the object is read on every call). */
export function controlNames(b: Bindings): ControlNames {
    const lower = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
    const kbd = (s: string) =>
        `<kbd>${s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)}</kbd>`;
    return {
        keyVerb(a) {
            const code = b.keys[a].find(Boolean) ?? '';
            if (code === 'Mouse0') return 'Click';
            if (code === 'Mouse2') return 'Right-click';
            if (code === 'WheelUp' || code === 'WheelDown') return 'Wheel';
            return code ? keyLabel(code) : 'Unbound';
        },
        keysVerb(a) {
            const names = b.keys[a].filter(Boolean).map((c) => (c === 'Mouse0' ? 'click' : keyLabel(c)));
            return names.length ? names.join(' or ') : 'unbound';
        },
        padVerb: (a) => padText(b, a).replace(' / ', ' or '),
        moveKeys() {
            const k = (['forward', 'left', 'back', 'right'] as const).map((a) =>
                keyLabel(b.keys[a].find(Boolean) ?? '')
            );
            return k.every((x) => /^[A-Z0-9]$/.test(x)) ? k.join('') : k.join('/');
        },
        lower,
        kbd,
        hotkey(code, what, markup = true) {
            if (actionForKey(b, code)) return '';
            const k = keyLabel(code);
            return ` · ${markup ? kbd(k) : k} ${what}`;
        }
    };
}

/** What the player is doing or looking at (sim.interaction, or the host's HUD for a guest). */
export interface PromptState {
    holding: string | null;
    target: string | null;
    shared: boolean;
    driving: boolean;
    seat: number;
}

/**
 * The prompt under the crosshair for keyboard and mouse or for a pad. `wood` gives the logging and
 * sawmill prompt (Epic 6) for the bound grab and drop names, or null where the generic one applies.
 */
export function interactionPrompt(
    it: PromptState,
    pad: boolean,
    n: ControlNames,
    propLabel: (name: string) => string,
    wood: (names: { press: string; drop: string }) => string | null = () => null
): string {
    const { keyVerb, keysVerb, padVerb, lower } = n;
    const both = it.shared ? ' together' : '';
    if (it.driving)
        return pad
            ? `Driving · left stick drive and steer · ${padVerb('jump')} brake · ${padVerb('drop')} recover · ${padVerb('grab')} get out`
            : `Driving · ${keyVerb('forward')}/${keyVerb('back')} throttle · ${keyVerb('left')}/${keyVerb('right')} steer · ${keyVerb('jump')} brake · ${keyVerb('drop')} recover · ${keysVerb('grab')} to get out`;
    if (it.seat >= 0)
        return pad ? `Riding along · ${padVerb('grab')} get out` : `Riding along · ${keysVerb('grab')} to get out`;
    if (it.target === 'ute') return pad ? `${padVerb('grab')} to drive the ute` : `${keyVerb('grab')} to drive the ute`;
    const w = wood(
        pad ? { press: padVerb('grab'), drop: padVerb('drop') } : { press: keyVerb('grab'), drop: keyVerb('drop') }
    );
    if (w) return w;
    if (it.holding)
        return pad
            ? `Holding ${propLabel(it.holding)}${both} · ${padVerb('grab')} release · ${padVerb('throw')} throw · ${padVerb('drop')} drop`
            : `Holding ${propLabel(it.holding)}${both} · ${lower(keyVerb('grab'))} to release · ${lower(keyVerb('throw'))} to throw · ${lower(keyVerb('reachFar'))} to adjust reach`;
    if (it.target)
        return pad
            ? `${padVerb('grab')} to grab ${propLabel(it.target)}`
            : `${keyVerb('grab')} to grab ${propLabel(it.target)}`;
    return '';
}
