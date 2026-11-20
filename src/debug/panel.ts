/**
 * Debug panel (design doc §7.3). Visible in development, or explicitly via the corner chip / F3 /
 * ?debug in a production build. Renders from app state; the DOM never owns state.
 */

export type ControlSpec =
    | { kind: 'button'; id: string; label: string; key?: string }
    | { kind: 'toggle'; id: string; label: string }
    | { kind: 'select'; id: string; label: string; options: { value: string; label: string }[] }
    | { kind: 'range'; id: string; label: string; min: number; max: number; step: number };

export interface PanelHost {
    get(id: string): string | number | boolean;
    set(id: string, value: string | number | boolean): void;
    action(id: string): void;
}

export class DebugPanel {
    readonly el: HTMLDivElement;
    private readonly statsEl: HTMLPreElement;
    private readonly inputs = new Map<string, HTMLInputElement | HTMLSelectElement | HTMLButtonElement>();
    private readonly host: PanelHost;
    private _visible = false;

    constructor(host: PanelHost, sections: { title: string; controls: ControlSpec[] }[]) {
        this.host = host;
        const el = document.createElement('div');
        el.className = 'debug-panel';
        el.innerHTML = '<div class="debug-title">Voxel debug <span class="debug-hint">F3 to hide</span></div>';
        for (const s of sections) {
            const sec = document.createElement('div');
            sec.className = 'debug-section';
            const h = document.createElement('div');
            h.className = 'debug-heading';
            h.textContent = s.title;
            sec.append(h);
            const grid = document.createElement('div');
            grid.className = 'debug-grid';
            for (const c of s.controls) grid.append(this.control(c));
            sec.append(grid);
            el.append(sec);
        }
        this.statsEl = document.createElement('pre');
        this.statsEl.className = 'debug-stats';
        el.append(this.statsEl);
        // keep clicks in the panel from reaching the canvas (no accidental pointer lock or orbit)
        for (const ev of ['pointerdown', 'mousedown', 'wheel', 'click']) el.addEventListener(ev, (e) => e.stopPropagation());
        document.body.append(el);
        this.el = el;
        this.visible = false;
    }

    private control(c: ControlSpec): HTMLElement {
        const wrap = document.createElement('label');
        wrap.className = `debug-control debug-${c.kind}`;
        if (c.kind === 'button') {
            const b = document.createElement('button');
            b.textContent = c.key ? `${c.label} (${c.key})` : c.label;
            b.addEventListener('click', () => this.host.action(c.id));
            b.dataset.id = c.id;
            this.inputs.set(c.id, b);
            return b;
        }
        const span = document.createElement('span');
        span.textContent = c.label;
        if (c.kind === 'toggle') {
            const i = document.createElement('input');
            i.type = 'checkbox';
            i.addEventListener('change', () => this.host.set(c.id, i.checked));
            this.inputs.set(c.id, i);
            wrap.append(i, span);
        } else if (c.kind === 'select') {
            const s = document.createElement('select');
            for (const o of c.options) {
                const opt = document.createElement('option');
                opt.value = o.value;
                opt.textContent = o.label;
                s.append(opt);
            }
            s.addEventListener('change', () => this.host.set(c.id, s.value));
            this.inputs.set(c.id, s);
            wrap.append(span, s);
        } else {
            const i = document.createElement('input');
            i.type = 'range';
            i.min = String(c.min);
            i.max = String(c.max);
            i.step = String(c.step);
            const out = document.createElement('em');
            i.addEventListener('input', () => {
                this.host.set(c.id, Number(i.value));
                out.textContent = i.value;
            });
            this.inputs.set(c.id, i);
            wrap.append(span, i, out);
        }
        return wrap;
    }

    /** Re-reads every control from host state. */
    sync(): void {
        for (const [id, el] of this.inputs) {
            if (el instanceof HTMLButtonElement) continue;
            const v = this.host.get(id);
            if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = Boolean(v);
            else {
                el.value = String(v);
                const em = el.parentElement?.querySelector('em');
                if (em) em.textContent = String(v);
            }
        }
        const pause = this.inputs.get('pause');
        if (pause) pause.textContent = this.host.get('paused') ? 'Resume (P)' : 'Pause (P)';
    }

    setStats(text: string): void {
        if (this._visible) this.statsEl.textContent = text;
    }

    get visible(): boolean {
        return this._visible;
    }

    set visible(v: boolean) {
        this._visible = v;
        this.el.style.display = v ? '' : 'none';
        if (v) this.sync();
    }
}
