/**
 * Keyboard + mouse input for the first-person character. Produces plain commands for the simulation;
 * look angles are applied to the camera at display rate so the view stays smooth. Pointer lock is
 * only requested from a user gesture (click or key press), and Esc releases it (browser default).
 * The click that acquires pointer lock never grabs anything (design doc §9).
 *
 * Edge-triggered requests (jump, grab, throw, actions) are queued and sent on exactly one command.
 */

import { ACTION_DROP, ACTION_NONE, ACTION_POUR, ACTION_RAGDOLL, PITCH_LIMIT } from '../sim/commands.ts';
import type { PlayerCommand } from '../sim/commands.ts';

export class FirstPersonInput {
    yaw = 0;
    pitch = 0;
    sensitivity = 0.0022;
    invertY = false;
    /** While set (a menu is open), keys and mouse buttons do nothing in the game. */
    suspended = false;
    carry = false;
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
            this.keys.add(e.code);
            if (e.code === 'Space') this.jumpQueued = true;
            if (this.active && !e.repeat) {
                if (e.code === 'KeyQ') this.actionQueued = ACTION_DROP;
                if (e.code === 'KeyT') this.actionQueued = ACTION_RAGDOLL;
                if (e.code === 'KeyR') this.actionQueued = ACTION_POUR;
                if (e.code === 'KeyE') this.grabQueued = true;
            }
            if (this.active && ['Space', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
        });
        window.addEventListener('keyup', (e) => this.keys.delete(e.code));
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
                this.lock();
                return;
            }
            if (e.button === 0) this.grabQueued = true;
            else if (e.button === 2) this.throwQueued = true;
        });
        canvas.addEventListener('contextmenu', (e) => {
            if (this.active) e.preventDefault();
        });
        canvas.addEventListener(
            'wheel',
            (e) => {
                if (!this.active || document.pointerLockElement !== canvas) return;
                this.reachQueued += -Math.sign(e.deltaY) * 0.2;
            },
            { passive: true }
        );
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
        const k = this.keys;
        const moveZ = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
        const moveX = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
        const cmd: PlayerCommand = {
            seq: ++this.seq,
            moveX: this.active ? moveX : 0,
            moveZ: this.active ? moveZ : 0,
            sprint: k.has('ShiftLeft') || k.has('ShiftRight'),
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
