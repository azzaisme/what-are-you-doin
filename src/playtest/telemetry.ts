/**
 * The playtest log (Epic 8 gate, issue #70): a plain-text record of a session, kept on the device,
 * so the person running a playtest can see afterwards what happened and when, without watching a
 * debug panel during it. Nothing is sent anywhere.
 *
 * It records the level, the device and how many play; every level event (falls, recoveries,
 * stages, the goal, the hazards and what they did, the ute); restarts, menu visits and the
 * facilitator's own notes; and every few seconds where the players and the bucket are and what they
 * hold. The summary answers the gate's questions: how long, finished or not, how often things went
 * wrong, and which hazards were met and survived.
 *
 * Engine-free: main.ts feeds it, the settings menu shows it.
 */

export interface PlaytestSample {
    players: { x: number; y: number; z: number; holding: string | null }[];
    bucket: { x: number; y: number; z: number } | null;
    waterY: number;
    stage: string;
}

interface Entry {
    /** Seconds since the session started (wall clock: pauses count). */
    t: number;
    kind: string;
    text: string;
}

export const PLAYTEST_STORAGE_KEY = 'uncivil.playtest.last';
const MAX_ENTRIES = 4000;

export class PlaytestLog {
    readonly meta: Record<string, string>;
    private readonly t0: number;
    private readonly entries: Entry[] = [];
    private readonly counts = new Map<string, number>();
    private readonly firsts = new Map<string, number>();
    private lastSample = -1e9;
    private players = 1;
    private maxPlayers = 1;
    goalAt = -1;

    constructor(meta: Record<string, string>, now: number) {
        this.meta = { ...meta };
        this.t0 = now;
        this.add(
            now,
            'session',
            `started: ${Object.entries(meta)
                .map(([k, v]) => `${k} ${v}`)
                .join(', ')}`
        );
    }

    private add(now: number, kind: string, text: string): void {
        const t = Math.max(0, (now - this.t0) / 1000);
        this.entries.push({ t, kind, text: text.replace(/\s+/g, ' ').trim() });
        if (this.entries.length > MAX_ENTRIES) this.entries.splice(1, this.entries.length - MAX_ENTRIES);
        this.counts.set(kind, (this.counts.get(kind) ?? 0) + 1);
        if (!this.firsts.has(kind)) this.firsts.set(kind, t);
    }

    /** A level event (the toasts players see) or anything else worth a line. */
    note(now: number, kind: string, text: string): void {
        this.add(now, kind, text);
        if (kind === 'goal' && this.goalAt < 0) this.goalAt = (now - this.t0) / 1000;
    }

    /** The number playing changed (split screen, guests joining or leaving). */
    setPlayers(now: number, n: number): void {
        if (n === this.players) return;
        this.add(now, 'players', `${n} playing (was ${this.players})`);
        this.players = n;
        this.maxPlayers = Math.max(this.maxPlayers, n);
    }

    /** Where everyone is, at most every `every` seconds. */
    sample(now: number, s: PlaytestSample, every = 5): void {
        if ((now - this.lastSample) / 1000 < every) return;
        this.lastSample = now;
        const f = (v: number) => v.toFixed(1);
        const ps = s.players
            .map((p, i) => `P${i + 1} ${f(p.x)},${f(p.y)},${f(p.z)}${p.holding ? ` holding ${p.holding}` : ''}`)
            .join('; ');
        const b = s.bucket ? `bucket ${f(s.bucket.x)},${f(s.bucket.y)},${f(s.bucket.z)}` : 'no bucket';
        this.add(now, 'where', `${ps} | ${b} | water ${s.waterY.toFixed(2)} | ${s.stage}`);
    }

    count(kind: string): number {
        return this.counts.get(kind) ?? 0;
    }

    /** The gate's questions, answered from the record. */
    summary(now: number): string {
        const mins = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
        const dur = (now - this.t0) / 1000;
        const hazardLines = this.entries.filter((e) => e.kind === 'hazard');
        const floods = hazardLines.filter((e) => e.text.includes('siren')).length;
        const gusts = hazardLines.filter((e) => e.text.includes('gust is coming')).length;
        const torn = hazardLines.filter((e) => e.text.includes('tore')).length;
        const washed = hazardLines.filter((e) => e.text.includes('left')).length;
        const first = (k: string) => (this.firsts.has(k) ? mins(this.firsts.get(k)!) : '—');
        return [
            `Playtest summary (${this.meta.level ?? '?'})`,
            `  length: ${mins(dur)}; most players at once: ${this.maxPlayers}`,
            `  finished: ${this.goalAt >= 0 ? `yes, at ${mins(this.goalAt)}` : 'no'}`,
            `  falls into the creek: ${this.count('fell')}; bucket recoveries: ${this.count('recovered')}`,
            `  floods: ${floods} (timber washed downstream ${washed}×); gusts: ${gusts} (torn from hands ${torn}×)`,
            `  restarts: ${this.count('restart')}; settings opened: ${this.count('menu')}; facilitator notes: ${this.count('note')}`,
            `  first grab: ${first('grab')}; first stage step: ${first('step')}; first hazard: ${first('hazard')}`
        ].join('\n');
    }

    /** The whole record as text: the summary, then one line per entry. */
    text(now: number): string {
        const lines = this.entries.map((e) => `${e.t.toFixed(1).padStart(7)}s  ${e.kind.padEnd(9)} ${e.text}`);
        return `${this.summary(now)}\n\nTimeline (seconds since the start)\n${lines.join('\n')}\n`;
    }
}
