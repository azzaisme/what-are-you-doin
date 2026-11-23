/**
 * Split screen for up to four local players (#22, #100): one world, one simulation, a view per
 * player. Two views are top and bottom; three are player 1 across the top and players 2 and 3 below;
 * four are quarters. Every view draws its own lit scene, each player's crosshair, prompt and label
 * sit in their part of the screen, and each player moves on their own commands.
 */

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
    views(): { slots: number[]; rects: Rect[] };
    entities(): Record<string, { x: number; z: number; visible: boolean }>;
    stats(): { voxel: { objects: number; rejected: number } };
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
        const vis = (e: Element) => getComputedStyle(e).display !== 'none' && (e as HTMLElement).offsetParent !== null;
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
    const problems = await boot(page, '?level=yard&t=0.01&quality=low&noui#cell100');
    await lab(page, (l) => l.action('pause')); // play live
    await lab(page, (l) => l.setPlayers(4));
    const v4 = await lab(page, (l) => l.views());
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
    h = await hud(page);
    expect(h.crosshairs.length).toBe(1);
    expect(h.tags.length).toBe(0);
    expect((await lab(page, (l) => l.stats())).voxel.rejected).toBe(0);
    expect(problems).toEqual([]);
});
