import { describe, expect, it } from 'vitest';

import {
    ACTIONS,
    BINDINGS_STORAGE_KEY,
    PAD_ACTIONS,
    PAD_BUTTONS,
    actionForKey,
    bindKey,
    bindPad,
    bindableKey,
    defaultBindings,
    keyLabel,
    keysText,
    loadBindings,
    padLabel,
    sanitizeBindings,
    saveBindings
} from '../../src/input/bindings.ts';
import { PadPlayer } from '../../src/input/gamepad.ts';
import { ACTION_DROP, ACTION_NONE, ACTION_POUR } from '../../src/sim/commands.ts';

function memory() {
    const data = new Map<string, string>();
    return {
        data,
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, v),
        removeItem: (k: string) => void data.delete(k)
    };
}

function pad(pressed: number[] = []): Gamepad {
    const buttons = Array.from({ length: 17 }, (_, i) => ({
        pressed: pressed.includes(i),
        touched: pressed.includes(i),
        value: pressed.includes(i) ? 1 : 0
    }));
    return {
        axes: [0, 0, 0, 0],
        buttons,
        connected: true,
        index: 0,
        id: 'test',
        mapping: 'standard'
    } as unknown as Gamepad;
}

describe('remappable controls', () => {
    it('defaults: every key and button does one thing, and the menu keys are not bindable', () => {
        const b = defaultBindings();
        const keys = ACTIONS.flatMap((a) => b.keys[a]).filter(Boolean);
        expect(new Set(keys).size).toBe(keys.length);
        const buttons = PAD_ACTIONS.flatMap((a) => b.pad[a]).filter((i) => i >= 0);
        expect(new Set(buttons).size).toBe(buttons.length);
        expect(actionForKey(b, 'KeyW')).toBe('forward');
        expect(actionForKey(b, 'Mouse0')).toBe('grab');
        expect(actionForKey(b, 'KeyE')).toBe('grab');
        expect(actionForKey(b, 'KeyZ')).toBeNull();
        for (const k of ['Escape', 'F3', 'Tab']) expect(bindableKey(k)).toBe(false);
        expect(bindableKey('KeyZ')).toBe(true);
        expect(buttons).not.toContain(PAD_BUTTONS.MENU);
    });

    it('binding a key takes it off the action that had it, and says which', () => {
        const b = defaultBindings();
        expect(bindKey(b, 'jump', 1, 'KeyW')).toBe('forward');
        expect(b.keys.jump).toEqual(['Space', 'KeyW']);
        expect(b.keys.forward).toEqual(['', 'ArrowUp']);
        expect(actionForKey(b, 'KeyW')).toBe('jump');
        // moving a key between an action's own slots is no conflict
        expect(bindKey(b, 'jump', 0, 'KeyW')).toBeNull();
        expect(b.keys.jump).toEqual(['KeyW', '']);
        // clearing, and refusing what can't be bound
        expect(bindKey(b, 'jump', 0, '')).toBeNull();
        expect(b.keys.jump).toEqual(['', '']);
        expect(bindKey(b, 'jump', 0, 'Escape')).toBeNull();
        expect(b.keys.jump).toEqual(['', '']);
        // pad buttons the same way; Start stays the menu's
        const p = defaultBindings();
        expect(bindPad(p, 'jump', 0, PAD_BUTTONS.B)).toBe('drop');
        expect(p.pad.drop).toEqual([-1, -1]);
        expect(bindPad(p, 'jump', 1, PAD_BUTTONS.MENU)).toBeNull();
        expect(p.pad.jump).toEqual([PAD_BUTTONS.B, -1]);
    });

    it('saves only what differs, loads back exactly, and survives junk and duplicates', () => {
        const s = memory();
        const b = defaultBindings();
        saveBindings(s, b);
        expect(s.data.has(BINDINGS_STORAGE_KEY)).toBe(false);
        bindKey(b, 'jump', 0, 'KeyF');
        bindPad(b, 'throw', 0, PAD_BUTTONS.LB);
        saveBindings(s, b);
        expect(JSON.parse(s.data.get(BINDINGS_STORAGE_KEY)!)).toEqual({
            keys: { jump: ['KeyF', ''] },
            pad: { throw: [PAD_BUTTONS.LB, -1] }
        });
        expect(loadBindings(s)).toEqual(b);
        // back to defaults: nothing stored
        saveBindings(s, defaultBindings());
        expect(s.data.has(BINDINGS_STORAGE_KEY)).toBe(false);
        // junk
        s.setItem(BINDINGS_STORAGE_KEY, '{oops');
        expect(loadBindings(s)).toEqual(defaultBindings());
        expect(loadBindings(null)).toEqual(defaultBindings());
        const odd = sanitizeBindings({
            keys: { jump: ['KeyW', 42], nonsense: ['KeyX', ''], grab: 'KeyE', drop: ['Escape', '<script>'] },
            pad: { jump: [PAD_BUTTONS.MENU, 99], throw: [1.5, PAD_BUTTONS.A] },
            __proto__: { keys: { forward: ['KeyZ', ''] } }
        });
        // a key used twice keeps its first use (forward comes first)
        expect(odd.keys.forward).toEqual(['KeyW', 'ArrowUp']);
        expect(odd.keys.jump).toEqual(['', '']);
        expect(odd.keys.grab).toEqual(defaultBindings().keys.grab);
        expect(odd.keys.drop).toEqual(['', '']);
        expect(odd.pad.jump).toEqual([-1, -1]);
        expect(odd.pad.throw).toEqual([-1, PAD_BUTTONS.A]);
        expect(Object.keys(odd.keys)).toEqual([...ACTIONS]);
    });

    it('names keys and buttons for people', () => {
        expect(keyLabel('KeyW')).toBe('W');
        expect(keyLabel('Digit3')).toBe('3');
        expect(keyLabel('Mouse0')).toBe('Left click');
        expect(keyLabel('ArrowUp')).toBe('↑');
        expect(keyLabel('')).toBe('—');
        expect(padLabel(PAD_BUTTONS.RT)).toBe('RT');
        expect(padLabel(-1)).toBe('—');
        const b = defaultBindings();
        expect(keysText(b, 'sprint')).toBe('Shift');
        expect(keysText(b, 'grab')).toBe('Left click / E');
        bindKey(b, 'throw', 0, '');
        expect(keysText(b, 'throw')).toBe('unbound');
    });

    it('a remapped pad button does the action; its old button no longer does', () => {
        const p = new PadPlayer(0);
        bindPad(p.bindings, 'drop', 0, PAD_BUTTONS.A); // A drops now (it jumped)
        p.poll(pad([PAD_BUTTONS.A]), 0.016, true);
        let c = p.command();
        expect(c.action).toBe(ACTION_DROP);
        expect(c.jump).toBe(false);
        p.poll(pad([]), 0.016, true);
        // B did drop: unbound now, it does nothing
        p.poll(pad([PAD_BUTTONS.B]), 0.016, true);
        c = p.command();
        expect(c.action).toBe(ACTION_NONE);
        // two buttons on one action: either one presses it, holding both is one press
        bindPad(p.bindings, 'jump', 0, PAD_BUTTONS.X);
        bindPad(p.bindings, 'jump', 1, PAD_BUTTONS.Y);
        p.poll(pad([]), 0.016, true);
        p.poll(pad([PAD_BUTTONS.X]), 0.016, true);
        expect(p.command().jump).toBe(true);
        p.poll(pad([PAD_BUTTONS.X, PAD_BUTTONS.Y]), 0.016, true);
        expect(p.command().jump).toBe(false);
    });

    it('pour (Epic 7) is remappable: R and Y by default; binding R or Y to something else takes it off pour', () => {
        const b = defaultBindings();
        expect(actionForKey(b, 'KeyR')).toBe('pour');
        expect(b.pad.pour).toEqual([PAD_BUTTONS.Y, -1]);
        expect(b.pad.plank).toEqual([PAD_BUTTONS.RIGHT, -1]);
        // R to ragdoll: it says pour lost it, and R no longer pours
        expect(bindKey(b, 'ragdoll', 1, 'KeyR')).toBe('pour');
        expect(actionForKey(b, 'KeyR')).toBe('ragdoll');
        expect(b.keys.pour).toEqual(['', '']);
        // on a pad: Y to jump stops Y pouring; pour moved to LB pours from there
        const p = new PadPlayer(0);
        expect(bindPad(p.bindings, 'jump', 1, PAD_BUTTONS.Y)).toBe('pour');
        p.poll(pad([PAD_BUTTONS.Y]), 0.016, true);
        let c = p.command();
        expect(c.action).toBe(ACTION_NONE);
        expect(c.jump).toBe(true);
        bindPad(p.bindings, 'pour', 0, PAD_BUTTONS.LB);
        p.poll(pad([]), 0.016, true);
        p.poll(pad([PAD_BUTTONS.LB]), 0.016, true);
        c = p.command();
        expect(c.action).toBe(ACTION_POUR);
    });
});
