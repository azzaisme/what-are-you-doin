/**
 * Keyboard + mouse input for the first-person walker. Produces plain commands for the simulation;
 * look angles are applied to the camera at display rate so the view stays smooth. Pointer lock is
 * only requested from a user gesture (click or key press), and Esc releases it (browser default).
 */

import type { PlayerCommand } from '../sim/lab-sim.ts';

export class FirstPersonInput {
    yaw = 0;
    pitch = 0;
    sensitivity = 0.0022;
    carry = false;
    private readonly keys = new Set<string>();
    private seq = 0;
    private readonly canvas: HTMLCanvasElement;
    active = false;
    private jumpQueued = false;

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        window.addEventListener('keydown', (e) => {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
            this.keys.add(e.code);
            if (e.code === 'Space') this.jumpQueued = true;
            if (this.active && ['Space', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
        });
        window.addEventListener('keyup', (e) => this.keys.delete(e.code));
        window.addEventListener('blur', () => this.keys.clear());
        document.addEventListener('mousemove', (e) => {
            if (!this.active || document.pointerLockElement !== this.canvas) return;
            this.yaw -= e.movementX * this.sensitivity;
            this.pitch -= e.movementY * this.sensitivity;
            this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch));
        });
        canvas.addEventListener('click', () => {
            if (this.active && document.pointerLockElement !== canvas) this.lock();
        });
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

    command(): PlayerCommand {
        const k = this.keys;
        const moveZ = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
        const moveX = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
        const jump = this.jumpQueued;
        this.jumpQueued = false;
        return {
            seq: ++this.seq,
            moveX: this.active ? moveX : 0,
            moveZ: this.active ? moveZ : 0,
            sprint: k.has('ShiftLeft') || k.has('ShiftRight'),
            jump: this.active && jump,
            yaw: this.yaw,
            pitch: this.pitch,
            carry: this.carry
        };
    }
}
