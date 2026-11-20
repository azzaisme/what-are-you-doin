/**
 * (Un)civil Engineers - Epic 1 "River Lab" visual demo entry point.
 *
 * Ownership: this module owns app state, the frame loop (via one director Script) and teardown.
 * Simulation, voxels and rendering talk through plain data: the sim publishes snapshots, the voxel
 * pipeline samples them at the voxel clock, the renderer uploads meshes.
 */

import { Color, Entity, Script, Vec2, Vec3 } from 'playcanvas';
import { CameraControls } from 'playcanvas/scripts/esm/camera-controls.mjs';

import { DebugPanel  } from './debug/panel.ts';
import type { PanelHost } from './debug/panel.ts';
import { FirstPersonInput } from './input/first-person.ts';
import { terrainHeight } from './levels/river-lab.ts';
import { ReferenceRenderer } from './render/reference.ts';
import { QUALITY, createLabScene  } from './render/scene.ts';
import type { Quality } from './render/scene.ts';
import { VoxelClient } from './render/voxel-pipeline.ts';
import { VoxelRenderer } from './render/voxel-renderer.ts';
import { FixedStepClock, SIM_DT, VOXEL_RATES, VoxelClock  } from './sim/clock.ts';
import type { VoxelRate } from './sim/clock.ts';
import { ACTION_DROP_TEST, ACTION_RAGDOLL, ACTION_RESET_PROPS } from './sim/commands.ts';
import { EYE_HEIGHT, LabSim } from './sim/lab-sim.ts';
import type { PropsMode } from './sim/lab-sim.ts';
import { initPhysics } from './sim/physics/world.ts';
import { ANIM_MAX } from './sim/snapshots.ts';
import type { CameraControlsApi } from './types/engine-scripts.ts';
import { CELL_SIZE_MAX_CM, CELL_SIZE_MIN_CM, CELL_SIZE_STORAGE_KEY, GRID_SIZE, clampCellSizeCm } from './voxels/grid.ts';
import { pose } from './voxels/math.ts';
import { SAMPLING_POLICIES  } from './voxels/rasterizer.ts';
import type { SamplingPolicy } from './voxels/rasterizer.ts';

import './style.css';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('application-canvas') as HTMLCanvasElement;
const loading = document.getElementById('loading');
const setLoading = (t: string) => {
    if (loading) loading.textContent = t;
};

const initialQuality: Quality = QUALITY[params.get('quality') === 'low' ? 'low' : 'high'];
const scene = await createLabScene(canvas, initialQuality);
const { app, camera } = scene;

// ------------------------------------------------------------------------------------- voxel world

const cellCm = Math.round(GRID_SIZE * 1000) / 10;
setLoading(`Rasterizing the River Lab into the ${cellCm} cm grid…`);
await nextFrame();
await initPhysics();
const sim = new LabSim({ props: params.get('props') === 'scripted' ? 'scripted' : 'physics' });
const renderer = new VoxelRenderer(app, scene.worldLayer);
// the voxel world lives in a worker: static build, rasterization and meshing all happen there
const worker = new Worker(new URL('./workers/voxel-worker.ts', import.meta.url), { type: 'module', name: 'voxels' });
const pipeline = new VoxelClient(worker, renderer, sim);
const build = await pipeline.init(cellCm, 1);
setLoading('Uploading meshes…');
await nextFrame();
const tUpload = performance.now();
pipeline.applyStatic();
const staticUploadMs = performance.now() - tUpload;
const reference = new ReferenceRenderer(app, sim, scene.worldLayer, scene.immediateLayer);
const fpInput = new FirstPersonInput(canvas);
const clock = new FixedStepClock();
const voxelClock = new VoxelClock();

// ------------------------------------------------------------------------------------- state

interface State {
    paused: boolean;
    pausedTime: number;
    mode: 'orbit' | 'firstPerson';
    hz: VoxelRate;
    policy: SamplingPolicy;
    gridLines: boolean;
    bounds: boolean;
    reference: boolean;
    reflection: boolean;
    refraction: boolean;
    reflectionScale: number;
    sunElevation: number;
    sunAzimuth: number;
    stress: number;
    quality: Quality['name'];
    fov: number;
    sensitivity: number;
    carry: boolean;
    uiHidden: boolean;
    forceVoxel: boolean;
    props: PropsMode;
    colliders: boolean;
}

const state: State = {
    paused: false,
    pausedTime: 0,
    mode: 'orbit',
    hz: 20,
    policy: 'coverage50',
    gridLines: false,
    bounds: false,
    reference: false,
    reflection: true,
    refraction: initialQuality.refraction,
    reflectionScale: initialQuality.reflectionScale,
    sunElevation: scene.sunElevation,
    sunAzimuth: scene.sunAzimuth,
    stress: 0,
    quality: initialQuality.name,
    fov: 52,
    sensitivity: 2.2,
    carry: true,
    uiHidden: false,
    forceVoxel: true,
    props: sim.propsMode,
    colliders: false
};

const rateParam = Number(params.get('hz'));
if ((VOXEL_RATES as readonly number[]).includes(rateParam)) state.hz = rateParam as VoxelRate;
voxelClock.setRate(state.hz);

// ------------------------------------------------------------------------------------- cameras

const ORBIT_HOME = { pos: new Vec3(-1.5, 2.6, 5.5), focus: new Vec3(-1.0, 0.8, -5.5) };
camera.setPosition(ORBIT_HOME.pos);
camera.addComponent('script');
const orbit = camera.script!.create(CameraControls) as unknown as CameraControlsApi;
orbit.enableFly = false;
orbit.focusPoint = ORBIT_HOME.focus.clone();
orbit.pitchRange = new Vec2(-85, 5);
orbit.zoomRange = new Vec2(1.5, 60);
orbit.rotateSpeed = 0.25;

function setMode(mode: State['mode']): void {
    state.mode = mode;
    if (mode === 'firstPerson') {
        orbit.enabled = false;
        const p = camera.getPosition();
        const f = camera.forward;
        const yaw = Math.atan2(-f.x, -f.z);
        // stand where the orbit camera was, on the ground, looking the same way
        sim.placePlayer(clamp(p.x, -25, 25), clamp(p.z, -19, 12), yaw);
        fpInput.yaw = yaw;
        fpInput.pitch = -0.12;
        fpInput.active = true;
        sim.fpActive = true;
        fpInput.lock();
    } else {
        fpInput.active = false;
        sim.fpActive = false;
        fpInput.unlock();
        orbit.enabled = true;
        // look from the current camera position at a point ahead
        const f = camera.forward;
        const p = camera.getPosition();
        const fp = new Vec3(p.x + f.x * 6, Math.max(terrainHeight(p.x + f.x * 6, p.z + f.z * 6) + 0.6, p.y + f.y * 6), p.z + f.z * 6);
        orbit.focusPoint = fp;
    }
    updateHud();
}

// ------------------------------------------------------------------------------------- frame loop

const frameTimes = new Float64Array(600);
const physTimes = new Float64Array(600);
let physCount = 0;
let physHead = 0;
const COLLIDER_COLOR = new Color(1, 0.35, 0.8);
const colliderPoints: Vec3[] = [];
let frameTimeCount = 0;
let frameTimeHead = 0;
let lastFrameStamp = performance.now();
let renderTime = 0;
const playerPose = pose();
const playerAnim = new Float64Array(ANIM_MAX);
let gridUniform = 0;

class LabDirector extends Script {
    static scriptName = 'labDirector';

    postUpdate(dt: number): void {
        const now = performance.now();
        frameTimes[frameTimeHead] = now - lastFrameStamp;
        frameTimeHead = (frameTimeHead + 1) % frameTimes.length;
        frameTimeCount = Math.min(frameTimes.length, frameTimeCount + 1);
        lastFrameStamp = now;

        // ---- fixed-step simulation
        fpInput.carry = state.carry;
        if (!state.paused) {
            const steps = clock.advance(dt);
            for (let s = 0; s < steps; s++) {
                sim.step(fpInput.command());
                physTimes[physHead] = sim.physicsMs;
                physHead = (physHead + 1) % physTimes.length;
                physCount = Math.min(physTimes.length, physCount + 1);
            }
            clock.tick = sim.tick;
            renderTime = clock.renderTime;
        } else {
            renderTime = state.pausedTime;
        }

        // ---- first-person camera: interpolated position, look applied at display rate
        if (state.mode === 'firstPerson') {
            if (sim.ring.sample(sim.playerEntity.slot, renderTime, playerPose, playerAnim)) {
                camera.setPosition(playerPose.p.x, playerPose.p.y, playerPose.p.z);
            } else {
                camera.setPosition(sim.player.x, sim.player.y + EYE_HEIGHT, sim.player.z);
            }
            camera.setEulerAngles((fpInput.pitch * 180) / Math.PI, (fpInput.yaw * 180) / Math.PI, 0);
        }
        if (camera.camera!.fov !== state.fov) camera.camera!.fov = state.fov;

        // ---- voxel clock: one reconstruction per voxel frame, committed before any pass renders
        const frame = voxelClock.frameAt(renderTime);
        if (frame !== voxelClock.frame || state.forceVoxel) {
            voxelClock.frame = frame;
            state.forceVoxel = false;
            pipeline.request(frame, voxelClock.timeOf(frame));
        }
        // apply a finished voxel frame (all its meshes at once) before this frame renders
        pipeline.poll();
        reference.update(renderTime);
        if (state.colliders) drawColliders();

        // ---- debug overlay uniform
        const g = state.gridLines ? 1 : 0;
        if (g !== gridUniform || g) {
            app.graphicsDevice.scope.resolve('uVoxelGridLines').setValue(g);
            gridUniform = g;
        }

        if (panel.visible && (frameTimeHead & 7) === 0) panel.setStats(statsText());
        if ((frameTimeHead & 3) === 0) updatePrompt();
    }
}
const directorEntity = new Entity('LabDirector');
directorEntity.addComponent('script');
directorEntity.script!.create(LabDirector);
app.root.addChild(directorEntity);
app.graphicsDevice.scope.resolve('uVoxelGridLines').setValue(0);

/** Debug only: Rapier's collider wireframes (read-only; nothing flows back into physics). */
function drawColliders(): void {
    const v = sim.physics.debugLines();
    const n = v.length / 3;
    while (colliderPoints.length < n) colliderPoints.push(new Vec3());
    for (let i = 0; i < n; i++) colliderPoints[i].set(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]);
    if (n >= 2) app.drawLines(colliderPoints.slice(0, n & ~1), COLLIDER_COLOR, false, scene.immediateLayer);
}

// ------------------------------------------------------------------------------------- actions

function setPaused(p: boolean): void {
    if (p && !state.paused) state.pausedTime = renderTime;
    if (!p && state.paused) {
        // resume from the paused instant
        sim.runTo(Math.max(sim.tick, Math.ceil(state.pausedTime / SIM_DT) + 1));
        clock.reset(sim.tick);
    }
    state.paused = p;
    panel.sync();
}

/** Advances exactly one voxel frame while paused. */
function stepVoxelFrame(): void {
    if (!state.paused) setPaused(true);
    const next = voxelClock.frameAt(state.pausedTime) + 1;
    const t = voxelClock.timeOf(next);
    sim.runTo(Math.ceil(t / SIM_DT + 1e-9) + 1);
    clock.reset(sim.tick);
    state.pausedTime = t;
}

/** Deterministic seek (used by screenshots and tests): pause at an exact time. */
function seek(t: number): void {
    state.paused = true;
    sim.runTo(Math.ceil(t / SIM_DT + 1e-9) + 1);
    clock.reset(sim.tick);
    state.pausedTime = t;
    state.forceVoxel = true;
    panel.sync();
}

function resetScene(): void {
    sim.reset();
    clock.reset(0);
    state.pausedTime = 0;
    state.forceVoxel = true;
    if (state.mode === 'orbit') {
        camera.setPosition(ORBIT_HOME.pos);
        orbit.focusPoint = ORBIT_HOME.focus.clone();
    }
}

function applyWater(): void {
    scene.water.reflectionSource = state.reflection ? 'planar' : 'sky';
    scene.water.refraction = state.refraction;
    scene.water.textureScale = state.reflectionScale;
}

// ------------------------------------------------------------------------------------- panel

const host: PanelHost = {
    get(id) {
        if (id === 'stress') return String(state.stress);
        if (id === 'hz') return String(state.hz);
        if (id === 'reflectionScale') return String(state.reflectionScale);
        return (state as unknown as Record<string, string | number | boolean>)[id];
    },
    set(id, v) {
        switch (id) {
            case 'hz':
                state.hz = Number(v) as VoxelRate;
                voxelClock.setRate(state.hz);
                break;
            case 'policy':
                state.policy = v as SamplingPolicy;
                pipeline.policy = state.policy;
                state.forceVoxel = true;
                break;
            case 'gridLines':
                state.gridLines = Boolean(v);
                break;
            case 'bounds':
                state.bounds = Boolean(v);
                reference.showBounds = state.bounds;
                break;
            case 'reference':
                state.reference = Boolean(v);
                reference.enabled = state.reference;
                pipeline.reference = state.reference;
                state.forceVoxel = true;
                break;
            case 'reflection':
                state.reflection = Boolean(v);
                applyWater();
                break;
            case 'refraction':
                state.refraction = Boolean(v);
                applyWater();
                break;
            case 'reflectionScale':
                state.reflectionScale = Number(v);
                applyWater();
                break;
            case 'sunElevation':
            case 'sunAzimuth':
                state[id] = Number(v);
                scene.setSun(state.sunElevation, state.sunAzimuth);
                break;
            case 'stress':
                state.stress = Number(v);
                sim.stressCount = state.stress;
                break;
            case 'quality':
                state.quality = v as Quality['name'];
                scene.setQuality(QUALITY[state.quality]);
                state.refraction = scene.quality.refraction;
                state.reflectionScale = scene.quality.reflectionScale;
                applyWater();
                panel.sync();
                break;
            case 'mode':
                setMode(v as State['mode']);
                break;
            case 'fov':
                state.fov = Number(v);
                break;
            case 'sensitivity':
                state.sensitivity = Number(v);
                fpInput.sensitivity = state.sensitivity / 1000;
                break;
            case 'carry':
                state.carry = Boolean(v);
                break;
            case 'props':
                state.props = v === 'scripted' ? 'scripted' : 'physics';
                sim.setPropsMode(state.props);
                clock.reset(sim.tick);
                state.pausedTime = 0;
                state.forceVoxel = true;
                panel.sync();
                updateHud();
                break;
            case 'colliders':
                state.colliders = Boolean(v);
                break;
        }
    },
    action(id) {
        if (id === 'pause') setPaused(!state.paused);
        else if (id === 'step') stepVoxelFrame();
        else if (id === 'reset') resetScene();
        else if (id === 'hideUi') setUiHidden(true);
        else if (id === 'ragdoll') fpInput.queueAction(ACTION_RAGDOLL);
        else if (id === 'dropTest') fpInput.queueAction(ACTION_DROP_TEST);
        else if (id === 'resetProps') fpInput.queueAction(ACTION_RESET_PROPS);
    }
};

const panel = new DebugPanel(host, [
    {
        title: 'Time',
        controls: [
            { kind: 'button', id: 'pause', label: 'Pause', key: 'P' },
            { kind: 'button', id: 'step', label: 'Step voxel frame', key: 'N' },
            { kind: 'button', id: 'reset', label: 'Reset scene', key: 'Backspace' },
            { kind: 'button', id: 'hideUi', label: 'Hide UI', key: 'H' },
            {
                kind: 'select',
                id: 'hz',
                label: 'Voxel rate',
                options: VOXEL_RATES.map((r) => ({ value: String(r), label: `${r} Hz` }))
            }
        ]
    },
    {
        title: 'Physics',
        controls: [
            {
                kind: 'select',
                id: 'props',
                label: 'Props',
                options: [
                    { value: 'physics', label: 'Physics (Rapier)' },
                    { value: 'scripted', label: 'Scripted (Epic 1)' }
                ]
            },
            { kind: 'button', id: 'ragdoll', label: 'Launch ragdoll', key: 'T' },
            { kind: 'button', id: 'dropTest', label: 'Drop test' },
            { kind: 'button', id: 'resetProps', label: 'Reset props' },
            { kind: 'toggle', id: 'colliders', label: 'Physics colliders' }
        ]
    },
    {
        title: 'Reconstruction',
        controls: [
            {
                kind: 'select',
                id: 'policy',
                label: 'Sampling',
                options: SAMPLING_POLICIES.map((p) => ({ value: p, label: p }))
            },
            { kind: 'toggle', id: 'gridLines', label: 'Grid lines' },
            { kind: 'toggle', id: 'bounds', label: 'Source bounds' },
            { kind: 'toggle', id: 'reference', label: 'Conventional reference' },
            {
                kind: 'select',
                id: 'stress',
                label: 'Extra moving objects',
                options: [0, 1, 10, 25].map((n) => ({ value: String(n), label: String(n) }))
            }
        ]
    },
    {
        title: 'Light & water',
        controls: [
            { kind: 'range', id: 'sunElevation', label: 'Sun elevation', min: -4, max: 70, step: 0.5 },
            { kind: 'range', id: 'sunAzimuth', label: 'Sun azimuth', min: 0, max: 360, step: 1 },
            { kind: 'toggle', id: 'reflection', label: 'Planar reflection' },
            { kind: 'toggle', id: 'refraction', label: 'Refraction' },
            {
                kind: 'select',
                id: 'reflectionScale',
                label: 'Reflection res',
                options: [0.25, 0.5, 0.75, 1].map((s) => ({ value: String(s), label: `${s * 100}%` }))
            },
            {
                kind: 'select',
                id: 'quality',
                label: 'Quality preset',
                options: [
                    { value: 'high', label: 'High' },
                    { value: 'low', label: 'Low' }
                ]
            }
        ]
    },
    {
        title: 'Camera',
        controls: [
            {
                kind: 'select',
                id: 'mode',
                label: 'View (V)',
                options: [
                    { value: 'orbit', label: 'Orbit' },
                    { value: 'firstPerson', label: 'First person' }
                ]
            },
            { kind: 'toggle', id: 'carry', label: 'Carry plank (G, first person)' },
            { kind: 'range', id: 'fov', label: 'FOV', min: 40, max: 100, step: 1 },
            { kind: 'range', id: 'sensitivity', label: 'Mouse sensitivity', min: 0.5, max: 6, step: 0.1 }
        ]
    }
]);

// ------------------------------------------------------------------------------------- HUD

const hud = document.createElement('div');
hud.className = 'hud';
hud.innerHTML = `
  <div class="hud-title"><b>(Un)civil Engineers</b> <span>River Lab · voxel tech demo</span></div>
  <div class="hud-help" id="hud-help"></div>
  <div class="hud-prompt" id="hud-prompt"></div>`;
document.body.append(hud);
// bottom dock: voxel-size box (left) and debug chip (right). Its measured height keeps the debug
// panel above it on every screen, so the boxes never overlap (portrait phones included).
const dock = document.createElement('div');
dock.className = 'ui-dock';
document.body.append(dock);
// ---- voxel size: a per-player quality setting, applied by reloading (sizes derive from it at load)
const cellUi = document.createElement('div');
cellUi.className = 'cell-size';
cellUi.innerHTML = `
  <label>Voxel size <input type="range" min="${CELL_SIZE_MIN_CM}" max="${CELL_SIZE_MAX_CM}" step="0.5" value="${cellCm}"><output>${cellCm.toFixed(1)} cm</output></label>
  <button type="button" disabled>Apply</button>
  <small>finer = sharper, slower to load</small>`;
dock.append(cellUi);
const cellRange = cellUi.querySelector('input')!;
const cellOut = cellUi.querySelector('output')!;
const cellApply = cellUi.querySelector('button')!;
for (const ev of ['pointerdown', 'mousedown', 'wheel', 'click', 'keydown']) cellUi.addEventListener(ev, (e) => e.stopPropagation());
cellRange.addEventListener('input', () => {
    const v = clampCellSizeCm(Number(cellRange.value));
    cellOut.textContent = `${v.toFixed(1)} cm`;
    cellApply.disabled = v === cellCm;
});
cellApply.addEventListener('click', () => applyCellSize(Number(cellRange.value)));

function applyCellSize(cm: number): void {
    const v = clampCellSizeCm(cm);
    try {
        localStorage.setItem(CELL_SIZE_STORAGE_KEY, String(v));
    } catch {
        // storage blocked: the hash below still carries the choice
    }
    location.hash = `cell${Math.round(v * 10)}`;
    location.reload();
}

const crosshair = document.createElement('div');
crosshair.className = 'crosshair';
document.body.append(crosshair);
const chip = document.createElement('button');
chip.className = 'debug-chip';
chip.textContent = 'Debug panel (F3)';
chip.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.visible = !panel.visible;
});
dock.append(chip);

// publish the HUD and dock sizes as CSS variables; the panel layout is computed from them
const layoutVars = () => {
    const root = document.documentElement.style;
    root.setProperty('--hud-bottom', `${Math.ceil(hud.getBoundingClientRect().bottom)}px`);
    root.setProperty('--dock-h', `${Math.ceil(dock.getBoundingClientRect().height)}px`);
};
new ResizeObserver(layoutVars).observe(hud);
new ResizeObserver(layoutVars).observe(dock);
window.addEventListener('resize', layoutVars);

function updateHud(): void {
    const help = document.getElementById('hud-help')!;
    // long help for keyboard screens, short help for narrow / touch screens (chosen in CSS)
    const long =
        state.mode === 'orbit'
            ? 'Drag to orbit · right-drag to pan · wheel to zoom · <kbd>V</kbd> first person · <kbd>H</kbd> hide UI'
            : sim.physicsProps
              ? 'Click to look · <kbd>WASD</kbd> move · <kbd>Shift</kbd> run · <kbd>Space</kbd> jump · <kbd>LMB</kbd>/<kbd>E</kbd> grab / release · <kbd>RMB</kbd> throw · wheel reach · <kbd>Q</kbd> drop · <kbd>G</kbd> plank · <kbd>T</kbd> ragdoll · <kbd>Esc</kbd> release mouse · <kbd>V</kbd> orbit'
              : 'Click to look · <kbd>WASD</kbd> move · <kbd>Shift</kbd> run · <kbd>Space</kbd> jump · <kbd>G</kbd> carry plank · <kbd>Esc</kbd> release mouse · <kbd>V</kbd> orbit';
    const short = state.mode === 'orbit' ? 'Drag to orbit · two fingers to pan and zoom' : 'Click to look · WASD move · click grab · V orbit';
    help.innerHTML = `<span class="help-long">${long}</span><span class="help-short">${short}</span>`;
    crosshair.style.display = state.mode === 'firstPerson' && !state.uiHidden ? '' : 'none';
}

function setUiHidden(h: boolean): void {
    state.uiHidden = h;
    document.body.classList.toggle('ui-hidden', h);
    updateHud();
    layoutVars();
}

const PROP_LABEL: Record<string, string> = { plank: 'plank', 'held-plank': 'plank', log: 'log (heavy)', cube: 'crate', sphere: 'ball', bucket: 'bucket' };
const propLabel = (name: string) => PROP_LABEL[name] ?? (name.startsWith('dummy') ? 'dummy' : name.startsWith('stress') ? 'test body' : name);
let promptText = '';

/** Context prompt (design doc §2.3): what a click would do right now. */
function updatePrompt(): void {
    let t = '';
    if (state.mode === 'firstPerson') {
        if (!fpInput.locked) t = 'Click to look around';
        else {
            const i = sim.interaction();
            if (i.holding) t = `Holding ${propLabel(i.holding)} · click to release · right-click to throw · wheel to adjust reach`;
            else if (i.target) t = `Click to grab ${propLabel(i.target)}`;
        }
    }
    if (t !== promptText) {
        promptText = t;
        document.getElementById('hud-prompt')!.textContent = t;
        crosshair.classList.toggle('crosshair-active', t.startsWith('Click to grab') || t.startsWith('Holding'));
    }
}
document.addEventListener('pointerlockchange', updatePrompt);

window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    switch (e.code) {
        case 'KeyP':
            setPaused(!state.paused);
            break;
        case 'KeyN':
            stepVoxelFrame();
            break;
        case 'Backspace':
            resetScene();
            e.preventDefault();
            break;
        case 'KeyH':
            setUiHidden(!state.uiHidden);
            break;
        case 'KeyV':
            setMode(state.mode === 'orbit' ? 'firstPerson' : 'orbit');
            panel.sync();
            break;
        case 'KeyG':
            state.carry = !state.carry;
            panel.sync();
            break;
        case 'F3':
            panel.visible = !panel.visible;
            e.preventDefault();
            break;
    }
});

// ------------------------------------------------------------------------------------- stats

function physAvg(): number {
    let sum = 0;
    for (let i = 0; i < physCount; i++) sum += physTimes[i];
    return physCount ? sum / physCount : 0;
}

function physPercentile(p: number): number {
    if (!physCount) return 0;
    const a = Array.from(physTimes.subarray(0, physCount)).sort((x, y) => x - y);
    return a[Math.min(physCount - 1, Math.floor(p * physCount))];
}

function percentile(p: number): number {
    const n = frameTimeCount;
    if (!n) return 0;
    const a = Array.from(frameTimes.subarray(0, n)).sort((x, y) => x - y);
    return a[Math.min(n - 1, Math.floor(p * n))];
}

const gl = (app.graphicsDevice as unknown as { gl?: WebGL2RenderingContext }).gl;
const gpuName = (() => {
    if (!gl) return 'unknown';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
})();

const EMPTY_FRAME_STATS = { frame: -1, time: 0, objects: 0, parts: 0, candidates: 0, samples: 0, occupied: 0, rejected: 0, changedCells: 0, dirtyCells: 0, dynDynOverlaps: 0, dynStaticOverlaps: 0, staticRebuilt: 0, dynamicRebuilt: 0, rasterMs: 0, resolveMs: 0, meshMs: 0, totalMs: 0, dynamicCells: 0, chunks: build.chunks };

function collectStats() {
    const v = { ...(pipeline.lastStats ?? EMPTY_FRAME_STATS), uploadMs: pipeline.uploadMs };
    const t = renderer.totals();
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    const n = frameTimeCount;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += frameTimes[i];
    return {
        gpu: gpuName,
        canvas: `${canvas.width}x${canvas.height}`,
        cellCm,
        fps: n ? 1000 / (sum / n) : 0,
        frameMsAvg: n ? sum / n : 0,
        frameMsP95: percentile(0.95),
        frameMsMax: percentile(1),
        drawCalls: app.stats.drawCallCount,
        voxel: v,
        voxelHz: state.hz,
        policy: state.policy,
        skippedVoxelFrames: pipeline.skippedFrames,
        voxelLagFrames: Math.max(0, voxelClock.frame - pipeline.appliedFrame),
        staticCells: build.staticCells,
        dynamicCells: v.dynamicCells,
        chunks: v.chunks,
        staticUnits: t.staticUnits,
        dynamicUnits: t.dynamicUnits,
        quadsTotal: t.quads,
        quadsDynamic: t.quadsDynamic,
        triangles: t.triangles,
        drawables: t.drawables,
        heapMB: mem ? mem.usedJSHeapSize / 1e6 : null,
        droppedTicks: clock.droppedTicks,
        physics: {
            props: sim.propsMode,
            tickMsAvg: physAvg(),
            tickMsP95: physPercentile(0.95),
            tickMsMax: physPercentile(1),
            stepMs: sim.physics.stats.stepMs,
            activeBodies: sim.physics.stats.activeBodies,
            enabledBodies: sim.physics.stats.enabledBodies,
            holding: sim.physics.stats.holding,
            grabForce: sim.physics.stats.grabForce,
            grabError: sim.physics.stats.grabError,
            maxHeldSpeed: sim.physics.stats.maxHeldSpeed,
            grabBreaks: sim.physics.stats.grabBreaks,
            linClamps: sim.physics.stats.linClamps,
            angClamps: sim.physics.stats.angClamps,
            recovered: sim.physics.stats.recovered,
            player: { x: sim.player.x, y: sim.player.y, z: sim.player.z, grounded: sim.player.grounded }
        },
        build: { workerBuildMs: build.buildMs, workerStaticMeshMs: build.staticMeshMs, staticUploadMs, columns: build.columns, trees: build.trees }
    };
}

function statsText(): string {
    const s = collectStats();
    const v = s.voxel;
    const f = (x: number, d = 2) => x.toFixed(d);
    return [
        `GPU      ${s.gpu}`,
        `canvas   ${s.canvas}  fps ${f(s.fps, 1)}`,
        `frame ms avg ${f(s.frameMsAvg)}  p95 ${f(s.frameMsP95)}  max ${f(s.frameMsMax)}`,
        `draws    ${s.drawCalls}  drawables ${s.drawables}`,
        `tris     ${(s.triangles / 1000).toFixed(0)}k  quads ${s.quadsTotal} (dyn ${s.quadsDynamic})`,
        `cells    ${s.cellCm} cm  static ${s.staticCells}  dyn ${s.dynamicCells}  chunks ${s.chunks}`,
        `voxel #${v.frame} @${s.voxelHz}Hz ${s.policy}  lag ${s.voxelLagFrames}  skipped ${s.skippedVoxelFrames}`,
        `  objects ${v.objects} parts ${v.parts} rejected ${v.rejected}`,
        `  candidates ${v.candidates} samples ${v.samples}`,
        `  occupied ${v.occupied} changed ${v.changedCells}`,
        `  dirty chunks: static ${v.staticRebuilt} dyn ${v.dynamicRebuilt}`,
        `  overlap dyn/dyn ${v.dynDynOverlaps} dyn/static ${v.dynStaticOverlaps}`,
        `  worker ms raster ${f(v.rasterMs)} resolve ${f(v.resolveMs)} mesh ${f(v.meshMs)}`,
        `  worker total ${f(v.totalMs)}   main-thread upload ${f(v.uploadMs)}`,
        `physics  ${s.physics.props}  tick ms avg ${f(s.physics.tickMsAvg)} p95 ${f(s.physics.tickMsP95)} max ${f(s.physics.tickMsMax)}`,
        `  bodies active ${s.physics.activeBodies}/${s.physics.enabledBodies}  held ${s.physics.holding < 0 ? '-' : s.physics.holding}  force ${f(s.physics.grabForce, 0)} N  err ${f(s.physics.grabError)} m`,
        `  clamps lin ${s.physics.linClamps} ang ${s.physics.angClamps}  recovered ${s.physics.recovered}  grab breaks ${s.physics.grabBreaks}`,
        `heap     ${s.heapMB === null ? 'n/a' : f(s.heapMB, 1) + ' MB'}  dropped ticks ${s.droppedTicks}`
    ].join('\n');
}

// ------------------------------------------------------------------------------------- test API

declare global {
    interface Window {
        __riverLab?: unknown;
    }
}

window.__riverLab = {
    ready: true,
    seek,
    set: (id: string, v: string | number | boolean) => host.set(id, v),
    action: (id: string) => host.action(id),
    stats: collectStats,
    async verifyGrid() {
        const w = await pipeline.query<{ vertices: number; misaligned: number }>('verify');
        return {
            vertices: w.vertices + renderer.verifiedVertices,
            misaligned: w.misaligned + renderer.misalignedVertices + (renderer.unitsAtIdentity() ? 0 : 1)
        };
    },
    dynamicHash: () => pipeline.query<number>('hash'),
    /** True when no voxel frame is in flight or waiting to be applied. */
    voxelIdle: () => !pipeline.inFlight && !state.forceVoxel,
    entities: () => Object.fromEntries(sim.entities.map((e) => [e.name, { x: e.pose.p.x, y: e.pose.p.y, z: e.pose.p.z, yaw: Math.atan2(2 * (e.pose.q.w * e.pose.q.y + e.pose.q.x * e.pose.q.z), 1 - 2 * (e.pose.q.y * e.pose.q.y + e.pose.q.x * e.pose.q.x)), visible: e.visible }])),
    setCamera(px: number, py: number, pz: number, fx: number, fy: number, fz: number) {
        if (state.mode !== 'orbit') setMode('orbit');
        camera.setPosition(px, py, pz);
        orbit.focusPoint = new Vec3(fx, fy, fz);
    },
    setFirstPerson(x: number, z: number, yaw: number, pitch: number) {
        setMode('firstPerson');
        sim.placePlayer(x, z, yaw);
        fpInput.yaw = yaw;
        fpInput.pitch = pitch;
        sim.step(fpInput.command());
        sim.step(fpInput.command());
        clock.reset(sim.tick);
        state.forceVoxel = true;
    },
    /** Merges fields into the next player command (grab / throw / move edges for tests). */
    input: (c: Record<string, unknown>) => fpInput.inject(c),
    player: () => ({ ...sim.player, holding: sim.physics.heldId }),
    hideUi: (h: boolean) => setUiHidden(h),
    showPanel: (v: boolean) => (panel.visible = v),
    get state() {
        return { ...state };
    }
};

// ------------------------------------------------------------------------------------- start

if (import.meta.env.DEV || params.has('debug') || location.hash === '#debug') panel.visible = true;
const startAt = Number(params.get('t'));
if (Number.isFinite(startAt) && params.has('t')) seek(startAt);
if (params.get('view') === 'fp') setMode('firstPerson');
if (params.has('noui')) setUiHidden(true);
updateHud();
loading?.remove();
console.info(`River Lab ready at ${cellCm} cm: ${build.columns} columns, ${build.staticCells} static cells, worker build ${build.buildMs.toFixed(0)} ms + static meshes ${build.staticMeshMs.toFixed(0)} ms, upload ${staticUploadMs.toFixed(0)} ms`);

function clamp(v: number, a: number, b: number): number {
    return Math.max(a, Math.min(b, v));
}

function nextFrame(): Promise<void> {
    return new Promise((r) => requestAnimationFrame(() => r()));
}
