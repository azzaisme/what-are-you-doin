/**
 * A minimal in-memory Nostr relay for the browser tests of the peer-to-peer transport (the real
 * game uses public relays). It does only what WebRTC signalling needs: EVENT is forwarded to every
 * open subscription whose filter matches (kinds, `#x` tag), REQ answers EOSE (nothing is stored),
 * CLOSE ends a subscription. Signatures are not checked.
 */

import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';

interface Filter {
    kinds?: number[];
    '#x'?: string[];
}
interface NostrEvent {
    kind: number;
    tags: string[][];
    id: string;
}

export interface Relay {
    url: string;
    events: () => number;
    close(): Promise<void>;
}

function matches(f: Filter, e: NostrEvent): boolean {
    if (f.kinds && !f.kinds.includes(e.kind)) return false;
    const x = f['#x'];
    if (x && !e.tags.some((t) => t[0] === 'x' && x.includes(t[1]))) return false;
    return true;
}

export async function startRelay(port = 0): Promise<Relay> {
    const wss = new WebSocketServer({ port, host: '127.0.0.1' });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    const subs = new Map<WebSocket, Map<string, Filter[]>>();
    let events = 0;
    wss.on('connection', (ws) => {
        subs.set(ws, new Map());
        ws.on('close', () => subs.delete(ws));
        ws.on('message', (raw) => {
            let msg: unknown;
            try {
                msg = JSON.parse(String(raw));
            } catch {
                return;
            }
            if (!Array.isArray(msg)) return;
            const [type, a, ...rest] = msg as [string, unknown, ...unknown[]];
            if (type === 'REQ' && typeof a === 'string') {
                subs.get(ws)?.set(a, rest as Filter[]);
                ws.send(JSON.stringify(['EOSE', a]));
            } else if (type === 'CLOSE' && typeof a === 'string') {
                subs.get(ws)?.delete(a);
            } else if (type === 'EVENT' && a && typeof a === 'object') {
                const e = a as NostrEvent;
                events++;
                ws.send(JSON.stringify(['OK', e.id, true, '']));
                for (const [peer, s] of subs)
                    for (const [id, filters] of s)
                        if (filters.some((f) => matches(f, e))) peer.send(JSON.stringify(['EVENT', id, e]));
            }
        });
    });
    const addr = wss.address();
    const p = typeof addr === 'object' && addr ? addr.port : port;
    return {
        url: `ws://127.0.0.1:${p}`,
        events: () => events,
        close: () =>
            new Promise((r) => {
                for (const c of wss.clients) c.terminate();
                wss.close(() => r());
            })
    };
}
