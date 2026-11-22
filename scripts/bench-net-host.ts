/**
 * Online host cost by player count (Epic 10, #92): the host's simulation tick plus its snapshot
 * publishing, with every player walking, in the Timber Yard and the Valley at 1, 4 and 8 players.
 * Reports the tick time (average and p95 over 600 ticks, after 60 warm-up ticks), the snapshot size
 * and the largest host state it published (the room capability allows 4,096 bytes per participant).
 *
 * Usage: node scripts/bench-net-host.ts            (UE_CELL_CM=10 for the 10 cm world)
 */
import os from 'node:os';

import { timberYardLevel } from '../src/levels/timber-yard.ts';
import { valleyLevel } from '../src/levels/valley.ts';
import { HostSession } from '../src/net/session.ts';
import { MemoryHub } from '../src/net/transport.ts';
import { neutralCommand } from '../src/sim/commands.ts';
import { LabSim, MAX_PLAYERS } from '../src/sim/lab-sim.ts';
import { initPhysics } from '../src/sim/physics/world.ts';

await initPhysics();
console.log(`CPU: ${os.cpus()[0]?.model ?? 'unknown'}; cell ${process.env.UE_CELL_CM ?? 'default'} cm`);

for (const level of [timberYardLevel, valleyLevel]) {
    for (const n of [1, 4, MAX_PLAYERS]) {
        const sim = new LabSim({ level });
        sim.step(neutralCommand(0));
        sim.fpActive = true;
        const hub = new MemoryHub();
        const hs = await HostSession.start(hub.transport('host'), sim, level.id, 'bnch');
        for (let i = 1; i < n; i++) sim.setSlotActive(i, true);
        const probe = hub.channel('room-ue-bnch', 'probe');
        const walk = (k: number) => ({ ...neutralCommand(k, level.spawn.yaw, 0), moveZ: 1 });
        const step = (k: number) => {
            const c = Array.from({ length: MAX_PLAYERS }, () => walk(k));
            sim.step(walk(k), c[1], c.slice(2));
            hs.afterStep((s) => sim.interactionIds(s));
        };
        for (let k = 0; k < 60; k++) step(k);
        const ms: number[] = [];
        let stateBytes = 0;
        for (let k = 0; k < 600; k++) {
            const t0 = performance.now();
            step(60 + k);
            ms.push(performance.now() - t0);
            const st = probe.peers().find((p) => p.id === 'host')?.state;
            if (st) stateBytes = Math.max(stateBytes, JSON.stringify(st).length);
        }
        ms.sort((a, b) => a - b);
        const avg = ms.reduce((a, b) => a + b, 0) / ms.length;
        console.log(
            `${level.id.padEnd(8)} ${String(n).padStart(2)} players: tick ${avg.toFixed(2)} ms (p95 ${ms[Math.floor(ms.length * 0.95)].toFixed(2)}),` +
                ` snapshot ${hs.lastSnapshotBytes} B, host state up to ${stateBytes} B`
        );
        hs.stop();
    }
}
