/**
 * "Play online" panel: host a game or join one advertised in the lobby. DOM only; the caller owns
 * the sessions. Text from other devices (game codes, levels) is shown with textContent only.
 */

import type { P2PStatus } from '../net/p2p.ts';
import type { GameAd, ListedGame } from '../net/session.ts';

export interface OnlinePanelHost {
    available(): 'room' | 'local' | 'p2p' | 'none';
    /** The panel was opened (the peer-to-peer lobby connects then). */
    opened?(): void;
    /** Peer to peer: relay and lobby status, or null while starting. */
    p2pStatus?(): P2PStatus | null;
    games(): ListedGame[];
    level: string;
    status(): OnlineStatus;
    host(): Promise<void>;
    join(ad: GameAd): Promise<void>;
    leave(): void;
}

export interface OnlineStatus {
    mode: 'off' | 'host' | 'guest';
    code?: string;
    players?: number;
    max?: number;
    /** Host: the guests' players and their round trip (ms, null while unknown). */
    guests?: { slot: number; lagMs: number | null }[];
    /** Host: players kept for a guest who lost their connection. */
    dropped?: number[];
    /** Guest: their player slot (-1 while watching a full game). */
    slot?: number;
    waiting?: boolean;
    /** Guest: round trip to the host, ms. */
    lagMs?: number | null;
    /** Guest: the host went quiet; waiting for it to come back. */
    reconnecting?: boolean;
    /** Guest: the host's page is in the background; the world waits for it. */
    hostAway?: boolean;
}

const lagText = (ms: number | null | undefined) => (ms === null || ms === undefined ? '…' : `${ms} ms`);

export class OnlinePanel {
    readonly button: HTMLButtonElement;
    readonly el: HTMLDivElement;
    private readonly host: OnlinePanelHost;
    private open = false;
    private ticker: ReturnType<typeof setInterval> | undefined;

    constructor(host: OnlinePanelHost, dock: HTMLElement) {
        this.host = host;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'online-chip';
        b.textContent = 'Play online';
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggle();
        });
        dock.insertBefore(b, dock.lastElementChild);
        this.button = b;
        const el = document.createElement('div');
        el.className = 'online-panel';
        el.style.display = 'none';
        for (const ev of ['pointerdown', 'mousedown', 'wheel', 'click', 'touchstart'])
            el.addEventListener(ev, (e) => e.stopPropagation());
        document.body.append(el);
        this.el = el;
    }

    toggle(force?: boolean): void {
        this.open = force ?? !this.open;
        this.el.style.display = this.open ? '' : 'none';
        if (this.open) {
            this.host.opened?.();
            this.render();
        }
        // the connection status changes without lobby events: refresh it while open
        clearInterval(this.ticker);
        // (and the players' round trips)
        if (this.open) this.ticker = setInterval(() => this.render(), 1000);
    }

    get visible(): boolean {
        return this.open;
    }

    /** Re-renders (call when the lobby or the session changes). */
    render(): void {
        const st = this.host.status();
        this.button.textContent =
            st.mode === 'host'
                ? `Hosting ${st.code} · ${st.players}/${st.max}`
                : st.mode === 'guest'
                  ? `In game ${st.code}`
                  : 'Play online';
        this.button.classList.toggle('live', st.mode !== 'off');
        if (!this.open) return;
        const el = this.el;
        el.replaceChildren();
        const h = document.createElement('div');
        h.className = 'online-title';
        h.textContent = 'Play online';
        el.append(h);
        const note = (text: string, cls = 'online-note') => {
            const p = document.createElement('p');
            p.className = cls;
            p.textContent = text;
            el.append(p);
        };
        const button = (label: string, fn: () => void, cls = '') => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = label;
            if (cls) b.className = cls;
            b.addEventListener('click', fn);
            el.append(b);
            return b;
        };
        const avail = this.host.available();
        if (avail === 'none') {
            note('Online play could not start in this browser. Split-screen co-op still works: plug in a controller.');
            button('Close', () => this.toggle(false));
            return;
        }
        if (st.mode === 'host') {
            note(
                `Hosting game ${st.code}. Players: ${st.players}/${st.max}. Friends open this page and tap “Play online”, then join ${st.code}.`
            );
            for (const g of st.guests ?? [])
                note(`Player ${g.slot + 1} · round trip ${lagText(g.lagMs)}`, 'online-sub');
            for (const s of st.dropped ?? [])
                note(`Player ${s + 1} lost their connection: their place is kept for a minute.`, 'online-warn');
            note('Your device runs the game for everyone: keep this page open and in front.', 'online-warn');
            button('Stop hosting', () => this.host.leave());
            button('Close', () => this.toggle(false));
            return;
        }
        if (st.mode === 'guest') {
            note(
                st.waiting
                    ? `Joined ${st.code}, waiting for the host…`
                    : st.slot !== undefined && st.slot < 0
                      ? `Game ${st.code} is full: you are watching, and get the first place that frees up.`
                      : `Playing in game ${st.code} as player ${(st.slot ?? 0) + 1} · round trip ${lagText(st.lagMs)}.`
            );
            if (st.reconnecting) note('Lost the host: reconnecting…', 'online-warn');
            else if (st.hostAway)
                note("The host's game is in the background: it may stop until they come back.", 'online-warn');
            button('Leave game', () => this.host.leave());
            button('Close', () => this.toggle(false));
            return;
        }
        button('Host a game', () => void this.host.host().then(() => this.render()), 'online-primary');
        const games = this.host.games();
        const sub = document.createElement('div');
        sub.className = 'online-sub';
        sub.textContent = games.length
            ? 'Games here now'
            : 'No games yet: someone taps “Host a game”, the others join it here.';
        el.append(sub);
        for (const g of games) {
            const same = g.level === this.host.level;
            // a full game can still be joined, to watch until a place frees up
            // another version of the game can't be joined: say so (the older page needs a reload)
            const label = g.compatible
                ? `${g.full ? 'Watch' : 'Join'} ${g.code} · ${g.players}/${g.max}${same ? '' : ' (other level)'}${g.full ? ' · full' : ''}`
                : `${g.code} · another version of the game: reload both pages to play together`;
            const b = button(label, () => void this.host.join(g).then(() => this.render()), 'online-game');
            b.disabled = !same || !g.compatible;
        }
        if (avail === 'local') note('Local test mode: tabs of this browser only.', 'online-warn');
        if (avail === 'p2p') {
            const st = this.host.p2pStatus?.() ?? null;
            if (!st) note('Connecting…');
            else if (st.relaysOpen === 0)
                note(
                    `Can't reach the matchmaking relays yet (0/${st.relays}). If this stays, a firewall, VPN or ad blocker may be blocking them.`,
                    'online-warn'
                );
            else if (st.peers === 0)
                note(
                    `Looking for other players… (relays ${st.relaysOpen}/${st.relays}). The others need this panel open too; finding each other can take up to a minute.`
                );
            else
                note(
                    `${st.peers} other player${st.peers === 1 ? '' : 's'} connected (relays ${st.relaysOpen}/${st.relays}). Games show up a few seconds after they start.`
                );
            if (st?.error && st.peers === 0)
                note(
                    /could not connect to peer/.test(st.error)
                        ? st.turn
                            ? 'Found another player but could not connect, even through the relay server. Trying again…'
                            : 'Found another player but could not connect directly: one of your networks blocks it (common on one shared Wi-Fi). Trying again… A relay server (TURN) would fix this.'
                        : `Connection problem: ${st.error}`,
                    'online-warn'
                );
        }
        button('Close', () => this.toggle(false));
    }
}
