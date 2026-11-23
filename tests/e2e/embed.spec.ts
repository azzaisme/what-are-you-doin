/**
 * The game as itch.io shows it (#103): inside a cross-origin iframe on another site's page, with the
 * permissions itch's embed grants (autoplay, fullscreen, gamepad) and the browser's real rule that
 * sound only starts after a user gesture.
 *
 * The embedding page is http://itch.test and the game http://game.test, both routed by the test
 * (the game to the local build), so the two are cross-origin like itch.io and its game host, and
 * neither is "local network" to the browser. Tab switching can't be produced in headless Chrome (it
 * never hides a page), so the hidden page is announced to the game the way the browser does it: the
 * visibility state changes and a visibilitychange event fires.
 */

import type { BrowserContext, Frame, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import config from '../../playwright.config.ts';

// real browsers block sound until a gesture; the default headless policy would not
test.use({
    launchOptions: {
        ...config.use?.launchOptions,
        args: [...(config.use?.launchOptions?.args ?? []), '--autoplay-policy=user-gesture-required']
    }
});

type Lab = {
    ready: boolean;
    action(id: string): void;
    paused(): boolean;
    player(): { holding: number };
    audio(): { started: boolean; context: string };
    net: {
        host(): Promise<void>;
        games(): { code: string }[];
        join(c: string): Promise<void>;
        status(): {
            hosting: string | null;
            guests: number;
            dropped: number[];
            guest: { slot: number; received: number; reconnecting: boolean; hostAway: boolean } | null;
        };
    };
};

const IGNORED = [
    /GPU stall due to ReadPixels/,
    /GL Driver Message/,
    /Powered by PlayCanvas/,
    /favicon/i,
    /status of 404/
];
const BUILD = 'http://localhost:4173';

/** itch's embed: the game in a sized iframe, and the page's own full screen button. */
const ITCH_PAGE = (src: string, w: number, h: number) => `<!doctype html>
<html><head><meta charset="utf-8"><title>itch embed</title></head>
<body style="margin:0;background:#2b2b2b">
  <div id="wrap"><iframe id="game" src="${src}" width="${w}" height="${h}" frameborder="0" scrolling="no"
    allow="autoplay; fullscreen *; gamepad; accelerometer; gyroscope"></iframe></div>
  <button id="fs" type="button">Full screen (the page's button)</button>
  <script>document.getElementById('fs').onclick = () => document.getElementById('game').requestFullscreen();</script>
</body></html>`;

async function routeEmbed(context: BrowserContext): Promise<void> {
    await context.route('http://game.test/**', async (route) => {
        const u = new URL(route.request().url());
        const res = await route.fetch({ url: BUILD + u.pathname + u.search });
        await route.fulfill({ response: res });
    });
    await context.route('http://itch.test/**', (route) => {
        const u = new URL(route.request().url());
        const q = u.searchParams.get('q') ?? '';
        const w = Number(u.searchParams.get('w') ?? 640);
        const h = Number(u.searchParams.get('h') ?? 360);
        return route.fulfill({ contentType: 'text/html', body: ITCH_PAGE(`http://game.test/${q}`, w, h) });
    });
}

/** Opens an itch page with the game in it; returns the page, the game's frame and its problems. */
async function openEmbed(page: Page, query: string, w = 640, h = 360): Promise<{ frame: Frame; problems: string[] }> {
    const problems: string[] = [];
    page.on('console', (m) => {
        if ((m.type() === 'error' || m.type() === 'warning') && !IGNORED.some((r) => r.test(m.text())))
            problems.push(`${m.type()}: ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await page.goto(`http://itch.test/game?w=${w}&h=${h}&q=${encodeURIComponent(query)}`);
    const frame = (await (await page.$('#game'))!.contentFrame())!;
    await frame.waitForFunction(() => (window as unknown as { __riverLab?: Lab }).__riverLab?.ready === true, null, {
        timeout: 150_000
    });
    return { frame, problems };
}

const lab = <T>(f: Frame, fn: (l: Lab) => T | Promise<T>) =>
    f.evaluate(
        (src) => new Function('l', `return (${src})(l)`)((window as unknown as { __riverLab: Lab }).__riverLab),
        fn.toString()
    ) as Promise<T>;

/** What the browser does when the tab is hidden or shown again (see the note at the top). */
const setHidden = (f: Frame, hidden: boolean) =>
    f.evaluate((h) => {
        Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            get: () => (h ? 'hidden' : 'visible')
        });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
        document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);

const view = (f: Frame) =>
    f.evaluate(() => {
        const c = document.querySelector('canvas')!;
        const hud = document.querySelector('.hud')!.getBoundingClientRect();
        return {
            w: innerWidth,
            h: innerHeight,
            canvasW: c.width,
            canvasH: c.height,
            cssW: c.clientWidth,
            hudInside: hud.right <= innerWidth + 0.5 && hud.bottom <= innerHeight + 0.5,
            locked: !!document.pointerLockElement,
            fullscreen: !!document.fullscreenElement,
            menu: !(document.querySelector('.settings-backdrop') as HTMLElement).hidden
        };
    });

test('itch embed: in a cross-origin iframe, a click takes the mouse and starts sound (never grabs); resizes, full screen both ways, a hidden page pauses', async ({
    page,
    context
}) => {
    test.setTimeout(600_000);
    await routeEmbed(context);
    const { frame, problems } = await openEmbed(page, '?level=yard&t=1&quality=low#cell100');
    await lab(frame, (l) => l.action('pause')); // ?t= seeks and pauses: play live from here
    const dpr = await frame.evaluate(() => devicePixelRatio);

    // before any gesture: no sound, no pointer lock; the canvas fills the 640 x 360 frame
    expect(await lab(frame, (l) => l.audio())).toMatchObject({ started: false, context: 'locked' });
    let v = await view(frame);
    expect(v).toMatchObject({ w: 640, h: 360, locked: false, menu: false });
    expect(v.canvasW).toBe(Math.round(640 * dpr));

    // the first click inside the frame: the mouse is taken and the sound starts; nothing is grabbed
    await page.locator('#game').click({ position: { x: 320, y: 200 } });
    await expect.poll(async () => (await view(frame)).locked).toBe(true);
    await expect.poll(async () => (await lab(frame, (l) => l.audio())).context).toBe('running');
    expect((await lab(frame, (l) => l.player())).holding).toBe(-1);

    // the embedding page resizes the frame: the canvas and the HUD follow
    await page.evaluate(() => {
        const g = document.getElementById('game') as HTMLIFrameElement;
        g.width = '960';
        g.height = '540';
    });
    await expect
        .poll(async () => {
            const x = await view(frame);
            return [x.w, x.canvasW, x.canvasH, x.hudInside];
        })
        .toEqual([960, Math.round(960 * dpr), Math.round(540 * dpr), true]);

    // the page's own full screen button: the frame fills the screen, then goes back (losing the
    // mouse to it opens the menu, as Esc would)
    await page.locator('#fs').click();
    await expect.poll(async () => (await view(frame)).canvasW).toBe(Math.round(1280 * dpr));
    v = await view(frame);
    expect(v).toMatchObject({ w: 1280, h: 720, locked: false, menu: true, hudInside: true });
    await page.evaluate(() => document.exitFullscreen());
    await expect.poll(async () => (await view(frame)).canvasW).toBe(Math.round(960 * dpr));

    // full screen from inside the game: Settings → Game → Full screen (the embed allows it)
    const fsRow = frame.locator('.settings-row', { hasText: 'Full screen' });
    await frame.locator('.settings-tabs button', { hasText: 'Game' }).click();
    await fsRow.locator('[role=switch]').click();
    await expect.poll(async () => (await view(frame)).fullscreen).toBe(true);
    await expect(fsRow.locator('[role=switch]')).toHaveAttribute('aria-checked', 'true');
    await expect.poll(async () => (await view(frame)).canvasW).toBe(Math.round(1280 * dpr));
    await fsRow.locator('[role=switch]').click();
    await expect.poll(async () => (await view(frame)).fullscreen).toBe(false);
    await expect(fsRow.locator('[role=switch]')).toHaveAttribute('aria-checked', 'false');
    await expect.poll(async () => (await view(frame)).canvasW).toBe(Math.round(960 * dpr));

    // back to the game (Resume takes the mouse again)
    await frame.locator('.settings-row button', { hasText: 'Resume' }).click();
    await expect.poll(async () => (await view(frame)).menu).toBe(false);
    expect(await lab(frame, (l) => l.paused())).toBe(false);

    // the tab is hidden: the sound pauses and the solo game stops at the menu; shown again, the
    // sound comes back and the game waits there for the player
    await setHidden(frame, true);
    await expect.poll(async () => (await lab(frame, (l) => l.audio())).context).toBe('suspended');
    expect((await view(frame)).menu).toBe(true);
    expect(await lab(frame, (l) => l.paused())).toBe(true);
    await setHidden(frame, false);
    await expect.poll(async () => (await lab(frame, (l) => l.audio())).context).toBe('running');
    expect((await view(frame)).menu).toBe(true);
    await frame.locator('.settings-row button', { hasText: 'Resume' }).click();
    expect(await lab(frame, (l) => l.paused())).toBe(false);
    expect(problems).toEqual([]);
});

test('itch embed, online: a host in the background tells its guests; a guest who leaves is held; a host who leaves is waited for, then left', async ({
    page,
    context
}) => {
    test.setTimeout(900_000);
    await routeEmbed(context);
    const q = '?level=yard&t=0.01&quality=low&net=local#cell100';
    const { frame: host, problems } = await openEmbed(page, q);
    const guestPage = await context.newPage();
    const { frame: guest, problems: guestProblems } = await openEmbed(guestPage, q);
    const status = (f: Frame) => lab(f, (l) => l.net.status());

    await lab(host, (l) => l.net.host());
    const code = (await status(host)).hosting!;
    await guest.waitForFunction(
        (c) => (window as unknown as { __riverLab: Lab }).__riverLab.net.games().some((g) => g.code === c),
        code,
        { timeout: 120_000 }
    );
    await guest.evaluate((c) => (window as unknown as { __riverLab: Lab }).__riverLab.net.join(c), code);
    await expect.poll(async () => (await status(guest)).guest?.received ?? 0, { timeout: 120_000 }).toBeGreaterThan(5);
    expect((await status(guest)).guest!.slot).toBe(1);

    // the host's tab goes to the background: the guest is told why the world stopped, and stays
    await setHidden(host, true);
    await expect.poll(async () => (await status(guest)).guest?.hostAway, { timeout: 30_000 }).toBe(true);
    await expect(guest.locator('.toast')).toContainText('in the background');
    await setHidden(host, false);
    await expect.poll(async () => (await status(guest)).guest?.hostAway, { timeout: 30_000 }).toBe(false);
    expect((await status(guest)).guest).not.toBeNull();

    // the guest's tab closes: the host holds player 2 for them
    await guestPage.close();
    await expect.poll(async () => (await status(host)).dropped, { timeout: 30_000 }).toEqual([1]);

    // a second guest joins; then the host's tab closes: the guest waits for the host (reconnecting),
    // then gives up and is told the host left
    const guest2Page = await context.newPage();
    const { frame: guest2, problems: guest2Problems } = await openEmbed(guest2Page, q);
    await guest2.waitForFunction(
        (c) => (window as unknown as { __riverLab: Lab }).__riverLab.net.games().some((g) => g.code === c),
        code,
        { timeout: 120_000 }
    );
    await guest2.evaluate((c) => (window as unknown as { __riverLab: Lab }).__riverLab.net.join(c), code);
    await expect.poll(async () => (await status(guest2)).guest?.received ?? 0, { timeout: 120_000 }).toBeGreaterThan(5);
    await page.close();
    await expect.poll(async () => (await status(guest2)).guest?.reconnecting, { timeout: 30_000 }).toBe(true);
    await expect(guest2.locator('.toast')).toContainText('reconnecting');
    // HOST_GRACE_MS (20 s) later the game is over for the guest
    await expect.poll(async () => (await status(guest2)).guest, { timeout: 60_000 }).toBeNull();
    await expect(guest2.locator('.toast')).toContainText('The host left the game');
    expect(problems).toEqual([]);
    expect(guestProblems).toEqual([]);
    expect(guest2Problems).toEqual([]);
});

test('credits and licences: Settings → Game → Credits lists what the game is made with; the licence texts load beside the game', async ({
    page,
    context
}) => {
    test.setTimeout(300_000);
    await routeEmbed(context);
    const { frame, problems } = await openEmbed(page, '?level=yard&t=1&quality=low#cell100');
    await frame.locator('.settings-chip').click();
    await frame.locator('.settings-tabs button', { hasText: 'Game' }).click();
    await frame.locator('.settings-row button', { hasText: 'Credits & licences' }).click();
    const dialog = frame.locator('.credits[role=dialog]');
    await expect(dialog).toBeVisible();
    for (const name of ['PlayCanvas Engine', 'Rapier', 'Trystero', 'noble-secp256k1'])
        await expect(dialog.locator('.credits-third-party')).toContainText(name);
    await expect(dialog).toContainText('Every sound is synthesised in code');
    // the full texts sit beside the game (a relative URL, so it works wherever the build is served)
    const href = await dialog.locator('a.credits-licenses').getAttribute('href');
    expect(href).toBe('./third-party-licenses.txt');
    const txt = await frame.evaluate(async (h) => {
        const r = await fetch(h);
        return { ok: r.ok, text: await r.text() };
    }, href!);
    expect(txt.ok).toBe(true);
    for (const s of [
        'playcanvas',
        '@dimforge/rapier3d-compat',
        'trystero',
        'Apache License',
        'Permission is hereby granted'
    ])
        expect(txt.text).toContain(s);
    // Esc closes the credits, not the menu below; Close (or a click outside) too
    await frame.locator('.credits-close').focus();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(frame.locator('.settings-backdrop')).toBeVisible();
    expect(problems).toEqual([]);
});
