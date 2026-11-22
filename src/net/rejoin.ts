/**
 * Rejoining after a reload (#93). Kept in sessionStorage, which belongs to one browser tab and
 * survives reloads and level switches in it: a rejoin token (the host gives a guest presenting it
 * their own player back) and the game this tab was last playing as a guest.
 */

import { SIM_HZ } from '../sim/clock.ts';

import { REJOIN_GRACE_TICKS, makeToken } from './session.ts';

const TOKEN_KEY = 'uncivil.net.token';
const GAME_KEY = 'uncivil.net.game';

function store(): Storage | null {
    try {
        return sessionStorage;
    } catch {
        return null;
    }
}

/** This tab's rejoin token (made on first use). */
export function rejoinToken(): string {
    const s = store();
    let t = s?.getItem(TOKEN_KEY) ?? null;
    if (!t || !/^[a-z0-9]{8,32}$/.test(t)) {
        t = makeToken();
        try {
            s?.setItem(TOKEN_KEY, t);
        } catch {
            // storage full or blocked: a rejoin then needs the same page (not a reload)
        }
    }
    return t;
}

/** Remembers the game this tab is in as a guest (call while playing, so the time stays fresh). */
export function rememberGame(code: string, level: string, now = Date.now()): void {
    try {
        store()?.setItem(GAME_KEY, JSON.stringify({ code, level, at: now }));
    } catch {
        // as above
    }
}

/** Forgets it (the player left on purpose, or the game ended). */
export function forgetGame(): void {
    try {
        store()?.removeItem(GAME_KEY);
    } catch {
        // as above
    }
}

/** The game this tab was in, if it was within the host's rejoin grace period. */
export function gameToRejoin(level: string, now = Date.now()): string | null {
    try {
        const v = JSON.parse(store()?.getItem(GAME_KEY) ?? 'null') as { code?: unknown; level?: unknown; at?: unknown };
        if (!v || typeof v.code !== 'string' || !/^[a-z0-9]{4}$/.test(v.code)) return null;
        if (v.level !== level || typeof v.at !== 'number') return null;
        return now - v.at < (REJOIN_GRACE_TICKS / SIM_HZ) * 1000 ? v.code : null;
    } catch {
        return null;
    }
}
