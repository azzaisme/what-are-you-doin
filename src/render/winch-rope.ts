/**
 * The hand winch's rope (Epic 5, #52), drawn from the drum to where its hook is: in a piece (its
 * point of the piece's frame, following it in the snapshot ring) or in a beaver's hand. One thin
 * box, stretched along the rope; nothing when the rope is on the drum. The same on host and guests
 * (the host draws what it would send).
 */

import { Color, Entity, StandardMaterial } from 'playcanvas';
import type { AppBase, Layer } from 'playcanvas';

import type { SnapshotRing } from '../sim/snapshots.ts';
import { ANIM_MAX } from '../sim/snapshots.ts';
import type { WinchRopeEnd } from '../sim/winch.ts';
import { pose, quatRotate, vec3 } from '../voxels/math.ts';
import type { Vec3 } from '../voxels/math.ts';

const _pose = pose();
const _anim = new Float64Array(ANIM_MAX);
const _v = vec3();
/** The rope's thickness (m). */
const THICK = 0.03;
/** A carried hook's height over the carrier's feet (m): about the hands. */
const HAND = 0.45;

export class WinchRope {
    private readonly e = new Entity('WinchRope');
    /** Whether the last update drew the rope (tests). */
    drawn = false;

    constructor(app: AppBase, layer: Layer) {
        const m = new StandardMaterial();
        m.diffuse = new Color(0.55, 0.45, 0.3);
        m.gloss = 0.2;
        m.update();
        this.e.addComponent('render', { type: 'box', material: m, layers: [layer.id], castShadows: false });
        this.e.enabled = false;
        app.root.addChild(this.e);
    }

    /**
     * `drum`: where the rope leaves the winch (null: no winch here). `avatarIndex(slot)`: the
     * entity index of that player's avatar.
     */
    update(
        drum: Vec3 | null,
        end: WinchRopeEnd | null,
        ring: SnapshotRing,
        time: number,
        avatarIndex: (slot: number) => number
    ): void {
        this.drawn = false;
        if (drum && end) {
            let ok = false;
            if ('hand' in end) {
                const k = avatarIndex(end.hand);
                if (k >= 0 && ring.sample(k, time, _pose, _anim)) {
                    _v.x = _pose.p.x;
                    _v.y = _pose.p.y + HAND;
                    _v.z = _pose.p.z;
                    ok = true;
                }
            } else if (ring.sample(end.index, time, _pose, _anim)) {
                quatRotate(_pose.q, end.local.x, end.local.y, end.local.z, _v);
                _v.x += _pose.p.x;
                _v.y += _pose.p.y;
                _v.z += _pose.p.z;
                ok = true;
            }
            const len = ok ? Math.hypot(_v.x - drum.x, _v.y - drum.y, _v.z - drum.z) : 0;
            if (len > 0.05) {
                this.e.setPosition((drum.x + _v.x) / 2, (drum.y + _v.y) / 2, (drum.z + _v.z) / 2);
                this.e.lookAt(_v.x, _v.y, _v.z);
                this.e.setLocalScale(THICK, THICK, len);
                this.drawn = true;
            }
        }
        this.e.enabled = this.drawn;
    }
}
