import { afterEach, describe, expect, it, vi } from 'vitest';

import { localTransport } from '../../src/net/transport.ts';

// The tab-to-tab transport (BroadcastChannel). Leaving closes the channel; an update coalesced just
// before must not post on it afterwards ("Channel is closed", seen in the online co-op browser test).

describe('local transport', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('an update sent just before leaving does not post on the closed channel', async () => {
        vi.stubGlobal('addEventListener', () => undefined); // the page's pagehide hook
        const errors: unknown[] = [];
        const onError = (e: unknown) => errors.push(e);
        process.on('uncaughtException', onError);
        try {
            const t = localTransport();
            const room = await t.join('leave-race');
            room.setState({ a: 1 }); // sent now
            room.setState({ a: 2 }); // coalesced: sent ~33 ms later
            room.leave();
            t.lobby.leave();
            await new Promise((r) => setTimeout(r, 120));
        } finally {
            process.off('uncaughtException', onError);
        }
        expect(errors).toEqual([]);
    });
});
