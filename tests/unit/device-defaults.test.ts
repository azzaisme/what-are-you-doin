import { describe, expect, it } from 'vitest';

import {
    DEFAULT_SETTINGS,
    SETTINGS_STORAGE_KEY,
    deviceDefaults,
    loadChosen,
    loadSettings,
    saveSettings
} from '../../src/ui/settings-store.ts';

function memory() {
    const data = new Map<string, string>();
    return {
        data,
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, v),
        removeItem: (k: string) => void data.delete(k)
    };
}

describe('a device set to reduce motion (#21)', () => {
    it('starts with the camera bob and kick off; everything else as usual', () => {
        const reduced = deviceDefaults({ reducedMotion: true });
        expect(reduced.cameraBob).toBe(false);
        expect({ ...reduced, cameraBob: true }).toEqual(DEFAULT_SETTINGS);
        expect(deviceDefaults({ reducedMotion: false })).toEqual(DEFAULT_SETTINGS);
        expect(loadSettings(memory(), reduced).cameraBob).toBe(false);
    });

    it("keeps the player's own choice: turning the bob back on is saved and comes back", () => {
        const reduced = deviceDefaults({ reducedMotion: true });
        const s = memory();
        saveSettings(s, { ...reduced }, reduced);
        expect(s.data.has(SETTINGS_STORAGE_KEY)).toBe(false); // nothing changed from this device's defaults
        saveSettings(s, { ...reduced, cameraBob: true }, reduced);
        expect(JSON.parse(s.data.get(SETTINGS_STORAGE_KEY)!)).toEqual({ cameraBob: true });
        expect(loadSettings(s, reduced).cameraBob).toBe(true);
        // and on a device without the setting, the same saved choice is simply the default
        expect(loadSettings(s, deviceDefaults({ reducedMotion: false })).cameraBob).toBe(true);
    });
});

describe('the camera bob choice survives the system setting changing (#21 audit)', () => {
    const reduced = deviceDefaults({ reducedMotion: true });
    const normal = deviceDefaults({ reducedMotion: false });

    it('turned on with reduce motion set: still on after the setting goes off, another setting is saved, and it comes back on', () => {
        const s = memory();
        const chosen = loadChosen(s);
        // reduce motion on: the player turns the bob on
        chosen.add('cameraBob');
        saveSettings(s, { ...reduced, cameraBob: true }, reduced, chosen);
        // reduce motion off: on, the default there; the player changes the field of view
        const later = loadSettings(s, normal);
        expect(later.cameraBob).toBe(true);
        saveSettings(s, { ...later, fov: 70 }, normal, loadChosen(s));
        expect(JSON.parse(s.data.get(SETTINGS_STORAGE_KEY)!)).toEqual({ cameraBob: true, fov: 70 });
        // reduce motion on again: still the player's choice
        expect(loadSettings(s, reduced).cameraBob).toBe(true);
    });

    it('turned off then on again without reduce motion: stays on once the system asks for reduced motion', () => {
        const s = memory();
        const chosen = loadChosen(s);
        chosen.add('cameraBob');
        saveSettings(s, { ...normal, cameraBob: false }, normal, chosen);
        saveSettings(s, { ...normal, cameraBob: true }, normal, chosen); // the default here, still saved
        expect(JSON.parse(s.data.get(SETTINGS_STORAGE_KEY)!)).toEqual({ cameraBob: true });
        expect(loadChosen(s).has('cameraBob')).toBe(true);
        expect(loadSettings(s, reduced).cameraBob).toBe(true);
    });

    it('never touched: follows the device, even after other settings are saved', () => {
        const s = memory();
        saveSettings(s, { ...normal, fov: 70 }, normal, loadChosen(s));
        expect(JSON.parse(s.data.get(SETTINGS_STORAGE_KEY)!)).toEqual({ fov: 70 });
        expect(loadSettings(s, reduced).cameraBob).toBe(false);
        expect(loadSettings(s, normal).cameraBob).toBe(true);
    });

    it('only device-dependent settings are kept when equal to the default', () => {
        const s = memory();
        saveSettings(s, { ...normal }, normal, new Set(['fov', 'cameraBob']));
        expect(JSON.parse(s.data.get(SETTINGS_STORAGE_KEY)!)).toEqual({ cameraBob: true });
    });
});
