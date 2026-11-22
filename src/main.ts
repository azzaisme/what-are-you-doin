/**
 * (Un)civil Engineers - Epic 1 "River Lab" visual demo entry point.
 *
 * Ownership: this module owns app state, the frame loop (via one director Script) and teardown.
 * Simulation, voxels and rendering talk through plain data: the sim publishes snapshots, the voxel
 * pipeline samples them at the voxel clock, the renderer uploads meshes.
 */

import { Color, Entity, Script, Vec2, Vec3 } from 'playcanvas';
import { CameraControls } from 'playcanvas/scripts/esm/camera-controls.mjs';

import { BEAVER_ARM_REACH, BEAVER_LEAN, BEAVER_WALK_AMOUNT, BEAVER_WALK_PHASE } from './assets/beaver.ts';
import { CELL_TIERS, assetTier, tierCellCm } from './assets/cell-tier.ts';
import type { CellTier } from './assets/cell-tier.ts';
import { SAW_MODE, TREE_CUT } from './assets/forestry.ts';
import { BUCKET_CAPACITY } from './assets/props.ts';
import { GameAudio, soundBodies } from './audio/game-audio.ts';
import { DebugPanel } from './debug/panel.ts';
import type { PanelHost } from './debug/panel.ts';
import { DESIGN_KEY, Designer, loadDraft } from './editor/designer.ts';
import { ParticleFX } from './fx/particles.ts';
import type { WatchedEntity } from './fx/particles.ts';
import { CALM, windAt } from './fx/wind.ts';
import { WoodFX } from './fx/wood-fx.ts';
import {
    ACTIONS,
    ACTION_LABELS,
    PAD_ACTIONS,
    actionForKey,
    bindKey,
    bindPad,
    bindableKey,
    defaultBindings,
    keyLabel,
    keysText,
    loadBindings,
    padLabel,
    saveBindings
} from './input/bindings.ts';
import type { Action, PadAction } from './input/bindings.ts';
import { FirstPersonInput } from './input/first-person.ts';
import { PadManager } from './input/gamepad.ts';
import { TouchControls, isTouchDevice } from './input/touch.ts';
import { levelFromData } from './levels/data.ts';
import { LEVEL_MENU, getLevel } from './levels/index.ts';
import { viewDistance } from './levels/view-distance.ts';
import { degradedTransport, parseConditions } from './net/netsim.ts';
import type { P2PTransport } from './net/p2p.ts';
import { forgetGame, gameToRejoin, rejoinToken, rememberGame } from './net/rejoin.ts';
import { GuestSession, HostSession, NET_PROTOCOL, listGames } from './net/session.ts';
import type { GameAd } from './net/session.ts';
import { localTransport, roomTransport } from './net/transport.ts';
import type { NetTransport } from './net/transport.ts';
import { PLAYTEST_STORAGE_KEY, PlaytestLog } from './playtest/telemetry.ts';
import { ReferenceRenderer } from './render/reference.ts';
import { QUALITY, createLabScene } from './render/scene.ts';
import type { Quality } from './render/scene.ts';
import { VoxelClient } from './render/voxel-pipeline.ts';
import type { LaneSpec } from './render/voxel-pipeline.ts';
import { VoxelRenderer } from './render/voxel-renderer.ts';
import { FixedStepClock, SIM_DT, VOXEL_RATES, VoxelClock } from './sim/clock.ts';
import type { VoxelRate } from './sim/clock.ts';
import { ACTION_DROP_TEST, ACTION_RAGDOLL, ACTION_RESET_PROPS, neutralCommand } from './sim/commands.ts';
import type { PlayerCommand } from './sim/commands.ts';
import { EYE_HEIGHT, LabSim, MAX_PLAYERS } from './sim/lab-sim.ts';
import type { PropsMode } from './sim/lab-sim.ts';
import { initPhysics } from './sim/physics/world.ts';
import { ANIM_MAX } from './sim/snapshots.ts';
import { WATER } from './sim/water.ts';
import type { CameraControlsApi } from './types/engine-scripts.ts';
import { OnlinePanel } from './ui/online-panel.ts';
import { PlaytestPanel } from './ui/playtest-panel.ts';
import { controlNames, interactionPrompt } from './ui/prompts.ts';
import { SettingsMenu } from './ui/settings-menu.ts';
import type { SettingValue } from './ui/settings-menu.ts';
import { DEFAULT_SETTINGS, SETTING_RANGES, loadSettings, saveSettings, urlOverrides } from './ui/settings-store.ts';
import type { Settings } from './ui/settings-store.ts';
import { woodLabel, woodPrompt } from './ui/wood-prompt.ts';
import {
    CELL_SIZE_MAX_CM,
    CELL_SIZE_DEFAULT_CM,
    CELL_SIZE_MIN_CM,
    CELL_SIZE_STORAGE_KEY,
    GRID_SIZE,
    OLD_CELL_SIZE_STORAGE_KEYS,
    clampCellSizeCm
} from './voxels/grid.ts';
import { pose } from './voxels/math.ts';
import { SAMPLING_POLICIES } from './voxels/rasterizer.ts';
import type { SamplingPolicy } from './voxels/rasterizer.ts';

import './style.css';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('application-canvas') as HTMLCanvasElement;
const loading = document.getElementById('loading');
const setLoading = (t: string) => {
    if (loading) loading.textContent = t;
};

// player settings: saved per browser; URL parameters override them for one visit (not saved)
const settingsStorage = (() => {
    try {
        return localStorage;
    } catch {
        return null;
    }
})();
const savedSettings: Settings = loadSettings(settingsStorage);
const settings: Settings = { ...savedSettings, ...urlOverrides(params) };
const initialQuality: Quality = QUALITY[settings.quality];
// ?level=tutorial|yard|lab; otherwise the last level played; a first visit starts with the tutorial
const LEVEL_KEY = 'uncivil.level';
const storedLevel = (() => {
    try {
        return localStorage.getItem(LEVEL_KEY);
    } catch {
        return null;
    }
})();
const levelId = params.get('level') ?? storedLevel ?? 'tutorial';
// 'custom' is the level designer's draft (local storage)
const level = levelId === 'custom' ? levelFromData(loadDraft()) : getLevel(levelId);
const editing = level.id === 'custom' && params.has('edit');
try {
    localStorage.setItem(LEVEL_KEY, level.id);
} catch {
    // storage blocked: the default applies next time
}

/** Loads another level (a reload: the voxel world is built per level). */
function goToLevel(id: string, extra: Record<string, string> = {}): void {
    try {
        localStorage.setItem(LEVEL_KEY, id);
    } catch {
        // storage blocked: the URL carries the choice
    }
    const q = new URLSearchParams({ level: id, ...extra });
    for (const k of ['quality', 'net', 'debug', 'look']) {
        const v = params.get(k);
        if (v !== null) q.set(k, v);
    }
    // the same address (a rebuild) with a hash would only be a fragment navigation: reload
    if (`?${q.toString()}` === location.search) location.reload();
    else location.search = `?${q.toString()}`;
}
const terrainHeight = level.terrainHeight;
const scene = await createLabScene(canvas, initialQuality, level);
const { app, camera } = scene;

// ------------------------------------------------------------------------------------- voxel world

const cellCm = Math.round(GRID_SIZE * 1000) / 10;
try {
    for (const k of OLD_CELL_SIZE_STORAGE_KEYS) localStorage.removeItem(k);
} catch {
    // storage blocked: nothing saved to clear
}
setLoading(`Rasterizing the ${level.name} into the ${cellCm} cm grid…`);
await nextFrame();
await initPhysics();
// the game's hazard seed (Epic 8): a new one each visit, or ?seed= to replay one; hosts send theirs
const hazardSeed = params.has('seed') ? Number(params.get('seed')) >>> 0 : (Math.random() * 2 ** 32) >>> 0;
const sim = new LabSim({
    level,
    props: params.get('props') === 'scripted' ? 'scripted' : 'physics',
    hazardSeed
});
// the voxel world lives in workers: static build, rasterization and meshing all happen there.
// Per-item cell sizes: one worker per lattice (fine 1 cm, base, coarse), each drawing the objects
// of its tier (src/assets/cell-tier.ts); ?tiers=off draws everything on the base grid.
const tiersOn = params.get('tiers') !== 'off';
const tierObjects = new Map<CellTier, number[]>(CELL_TIERS.map((t) => [t, []]));
for (const e of sim.entities)
    if (e.asset.parts.length > 0 && !(tiersOn && e.id === sim.fpBody.id))
        tierObjects.get(tiersOn ? assetTier(e.asset) : 'base')!.push(e.id);
const lanes: LaneSpec[] = [];
// your own first-person limbs get a 1 cm lane to themselves, so it can be moved with the camera
// between voxel frames (VoxelClient.lockBody) without moving anything else
if (tiersOn)
    lanes.push({
        worker: new Worker(new URL('./workers/voxel-worker.ts', import.meta.url), {
            type: 'module',
            name: 'voxels-self'
        }),
        renderer: new VoxelRenderer(app, scene.worldLayer, tierCellCm(assetTier(sim.fpBody.asset), cellCm) / 100),
        cellCm: tierCellCm(assetTier(sim.fpBody.asset), cellCm),
        objects: [sim.fpBody.id],
        world: false
    });
for (const tier of CELL_TIERS) {
    const objects = tierObjects.get(tier)!;
    if (tier !== 'base' && objects.length === 0) continue;
    const laneCm = tierCellCm(tier, cellCm);
    lanes.push({
        worker: new Worker(new URL('./workers/voxel-worker.ts', import.meta.url), {
            type: 'module',
            name: `voxels-${tier}`
        }),
        renderer: new VoxelRenderer(app, scene.worldLayer, laneCm / 100),
        cellCm: laneCm,
        objects,
        world: tier === 'base'
    });
}
// streamed levels (the Valley): a coarse far lattice holds the whole world, the base lane builds
// only the tiles near this device's cameras
if (level.stream)
    lanes.push({
        worker: new Worker(new URL('./workers/voxel-worker.ts', import.meta.url), {
            type: 'module',
            name: 'voxels-far'
        }),
        renderer: new VoxelRenderer(app, scene.worldLayer, level.stream.farCm / 100, true),
        cellCm: level.stream.farCm,
        objects: [],
        world: true,
        far: true
    });
const pipeline = new VoxelClient(lanes, sim);
/** Streamed levels: how far around the cameras the near world is built follows the quality preset. */
function applyViewDistance(q: Quality): void {
    if (!level.stream) return;
    const v = viewDistance(level.stream, q.name);
    pipeline.nearRadius = v.radius;
    scene.app.scene.fog.start = v.fogStart;
}
applyViewDistance(initialQuality);
const build = await pipeline.init(1, level.id, level.data);
setLoading('Uploading meshes…');
await nextFrame();
const tUpload = performance.now();
pipeline.applyStatic();
const staticUploadMs = performance.now() - tUpload;
const reference = new ReferenceRenderer(app, sim, scene.worldLayer, scene.immediateLayer);
const fpInput = new FirstPersonInput(canvas);
// remappable controls (#98): one table shared by the keyboard, the pads and the settings menu
const bindings = loadBindings(settingsStorage);
fpInput.bindings = bindings;
fpInput.onPlank = () => {
    state.carry = !state.carry;
    panel.sync();
};

// ---- particles (voxel cells): falling leaves, landing dust and chips, splashes
const watched: WatchedEntity[] = [];
const watch = (name: string, bottom: number, timber: boolean) => {
    const e = sim.entities.find((x) => x.name === name);
    if (e) watched.push({ slot: e.slot, bottom, timber });
};
for (const e of sim.entities) {
    if (e.name === 'plank' || e.name === 'held-plank' || e.name.startsWith('extra-plank')) watch(e.name, 0.05, true);
    else if (e.name.startsWith('beam-')) watch(e.name, 0.075, true);
    else if (e.name.startsWith('crate-')) watch(e.name, 0.25, true);
}
for (const n of ['log', 'extra-log-0', 'extra-log-1']) watch(n, 0.2, true);
for (const e of sim.entities)
    if (e.name.startsWith('felled-log') || e.name.startsWith('short-log')) watch(e.name, 0.2, true);
watch('cube', 0.25, true);
watch('sphere', 0.3, false);
watch('bucket', 0, false);
for (const d of sim.dummy) watch(d.name, 0.15, false);
for (const e of sim.eyes) watched.push({ slot: e.slot, bottom: 0, timber: false, eyeHeight: EYE_HEIGHT });
const fx = new ParticleFX(level, watched);
fx.bucketSlot = level.props.some((p) => p.name === 'bucket') && sim.physicsProps ? sim.bucket.slot : -1;
// ---- sound (src/audio): built and started on the first click, tap or key (browser rules)
const audio = new GameAudio(app, camera, {
    level,
    ring: sim.ring,
    watched: soundBodies(sim.entities),
    eyeSlots: sim.eyes.map((e) => e.slot),
    eyeHeight: EYE_HEIGHT,
    uteSlot: level.actors.ute.mode === 'none' ? -1 : sim.ute.slot,
    slotOfId: (id) => sim.entities.find((e) => e.id === id)?.slot ?? -1
});
audio.armUnlock();
// ---- the playtest log (Epic 8 gate): what happened this session, kept on this device
const playtest = new PlaytestLog(
    {
        level: level.name,
        voxels: `${Math.round(GRID_SIZE * 1000) / 10} cm`,
        seed: String(hazardSeed),
        device: isTouchDevice() ? 'touch' : 'mouse & keyboard',
        screen: `${window.innerWidth}x${window.innerHeight}`,
        date: new Date().toISOString().slice(0, 16).replace('T', ' ')
    },
    performance.now()
);
const playtestHeld: number[] = [];
const playtestPose = pose();
const playtestAnim = new Float64Array(ANIM_MAX);
function savePlaytest(): void {
    try {
        localStorage.setItem(PLAYTEST_STORAGE_KEY, playtest.text(performance.now()));
    } catch {
        // storage blocked or full: the log lasts for this visit
    }
}
const previousPlaytest = (() => {
    try {
        return localStorage.getItem(PLAYTEST_STORAGE_KEY) ?? '';
    } catch {
        return '';
    }
})();
setInterval(savePlaytest, 15_000);
window.addEventListener('pagehide', savePlaytest);
/** Per frame: grabs as they happen, who plays, and every few seconds where everyone is. */
function playtestFrame(t: number): void {
    const now = performance.now();
    let playing = 0;
    const players: { x: number; y: number; z: number; holding: string | null }[] = [];
    sim.players.forEach((_, i) => {
        const sp = soundPlayer(i);
        if (!sp.active || !sim.ring.sample(sim.eyes[i].slot, t, playtestPose, playtestAnim)) return;
        playing++;
        const name = sp.held >= 0 ? (sim.entities.find((e) => e.id === sp.held)?.name ?? '?') : null;
        if (sp.held !== (playtestHeld[i] ?? -1) && name) playtest.note(now, 'grab', `P${i + 1} took the ${name}`);
        playtestHeld[i] = sp.held;
        const p = playtestPose.p;
        players.push({ x: p.x, y: p.y - EYE_HEIGHT, z: p.z, holding: name });
    });
    playtest.setPlayers(now, Math.max(1, playing));
    const bucketSeen = sim.ring.sample(sim.bucket.slot, t, playtestPose, playtestAnim);
    const r = level.rules;
    const k = guestSession ? guestSession.step : sim.progress.step;
    const stage = r?.stages?.[k]?.name ?? r?.steps?.[k]?.text ?? r?.objective ?? '';
    playtest.sample(now, {
        players,
        bucket: bucketSeen ? { ...playtestPose.p } : null,
        waterY: (guestSession ? guestSession.hazard : sim.hazards.net()).waterY,
        stage: (guestSession ? guestSession.goal : sim.progress.goalReached) ? 'finished' : stage
    });
}
// logging: chips, needles and sawdust (src/fx/wood-fx.ts)
if (level.forestry) {
    const f = sim.forestry.ents;
    fx.wood = new WoodFX(
        { chips: f.chips.slot, needles: f.needles.slot, sawmill: f.sawmill.slot },
        level.forestry.sawmill
    );
}
pipeline.particles = (time) => {
    const cp = camera.getPosition();
    fx.update(time, sim.ring, { x: cp.x, z: cp.z });
    return { buffer: fx.buffer, count: fx.count };
};
// streamed levels: the near world follows this device's cameras (both views in split screen)
if (level.stream) {
    const focus = new Float32Array(4);
    pipeline.focus = () => {
        const a = camera.getPosition();
        focus[0] = a.x;
        focus[1] = a.z;
        if (state.players > 1) {
            const b = scene.camera2.getPosition();
            focus[2] = b.x;
            focus[3] = b.z;
            return focus;
        }
        return focus.subarray(0, 2);
    };
}
const windNow = { x: 0, z: 0, speed: 0, gustiness: 0 };
// gamepads (local co-op): the first pad to press A drives player 1, the next one joins as player 2
const pads = new PadManager();
pads.bindings = bindings;
// touch controls (phones): shown in first person on touch devices, or after the first touch
const touch = new TouchControls();
let touchSeen = isTouchDevice();
window.addEventListener(
    'touchstart',
    () => {
        if (!touchSeen) {
            touchSeen = true;
            updateTouch();
        }
    },
    { passive: true }
);
function updateTouch(): void {
    touch.show(touchSeen && state.mode === 'firstPerson' && !state.uiHidden);
}

// online co-op: one device hosts the simulation, guests render its snapshots. On claude.ai over the
// artifact room; elsewhere (itch.io) peer to peer over WebRTC, connected when the panel first opens.
let transport: NetTransport | null = null;
let transportKind: 'room' | 'local' | 'p2p' | 'none' = 'none';
let p2p: P2PTransport | null = null;
let p2pStarting: Promise<void> | null = null;
let hostSession: HostSession | null = null;
let guestSession: GuestSession | null = null;
let guestEventsSeen = 0;
/** Slot of the local second player (split screen), or -1. */
let localSlot2 = -1;

/** Test hook: fields merged into player 2's next command (no real pad in headless tests). */
let p2Injected: Partial<PlayerCommand> | null = null;
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
    players: number;
    particles: boolean;
    look: 'default' | 'pixel';
    cameraFeel: boolean;
    /** First person: watch your beaver from over its shoulder (C). */
    chase: boolean;
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
    fov: settings.fov,
    sensitivity: settings.mouseSensitivity,
    // the Epic 1 comfort-test plank is on by default in the River Lab only; in a level you start empty-handed
    carry: level.id === 'lab',
    uiHidden: false,
    forceVoxel: true,
    props: sim.propsMode,
    colliders: false,
    players: 1,
    particles: settings.particles,
    look: settings.look,
    cameraFeel: settings.cameraBob,
    chase: settings.overShoulder
};
fx.enabled = state.particles;
const sideView = params.get('view') === 'side';
scene.setPixelLook(state.look === 'pixel');

const rateParam = Number(params.get('hz'));
if ((VOXEL_RATES as readonly number[]).includes(rateParam)) state.hz = rateParam as VoxelRate;
voxelClock.setRate(state.hz);

// ------------------------------------------------------------------------------------- cameras

const ORBIT_HOME = { pos: new Vec3(...level.orbitHome.pos), focus: new Vec3(...level.orbitHome.focus) };
camera.setPosition(ORBIT_HOME.pos);
camera.addComponent('script');
const orbit = camera.script!.create(CameraControls) as unknown as CameraControlsApi;
orbit.enableFly = false;
orbit.focusPoint = ORBIT_HOME.focus.clone();
orbit.pitchRange = new Vec2(-85, 5);
orbit.zoomRange = new Vec2(1.5, 60);
orbit.rotateSpeed = 0.25;

/** `lock`: request pointer lock (only from a user gesture; the level start waits for a click). */
function setMode(mode: State['mode'], lock = true): void {
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
        if (lock) fpInput.lock();
    } else {
        fpInput.active = false;
        sim.fpActive = false;
        fpInput.unlock();
        orbit.enabled = true;
        // look from the current camera position at a point ahead
        const f = camera.forward;
        const p = camera.getPosition();
        const fp = new Vec3(
            p.x + f.x * 6,
            Math.max(terrainHeight(p.x + f.x * 6, p.z + f.z * 6) + 0.6, p.y + f.y * 6),
            p.z + f.z * 6
        );
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
let prevGustPhase = 0;
const playerPose = pose();
const playerAnim = new Float64Array(ANIM_MAX);
const bodyPose = pose();
const bodyAnim = new Float64Array(ANIM_MAX);
/**
 * First-person camera feel, from your own beaver's animation (so it matches what others see):
 * a little head bob while walking, a kick forward and down on throws and hard landings, a lean back
 * under heavy loads. Small: a few centimetres and degrees.
 */
function cameraFeel(slot: number, t: number, out: { dx: number; dy: number; dz: number; pitch: number; roll: number }) {
    out.dx = out.dy = out.dz = out.pitch = out.roll = 0;
    if (!state.cameraFeel || slot < 0 || !sim.ring.sample(slot, t, bodyPose, bodyAnim)) return;
    const amount = bodyAnim[BEAVER_WALK_AMOUNT];
    const phase = bodyAnim[BEAVER_WALK_PHASE];
    const reach = bodyAnim[BEAVER_ARM_REACH];
    const lean = bodyAnim[BEAVER_LEAN];
    const fwd = 0.35 * reach + 0.12 * Math.min(0, lean) * -1;
    const yaw = fpInput.yaw;
    out.dx = -Math.sin(yaw) * fwd;
    out.dz = -Math.cos(yaw) * fwd;
    out.dy = 0.014 * amount * Math.cos(2 * phase) - 0.12 * Math.max(0, -lean) - 0.03 * Math.max(0, lean);
    out.pitch = 0.18 * lean;
    out.roll = 0.008 * amount * Math.sin(phase);
}
const feel = { dx: 0, dy: 0, dz: 0, pitch: 0, roll: 0 };
let gridUniform = 0;

class LabDirector extends Script {
    static scriptName = 'labDirector';

    postUpdate(dt: number): void {
        const now = performance.now();
        frameTimes[frameTimeHead] = now - lastFrameStamp;
        frameTimeHead = (frameTimeHead + 1) % frameTimes.length;
        frameTimeCount = Math.min(frameTimes.length, frameTimeCount + 1);
        lastFrameStamp = now;

        // ---- gamepads: look at display rate; player 1's pad shares the mouse's look angles
        const pad1 = pads.players[0];
        if (pad1) {
            pad1.yaw = fpInput.yaw;
            pad1.pitch = fpInput.pitch;
            pad1.carry = state.carry;
        }
        pads.poll(dt);
        if (menu.open) menu.pollPad(menuPad(), dt);
        const look = touch.takeLook(fpInput.yaw, fpInput.pitch);
        fpInput.yaw = look.yaw;
        fpInput.pitch = look.pitch;
        if (pad1 && pads.players[0] === pad1) {
            fpInput.yaw = pad1.yaw;
            fpInput.pitch = pad1.pitch;
            if (pad1.carry !== state.carry) {
                state.carry = pad1.carry;
                panel.sync();
            }
        }

        // ---- fixed-step simulation (a guest runs none: it renders the host's snapshots)
        fpInput.carry = state.carry;
        if (guestSession) {
            guestSession.sendInput(playerOneCommand());
            renderTime = guestSession.renderTime();
            if (guestSession.incompatible)
                leaveOnline('That game runs another version: reload both pages to play together');
            else if (guestSession.hostGone) leaveOnline('The host left the game.');
            else noteReconnect(guestSession);
        } else if (!state.paused) {
            const steps = clock.advance(dt);
            for (let s = 0; s < steps; s++) {
                const c = slotCommands();
                sim.step(playerOneCommand(), c[1], c.slice(2));
                hostSession?.afterStep((slot) => sim.interactionIds(slot));
                physTimes[physHead] = sim.physicsMs;
                physHead = (physHead + 1) % physTimes.length;
                physCount = Math.min(physTimes.length, physCount + 1);
            }
            clock.tick = sim.tick;
            renderTime = clock.renderTime;
        } else {
            renderTime = state.pausedTime;
        }

        // ---- in the driver's seat the view turns with the ute (the look stays relative to it)
        followUte(0, guestSession ? guestSession.slot : 0, renderTime);
        if (state.players > 1 && localSlot2 > 0) followUte(1, localSlot2, renderTime);

        // ---- first-person camera: interpolated position, look applied at display rate
        if (state.mode === 'firstPerson') {
            const myEye = guestSession ? sim.eyes[Math.max(0, guestSession.slot)] : sim.playerEntity;
            const mySlot = guestSession ? guestSession.slot : 0;
            cameraFeel(mySlot >= 0 && mySlot < sim.avatars.length ? sim.avatars[mySlot].slot : -1, renderTime, feel);
            if (sim.ring.sample(myEye.slot, renderTime, playerPose, playerAnim)) {
                camera.setPosition(playerPose.p.x + feel.dx, playerPose.p.y + feel.dy, playerPose.p.z + feel.dz);
            } else {
                camera.setPosition(sim.player.x, sim.player.y + EYE_HEIGHT, sim.player.z);
            }
            camera.setEulerAngles(
                ((fpInput.pitch + feel.pitch) * 180) / Math.PI,
                (fpInput.yaw * 180) / Math.PI,
                (feel.roll * 180) / Math.PI
            );
            // over-the-shoulder view (C): back, up and to the right of the eye, same look
            if (state.chase && localSlot2 < 0) {
                const e = camera.getPosition();
                const yaw = fpInput.yaw;
                const cp = Math.cos(fpInput.pitch);
                const back = 3.2;
                camera.setPosition(
                    e.x + Math.sin(yaw) * cp * back + Math.cos(yaw) * 0.7,
                    e.y - Math.sin(fpInput.pitch) * back * 0.35 + 0.45,
                    e.z + Math.cos(yaw) * cp * back - Math.sin(yaw) * 0.7
                );
                // ?view=side (screenshots of the animation): from the beaver's right, level
                if (sideView) {
                    camera.setPosition(
                        e.x + Math.cos(yaw) * 2.1 * EYE_HEIGHT,
                        e.y - 0.45 * EYE_HEIGHT,
                        e.z - Math.sin(yaw) * 2.1 * EYE_HEIGHT
                    );
                    camera.setEulerAngles(-5, (yaw * 180) / Math.PI + 90, 0);
                }
            }
        }
        if (camera.camera!.fov !== state.fov) camera.camera!.fov = state.fov;
        // ---- player 2's view (split screen): interpolated eye, look at display rate
        if (state.players > 1 && localSlot2 > 0) {
            const c2 = scene.camera2;
            const p2 = pads.players[1];
            if (sim.ring.sample(sim.eyes[localSlot2].slot, renderTime, playerPose, playerAnim))
                c2.setPosition(playerPose.p.x, playerPose.p.y, playerPose.p.z);
            const yaw2 = p2 ? p2.yaw : sim.players[localSlot2].yaw;
            const pitch2 = p2 ? p2.pitch : sim.players[localSlot2].pitch;
            c2.setEulerAngles((pitch2 * 180) / Math.PI, (yaw2 * 180) / Math.PI, 0);
            if (c2.camera!.fov !== state.fov) c2.camera!.fov = state.fov;
        }

        // ---- voxel clock: one reconstruction per voxel frame, committed before any pass renders
        const frame = voxelClock.frameAt(renderTime);
        // your own beaver, without its head, when yours is the only camera on this device
        const ownSlot = guestSession ? guestSession.slot : 0;
        pipeline.firstPersonSlot =
            state.mode === 'firstPerson' &&
            !state.chase &&
            localSlot2 < 0 &&
            ownSlot >= 0 &&
            ownSlot < sim.avatars.length
                ? sim.avatars[ownSlot].slot
                : -1;
        pipeline.firstPersonBodySlot = sim.fpBody.slot;
        if (frame !== voxelClock.frame || state.forceVoxel) {
            voxelClock.frame = frame;
            state.forceVoxel = false;
            pipeline.request(frame, voxelClock.timeOf(frame));
        }
        // apply a finished voxel frame (all its meshes at once) before this frame renders
        pipeline.poll();
        // your own limbs stay with the camera between voxel frames
        let bodyNow: { x: number; y: number; z: number; yaw: number } | null = null;
        if (pipeline.firstPersonSlot >= 0 && sim.ring.sample(pipeline.firstPersonSlot, renderTime, bodyPose, bodyAnim))
            // the beaver's root faces the other way from the look (its yaw is the look's + pi)
            bodyNow = { x: bodyPose.p.x, y: bodyPose.p.y, z: bodyPose.p.z, yaw: fpInput.yaw + Math.PI };
        pipeline.lockBody(sim.fpBody.id, bodyNow);
        reference.update(renderTime);
        if (state.colliders) drawColliders();
        // gusts stir the water
        windAt(renderTime, level.wind ?? CALM, windNow);
        scene.water.rippleSpeed = 0.03 + 0.012 * windNow.speed;
        scene.water.bumpiness = 0.26 + 0.03 * windNow.speed;
        // the flood (Epic 8): the river's surface follows the host's water level
        const hz = guestSession ? guestSession.hazard : sim.hazards.net();
        if (hz.waterY !== fx.waterY) {
            scene.waterEntity.setLocalPosition(level.water.cx, hz.waterY, level.water.cz);
            fx.waterY = hz.waterY;
        }
        // the aimed gust's warning: leaves stream past the player it is aimed at
        if (hz.gust === 1 && prevGustPhase === 0 && hz.gustSlot >= 0 && hz.gustSlot < sim.eyes.length) {
            if (sim.ring.sample(sim.eyes[hz.gustSlot].slot, renderTime, playerPose, playerAnim))
                fx.gust(
                    renderTime,
                    playerPose.p.x,
                    playerPose.p.y - 0.5,
                    playerPose.p.z,
                    Math.cos(hz.gustDir),
                    Math.sin(hz.gustDir)
                );
        }
        prevGustPhase = hz.gust;
        const cpos = camera.getPosition();
        audio.update({
            time: renderTime,
            listener: { x: cpos.x, y: cpos.y, z: cpos.z },
            hazard: hz,
            windSpeed: windNow.speed,
            players: sim.players.map((_, i) => soundPlayer(i)),
            uteDriven: guestSession ? guestSession.hud.some((h) => h.seat === 0) : sim.driver >= 0
        });
        if (state.mode === 'firstPerson') playtestFrame(renderTime);

        // ---- debug overlay uniform
        const g = state.gridLines ? 1 : 0;
        if (g !== gridUniform || g) {
            app.graphicsDevice.scope.resolve('uVoxelGridLines').setValue(g);
            gridUniform = g;
        }

        if (panel.visible && (frameTimeHead & 7) === 0) panel.setStats(statsText());
        if ((frameTimeHead & 3) === 0) updatePrompt();
        pollEvents();
        updateWater();
    }
}
const directorEntity = new Entity('LabDirector');
directorEntity.addComponent('script');
directorEntity.script!.create(LabDirector);
app.root.addChild(directorEntity);
app.graphicsDevice.scope.resolve('uVoxelGridLines').setValue(0);

/** What the sound needs of a player: playing, holding (entity id) and seat, host or guest alike. */
function soundPlayer(i: number): { active: boolean; held: number; seat: number } {
    if (guestSession) {
        const h = guestSession.hud[i];
        return { active: true, held: h?.held ?? -1, seat: h?.seat ?? -1 };
    }
    const active = sim.isSlotActive(i);
    return {
        active,
        held: active && sim.physicsProps ? sim.physics.heldIdOf(i) : -1,
        seat: sim.seatOf(i)
    };
}

/** Player 1: keyboard + mouse, merged with player 1's pad when one has joined. */
function playerOneCommand() {
    const cmd = fpInput.command();
    if (touch.enabled) {
        const t = touch.take();
        if (t.moveX || t.moveZ) {
            cmd.moveX = t.moveX;
            cmd.moveZ = t.moveZ;
        }
        cmd.sprint ||= t.sprint;
        cmd.jump ||= t.jump;
        cmd.grab ||= t.grab;
        cmd.throw ||= t.throw;
        if (t.action) cmd.action = t.action;
    }
    const pad = pads.players[0];
    if (!pad) return cmd;
    const p = pad.take();
    if (pad.moving) {
        cmd.moveX = p.moveX;
        cmd.moveZ = p.moveZ;
    }
    cmd.sprint ||= p.sprint;
    cmd.jump ||= p.jump && state.mode === 'firstPerson';
    cmd.grab ||= p.grab && state.mode === 'firstPerson';
    cmd.throw ||= p.throw && state.mode === 'firstPerson';
    cmd.reach += p.reach;
    if (p.action) cmd.action = p.action;
    // a pad drives player 1 without pointer lock
    if (state.mode === 'firstPerson' && pad.moving && !fpInput.locked) {
        cmd.moveX = p.moveX;
        cmd.moveZ = p.moveZ;
    }
    return cmd;
}

/** Player 2: their pad (or the test hook); undefined in single player. */
function playerTwoCommand() {
    if (state.players < 2) return undefined;
    const pad = pads.players[1];
    const p = sim.players[Math.max(1, localSlot2)];
    const base = pad ? pad.command() : { ...neutralCommand(0, p.yaw, p.pitch) };
    if (p2Injected) {
        Object.assign(base, p2Injected);
        p2Injected = null;
    }
    return base;
}

/** Commands for slots 1.. this tick: remote guests (when hosting) and the local second player. */
function slotCommands(): (PlayerCommand | undefined)[] {
    const out: (PlayerCommand | undefined)[] = [];
    for (let slot = 1; slot < MAX_PLAYERS; slot++) {
        if (slot === localSlot2) out[slot] = playerTwoCommand();
        else if (hostSession) out[slot] = hostSession.commandFor(slot);
    }
    return out;
}

/** One player or two on this device (split screen: player 1 on top, player 2 below). */
function setPlayers(n: number): void {
    const count = n >= 2 && !guestSession ? 2 : 1;
    if (count === state.players) return;
    if (count === 2) {
        const slot = sim.freeSlot();
        if (slot < 0) {
            showToast('No free player slot (the online game is full)');
            return;
        }
        localSlot2 = slot;
    }
    state.players = count;
    if (count === 2 && state.mode !== 'firstPerson') setMode('firstPerson', false);
    if (count === 2) sim.setSlotActive(localSlot2, true);
    else if (localSlot2 > 0) {
        sim.setSlotActive(localSlot2, false);
        localSlot2 = -1;
    }
    const p2 = pads.players[1];
    if (p2 && localSlot2 > 0) {
        p2.yaw = sim.players[localSlot2].yaw;
        p2.pitch = sim.players[localSlot2].pitch;
    }
    scene.setSplit(count === 2);
    document.body.classList.toggle('split', count === 2);
    panel.sync();
    updateHud();
}

pads.onJoin = (slot) => {
    if (slot === 0) {
        if (state.mode !== 'firstPerson') setMode('firstPerson', false);
        showToast('Player 1: gamepad connected');
    } else {
        setPlayers(2);
        showToast('Player 2 joined — split screen');
    }
};
pads.onLeave = (slot) => {
    if (slot === 1) {
        setPlayers(1);
        showToast('Player 2 left');
    }
};

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
    if (guestSession) return; // the host runs the game
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
    if (guestSession) return;
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
    if (guestSession) return;
    playtest.note(performance.now(), 'restart', 'level restarted');
    sim.reset();
    clock.reset(0);
    state.pausedTime = 0;
    state.forceVoxel = true;
    if (state.mode === 'orbit') {
        camera.setPosition(ORBIT_HOME.pos);
        orbit.focusPoint = ORBIT_HOME.focus.clone();
    } else if (level.rules) {
        toSpawn();
    }
    seenEvents = 0;
    updateObjective();
}

/** First person at the level's start, looking where the level wants you to look. */
function toSpawn(): void {
    const sp = level.spawn;
    sim.placePlayer(sp.x, sp.z, sp.yaw);
    fpInput.yaw = sp.yaw;
    fpInput.pitch = sp.pitch;
    clock.reset(sim.tick);
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
        if (id === 'props') return sim.propsMode;
        if (id === 'players') return String(state.players);
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
                applyViewDistance(scene.quality);
                state.refraction = scene.quality.refraction;
                state.reflectionScale = scene.quality.reflectionScale;
                applyWater();
                panel.sync();
                break;
            case 'look':
                state.look = v === 'pixel' ? 'pixel' : 'default';
                scene.setPixelLook(state.look === 'pixel');
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
            case 'cameraFeel':
                state.cameraFeel = Boolean(v);
                break;
            case 'chase':
                state.chase = Boolean(v);
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
            case 'players':
                setPlayers(Number(v));
                break;
            case 'particles':
                state.particles = Boolean(v);
                fx.enabled = state.particles;
                state.forceVoxel = true;
                break;
        }
        persistFromState();
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
            { kind: 'toggle', id: 'colliders', label: 'Physics colliders' },
            { kind: 'toggle', id: 'particles', label: 'Leaves & particles' },
            {
                kind: 'select',
                id: 'players',
                label: 'Players (split screen)',
                options: [
                    { value: '1', label: '1' },
                    { value: '2', label: '2 (gamepad A joins)' }
                ]
            }
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
            },
            {
                kind: 'select',
                id: 'look',
                label: 'Look (L)',
                options: [
                    { value: 'default', label: 'Default' },
                    { value: 'pixel', label: 'Pixel (prototype)' }
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
            { kind: 'toggle', id: 'cameraFeel', label: 'Camera bob & kick' },
            { kind: 'toggle', id: 'chase', label: 'Over the shoulder (C)' },
            { kind: 'range', id: 'fov', label: 'FOV', min: 40, max: 100, step: 1 },
            { kind: 'range', id: 'sensitivity', label: 'Mouse sensitivity', min: 0.5, max: 6, step: 0.1 }
        ]
    }
]);

// ------------------------------------------------------------------------------------- HUD

const hud = document.createElement('div');
hud.className = 'hud';
hud.innerHTML = `
  <div class="hud-title"><b>(Un)civil Engineers</b> <span>${level.id === 'lab' ? 'River Lab · voxel tech demo' : level.id === 'yard' ? `Level 1 · ${level.name}` : level.name}</span></div>
  <div class="hud-objective" id="hud-objective"></div>
  <div class="hud-water" id="hud-water"></div>
  <div class="hud-help" id="hud-help"></div>
  <div class="hud-prompt" id="hud-prompt"></div>`;
document.body.append(hud);
// bottom dock: voxel-size box (left) and debug chip (right). Its measured height keeps the debug
// panel above it on every screen, so the boxes never overlap (portrait phones included).
const dock = document.createElement('div');
dock.className = 'ui-dock';
document.body.append(dock);
// ---- voxel size: a per-player quality setting (Settings > Video), applied by reloading (sizes derive
// from it at load)
function applyCellSize(cm: number): void {
    const v = clampCellSizeCm(cm);
    // the default is stored as "no choice", so a saved size never hides a later default change
    try {
        if (v === CELL_SIZE_DEFAULT_CM) localStorage.removeItem(CELL_SIZE_STORAGE_KEY);
        else localStorage.setItem(CELL_SIZE_STORAGE_KEY, String(v));
    } catch {
        // storage blocked: the hash below still carries the choice
    }
    if (v === CELL_SIZE_DEFAULT_CM) history.replaceState(null, '', location.pathname + location.search);
    else location.hash = `cell${Math.round(v * 10)}`;
    location.reload();
}

const crosshair = document.createElement('div');
crosshair.className = 'crosshair';
document.body.append(crosshair);
// split screen: player 2's crosshair, prompt and label in the bottom view; player 1's label on top
const crosshair2 = document.createElement('div');
crosshair2.className = 'crosshair crosshair-p2';
document.body.append(crosshair2);
const prompt2 = document.createElement('div');
prompt2.className = 'hud-prompt prompt-p2';
document.body.append(prompt2);
for (const n of [1, 2]) {
    const tag = document.createElement('div');
    tag.className = `player-tag player-tag-${n}`;
    tag.textContent = `P${n}`;
    document.body.append(tag);
}
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
    updateTouch();
    const help = document.getElementById('hud-help')!;
    // long help for keyboard screens, short help for narrow / touch screens (chosen in CSS)
    const long =
        state.mode === 'orbit'
            ? `Drag to orbit · right-drag to pan · wheel to zoom${hotkey('KeyV', 'first person')}${hotkey('KeyH', 'hide UI')}`
            : sim.physicsProps
              ? `Click to look · ${kbd(moveKeys())} move · ${kbd(keysText(bindings, 'sprint'))} run · ${kbd(keysText(bindings, 'jump'))} jump · ${kbd(keysText(bindings, 'grab'))} grab / release · ${kbd(keysText(bindings, 'throw'))} throw · ${kbd(keyVerb('reachFar'))} reach · ${kbd(keysText(bindings, 'drop'))} drop · ${kbd(keysText(bindings, 'pour'))} pour · ${kbd(keysText(bindings, 'plank'))} plank · ${kbd(keysText(bindings, 'ragdoll'))} ragdoll · <kbd>Esc</kbd> release mouse${hotkey('KeyV', 'orbit')}`
              : `Click to look · ${kbd(moveKeys())} move · ${kbd(keysText(bindings, 'sprint'))} run · ${kbd(keysText(bindings, 'jump'))} jump · ${kbd(keysText(bindings, 'plank'))} carry plank · <kbd>Esc</kbd> release mouse${hotkey('KeyV', 'orbit')}`;
    const short =
        state.mode === 'orbit'
            ? 'Drag to orbit · two fingers to pan and zoom'
            : `Click to look · ${moveKeys()} move · ${lower(keyVerb('grab'))} grab${hotkey('KeyV', 'orbit', false)}`;
    if (touchSeen && state.mode === 'firstPerson') {
        help.innerHTML =
            'Left thumb: move (push to the edge to run) · right thumb: look · buttons: jump, grab, throw, drop, pour';
        crosshair.style.display = !state.uiHidden ? '' : 'none';
        return;
    }
    if (state.players > 1 || pads.players[0]) {
        help.innerHTML =
            'Pads: left stick move · right stick look · A jump · RT grab / release · RB throw · B drop · Y pour · X ragdoll · D-pad up/down reach';
        crosshair.style.display = state.mode === 'firstPerson' && !state.uiHidden ? '' : 'none';
        return;
    }
    help.innerHTML = `<span class="help-long">${long}</span><span class="help-short">${short}</span>`;
    crosshair.style.display = state.mode === 'firstPerson' && !state.uiHidden ? '' : 'none';
}

function setUiHidden(h: boolean): void {
    state.uiHidden = h;
    document.body.classList.toggle('ui-hidden', h);
    updateHud();
    layoutVars();
}

const PROP_LABEL: Record<string, string> = {
    plank: 'plank',
    'held-plank': 'plank',
    log: 'log (heavy)',
    cube: 'crate',
    sphere: 'ball',
    bucket: 'bucket'
};
const propLabel = (name: string) =>
    PROP_LABEL[name] ??
    (name.startsWith('dummy')
        ? 'dummy'
        : name.startsWith('stress')
          ? 'test body'
          : name.startsWith('extra-plank')
            ? 'plank'
            : name.startsWith('beam')
              ? 'beam'
              : name.startsWith('extra-log')
                ? 'log (heavy)'
                : (woodLabel(name) ?? name));

// ---- objective line and toasts for level events (fell in, bucket recovered, goal reached)
const toast = document.createElement('div');
toast.className = 'toast';
document.body.append(toast);
let toastTimer = 0;
let seenEvents = 0;
function showToast(text: string, kind = 'info'): void {
    toast.textContent = text;
    toast.className = `toast show toast-${kind}`;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(
        () => (toast.className = 'toast'),
        kind === 'goal' ? 6000 : kind === 'hazard' ? 5000 : 3500
    );
}

function updateObjective(): void {
    const el = document.getElementById('hud-objective');
    if (!el) return;
    const r = level.rules;
    const steps = r?.steps;
    if (steps) {
        const k = guestSession ? guestSession.step : sim.progress.step;
        const done = k >= steps.length;
        el.textContent = done
            ? '✓ Tutorial complete — pick a level from Levels'
            : `Step ${k + 1}/${steps.length} · ${steps[k].text}`;
        el.classList.toggle('done', done);
        return;
    }
    const stages = r?.stages;
    if (stages) {
        // journeys: the stage being played, out of all of them
        const k = guestSession ? guestSession.step : sim.progress.step;
        const done = k >= stages.length;
        el.textContent = done
            ? '✓ The bucket reached the flower — the valley is yours'
            : `${k + 1}/${stages.length} ${stages[k].name} · ${stages[k].objective}`;
        el.classList.toggle('done', done);
        return;
    }
    const done = guestSession ? guestSession.goal : sim.progress.goalReached;
    el.textContent = r ? `${done ? '✓' : '○'} ${r.objective}` : '';
    el.classList.toggle('done', done);
}
/** The bucket's water (Epic 7): litres in it, and on the flower stage what the flower has had. */
const hasBucket = !!level.rules && level.props.some((p) => p.name === 'bucket');
let waterText = '';
function updateWater(): void {
    const el = document.getElementById('hud-water');
    if (!el) return;
    let t = '';
    if (hasBucket && sim.physicsProps) {
        const w = guestSession ? guestSession.water : { volume: sim.water.volume, poured: sim.water.poured };
        const stages = level.rules?.stages;
        const k = guestSession ? guestSession.step : sim.progress.step;
        const flower = stages && stages[Math.min(k, stages.length - 1)]?.flower;
        const full = Math.max(0, Math.min(10, Math.round((w.volume / BUCKET_CAPACITY) * 10)));
        t = `Bucket ${'▮'.repeat(full)}${'▯'.repeat(10 - full)} ${w.volume.toFixed(1)} L`;
        if (flower) t += ` · flower ${w.poured.toFixed(1)} / ${WATER.minDelivery} L`;
    }
    if (t !== waterText) {
        waterText = t;
        el.textContent = t;
    }
}

function pollEvents(): void {
    if (guestSession) {
        for (const e of guestSession.events) {
            if (e.n <= guestEventsSeen) continue;
            guestEventsSeen = e.n;
            showToast(e.text, e.kind);
            audio.onEvent(e.kind);
            playtest.note(performance.now(), e.kind, e.text);
        }
        updateObjective();
        return;
    }
    if (sim.events.length < seenEvents) seenEvents = 0;
    while (seenEvents < sim.events.length) {
        const e = sim.events[seenEvents++];
        showToast(e.text, e.kind);
        audio.onEvent(e.kind);
        playtest.note(performance.now(), e.kind, e.text);
        updateObjective();
    }
}
let promptText = '';

/** Context prompt (design doc §2.3): what a click (or a trigger) would do right now. */
// ---- control names in hints and prompts, from the player's bindings (src/ui/prompts.ts)
const names = controlNames(bindings);
const { keyVerb, lower, moveKeys, kbd, hotkey } = names;

function interactionText(i: number, pad: boolean): string {
    const it = guestInteraction() ?? sim.interaction(i);
    return interactionPrompt(it, pad, names, propLabel, (n) =>
        woodPrompt(it, pad ? 'pad' : 'mouse', treeCut, sawBeams(), n)
    );
}

/** A stand tree's cut so far, from the newest snapshot (the same for host and guests). */
const cutPose = pose();
const cutAnim = new Float64Array(ANIM_MAX);
function treeCut(marker: string): number {
    const e = sim.entities.find((x) => x.name === marker);
    if (!e || !sim.ring.sample(e.slot, sim.ring.newestTick * SIM_DT, cutPose, cutAnim)) return 0;
    return cutAnim[TREE_CUT];
}

/** Whether the sawmill is set to beams, from the newest snapshot. */
function sawBeams(): boolean {
    const e = sim.forestry.ents.sawmill;
    if (!sim.ring.sample(e.slot, sim.ring.newestTick * SIM_DT, cutPose, cutAnim)) return false;
    return cutAnim[SAW_MODE] > 0.5;
}

/** A guest's prompt comes from the host (guests run no physics). */
function guestInteraction(): {
    holding: string | null;
    target: string | null;
    shared: boolean;
    driving: boolean;
    seat: number;
} | null {
    if (!guestSession) return null;
    const h = guestSession.hud[guestSession.slot];
    if (!h) return { holding: null, target: null, shared: false, driving: false, seat: -1 };
    const name = (id: number) => (id < 0 ? null : (sim.entities.find((e) => e.id === id)?.name ?? null));
    return { holding: name(h.held), target: name(h.target), shared: h.shared, driving: h.driving, seat: h.seat };
}

/** The ute's yaw last render frame, per local view (NaN when that view's player isn't in it). */
const lastUteYaw = [NaN, NaN];
const utePose = pose();
const uteAnim = new Float64Array(ANIM_MAX);
function followUte(view: number, slot: number, time: number): void {
    const seated = slot >= 0 && (guestSession ? (guestSession.hud[slot]?.seat ?? -1) : sim.seatOf(slot)) >= 0;
    if (!seated || !sim.ring.sample(sim.ute.slot, time, utePose, uteAnim)) {
        lastUteYaw[view] = NaN;
        return;
    }
    const q = utePose.q;
    const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
    const prev = lastUteYaw[view];
    lastUteYaw[view] = yaw;
    if (Number.isNaN(prev)) return;
    let d = yaw - prev;
    if (d > Math.PI) d -= 2 * Math.PI;
    else if (d < -Math.PI) d += 2 * Math.PI;
    // player 1's pad takes its look from fpInput each frame
    if (view === 0) fpInput.yaw += d;
    else {
        const pad = pads.players[1];
        if (pad) pad.yaw += d;
    }
}

function updatePrompt(): void {
    let t = '';
    if (state.mode === 'firstPerson') {
        if (touch.enabled) {
            const it = guestInteraction() ?? sim.interaction(0);
            touch.setHolding(!!it.holding, it.holding === 'bucket');
            t = it.driving
                ? 'Driving · stick to drive · jump to brake · drop to recover · grab to get out'
                : woodPrompt(it, 'touch', treeCut, sawBeams())
                  ? woodPrompt(it, 'touch', treeCut, sawBeams())!
                  : it.seat >= 0
                    ? 'Riding along · grab to get out'
                    : it.holding
                      ? `Holding ${propLabel(it.holding)}${it.shared ? ' together' : ''}`
                      : it.target === 'ute'
                        ? 'Grab to drive the ute'
                        : it.target
                          ? `Grab ${propLabel(it.target)}`
                          : '';
        } else if (!fpInput.locked && !pads.players[0]) t = 'Click to look around';
        else t = interactionText(0, !fpInput.locked);
    }
    if (state.players > 1 && localSlot2 > 0) prompt2.textContent = interactionText(localSlot2, true);
    if (t !== promptText) {
        promptText = t;
        document.getElementById('hud-prompt')!.textContent = t;
        crosshair.classList.toggle(
            'crosshair-active',
            t.startsWith(`${keyVerb('grab')} to grab`) ||
                t.startsWith('Holding') ||
                t.startsWith(`${keyVerb('grab')} to drive`)
        );
    }
}
document.addEventListener('pointerlockchange', updatePrompt);

window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    // the settings menu takes the keyboard while it is open (it handles its own keys)
    if (menu.open) return;
    if (e.code === 'Escape' && !e.repeat && !editing) {
        // with the mouse captured, the browser's Esc releases it first (that opens the menu, below)
        menu.show();
        e.preventDefault();
        return;
    }
    // a key bound to a game action does that, not a hotkey (bind V to jump and V jumps)
    if (actionForKey(bindings, e.code)) return;
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
        case 'KeyC':
            state.chase = !state.chase;
            panel.sync();
            persistFromState();
            break;
        case 'KeyL':
            state.look = state.look === 'pixel' ? 'default' : 'pixel';
            scene.setPixelLook(state.look === 'pixel');
            panel.sync();
            persistFromState();
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

const EMPTY_FRAME_STATS = {
    frame: -1,
    time: 0,
    objects: 0,
    parts: 0,
    candidates: 0,
    samples: 0,
    occupied: 0,
    rejected: 0,
    changedCells: 0,
    dirtyCells: 0,
    dynDynOverlaps: 0,
    dynStaticOverlaps: 0,
    staticRebuilt: 0,
    dynamicRebuilt: 0,
    rasterMs: 0,
    resolveMs: 0,
    meshMs: 0,
    totalMs: 0,
    dynamicCells: 0,
    chunks: build.chunks,
    particles: 0
};

function collectStats() {
    const v = { ...(pipeline.lastStats ?? EMPTY_FRAME_STATS), uploadMs: pipeline.uploadMs };
    // every lattice's meshes together
    const t = pipeline.renderers
        .map((r) => r.totals())
        .reduce((a, b) => ({
            staticUnits: a.staticUnits + b.staticUnits,
            dynamicUnits: a.dynamicUnits + b.dynamicUnits,
            quads: a.quads + b.quads,
            quadsDynamic: a.quadsDynamic + b.quadsDynamic,
            triangles: a.triangles + b.triangles,
            drawables: a.drawables + b.drawables
        }));
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
            releaseClamps: sim.physics.stats.releaseClamps,
            player: { x: sim.player.x, y: sim.player.y, z: sim.player.z, grounded: sim.player.grounded }
        },
        build: {
            workerBuildMs: build.buildMs,
            workerStaticMeshMs: build.staticMeshMs,
            staticUploadMs,
            columns: build.columns,
            trees: build.trees
        }
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
        `  clamps lin ${s.physics.linClamps} ang ${s.physics.angClamps}  release ${s.physics.releaseClamps}  recovered ${s.physics.recovered}  breaks ${s.physics.grabBreaks}`,
        `fx       particles ${v.particles ?? 0}  wind ${f(windNow.speed, 1)} m/s  max wind force ${f(sim.windForce, 1)} N`,
        `heap     ${s.heapMB === null ? 'n/a' : f(s.heapMB, 1) + ' MB'}  dropped ticks ${s.droppedTicks}`
    ].join('\n');
}

// ------------------------------------------------------------------------------------- online

/** Starts the transport in the background (the platform answers within ~10 s, or never). */
async function startTransport(): Promise<void> {
    const net = params.get('net');
    if (net === 'local') transport = localTransport();
    else if (net !== 'p2p' && net !== 'off') transport = await roomTransport();
    if (transport && netConditions) transport = degradedTransport(transport, netConditions);
    if (transport) {
        transportKind = transport.kind === 'room' ? 'room' : 'local';
        watchLobby();
    } else if (net !== 'off') {
        // peer to peer: connect now only when arriving to join a game, else when the panel opens
        transportKind = 'p2p';
        if (params.has('join')) await connectP2P();
    }
    online.render();
}

/**
 * Connects the peer-to-peer lobby (once). For tests: `?relays=ws://…,wss://…` replaces the public
 * relays and `?ice=local` uses no STUN servers.
 */
function connectP2P(): Promise<void> {
    if (transportKind !== 'p2p') return Promise.resolve();
    p2pStarting ??= import('./net/p2p.ts')
        .then(({ p2pTransport }) => {
            const relays = params.get('relays')?.split(',').filter(Boolean);
            const turnUrls = (import.meta.env.VITE_TURN_URLS ?? '').split(',').filter(Boolean);
            p2p = p2pTransport({
                relays,
                localOnly: params.get('ice') === 'local',
                turn: turnUrls.length
                    ? {
                          urls: turnUrls,
                          username: import.meta.env.VITE_TURN_USERNAME,
                          credential: import.meta.env.VITE_TURN_CREDENTIAL
                      }
                    : undefined
            });
            transport = netConditions ? degradedTransport(p2p, netConditions) : p2p;
            watchLobby();
            online.render();
        })
        .catch((e: unknown) => {
            console.warn('online play could not start', e);
            transportKind = 'none';
            online.render();
        });
    return p2pStarting;
}

function watchLobby(): void {
    transport?.lobby.onChange(() => {
        online.render();
        // arrived with ?join=CODE (switched level to join a game): join as soon as it is listed
        const code = params.get('join') ?? rejoinCode;
        if (code && !guestSession && !hostSession && !autoJoinTried) {
            const g = listGames(transport!.lobby).find((x) => x.code === code);
            if (g) {
                autoJoinTried = true;
                void joinOnline(g);
            }
        }
    });
}
let autoJoinTried = false;
/** Testing on a bad network on purpose: `?netsim=latency,jitter,loss` (ms, ms, 0..1). */
const netConditions = parseConditions(params.get('netsim'));
/** A game this tab was playing as a guest before a reload: rejoined (as the same player) when listed. */
const rejoinCode = gameToRejoin(level.id);
let wasReconnecting = false;

/** Tells a guest when the host goes quiet and when it is back. */
function noteReconnect(g: GuestSession): void {
    if (g.reconnecting !== wasReconnecting) {
        wasReconnecting = g.reconnecting;
        showToast(g.reconnecting ? 'Lost the host: reconnecting…' : 'Reconnected', g.reconnecting ? 'warn' : 'info');
    }
    // keep the rejoin record fresh, so a reload within the host's grace period comes back
    const now = Date.now();
    if (!g.reconnecting && g.received > 0 && now - lastRemembered > 5000) {
        lastRemembered = now;
        rememberGame(g.code, level.id, now);
    }
}
let lastRemembered = 0;

async function hostOnline(): Promise<void> {
    await connectP2P();
    if (!transport || hostSession || guestSession) return;
    if (state.paused) setPaused(false);
    if (state.mode !== 'firstPerson') {
        setMode('firstPerson', false);
        toSpawn();
    }
    hostSession = await HostSession.start(transport, sim, level.id);
    playtest.note(performance.now(), 'online', `hosting game ${hostSession.code}`);
    hostSession.onGuestsChanged = (joined, left, dropped, back) => {
        for (const s of joined) showToast(`Player ${s + 1} joined`);
        for (const s of left) showToast(`Player ${s + 1} left`);
        for (const s of dropped) showToast(`Player ${s + 1} lost their connection: keeping their place for a minute`);
        for (const s of back) showToast(`Player ${s + 1} is back`);
        online.render();
    };
    showToast(`Hosting game ${hostSession.code}`);
    online.render();
}

async function joinOnline(ad: GameAd): Promise<void> {
    if (!transport || hostSession || guestSession) return;
    if (ad.v !== NET_PROTOCOL) {
        showToast('That game runs another version: reload both pages to play together', 'warn');
        return;
    }
    if (ad.level !== level.id && LEVEL_MENU.some((l) => l.id === ad.level)) {
        // the voxel world is built per level: reload into the host's level and join from there
        goToLevel(ad.level, { join: ad.code });
        return;
    }
    setPlayers(1);
    if (state.paused) setPaused(false);
    guestSession = await GuestSession.join(transport, sim, ad, { token: rejoinToken() });
    playtest.note(performance.now(), 'online', `joined game ${ad.code}`);
    rememberGame(ad.code, level.id);
    wasReconnecting = false;
    guestEventsSeen = 0;
    state.forceVoxel = true;
    if (state.mode !== 'firstPerson') setMode('firstPerson', false);
    showToast(`Joined game ${ad.code}`);
    online.render();
    if (transportKind === 'p2p') {
        // peer to peer has no relay server for game data: a strict network can block the connection
        const joined = guestSession;
        setTimeout(() => {
            if (guestSession === joined && joined.received === 0)
                showToast("Can't reach the host yet: one of your networks may block direct connections");
        }, 25_000);
    }
}

/** Leaves the online game; a guest goes back to its own (solo) world. */
function leaveOnline(message?: string): void {
    if (hostSession) {
        hostSession.stop();
        hostSession = null;
    }
    if (guestSession) {
        guestSession.leave();
        guestSession = null;
        forgetGame();
        sim.reset();
        clock.reset(0);
        state.forceVoxel = true;
        if (state.mode === 'firstPerson') toSpawn();
    }
    if (message) showToast(message);
    online.render();
    updateObjective();
}

const online = new OnlinePanel(
    {
        available: () => transportKind,
        opened: () => void connectP2P(),
        p2pStatus: () => (transportKind === 'p2p' ? (p2p ? p2p.status() : null) : null),
        games: () => (transport ? listGames(transport.lobby) : []),
        level: level.id,
        status: () =>
            hostSession
                ? {
                      mode: 'host',
                      code: hostSession.code,
                      players: sim.playerCount,
                      max: MAX_PLAYERS,
                      guests: [...hostSession.slots.values()]
                          .sort((a, b) => a - b)
                          .map((s) => ({ slot: s, lagMs: hostSession!.lagMs(s) })),
                      dropped: hostSession.droppedSlots()
                  }
                : guestSession
                  ? {
                        mode: 'guest',
                        code: guestSession.code,
                        slot: guestSession.slot,
                        waiting: guestSession.received === 0,
                        lagMs: guestSession.lagMs,
                        reconnecting: guestSession.reconnecting
                    }
                  : { mode: 'off' },
        host: hostOnline,
        join: joinOnline,
        leave: () => leaveOnline()
    },
    dock
);
void startTransport();

// ---- Levels: a small chooser in the dock
const levelsBtn = document.createElement('button');
levelsBtn.type = 'button';
levelsBtn.className = 'online-chip levels-chip';
levelsBtn.textContent = 'Levels';
dock.insertBefore(levelsBtn, online.button);
const levelsPanel = document.createElement('div');
levelsPanel.className = 'online-panel levels-panel';
levelsPanel.style.display = 'none';
for (const ev of ['pointerdown', 'mousedown', 'wheel', 'click', 'touchstart'])
    levelsPanel.addEventListener(ev, (e) => e.stopPropagation());
document.body.append(levelsPanel);
function renderLevels(): void {
    levelsPanel.replaceChildren();
    const t = document.createElement('div');
    t.className = 'online-title';
    t.textContent = 'Levels';
    levelsPanel.append(t);
    for (const l of LEVEL_MENU) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = l.id === level.id ? 'online-primary' : '';
        b.textContent = l.id === level.id ? `${l.name} (playing)` : l.name;
        b.title = l.note;
        b.addEventListener('click', () => (l.id === level.id ? (levelsPanel.style.display = 'none') : goToLevel(l.id)));
        levelsPanel.append(b);
        const n = document.createElement('p');
        n.className = 'online-note';
        n.textContent = l.note;
        levelsPanel.append(n);
    }
    const hasDraft = (() => {
        try {
            return localStorage.getItem(DESIGN_KEY) !== null;
        } catch {
            return false;
        }
    })();
    const own = document.createElement('div');
    own.className = 'online-title';
    own.textContent = 'Your levels';
    levelsPanel.append(own);
    const design = document.createElement('button');
    design.type = 'button';
    design.textContent = editing ? 'Level designer (open)' : 'Level designer';
    design.addEventListener('click', () => goToLevel('custom', { edit: '1' }));
    levelsPanel.append(design);
    if (hasDraft || level.id === 'custom') {
        const play = document.createElement('button');
        play.type = 'button';
        play.textContent = level.id === 'custom' && !editing ? 'Play my level (playing)' : 'Play my level';
        play.addEventListener('click', () => goToLevel('custom'));
        levelsPanel.append(play);
    }
    const dn = document.createElement('p');
    dn.className = 'online-note';
    dn.textContent = 'Build your own level, playtest it, and copy it out as JSON.';
    levelsPanel.append(dn);
    const c = document.createElement('button');
    c.type = 'button';
    c.textContent = 'Close';
    c.addEventListener('click', () => (levelsPanel.style.display = 'none'));
    levelsPanel.append(c);
}
levelsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = levelsPanel.style.display === 'none';
    if (open) renderLevels();
    levelsPanel.style.display = open ? '' : 'none';
});

// ------------------------------------------------------------------------------------- settings

/** Changes a setting for this visit and saves it (only what the player changed is saved). */
function setSetting<K extends keyof Settings>(key: K, v: Settings[K]): void {
    if (settings[key] === v) return;
    settings[key] = v;
    savedSettings[key] = v;
    saveSettings(settingsStorage, savedSettings);
}

/** Settings that also live in the game state (the debug panel and hotkeys change them too). */
function persistFromState(): void {
    setSetting('fov', state.fov);
    setSetting('mouseSensitivity', state.sensitivity);
    setSetting('quality', state.quality);
    setSetting('look', state.look);
    setSetting('cameraBob', state.cameraFeel);
    setSetting('overShoulder', state.chase);
    setSetting('particles', state.particles);
    if (menuReady) menu.sync();
}

function applyInputSettings(): void {
    fpInput.sensitivity = settings.mouseSensitivity / 1000;
    fpInput.invertY = settings.invertMouseY;
    pads.lookScale = settings.padLookSpeed;
    pads.invertY = settings.invertPadY;
    touch.lookScale = settings.touchLookSpeed;
}

function applyUiSettings(): void {
    audio.setVolumes({
        master: settings.volumeMaster,
        effects: settings.volumeEffects,
        ambience: settings.volumeAmbience
    });
    document.documentElement.style.setProperty('--ui-scale', String(settings.uiScale));
    document.body.classList.toggle('no-hints', !settings.controlHints);
    layoutVars();
}
applyInputSettings();
applyUiSettings();

/** Settings keys that map onto debug panel controls (same side effects). */
const PANEL_ID: Partial<Record<keyof Settings, string>> = {
    fov: 'fov',
    mouseSensitivity: 'sensitivity',
    quality: 'quality',
    look: 'look',
    cameraBob: 'cameraFeel',
    overShoulder: 'chase',
    particles: 'particles'
};
let cellPending = cellCm;
let menuReady = false;
let menuPaused = false;
let menuPadIndex = -1;

/** The pad that drives the menu: the one that opened it, else the first connected. */
function menuPad(): Gamepad | null {
    try {
        const all = navigator.getGamepads ? Array.from(navigator.getGamepads()) : [];
        return (
            all.find((g) => g && g.connected && g.index === menuPadIndex) ?? all.find((g) => g && g.connected) ?? null
        );
    } catch {
        return null;
    }
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const times = (v: number) => `${v.toFixed(1)}×`;
const menu = new SettingsMenu(
    {
        get(key): SettingValue {
            if (key === 'cellCm') return cellPending;
            if (key === 'uiHidden') return state.uiHidden;
            if (key === 'debugPanel') return panel.visible;
            return settings[key as keyof Settings];
        },
        set(key, v) {
            if (key === 'cellCm') {
                cellPending = clampCellSizeCm(Number(v));
                menu.sync();
                return;
            }
            if (key === 'uiHidden') {
                setUiHidden(Boolean(v));
                return;
            }
            if (key === 'debugPanel') {
                panel.visible = Boolean(v);
                return;
            }
            const k = key as keyof Settings;
            const pid = PANEL_ID[k];
            if (pid) {
                host.set(pid, v as string | number | boolean);
                panel.sync();
                return;
            }
            (setSetting as (k: keyof Settings, v: SettingValue) => void)(k, v);
            applyInputSettings();
            applyUiSettings();
        },
        action(id) {
            switch (id) {
                case 'resume':
                    menu.close();
                    if (state.mode === 'firstPerson' && !touch.enabled) fpInput.lock();
                    break;
                case 'restart':
                    menu.close();
                    resetScene();
                    break;
                case 'levels':
                    menu.close();
                    renderLevels();
                    levelsPanel.style.display = '';
                    break;
                case 'online':
                    menu.close();
                    online.button.click();
                    break;
                case 'playtest':
                    playtestPanel.open();
                    break;
                case 'applyCell':
                    applyCellSize(cellPending);
                    break;
                case 'resetCell':
                    applyCellSize(CELL_SIZE_DEFAULT_CM);
                    break;
                case 'resetKeys':
                case 'resetPad': {
                    const d = defaultBindings();
                    if (id === 'resetKeys') Object.assign(bindings.keys, d.keys);
                    else Object.assign(bindings.pad, d.pad);
                    saveBindings(settingsStorage, bindings);
                    updateHud();
                    menu.sync();
                    break;
                }
                case 'resetAll': {
                    // everything: the settings and the remapped keys and buttons
                    const d = defaultBindings();
                    Object.assign(bindings.keys, d.keys);
                    Object.assign(bindings.pad, d.pad);
                    saveBindings(settingsStorage, bindings);
                    for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
                        const v = DEFAULT_SETTINGS[k];
                        const pid = PANEL_ID[k];
                        if (pid) host.set(pid, v);
                        else (setSetting as (k: keyof Settings, v: SettingValue) => void)(k, v);
                    }
                    applyInputSettings();
                    applyUiSettings();
                    updateHud();
                    panel.sync();
                    menu.sync();
                    break;
                }
            }
        },
        binding(device, action, slot) {
            return device === 'keys'
                ? keyLabel(bindings.keys[action as Action][slot])
                : padLabel(bindings.pad[action as PadAction][slot]);
        },
        rebind(device, action, slot, value) {
            let note: string | null = null;
            if (device === 'keys') {
                const code = typeof value === 'string' ? value : '';
                if (code && !bindableKey(code))
                    return `${keyLabel(code)} can't be bound (it opens the menu or the browser's own)`;
                const took = bindKey(bindings, action as Action, slot, code);
                if (took) note = `${keyLabel(code)} was ${ACTION_LABELS[took]}: that is now unbound there`;
            } else {
                const button = typeof value === 'number' ? value : -1;
                if (button === 9) return "Start opens the menu and can't be bound";
                const took = bindPad(bindings, action as PadAction, slot, button);
                if (took) note = `${padLabel(button)} was ${ACTION_LABELS[took]}: that is now unbound there`;
            }
            saveBindings(settingsStorage, bindings);
            updateHud();
            return note;
        },
        enabled(id) {
            if (id === 'applyCell') return cellPending !== cellCm;
            if (id === 'resetCell') return cellCm !== CELL_SIZE_DEFAULT_CM;
            if (id === 'restart') return !guestSession;
            return true;
        },
        shown(key) {
            // touch look speed only where there is touch; mouse rows everywhere else
            if (key === 'touchLookSpeed') return touchSeen;
            if (key === 'mouseSensitivity' || key === 'invertMouseY')
                return !touchSeen || matchMedia('(pointer: fine)').matches;
            return true;
        },
        opened() {
            playtest.note(performance.now(), 'menu', 'settings opened');
            // the game below gets no input, and solo play pauses (an online game keeps running)
            fpInput.suspended = true;
            fpInput.clear();
            pads.suspended = true;
            fpInput.unlock();
            levelsPanel.style.display = 'none';
            cellPending = cellCm;
            menuPaused = !state.paused && !hostSession && !guestSession;
            if (menuPaused) setPaused(true);
            updatePrompt();
        },
        closed() {
            fpInput.suspended = false;
            pads.suspended = false;
            if (menuPaused && state.paused) setPaused(false);
            menuPaused = false;
            updatePrompt();
        }
    },
    [
        {
            id: 'game',
            label: 'Game',
            rows: [
                { kind: 'button', id: 'resume', label: 'Resume', primary: true },
                { kind: 'button', id: 'restart', label: 'Restart level' },
                { kind: 'button', id: 'levels', label: 'Levels…' },
                { kind: 'button', id: 'online', label: 'Play online…' },
                {
                    kind: 'button',
                    id: 'playtest',
                    label: 'Playtest log…',
                    hint: 'What happened this session, to note, copy or save'
                },
                { kind: 'toggle', key: 'uiHidden', label: 'Hide HUD', hint: 'H' },
                { kind: 'toggle', key: 'debugPanel', label: 'Debug panel', hint: 'F3' }
            ]
        },
        {
            id: 'controls',
            label: 'Controls',
            rows: [
                {
                    kind: 'range',
                    key: 'mouseSensitivity',
                    label: 'Mouse sensitivity',
                    ...SETTING_RANGES.mouseSensitivity,
                    format: (v) => v.toFixed(1)
                },
                { kind: 'toggle', key: 'invertMouseY', label: 'Invert mouse Y' },
                {
                    kind: 'range',
                    key: 'padLookSpeed',
                    label: 'Gamepad look speed',
                    ...SETTING_RANGES.padLookSpeed,
                    format: times
                },
                { kind: 'toggle', key: 'invertPadY', label: 'Invert gamepad Y' },
                {
                    kind: 'range',
                    key: 'touchLookSpeed',
                    label: 'Touch look speed',
                    ...SETTING_RANGES.touchLookSpeed,
                    format: times
                },
                { kind: 'toggle', key: 'overShoulder', label: 'Over-the-shoulder camera', hint: 'C' }
            ]
        },
        {
            id: 'keys',
            label: 'Keys',
            rows: [
                ...ACTIONS.map((a) => ({
                    kind: 'binding' as const,
                    key: a,
                    label: ACTION_LABELS[a],
                    device: 'keys' as const
                })),
                { kind: 'button', id: 'resetKeys', label: 'Reset keys to defaults' }
            ]
        },
        {
            id: 'pad',
            label: 'Pad',
            rows: [
                ...PAD_ACTIONS.map((a) => ({
                    kind: 'binding' as const,
                    key: a,
                    label: ACTION_LABELS[a],
                    device: 'pad' as const,
                    hint: a === 'sprint' ? 'The sticks move and look; Start opens this menu' : undefined
                })),
                { kind: 'button', id: 'resetPad', label: 'Reset gamepad buttons to defaults' }
            ]
        },
        {
            id: 'video',
            label: 'Video',
            rows: [
                {
                    kind: 'choice',
                    key: 'quality',
                    label: 'Quality',
                    options: [
                        { value: 'high', label: 'High' },
                        { value: 'low', label: 'Low' }
                    ]
                },
                {
                    kind: 'range',
                    key: 'cellCm',
                    label: 'Voxel size',
                    min: CELL_SIZE_MIN_CM,
                    max: CELL_SIZE_MAX_CM,
                    step: 0.5,
                    format: (v) => `${v.toFixed(1)} cm`,
                    hint: 'Finer is sharper but slower to load'
                },
                {
                    kind: 'button',
                    id: 'applyCell',
                    label: 'Apply voxel size',
                    hint: 'Reloads the level'
                },
                {
                    kind: 'button',
                    id: 'resetCell',
                    label: `Reset voxel size to ${CELL_SIZE_DEFAULT_CM} cm`
                },
                {
                    kind: 'choice',
                    key: 'look',
                    label: 'Look',
                    hint: 'L',
                    options: [
                        { value: 'default', label: 'Default' },
                        { value: 'pixel', label: 'Pixel' }
                    ]
                },
                { kind: 'range', key: 'fov', label: 'Field of view', ...SETTING_RANGES.fov, format: (v) => `${v}°` },
                { kind: 'toggle', key: 'cameraBob', label: 'Camera bob & kick', hint: 'Off for less motion' },
                { kind: 'toggle', key: 'particles', label: 'Leaves & particles' }
            ]
        },
        {
            id: 'sound',
            label: 'Sound',
            rows: [
                { kind: 'range', key: 'volumeMaster', label: 'Volume', ...SETTING_RANGES.volumeMaster, format: pct },
                {
                    kind: 'range',
                    key: 'volumeEffects',
                    label: 'Effects',
                    ...SETTING_RANGES.volumeEffects,
                    format: pct,
                    hint: 'Knocks, splashes, the ute, sirens and gusts'
                },
                {
                    kind: 'range',
                    key: 'volumeAmbience',
                    label: 'Ambience',
                    ...SETTING_RANGES.volumeAmbience,
                    format: pct,
                    hint: 'The creek, wind and birds'
                }
            ]
        },
        {
            id: 'interface',
            label: 'Interface',
            rows: [
                { kind: 'range', key: 'uiScale', label: 'Text & menu size', ...SETTING_RANGES.uiScale, format: pct },
                { kind: 'toggle', key: 'controlHints', label: 'Control hints' },
                { kind: 'button', id: 'resetAll', label: 'Reset all settings' }
            ]
        }
    ]
);
menuReady = true;
const playtestPanel = new PlaytestPanel({
    text: () => playtest.text(performance.now()),
    previous: () => previousPlaytest,
    note: (t) => playtest.note(performance.now(), 'note', t),
    closed: () => menu.sync()
});

// opening it: the Settings button, Esc, Start on a pad, or losing the mouse in first person
const settingsBtn = document.createElement('button');
settingsBtn.type = 'button';
settingsBtn.className = 'online-chip settings-chip';
settingsBtn.innerHTML = '<span aria-hidden="true">⚙</span> Settings';
settingsBtn.setAttribute('aria-haspopup', 'dialog');
settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.toggle();
});
dock.insertBefore(settingsBtn, levelsBtn);
// the menu's footer shows pad buttons once a pad is in use
const padSeen = () => document.body.classList.add('has-pad');
window.addEventListener('gamepadconnected', padSeen);
pads.onMenu = (pad) => {
    padSeen();
    if (menu.open) return; // the menu reads Start itself (it closes)
    menuPadIndex = pad.index;
    menu.show();
};
document.addEventListener('pointerlockchange', () => {
    // Esc while playing: the browser releases the mouse (the key never reaches the page)
    if (!fpInput.locked && state.mode === 'firstPerson' && !menu.open && !editing) menu.show();
});

// ------------------------------------------------------------------------------------- test API

declare global {
    interface Window {
        __riverLab?: unknown;
    }
}

window.__riverLab = {
    ready: true,
    seek,
    paused: () => state.paused,
    set: (id: string, v: string | number | boolean) => host.set(id, v),
    action: (id: string) => host.action(id),
    stats: collectStats,
    async verifyGrid() {
        const w = await pipeline.query<{ vertices: number; misaligned: number }>('verify');
        return {
            vertices: w.vertices + pipeline.renderers.reduce((n, r) => n + r.verifiedVertices, 0),
            misaligned:
                w.misaligned +
                pipeline.renderers.reduce((n, r) => n + r.misalignedVertices + (r.unitsAtIdentity() ? 0 : 1), 0)
        };
    },
    dynamicHash: () => pipeline.query<number>('hash'),
    /** True when no voxel frame is in flight or waiting to be applied. */
    voxelIdle: () => !pipeline.inFlight && !state.forceVoxel,
    entities: () =>
        Object.fromEntries(
            sim.entities.map((e) => [
                e.name,
                {
                    x: e.pose.p.x,
                    y: e.pose.p.y,
                    z: e.pose.p.z,
                    yaw: Math.atan2(
                        2 * (e.pose.q.w * e.pose.q.y + e.pose.q.x * e.pose.q.z),
                        1 - 2 * (e.pose.q.y * e.pose.q.y + e.pose.q.x * e.pose.q.x)
                    ),
                    visible: e.visible
                }
            ])
        ),
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
        fpInput.carry = state.carry;
        sim.step(fpInput.command());
        sim.step(fpInput.command());
        clock.reset(sim.tick);
        state.forceVoxel = true;
    },
    /** Online co-op (tests use ?net=local, which links tabs of one browser, or ?net=p2p&relays=…). */
    net: {
        connect: () => connectP2P(),
        host: () => hostOnline(),
        games: () => (transport ? listGames(transport.lobby) : []),
        join: (code: string) => {
            const g = transport ? listGames(transport.lobby).find((x) => x.code === code) : undefined;
            return g ? joinOnline(g) : Promise.resolve();
        },
        leave: () => leaveOnline(),
        status: () => ({
            kind: transportKind,
            peers: p2p ? p2p.lobbyPeers() : null,
            p2p: p2p ? p2p.status() : null,
            hosting: hostSession?.code ?? null,
            guests: hostSession?.guestCount ?? 0,
            dropped: hostSession?.droppedSlots() ?? [],
            lag: hostSession ? [...hostSession.slots.values()].map((s) => hostSession!.lagMs(s)) : [],
            guest: guestSession
                ? {
                      code: guestSession.code,
                      slot: guestSession.slot,
                      received: guestSession.received,
                      lagMs: guestSession.lagMs,
                      reconnecting: guestSession.reconnecting
                  }
                : null
        })
    },
    /** Two-player split screen without real pads (tests); player 2 commands via input2. */
    setPlayers: (n: number) => setPlayers(n),
    input2: (c: Record<string, unknown>) => {
        p2Injected = { ...p2Injected, ...c };
    },
    look2(yaw: number, pitch: number) {
        sim.players[Math.max(1, localSlot2)].yaw = yaw;
        sim.players[Math.max(1, localSlot2)].pitch = pitch;
        p2Injected = { ...p2Injected, yaw, pitch };
    },
    /** Merges fields into the next player command (grab / throw / move edges for tests). */
    input: (c: Record<string, unknown>) => fpInput.inject(c),
    player: () => ({ ...sim.player, holding: sim.physics.heldId, eyeHeight: EYE_HEIGHT }),
    /** Puts player 1 somewhere (tests and screenshots of big levels). */
    teleport: (x: number, z: number, yaw?: number) => sim.placePlayer(x, z, yaw ?? sim.player.yaw, 0),
    /** Streamed levels: near tiles built so far. */
    nearTiles: () => pipeline.nearTiles.size,
    /** Streamed levels: whether the near world is built over a square around (x, z). */
    nearBuiltAt: (x: number, z: number, half = 3) => pipeline.nearCovers(x - half, x + half, z - half, z + half),
    level: level.id,
    progress: () => ({ ...sim.progress, events: sim.events.map((e) => e.kind), stepText: sim.stepText }),
    /** The bucket's water (Epic 7): litres in it and poured into the flower; a guest's from the host. */
    water: () => (guestSession ? { ...guestSession.water } : { volume: sim.water.volume, poured: sim.water.poured }),
    hudWater: () => document.getElementById('hud-water')?.textContent ?? '',
    /** Places a named prop at a pose (tests and the evidence capture), as a teleport. */
    placeProp(name: string, x: number, y: number, z: number, yaw = 0) {
        const e = sim.entities.find((n) => n.name === name);
        if (!e) return false;
        const q = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
        sim.physics.place(e.id, { p: { x, y, z }, q });
        return true;
    },
    interaction: () => sim.interaction(),
    /** The hazards (Epic 8): water level, phases, and the rendered water plane's height. */
    hazards: () => ({
        ...(guestSession ? guestSession.hazard : sim.hazards.net()),
        tick: sim.tick,
        floods: sim.hazards.floodCount,
        gusts: sim.hazards.gustCount,
        planeY: scene.waterEntity.getPosition().y
    }),
    /** The playtest log as text. */
    playtestLog: () => playtest.text(performance.now()),
    /** The sound: locked until a gesture, then what has played. */
    audio: () => audio.status(),
    /** Logging: each stand tree's phase and cut, and the sawmill's state and totals. */
    wood: () => ({
        trees: Array.from({ length: sim.forestry.treeCount }, (_, n) => sim.forestry.treeState(n)),
        sawmill: sim.sawmill
            ? { phase: sim.sawmill.phase, stopped: sim.sawmill.stopped, mode: sim.sawmill.mode, ...sim.sawmill.stats }
            : null
    }),
    /** The ute: where it is, which way it faces (yaw 0 = +z), its speed and who drives it (-1: nobody). */
    ute() {
        const p = sim.ute.pose;
        const q = p.q;
        return {
            x: p.p.x,
            y: p.p.y,
            z: p.p.z,
            yaw: Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x)),
            speed: sim.vehicle?.speed() ?? 0,
            driver: sim.driver,
            drivable: !!sim.vehicle
        };
    },
    /** Sets the first-person look angles (as mouse look would). */
    look(yaw: number, pitch: number) {
        fpInput.yaw = yaw;
        fpInput.pitch = pitch;
    },
    hideUi: (h: boolean) => setUiHidden(h),
    showPanel: (v: boolean) => (panel.visible = v),
    get state() {
        return { ...state };
    },
    /** The level designer, when open (`?level=custom&edit=1`). */
    get designer() {
        return designer;
    }
};

// ------------------------------------------------------------------------------------- start

if ((import.meta.env.DEV && !editing) || params.has('debug') || location.hash === '#debug') panel.visible = true;
const startAt = Number(params.get('t'));
if (Number.isFinite(startAt) && params.has('t')) seek(startAt);
let designer: Designer | null = null;
if (editing) {
    designer = new Designer(
        {
            app,
            camera,
            layer: scene.immediateLayer,
            canvas,
            rebuild: () => goToLevel('custom', { edit: '1' }),
            play: () => {
                try {
                    sessionStorage.removeItem('uncivil.design.camera');
                } catch {
                    // nothing saved
                }
                goToLevel('custom');
            },
            exit: () => goToLevel('tutorial'),
            toast: (t) => showToast(t)
        },
        loadDraft()
    );
    document.body.classList.add('designing');
    panel.visible = false;
    // edit a still world: props stay where their outlines are (Play runs it)
    setPaused(true);
    const cam = designer.savedCamera();
    const sp = level.spawn;
    const g = terrainHeight(sp.x, sp.z);
    const [px, py, pz, fx, fy, fz] = cam ? [...cam.pos, ...cam.focus] : [sp.x + 9, g + 9, sp.z + 9, sp.x, g, sp.z - 4];
    camera.setPosition(px, py, pz);
    orbit.focusPoint = new Vec3(fx, fy, fz);
    const d = designer;
    app.on('update', () => d.draw());
} else if (
    params.get('view') === 'fp' ||
    params.get('view') === 'chase' ||
    (level.startFirstPerson && params.get('view') !== 'orbit')
) {
    // no pointer lock without a user gesture (design doc §9): the first click on the canvas takes it
    setMode('firstPerson', false);
    toSpawn();
}
updateObjective();
updateWater();
if (params.has('noui')) setUiHidden(true);
updateHud();
loading?.remove();
console.info(
    `${level.name} ready at ${cellCm} cm: ${build.columns} columns, ${build.staticCells} static cells, worker build ${build.buildMs.toFixed(0)} ms + static meshes ${build.staticMeshMs.toFixed(0)} ms, upload ${staticUploadMs.toFixed(0)} ms`
);

function clamp(v: number, a: number, b: number): number {
    return Math.max(a, Math.min(b, v));
}

function nextFrame(): Promise<void> {
    return new Promise((r) => requestAnimationFrame(() => r()));
}
