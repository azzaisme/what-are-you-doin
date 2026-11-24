/**
 * Remappable controls (#98): which keys, mouse buttons and gamepad buttons do what. Saved per browser
 * under their own storage key (only what differs from the defaults), with a reset to defaults.
 *
 * Every action has two keyboard / mouse slots and two gamepad slots. A key or button does one thing:
 * binding it to an action takes it off any other action (the caller says which, so the player knows).
 * Not remappable, so a player can always get back to the menu: Esc and Start (pad), and the sticks
 * (move and look; their sensitivity and inversion are settings).
 *
 * Keyboard codes are `KeyboardEvent.code` (the key's place, so WASD stays put on AZERTY), plus
 * `Mouse0` / `Mouse1` / `Mouse2` (left, middle, right button) and `WheelUp` / `WheelDown`.
 * Gamepad buttons are standard-mapping indices.
 */

/** Things a player does, in the order the menu lists them. */
export const ACTIONS = [
    'forward',
    'back',
    'left',
    'right',
    'sprint',
    'jump',
    'grab',
    'throw',
    'drop',
    'nail',
    'pour',
    'ragdoll',
    'plank',
    'reachFar',
    'reachNear'
] as const;
export type Action = (typeof ACTIONS)[number];

/** Actions a gamepad button can do (moving is the left stick). */
export const PAD_ACTIONS = [
    'sprint',
    'jump',
    'grab',
    'throw',
    'drop',
    'nail',
    'pour',
    'ragdoll',
    'plank',
    'reachFar',
    'reachNear'
] as const satisfies readonly Action[];
export type PadAction = (typeof PAD_ACTIONS)[number];

export const ACTION_LABELS: Record<Action, string> = {
    forward: 'Move forward',
    back: 'Move back',
    left: 'Move left',
    right: 'Move right',
    sprint: 'Run',
    jump: 'Jump',
    grab: 'Grab / release / use',
    throw: 'Throw',
    drop: 'Drop (in the ute: recover it)',
    nail: 'Nail (hammer)',
    pour: 'Pour the bucket (again: stop)',
    ragdoll: 'Launch the ragdoll',
    plank: 'Carry plank',
    reachFar: 'Hold further away',
    reachNear: 'Hold closer'
};

/** Two slots per action; '' (keys) or -1 (pad) is an empty slot. */
export type KeySlots = [string, string];
export type PadSlots = [number, number];

export interface Bindings {
    keys: Record<Action, KeySlots>;
    pad: Record<PadAction, PadSlots>;
}

/** Standard-mapping gamepad buttons. */
export const PAD_BUTTONS = {
    A: 0,
    B: 1,
    X: 2,
    Y: 3,
    LB: 4,
    RB: 5,
    LT: 6,
    RT: 7,
    VIEW: 8,
    MENU: 9,
    L3: 10,
    R3: 11,
    UP: 12,
    DOWN: 13,
    LEFT: 14,
    RIGHT: 15
} as const;
const B = PAD_BUTTONS;

const DEFAULT_KEYS: Record<Action, KeySlots> = {
    forward: ['KeyW', 'ArrowUp'],
    back: ['KeyS', 'ArrowDown'],
    left: ['KeyA', 'ArrowLeft'],
    right: ['KeyD', 'ArrowRight'],
    sprint: ['ShiftLeft', 'ShiftRight'],
    jump: ['Space', ''],
    grab: ['Mouse0', 'KeyE'],
    throw: ['Mouse2', ''],
    drop: ['KeyQ', ''],
    nail: ['KeyF', ''],
    pour: ['KeyR', ''],
    ragdoll: ['KeyT', ''],
    plank: ['KeyG', ''],
    reachFar: ['WheelUp', ''],
    reachNear: ['WheelDown', '']
};

const DEFAULT_PAD: Record<PadAction, PadSlots> = {
    sprint: [B.L3, B.LT],
    jump: [B.A, -1],
    grab: [B.RT, -1],
    throw: [B.RB, -1],
    drop: [B.B, -1],
    nail: [B.LB, -1],
    pour: [B.Y, -1],
    ragdoll: [B.X, -1],
    plank: [B.RIGHT, -1],
    reachFar: [B.UP, -1],
    reachNear: [B.DOWN, -1]
};

export function defaultBindings(): Bindings {
    const keys = {} as Record<Action, KeySlots>;
    for (const a of ACTIONS) keys[a] = [...DEFAULT_KEYS[a]];
    const pad = {} as Record<PadAction, PadSlots>;
    for (const a of PAD_ACTIONS) pad[a] = [...DEFAULT_PAD[a]];
    return { keys, pad };
}

/** Keys that stay with the game and the browser: the menu, the debug panel, browser shortcuts. */
const RESERVED_KEYS = new Set(['Escape', 'F3', 'F5', 'F11', 'F12', 'MetaLeft', 'MetaRight', 'Tab']);
/** Start opens the menu from any pad. */
const RESERVED_PAD = new Set<number>([B.MENU]);

const isCode = (v: unknown): v is string =>
    typeof v === 'string' && /^[A-Za-z0-9]{1,24}$/.test(v) && !RESERVED_KEYS.has(v);
const isButton = (v: unknown): v is number =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 32 && !RESERVED_PAD.has(v);

/** True if a key can be bound (Esc, F3, Tab and browser keys can't). */
export function bindableKey(code: string): boolean {
    return isCode(code);
}

export function bindablePadButton(i: number): boolean {
    return isButton(i);
}

/**
 * A complete, valid Bindings from anything (stored JSON, old versions, junk): unknown actions are
 * dropped, missing ones get their defaults, and a key used twice keeps only its first use.
 */
export function sanitizeBindings(raw: unknown): Bindings {
    const out = defaultBindings();
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const own = (o: unknown, k: string): unknown =>
        o && typeof o === 'object' && Object.hasOwn(o, k) ? (o as Record<string, unknown>)[k] : undefined;
    const keys = own(src, 'keys');
    const pad = own(src, 'pad');
    for (const a of ACTIONS) {
        const v = own(keys, a);
        if (Array.isArray(v)) out.keys[a] = [isCode(v[0]) ? v[0] : '', isCode(v[1]) ? v[1] : ''];
    }
    for (const a of PAD_ACTIONS) {
        const v = own(pad, a);
        if (Array.isArray(v)) out.pad[a] = [isButton(v[0]) ? v[0] : -1, isButton(v[1]) ? v[1] : -1];
    }
    // one action per key or button
    const seenK = new Set<string>();
    for (const a of ACTIONS)
        out.keys[a] = out.keys[a].map((c) => (c && seenK.has(c) ? '' : (seenK.add(c), c))) as KeySlots;
    const seenP = new Set<number>();
    for (const a of PAD_ACTIONS)
        out.pad[a] = out.pad[a].map((i) => (i >= 0 && seenP.has(i) ? -1 : (seenP.add(i), i))) as PadSlots;
    return out;
}

/**
 * Binds a key (or mouse button / wheel) to an action's slot; '' clears the slot. Returns the action
 * that lost the key, if another had it, else null.
 */
export function bindKey(b: Bindings, action: Action, slot: 0 | 1, code: string): Action | null {
    if (code && !isCode(code)) return null;
    let took: Action | null = null;
    if (code) {
        for (const a of ACTIONS) {
            const s = b.keys[a];
            for (const k of [0, 1] as const) {
                if (s[k] === code && !(a === action && k === slot)) {
                    s[k] = '';
                    if (a !== action) took = a;
                }
            }
        }
    }
    b.keys[action][slot] = code;
    return took;
}

/** Binds a gamepad button to an action's slot; -1 clears it. Returns the action that lost it, if any. */
export function bindPad(b: Bindings, action: PadAction, slot: 0 | 1, button: number): PadAction | null {
    if (button >= 0 && !isButton(button)) return null;
    let took: PadAction | null = null;
    if (button >= 0) {
        for (const a of PAD_ACTIONS) {
            const s = b.pad[a];
            for (const k of [0, 1] as const) {
                if (s[k] === button && !(a === action && k === slot)) {
                    s[k] = -1;
                    if (a !== action) took = a;
                }
            }
        }
    }
    b.pad[action][slot] = button;
    return took;
}

/** The action a key does, or null. */
export function actionForKey(b: Bindings, code: string): Action | null {
    if (!code) return null;
    for (const a of ACTIONS) if (b.keys[a][0] === code || b.keys[a][1] === code) return a;
    return null;
}

// ------------------------------------------------------------------------------------- labels

const NAMED: Record<string, string> = {
    Space: 'Space',
    ShiftLeft: 'Left Shift',
    ShiftRight: 'Right Shift',
    ControlLeft: 'Left Ctrl',
    ControlRight: 'Right Ctrl',
    AltLeft: 'Left Alt',
    AltRight: 'Right Alt',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Enter: 'Enter',
    Backspace: 'Backspace',
    CapsLock: 'Caps Lock',
    Mouse0: 'Left click',
    Mouse1: 'Middle click',
    Mouse2: 'Right click',
    Mouse3: 'Mouse 4',
    Mouse4: 'Mouse 5',
    WheelUp: 'Wheel up',
    WheelDown: 'Wheel down',
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/'
};

/** A short readable name for a key code ('KeyW' → 'W', 'Mouse0' → 'Left click'). */
export function keyLabel(code: string): string {
    if (!code) return '—';
    if (NAMED[code]) return NAMED[code];
    let m = /^Key([A-Z])$/.exec(code);
    if (m) return m[1];
    m = /^Digit([0-9])$/.exec(code);
    if (m) return m[1];
    m = /^Numpad(.+)$/.exec(code);
    if (m) return `Num ${m[1]}`;
    return code;
}

const PAD_NAMES = [
    'A',
    'B',
    'X',
    'Y',
    'LB',
    'RB',
    'LT',
    'RT',
    'View',
    'Start',
    'L3',
    'R3',
    'D-pad ↑',
    'D-pad ↓',
    'D-pad ←',
    'D-pad →'
];

export function padLabel(i: number): string {
    if (i < 0) return '—';
    return PAD_NAMES[i] ?? `Button ${i}`;
}

/** The labels of an action's bound keys ('W', 'Left click / E'), for hints and prompts. */
export function keysText(b: Bindings, action: Action): string {
    let s = b.keys[action].filter(Boolean).map(keyLabel);
    // a left / right pair reads as one key ('Left Shift' and 'Right Shift' → 'Shift')
    if (s.length === 2 && /^Left /.test(s[0]) && s[1] === s[0].replace(/^Left /, 'Right ')) s = [s[0].slice(5)];
    return s.length ? s.join(' / ') : 'unbound';
}

export function padText(b: Bindings, action: PadAction): string {
    const s = b.pad[action].filter((i) => i >= 0).map(padLabel);
    return s.length ? s.join(' / ') : 'unbound';
}

// ------------------------------------------------------------------------------------- storage

export const BINDINGS_STORAGE_KEY = 'uncivil.bindings';

interface BindingsStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

export function loadBindings(storage: BindingsStorage | null): Bindings {
    try {
        const s = storage?.getItem(BINDINGS_STORAGE_KEY);
        return sanitizeBindings(s ? JSON.parse(s) : null);
    } catch {
        return defaultBindings();
    }
}

/** Saves only the actions that differ from the defaults (a later default change still reaches players). */
export function saveBindings(storage: BindingsStorage | null, b: Bindings): void {
    const d = defaultBindings();
    const keys: Partial<Record<Action, KeySlots>> = {};
    const pad: Partial<Record<PadAction, PadSlots>> = {};
    for (const a of ACTIONS) if (b.keys[a].join() !== d.keys[a].join()) keys[a] = b.keys[a];
    for (const a of PAD_ACTIONS) if (b.pad[a].join() !== d.pad[a].join()) pad[a] = b.pad[a];
    const diff: Record<string, unknown> = {};
    if (Object.keys(keys).length) diff.keys = keys;
    if (Object.keys(pad).length) diff.pad = pad;
    try {
        if (!Object.keys(diff).length) storage?.removeItem(BINDINGS_STORAGE_KEY);
        else storage?.setItem(BINDINGS_STORAGE_KEY, JSON.stringify(diff));
    } catch {
        // storage blocked: the bindings last for this visit
    }
}
