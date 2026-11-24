/**
 * Touch controls for phones (first person): a floating stick on the left half (pushed to the edge
 * it sprints), drag on the right half to look, and buttons for jump, grab / release, throw and drop
 * (and pour, while you hold the bucket).
 * Produces the same command fields as the gamepad; look changes the shared yaw/pitch at display
 * rate. Shown on coarse-pointer devices, or after the first touch.
 */

import { ACTION_DROP, ACTION_NAIL, ACTION_NONE, ACTION_POUR, PITCH_LIMIT } from '../sim/commands.ts';
import type { PlayerCommand } from '../sim/commands.ts';

const STICK_RADIUS = 56;
const LOOK_SENSITIVITY = 0.0065;

export class TouchControls {
    readonly el: HTMLDivElement;
    enabled = false;
    /** Look speed (times the default), from the settings. */
    lookScale = 1;
    /** Look change since the last takeLook (radians), like mouse movement. */
    private dyaw = 0;
    private dpitch = 0;
    private moveX = 0;
    private moveZ = 0;
    private sprint = false;
    private q = { jump: false, grab: false, throw: false, action: ACTION_NONE as number };
    private stickId: number | null = null;
    private stickOrigin = { x: 0, y: 0 };
    private lookId: number | null = null;
    private lookLast = { x: 0, y: 0 };
    private readonly knob: HTMLDivElement;
    private readonly base: HTMLDivElement;
    private readonly grabBtn: HTMLButtonElement;
    private readonly pourBtn: HTMLButtonElement;

    constructor() {
        const el = document.createElement('div');
        el.className = 'touch-ui';
        el.innerHTML = `
          <div class="touch-stick"><div class="touch-knob"></div></div>
          <div class="touch-buttons">
            <button type="button" data-b="nail" class="touch-nail" aria-label="Nail">Nail</button>
            <button type="button" data-b="pour" class="touch-pour" aria-label="Pour" hidden>Pour</button>
            <button type="button" data-b="drop" aria-label="Drop">Drop</button>
            <button type="button" data-b="throw" aria-label="Throw">Throw</button>
            <button type="button" data-b="grab" class="touch-grab" aria-label="Grab">Grab</button>
            <button type="button" data-b="jump" class="touch-jump" aria-label="Jump">Jump</button>
          </div>`;
        document.body.append(el);
        this.el = el;
        this.base = el.querySelector('.touch-stick')!;
        this.knob = el.querySelector('.touch-knob')!;
        this.grabBtn = el.querySelector('.touch-grab')!;
        this.pourBtn = el.querySelector('.touch-pour')!;
        for (const b of el.querySelectorAll<HTMLButtonElement>('button')) {
            b.addEventListener('touchstart', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const k = b.dataset.b;
                if (k === 'jump') this.q.jump = true;
                else if (k === 'grab') this.q.grab = true;
                else if (k === 'throw') this.q.throw = true;
                else if (k === 'drop') this.q.action = ACTION_DROP;
                else if (k === 'nail') this.q.action = ACTION_NAIL;
                else if (k === 'pour') this.q.action = ACTION_POUR;
                b.classList.add('down');
            });
            b.addEventListener('touchend', () => b.classList.remove('down'));
            b.addEventListener('click', (e) => e.stopPropagation());
        }
        window.addEventListener('touchstart', (e) => this.start(e), { passive: false });
        window.addEventListener('touchmove', (e) => this.move(e), { passive: false });
        window.addEventListener('touchend', (e) => this.end(e));
        window.addEventListener('touchcancel', (e) => this.end(e));
    }

    /** The canvas is the play area; touches on panels and buttons are theirs. */
    private onCanvas(e: TouchEvent): boolean {
        return e.target instanceof HTMLCanvasElement;
    }

    private start(e: TouchEvent): void {
        if (!this.enabled || !this.onCanvas(e)) return;
        e.preventDefault();
        for (const t of Array.from(e.changedTouches)) {
            if (t.clientX < window.innerWidth * 0.45 && this.stickId === null) {
                this.stickId = t.identifier;
                this.stickOrigin = { x: t.clientX, y: t.clientY };
                this.base.style.left = `${t.clientX}px`;
                this.base.style.top = `${t.clientY}px`;
                this.base.classList.add('active');
                this.setKnob(0, 0);
            } else if (this.lookId === null) {
                this.lookId = t.identifier;
                this.lookLast = { x: t.clientX, y: t.clientY };
            }
        }
    }

    private move(e: TouchEvent): void {
        if (!this.enabled) return;
        let used = false;
        for (const t of Array.from(e.changedTouches)) {
            if (t.identifier === this.stickId) {
                let dx = t.clientX - this.stickOrigin.x;
                let dy = t.clientY - this.stickOrigin.y;
                const m = Math.hypot(dx, dy);
                if (m > STICK_RADIUS) {
                    dx *= STICK_RADIUS / m;
                    dy *= STICK_RADIUS / m;
                }
                const k = Math.min(1, m / STICK_RADIUS);
                const dead = k < 0.15;
                this.moveX = dead ? 0 : dx / STICK_RADIUS;
                this.moveZ = dead ? 0 : -dy / STICK_RADIUS;
                this.sprint = k > 0.95;
                this.setKnob(dx, dy);
                used = true;
            } else if (t.identifier === this.lookId) {
                this.dyaw -= (t.clientX - this.lookLast.x) * LOOK_SENSITIVITY * this.lookScale;
                this.dpitch -= (t.clientY - this.lookLast.y) * LOOK_SENSITIVITY * this.lookScale;
                this.lookLast = { x: t.clientX, y: t.clientY };
                used = true;
            }
        }
        if (used) e.preventDefault();
    }

    private end(e: TouchEvent): void {
        for (const t of Array.from(e.changedTouches)) {
            if (t.identifier === this.stickId) {
                this.stickId = null;
                this.moveX = this.moveZ = 0;
                this.sprint = false;
                this.base.classList.remove('active');
            } else if (t.identifier === this.lookId) {
                this.lookId = null;
            }
        }
    }

    private setKnob(dx: number, dy: number): void {
        this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
    }

    /** Shows the controls (first person on a touch device). */
    show(on: boolean): void {
        this.enabled = on;
        this.el.classList.toggle('on', on);
        document.body.classList.toggle('touch-play', on);
        if (!on) {
            this.stickId = this.lookId = null;
            this.moveX = this.moveZ = 0;
        }
    }

    /** "Release" instead of "Grab" while holding something. */
    setHolding(holding: boolean, bucket = false): void {
        const label = holding ? 'Release' : 'Grab';
        if (this.grabBtn.textContent !== label) this.grabBtn.textContent = label;
        if (this.pourBtn.hidden === bucket) this.pourBtn.hidden = !bucket;
    }

    /** Applies and clears the look change since the last call. */
    takeLook(yaw: number, pitch: number): { yaw: number; pitch: number } {
        const out = { yaw: yaw + this.dyaw, pitch: Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch + this.dpitch)) };
        this.dyaw = this.dpitch = 0;
        return out;
    }

    get moving(): boolean {
        return this.moveX !== 0 || this.moveZ !== 0;
    }

    /** Fields this contributes to a command; presses are consumed. */
    take(): Pick<PlayerCommand, 'moveX' | 'moveZ' | 'sprint' | 'jump' | 'grab' | 'throw' | 'action'> {
        const out = {
            moveX: this.moveX,
            moveZ: this.moveZ,
            sprint: this.sprint,
            jump: this.q.jump,
            grab: this.q.grab,
            throw: this.q.throw,
            action: this.q.action
        };
        this.q = { jump: false, grab: false, throw: false, action: ACTION_NONE };
        return out;
    }
}

/** True on phones and tablets (no hover, coarse pointer). */
export function isTouchDevice(): boolean {
    try {
        return matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0;
    } catch {
        return false;
    }
}
