/**
 * Player commands: plain, sequenced data (design doc §6.2). The local input layer produces them, the
 * simulation consumes them at fixed ticks, and a network adapter can carry them unchanged (Epic 3).
 * Edge-triggered requests (grab, throw, actions) are booleans/codes set on exactly one command.
 */

export const ACTION_NONE = 0;
/** Launch the ragdoll dummy from in front of the player (a deliberate comic event). */
export const ACTION_RAGDOLL = 1;
/** Run the scripted drop test: a plank dropped with spin from a fixed pose. */
export const ACTION_DROP_TEST = 2;
/** Put every physics prop back at its spawn pose. */
export const ACTION_RESET_PROPS = 3;
/** Let go of whatever is held (Q). */
export const ACTION_DROP = 4;
/** Start or stop pouring the bucket you hold (R): tip it forward, or let it hang again (Epic 7). */
export const ACTION_POUR = 5;
/** Swing the hammer: nail what the crosshair is on to what lies behind it (F). */
export const ACTION_NAIL = 6;
export const ACTION_MAX = 6;

export interface PlayerCommand {
    seq: number;
    /** Desired move in player space: x right, z forward, each -1..1. */
    moveX: number;
    moveZ: number;
    sprint: boolean;
    jump: boolean;
    /** Look yaw/pitch in radians (absolute, from the client's mouse look). */
    yaw: number;
    pitch: number;
    /** Scripted mode: carry the comfort-test plank. Physics mode: rising edge puts it in your grip. */
    carry: boolean;
    /** Edge: grab what the crosshair points at, or release what is held. */
    grab: boolean;
    /** Edge: throw what is held (bounded impulse along the view). */
    throw: boolean;
    /** Change of hold distance in metres requested on this command (mouse wheel). */
    reach: number;
    /** Edge: a discrete request (ACTION_*). */
    action: number;
}

export const PITCH_LIMIT = 1.45;
export const MAX_REACH_STEP = 1;

export function neutralCommand(seq = 0, yaw = 0, pitch = 0): PlayerCommand {
    return {
        seq,
        moveX: 0,
        moveZ: 0,
        sprint: false,
        jump: false,
        yaw,
        pitch,
        carry: false,
        grab: false,
        throw: false,
        reach: 0,
        action: ACTION_NONE
    };
}

const finite = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/**
 * Validates a command from an untrusted source (a remote client later): every number finite and in
 * range, booleans coerced, unknown actions dropped. The simulation only ever sees sanitized commands.
 */
export function sanitizeCommand(c: Partial<PlayerCommand> | null | undefined): PlayerCommand {
    const src = c ?? {};
    const yaw = finite(src.yaw);
    const action = Math.trunc(finite(src.action));
    return {
        seq: Math.max(0, Math.trunc(finite(src.seq))),
        moveX: clamp(finite(src.moveX), -1, 1),
        moveZ: clamp(finite(src.moveZ), -1, 1),
        sprint: src.sprint === true,
        jump: src.jump === true,
        // wrap yaw so a long session cannot lose precision
        yaw: Math.atan2(Math.sin(yaw), Math.cos(yaw)),
        pitch: clamp(finite(src.pitch), -PITCH_LIMIT, PITCH_LIMIT),
        carry: src.carry === true,
        grab: src.grab === true,
        throw: src.throw === true,
        reach: clamp(finite(src.reach), -MAX_REACH_STEP, MAX_REACH_STEP),
        action: action >= 0 && action <= ACTION_MAX ? action : ACTION_NONE
    };
}
