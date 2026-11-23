import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import pngjs from 'pngjs';

const { PNG } = pngjs;

/**
 * The Valley's weather in a real browser (Epic 9, #88). The first test always runs: at full fog on
 * the Low preset, the sky behind the fogged-out far world is the fog colour (no outline of the far
 * landmarks against a blue sky). The screenshots of every area at Low and High (the PR's evidence,
 * docs/screenshots/epic9) run with WEATHER_SHOTS=1, as they take about half an hour in software
 * rendering: `WEATHER_SHOTS=1 npx playwright test tests/e2e/weather.spec.ts`.
 *
 * Each weather is switched on with the debug hook, which waits for the grace period like any
 * hazard: the test seeks past it first (`seek` steps the simulation without drawing).
 */

type Lab = {
    ready: boolean;
    action(id: string): void;
    seek(t: number): void;
    teleport(x: number, z: number, yaw?: number, slot?: number): void;
    setPlayers(n: number): void;
    weather(n: number): boolean;
    nearBuiltAt(x: number, z: number): boolean;
    hazards(): { weatherZone?: number; weather?: number };
};
type Apps = Map<{ scene: { fog: { end: number } } }, unknown>;

const SHOTS = process.env.WEATHER_SHOTS_DIR ?? 'test-results/weather-shots';
/** Route frame (valley.ts) to the world. */
const at = (u: number, t: number) => ({ x: -64 + (u + t) / Math.SQRT2, z: 62 + (t - u) / Math.SQRT2 });
/** valley.ts roadT, for where to stand on the road. */
function roadT(u: number): number {
    const ss = (a: number, b: number, x: number) => {
        const k = Math.max(0, Math.min(1, (x - a) / (b - a)));
        return k * k * (3 - 2 * k);
    };
    if (u > 4 && u < 82) return 2.5 * Math.sin((u - 4) * 0.07) * ss(4, 12, u) * (1 - ss(74, 82, u));
    if (u > 140 && u < 192) return 4 * Math.sin((u - 140) * 0.09) * ss(140, 148, u) * (1 - ss(184, 192, u));
    return 0;
}

const ZONES = [
    { name: 'rain', zone: 0, u: 22, fogEnd: { low: 150, high: 150 } },
    { name: 'mist', zone: 1, u: 78, fogEnd: { low: 24, high: 36 } },
    { name: 'fog', zone: 2, u: 148, fogEnd: { low: 24, high: 30 } },
    { name: 'snow', zone: 3, u: 167, fogEnd: { low: 80, high: 80 } }
] as const;

/** Boots the Valley, stands in a weather area facing up the road with that weather at full strength. */
async function inWeather(
    page: Page,
    z: (typeof ZONES)[number],
    quality: 'low' | 'high',
    t = roadT(z.u)
): Promise<void> {
    await page.addInitScript({ path: path.resolve('.claude/skills/inspect-runtime/scripts/devtools-hook.js') });
    await page.goto(`/?level=valley&quality=${quality}&noui#cell100`);
    await page.waitForFunction(() => (window as unknown as { __riverLab?: Lab }).__riverLab?.ready === true, null, {
        timeout: 200_000
    });
    await page.waitForTimeout(3000);
    // to the end of the grace period, off any weather area (the spawn), then run on
    await page.evaluate(() => (window as unknown as { __riverLab: Lab }).__riverLab.seek(19.98));
    await page.evaluate(() => (window as unknown as { __riverLab: Lab }).__riverLab.action('pause'));
    const p = at(z.u, t);
    const started = await page.evaluate(
        ({ p, n }) => {
            const l = (window as unknown as { __riverLab: Lab }).__riverLab;
            l.teleport(p.x, p.z, -Math.PI / 4);
            return l.weather(n);
        },
        { p, n: z.zone }
    );
    expect(started, `${z.name} switched on`).toBe(true);
    await page.waitForFunction((p) => (window as unknown as { __riverLab: Lab }).__riverLab.nearBuiltAt(p.x, p.z), p, {
        timeout: 300_000
    });
    // the fog eases in with the (capped) frame time: slow at software-rendering frame rates
    await page.waitForFunction(
        (end) => {
            const apps = (globalThis as unknown as { __playcanvasApps?: Apps }).__playcanvasApps;
            const app = apps ? [...apps.keys()][0] : null;
            return !!app && app.scene.fog.end < end + 0.5;
        },
        z.fogEnd[quality],
        { timeout: 400_000, polling: 1000 }
    );
    await page.waitForTimeout(3000);
    const h = await page.evaluate(() => (window as unknown as { __riverLab: Lab }).__riverLab.hazards());
    expect(h.weatherZone).toBe(z.zone);
    expect(h.weather).toBe(1);
}

/** CIE76 colour difference between two sRGB colours. */
function deltaE(a: number[], b: number[]): number {
    const lab = (c: number[]) => {
        const lin = c.map((v) => {
            const u = v / 255;
            return u > 0.04045 ? ((u + 0.055) / 1.055) ** 2.4 : u / 12.92;
        });
        const [r, g, bb] = lin;
        const X = (0.4124 * r + 0.3576 * g + 0.1805 * bb) / 0.95047;
        const Y = 0.2126 * r + 0.7152 * g + 0.0722 * bb;
        const Z = (0.0193 * r + 0.1192 * g + 0.9505 * bb) / 1.08883;
        const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
        return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
    };
    const p = lab(a);
    const q = lab(b);
    return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

test('full fog on Low: the sky is the fog colour, no outline of the far world against it', async ({ page }) => {
    test.setTimeout(900_000);
    // (on the route's centre line at u 148, facing up it: the far landmarks stand above the crest)
    await inWeather(page, ZONES[2], 'low', 0);
    const png = PNG.sync.read(await page.screenshot());
    // where the far landmarks stand above the road's crest, beyond the fog's end, from this spot
    // (before the fog's sky they showed as outlines against blue: dE about 18 from the band's median)
    const px: number[][] = [];
    for (let x = Math.round(png.width * 0.67); x < png.width * 0.79; x += 6)
        for (let y = Math.round(png.height * 0.14); y < png.height * 0.22; y += 4) {
            const o = (y * png.width + x) * 4;
            px.push([png.data[o], png.data[o + 1], png.data[o + 2]]);
        }
    const median = [0, 1, 2].map((i) => px.map((c) => c[i]).sort((a, b) => a - b)[px.length >> 1]);
    const worst = Math.max(...px.map((c) => deltaE(c, median)));
    expect(worst, `colour spread over the far landmarks: dE ${worst.toFixed(2)}`).toBeLessThan(3);
});

test('split screen at full fog: each view has its own fog sky, round its own camera, however far apart', async ({
    page
}) => {
    test.setTimeout(900_000);
    await inWeather(page, ZONES[2], 'low', 0);
    // player 2 joins on the same screen, 130 m back down the road
    const far = at(18, roadT(18));
    await page.evaluate((far) => {
        const l = (window as unknown as { __riverLab: Lab }).__riverLab;
        l.setPlayers(2);
        l.teleport(far.x, far.z, -Math.PI / 4, 1);
    }, far);
    await page.waitForTimeout(4000);
    const views = await page.evaluate(() => {
        type E = {
            enabled: boolean;
            getPosition(): { x: number; y: number; z: number };
            render?: { layers: number[] };
            camera?: { layers: number[] };
        };
        type App = {
            root: { findByName(n: string): E | null };
            scene: { layers: { getLayerById(id: number): { name: string } | null } };
        };
        const apps = (globalThis as unknown as { __playcanvasApps: Map<App, unknown> }).__playcanvasApps;
        const app = [...apps.keys()][0];
        const names = (ids: number[] = []) => ids.map((id) => app.scene.layers.getLayerById(id)?.name ?? '?');
        const pos = (n: string) => {
            const e = app.root.findByName(n)!;
            const p = e.getPosition();
            return {
                x: p.x,
                y: p.y,
                z: p.z,
                on: e.enabled,
                layers: names(e.render?.layers ?? e.camera?.layers)
            };
        };
        return {
            dome1: pos('FogDome1'),
            dome2: pos('FogDome2'),
            camera1: pos('MainCamera'),
            camera2: pos('Player2Camera')
        };
    });
    const d = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
        Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    expect(views.dome1.on).toBe(true);
    expect(views.dome2.on).toBe(true);
    expect(d(views.camera1, views.camera2), 'the two views are far apart').toBeGreaterThan(120);
    expect(d(views.dome1, views.camera1), "player 1's dome round player 1's camera").toBeLessThan(0.5);
    expect(d(views.dome2, views.camera2), "player 2's dome round player 2's camera").toBeLessThan(0.5);
    // each dome is drawn in its own view only: dome 1 on View1, dome 2 on View2, and each camera
    // draws its own view's layer and not the other's
    expect(views.dome1.layers).toEqual(['View1']);
    expect(views.dome2.layers).toEqual(['View2']);
    expect(views.camera1.layers).toContain('View1');
    expect(views.camera1.layers).not.toContain('View2');
    expect(views.camera2.layers).toContain('View2');
    expect(views.camera2.layers).not.toContain('View1');
});

for (const quality of ['low', 'high'] as const)
    for (const z of ZONES)
        test(`screenshot: ${z.name} at full strength, ${quality}`, async ({ page }) => {
            test.skip(!process.env.WEATHER_SHOTS, 'evidence screenshots: WEATHER_SHOTS=1');
            test.setTimeout(900_000);
            fs.mkdirSync(SHOTS, { recursive: true });
            await inWeather(page, z, quality);
            await page.screenshot({ path: `${SHOTS}/${z.name}-${quality}.png` });
        });
