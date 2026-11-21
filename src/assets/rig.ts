/**
 * A tiny joint hierarchy for voxel assets. Joints have a parent, a rest offset and an animated
 * local rotation; parts hang off joints with a fixed local offset. Evaluation composes world poses
 * without allocating.
 */

import { composePose, copyPose, pose, quatFromYawPitchRoll, quatIdentity } from '../voxels/math.ts';
import type { Pose, Quat } from '../voxels/math.ts';

export interface JointDef {
    name: string;
    parent: number; // -1 = root
    /** Rest translation relative to the parent joint. */
    x: number;
    y: number;
    z: number;
}

export class Rig {
    readonly joints: readonly JointDef[];
    readonly world: Pose[];
    /** Animated local rotation per joint, set by the asset before evaluate(). */
    readonly rot: Quat[];
    /** Animated extra translation per joint (parent frame), added to the rest offset. */
    readonly shift: { x: number; y: number; z: number }[];
    private readonly local: Pose[];

    constructor(joints: JointDef[]) {
        for (let i = 0; i < joints.length; i++) {
            if (joints[i].parent >= i) throw new Error(`Joint ${joints[i].name} must come after its parent`);
        }
        this.joints = joints;
        this.world = joints.map(() => pose());
        this.local = joints.map((j) => pose(j.x, j.y, j.z));
        this.rot = joints.map(() => quatIdentity());
        this.shift = joints.map(() => ({ x: 0, y: 0, z: 0 }));
    }

    setShift(index: number, x: number, y: number, z: number): void {
        const s = this.shift[index];
        s.x = x;
        s.y = y;
        s.z = z;
    }

    setRot(index: number, yaw: number, pitch: number, roll: number): void {
        quatFromYawPitchRoll(yaw, pitch, roll, this.rot[index]);
    }

    evaluate(root: Pose): void {
        for (let i = 0; i < this.joints.length; i++) {
            const j = this.joints[i];
            const l = this.local[i];
            const sh = this.shift[i];
            l.p.x = j.x + sh.x;
            l.p.y = j.y + sh.y;
            l.p.z = j.z + sh.z;
            const r = this.rot[i];
            l.q.x = r.x;
            l.q.y = r.y;
            l.q.z = r.z;
            l.q.w = r.w;
            if (j.parent < 0) composePose(root, l, this.world[i]);
            else composePose(this.world[j.parent], l, this.world[i]);
        }
    }

    index(name: string): number {
        const i = this.joints.findIndex((j) => j.name === name);
        if (i < 0) throw new Error(`No joint ${name}`);
        return i;
    }
}

/** A part attached to a joint with a fixed local offset and rotation. */
export interface Attachment {
    joint: number;
    offset: Pose;
}

export function attach(joint: number, x: number, y: number, z: number, yaw = 0, pitch = 0, roll = 0): Attachment {
    return { joint, offset: pose(x, y, z, quatFromYawPitchRoll(yaw, pitch, roll)) };
}

export function evaluateAttachments(rig: Rig, attachments: readonly Attachment[], out: Pose[]): void {
    for (let i = 0; i < attachments.length; i++) {
        const a = attachments[i];
        composePose(rig.world[a.joint], a.offset, out[i]);
    }
}

export { copyPose };
