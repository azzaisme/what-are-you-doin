/**
 * The settings menu: a modal dialog with tabs of rows (sliders, switches, choices, buttons). Every
 * input gets there the same way:
 * - mouse and touch: tap tabs and controls (44 px targets; the dialog scrolls on short screens);
 * - keyboard: Tab / Shift+Tab, or the arrow keys (up / down between rows, left / right to change),
 *   Enter / Space to press, Page Up / Page Down or Q / E for tabs, Esc to close;
 * - gamepad: D-pad or left stick (held: repeats), A to press, B or Start to close, LB / RB for
 *   tabs. The caller passes the pad in each frame (see pollPad).
 *
 * The highlighted row is always shown (not only after keyboard use), so a pad player can see where
 * they are. DOM only; the caller owns the values (get / set) and actions.
 */

export type SettingValue = number | boolean | string;

export type SettingsRow =
    | {
          kind: 'range';
          key: string;
          label: string;
          min: number;
          max: number;
          step: number;
          format(v: number): string;
          hint?: string;
      }
    | { kind: 'toggle'; key: string; label: string; hint?: string }
    | { kind: 'choice'; key: string; label: string; options: { value: string; label: string }[]; hint?: string }
    | { kind: 'button'; id: string; label: string; hint?: string; primary?: boolean };

export interface SettingsTab {
    id: string;
    label: string;
    rows: SettingsRow[];
}

export interface SettingsMenuHost {
    get(key: string): SettingValue;
    set(key: string, v: SettingValue): void;
    action(id: string): void;
    /** A row is shown (rows can depend on the device or the game state). */
    shown?(key: string): boolean;
    /** A button is enabled. */
    enabled?(id: string): boolean;
    opened?(): void;
    closed?(): void;
}

/** Standard gamepad buttons used for menu navigation. */
const PAD = { A: 0, B: 1, LB: 4, RB: 5, MENU: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 } as const;
const REPEAT_DELAY = 0.4;
const REPEAT_EVERY = 0.11;

type Dir = 'up' | 'down' | 'left' | 'right';

interface RowView {
    row: SettingsRow;
    el: HTMLDivElement;
    /** The element that takes focus for this row. */
    focus(): HTMLElement;
    /** Changes the value one step (left / right); false if it has no value. */
    nudge(d: -1 | 1): boolean;
    sync(): void;
}

let uid = 0;

export class SettingsMenu {
    readonly el: HTMLDivElement;
    private readonly dialog: HTMLDivElement;
    private readonly tabButtons: HTMLButtonElement[] = [];
    private readonly panel: HTMLDivElement;
    private readonly host: SettingsMenuHost;
    private readonly tabs: SettingsTab[];
    private tab = 0;
    private views: RowView[] = [];
    private current = 0;
    private opener: Element | null = null;
    private isOpen = false;
    // gamepad: held directions repeat; edges for buttons
    /** Null right after opening: the press that opened the menu is not read as a new press. */
    private padPrev: boolean[] | null = null;
    private held: Dir | null = null;
    private heldTime = 0;
    private nextRepeat = 0;

    constructor(host: SettingsMenuHost, tabs: SettingsTab[]) {
        this.host = host;
        this.tabs = tabs;
        const id = `settings-${++uid}`;
        const el = document.createElement('div');
        el.className = 'settings-backdrop';
        el.hidden = true;
        el.innerHTML = `
          <div class="settings" role="dialog" aria-modal="true" aria-labelledby="${id}-title">
            <div class="settings-head">
              <h2 id="${id}-title">Settings</h2>
              <button type="button" class="settings-close" aria-label="Close settings">✕</button>
            </div>
            <div class="settings-tabs" role="tablist" aria-label="Settings sections"></div>
            <div class="settings-panel" role="tabpanel" id="${id}-panel"></div>
            <div class="settings-foot" aria-hidden="true">
              <span class="foot-keys"><kbd>↑</kbd><kbd>↓</kbd> choose · <kbd>←</kbd><kbd>→</kbd> change · <kbd>Q</kbd><kbd>E</kbd> sections · <kbd>Esc</kbd> close</span>
              <span class="foot-pad"><b>A</b> select · <b>B</b> close · <b>LB</b>/<b>RB</b> sections</span>
            </div>
          </div>`;
        document.body.append(el);
        this.el = el;
        this.dialog = el.querySelector('.settings')!;
        this.panel = el.querySelector('.settings-panel')!;
        const tablist = el.querySelector('.settings-tabs')!;
        tabs.forEach((t, i) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.role = 'tab';
            b.id = `${id}-tab-${t.id}`;
            b.textContent = t.label;
            b.setAttribute('aria-controls', `${id}-panel`);
            b.addEventListener('click', () => this.showTab(i, false));
            tablist.append(b);
            this.tabButtons.push(b);
        });
        el.querySelector('.settings-close')!.addEventListener('click', () => this.close());
        // a click on the backdrop (outside the dialog) closes, like Esc
        el.addEventListener('pointerdown', (e) => {
            if (e.target === el) this.close();
        });
        // the game below never sees input meant for the menu
        for (const ev of ['pointerdown', 'mousedown', 'wheel', 'click', 'contextmenu', 'touchstart'] as const)
            el.addEventListener(ev, (e) => e.stopPropagation());
        el.addEventListener('keydown', (e) => this.onKey(e));
        el.addEventListener('keyup', (e) => e.stopPropagation());
        this.panel.addEventListener('focusin', (e) => {
            const k = this.views.findIndex((v) => v.el.contains(e.target as Node));
            if (k >= 0) this.setCurrent(k, false);
        });
        this.showTab(0, false);
    }

    get open(): boolean {
        return this.isOpen;
    }

    get tabId(): string {
        return this.tabs[this.tab].id;
    }

    show(tabId?: string): void {
        if (!this.isOpen) {
            this.opener = document.activeElement;
            this.isOpen = true;
            this.el.hidden = false;
            document.body.classList.add('settings-open');
            this.host.opened?.();
        }
        const k = tabId ? this.tabs.findIndex((t) => t.id === tabId) : this.tab;
        this.showTab(k >= 0 ? k : 0, true);
        this.padPrev = null;
    }

    close(): void {
        if (!this.isOpen) return;
        this.isOpen = false;
        this.el.hidden = true;
        document.body.classList.remove('settings-open');
        this.held = null;
        if (this.opener instanceof HTMLElement && document.contains(this.opener)) this.opener.focus();
        else (document.activeElement as HTMLElement | null)?.blur?.();
        this.host.closed?.();
    }

    toggle(): void {
        if (this.isOpen) this.close();
        else this.show();
    }

    /** Re-reads every value (after a change made elsewhere: a hotkey, the debug panel). */
    sync(): void {
        for (const v of this.views) v.sync();
    }

    /** Rebuilds the current tab (rows shown or hidden by the game state). */
    refresh(): void {
        if (this.isOpen) this.showTab(this.tab, false);
    }

    private showTab(k: number, focus: boolean): void {
        this.tab = k;
        this.tabButtons.forEach((b, i) => {
            b.setAttribute('aria-selected', String(i === k));
            b.tabIndex = i === k ? 0 : -1;
        });
        this.panel.setAttribute('aria-labelledby', this.tabButtons[k].id);
        this.panel.replaceChildren();
        this.views = this.tabs[k].rows
            .filter((r) => this.host.shown?.(r.kind === 'button' ? r.id : r.key) ?? true)
            .map((r) => this.buildRow(r));
        for (const v of this.views) this.panel.append(v.el);
        this.current = Math.min(this.current, Math.max(0, this.views.length - 1));
        if (focus || this.isOpen) this.setCurrent(0, focus || this.panel.contains(document.activeElement));
        this.panel.scrollTop = 0;
    }

    private setCurrent(k: number, focus: boolean): void {
        if (!this.views.length) return;
        this.current = Math.max(0, Math.min(this.views.length - 1, k));
        this.views.forEach((v, i) => v.el.classList.toggle('current', i === this.current));
        const v = this.views[this.current];
        if (focus) {
            v.focus().focus({ preventScroll: true });
            v.el.scrollIntoView({ block: 'nearest' });
        }
    }

    private move(d: Dir): void {
        if (d === 'up' || d === 'down') {
            const n = this.views.length;
            if (!n) return;
            this.setCurrent((this.current + (d === 'down' ? 1 : n - 1)) % n, true);
        } else {
            const v = this.views[this.current];
            v?.nudge(d === 'right' ? 1 : -1);
        }
    }

    private switchTab(d: -1 | 1): void {
        const n = this.tabs.length;
        this.showTab((this.tab + d + n) % n, true);
    }

    private onKey(e: KeyboardEvent): void {
        // the game's own hotkeys stay out of the menu
        e.stopPropagation();
        const onTab = this.tabButtons.includes(e.target as HTMLButtonElement);
        switch (e.key) {
            case 'Escape':
                e.preventDefault();
                this.close();
                return;
            case 'ArrowDown':
            case 'ArrowUp':
                e.preventDefault();
                if (onTab && e.key === 'ArrowDown') this.setCurrent(0, true);
                else if (!onTab) this.move(e.key === 'ArrowDown' ? 'down' : 'up');
                return;
            case 'ArrowLeft':
            case 'ArrowRight':
                e.preventDefault();
                if (onTab) this.switchTab(e.key === 'ArrowRight' ? 1 : -1);
                else this.move(e.key === 'ArrowRight' ? 'right' : 'left');
                if (onTab) this.tabButtons[this.tab].focus();
                return;
            case 'PageUp':
            case 'PageDown':
                e.preventDefault();
                this.switchTab(e.key === 'PageDown' ? 1 : -1);
                return;
            case 'q':
            case 'Q':
            case 'e':
            case 'E':
                if (e.target instanceof HTMLInputElement && e.target.type === 'text') return;
                e.preventDefault();
                this.switchTab(e.key.toLowerCase() === 'e' ? 1 : -1);
                return;
            case 'Tab': {
                // keep focus inside the dialog
                const f = this.focusables();
                if (!f.length) return;
                const i = f.indexOf(document.activeElement as HTMLElement);
                if (e.shiftKey && i <= 0) {
                    e.preventDefault();
                    f[f.length - 1].focus();
                } else if (!e.shiftKey && i === f.length - 1) {
                    e.preventDefault();
                    f[0].focus();
                }
                return;
            }
        }
    }

    private focusables(): HTMLElement[] {
        return Array.from(
            this.dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])')
        ).filter((x) => x.tabIndex >= 0 && x.offsetParent !== null);
    }

    /** Gamepad navigation, once per frame while open. B or Start closes. */
    pollPad(pad: Gamepad | null, dt: number): void {
        if (!this.isOpen || !pad) return;
        const b = (i: number) => !!pad.buttons[i]?.pressed;
        if (!this.padPrev) {
            // held directions from before opening do not move either
            this.padPrev = pad.buttons.map((x) => x.pressed);
            this.held = 'up';
            this.heldTime = -Infinity;
            return;
        }
        const prev = this.padPrev;
        const edge = (i: number) => b(i) && !prev[i];
        const ax = pad.axes[0] ?? 0;
        const ay = pad.axes[1] ?? 0;
        const dir: Dir | null =
            b(PAD.UP) || ay < -0.6
                ? 'up'
                : b(PAD.DOWN) || ay > 0.6
                  ? 'down'
                  : b(PAD.LEFT) || ax < -0.6
                    ? 'left'
                    : b(PAD.RIGHT) || ax > 0.6
                      ? 'right'
                      : null;
        if (dir !== this.held) {
            this.held = dir;
            this.heldTime = 0;
            this.nextRepeat = REPEAT_DELAY;
            if (dir) this.move(dir);
        } else if (dir) {
            this.heldTime += dt;
            if (this.heldTime >= this.nextRepeat) {
                this.nextRepeat += REPEAT_EVERY;
                this.move(dir);
            }
        }
        const closeNow = edge(PAD.B) || edge(PAD.MENU);
        if (edge(PAD.A)) this.views[this.current]?.focus().click();
        if (edge(PAD.LB)) this.switchTab(-1);
        if (edge(PAD.RB)) this.switchTab(1);
        this.padPrev = pad.buttons.map((x) => x.pressed);
        if (closeNow) this.close();
    }

    private buildRow(row: SettingsRow): RowView {
        const el = document.createElement('div');
        el.className = `settings-row settings-${row.kind}`;
        const rid = `settings-row-${++uid}`;
        const label = document.createElement('div');
        label.className = 'settings-label';
        label.id = `${rid}-label`;
        label.textContent = row.label;
        if (row.hint) {
            const h = document.createElement('small');
            h.id = `${rid}-hint`;
            h.textContent = row.hint;
            label.append(h);
        }
        const control = document.createElement('div');
        control.className = 'settings-control';
        el.append(label, control);
        const describe = (x: HTMLElement) => {
            x.setAttribute('aria-labelledby', label.id);
            if (row.hint) x.setAttribute('aria-describedby', `${rid}-hint`);
        };
        // a tap anywhere on the row's label focuses its control
        label.addEventListener('click', () => view.focus().focus());

        let view: RowView;
        switch (row.kind) {
            case 'range': {
                const minus = document.createElement('button');
                minus.type = 'button';
                minus.className = 'settings-step';
                minus.textContent = '−';
                minus.tabIndex = -1;
                minus.setAttribute('aria-hidden', 'true');
                const input = document.createElement('input');
                input.type = 'range';
                input.min = String(row.min);
                input.max = String(row.max);
                input.step = String(row.step);
                describe(input);
                const plus = minus.cloneNode() as HTMLButtonElement;
                plus.textContent = '+';
                const out = document.createElement('output');
                control.append(minus, input, plus, out);
                const sync = () => {
                    const v = Number(this.host.get(row.key));
                    input.value = String(v);
                    out.textContent = row.format(v);
                    input.setAttribute('aria-valuetext', row.format(v));
                };
                const setV = (v: number) => {
                    const c = Math.max(
                        row.min,
                        Math.min(row.max, Math.round((v - row.min) / row.step) * row.step + row.min)
                    );
                    this.host.set(row.key, Number(c.toFixed(6)));
                    sync();
                };
                input.addEventListener('input', () => setV(Number(input.value)));
                // the arrow keys move between rows (handled by the menu), not the slider
                input.addEventListener('keydown', (e) => {
                    if (e.key.startsWith('Arrow')) e.preventDefault();
                });
                const nudge = (d: -1 | 1) => {
                    setV(Number(this.host.get(row.key)) + d * row.step);
                    return true;
                };
                minus.addEventListener('click', () => {
                    nudge(-1);
                    input.focus();
                });
                plus.addEventListener('click', () => {
                    nudge(1);
                    input.focus();
                });
                view = { row, el, focus: () => input, nudge, sync };
                break;
            }
            case 'toggle': {
                const b = document.createElement('button');
                b.type = 'button';
                b.role = 'switch';
                b.className = 'settings-switch';
                describe(b);
                control.append(b);
                const sync = () => {
                    const on = Boolean(this.host.get(row.key));
                    b.setAttribute('aria-checked', String(on));
                    b.textContent = on ? 'On' : 'Off';
                };
                const setV = (on: boolean) => {
                    this.host.set(row.key, on);
                    sync();
                };
                b.addEventListener('click', () => setV(!this.host.get(row.key)));
                const nudge = (d: -1 | 1) => {
                    setV(d > 0);
                    return true;
                };
                view = { row, el, focus: () => b, nudge, sync };
                break;
            }
            case 'choice': {
                const group = document.createElement('div');
                group.className = 'settings-choices';
                group.role = 'radiogroup';
                describe(group);
                control.append(group);
                const buttons = row.options.map((o) => {
                    const b = document.createElement('button');
                    b.type = 'button';
                    b.role = 'radio';
                    b.textContent = o.label;
                    b.addEventListener('click', () => {
                        this.host.set(row.key, o.value);
                        sync();
                    });
                    group.append(b);
                    return b;
                });
                const index = () =>
                    Math.max(
                        0,
                        row.options.findIndex((o) => o.value === String(this.host.get(row.key)))
                    );
                const sync = () => {
                    const k = index();
                    buttons.forEach((b, i) => {
                        b.setAttribute('aria-checked', String(i === k));
                        b.tabIndex = i === k ? 0 : -1;
                    });
                };
                const nudge = (d: -1 | 1) => {
                    const n = row.options.length;
                    const k = Math.max(0, Math.min(n - 1, index() + d));
                    this.host.set(row.key, row.options[k].value);
                    sync();
                    if (group.contains(document.activeElement)) buttons[k].focus();
                    return true;
                };
                view = { row, el, focus: () => buttons[index()], nudge, sync };
                break;
            }
            case 'button': {
                el.classList.toggle('settings-primary', !!row.primary);
                const b = document.createElement('button');
                b.type = 'button';
                b.textContent = row.label;
                if (row.hint) b.setAttribute('aria-describedby', `${rid}-hint`);
                label.textContent = '';
                if (row.hint) {
                    const h = document.createElement('small');
                    h.id = `${rid}-hint`;
                    h.textContent = row.hint;
                    label.append(h);
                }
                control.append(b);
                b.addEventListener('click', () => this.host.action(row.id));
                const sync = () => {
                    b.disabled = !(this.host.enabled?.(row.id) ?? true);
                };
                view = { row, el, focus: () => b, nudge: () => false, sync };
                break;
            }
        }
        view.sync();
        return view;
    }
}
