/**
 * Split screen for up to four local players (#22, #100): one world, one simulation, a view per
 * player. Two views are top and bottom; three are player 1 across the top and players 2 and 3 below;
 * four are quarters. Every view draws its own lit scene, each player's crosshair, prompt and label
 * sit in their part of the screen, and each player moves on their own commands.
 */

import path from 'node:path';

import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';

type Rect = { x: number; y: number; w: number; h: number };
type Lab = {
    ready: boolean;
    action(id: string): void;
    setPlayers(n: number): void;
    look(yaw: number, pitch: number): void;
    lookView(v: number, yaw: number, pitch: number): void;
    inputView(v: number, c: Record<string, unknown>): void;
    views(): { slots: number[]; rects: Rect[]; shadows: { cast: boolean; cascades: number } };
    entities(): Record<string, { x: number; z: number; visible: boolean }>;
    stats(): { voxel: { objects: number; rejected: number } };
    seek(t: number): void;
    teleport(x: number, z: number, yaw?: number, slot?: number): void;
    weather(n: number): boolean;
    nearBuiltAt(x: number, z: number): boolean;
    teleportView(v: number, x: number, z: number, yaw?: number): void;
    player(): { x: number; y: number; z: number; eyeHeight: number };
    placeProp(id: string, x: number, y: number, z: number, yaw: number): void;
    showNailOutlines(on: boolean): void;
    joints(): { outlines: number[][]; viewLayers: string[][] };
};

const IGNORED = [
    /GPU stall due to ReadPixels/,
    /GL Driver Message/,
    /Powered by PlayCanvas/,
    /favicon/i,
    /status of 404/
];

async function boot(page: Page, query: string): Promise<string[]> {
    const problems: string[] = [];
    page.on('console', (m) => {
        if ((m.type() === 'error' || m.type() === 'warning') && !IGNORED.some((r) => r.test(m.text())))
            problems.push(`${m.type()}: ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await page.goto(`/${query}`);
    await page.waitForFunction(() => (window as unknown as { __riverLab?: Lab }).__riverLab?.ready === true, null, {
        timeout: 150_000
    });
    return problems;
}

const lab = <T>(page: Page, fn: (l: Lab) => T) =>
    page.evaluate(
        (src) => new Function('l', `return (${src})(l)`)((window as unknown as { __riverLab: Lab }).__riverLab),
        fn.toString()
    ) as Promise<T>;

/** Mean brightness (0-255) of a screen region given as fractions, sampled every 6 px. */
function brightness(png: PNG, r: Rect): number {
    let sum = 0;
    let n = 0;
    const x0 = Math.floor(r.x * png.width) + 4;
    const x1 = Math.floor((r.x + r.w) * png.width) - 4;
    const y0 = Math.floor(r.y * png.height) + 4;
    const y1 = Math.floor((r.y + r.h) * png.height) - 4;
    for (let y = y0; y < y1; y += 6)
        for (let x = x0; x < x1; x += 6) {
            const i = (y * png.width + x) * 4;
            sum += (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3;
            n++;
        }
    return sum / n;
}

/** Where each visible crosshair and player label is (pixel centres / boxes). */
const hud = (page: Page) =>
    page.evaluate(() => {
        const vis = (e: Element) => getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0;
        const crosshairs = [...document.querySelectorAll('.crosshair')].filter(vis).map((e) => {
            const b = e.getBoundingClientRect();
            return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
        });
        const tags = [...document.querySelectorAll('.player-tag')].filter(vis).map((e) => {
            const b = e.getBoundingClientRect();
            return { text: e.textContent, left: b.left, right: b.right, top: b.top, bottom: b.bottom };
        });
        return { crosshairs, tags, w: innerWidth, h: innerHeight };
    });

test('split screen for four, then three: every view draws, every HUD sits in its view, every player moves on their own', async ({
    page
}) => {
    test.setTimeout(900_000);
    const problems = await boot(page, '?level=yard&t=0.01&quality=low#cell100');
    await lab(page, (l) => l.action('pause')); // play live
    // the sun's shadows on Low (two cascades) stay as they are for one and two views...
    expect((await lab(page, (l) => l.views())).shadows).toEqual({ cast: true, cascades: 2 });
    await lab(page, (l) => l.setPlayers(2));
    expect((await lab(page, (l) => l.views())).shadows).toEqual({ cast: true, cascades: 2 });
    await lab(page, (l) => l.setPlayers(4));
    const v4 = await lab(page, (l) => l.views());
    // ...and go off for four (the engine draws them again for every view)
    expect(v4.shadows.cast).toBe(false);
    expect(v4.slots.length).toBe(4);
    expect(new Set(v4.slots).size).toBe(4);
    // four quarters
    expect(v4.rects).toEqual([
        { x: 0, y: 0, w: 0.5, h: 0.5 },
        { x: 0.5, y: 0, w: 0.5, h: 0.5 },
        { x: 0, y: 0.5, w: 0.5, h: 0.5 },
        { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }
    ]);
    // everyone looks a different way
    await lab(page, (l) => {
        l.look(0, -0.1);
        l.lookView(1, 1.57, -0.1);
        l.lookView(2, 3.14, -0.1);
        l.lookView(3, -1.57, 0.2);
    });
    // four beaver bodies in the voxel world: the yard's 31 plus one per player
    await page.waitForFunction(
        () => (window as unknown as { __riverLab: Lab }).__riverLab.stats().voxel.objects === 35,
        null,
        {
            timeout: 120_000
        }
    );
    await page.waitForTimeout(3000);
    let png = PNG.sync.read(await page.screenshot());
    const lit = v4.rects.map((r) => brightness(png, r));
    // every quarter draws a lit scene (a view left out of the split stays black)...
    for (const [v, b] of lit.entries()) expect(b, `view ${v + 1} brightness`).toBeGreaterThan(30);
    // ...and they are four different views
    for (let a = 0; a < 4; a++)
        for (let b = a + 1; b < 4; b++)
            expect(Math.abs(lit[a] - lit[b]), `views ${a + 1} and ${b + 1} differ`).toBeGreaterThan(0.5);
    // each player's crosshair at their quarter's centre, their label in their quarter
    let h = await hud(page);
    expect(h.crosshairs.length).toBe(4);
    for (const [v, r] of v4.rects.entries()) {
        const cx = (r.x + r.w / 2) * h.w;
        const cy = (r.y + r.h / 2) * h.h;
        expect(
            h.crosshairs.some((c) => Math.abs(c.x - cx) < 4 && Math.abs(c.y - cy) < 4),
            `crosshair ${v + 1}`
        ).toBe(true);
        const tag = h.tags.find((t) => t.text === `P${v + 1}`)!;
        expect(tag, `label P${v + 1}`).toBeDefined();
        expect(tag.left >= r.x * h.w && tag.right <= (r.x + r.w) * h.w + 1, `P${v + 1} inside its view`).toBe(true);
        expect(tag.top >= r.y * h.h && tag.bottom <= (r.y + r.h) * h.h + 1, `P${v + 1} inside its view`).toBe(true);
    }

    // players 2, 3 and 4 each walk on their own commands; the others stay where they are
    for (let v = 1; v < 4; v++) {
        const slot = v4.slots[v];
        const name = `avatar-${slot}`;
        const start = await lab(page, (l) => l.entities());
        let moved = 0;
        for (let i = 0; i < 240 && moved <= 0.3; i++) {
            await page.evaluate(
                ([vv]) =>
                    (window as unknown as { __riverLab: Lab }).__riverLab.inputView(vv, {
                        moveZ: 1,
                        yaw: [0, 1.57, 3.14, -1.57][vv]
                    }),
                [v]
            );
            await page.waitForTimeout(200);
            const now = (await lab(page, (l) => l.entities()))[name];
            moved = Math.hypot(now.x - start[name].x, now.z - start[name].z);
        }
        expect(moved, `player ${v + 1} walked`).toBeGreaterThan(0.3);
        const end = await lab(page, (l) => l.entities());
        for (const [w, other] of v4.slots.entries()) {
            if (w === v || w === 0) continue;
            const o = `avatar-${other}`;
            expect(Math.hypot(end[o].x - start[o].x, end[o].z - start[o].z), `player ${w + 1} stayed`).toBeLessThan(
                0.15
            );
        }
    }

    // three players: player 1 across the top, players 2 and 3 below; player 4's body goes
    await lab(page, (l) => l.setPlayers(3));
    const v3 = await lab(page, (l) => l.views());
    expect(v3.slots).toEqual(v4.slots.slice(0, 3));
    // three views: one shadow cascade
    expect(v3.shadows).toEqual({ cast: true, cascades: 1 });
    expect(v3.rects).toEqual([
        { x: 0, y: 0, w: 1, h: 0.5 },
        { x: 0, y: 0.5, w: 0.5, h: 0.5 },
        { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }
    ]);
    await page.waitForFunction(
        () => (window as unknown as { __riverLab: Lab }).__riverLab.stats().voxel.objects === 34,
        null,
        {
            timeout: 120_000
        }
    );
    await page.waitForTimeout(2000);
    png = PNG.sync.read(await page.screenshot());
    for (const [v, r] of v3.rects.entries()) expect(brightness(png, r), `3 views: view ${v + 1}`).toBeGreaterThan(30);
    h = await hud(page);
    expect(h.crosshairs.length).toBe(3);
    expect(h.tags.map((t) => t.text).sort()).toEqual(['P1', 'P2', 'P3']);

    // back to one: one full view, the other bodies gone
    await lab(page, (l) => l.setPlayers(1));
    await page.waitForFunction(
        () => (window as unknown as { __riverLab: Lab }).__riverLab.stats().voxel.objects === 32,
        null,
        {
            timeout: 120_000
        }
    );
    expect((await lab(page, (l) => l.views())).shadows).toEqual({ cast: true, cascades: 2 });
    h = await hud(page);
    expect(h.crosshairs.length).toBe(1);
    expect(h.tags.length).toBe(0);
    expect((await lab(page, (l) => l.stats())).voxel.rejected).toBe(0);
    expect(problems).toEqual([]);
});

test("four views: a player's hammer outline shows in that player's quarter only", async ({ page }) => {
    test.setTimeout(600_000);
    const problems = await boot(page, '?level=yard&t=0.01&quality=low&noui#cell100');
    await lab(page, (l) => l.action('pause'));
    await lab(page, (l) => l.setPlayers(4));
    const { slots, rects } = await lab(page, (l) => l.views());
    // player 3 (view 2, bottom left) stands over a beam on the ground and looks down at it; the
    // others look at the same beam from 3 m and more away (out of hammer reach), so an outline
    // shared between views would show in theirs
    const p0 = await lab(page, (l) => l.player());
    await page.evaluate(
        ([x, y, z, eye]) => {
            const l = (window as unknown as { __riverLab: Lab }).__riverLab;
            l.placeProp('beam-0', x + 3, y + 0.3, z - 0.6, 0);
            l.look(Math.atan2(-3, 0.6), -Math.atan2(eye - 0.2, Math.hypot(3, 0.6)));
            l.teleportView(1, x + 6, z - 0.6, 0);
            l.lookView(1, Math.PI / 2, -0.2);
            l.teleportView(2, x + 3, z, 0);
            l.lookView(2, 0, -Math.atan2(eye - 0.2, 0.55));
            l.teleportView(3, x + 3, z - 4.6, 0);
            l.lookView(3, Math.PI, -0.2);
        },
        [p0.x, p0.y, p0.z, p0.eyeHeight]
    );
    await page.waitForFunction(
        (s3) => {
            const o = (window as unknown as { __riverLab: Lab }).__riverLab.joints().outlines;
            return o.length === 4 && o[2].length === 1 && o[2][0] === s3;
        },
        slots[2],
        { timeout: 120_000 }
    );
    const j = await lab(page, (l) => l.joints());
    expect(j.outlines).toEqual([[], [], [slots[2]], []]);
    // each camera draws its own view's layer and no other
    expect(j.viewLayers).toEqual([['View1'], ['View2'], ['View3'], ['View4']]);
    // on screen: the pixels that change with the outline (the same in every shot with it and in
    // every shot without, and different between) are all in player 3's quarter
    // with the world paused (still drawing), so animated things don't change between shots
    await lab(page, (l) => l.action('pause'));
    await page.waitForTimeout(1500);
    const shots: PNG[] = [];
    for (const [on, frames] of [
        [true, 3],
        [false, 5],
        [true, 4],
        [false, 7],
        [true, 6]
    ] as const) {
        await page.evaluate(
            async ([v, k]) => {
                (window as unknown as { __riverLab: Lab }).__riverLab.showNailOutlines(v as boolean);
                for (let f = 0; f < (k as number); f++) await new Promise((r) => requestAnimationFrame(r));
            },
            [on, frames]
        );
        shots.push(PNG.sync.read(await page.screenshot()));
    }
    const { width: w, height: h } = shots[0];
    const ons = [shots[0], shots[2], shots[4]];
    const offs = [shots[1], shots[3]];
    // a channel-wise difference: the software renderer jitters some far pixels by one step between
    // frames, while an outline is a full-colour line, so "changed" means by more than 8 levels in
    // some channel with every shot on (and every shot off) within 2 of each other
    const diff = (a: PNG, b: PNG, i: number) =>
        Math.max(
            Math.abs(a.data[i] - b.data[i]),
            Math.abs(a.data[i + 1] - b.data[i + 1]),
            Math.abs(a.data[i + 2] - b.data[i + 2])
        );
    const inView = [0, 0, 0, 0];
    let outside = 0;
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            if (diff(ons[0], offs[0], i) <= 8) continue;
            if (ons.some((p) => diff(p, ons[0], i) > 2) || offs.some((p) => diff(p, offs[0], i) > 2)) continue;
            const v = rects.findIndex(
                (r) => x >= r.x * w && x < (r.x + r.w) * w && y >= r.y * h && y < (r.y + r.h) * h
            );
            if (v >= 0) inView[v]++;
            else outside++;
        }
    expect(inView[2], "outline pixels in player 3's quarter").toBeGreaterThan(20);
    expect([inView[0], inView[1], inView[3], outside], 'outline pixels anywhere else').toEqual([0, 0, 0, 0]);
    expect(problems).toEqual([]);
});

/** Route frame (valley.ts) to the world, as in weather.spec.ts. */
const valleyAt = (u: number, t: number) => ({ x: -64 + (u + t) / Math.SQRT2, z: 62 + (t - u) / Math.SQRT2 });

test('four views at full fog: each view has its own fog sky, round its own camera, on its own layer only', async ({
    page
}) => {
    test.setTimeout(900_000);
    await page.addInitScript({ path: path.resolve('.claude/skills/inspect-runtime/scripts/devtools-hook.js') });
    const problems = await boot(page, '?level=valley&quality=low&noui#cell100');
    await page.waitForTimeout(3000);
    // past the hazards' grace period, then the fog area (zone 2) at full strength
    await lab(page, (l) => l.seek(19.98));
    await lab(page, (l) => l.action('pause'));
    const fog = valleyAt(148, 0);
    expect(
        await page.evaluate((p) => {
            const l = (window as unknown as { __riverLab: Lab }).__riverLab;
            l.teleport(p.x, p.z, -Math.PI / 4);
            return l.weather(2);
        }, fog)
    ).toBe(true);
    await page.waitForFunction(
        (p) => (window as unknown as { __riverLab: Lab }).__riverLab.nearBuiltAt(p.x, p.z),
        fog,
        {
            timeout: 300_000
        }
    );
    // three more players, spread far back down the road (the road is straight at these points)
    await lab(page, (l) => l.setPlayers(4));
    const spots = [100, 60, 30].map((u) => valleyAt(u, 0));
    await page.evaluate((spots) => {
        const l = (window as unknown as { __riverLab: Lab }).__riverLab;
        spots.forEach((p, i) => l.teleportView(i + 1, p.x, p.z, -Math.PI / 4));
    }, spots);
    type Apps = Map<{ scene: { fog: { end: number } } }, unknown>;
    await page.waitForFunction(
        () => {
            const apps = (globalThis as unknown as { __playcanvasApps?: Apps }).__playcanvasApps;
            const app = apps ? [...apps.keys()][0] : null;
            return !!app && app.scene.fog.end < 24.5;
        },
        null,
        { timeout: 400_000, polling: 1000 }
    );
    await page.waitForTimeout(3000);
    const views = await page.evaluate(() => {
        type E = {
            enabled: boolean;
            getPosition(): { x: number; y: number; z: number };
            render?: { layers: number[] };
            camera?: { layers: number[] };
        };
        type App = {
            root: { findByName(n: string): E | null };
            scene: { layers: { getLayerByName(n: string): { id: number } | null } };
        };
        const apps = (globalThis as unknown as { __playcanvasApps: Map<App, unknown> }).__playcanvasApps;
        const app = [...apps.keys()][0];
        const viewIds = [1, 2, 3, 4].map((v) => app.scene.layers.getLayerByName(`View${v}`)!.id);
        const named = (id: number) => viewIds.indexOf(id);
        return [0, 1, 2, 3].map((v) => {
            const dome = app.root.findByName(`FogDome${v + 1}`)!;
            const cam = app.root.findByName(v === 0 ? 'MainCamera' : `Player${v + 1}Camera`)!;
            const d = dome.getPosition();
            const c = cam.getPosition();
            return {
                on: dome.enabled,
                fromCamera: Math.hypot(d.x - c.x, d.y - c.y, d.z - c.z),
                camera: { x: c.x, z: c.z },
                // the view layers the dome draws in, and the ones its camera draws
                domeViews: dome.render!.layers.map(named),
                cameraViews: cam.camera!.layers.map(named).filter((i) => i >= 0)
            };
        });
    });
    for (const [v, s] of views.entries()) {
        expect(s.on, `dome ${v + 1} on`).toBe(true);
        expect(s.fromCamera, `dome ${v + 1} round camera ${v + 1}`).toBeLessThan(0.5);
        expect(s.domeViews, `dome ${v + 1} only on View${v + 1}`).toEqual([v]);
        expect(s.cameraViews, `camera ${v + 1} draws View${v + 1} only`).toEqual([v]);
    }
    for (let a = 0; a < 4; a++)
        for (let b = a + 1; b < 4; b++)
            expect(
                Math.hypot(views[a].camera.x - views[b].camera.x, views[a].camera.z - views[b].camera.z),
                `views ${a + 1} and ${b + 1} apart`
            ).toBeGreaterThan(25);
    expect(problems).toEqual([]);
});
