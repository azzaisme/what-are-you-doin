/**
 * The playtest log viewer (Settings → Game → Playtest log): the session's record as text, a box
 * for the facilitator's own notes, and Copy / Save / Close. Works with mouse, touch and keyboard
 * (Tab between the controls, Esc closes). DOM only; the caller owns the log.
 */

export interface PlaytestPanelHost {
    /** The current session's text. */
    text(): string;
    /** The previous session's text (from this browser), or ''. */
    previous(): string;
    /** A note typed by the facilitator. */
    note(text: string): void;
    closed(): void;
}

export class PlaytestPanel {
    private readonly el: HTMLDivElement;
    private readonly area: HTMLTextAreaElement;
    private readonly input: HTMLInputElement;
    private readonly host: PlaytestPanelHost;
    private showingPrevious = false;

    constructor(host: PlaytestPanelHost) {
        this.host = host;
        const el = document.createElement('div');
        el.className = 'settings-backdrop playtest-backdrop';
        el.hidden = true;
        el.innerHTML = `
          <div class="settings playtest" role="dialog" aria-modal="true" aria-labelledby="playtest-title">
            <div class="settings-head">
              <h2 id="playtest-title">Playtest log</h2>
              <button type="button" class="settings-close" data-act="close" aria-label="Close the playtest log">✕</button>
            </div>
            <p class="playtest-hint">Everything that happened this session, kept on this device only. Add what you
              saw, then copy or save it for docs/progress.md.</p>
            <form class="playtest-note">
              <input type="text" maxlength="300" placeholder="Note (e.g. “tried to swim across”)" aria-label="Note" />
              <button type="submit">Add note</button>
            </form>
            <textarea readonly spellcheck="false" aria-label="The session log"></textarea>
            <div class="playtest-actions">
              <button type="button" data-act="copy">Copy</button>
              <button type="button" data-act="save">Save as file</button>
              <button type="button" data-act="previous">Previous session</button>
            </div>
          </div>`;
        document.body.append(el);
        this.el = el;
        this.area = el.querySelector('textarea')!;
        this.input = el.querySelector('input')!;
        el.querySelector('form')!.addEventListener('submit', (e) => {
            e.preventDefault();
            const t = this.input.value.trim();
            if (t) host.note(t);
            this.input.value = '';
            this.refresh();
        });
        el.addEventListener('click', (e) => {
            const act = (e.target as HTMLElement).closest('[data-act]')?.getAttribute('data-act');
            if (act === 'close' || e.target === el) this.close();
            else if (act === 'copy') void this.copy();
            else if (act === 'save') this.save();
            else if (act === 'previous') {
                this.showingPrevious = !this.showingPrevious;
                this.refresh();
            }
        });
        el.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Escape') this.close();
        });
    }

    get isOpen(): boolean {
        return !this.el.hidden;
    }

    open(): void {
        this.showingPrevious = false;
        this.el.hidden = false;
        this.refresh();
        this.input.focus();
    }

    close(): void {
        if (this.el.hidden) return;
        this.el.hidden = true;
        this.host.closed();
    }

    private refresh(): void {
        const prev = this.host.previous();
        const btn = this.el.querySelector<HTMLButtonElement>('[data-act="previous"]')!;
        btn.hidden = !prev;
        btn.textContent = this.showingPrevious ? 'This session' : 'Previous session';
        this.area.value = this.showingPrevious ? prev : this.host.text();
        this.area.scrollTop = this.showingPrevious ? 0 : this.area.scrollHeight;
    }

    private async copy(): Promise<void> {
        try {
            await navigator.clipboard.writeText(this.area.value);
        } catch {
            // no clipboard (an embed without permission): select it for a manual copy
            this.area.focus();
            this.area.select();
        }
    }

    private save(): void {
        const blob = new Blob([this.area.value], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `playtest-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`;
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
}
