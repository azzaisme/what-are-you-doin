import { describe, expect, it } from 'vitest';

import {
    DEFAULT_SETTINGS,
    SETTINGS_STORAGE_KEY,
    clampSetting,
    loadSettings,
    sanitizeSettings,
    saveSettings,
    urlOverrides
} from '../../src/ui/settings-store.ts';
import type { SettingsStorage } from '../../src/ui/settings-store.ts';

function memory(): SettingsStorage & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
        data,
        getItem: (k) => data.get(k) ?? null,
        setItem: (k, v) => void data.set(k, v),
        removeItem: (k) => void data.delete(k)
    };
}

describe('settings: saved per browser, safe against anything stored', () => {
    it('defaults when nothing is saved, storage is blocked or the data is bad', () => {
        expect(loadSettings(memory())).toEqual(DEFAULT_SETTINGS);
        expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS);
        const bad = memory();
        bad.setItem(SETTINGS_STORAGE_KEY, '{not json');
        expect(loadSettings(bad)).toEqual(DEFAULT_SETTINGS);
        const throws: SettingsStorage = {
            getItem: () => {
                throw new Error('blocked');
            },
            setItem: () => {
                throw new Error('blocked');
            },
            removeItem: () => {
                throw new Error('blocked');
            }
        };
        expect(loadSettings(throws)).toEqual(DEFAULT_SETTINGS);
        expect(() => saveSettings(throws, { ...DEFAULT_SETTINGS, fov: 70 })).not.toThrow();
    });

    it('saves only what differs from the defaults, and reads it back', () => {
        const m = memory();
        saveSettings(m, { ...DEFAULT_SETTINGS, fov: 70, invertPadY: true, quality: 'low' });
        expect(JSON.parse(m.data.get(SETTINGS_STORAGE_KEY)!)).toEqual({ fov: 70, invertPadY: true, quality: 'low' });
        expect(loadSettings(m)).toEqual({ ...DEFAULT_SETTINGS, fov: 70, invertPadY: true, quality: 'low' });
        // back to all defaults: nothing stored
        saveSettings(m, { ...DEFAULT_SETTINGS });
        expect(m.data.has(SETTINGS_STORAGE_KEY)).toBe(false);
    });

    it('clamps and snaps numbers, ignores wrong types and unknown keys', () => {
        expect(clampSetting('fov', 500)).toBe(100);
        expect(clampSetting('fov', -3)).toBe(40);
        expect(clampSetting('padLookSpeed', 1.2999999)).toBe(1.3);
        expect(clampSetting('uiScale', '1.24')).toBe(1.2);
        expect(clampSetting('mouseSensitivity', 'fast')).toBe(DEFAULT_SETTINGS.mouseSensitivity);
        expect(clampSetting('fov', NaN)).toBe(DEFAULT_SETTINGS.fov);
        const s = sanitizeSettings({
            fov: 'wide',
            invertMouseY: 'yes',
            quality: 'ultra',
            look: 'pixel',
            uiScale: 9,
            hacked: true,
            __proto__: { cameraBob: false }
        });
        expect(s.fov).toBe(DEFAULT_SETTINGS.fov);
        expect(s.invertMouseY).toBe(false);
        expect(s.quality).toBe('high');
        expect(s.look).toBe('pixel');
        expect(s.uiScale).toBe(1.6);
        expect(s.cameraBob).toBe(true);
        expect(Object.keys(s).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
        expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
        expect(sanitizeSettings([1, 2])).toEqual(DEFAULT_SETTINGS);
    });

    it('URL parameters override for one visit', () => {
        expect(urlOverrides(new URLSearchParams(''))).toEqual({});
        expect(urlOverrides(new URLSearchParams('quality=low&look=pixel&bob=off&view=chase'))).toEqual({
            quality: 'low',
            look: 'pixel',
            cameraBob: false,
            overShoulder: true
        });
        expect(urlOverrides(new URLSearchParams('quality=ultra&look=x&view=fp'))).toEqual({});
    });
});
