/**
 * Player settings: what the settings menu changes, saved in local storage per browser. URL
 * parameters (?quality=, ?look=, ?bob=, ?view=, ?sound=off) still win for that visit, so test and share links
 * keep working, but they are not saved.
 *
 * The voxel size is a setting too, but it keeps its own storage key and URL hash (see
 * voxels/grid.ts): it is read before anything is built.
 */

export interface Settings {
    /** Mouse look (milliradians per pixel). */
    mouseSensitivity: number;
    invertMouseY: boolean;
    /** Gamepad look speed (times the default). */
    padLookSpeed: number;
    invertPadY: boolean;
    /** Touch look speed (times the default). */
    touchLookSpeed: number;
    /** Vertical field of view (degrees). */
    fov: number;
    quality: 'high' | 'low';
    look: 'default' | 'pixel';
    /** Camera bob and kick from walking, grabbing and throwing. */
    cameraBob: boolean;
    /** Falling leaves and voxel particles. */
    particles: boolean;
    /** First person: watch yourself from over the shoulder. */
    overShoulder: boolean;
    /** Size of the menus and HUD text (times the default). */
    uiScale: number;
    /** Control hints at the top of the screen. */
    controlHints: boolean;
    /** Sound: everything, effects (impacts, steps, the ute, the hazards' tells), ambience (creek, wind, birds). */
    volumeMaster: number;
    volumeEffects: number;
    volumeAmbience: number;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
    mouseSensitivity: 2.2,
    invertMouseY: false,
    padLookSpeed: 1,
    invertPadY: false,
    touchLookSpeed: 1,
    fov: 52,
    quality: 'high',
    look: 'default',
    cameraBob: true,
    particles: true,
    overShoulder: false,
    uiScale: 1,
    controlHints: true,
    volumeMaster: 0.8,
    volumeEffects: 1,
    volumeAmbience: 0.7
});

/** Ranges for the numeric settings (min, max, step). */
export const SETTING_RANGES = {
    mouseSensitivity: { min: 0.5, max: 6, step: 0.1 },
    padLookSpeed: { min: 0.3, max: 3, step: 0.1 },
    touchLookSpeed: { min: 0.3, max: 3, step: 0.1 },
    fov: { min: 40, max: 100, step: 1 },
    uiScale: { min: 0.8, max: 1.6, step: 0.1 },
    volumeMaster: { min: 0, max: 1, step: 0.05 },
    volumeEffects: { min: 0, max: 1, step: 0.05 },
    volumeAmbience: { min: 0, max: 1, step: 0.05 }
} as const satisfies Partial<Record<keyof Settings, { min: number; max: number; step: number }>>;

export const SETTINGS_STORAGE_KEY = 'uncivil.settings';

type NumberKey = keyof typeof SETTING_RANGES;
const isNumberKey = (k: string): k is NumberKey => k in SETTING_RANGES;

/** Snaps to the step and clamps to the range; non-numbers become the default. */
export function clampSetting(key: NumberKey, v: unknown): number {
    const r = SETTING_RANGES[key];
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    if (!Number.isFinite(n)) return DEFAULT_SETTINGS[key];
    const snapped = Math.round((n - r.min) / r.step) * r.step + r.min;
    // keep the decimals of the step (0.1 steps print as 1.3, not 1.3000000000000003)
    const decimals = String(r.step).split('.')[1]?.length ?? 0;
    return Number(Math.max(r.min, Math.min(r.max, snapped)).toFixed(decimals));
}

/** A complete, valid Settings from anything (stored JSON, old versions, junk). */
export function sanitizeSettings(raw: unknown): Settings {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const out: Settings = { ...DEFAULT_SETTINGS };
    for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
        // own properties only: nothing inherited from a prototype counts
        if (!Object.hasOwn(src, k)) continue;
        const v = src[k];
        if (isNumberKey(k)) out[k] = clampSetting(k, v);
        else if (typeof DEFAULT_SETTINGS[k] === 'boolean') {
            if (typeof v === 'boolean') (out[k] as boolean) = v;
        }
    }
    const own = (k: string) => (Object.hasOwn(src, k) ? src[k] : undefined);
    const q = own('quality');
    if (q === 'low' || q === 'high') out.quality = q;
    const look = own('look');
    if (look === 'pixel' || look === 'default') out.look = look;
    return out;
}

/** The minimal storage interface (localStorage, or a stand-in in tests). */
export interface SettingsStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

/** Saved settings; defaults when nothing is saved, storage is blocked or the data is bad. */
export function loadSettings(storage: SettingsStorage | null): Settings {
    try {
        const s = storage?.getItem(SETTINGS_STORAGE_KEY);
        return sanitizeSettings(s ? JSON.parse(s) : null);
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

/** Saves only what differs from the defaults, so a later default change still reaches players. */
export function saveSettings(storage: SettingsStorage | null, s: Settings): void {
    const diff: Partial<Record<keyof Settings, unknown>> = {};
    for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[])
        if (s[k] !== DEFAULT_SETTINGS[k]) diff[k] = s[k];
    try {
        if (Object.keys(diff).length === 0) storage?.removeItem(SETTINGS_STORAGE_KEY);
        else storage?.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(diff));
    } catch {
        // storage blocked: the settings last for this visit
    }
}

/** URL parameters that override settings for one visit (not saved). */
export function urlOverrides(params: URLSearchParams): Partial<Settings> {
    const o: Partial<Settings> = {};
    const q = params.get('quality');
    if (q === 'low' || q === 'high') o.quality = q;
    const look = params.get('look');
    if (look === 'pixel' || look === 'default') o.look = look;
    if (params.get('bob') === 'off') o.cameraBob = false;
    if (params.get('sound') === 'off') o.volumeMaster = 0;
    const view = params.get('view');
    if (view === 'chase' || view === 'side') o.overShoulder = true;
    return o;
}
