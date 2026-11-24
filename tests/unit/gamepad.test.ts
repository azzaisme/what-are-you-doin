import { describe, expect, it } from 'vitest';

import { LOOK_SPEED, PAD, PadPlayer, deadzone } from '../../src/input/gamepad.ts';
import { ACTION_DROP, ACTION_NONE, ACTION_POUR, ACTION_RAGDOLL } from '../../src/sim/commands.ts';

/** A minimal Gamepad stand-in with the standard mapping. */
function pad(axes: number[] = [0, 0, 0, 0], pressed: number[] = [], values: Record<number, number> = {}): Gamepad {
    const buttons = Array.from({ length: 17 }, (_, i) => ({
        pressed: pressed.includes(i),
        touched: pressed.includes(i),
        value: values[i] ?? (pressed.includes(i) ? 1 : 0)
    }));
    return {
        axes,
        buttons,
        connected: true,
        index: 0,
        id: 'test',
        mapping: 'standard',
        timestamp: 0,
        hapticActuators: [],
        vibrationActuator: null
    } as unknown as Gamepad;
}

describe('gamepad input', () => {
    it('applies a radial deadzone and rescales beyond it', () => {
        expect(deadzone(0.1, 0.1)).toEqual([0, 0]);
        expect(deadzone(NaN, 0)).toEqual([0, 0]);
        const [x, y] = deadzone(1, 0);
        expect(x).toBeCloseTo(1, 9);
        expect(y).toBe(0);
        const [hx] = deadzone(0.59, 0);
        expect(hx).toBeGreaterThan(0.45);
        expect(hx).toBeLessThan(0.55);
    });

    it('moves with the left stick (up is forward) and looks at a bounded rate with the right stick', () => {
        const p = new PadPlayer(0);
        p.poll(pad([0.5, -1, 1, 0]), 0.05, true);
        const c = p.command();
        expect(c.moveZ).toBeCloseTo(2 / Math.sqrt(5), 6); // the diagonal is normalised to length 1
        expect(c.moveX).toBeGreaterThan(0.3);
        // full right deflection for one 50 ms frame turns right (yaw decreases) at LOOK_SPEED
        expect(p.yaw).toBeCloseTo(-LOOK_SPEED.yaw * 0.05, 9);
        // a stalled frame (dt huge) cannot spin the view
        const q = new PadPlayer(0);
        q.poll(pad([0, 0, 1, 0]), 5, true);
        expect(Math.abs(q.yaw)).toBeLessThanOrEqual(LOOK_SPEED.yaw * 0.1 + 1e-9);
        // pitch is clamped
        for (let i = 0; i < 100; i++) q.poll(pad([0, 0, 0, -1]), 0.1, true);
        expect(q.pitch).toBeLessThanOrEqual(1.45);
    });

    it('sends each button press on exactly one command', () => {
        const p = new PadPlayer(0);
        p.poll(pad(undefined, [PAD.A, PAD.RT, PAD.RB, PAD.X]), 0.016, true);
        const first = p.command();
        expect([first.jump, first.grab, first.throw, first.action]).toEqual([true, true, true, ACTION_RAGDOLL]);
        const second = p.command();
        expect([second.jump, second.grab, second.throw, second.action]).toEqual([false, false, false, ACTION_NONE]);
        // still held next frame: no new edge
        p.poll(pad(undefined, [PAD.A, PAD.RT]), 0.016, true);
        expect(p.command().jump).toBe(false);
        // B drops; LT held sprints; D-pad changes reach
        p.poll(pad(undefined, [PAD.B, PAD.UP], { [PAD.LT]: 0.9 }), 0.016, true);
        const c = p.command();
        expect(c.action).toBe(ACTION_DROP);
        expect(c.sprint).toBe(true);
        expect(c.reach).toBeGreaterThan(0);
    });

    it('D-pad right toggles the carry plank only for player 1', () => {
        const p1 = new PadPlayer(0);
        p1.poll(pad(undefined, [PAD.RIGHT]), 0.016, true);
        expect(p1.carry).toBe(true);
        const p2 = new PadPlayer(1);
        p2.poll(pad(undefined, [PAD.RIGHT]), 0.016, false);
        expect(p2.carry).toBe(false);
        expect(p2.command().carry).toBe(false);
    });

    it('Y pours the bucket (one press, one action), for either player', () => {
        for (const slot of [0, 1]) {
            const p = new PadPlayer(slot);
            p.poll(pad(undefined, [PAD.Y]), 0.016, slot === 0);
            expect(p.command().action).toBe(ACTION_POUR);
            expect(p.carry).toBe(false);
            p.poll(pad(undefined, [PAD.Y]), 0.016, slot === 0);
            expect(p.command().action).toBe(ACTION_NONE);
        }
    });
});
