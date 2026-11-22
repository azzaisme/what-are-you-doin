/**
 * Keyboard + mouse input for the first-person character. Produces plain commands for the simulation;
 * look angles are applied to the camera at display rate so the view stays smooth. Pointer lock is
 * only requested from a user gesture (click or key press), and Esc releases it (browser default).
 * The click that acquires pointer lock never grabs anything (design doc §9).
 *
 * Edge-triggered requests (jump, grab, throw, actions) are queued and sent on exactly one command.
 * Which key or mouse button does what comes from the player's bindings (bindings.ts).
 */

import { ACTION_DROP, ACTION_NONE, ACTION_RAGDOLL, PITCH_LIMIT } from '../sim/commands.ts';
import type { PlayerCommand } from '../sim/commands.ts';

import { actionForKey, defaultBindings } from './bindings.ts';
import type { Action, Bindings } from './bindings.ts';

export class FirstPersonInput {
    yaw = 0;
    pitch = 0;
    sensitivity = 0.0022;
    invertY = false;
    /** While set (a menu is open), keys and mouse buttons do nothing in the game. */
    suspended = false;
    carry = false;
    /** Which keys and mouse buttons do what (the settings menu changes it in place). */
    bindings: Bindings = defaultBindings();
    /** The plank key was pressed (player 1's carry plank toggles; the caller owns that state). */
    onPlank: () => void = () => undefined;
    /** Held keys and mouse buttons (codes, see bindings.ts). */
    private readonly keys = new Set<string>();
    private seq = 0;
    private readonly canvas: HTMLCanvasElement;
    active = false;
    private jumpQueued = false;
    private grabQueued = false;
    private throwQueued = false;
    private reachQueued = 0;
    private actionQueued = ACTION_NONE;

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        window.addEventListener('keydown', (e) => {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
            if (this.suspended) return;
            const action = actionForKey(this.bindings, e.code);
            if (!action) return;
            this.keys.add(e.code);
            this.press(action, e.repeat);
            // a bound key is the game's (Space and the arrows would scroll the page)
            if (this.active) e.preventDefault();
        });
        window.addEventListener('keyup', (e) => this.keys.delete(e.code));
        window.addEventListener('mouseup', (e) => this.keys.delete(`Mouse${e.button}`));
        window.addEventListener('blur', () => this.keys.clear());
        document.addEventListener('mousemove', (e) => {
            if (!this.active || document.pointerLockElement !== this.canvas) return;
            this.yaw -= e.movementX * this.sensitivity;
            this.pitch -= e.movementY * this.sensitivity * (this.invertY ? -1 : 1);
            this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch));
        });
        canvas.addEventListener('mousedown', (e) => {
            if (!this.active || this.suspended) return;
            if (document.pointerLockElement !== canvas) {
                // the click that takes the mouse never does anything else
                this.lock();
                return;
            }
            const code = `Mouse${e.button}`;
            const action = actionForKey(this.bindings, code);
            if (!action) return;
            this.keys.add(code);
            this.press(action, false);
            if (e.button === 1) e.preventDefault(); // no autoscroll
        });
        canvas.addEventListener('contextmenu', (e) => {
            if (this.active) e.preventDefault();
        });
        canvas.addEventListener(
            'wheel',
            (e) => {
                if (!this.active || document.pointerLockElement !== canvas || this.suspended || !e.deltaY) return;
                const action = actionForKey(this.bindings, e.deltaY < 0 ? 'WheelUp' : 'WheelDown');
                if (action) this.press(action, false);
            },
            { passive: true }
        );
    }

    /** A bound key or button went down (`repeat`: held, auto-repeating). */
    private press(action: Action, repeat: boolean): void {
        if (action === 'jump') this.jumpQueued = true; // held, it keeps hopping
        if (repeat) return;
        if (action === 'plank') this.onPlank();
        if (!this.active) return;
        if (action === 'grab') this.grabQueued = true;
        else if (action === 'throw') this.throwQueued = true;
        else if (action === 'drop') this.actionQueued = ACTION_DROP;
        else if (action === 'ragdoll') this.actionQueued = ACTION_RAGDOLL;
        else if (action === 'reachFar') this.reachQueued += 0.2;
        else if (action === 'reachNear') this.reachQueued -= 0.2;
    }

    /** Some key or button bound to the action is held. */
    private held(action: Action): boolean {
        const [a, b] = this.bindings.keys[action];
        return (!!a && this.keys.has(a)) || (!!b && this.keys.has(b));
    }

    /** Forgets held keys and queued presses (a menu opened over the game). */
    clear(): void {
        this.keys.clear();
        this.jumpQueued = this.grabQueued = this.throwQueued = false;
        this.reachQueued = 0;
    }

    get locked(): boolean {
        return document.pointerLockElement === this.canvas;
    }

    lock(): void {
        const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
        if (p && typeof p.catch === 'function') p.catch(() => undefined);
    }

    unlock(): void {
        if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    }

    private injected: Partial<PlayerCommand> | null = null;

    /** Test hook: fields merged into the next command (e.g. a grab edge or a move). */
    inject(c: Partial<PlayerCommand>): void {
        this.injected = { ...this.injected, ...c };
    }

    /** Queues a discrete request from UI (debug panel buttons). */
    queueAction(action: number): void {
        this.actionQueued = action;
    }

    command(): PlayerCommand {
        const h = (a: Action) => (this.held(a) ? 1 : 0);
        const moveZ = h('forward') - h('back');
        const moveX = h('right') - h('left');
        const cmd: PlayerCommand = {
            seq: ++this.seq,
            moveX: this.active ? moveX : 0,
            moveZ: this.active ? moveZ : 0,
            sprint: this.held('sprint'),
            jump: this.active && this.jumpQueued,
            yaw: this.yaw,
            pitch: this.pitch,
            carry: this.carry,
            grab: this.active && this.grabQueued,
            throw: this.active && this.throwQueued,
            reach: this.active ? this.reachQueued : 0,
            action: this.actionQueued
        };
        this.jumpQueued = false;
        this.grabQueued = false;
        this.throwQueued = false;
        this.reachQueued = 0;
        this.actionQueued = ACTION_NONE;
        if (this.injected) {
            Object.assign(cmd, this.injected);
            this.injected = null;
        }
        return cmd;
    }
}
