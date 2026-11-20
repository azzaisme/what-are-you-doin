/**
 * Scene, lighting and water (design doc §5.6-§5.8).
 *
 * "Light is not pixelated": a continuous golden-hour sun with cascaded soft shadows, a dynamic sky
 * that also provides image-based ambient light and reflections, linear lighting with filmic tone
 * mapping, distance fog matched to the horizon, and a real planar river reflection (the engine's
 * Water script: a mirrored camera with oblique clipping, rendering the same layers - and therefore
 * the same voxel meshes - as the main camera). No pixelation filter anywhere.
 */

import {
    ADDRESS_REPEAT,
    AppBase,
    AppOptions,
    CameraComponentSystem,
    CameraFrame,
    Color,
    DEVICETYPE_WEBGL2,
    DynamicSkyEffect,
    Entity,
    FILLMODE_FILL_WINDOW,
    FILTER_LINEAR,
    FILTER_LINEAR_MIPMAP_LINEAR,
    FOG_LINEAR,
    LAYERID_DEPTH,
    Layer,
    LightComponentSystem,
    Mesh,
    MeshInstance,
    PIXELFORMAT_RGBA8,
    PlaneGeometry,
    RESOLUTION_AUTO,
    RenderComponentSystem,
    SHADOW_PCF5_16F,
    SHADOWUPDATE_REALTIME,
    ScriptComponentSystem,
    StandardMaterial,
    TONEMAP_ACES2,
    Texture,
    TextureHandler,
    Vec2,
    Vec3,
    createGraphicsDevice
    
} from 'playcanvas';
import type { GraphicsDevice } from 'playcanvas';
import { Water } from 'playcanvas/scripts/esm/water.mjs';

import { LAB_MAX_X, LAB_MIN_X, WATER_Y } from '../levels/river-lab.ts';
import type { WaterApi } from '../types/engine-scripts.ts';

export interface Quality {
    name: 'high' | 'low';
    samples: number;
    shadowResolution: number;
    cascades: number;
    reflectionScale: number;
    refraction: boolean;
    pixelRatio: number;
}

export const QUALITY: Record<Quality['name'], Quality> = {
    high: { name: 'high', samples: 4, shadowResolution: 2048, cascades: 3, reflectionScale: 0.5, refraction: true, pixelRatio: 2 },
    low: { name: 'low', samples: 1, shadowResolution: 1024, cascades: 2, reflectionScale: 0.25, refraction: false, pixelRatio: 1 }
};

export interface LabScene {
    app: AppBase;
    device: GraphicsDevice;
    camera: Entity;
    cameraFrame: CameraFrame;
    sky: DynamicSkyEffect;
    sun: Entity;
    water: WaterApi;
    waterEntity: Entity;
    worldLayer: Layer;
    immediateLayer: Layer;
    quality: Quality;
    setSun(elevationDeg: number, azimuthDeg: number): void;
    setQuality(q: Quality): void;
    sunElevation: number;
    sunAzimuth: number;
}

export async function createLabScene(canvas: HTMLCanvasElement, quality: Quality): Promise<LabScene> {
    // WebGL2 baseline (design doc §4.1). WebGPU is an optional, measured extension for later.
    const device = await createGraphicsDevice(canvas, { deviceTypes: [DEVICETYPE_WEBGL2], antialias: false });
    device.maxPixelRatio = Math.min(window.devicePixelRatio, quality.pixelRatio);

    const options = new AppOptions();
    options.graphicsDevice = device;
    options.componentSystems = [RenderComponentSystem, CameraComponentSystem, LightComponentSystem, ScriptComponentSystem];
    options.resourceHandlers = [TextureHandler];

    const app = new AppBase(canvas);
    app.init(options);
    app.setCanvasFillMode(FILLMODE_FILL_WINDOW);
    app.setCanvasResolution(RESOLUTION_AUTO);
    const resize = () => app.resizeCanvas();
    window.addEventListener('resize', resize);
    app.on('destroy', () => window.removeEventListener('resize', resize));
    app.start();

    const layers = app.scene.layers;
    const worldLayer = layers.getLayerByName('World')!;
    const skyboxLayer = layers.getLayerByName('Skybox')!;
    const uiLayer = layers.getLayerByName('UI')!;
    const immediateLayer = layers.getLayerByName('Immediate')!;
    // the water renders after the world's transparent pass so it blends over the river bed, and is
    // excluded from its own reflection / refraction cameras
    const waterLayer = new Layer({ name: 'Water' });
    layers.insert(waterLayer, layers.getTransparentIndex(worldLayer) + 1);

    // ---- sun: soft cascaded shadows sized for 10 cm detail near the camera
    const sun = new Entity('Sun');
    sun.addComponent('light', {
        type: 'directional',
        color: new Color(1, 0.86, 0.68),
        castShadows: true,
        shadowType: SHADOW_PCF5_16F,
        shadowResolution: quality.shadowResolution,
        numCascades: quality.cascades,
        cascadeDistribution: 0.55,
        shadowDistance: 48,
        shadowBias: 0.25,
        normalOffsetBias: 0.06,
        shadowUpdateMode: SHADOWUPDATE_REALTIME
    });
    app.root.addChild(sun);

    // ---- camera
    const camera = new Entity('MainCamera');
    camera.addComponent('camera', {
        fov: 52,
        nearClip: 0.05,
        farClip: 600,
        layers: [worldLayer.id, LAYERID_DEPTH, skyboxLayer.id, waterLayer.id, immediateLayer.id, uiLayer.id]
    });
    app.root.addChild(camera);

    // ---- HDR frame: tone mapping, depth map for the water, a little bloom on the sun glints
    const cameraFrame = new CameraFrame(app, camera.camera!);
    cameraFrame.rendering.toneMapping = TONEMAP_ACES2;
    cameraFrame.rendering.sceneDepthMap = true;
    cameraFrame.rendering.samples = quality.samples;
    cameraFrame.bloom.intensity = 0.006;
    cameraFrame.bloom.blurLevel = 16;
    cameraFrame.vignette.intensity = 0.25;
    cameraFrame.vignette.inner = 0.55;
    cameraFrame.vignette.outer = 1.3;
    // a gentle warm grade for the golden hour; contrast so the low sun reads
    cameraFrame.grading.enabled = true;
    cameraFrame.grading.contrast = 1.08;
    cameraFrame.grading.saturation = 1.05;
    cameraFrame.grading.brightness = 1.0;
    cameraFrame.grading.tint = new Color(1.0, 0.95, 0.86);

    // ---- dynamic sky: renders the sky, generates image-based lighting, drives the sun
    const sky = new DynamicSkyEffect(device);
    sky.light = sun.light!;
    sky.sunIntensity = 5.5;
    sky.turbidity = 7.5;
    sky.rayleigh = 2.2;
    sky.luminance = 1.0;
    sky.starBrightness = 0;
    cameraFrame.addEffect(sky);
    app.scene.exposure = 0.95;
    // the sky's ambient is bright and blue; keep it as fill so the low warm sun carries the image
    app.scene.skyboxIntensity = 0.45;

    // ---- distance fog, coloured from the horizon each time the sun moves
    app.scene.fog.type = FOG_LINEAR;
    app.scene.fog.start = 18;
    app.scene.fog.end = 120;

    // ---- the river: one smooth surface exception (design doc §3.3 item 5)
    const riverLength = LAB_MAX_X - LAB_MIN_X;
    const waterMesh = Mesh.fromGeometry(device, new PlaneGeometry({ halfExtents: new Vec2(riverLength / 2, 4.9), widthSegments: 1, lengthSegments: 1 }));
    const waterEntity = new Entity('River');
    waterEntity.addComponent('render', {
        meshInstances: [new MeshInstance(waterMesh, new StandardMaterial())],
        layers: [waterLayer.id],
        castShadows: false,
        receiveShadows: false
    });
    waterEntity.setLocalPosition((LAB_MIN_X + LAB_MAX_X) / 2, WATER_Y, 0);
    app.root.addChild(waterEntity);
    waterEntity.addComponent('script');
    const water = waterEntity.script!.create(Water, {
        properties: {
            cameraEntity: camera,
            lightEntity: sun,
            normalMap: makeRippleNormalMap(device),
            causticsMap: makeCausticsMap(device),
            reflectionSource: 'planar',
            refraction: quality.refraction,
            textureScale: quality.reflectionScale,
            obliqueClipping: true,
            clipBias: 0.04,
            depthEffects: true,
            shallowColor: new Color(0.42, 0.78, 0.74),
            deepColor: new Color(0.04, 0.2, 0.26),
            depthFade: 0.9,
            shoreSoftness: 0.12,
            opacity: 0.86,
            rippleTiling: 0.22,
            rippleSpeed: 0.045,
            bumpiness: 0.32,
            distortion: 0.018,
            fresnelPower: 4,
            reflectionStrength: 1,
            specularPower: 320,
            specularIntensity: 1.2,
            diffuseIntensity: 0.25,
            foam: true,
            foamDepth: 0.12,
            causticsTiling: 0.6,
            causticsSpeed: 0.05,
            causticsStrength: 2.2,
            causticsDepth: 0.8
        }
    }) as unknown as WaterApi;

    const scene: LabScene = {
        app,
        device,
        camera,
        cameraFrame,
        sky,
        sun,
        water,
        waterEntity,
        worldLayer,
        immediateLayer,
        quality,
        sunElevation: 5,
        sunAzimuth: 30,
        setSun(elevation: number, azimuth: number) {
            scene.sunElevation = elevation;
            scene.sunAzimuth = azimuth;
            sky.elevation = elevation;
            sky.azimuth = azimuth;
            cameraFrame.update();
            // fog takes the sky colour near the horizon in the main viewing direction (towards -Z)
            const c = sky.getSkyColor(new Vec3(0, 0.04, -1));
            const k = 0.5;
            app.scene.fog.color = new Color(toSrgb(c.r * k), toSrgb(c.g * k), toSrgb(c.b * k));
        },
        setQuality(q: Quality) {
            scene.quality = q;
            device.maxPixelRatio = Math.min(window.devicePixelRatio, q.pixelRatio);
            app.resizeCanvas();
            cameraFrame.rendering.samples = q.samples;
            cameraFrame.update();
            sun.light!.shadowResolution = q.shadowResolution;
            sun.light!.numCascades = q.cascades;
            water.refraction = q.refraction;
            water.textureScale = q.reflectionScale;
        }
    };
    scene.setSun(scene.sunElevation, scene.sunAzimuth);
    return scene;
}

function toSrgb(v: number): number {
    const x = Math.max(0, Math.min(1, v));
    return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

/** Tileable ripple normal map from integer-frequency waves (original procedural asset). */
function makeRippleNormalMap(device: GraphicsDevice): Texture {
    const N = 256;
    const h = new Float32Array(N * N);
    const waves: [number, number, number, number][] = [
        [3, 1, 1.0, 0.1],
        [-2, 5, 0.7, 1.7],
        [7, -4, 0.45, 2.9],
        [-9, -7, 0.3, 4.1],
        [13, 6, 0.22, 0.6],
        [5, 15, 0.18, 3.3],
        [-17, 11, 0.12, 5.2],
        [21, -19, 0.08, 1.1]
    ];
    for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
            let v = 0;
            for (const [kx, ky, a, ph] of waves) v += a * Math.sin(((kx * x + ky * y) / N) * Math.PI * 2 + ph);
            h[x + y * N] = v;
        }
    }
    const tex = new Texture(device, {
        name: 'riverRippleNormal',
        width: N,
        height: N,
        format: PIXELFORMAT_RGBA8,
        mipmaps: true,
        addressU: ADDRESS_REPEAT,
        addressV: ADDRESS_REPEAT,
        minFilter: FILTER_LINEAR_MIPMAP_LINEAR,
        magFilter: FILTER_LINEAR
    });
    const px = tex.lock() as Uint8Array;
    const s = 0.9;
    for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
            const dx = h[((x + 1) % N) + y * N] - h[((x - 1 + N) % N) + y * N];
            const dy = h[x + ((y + 1) % N) * N] - h[x + ((y - 1 + N) % N) * N];
            let nx = -dx * s;
            let ny = -dy * s;
            let nz = 1;
            const l = Math.hypot(nx, ny, nz);
            nx /= l;
            ny /= l;
            nz /= l;
            const o = (x + y * N) * 4;
            px[o] = Math.round((nx * 0.5 + 0.5) * 255);
            px[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
            px[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
            px[o + 3] = 255;
        }
    }
    tex.unlock();
    return tex;
}

/** Tileable caustics pattern: bright thin network from folded interfering waves (original). */
function makeCausticsMap(device: GraphicsDevice): Texture {
    const N = 256;
    const tex = new Texture(device, {
        name: 'riverCaustics',
        width: N,
        height: N,
        format: PIXELFORMAT_RGBA8,
        mipmaps: true,
        addressU: ADDRESS_REPEAT,
        addressV: ADDRESS_REPEAT,
        minFilter: FILTER_LINEAR_MIPMAP_LINEAR,
        magFilter: FILTER_LINEAR
    });
    const px = tex.lock() as Uint8Array;
    const pattern = (u: number, v: number, seed: number) => {
        let s = 0;
        const ks: [number, number][] = [
            [2, 3],
            [-3, 2],
            [4, -1],
            [1, 5],
            [-5, -3]
        ];
        ks.forEach(([kx, ky], n) => {
            s += Math.sin((kx * u + ky * v) * Math.PI * 2 + n * 1.9 + seed);
        });
        return Math.pow(1 - Math.min(1, Math.abs(s) / 2.2), 6);
    };
    for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
            const u = x / N;
            const v = y / N;
            const o = (x + y * N) * 4;
            px[o] = Math.round(pattern(u, v, 0) * 255);
            px[o + 1] = Math.round(pattern(v, u, 2.3) * 255);
            px[o + 2] = 0;
            px[o + 3] = 255;
        }
    }
    tex.unlock();
    return tex;
}
