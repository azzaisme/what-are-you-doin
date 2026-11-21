/**
 * The tutorial: a fenced meadow lane with one station per skill, in order — look, walk, jump, grab,
 * carry and place, throw, bridge a ditch, deliver the bucket. Written as level data (the same format
 * the level designer edits).
 */

import type { LevelData } from './data.ts';

const lane = { minX: -4, maxX: 4, minZ: -20, maxZ: 12.5 };

export const TUTORIAL_DATA: LevelData = {
    v: 1,
    id: 'tutorial',
    name: 'Tutorial',
    size: { minX: -28, maxX: 28, minZ: -42, maxZ: 14 },
    ground: { base: 0.3, noise: 0.35, seed: 11 },
    features: [
        { type: 'flat', rect: lane, y: 0.3 },
        { type: 'flat', rect: { minX: -6, maxX: 6, minZ: -24, maxZ: -20 }, y: 0.3 },
        { type: 'paint', rect: { minX: -1.1, maxX: 1.1, minZ: -23, maxZ: 12.5 }, material: 'path' },
        { type: 'paint', rect: { minX: -3.2, maxX: -1.5, minZ: -1.6, maxZ: 0.1 }, material: 'hi-vis' },
        { type: 'ditch', x1: -4.8, z1: -10, x2: 4.8, z2: -10, width: 1.8, depth: 1.2 },
        { type: 'mound', x: -14, z: -14, r: 9, h: 2.5 },
        { type: 'mound', x: 15, z: -6, r: 8, h: 1.8 },
        { type: 'mound', x: 2, z: -34, r: 14, h: 5 }
    ],
    pieces: [
        // the lane's fences (keep you on the course; the log must be jumped)
        {
            shape: { type: 'box', hx: 0.06, hy: 0.45, hz: 16 },
            x: -4.3,
            y: 0.45,
            z: -3.5,
            material: 'dark-timber',
            name: 'fence-l'
        },
        {
            shape: { type: 'box', hx: 0.06, hy: 0.45, hz: 16 },
            x: 4.3,
            y: 0.45,
            z: -3.5,
            material: 'dark-timber',
            name: 'fence-r'
        },
        // 2: the first sign
        {
            shape: { type: 'box', hx: 0.05, hy: 0.6, hz: 0.05 },
            x: 2.6,
            y: 0.6,
            z: 5.5,
            material: 'dark-timber',
            name: 'sign-post'
        },
        {
            shape: { type: 'box', hx: 0.4, hy: 0.22, hz: 0.03 },
            x: 2.6,
            y: 1.25,
            z: 5.5,
            material: 'hi-vis',
            name: 'sign'
        },
        // 3: a log across the lane, too high to step over (0.5 m)
        {
            shape: { type: 'cylinder', axis: 'x', r: 0.25, half: 4.2 },
            x: 0,
            y: 0.25,
            z: 3,
            material: 'dark-timber',
            name: 'jump-log'
        },
        // 5: the pad, slightly raised
        {
            shape: { type: 'box', hx: 0.85, hy: 0.04, hz: 0.85 },
            x: -2.35,
            y: 0.04,
            z: -0.75,
            material: 'hi-vis',
            name: 'pad'
        },
        // 6: the bin for the ball (low walls)
        {
            shape: { type: 'box', hx: 0.8, hy: 0.2, hz: 0.04 },
            x: -2.3,
            y: 0.2,
            z: -5.0,
            material: 'timber',
            name: 'bin-n'
        },
        {
            shape: { type: 'box', hx: 0.8, hy: 0.2, hz: 0.04 },
            x: -2.3,
            y: 0.2,
            z: -6.6,
            material: 'timber',
            name: 'bin-s'
        },
        {
            shape: { type: 'box', hx: 0.04, hy: 0.2, hz: 0.8 },
            x: -3.06,
            y: 0.2,
            z: -5.8,
            material: 'timber',
            name: 'bin-w'
        },
        {
            shape: { type: 'box', hx: 0.04, hy: 0.2, hz: 0.8 },
            x: -1.54,
            y: 0.2,
            z: -5.8,
            material: 'timber',
            name: 'bin-e'
        },
        // 8: the flag at the end
        {
            shape: { type: 'box', hx: 0.04, hy: 1.2, hz: 0.04 },
            x: 0,
            y: 1.2,
            z: -17.5,
            material: 'steel',
            name: 'flag-pole'
        },
        {
            shape: { type: 'box', hx: 0.35, hy: 0.2, hz: 0.02 },
            x: 0.39,
            y: 2.15,
            z: -17.5,
            material: 'hi-vis',
            name: 'flag'
        }
    ],
    trees: [
        { x: -9, z: 8, scale: 1.2, yaw: 0.3, kind: 'oak' },
        { x: 8.5, z: 6, scale: 1.1, yaw: 1.2, kind: 'oak' },
        { x: -8, z: -4, scale: 1.3, yaw: 2.1 },
        { x: 9, z: -9, scale: 1.2, yaw: 0.8 },
        { x: -9.5, z: -18, scale: 1.1, yaw: 2.6, kind: 'oak' },
        { x: 8, z: -20, scale: 1.25, yaw: 1.7 },
        { x: -16, z: 2, scale: 1.3, yaw: 0.2 },
        { x: 16, z: 1, scale: 1.2, yaw: 2.9, kind: 'oak' },
        { x: -18, z: -24, scale: 1.2, yaw: 1.1 },
        { x: 18, z: -26, scale: 1.3, yaw: 0.6 },
        { x: -5, z: -30, scale: 1.1, yaw: 1.9 },
        { x: 9, z: -32, scale: 1.2, yaw: 2.2 }
    ],
    rocks: [
        { x: -6.5, z: 2, size: 0.5, yaw: 0.4 },
        { x: 6.5, z: -14, size: 0.6, yaw: 1.4 },
        { x: -12, z: -9, size: 0.7, yaw: 2.2 }
    ],
    props: [
        { name: 'cube', x: 2, z: 0.6 },
        { name: 'sphere', x: 2.2, z: -3.2 },
        // the plank already points across the ditch: push or carry it over
        { name: 'plank', x: -1.8, z: -7.6, yaw: Math.PI / 2 },
        { name: 'bucket', x: 1.6, z: -6.8 }
    ],
    spawn: { x: 0, z: 10.5, yaw: 0 },
    goal: { minX: -2.5, maxX: 2.5, minZ: -19.5, maxZ: -15.5 },
    objective: 'Tutorial',
    steps: [
        { kind: 'look', text: 'Look around: move the mouse (right stick, or drag on the right of the screen).' },
        {
            kind: 'reach',
            text: 'Walk to the orange sign: W A S D (left stick, or your left thumb).',
            rect: { minX: -4, maxX: 4, minZ: 4.4, maxZ: 6.6 }
        },
        { kind: 'jump', text: 'Jump over the log: Space (A, or the Jump button).' },
        { kind: 'grab', text: 'Look at the crate and grab it: click (RT, or Grab).', entity: 'cube' },
        {
            kind: 'place',
            text: 'Carry the crate onto the orange pad and let go: click again (RT, or Release).',
            entity: 'cube',
            rect: { minX: -3.3, maxX: -1.4, minZ: -1.7, maxZ: 0.2 }
        },
        {
            kind: 'place',
            text: 'Throw the ball into the bin: grab it, then right-click (RB, or Throw).',
            entity: 'sphere',
            rect: { minX: -3.05, maxX: -1.55, minZ: -6.6, maxZ: -5.0 }
        },
        {
            kind: 'reach',
            text: 'Push the plank across the ditch and walk over it.',
            rect: { minX: -4, maxX: 4, minZ: -14, maxZ: -11.2 }
        },
        { kind: 'goal', text: 'Bring the bucket to the flag. (Falling in? You are fished out.)' }
    ],
    sun: { elevation: 15, azimuth: 135 },
    wind: { dir: Math.PI * 0.6, base: 0.8, gust: 1.8 }
};
