import { afterEach, describe, expect, it } from 'vitest';

import { MAX_PADS, PAD, PadManager } from '../../src/input/gamepad.ts';

type FakePad = {
    index: number;
    id: string;
    connected: boolean;
    mapping: string;
    axes: number[];
    buttons: { pressed: boolean; value: number }[];
};
const pad = (index: number): FakePad => ({
    index,
    id: `pad ${index}`,
    connected: true,
    mapping: 'standard',
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }))
});

const nav = globalThis as unknown as { navigator?: { getGamepads?: () => (FakePad | null)[] } };
const saved = nav.navigator;
afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', { value: saved, configurable: true });
});

/** Up to four pads join in turn; one leaves from the middle; player 1's pad leaves. */
describe('local players on gamepads (split screen up to quarters, #22)', () => {
    it('joins up to four players in order, and the ones behind a player who leaves move up', () => {
        const pads = [pad(0), pad(1), pad(2), pad(3), pad(4)];
        Object.defineProperty(globalThis, 'navigator', { value: { getGamepads: () => pads }, configurable: true });
        const m = new PadManager();
        const joined: number[] = [];
        const left: number[] = [];
        m.onJoin = (s) => joined.push(s);
        m.onLeave = (s) => left.push(s);
        const press = (i: number) => {
            pads[i].buttons[PAD.A].pressed = true;
            m.poll(0.016);
            pads[i].buttons[PAD.A].pressed = false;
            m.poll(0.016);
        };
        for (const i of [0, 1, 2, 3]) press(i);
        expect(MAX_PADS).toBe(4);
        expect(joined).toEqual([0, 1, 2, 3]);
        expect(m.players.map((p) => p?.padIndex)).toEqual([0, 1, 2, 3]);
        // a fifth pad finds no place
        press(4);
        expect(joined).toEqual([0, 1, 2, 3]);
        // player 3's pad (index 2) goes: player 4 becomes player 3
        pads[2].connected = false;
        m.poll(0.016);
        expect(left).toEqual([2]);
        expect(m.players.map((p) => p?.padIndex ?? null)).toEqual([0, 1, 3, null]);
        // player 1's pad goes: player 1 keeps their place (keyboard and mouse), nobody moves
        pads[0].connected = false;
        m.poll(0.016);
        expect(left).toEqual([2, 0]);
        expect(m.players.map((p) => p?.padIndex ?? null)).toEqual([null, 1, 3, null]);
        // the free fifth pad can join now, as the next player... in player 1's free place first
        press(4);
        expect(joined).toEqual([0, 1, 2, 3, 0]);
        expect(m.players.map((p) => p?.padIndex ?? null)).toEqual([4, 1, 3, null]);
    });
});
