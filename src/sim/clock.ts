/**
 * Time model (design doc §4.4).
 *
 * - Simulation: fixed 1/60 s steps from accumulated wall time, with capped catch-up.
 * - Rendering: interpolates between simulation snapshots at display rate (one tick behind).
 * - Voxels: a global voxel clock (12/20/30/60 Hz) samples the interpolated poses at its own frame
 *   times. All visible solids are reconstructed for the same voxel time.
 */

export const SIM_HZ = 60;
export const SIM_DT = 1 / SIM_HZ;
export const MAX_CATCHUP_STEPS = 4;
/** Catch-up cap of the browser tests' fast clock (one second of steps per drawn frame). */
export const FAST_CATCHUP_STEPS = 60;
export const VOXEL_RATES = [12, 20, 30, 60] as const;
export type VoxelRate = (typeof VOXEL_RATES)[number];

export class FixedStepClock {
    /** Completed simulation ticks. */
    tick = 0;
    private acc = 0;
    /** Ticks dropped because catch-up was capped (instrumented, not hidden). */
    droppedTicks = 0;
    /** Most steps one call to `advance` returns (the browser tests' fast clock raises it). */
    maxSteps = MAX_CATCHUP_STEPS;

    /** Adds wall time; returns how many fixed steps to run now (0..maxSteps). */
    advance(frameDt: number): number {
        if (!(frameDt > 0) || !Number.isFinite(frameDt)) return 0;
        this.acc += frameDt;
        let steps = Math.floor(this.acc / SIM_DT + 1e-9);
        if (steps > this.maxSteps) {
            this.droppedTicks += steps - this.maxSteps;
            steps = this.maxSteps;
            this.acc = steps * SIM_DT; // drop the backlog instead of spiralling
        }
        this.acc -= steps * SIM_DT;
        if (this.acc < 0) this.acc = 0;
        return steps;
    }

    /** Fraction of a step accumulated since the last completed tick, in [0, 1). */
    get alpha(): number {
        return Math.min(0.999999, this.acc / SIM_DT);
    }

    /**
     * Render time: interpolation runs one tick behind the newest snapshot, so it always lies
     * between two completed snapshots.
     */
    get renderTime(): number {
        return Math.max(0, (this.tick - 1 + this.alpha) * SIM_DT);
    }

    reset(tick = 0): void {
        this.tick = tick;
        this.acc = 0;
        this.droppedTicks = 0;
    }
}

export class VoxelClock {
    hz: VoxelRate = 20;
    /** Index of the last reconstructed voxel frame, or -1 before the first. */
    frame = -1;

    /** Voxel frame index containing a render time. */
    frameAt(time: number): number {
        return Math.floor(time * this.hz + 1e-9);
    }

    /** Time of a voxel frame. */
    timeOf(frame: number): number {
        return frame / this.hz;
    }

    /** True when a render time has entered a new voxel frame. */
    due(time: number): boolean {
        return this.frameAt(time) !== this.frame;
    }

    setRate(hz: VoxelRate): void {
        this.hz = hz;
        this.frame = -1;
    }
}
