import { beforeAll, describe, expect, it } from 'vitest';

import { timberYardLevel } from '../../src/levels/timber-yard.ts';
import { GuestSession, HostSession, listGames } from '../../src/net/session.ts';
import { MemoryHub } from '../../src/net/transport.ts';
import { neutralCommand } from '../../src/sim/commands.ts';
import { LabSim } from '../../src/sim/lab-sim.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';

beforeAll(() => initPhysics());

describe('a host whose page goes to the background (#103)', () => {
    it('tells its guests the world is waiting, and that it is back; the guest does not leave', async () => {
        const hub = new MemoryHub();
        const host = new LabSim({ level: timberYardLevel });
        host.step(neutralCommand(0));
        host.fpActive = true;
        const hs = await HostSession.start(hub.transport('host'), host, 'yard', 'away');
        const ad = listGames(hub.channel('lobby', 'w'))[0];
        let clock = 0;
        const gs = await GuestSession.join(hub.transport('guest'), new LabSim({ level: timberYardLevel }), ad, {
            now: () => clock
        });
        for (let n = 0; n < 30; n++) {
            host.step(neutralCommand(n));
            hs.afterStep((s) => host.interactionIds(s));
        }
        expect(gs.received).toBeGreaterThan(0);
        expect(gs.hostAway).toBe(false);
        hs.setAway(true);
        expect(gs.hostAway).toBe(true);
        // a hidden page draws no frames: no snapshots for a long while, and the guest stays
        clock += 120_000;
        expect(gs.reconnecting).toBe(false);
        expect(gs.hostGone).toBe(false);
        hs.setAway(false);
        expect(gs.hostAway).toBe(false);
        hs.stop();
    });
});
