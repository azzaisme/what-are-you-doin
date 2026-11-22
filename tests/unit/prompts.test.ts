import { describe, expect, it } from 'vitest';

import { PAD_BUTTONS, bindKey, bindPad, defaultBindings } from '../../src/input/bindings.ts';
import { controlNames, interactionPrompt } from '../../src/ui/prompts.ts';
import type { PromptState } from '../../src/ui/prompts.ts';
import { woodPrompt } from '../../src/ui/wood-prompt.ts';

const none: PromptState = { holding: null, target: null, shared: false, driving: false, seat: -1 };
const label = (n: string) => `the ${n}`;

describe('prompts follow the bindings', () => {
    it('read as they always did with the default bindings', () => {
        const n = controlNames(defaultBindings());
        expect(interactionPrompt({ ...none, target: 'bucket' }, false, n, label)).toBe('Click to grab the bucket');
        expect(interactionPrompt({ ...none, target: 'bucket' }, true, n, label)).toBe('RT to grab the bucket');
        expect(interactionPrompt({ ...none, holding: 'plank' }, false, n, label)).toBe(
            'Holding the plank · click to release · right-click to throw · wheel to adjust reach'
        );
        expect(interactionPrompt({ ...none, driving: true, seat: 0 }, false, n, label)).toBe(
            'Driving · W/S throttle · A/D steer · Space brake · Q recover · click or E to get out'
        );
        expect(interactionPrompt({ ...none, driving: true, seat: 0 }, true, n, label)).toBe(
            'Driving · left stick drive and steer · A brake · B recover · RT get out'
        );
        expect(n.moveKeys()).toBe('WASD');
        expect(n.hotkey('KeyV', 'orbit', false)).toBe(' · V orbit');
    });

    it('name the rebound key or button, the moment it changes', () => {
        const b = defaultBindings();
        const n = controlNames(b);
        bindKey(b, 'grab', 0, 'KeyR'); // grab: R or E (left click no longer grabs)
        bindKey(b, 'forward', 0, 'KeyZ'); // AZERTY-style
        bindPad(b, 'grab', 0, PAD_BUTTONS.RB); // RB was throw: throw is unbound now
        expect(interactionPrompt({ ...none, target: 'bucket' }, false, n, label)).toBe('R to grab the bucket');
        expect(interactionPrompt({ ...none, target: 'bucket' }, true, n, label)).toBe('RB to grab the bucket');
        expect(interactionPrompt({ ...none, holding: 'plank' }, true, n, label)).toBe(
            'Holding the plank · RB release · unbound throw · B drop'
        );
        expect(interactionPrompt({ ...none, seat: 1 }, false, n, label)).toBe('Riding along · R or E to get out');
        expect(n.moveKeys()).toBe('ZASD');
    });

    it('hand the bound grab and drop to the logging and sawmill prompts (Epic 6)', () => {
        const b = defaultBindings();
        const n = controlNames(b);
        bindKey(b, 'grab', 0, 'KeyF');
        bindKey(b, 'drop', 0, 'KeyX');
        const axe = { ...none, holding: 'axe', target: 'tree-1' };
        const wood = (it: PromptState, pad: boolean) =>
            interactionPrompt(it, pad, n, label, (names) =>
                woodPrompt(it, pad ? 'pad' : 'mouse', () => 0.5, false, names)
            );
        expect(wood(axe, false)).toBe('F to chop the pine · cut 50% · X to put the axe down');
        bindPad(b, 'drop', 0, PAD_BUTTONS.Y);
        expect(wood(axe, true)).toBe('RT to chop the pine · cut 50% · Y to put the axe down');
        // and without names (the old callers), the defaults
        expect(woodPrompt(axe, 'mouse', () => 0)).toBe('Click to chop the pine · Q to put the axe down');
    });

    it('hide a fixed hotkey hint while that key is bound to a game action', () => {
        const b = defaultBindings();
        const n = controlNames(b);
        bindKey(b, 'jump', 1, 'KeyV');
        expect(n.hotkey('KeyV', 'orbit')).toBe('');
        expect(n.hotkey('KeyH', 'hide UI')).toBe(' · <kbd>H</kbd> hide UI');
    });
});
