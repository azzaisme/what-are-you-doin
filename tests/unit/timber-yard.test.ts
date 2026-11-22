import { beforeAll, describe, expect, it } from 'vitest';

import {
    BRIDGE,
    BRIDGE_X,
    BUCKET_STUMP,
    CREEK_WATER_Y,
    YARD_GOAL,
    YARD_Y,
    creekCenterZ,
    timberYardLevel,
    yardHeight
} from '../../src/levels/timber-yard.ts';
import { neutralCommand } from '../../src/sim/commands.ts';
import type { PlayerCommand } from '../../src/sim/commands.ts';
import { EYE_HEIGHT, LabSim } from '../../src/sim/lab-sim.ts';
import { initPhysics } from '../../src/sim/physics/world.ts';
import { pose, quatFromYawPitchRoll, quatMul } from '../../src/voxels/math.ts';
import { VoxelWorld } from '../../src/voxels/world.ts';

beforeAll(() => initPhysics());

const cmd = (n: number, c: Partial<PlayerCommand> = {}): PlayerCommand => ({ ...neutralCommand(n), ...c });
const yard = () => new LabSim({ level: timberYardLevel });
const S_TICKS = (sec: number) => Math.round(sec * 60);
const byName = (s: LabSim, n: string) => s.entities.find((e) => e.name === n)!;

/** Lays both beams flat across the gap, side by side, long axis along Z. */
function bridgeBeams(s: LabSim): void {
    const flatAlongZ = quatMul(quatFromYawPitchRoll(Math.PI / 2, 0, 0), quatFromYawPitchRoll(0, Math.PI / 2, 0));
    ['beam-0', 'beam-1'].forEach((n, i) =>
        s.physics.place(byName(s, n).id, pose(BRIDGE_X - 0.105 + i * 0.21, YARD_Y + 0.12, BRIDGE.zc, flatAlongZ))
    );
}

describe('level 1: the timber yard', () => {
    it('builds a static voxel world with the creek, the bridge abutments and the yard', () => {
        const w = new VoxelWorld();
        const r = timberYardLevel.build(w, 1);
        expect(r.columns).toBeGreaterThan(300_000);
        expect(r.trees).toBeGreaterThan(30);
        const l = timberYardLevel.layout(1);
        for (const name of [
            'abutment-near',
            'abutment-far',
            'shed-roof',
            'saw-bench',
            'stump',
            'flag',
            'flower-centre'
        ])
            expect(l.pieces.some((p) => p.name === name)).toBe(true);
        // nothing grows on the road, in the creek or in the yard
        for (const t of l.trees) expect(Math.abs(t.z - creekCenterZ(t.x))).toBeGreaterThan(2);
    }, 60_000); // the full static build takes ~10 s at 5 cm

    it('the gap is spannable by a 3.2 m beam but too wide to step or jump', () => {
        expect(BRIDGE.gap).toBeGreaterThan(2.3);
        expect(BRIDGE.gap).toBeLessThan(3.2 - 0.4); // at least 20 cm bearing on each abutment
        // the creek is deep below the banks
        expect(YARD_Y - CREEK_WATER_Y).toBeGreaterThan(0.7);
        expect(yardHeight(BRIDGE_X, BRIDGE.zc)).toBeLessThan(CREEK_WATER_Y - 0.4);
    });

    it('starts with every prop at rest: the plank stack and the log pile hold, nothing is lost', () => {
        const s = yard();
        for (let n = 0; n < 360; n++) s.step(cmd(n));
        expect(s.physics.stats.activeBodies).toBe(0);
        expect(s.physics.stats.recovered).toBe(0);
        expect(byName(s, 'extra-plank-4').pose.p.y).toBeGreaterThan(YARD_Y + 0.5); // top of the stack
        expect(byName(s, 'extra-log-1').pose.p.y).toBeGreaterThan(YARD_Y + 0.5); // on top of the pile
        const b = s.bucket.pose.p;
        expect(Math.hypot(b.x - BUCKET_STUMP.x, b.z - BUCKET_STUMP.z)).toBeLessThan(0.1);
        expect(b.y).toBeGreaterThan(BUCKET_STUMP.top - 0.03);
        expect(s.sphere.visible).toBe(false); // not part of this level
        // the ute (a vehicle, never asleep) stays parked where the level put it
        const spot = timberYardLevel.actors.ute;
        if (spot.mode !== 'drivable') throw new Error('the yard ute is drivable');
        expect(Math.hypot(s.ute.pose.p.x - spot.pose.p.x, s.ute.pose.p.z - spot.pose.p.z)).toBeLessThan(0.05);
        expect(Math.abs(s.ute.pose.p.y - spot.pose.p.y)).toBeLessThan(0.08);
    });

    it('falling into the creek puts you back on the bank; you cannot climb out on your own', () => {
        const s = yard();
        s.step(cmd(0));
        s.fpActive = true;
        s.placePlayer(BRIDGE_X + 5, 2.5, 0);
        for (let n = 0; n < 30; n++) s.step(cmd(n));
        for (let n = 0; n < 240 && s.progress.falls === 0; n++) s.step(cmd(100 + n, { moveZ: 1 }));
        expect(s.progress.falls).toBe(1);
        expect(s.events.at(-1)?.kind).toBe('fell');
        expect(s.player.y).toBeGreaterThan(YARD_Y - 0.1);
        expect(timberYardLevel.rules!.isSafe(s.player.x, s.player.z)).toBe(true);
    });

    it('two beams laid across the gap carry you to the far bank', () => {
        const s = yard();
        bridgeBeams(s);
        for (let n = 0; n < 120; n++) s.step(cmd(n));
        s.fpActive = true;
        s.placePlayer(BRIDGE_X, 1.4, 0);
        for (let n = 0; n < 300; n++) s.step(cmd(200 + n, { moveZ: 1 }));
        expect(s.player.z).toBeLessThan(YARD_GOAL.maxZ);
        expect(s.progress.falls).toBe(0);
    });

    it('a beam can be lifted alone (36 kg), the log cannot (113 kg)', () => {
        const s = yard();
        for (let n = 0; n < 60; n++) s.step(cmd(n));
        const beam = byName(s, 'beam-1');
        s.fpActive = true;
        s.placePlayer(beam.pose.p.x, beam.pose.p.z + 1.3, 0);
        const pitch = -Math.atan2(s.player.y + EYE_HEIGHT - beam.pose.p.y, 1.3);
        for (let n = 0; n < 5; n++) s.step(cmd(100 + n, { pitch }));
        s.step(cmd(110, { grab: true, pitch }));
        expect(s.physics.heldId).toBe(beam.id);
        const y0 = beam.pose.p.y;
        for (let n = 0; n < 120; n++) s.step(cmd(111 + n, { pitch: -0.1 }));
        expect(beam.pose.p.y).toBeGreaterThan(y0 + 0.4);
    });

    it('the objective: the bucket resting by the far-bank flag completes it, once', () => {
        const s = yard();
        s.step(cmd(0));
        s.physics.place(s.bucket.id, pose((YARD_GOAL.minX + YARD_GOAL.maxX) / 2, yardHeight(BRIDGE_X, -7) + 0.3, -7));
        for (let n = 0; n < 120; n++) s.step(cmd(n));
        expect(s.progress.goalReached).toBe(true);
        expect(s.events.filter((e) => e.kind === 'goal').length).toBe(1);
        for (let n = 0; n < 120; n++) s.step(cmd(200 + n));
        expect(s.events.filter((e) => e.kind === 'goal').length).toBe(1);
    });

    it('a bucket dropped in the creek comes back to its stump', () => {
        const s = yard();
        s.step(cmd(0));
        s.physics.place(s.bucket.id, pose(BRIDGE_X + 3, CREEK_WATER_Y + 0.5, creekCenterZ(BRIDGE_X + 3)));
        for (let n = 0; n < 240; n++) s.step(cmd(n));
        expect(s.progress.recoveries).toBe(1);
        expect(Math.hypot(s.bucket.pose.p.x - BUCKET_STUMP.x, s.bucket.pose.p.z - BUCKET_STUMP.z)).toBeLessThan(0.2);
        expect(s.progress.goalReached).toBe(false);
    });

    it('a held bucket hangs from its handle and stays steady (no per-tick shaking)', () => {
        const s = yard();
        for (let n = 0; n < 60; n++) s.step(cmd(n));
        s.fpActive = true;
        const b = s.bucket.pose.p;
        s.placePlayer(b.x, b.z + 1.2, 0);
        for (let n = 0; n < 30; n++) s.step(cmd(60 + n));
        const pitch = -Math.atan2(s.player.y + EYE_HEIGHT - (b.y + 0.15), 1.2);
        for (let n = 0; n < 10; n++) s.step(cmd(100 + n, { pitch }));
        s.step(cmd(200, { grab: true, pitch }));
        expect(s.physics.heldId).toBe(s.bucket.id);
        // let the pickup swing settle, then stand still and turn slowly
        for (let n = 0; n < 120; n++) s.step(cmd(300 + n, { pitch: -0.2 }));
        const weight = s.physics.bodies.get(s.bucket.id)!.body.mass() * 9.81;
        let prevVy = 0;
        let flips = 0;
        let maxTilt = 0;
        let maxForce = 0;
        let prevY = s.bucket.pose.p.y;
        for (let n = 0; n < 240; n++) {
            s.step(cmd(500 + n, { pitch: -0.2, yaw: n * 0.008 }));
            const vy = s.bucket.pose.p.y - prevY;
            prevY = s.bucket.pose.p.y;
            if (Math.sign(vy) !== Math.sign(prevVy) && Math.abs(vy) > 2e-4) flips++;
            prevVy = vy;
            const q = s.bucket.pose.q;
            maxTilt = Math.max(maxTilt, (Math.acos(Math.min(1, 1 - 2 * (q.x * q.x + q.z * q.z))) * 180) / Math.PI);
            maxForce = Math.max(maxForce, s.physics.stats.grabForce);
        }
        expect(s.physics.heldId).toBe(s.bucket.id);
        // before the fix: ~500 N on a 1.5 kg bucket, spinning at 30 rad/s, reversing every tick
        expect(flips).toBeLessThan(6);
        expect(maxForce).toBeLessThan(weight * 2);
        // the lanky stand-in people hold it further from the turning axis than beavers (higher
        // eye): measured 20.0 deg for them, ~15 for beavers
        expect(maxTilt).toBeLessThan(22);
    });

    it('finishable with inputs only: carry the bucket to the near abutment and throw it over', () => {
        // the shortcut (freeform, design doc §2.1): played through player commands only, no bridge
        const s = yard();
        let n = 0;
        let pitch = 0;
        const step = (c: Partial<PlayerCommand> = {}, k = 1) => {
            for (let i = 0; i < k; i++) s.step(cmd(n++, { pitch, ...c }));
        };
        step({}, 60);
        s.fpActive = true;
        const bucket = byName(s, 'bucket');
        s.placePlayer(BUCKET_STUMP.x, BUCKET_STUMP.z + 1, 0);
        step({}, 20);
        pitch = -Math.atan2(s.player.y + EYE_HEIGHT - bucket.pose.p.y, s.player.z - bucket.pose.p.z);
        step({}, 3);
        step({ grab: true });
        expect(s.physics.heldId).toBe(bucket.id);
        pitch = 0;
        for (let i = 0; i < 900 && Math.abs(s.player.x - BRIDGE_X) > 0.1; i++)
            step({ moveX: s.player.x > BRIDGE_X ? -0.6 : 0.6 });
        for (let i = 0; i < 900 && s.player.z > BRIDGE.nearFace + 0.25; i++) step({ moveZ: 0.6 });
        expect(s.progress.falls).toBe(0);
        step({}, 30);
        for (let i = 0; i < 20; i++) {
            pitch += (0.5 - pitch) / 6;
            step();
        }
        step({}, 20);
        step({ throw: true });
        step({}, 240);
        expect(s.progress.goalReached).toBe(true);
        expect(s.player.z).toBeGreaterThan(BRIDGE.nearFace); // the player never crossed
    }, 60_000);

    it('finishable with inputs only by building the bridge: shoulder both beams over, walk back for the bucket and carry it across at a normal pace', () => {
        const s = yard();
        let n = 0;
        let yaw = 0;
        let pitch = 0;
        const step = (c: Partial<PlayerCommand> = {}, k = 1) => {
            for (let i = 0; i < k; i++) s.step(cmd(n++, { yaw, pitch, ...c }));
        };
        const ease = (to: number, k: number, set: (v: number) => void, from: number) => {
            for (let i = 1; i <= k; i++) {
                set(from + ((to - from) * i) / k);
                step();
            }
        };
        const goTo = (x: number, zStop: number, pace = 0.4) => {
            for (let i = 0; i < 900 && Math.abs(s.player.x - x) > 0.05; i++)
                step({ moveX: (s.player.x > x ? -1 : 1) * Math.min(pace, Math.abs(s.player.x - x) * 2 + 0.1) });
            for (let i = 0; i < 900 && s.player.z > zStop; i++) step({ moveZ: Math.max(0.5, pace) });
            step({}, 30);
        };
        /** Walks (full stick, no sprint) facing the way it goes, to within 0.3 m of (x, z). */
        const walkTo = (x: number, z: number) => {
            for (let i = 0; i < 1800; i++) {
                const dx = x - s.player.x;
                const dz = z - s.player.z;
                if (Math.hypot(dx, dz) < 0.3) break;
                // forward is (-sin yaw, -cos yaw)
                yaw = Math.atan2(-dx, -dz);
                step({ moveZ: 1 });
            }
        };
        step({}, 60);
        s.fpActive = true;
        for (const [name, x] of [
            ['beam-0', BRIDGE_X - 0.12],
            ['beam-1', BRIDGE_X + 0.12]
        ] as const) {
            const beam = byName(s, name);
            // stand off the beam's +x end, facing it (-x), and take it by that end on your shoulder
            yaw = Math.PI / 2;
            s.placePlayer(beam.pose.p.x + 2.4, beam.pose.p.z, yaw);
            step({}, 20);
            pitch = -Math.atan2(s.player.y + EYE_HEIGHT - beam.pose.p.y, s.player.x - (beam.pose.p.x + 1.45));
            step({}, 5);
            step({ grab: true });
            expect(s.physics.heldId).toBe(beam.id);
            ease(-0.25, 40, (v) => (pitch = v), pitch);
            step({}, 30);
            // turn to the creek: the beam turns with you and points out over the gap
            ease(0, 120, (v) => (yaw = v), yaw);
            goTo(x, BRIDGE.nearEdge + 0.4);
            ease(-0.7, 40, (v) => (pitch = v), pitch);
            step({}, 30);
            step({ grab: true });
            step({}, 120);
            expect(s.physics.heldId).toBe(-1);
            // it rests on both abutments, level
            const along = Math.abs(beam.pose.p.z - BRIDGE.zc);
            expect(along).toBeLessThan(0.3);
            expect(Math.abs(beam.pose.p.y - (YARD_Y + 0.12))).toBeLessThan(0.25);
        }
        expect(s.progress.falls).toBe(0);
        // walk back to the stump for the bucket (no teleport, no sprint) and carry it over the new
        // bridge to the flag: the flood the finished bridge set off (Epic 8) leaves time for that
        const bucket = byName(s, 'bucket');
        const bridgeDone = s.tick;
        pitch = 0;
        walkTo(BUCKET_STUMP.x, BUCKET_STUMP.z + 1);
        yaw = 0;
        step({}, 10);
        pitch = -Math.atan2(s.player.y + EYE_HEIGHT - bucket.pose.p.y, s.player.z - bucket.pose.p.z);
        step({}, 3);
        step({ grab: true });
        expect(s.physics.heldId).toBe(bucket.id);
        pitch = 0;
        goTo(BRIDGE_X, (YARD_GOAL.minZ + YARD_GOAL.maxZ) / 2, 1);
        // the finished bridge set off the flood, and a walk was quick enough: the water is still
        // well below the capstones (0.5 m) the beams rest on
        expect(s.events.some((e) => e.kind === 'hazard' && e.text.includes('siren'))).toBe(true);
        expect(s.hazards.waterY).toBeLessThan(0.3);
        expect(s.tick - bridgeDone).toBeLessThan(S_TICKS(20));
        expect(s.progress.falls).toBe(0);
        expect(s.player.z).toBeLessThan(BRIDGE.farEdge);
        step({ grab: true });
        step({}, 90);
        expect(s.progress.goalReached).toBe(true);
    }, 120_000);
});
