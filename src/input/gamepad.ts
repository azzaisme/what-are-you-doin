/**
 * Gamepad input (local co-op, design doc §6.2 / §10): the browser Gamepad API with the standard
 * mapping (Xbox layout; the Steam Deck's controls and most pads report it). Produces the same plain
 * PlayerCommand as keyboard and mouse. Look is applied at display rate from the right stick, so the
 * view stays smooth; edges (jump, grab, throw, actions) are sent on exactly one command.
 *
 * Joining: the first pad to press A joins as player 1, the next different pad as player 2.
 *
 * Default buttons (standard mapping; every button below can be rebound, see bindings.ts):
 *   left stick  move            right stick  look            L3 or LT (held)  sprint
 *   A           jump            RT           grab / release   RB               throw
 *   B           drop            Y            pour the bucket you hold (again: stop)
 *   X           ragdoll
 *   D-pad up/down  hold further / closer   D-pad right  plank (player 1, River Lab)
 *   Start (menu)   settings (any pad, joined or not; not rebindable)
 */

import { ACTION_DROP, ACTION_NONE, ACTION_POUR, ACTION_RAGDOLL, PITCH_LIMIT } from '../sim/commands.ts';
import type { PlayerCommand } from '../sim/commands.ts';

import { PAD_ACTIONS, defaultBindings } from './bindings.ts';
import type { Bindings, PadAction } from './bindings.ts';

export const PAD = {
    A: 0,
    B: 1,
    X: 2,
    Y: 3,
    LB: 4,
    RB: 5,
    LT: 6,
    RT: 7,
    VIEW: 8,
    MENU: 9,
    L3: 10,
    R3: 11,
    UP: 12,
    DOWN: 13,
    RIGHT: 15
} as const;

const DEADZONE = 0.18;
/** Look speed at full stick deflection (rad/s), with a squared response for fine aim. */
export const LOOK_SPEED = { yaw: 2.8, pitch: 2.0 };

/** Radial deadzone, rescaled so movement starts at zero just outside it. */
export function deadzone(x: number, y: number, dz = DEADZONE): [number, number] {
    const m = Math.hypot(x, y);
    if (!(m > dz)) return [0, 0];
    const k = Math.min(1, (m - dz) / (1 - dz)) / m;
    return [x * k, y * k];
}

/** One player's pad: look angles, held buttons, queued edges. */
export class PadPlayer {
    yaw = 0;
    pitch = 0;
    carry = false;
    /** Look speed (times LOOK_SPEED) and inverted vertical look, from the settings. */
    lookScale = 1;
    invertY = false;
    /** Which buttons do what (shared with the settings menu). */
    bindings: Bindings = defaultBindings();
    padIndex: number;
    private seq = 0;
    /** Actions held at the last poll (edges are per action: either of its buttons). */
    private prev = new Set<PadAction>();
    private moveX = 0;
    private moveZ = 0;
    private sprint = false;
    private q = { jump: false, grab: false, throw: false, reach: 0, action: ACTION_NONE as number };

    constructor(padIndex: number) {
        this.padIndex = padIndex;
    }

    /** Reads the pad once per frame: look at display rate, edges queued for the next command. */
    poll(pad: Gamepad, dt: number, allowCarry: boolean): void {
        // triggers count from part way down (a light rest on them is not a press)
        const b = (i: number) => {
            const x = pad.buttons[i];
            if (!x) return false;
            // (a digital trigger reports pressed with no value)
            return i === PAD.LT || i === PAD.RT ? x.value > 0.4 || (x.pressed && !(x.value > 0)) : x.pressed;
        };
        const down = new Set<PadAction>();
        for (const a of PAD_ACTIONS) if (this.bindings.pad[a].some((i) => i >= 0 && b(i))) down.add(a);
        const edge = (a: PadAction) => down.has(a) && !this.prev.has(a);
        const [lx, ly] = deadzone(pad.axes[0] ?? 0, pad.axes[1] ?? 0);
        const [rx, ry] = deadzone(pad.axes[2] ?? 0, pad.axes[3] ?? 0);
        this.moveX = lx;
        this.moveZ = -ly;
        this.sprint = down.has('sprint');
        const step = Math.min(dt, 0.1);
        const ls = this.lookScale;
        this.yaw -= rx * Math.abs(rx) * LOOK_SPEED.yaw * ls * step;
        const vy = this.invertY ? -ry : ry;
        this.pitch = Math.max(
            -PITCH_LIMIT,
            Math.min(PITCH_LIMIT, this.pitch - vy * Math.abs(vy) * LOOK_SPEED.pitch * ls * step)
        );
        if (edge('jump')) this.q.jump = true;
        if (edge('grab')) this.q.grab = true;
        if (edge('throw')) this.q.throw = true;
        if (edge('drop')) this.q.action = ACTION_DROP;
        if (edge('pour')) this.q.action = ACTION_POUR;
        if (edge('ragdoll')) this.q.action = ACTION_RAGDOLL;
        if (edge('reachFar')) this.q.reach += 0.25;
        if (edge('reachNear')) this.q.reach -= 0.25;
        if (allowCarry && edge('plank')) this.carry = !this.carry;
        this.prev = down;
    }

    /** Stops moving (a menu opened): the stick is ignored until it is next read. */
    idle(): void {
        this.moveX = this.moveZ = 0;
        this.sprint = false;
    }

    /** True when the stick or a button is in use this frame (for merging with keyboard input). */
    get moving(): boolean {
        return this.moveX !== 0 || this.moveZ !== 0;
    }

    /** Fields this pad contributes to a command; edges are consumed. */
    take(): Pick<PlayerCommand, 'moveX' | 'moveZ' | 'sprint' | 'jump' | 'grab' | 'throw' | 'reach' | 'action'> {
        const out = {
            moveX: this.moveX,
            moveZ: this.moveZ,
            sprint: this.sprint,
            jump: this.q.jump,
            grab: this.q.grab,
            throw: this.q.throw,
            reach: this.q.reach,
            action: this.q.action
        };
        this.q = { jump: false, grab: false, throw: false, reach: 0, action: ACTION_NONE };
        return out;
    }

    /** A full command for a pad-only player (player 2). */
    command(): PlayerCommand {
        return { seq: ++this.seq, ...this.take(), yaw: this.yaw, pitch: this.pitch, carry: false };
    }
}

/** Tracks connected pads and who has joined with which. */
export class PadManager {
    readonly players: (PadPlayer | null)[] = [null, null];
    private prevA = new Map<number, boolean>();
    private prevMenu = new Map<number, boolean>();
    /** Look settings and button bindings applied to every player's pad. */
    lookScale = 1;
    invertY = false;
    bindings: Bindings = defaultBindings();
    /**
     * While set (a menu is open), pads move no one and press nothing: buttons are still tracked,
     * so a press that closes the menu does not also act in the game.
     */
    suspended = false;
    /** Start (menu) pressed on any pad, with that pad. */
    onMenu: (pad: Gamepad) => void = () => undefined;
    /** Called when a pad joins as player `slot` (0 or 1), or when player 2's pad goes away. */
    onJoin: (slot: number) => void = () => undefined;
    onLeave: (slot: number) => void = () => undefined;

    private pads(): (Gamepad | null)[] {
        try {
            return typeof navigator !== 'undefined' && navigator.getGamepads ? Array.from(navigator.getGamepads()) : [];
        } catch {
            return [];
        }
    }

    /** Once per frame: joins on A, polls joined pads, notices disconnects. */
    poll(dt: number): void {
        const pads = this.pads();
        for (let s = 0; s < this.players.length; s++) {
            const pl = this.players[s];
            if (!pl) continue;
            const pad = pads[pl.padIndex];
            if (!pad || !pad.connected) {
                this.players[s] = null;
                this.onLeave(s);
                continue;
            }
            pl.lookScale = this.lookScale;
            pl.invertY = this.invertY;
            pl.bindings = this.bindings;
            const yaw = pl.yaw;
            const pitch = pl.pitch;
            pl.poll(pad, dt, s === 0);
            if (this.suspended) {
                // the edges are swallowed and the view stays put
                pl.take();
                pl.yaw = yaw;
                pl.pitch = pitch;
                pl.idle();
            }
        }
        for (const pad of pads) {
            if (!pad || !pad.connected) continue;
            const m = !!pad.buttons[PAD.MENU]?.pressed;
            const wasM = this.prevMenu.get(pad.index) ?? false;
            this.prevMenu.set(pad.index, m);
            if (m && !wasM) this.onMenu(pad);
            const a = !!pad.buttons[PAD.A]?.pressed && !this.suspended;
            const was = this.prevA.get(pad.index) ?? false;
            this.prevA.set(pad.index, a);
            if (!a || was || this.players.some((p) => p?.padIndex === pad.index)) continue;
            const slot = this.players.findIndex((p) => p === null);
            if (slot < 0) continue;
            const pl = new PadPlayer(pad.index);
            pl.bindings = this.bindings;
            // swallow the joining press, so it does not also jump
            pl.poll(pad, 0, false);
            pl.take();
            this.players[slot] = pl;
            this.onJoin(slot);
        }
    }

    get connectedCount(): number {
        return this.pads().filter((p) => p && p.connected).length;
    }
}
