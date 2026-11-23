import type { BrowserContext, Page, TestInfo } from '@playwright/test';

/**
 * The browser tests' fast clock. Software GL draws about one frame a second, and the game's normal
 * clock (at most 4 steps of 1/60 s per drawn frame) then runs the game 10-20x slower than real time.
 * With the fast clock the page takes the wall time since the last frame (up to 1 s) and runs up to 60
 * steps a frame: the same steps in the same order, so game time keeps up with wall time. It is turned
 * on by `window.__uncivilFastClock`, which only an init script like this one sets before the page
 * loads (src/main.ts); players never get it.
 *
 * Every test runs with it, on a smaller page (fewer pixels to draw in software), except those tagged:
 * - `REALTIME`: what is drawn matters, so they run as a player's game does (normal clock, full page);
 * - `REALCLOCK`: real-time input or networking matters, so they keep the normal clock (small page).
 */
export const REALTIME = '@realtime';
export const REALCLOCK = '@realclock';

/** The page size of fast-clock tests: still the desktop layout (wider than 700 px), 16:9 like 1280 x 720. */
export const FAST_VIEWPORT = { width: 720, height: 405 };

export async function fastClock(
    context: BrowserContext,
    page: Page,
    info: TestInfo,
    opts: { viewport?: boolean } = {}
): Promise<void> {
    if (info.tags.includes(REALTIME)) return;
    if (opts.viewport !== false) {
        await page.setViewportSize(FAST_VIEWPORT);
        // (a page the test opens later, before it loads anything)
        context.on('page', (p) => void p.setViewportSize(FAST_VIEWPORT).catch(() => undefined));
    }
    if (info.tags.includes(REALCLOCK)) return;
    // every page of the context: a second device's page in the online tests, and iframes
    await context.addInitScript(() => {
        (window as unknown as { __uncivilFastClock?: boolean }).__uncivilFastClock = true;
    });
}
