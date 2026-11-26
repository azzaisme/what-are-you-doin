/**
 * The fog's sky (Epic 9, weather): when the fog closes in, the sky behind it would still show
 * blue around the fogged-out silhouettes of the far world (the fog colour is not the sky's). A large
 * dome round the camera, far beyond the fog's end, takes the fog colour from the engine's own fog
 * (fully fogged at that distance), so the sky turns the fog colour and the far world's outline melts
 * into it. It fades in as the fog end closes from `startAt` to `fullAt` and is off in clear weather.
 * One per local view, on that view's own layer, centred on that view's camera (split screen: player
 * 2 may be far from player 1, and a dome round the other camera would stand inside their fog).
 */

import {
    BLEND_NORMAL,
    CULLFACE_FRONT,
    Color,
    Entity,
    Mesh,
    MeshInstance,
    SphereGeometry,
    StandardMaterial
} from 'playcanvas';
import type { AppBase, Layer } from 'playcanvas';

export const FOG_DOME = {
    /**
     * Radius (m). Once the fog's end is under it the dome is fully fogged (the fog colour, exactly);
     * from `startAt` down to it, the dome is nearly fogged and still fading in.
     */
    radius: 150,
    /** The fog end (m) where it starts to show, and where it is fully opaque. */
    startAt: 160,
    fullAt: 100
};

/** The dome's opacity for a fog end (0: clear sky, 1: the sky is the fog colour). */
export function fogDomeOpacity(fogEnd: number): number {
    const k = (FOG_DOME.startAt - fogEnd) / (FOG_DOME.startAt - FOG_DOME.fullAt);
    const x = Math.max(0, Math.min(1, k));
    return x * x * (3 - 2 * x);
}

export class FogDome {
    readonly entity: Entity;
    private readonly material: StandardMaterial;
    private opacity = -1;

    constructor(app: AppBase, layer: Layer, name = 'FogDome') {
        const mesh = Mesh.fromGeometry(
            app.graphicsDevice,
            new SphereGeometry({ radius: FOG_DOME.radius, latitudeBands: 12, longitudeBands: 24 })
        );
        const m = new StandardMaterial();
        m.useLighting = false;
        m.useSkybox = false;
        m.diffuse = new Color(0, 0, 0);
        m.emissive = new Color(0.8, 0.8, 0.8);
        m.cull = CULLFACE_FRONT;
        m.blendType = BLEND_NORMAL;
        m.depthWrite = false;
        m.opacity = 0;
        m.update();
        this.material = m;
        this.entity = new Entity(name);
        this.entity.addComponent('render', {
            meshInstances: [new MeshInstance(mesh, m)],
            layers: [layer.id],
            castShadows: false,
            receiveShadows: false
        });
        this.entity.enabled = false;
        app.root.addChild(this.entity);
    }

    /** Follows the camera; shows as the fog closes in. */
    update(camera: { x: number; y: number; z: number }, fogEnd: number): void {
        const o = fogDomeOpacity(fogEnd);
        this.entity.enabled = o > 0;
        if (o <= 0) return;
        this.entity.setPosition(camera.x, camera.y, camera.z);
        if (Math.abs(o - this.opacity) > 0.002) {
            this.material.opacity = o;
            this.material.update();
            this.opacity = o;
        }
    }
}
