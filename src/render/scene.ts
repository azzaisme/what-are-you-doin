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
    Vec4,
    ASPECT_AUTO,
    ASPECT_MANUAL,
    createGraphicsDevice
} from 'playcanvas';
import type { GraphicsDevice } from 'playcanvas';
import { Water } from 'playcanvas/scripts/esm/water.mjs';

import type { LevelDef } from '../levels/level.ts';
import type { WaterApi } from '../types/engine-scripts.ts';

import { addPixelLook } from './pixel-look.ts';
import type { PixelLook } from './pixel-look.ts';

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
    high: {
        name: 'high',
        samples: 4,
        shadowResolution: 2048,
        cascades: 3,
        reflectionScale: 0.5,
        refraction: true,
        pixelRatio: 2
    },
    low: {
        name: 'low',
        samples: 1,
        shadowResolution: 1024,
        cascades: 2,
        reflectionScale: 0.25,
        refraction: false,
        pixelRatio: 1
    }
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
    /**
     * Per-view immediate layers: the main camera draws `viewLayers[0]`, player 2's camera
     * `viewLayers[1]`, so one local player's aim marks never show in the other's view.
     */
    viewLayers: [Layer, Layer];
    quality: Quality;
    setSun(elevationDeg: number, azimuthDeg: number): void;
    /**
     * Split screen (local co-op): player 1 on top, player 2's camera below. In split screen the
     * water uses its sky reflection: the engine's planar reflection follows one camera only.
     */
    setSplit(split: boolean): void;
    camera2: Entity;
    split: boolean;
    setQuality(q: Quality): void;
    /** The prototype pixel-game look (`src/render/pixel-look.ts`). */
    pixelLook: boolean;
    setPixelLook(on: boolean): void;
    sunElevation: number;
    sunAzimuth: number;
}

export async function createLabScene(canvas: HTMLCanvasElement, quality: Quality, level: LevelDef): Promise<LabScene> {
    // WebGL2 baseline (design doc §4.1). WebGPU is an optional, measured extension for later.
    const device = await createGraphicsDevice(canvas, { deviceTypes: [DEVICETYPE_WEBGL2], antialias: false });
    device.maxPixelRatio = Math.min(window.devicePixelRatio, quality.pixelRatio);

    const options = new AppOptions();
    options.graphicsDevice = device;
    options.componentSystems = [
        RenderComponentSystem,
        CameraComponentSystem,
        LightComponentSystem,
        ScriptComponentSystem
    ];
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
    // one immediate layer per local view. Inserted before the shared Immediate layer's transparent
    // part: CameraFrame renders layers up to that one in its scene pass (kept to the camera's half
    // in split screen); later layers go to a pass over the whole back buffer
    const viewLayers: [Layer, Layer] = [new Layer({ name: 'View1' }), new Layer({ name: 'View2' })];
    for (const l of viewLayers) layers.insert(l, layers.getTransparentIndex(immediateLayer));

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
        layers: [
            worldLayer.id,
            LAYERID_DEPTH,
            skyboxLayer.id,
            waterLayer.id,
            immediateLayer.id,
            viewLayers[0].id,
            uiLayer.id
        ]
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
    const pixel1 = addPixelLook(device, cameraFrame, () => scene.quality.samples);
    let pixel2: PixelLook | null = null;
    app.scene.exposure = 0.95;
    // the sky's ambient is bright and blue; keep it as fill so the low warm sun carries the image
    app.scene.skyboxIntensity = 0.45;

    // ---- distance fog, coloured from the horizon each time the sun moves
    app.scene.fog.type = FOG_LINEAR;
    app.scene.fog.start = level.stream?.fog.start ?? 18;
    app.scene.fog.end = level.stream?.fog.end ?? 120;

    // ---- the river: one smooth surface exception (design doc §3.3 item 5)
    const W = level.water;
    const waterMesh = Mesh.fromGeometry(
        device,
        new PlaneGeometry({ halfExtents: new Vec2(W.halfX, W.halfZ), widthSegments: 1, lengthSegments: 1 })
    );
    const waterEntity = new Entity('River');
    waterEntity.addComponent('render', {
        meshInstances: [new MeshInstance(waterMesh, new StandardMaterial())],
        layers: [waterLayer.id],
        castShadows: false,
        receiveShadows: false
    });
    waterEntity.setLocalPosition(W.cx, W.y, W.cz);
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

    // ---- second view for split screen: same layers and look, its own HDR frame and sky (the sky of
    // the main camera alone lights the scene)
    const camera2 = new Entity('Player2Camera');
    camera2.addComponent('camera', {
        fov: 52,
        nearClip: 0.05,
        farClip: 600,
        layers: [
            worldLayer.id,
            LAYERID_DEPTH,
            skyboxLayer.id,
            waterLayer.id,
            immediateLayer.id,
            viewLayers[1].id,
            uiLayer.id
        ]
    });
    camera2.enabled = false;
    app.root.addChild(camera2);
    let frame2: CameraFrame | null = null;
    let sky2: DynamicSkyEffect | null = null;
    const ensureSecondFrame = () => {
        if (frame2) return;
        const f = new CameraFrame(app, camera2.camera!);
        f.rendering.toneMapping = TONEMAP_ACES2;
        f.rendering.sceneDepthMap = true;
        f.rendering.samples = scene.quality.samples;
        f.bloom.intensity = cameraFrame.bloom.intensity;
        f.bloom.blurLevel = cameraFrame.bloom.blurLevel;
        f.vignette.intensity = cameraFrame.vignette.intensity;
        f.vignette.inner = cameraFrame.vignette.inner;
        f.vignette.outer = cameraFrame.vignette.outer;
        f.grading.enabled = true;
        f.grading.contrast = cameraFrame.grading.contrast;
        f.grading.saturation = cameraFrame.grading.saturation;
        f.grading.brightness = cameraFrame.grading.brightness;
        f.grading.tint = cameraFrame.grading.tint.clone();
        const k = new DynamicSkyEffect(device);
        k.lighting = false;
        k.sunIntensity = sky.sunIntensity;
        k.turbidity = sky.turbidity;
        k.rayleigh = sky.rayleigh;
        k.luminance = sky.luminance;
        k.starBrightness = 0;
        k.elevation = sky.elevation;
        k.azimuth = sky.azimuth;
        f.addEffect(k);
        pixel2 = addPixelLook(device, f, () => scene.quality.samples);
        f.update();
        pixel2.set(scene.pixelLook);
        frame2 = f;
        sky2 = k;
    };

    // Split screen with CameraFrame: the frame renders its scene into a full-size target and composes
    // over the whole back buffer, ignoring camera.rect (measured: the last camera covered both
    // halves). So in split screen both cameras keep a full rect with the half-screen aspect ratio,
    // their scene targets are half height (no wasted pixels), and each compose pass is limited to its
    // half by viewport and scissor, with its clear off. The engine rebuilds these passes when settings
    // change, so this is re-applied every frame while split.
    type SplitPass = { scaleY: number } | null | undefined;
    type ComposePass = {
        viewport?: Vec4;
        scissor?: Vec4;
        setClearColor(c?: Color): void;
        setClearDepth(d?: number): void;
        setClearStencil(s?: number): void;
    };
    type FrameInternals = {
        renderPassCamera?: { scenePass?: SplitPass; prePass?: SplitPass; composePass?: ComposePass };
    };
    const topRect = new Vec4();
    const bottomRect = new Vec4();
    const applySplit = (f: CameraFrame | null, rect: Vec4) => {
        const rp = (f as unknown as FrameInternals | null)?.renderPassCamera;
        if (!rp) return;
        const scale = f!.rendering.renderTargetScale ?? 1;
        if (rp.scenePass) rp.scenePass.scaleY = scale * 0.5;
        if (rp.prePass) rp.prePass.scaleY = scale * 0.5;
        const cp = rp.composePass;
        if (!cp) return;
        cp.viewport = rect;
        cp.scissor = rect;
        cp.setClearColor(undefined);
        cp.setClearDepth(undefined);
        cp.setClearStencil(undefined);
    };
    app.on('prerender', () => {
        if (!scene.split) return;
        const w = device.width;
        const h = device.height;
        const half = Math.floor(h / 2);
        topRect.set(0, h - half, w, half);
        bottomRect.set(0, 0, w, half);
        const aspect = w / Math.max(1, half);
        camera.camera!.aspectRatio = aspect;
        camera2.camera!.aspectRatio = aspect;
        applySplit(cameraFrame, topRect);
        applySplit(frame2, bottomRect);
    });

    const scene: LabScene = {
        camera2,
        split: false,
        pixelLook: false,
        setPixelLook(on: boolean) {
            scene.pixelLook = on;
            pixel1.set(on);
            pixel2?.set(on);
        },
        setSplit(split: boolean) {
            if (split === scene.split) return;
            scene.split = split;
            if (split) ensureSecondFrame();
            camera2.enabled = split;
            camera2.camera!.priority = -1;
            camera.camera!.aspectRatioMode = split ? ASPECT_MANUAL : ASPECT_AUTO;
            camera2.camera!.aspectRatioMode = ASPECT_MANUAL;
            if (!split) {
                // back to one full-screen frame: rebuild its passes with full-size targets
                const cp = (cameraFrame as unknown as FrameInternals).renderPassCamera?.composePass;
                if (cp) {
                    cp.viewport = undefined;
                    cp.scissor = undefined;
                }
                cameraFrame.update();
            }
            water.reflectionSource = split ? 'sky' : 'planar';
            water.refraction = split ? false : scene.quality.refraction;
        },
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
        viewLayers,
        quality,
        sunElevation: level.sun.elevation,
        sunAzimuth: level.sun.azimuth,
        setSun(elevation: number, azimuth: number) {
            scene.sunElevation = elevation;
            scene.sunAzimuth = azimuth;
            sky.elevation = elevation;
            sky.azimuth = azimuth;
            cameraFrame.update();
            if (sky2 && frame2) {
                sky2.elevation = elevation;
                sky2.azimuth = azimuth;
                frame2.update();
            }
            // fog takes the sky colour near the horizon in the main viewing direction (towards -Z)
            const c = sky.getSkyColor(new Vec3(0, 0.04, -1));
            const k = 0.5;
            app.scene.fog.color = new Color(toSrgb(c.r * k), toSrgb(c.g * k), toSrgb(c.b * k));
        },
        setQuality(q: Quality) {
            scene.quality = q;
            device.maxPixelRatio = Math.min(window.devicePixelRatio, q.pixelRatio);
            app.resizeCanvas();
            const samples = scene.pixelLook ? 1 : q.samples;
            cameraFrame.rendering.samples = samples;
            cameraFrame.update();
            if (frame2) {
                frame2.rendering.samples = samples;
                frame2.update();
            }
            sun.light!.shadowResolution = q.shadowResolution;
            sun.light!.numCascades = q.cascades;
            water.refraction = scene.split ? false : q.refraction;
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
