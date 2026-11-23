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
    player(): { x: number; y: number; z: number; yaw: number; holding: number; eyeHeight: number };
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

test('text size 160 %: every HUD and menu text is 1.6× and stays on screen, phone and desktop', async ({ page }) => {
    test.setTimeout(600_000);
    await page.addInitScript(() => localStorage.setItem('uncivil.settings', JSON.stringify({ uiScale: 1.6 })));
    const problems = await boot(page, '?level=yard&t=1&quality=low#cell100');
    const check = async (label: string) => {
        const t = await texts(page);
        expect(t.length, `${label}: some text`).toBeGreaterThan(3);
        const wrong = t.filter((x) => Math.abs(x.zoom - 1.6) > 0.01).map((x) => `${x.what} zoom ${x.zoom}`);
        expect(wrong, `${label}: text not at 160 %`).toEqual([]);
        const off = t.filter((x) => !x.inside).map((x) => x.what);
        expect(off, `${label}: text off screen`).toEqual([]);
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
        await page.locator('.levels-chip').click();
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
    // walking: the camera has no bob or kick at all
    await page.keyboard.down('KeyW');
    let most = 0;
    for (let n = 0; n < 30; n++) {
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
        const f = await lab(page, (l) => l.cameraFeel());
        most = Math.max(most, Math.abs(f.dx), Math.abs(f.dy), Math.abs(f.dz), Math.abs(f.pitch), Math.abs(f.roll));
    }
    await page.keyboard.up('KeyW');
    expect(most).toBe(0);
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
    // with it on, walking bobs the camera
    await page.keyboard.down('KeyW');
    most = 0;
    for (let n = 0; n < 60 && most < 0.002; n++) {
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
        const f = await lab(page, (l) => l.cameraFeel());
        most = Math.max(most, Math.abs(f.dy), Math.abs(f.roll));
    }
    await page.keyboard.up('KeyW');
    expect(most).toBeGreaterThan(0.002);
    // a reload keeps the choice
    await page.reload();
    await ready(page);
    expect(await lab(page, (l) => l.state.cameraFeel)).toBe(true);
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
    const problems = await boot(page, '?level=yard&t=1&quality=low#cell100');
    await lab(page, (l) => l.action('pause')); // play live
    // the bucket on the ground 1.3 m ahead, under the crosshair
    const p = await lab(page, (l) => l.player());
    const ahead = 1.3;
    await page.evaluate(
        ([x, y, z]) => (window as unknown as { __riverLab: Lab }).__riverLab.placeProp('bucket', x, y, z),
        [p.x - Math.sin(p.yaw) * ahead, p.y + 0.3, p.z - Math.cos(p.yaw) * ahead]
    );
    await page.evaluate(
        ([yaw, pitch]) => (window as unknown as { __riverLab: Lab }).__riverLab.look(yaw, pitch),
        [p.yaw, -Math.atan2(p.eyeHeight - 0.15, ahead)]
    );
    await expect.poll(() => lab(page, (l) => l.interaction().target), { timeout: 20_000 }).toBe('bucket');
    const vw = page.viewportSize()!;
    const centre = { x: vw.width / 2, y: vw.height / 2 };
    const notHeld = async (what: string) => {
        await page.waitForTimeout(400);
        expect((await lab(page, (l) => l.player())).holding, what).toBe(-1);
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
    await page.locator('.levels-chip').click();
    await notHeld('the level chooser');
    // Resume from the menu takes the mouse back and grabs nothing; then a click on the game grabs
    await page.keyboard.press('Escape');
    await expect(page.locator('.settings-backdrop')).toBeVisible();
    await page.locator('.settings-row button', { hasText: 'Resume' }).click();
    await expect.poll(() => page.evaluate(() => !!document.pointerLockElement)).toBe(true);
    await notHeld('Resume');
    expect(await lab(page, (l) => l.interaction().target)).toBe('bucket');
    await page.mouse.click(centre.x, centre.y);
    await expect.poll(() => lab(page, (l) => l.interaction().holding)).toBe('bucket');
    expect(problems).toEqual([]);
});
