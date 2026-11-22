/**
 * Drives one player of a LabSim with player commands only (look, walk, grab, pour), for tests that
 * play a level the way a person would. Setup (where a player starts) may still use placePlayer;
 * everything the player then does goes through `step`.
 */

import { ACTION_POUR, neutralCommand } from '../../src/sim/commands.ts';
import type { PlayerCommand } from '../../src/sim/commands.ts';
import { EYE_HEIGHT } from '../../src/sim/lab-sim.ts';
import type { LabSim } from '../../src/sim/lab-sim.ts';

export class Player {
    readonly s: LabSim;
    readonly slot: number;
    yaw = 0;
    pitch = 0;
    private n = 1;
    /** Steps the sim with this player's command (other players stand still). */
    send: (c: PlayerCommand) => void;

    constructor(s: LabSim, slot = 0, send?: (c: PlayerCommand) => void) {
        this.s = s;
        this.slot = slot;
        this.yaw = s.players[slot].yaw;
        this.send =
            send ??
            ((c) => {
                if (slot === 0) s.step(c);
                else s.step(neutralCommand(0, s.player.yaw, s.player.pitch), slot === 1 ? c : undefined);
            });
    }

    get p() {
        return this.s.players[this.slot];
    }

    step(c: Partial<PlayerCommand> = {}, k = 1): void {
        for (let i = 0; i < k; i++) this.send({ ...neutralCommand(this.n++, this.yaw, this.pitch), ...c });
    }

    /** Turns to look at a point over `ticks` (smoothly, as a mouse would). */
    lookAt(x: number, y: number, z: number, ticks = 20): void {
        const p = this.p;
        const yaw = Math.atan2(-(x - p.x), -(z - p.z));
        const pitch = Math.atan2(y - (p.y + EYE_HEIGHT), Math.hypot(x - p.x, z - p.z));
        let d = yaw - this.yaw;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        const y0 = this.yaw;
        const p0 = this.pitch;
        for (let i = 1; i <= ticks; i++) {
            this.yaw = y0 + (d * i) / ticks;
            this.pitch = p0 + ((pitch - p0) * i) / ticks;
            this.step();
        }
    }

    /** Walks to (x, z), turning towards it as it goes; returns whether it got within `near`. */
    walkTo(x: number, z: number, near = 0.3, maxTicks = 3000): boolean {
        for (let i = 0; i < maxTicks; i++) {
            const p = this.p;
            const dx = x - p.x;
            const dz = z - p.z;
            const dist = Math.hypot(dx, dz);
            if (dist < near) break;
            const want = Math.atan2(-dx, -dz);
            let d = want - this.yaw;
            d = Math.atan2(Math.sin(d), Math.cos(d));
            // turn at most ~3 rad/s, and walk only once roughly facing the way
            this.yaw += Math.max(-0.05, Math.min(0.05, d));
            this.step({ moveZ: Math.abs(d) < 0.6 ? Math.min(1, dist) : 0 });
        }
        this.step({}, 30);
        return Math.hypot(x - this.p.x, z - this.p.z) < near + 0.1;
    }

    /** Looks at the bucket and grabs it; returns whether it is now held. */
    grabBucket(): boolean {
        const b = this.s.bucket.pose.p;
        this.lookAt(b.x, b.y + 0.2, b.z);
        this.step({ grab: true });
        this.step({}, 5);
        return this.s.physics.heldIdOf(this.slot) === this.s.bucket.id;
    }

    /** Starts or stops pouring the bucket held. */
    togglePour(): void {
        this.step({ action: ACTION_POUR });
    }

    /**
     * Holds the bucket so its mouth (rim centre) hangs over (x, z) at about `mouthY`, steering with
     * small steps and the view's pitch, for up to `ticks` ticks (stopping early once `until` holds).
     */
    holdOver(x: number, z: number, mouthY: number, ticks: number, until?: () => boolean): void {
        const s = this.s;
        for (let i = 0; i < ticks && !until?.(); i++) {
            const b = s.bucket.pose.p;
            const ex = x - b.x;
            const ez = z - b.z;
            const fx = -Math.sin(this.yaw);
            const fz = -Math.cos(this.yaw);
            const rx = Math.cos(this.yaw);
            const rz = -Math.sin(this.yaw);
            // gentle: a hanging bucket swings if you hurry it, so creep, and stand still when close
            const k = Math.hypot(ex, ez) < 0.2 ? 0 : 0.5;
            const clamp = (v: number) => Math.max(-0.25, Math.min(0.25, v));
            const mouth = b.y + 0.3;
            this.pitch = Math.max(-1.3, Math.min(0.5, this.pitch + (mouthY - mouth) * 0.03));
            this.step({ moveX: clamp((ex * rx + ez * rz) * k), moveZ: clamp((ex * fx + ez * fz) * k) });
        }
    }
}
