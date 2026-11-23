import { describe, expect, it } from 'vitest';

import {
    DEFAULT_SETTINGS,
    SETTINGS_STORAGE_KEY,
    deviceDefaults,
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
