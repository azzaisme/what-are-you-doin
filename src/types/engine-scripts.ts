// Typed views of the engine's shipped ESM scripts. The package ships them as JSDoc-typed .mjs that
// TypeScript resolves through package exports with weak inferred types, so we cast to these
// interfaces. Only members we use are listed; checked against playcanvas 2.24.2 sources.

import type { Color, Entity, Script, Texture, Vec2, Vec3 } from 'playcanvas';

export interface WaterApi extends Script {
    cameraEntity: Entity | null;
    lightEntity: Entity | null;
    normalMap: Texture | null;
    causticsMap: Texture | null;
    reflectionSource: 'planar' | 'sky' | 'none';
    refraction: boolean;
    obliqueClipping: boolean;
    clipBias: number;
    textureScale: number;
    depthEffects: boolean;
    shallowColor: Color;
    deepColor: Color;
    depthFade: number;
    opacity: number;
    foam: boolean;
    rippleSpeed: number;
    bumpiness: number;
}

export interface CameraControlsApi extends Script {
    enableFly: boolean;
    enableOrbit: boolean;
    enablePan: boolean;
    focusPoint: Vec3;
    rotateSpeed: number;
    zoomRange: Vec2;
    pitchRange: Vec2;
}
