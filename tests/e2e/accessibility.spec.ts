/**
 * Input and accessibility (#21): text size reaches every HUD and menu and keeps them on screen; less
 * motion (the system setting or the switch) holds the camera steady and stills the UI; the field of
 * view setting is the camera's; and clicking a menu never grabs the timber under the crosshair.
 */

import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

type Lab = {
    ready: boolean;
    action(id: string): void;
    paused(): boolean;
    player(): {
        x: number;
        y: number;
        z: number;
        yaw: number;
        holding: number;
        eyeHeight: number;
        walkDist: number;
        fallTicks: number;
        grounded: boolean;
    };
    teleport(x: number, z: number, yaw?: number): void;
    setPlayers(n: number): void;
    teleport2(x: number, z: number, yaw: number): void;
    look2(yaw: number, pitch: number): void;
    placeProp(name: string, x: number, y: number, z: number, yaw?: number): boolean;
    interaction(): { holding: string | null; target: string | null };
    look(yaw: number, pitch: number): void;
    cameraFov(): number;
    cameraFeel(): { dx: number; dy: number; dz: number; pitch: number; roll: number };
    state: { cameraFeel: boolean };
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
    await ready(page);
    return problems;
}

const ready = (page: Page) =>
    page.waitForFunction(() => (window as unknown as { __riverLab?: Lab }).__riverLab?.ready === true, null, {
        timeout: 150_000
    });

const lab = <T>(page: Page, fn: (l: Lab) => T) =>
    page.evaluate(
        (src) => new Function('l', `return (${src})(l)`)((window as unknown as { __riverLab: Lab }).__riverLab),
        fn.toString()
    ) as Promise<T>;

/**
 * Every visible element that shows text of its own, with its effective zoom (Element.currentCSSZoom)
 * and whether it lies inside the viewport. The developer's debug panel is left out (not player UI).
 */
/**
 * Walks forward (W held) from a spot on clear flat ground until the beaver has walked `metres`
 * (its walked distance, as the walking animation counts it), sampling the camera's bob and kick
 * every frame. Fails if it is blocked (no progress for 5 s), falls, or the ground isn't flat.
 */
async function walkAndFeel(
    page: Page,
    from: { x: number; z: number },
    metres: number
): Promise<{ walked: number; most: number; rise: number; frames: number }> {
    await lab(page, (l) => l.look(0, 0));
    await page.evaluate(
        ([x, z]) => (window as unknown as { __riverLab: Lab }).__riverLab.teleport(x, z, 0),
        [from.x, from.z]
    );
    await page.waitForTimeout(500);
    const start = await lab(page, (l) => l.player());
    await page.keyboard.down('KeyW');
    let most = 0;
    let rise = 0;
    let walked = 0;
    let frames = 0;
    let lastProgress = Date.now();
    try {
        while (walked < metres) {
            await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
            frames++;
            const [f, p] = await page.evaluate(() => {
                const l = (window as unknown as { __riverLab: Lab }).__riverLab;
                return [l.cameraFeel(), l.player()] as const;
            });
            most = Math.max(most, Math.abs(f.dx), Math.abs(f.dy), Math.abs(f.dz), Math.abs(f.pitch), Math.abs(f.roll));
            rise = Math.max(rise, Math.abs(p.y - start.y));
            expect(p.fallTicks, 'not falling').toBe(0);
            if (p.walkDist - start.walkDist > walked + 0.01) lastProgress = Date.now();
            walked = Math.max(walked, p.walkDist - start.walkDist);
            expect(Date.now() - lastProgress, `blocked after ${walked.toFixed(2)} m`).toBeLessThan(5000);
        }
    } finally {
        await page.keyboard.up('KeyW');
    }
    return { walked, most, rise, frames };
}

const texts = (page: Page) =>
    page.evaluate(() => {
        const out: { what: string; zoom: number; inside: boolean }[] = [];
        for (const el of document.querySelectorAll<HTMLElement>('body *')) {
            if (el.closest('.debug-panel, .debug-chip, script, style, canvas')) continue;
            const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim() !== '');
            if (!own) continue;
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden' || el.closest('[hidden]')) continue;
            // text scrolled inside a scrolling panel (or the scrolling row of section tabs) counts when
            // that panel is on screen
            const box = (
                el.closest('.settings-panel, .settings-tabs, .online-panel, .credits, .playtest') ?? el
            ).getBoundingClientRect();
            out.push({
                what: `${el.tagName.toLowerCase()}.${el.className} "${el.textContent!.trim().slice(0, 24)}"`,
                zoom: (el as unknown as { currentCSSZoom: number }).currentCSSZoom,
                inside:
                    box.left >= -0.5 &&
                    box.top >= -0.5 &&
                    box.right <= innerWidth + 0.5 &&
                    box.bottom <= innerHeight + 0.5
            });
        }
        return out;
    });

/**
 * Text cut off: an element that hides or scrolls what overflows it sideways and is wider inside than
 * out (a key name cut to an ellipsis, a panel that scrolls sideways). The row of section tabs is
 * left out: it scrolls sideways by design, each tab keeping its whole name.
 */
const clipped = (page: Page) =>
    page.evaluate(() => {
        const out: string[] = [];
        for (const el of document.querySelectorAll<HTMLElement>('body *')) {
            if (el.closest('.debug-panel, .debug-chip, script, style, canvas, .settings-tabs')) continue;
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden') continue;
            if (cs.overflowX === 'visible' && cs.textOverflow !== 'ellipsis') continue;
            if (el.scrollWidth > el.clientWidth + 1)
                out.push(
                    `${el.tagName.toLowerCase()}.${el.className} "${el.textContent!.trim().slice(0, 24)}" ${el.scrollWidth} > ${el.clientWidth}`
                );
        }
        return out;
    });

/** Each action prompt shown that overlaps the HUD's other text, the dock or the other prompt. */
const promptsCovered = (page: Page) =>
    page.evaluate(() => {
        const box = (e: Element) => e.getBoundingClientRect();
        const hit = (a: DOMRect, b: DOMRect) =>
            a.width > 0 && b.width > 0 && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        const prompts = [...document.querySelectorAll<HTMLElement>('.hud-prompt')].filter(
            (e) => e.textContent!.trim() !== '' && getComputedStyle(e).display !== 'none'
        );
        const others = [...document.querySelectorAll('.hud > :not(.hud-prompt), .ui-dock > *')];
        const out: string[] = [];
        for (const p of prompts) {
            for (const o of [...others, ...prompts.filter((q) => q !== p)])
                if (hit(box(p), box(o))) out.push(`${p.className} over ${o.className}`);
        }
        return out;
    });

test('text size 160 %: every HUD and menu text is 1.6× and stays on screen, phone and desktop', async ({ page }) => {
    test.setTimeout(600_000);
    await page.addInitScript(() => localStorage.setItem('uncivil.settings', JSON.stringify({ uiScale: 1.6 })));
    // (the local test transport: the online panel opens without reaching for the public relays)
    const problems = await boot(page, '?level=yard&t=1&quality=low&net=local#cell100');
    const check = async (label: string) => {
        const t = await texts(page);
        expect(t.length, `${label}: some text`).toBeGreaterThan(3);
        const wrong = t.filter((x) => Math.abs(x.zoom - 1.6) > 0.01).map((x) => `${x.what} zoom ${x.zoom}`);
        expect(wrong, `${label}: text not at 160 %`).toEqual([]);
        const off = t.filter((x) => !x.inside).map((x) => x.what);
        expect(off, `${label}: text off screen`).toEqual([]);
        expect(await clipped(page), `${label}: text cut off or scrolled sideways`).toEqual([]);
        expect(await promptsCovered(page), `${label}: an action prompt over other text or the dock`).toEqual([]);
    };
    for (const [w, h] of [
        [390, 844],
        [1280, 720]
    ]) {
        await page.setViewportSize({ width: w, height: h });
        await page.waitForTimeout(500);
        await check(`${w}x${h} HUD`);
        // the HUD and the dock never overlap
        const overlap = await page.evaluate(() => {
            const range = document.createRange();
            range.selectNodeContents(document.querySelector('.hud')!);
            const a = range.getBoundingClientRect();
            const b = document.querySelector('.ui-dock')!.getBoundingClientRect();
            return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        });
        expect(overlap, `${w}x${h}: HUD over the dock`).toBe(false);
        // every section of the settings menu
        await page.locator('.settings-chip').click();
        for (const tab of await page.locator('.settings-tabs button').allTextContents()) {
            await page.locator('.settings-tabs button', { hasText: tab }).click();
            await check(`${w}x${h} Settings › ${tab}`);
        }
        // the credits over it
        await page.locator('.settings-tabs button', { hasText: 'Game' }).click();
        await page.locator('.settings-row button', { hasText: 'Credits & licences' }).click();
        await check(`${w}x${h} credits`);
        await page.locator('.credits-close').click();
        await page.keyboard.press('Escape');
        await expect(page.locator('.settings-backdrop')).toBeHidden();
        // the online and level panels
        await page.locator('.online-chip', { hasText: 'Play online' }).click();
        await check(`${w}x${h} online panel`);
        await page.locator('.online-panel:visible button', { hasText: 'Close' }).click();
        await page.locator('.levels-chip').click();
        await check(`${w}x${h} levels panel`);
        // (large text on a phone: the panel covers its chip; it has its own Close button)
        await page.locator('.levels-panel button', { hasText: 'Close' }).click();
        await expect(page.locator('.levels-panel')).toBeHidden();
        // split screen: player 2 looks down at a beam at their feet (their prompt shows), and each
        // player's label is in their own half
        await lab(page, (l) => l.setPlayers(2));
        if (await lab(page, (l) => l.paused())) await lab(page, (l) => l.action('pause')); // play live
        const p0 = await lab(page, (l) => l.player());
        await page.evaluate(
            ([x, y, z, eye]) => {
                const l = (window as unknown as { __riverLab: Lab }).__riverLab;
                l.teleport2(x + 3, z, 0);
                l.placeProp('beam-0', x + 3, y + 0.3, z - 0.6, 0);
                l.look2(0, -Math.atan2(eye - 0.2, 0.55));
            },
            [p0.x, p0.y, p0.z, p0.eyeHeight]
        );
        await page.waitForFunction(
            () => (document.querySelector('.prompt-p2')?.textContent ?? '').trim() !== '',
            null,
            {
                timeout: 60_000
            }
        );
        await check(`${w}x${h} split screen`);
        const tags = await page.evaluate(() =>
            [...document.querySelectorAll<HTMLElement>('.player-tag')]
                .filter((e) => getComputedStyle(e).display !== 'none')
                .map((e) => {
                    const r = e.getBoundingClientRect();
                    return { text: e.textContent, top: r.top, bottom: r.bottom };
                })
        );
        expect(tags.map((t) => t.text)).toEqual(['P1', 'P2']);
        expect(tags[0].bottom, `${w}x${h}: P1 in the top half`).toBeLessThanOrEqual(h / 2);
        expect(tags[1].top, `${w}x${h}: P2 in the bottom half`).toBeGreaterThanOrEqual(h / 2);
        await lab(page, (l) => l.setPlayers(1));
        await page.waitForTimeout(500);
    }
    expect(problems).toEqual([]);
});

test('text size 160 %: the HUD, debug panel, settings chip and debug chip never overlap, on every screen shape', async ({
    page
}) => {
    test.setTimeout(600_000);
    await page.addInitScript(() => localStorage.setItem('uncivil.settings', JSON.stringify({ uiScale: 1.6 })));
    const problems = await boot(page, '?level=yard&t=4&debug&quality=low#cell100');
    type Rect = { l: number; t: number; r: number; b: number };
    const rects = () =>
        page.evaluate(() => {
            const out: Record<string, Rect | null> = {};
            for (const s of ['.hud', '.debug-panel', '.settings-chip', '.debug-chip']) {
                const e = document.querySelector(s) as HTMLElement | null;
                if (!e || getComputedStyle(e).display === 'none') {
                    out[s] = null;
                    continue;
                }
                // the HUD's visible extent is its text, not the full line box
                const range = document.createRange();
                range.selectNodeContents(e);
                const b = s === '.hud' ? range.getBoundingClientRect() : e.getBoundingClientRect();
                out[s] = { l: b.left, t: b.top, r: b.right, b: b.bottom };
            }
            return out;
        });
    const hit = (a: Rect, b: Rect) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
    const assertLayout = async (label: string, w: number, h: number) => {
        const r = await rects();
        const names = Object.keys(r).filter((k) => r[k]);
        for (const n of names) {
            const b = r[n]!;
            expect(
                b.l >= -0.5 && b.t >= -0.5 && b.r <= w + 0.5 && b.b <= h + 0.5,
                `${label}: ${n} inside the viewport ${JSON.stringify(b)}`
            ).toBe(true);
            for (const m of names) if (m < n) expect(hit(r[n]!, r[m]!), `${label}: ${n} overlaps ${m}`).toBe(false);
        }
        return r;
    };
    expect(await page.evaluate(() => document.querySelector('.hud')!.currentCSSZoom)).toBeCloseTo(1.6, 2);
    for (const [w, h] of [
        [360, 740],
        [390, 844],
        [768, 1408],
        [1280, 720],
        [844, 390]
    ]) {
        await page.setViewportSize({ width: w, height: h });
        await page.waitForTimeout(400);
        await lab(page, (l) => (l as unknown as { showPanel(v: boolean): void }).showPanel(true));
        // the layout follows the HUD and dock sizes a frame after a resize (ResizeObserver)
        await expect(async () => {
            const open = await assertLayout(`${w}x${h} panel open`, w, h);
            expect(open['.debug-panel']).not.toBeNull();
            expect(open['.hud']).not.toBeNull();
            expect(open['.settings-chip']).not.toBeNull();
        }).toPass({ timeout: 20_000 });
        await lab(page, (l) => (l as unknown as { showPanel(v: boolean): void }).showPanel(false));
        await expect(async () => {
            await assertLayout(`${w}x${h} panel closed`, w, h);
        }).toPass({ timeout: 20_000 });
    }
    expect(problems).toEqual([]);
});

test('less motion: a device set to reduce motion starts with the camera steady and the UI still; the player can turn it back on', async ({
    browser
}) => {
    test.setTimeout(600_000);
    const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    const problems = await boot(page, '?level=yard&t=1&quality=low#cell100');
    await lab(page, (l) => l.action('pause')); // play live
    expect(await lab(page, (l) => l.state.cameraFeel)).toBe(false);
    expect(await page.evaluate(() => document.body.classList.contains('reduced-motion'))).toBe(true);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.toast')!).transitionDuration)).toBe(
        '0s'
    );
    // walking 2 m on clear flat ground (the spawn, facing up the yard): no bob or kick at all
    const spawn = await lab(page, (l) => l.player());
    const still = await walkAndFeel(page, spawn, 2);
    expect(still.walked).toBeGreaterThanOrEqual(2);
    expect(still.rise, 'flat ground').toBeLessThan(0.05);
    expect(still.most).toBe(0);
    // the switch shows it, and turning it on is the player's saved choice
    await page.locator('.settings-chip').click();
    await page.locator('.settings-tabs button', { hasText: 'Video' }).click();
    const bob = page.locator('.settings-row', { hasText: 'Camera bob' }).locator('[role=switch]');
    await expect(bob).toHaveAttribute('aria-checked', 'false');
    await bob.click();
    await expect(bob).toHaveAttribute('aria-checked', 'true');
    expect(await page.evaluate(() => document.body.classList.contains('reduced-motion'))).toBe(false);
    expect(JSON.parse((await page.evaluate(() => localStorage.getItem('uncivil.settings')))!)).toMatchObject({
        cameraBob: true
    });
    await page.keyboard.press('Escape');
    // with it on, the same 2 m walk bobs the camera (a few centimetres; a stride is under 2 m)
    const bobbing = await walkAndFeel(page, spawn, 2);
    expect(bobbing.walked).toBeGreaterThanOrEqual(2);
    expect(bobbing.rise, 'flat ground').toBeLessThan(0.05);
    expect(bobbing.most).toBeGreaterThan(0.005);
    // a reload keeps the choice
    await page.reload();
    await ready(page);
    expect(await lab(page, (l) => l.state.cameraFeel)).toBe(true);
    // Reset all settings: back to this device's default (off), and nothing of it saved...
    await page.locator('.settings-chip').click();
    await page.locator('.settings-tabs button', { hasText: 'Interface' }).click();
    await page.locator('.settings-row button', { hasText: 'Reset all settings' }).click();
    await expect.poll(() => lab(page, (l) => l.state.cameraFeel)).toBe(false);
    const stored = await page.evaluate(() => localStorage.getItem('uncivil.settings'));
    expect(
        stored === null ? {} : JSON.parse(stored),
        'nothing device-dependent saved after Reset all'
    ).not.toHaveProperty('cameraBob');
    await page.keyboard.press('Escape');
    // ...so it follows the device again when the system setting changes, both ways
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.reload();
    await ready(page);
    expect(await lab(page, (l) => l.state.cameraFeel)).toBe(true);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload();
    await ready(page);
    expect(await lab(page, (l) => l.state.cameraFeel)).toBe(false);
    expect(problems).toEqual([]);
    await context.close();
});

test('less motion by the switch alone (no system setting): the menus and toasts stop moving', async ({ browser }) => {
    test.setTimeout(300_000);
    const context = await browser.newContext({
        reducedMotion: 'no-preference',
        viewport: { width: 1280, height: 720 }
    });
    const page = await context.newPage();
    const problems = await boot(page, '?level=yard&t=1&quality=low#cell100');
    const motion = () =>
        page.evaluate(() => ({
            reduced: document.body.classList.contains('reduced-motion'),
            toast: getComputedStyle(document.querySelector('.toast')!).transitionDuration,
            // the menu's buttons (their press and hover)
            menu: getComputedStyle(document.querySelector('.settings-close')!).transitionDuration
        }));
    // the system doesn't ask for less motion: the UI moves
    expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(false);
    const moving = await motion();
    expect(moving.reduced).toBe(false);
    expect(moving.toast).not.toBe('0s');
    expect(moving.menu).not.toBe('0s');
    // the player switches Camera bob & kick off: body.reduced-motion alone stills them
    await page.locator('.settings-chip').click();
    await page.locator('.settings-tabs button', { hasText: 'Video' }).click();
    const bob = page.locator('.settings-row', { hasText: 'Camera bob' }).locator('[role=switch]');
    await expect(bob).toHaveAttribute('aria-checked', 'true');
    await bob.click();
    await expect(bob).toHaveAttribute('aria-checked', 'false');
    expect(await motion()).toEqual({ reduced: true, toast: '0s', menu: '0s' });
    expect(problems).toEqual([]);
    await context.close();
});

test('the online panel is not rebuilt while nothing changes (its buttons stay the same buttons)', async ({ page }) => {
    test.setTimeout(300_000);
    const problems = await boot(page, '?level=yard&t=1&quality=low&net=local#cell100');
    await page.locator('.online-chip', { hasText: 'Play online' }).click();
    const panel = page.locator('.online-panel:visible');
    await expect(panel.locator('button', { hasText: 'Close' })).toBeVisible();
    await page.waitForTimeout(1500);
    // watch it for over three of its once-a-second refreshes
    const changes = await page.evaluate(async () => {
        const el = [...document.querySelectorAll<HTMLElement>('.online-panel')].find((e) => e.offsetWidth > 0)!;
        const close = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Close');
        let records = 0;
        const watch = new MutationObserver((m) => (records += m.length));
        watch.observe(el, { childList: true, subtree: true, characterData: true, attributes: true });
        await new Promise((r) => setTimeout(r, 3500));
        watch.disconnect();
        const after = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Close');
        return { records, sameButton: after === close };
    });
    expect(changes).toEqual({ records: 0, sameButton: true });
    expect(problems).toEqual([]);
});

test('touch controls on a phone: the stick walks the beaver, the Jump button jumps (#97)', async ({ browser }) => {
    test.setTimeout(300_000);
    const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const problems = await boot(page, '?level=yard&t=1&quality=low#cell100');
    await lab(page, (l) => l.action('pause')); // play live
    await expect(page.locator('.touch-ui')).toHaveClass(/\bon\b/);
    const cdp = await context.newCDPSession(page);
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) =>
        cdp.send('Input.dispatchTouchEvent', {
            type,
            touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }]
        });
    // the stick: a touch on the left of the play area, pushed up (forward) and held
    const start = await lab(page, (l) => l.player());
    await touch('touchStart', 90, 560);
    await touch('touchMove', 90, 500);
    let walked = 0;
    for (let i = 0; i < 60 && walked < 1; i++) {
        await page.waitForTimeout(200);
        await touch('touchMove', 90, i % 2 ? 499 : 500); // held: a finger trembles
        walked = (await lab(page, (l) => l.player())).walkDist - start.walkDist;
    }
    await touch('touchEnd', 90, 500);
    expect(walked, 'walked with the stick').toBeGreaterThanOrEqual(1);
    const p = await lab(page, (l) => l.player());
    expect(Math.hypot(p.x - start.x, p.z - start.z), 'moved on the ground').toBeGreaterThan(0.5);
    // the Jump button: the beaver leaves the ground
    await page.waitForTimeout(500);
    const ground = (await lab(page, (l) => l.player())).y;
    const jump = await page.locator('.touch-jump').boundingBox();
    await touch('touchStart', jump!.x + jump!.width / 2, jump!.y + jump!.height / 2);
    await touch('touchEnd', 0, 0);
    let rise = 0;
    for (let i = 0; i < 30 && rise < 0.2; i++) {
        await page.waitForTimeout(50);
        rise = Math.max(rise, (await lab(page, (l) => l.player())).y - ground);
    }
    expect(rise, 'jumped').toBeGreaterThan(0.2);
    expect(problems).toEqual([]);
    await context.close();
});

test('field of view: the setting is the camera’s, live', async ({ page }) => {
    test.setTimeout(300_000);
    const problems = await boot(page, '?level=yard&t=1&quality=low#cell100');
    expect(await lab(page, (l) => l.cameraFov())).toBe(52);
    await page.locator('.settings-chip').click();
    await page.locator('.settings-tabs button', { hasText: 'Video' }).click();
    const fov = page.locator('.settings-row', { hasText: 'Field of view' });
    await fov.locator('input[type=range]').focus();
    for (let n = 0; n < 8; n++) await fov.locator('button', { hasText: '+' }).click();
    await expect(fov.locator('output')).toHaveText('60°');
    await expect.poll(() => lab(page, (l) => l.cameraFov())).toBe(60);
    expect(problems).toEqual([]);
});

test('clicking a menu never grabs the timber under the crosshair; a click on the game does', async ({ page }) => {
    test.setTimeout(300_000);
    const problems = await boot(page, '?level=yard&t=1&quality=low&net=local#cell100');
    await lab(page, (l) => l.action('pause')); // play live
    // the bucket on the ground 1.3 m ahead, under the crosshair
    const p = await lab(page, (l) => l.player());
    const ahead = 1.3;
    await page.evaluate(
        ([x, y, z]) => (window as unknown as { __riverLab: Lab }).__riverLab.placeProp('bucket', x, y, z),
        [p.x - Math.sin(p.yaw) * ahead, p.y + 0.15, p.z - Math.cos(p.yaw) * ahead]
    );
    await page.evaluate(
        ([yaw, pitch]) => (window as unknown as { __riverLab: Lab }).__riverLab.look(yaw, pitch),
        [p.yaw, -Math.atan2(p.eyeHeight - 0.15, ahead)]
    );
    await expect.poll(() => lab(page, (l) => l.interaction().target), { timeout: 20_000 }).toBe('bucket');
    const vw = page.viewportSize()!;
    const centre = { x: vw.width / 2, y: vw.height / 2 };
    // after each click: nothing held, and the bucket still under the crosshair (so the click had
    // something to grab, had it reached the game)
    const notHeld = async (what: string) => {
        await page.waitForTimeout(400);
        expect((await lab(page, (l) => l.player())).holding, what).toBe(-1);
        expect(await lab(page, (l) => l.interaction().target), `${what}: still aimed at the bucket`).toBe('bucket');
    };

    // the first click on the game takes the mouse, and grabs nothing
    await page.mouse.click(centre.x, centre.y);
    await expect.poll(() => page.evaluate(() => !!document.pointerLockElement)).toBe(true);
    await notHeld('the click that takes the mouse');
    // Esc (the browser releases the mouse): the menu opens; clicks on it, right over the crosshair,
    // grab nothing
    await page.evaluate(() => document.exitPointerLock());
    await expect(page.locator('.settings-backdrop')).toBeVisible();
    await page.mouse.click(centre.x, centre.y);
    await notHeld('a click on the menu over the crosshair');
    for (const tab of ['Controls', 'Video', 'Game']) {
        await page.locator('.settings-tabs button', { hasText: tab }).click();
        await notHeld(`the ${tab} tab`);
    }
    // a click on the backdrop outside the dialog closes the menu: still nothing grabbed
    await page.mouse.click(4, vw.height / 2);
    await expect(page.locator('.settings-backdrop')).toBeHidden();
    await notHeld('a click outside the menu that closes it');
    // the dock's buttons and the panels they open
    await page.locator('.online-chip', { hasText: 'Play online' }).click();
    await page.locator('.online-panel:visible').click({ position: { x: 20, y: 20 } });
    await page.locator('.online-panel:visible button', { hasText: 'Close' }).click();
    await notHeld('the online panel');
    await page.locator('.levels-chip').click();
    await page.locator('.levels-panel button', { hasText: 'Close' }).click();
    await notHeld('the level chooser');
    // Resume from the menu takes the mouse back and grabs nothing; then a click on the game grabs
    await page.keyboard.press('Escape');
    await expect(page.locator('.settings-backdrop')).toBeVisible();
    await page.locator('.settings-row button', { hasText: 'Resume' }).click();
    await expect.poll(() => page.evaluate(() => !!document.pointerLockElement)).toBe(true);
    await notHeld('Resume');
    expect(await lab(page, (l) => l.interaction().target)).toBe('bucket');
    // a click on the game, without moving the mouse (with the mouse taken, moving it turns the view;
    // the click goes to the game wherever the pointer sits): it grabs the bucket
    await page.mouse.down();
    await page.mouse.up();
    await expect.poll(() => lab(page, (l) => l.interaction().holding)).toBe('bucket');
    expect(problems).toEqual([]);
});
