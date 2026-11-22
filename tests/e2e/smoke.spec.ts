import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import pngjs from 'pngjs';

import { startRelay } from './nostr-relay.ts';

const { PNG } = pngjs;

// Browser smoke and invariants. Runs against the production build (vite preview) in headless
// Chrome with SwiftShader. Visual quality is judged from captured screenshots by a human; these
// tests check boot, absence of errors, grid invariants and deterministic reconstruction.

type Lab = {
    ready: boolean;
    seek(t: number): void;
    set(id: string, v: unknown): void;
    stats(): Record<string, unknown> & { voxel: Record<string, number>; staticCells: number; dynamicCells: number };
    verifyGrid(): Promise<{ vertices: number; misaligned: number }>;
    dynamicHash(): Promise<number>;
    voxelIdle(): boolean;
    setFirstPerson(x: number, z: number, yaw: number, pitch: number): void;
    entities(): Record<string, { visible: boolean; x: number; y: number; z: number }>;
    input(c: Record<string, unknown>): void;
    action(id: string): void;
    player(): { x: number; y: number; z: number; holding: number; grounded: boolean; eyeHeight: number };
    look(yaw: number, pitch: number): void;
    level: string;
    progress(): { goalReached: boolean; falls: number; recoveries: number; events: string[] };
    placeProp(name: string, x: number, y: number, z: number, yaw?: number): boolean;
    interaction(): { holding: string | null; target: string | null; shared: boolean; driving: boolean; seat: number };
    teleport(x: number, z: number, yaw?: number): void;
    ute(): { x: number; y: number; z: number; yaw: number; speed: number; driver: number; drivable: boolean };
    wood(): {
        trees: { phase: string; cut: number }[];
        sawmill: { phase: string; stopped: string; mode: string; taken: number; planks: number } | null;
    };
};

const IGNORED = [
    /GPU stall due to ReadPixels/,
    /GL Driver Message/,
    /Powered by PlayCanvas/,
    /favicon/i,
    /status of 404/
];

async function boot(page: Page, query = '?level=lab&t=4&noui'): Promise<string[]> {
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
    await idle(page);
    await page.waitForTimeout(1500);
    return problems;
}

/** Voxel frames are built in a worker: wait until none is in flight. */
async function idle(page: Page): Promise<void> {
    await page.waitForTimeout(150);
    await page.waitForFunction(() => (window as unknown as { __riverLab: Lab }).__riverLab.voxelIdle(), null, {
        timeout: 60_000
    });
}

const lab = <T>(page: Page, fn: (l: Lab) => T) =>
    page.evaluate(
        (src) => new Function('l', `return (${src})(l)`)((window as unknown as { __riverLab: Lab }).__riverLab),
        fn.toString()
    ) as Promise<T>;

test('boots the River Lab with no console errors and a non-blank frame', async ({ page }) => {
    const problems = await boot(page);
    const shot = await page.screenshot();
    expect(shot.byteLength).toBeGreaterThan(50_000); // a blank canvas compresses to a few kB
    // colour sanity: vertex colours must reach the screen (a lost colour stream renders white)
    const png = PNG.sync.read(shot);
    let green = 0;
    let saturated = 0;
    const n = png.width * png.height;
    for (let i = 0; i < n; i++) {
        const r = png.data[i * 4];
        const g = png.data[i * 4 + 1];
        const b = png.data[i * 4 + 2];
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        if (max > 40 && (max - min) / max > 0.35) saturated++;
        if (g > r * 1.15 && g > b * 1.15) green++;
    }
    expect(saturated / n).toBeGreaterThan(0.3);
    expect(green / n).toBeGreaterThan(0.12); // measured 0.19 at 5 cm, about 0.3 at 10 cm; a white-out is ~0
    const s = await lab(page, (l) => l.stats());
    expect(s.staticCells).toBeGreaterThan(1_000_000);
    expect(s.voxel.objects).toBe(7);
    expect(s.voxel.rejected).toBe(0);
    // feet and wheels may dip a cell into the ground at fine cell sizes; the dynamic cell wins and
    // the static cell reappears afterwards (compositor policy). Physics props rest on the analytic
    // terrain, which lies 0-1 cell below the voxel ground surface, so resting props share at most one
    // layer of cells with the ground (measured 123 at 5 cm; the plank's footprint alone is ~190).
    // Several layers (a sinking prop) would be well over this bound.
    expect(s.voxel.dynStaticOverlaps).toBeLessThan(400);
    expect(problems).toEqual([]);
});

test('every uploaded vertex lies on the global 10 cm grid and render units never move', async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(() => (window as unknown as { __riverLab: Lab }).__riverLab.verifyGrid());
    expect(r.vertices).toBeGreaterThan(10_000);
    expect(r.misaligned).toBe(0);
});

test('reconstruction is deterministic for a time and changes as objects move', async ({ page }) => {
    await boot(page);
    const at = async (t: number) => {
        await lab(page, (l) => l.seek(0));
        await page.evaluate((t) => (window as unknown as { __riverLab: Lab }).__riverLab.seek(t), t);
        await idle(page);
        return page.evaluate(() => (window as unknown as { __riverLab: Lab }).__riverLab.dynamicHash());
    };
    const a1 = await at(6.25);
    const b = await at(7.0);
    const a2 = await at(6.25);
    expect(a2).toBe(a1);
    expect(b).not.toBe(a1);
});

test('debug controls: reference mode, voxel rates, sampling policies and stress objects', async ({ page }) => {
    const problems = await boot(page);
    await lab(page, (l) => l.set('reference', true));
    await idle(page);
    expect((await lab(page, (l) => l.stats())).dynamicCells).toBe(0);
    await lab(page, (l) => l.set('reference', false));
    for (const hz of ['12', '30', '60', '20'])
        await page.evaluate((hz) => (window as unknown as { __riverLab: Lab }).__riverLab.set('hz', hz), hz);
    for (const p of ['center', 'coverage25', 'conservative', 'coverage50']) {
        await page.evaluate((p) => (window as unknown as { __riverLab: Lab }).__riverLab.set('policy', p), p);
        await page.waitForTimeout(300);
    }
    await lab(page, (l) => l.set('stress', '25'));
    await lab(page, (l) => l.seek(5));
    await idle(page);
    const s = await lab(page, (l) => l.stats());
    expect(s.voxel.objects).toBe(32);
    expect(s.voxel.rejected).toBe(0);
    expect(problems).toEqual([]);
});

test('first-person mode carries a voxelized plank', async ({ page }) => {
    const problems = await boot(page);
    await lab(page, (l) => l.setFirstPerson(0, 6, 0, -0.1));
    await lab(page, (l) => l.set('carry', true));
    await page.waitForTimeout(1500);
    const e = await lab(page, (l) => l.entities());
    expect(e['held-plank'].visible).toBe(true);
    expect(problems).toEqual([]);
});

test('voxel size is a quality setting: #cell100 loads the 10 cm world', async ({ page }) => {
    const problems = await boot(page, '?level=lab&t=4&noui#cell100');
    const s = await lab(page, (l) => l.stats());
    expect(s.cellCm).toBe(10);
    expect(s.staticCells).toBeGreaterThan(1_000_000);
    expect(s.staticCells).toBeLessThan(2_000_000);
    const g = await page.evaluate(() => (window as unknown as { __riverLab: Lab }).__riverLab.verifyGrid());
    expect(g.misaligned).toBe(0);
    expect(problems).toEqual([]);
});

test('default voxel size is 5 cm with the slider range 5-10 cm', async ({ page }) => {
    await boot(page);
    const s = await lab(page, (l) => l.stats());
    expect(s.cellCm).toBe(5);
    expect(s.staticCells).toBeGreaterThan(5_000_000);
    // the voxel size is in Settings > Video (this page hides the UI: Esc opens the menu)
    await page.keyboard.press('Escape');
    await page.locator('.settings-tabs button', { hasText: 'Video' }).click();
    const range = page.locator('.settings-row', { hasText: 'Voxel size' }).locator('input[type=range]');
    await expect(range).toHaveAttribute('min', '5');
    await expect(range).toHaveAttribute('max', '10');
});

test('settings menu: mouse, keyboard and gamepad reach every setting, and it is saved', async ({ page }) => {
    // a stand-in gamepad the page reads through navigator.getGamepads
    await page.addInitScript(() => {
        const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
        const pad = { index: 0, id: 'test pad', connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons };
        (window as unknown as { __pad: typeof pad }).__pad = pad;
        navigator.getGamepads = () => [pad as unknown as Gamepad];
    });
    const problems = await boot(page, '?level=yard&t=1&quality=low#cell100');
    // run live from here (?t= seeks and pauses): opening the menu pauses solo play, closing resumes it
    await lab(page, (l) => l.action('pause'));
    expect(await lab(page, (l) => (l as unknown as { paused(): boolean }).paused())).toBe(false);
    const backdrop = page.locator('.settings-backdrop');
    // the game reads pads once per rendered frame (well over 150 ms in software GL on CI): hold each
    // button until the page has drawn a frame, then release it for another
    const frames = () =>
        page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    const setButton = (i: number, v: boolean) =>
        page.evaluate(
            ([i, v]) => {
                (window as unknown as { __pad: { buttons: { pressed: boolean }[] } }).__pad.buttons[i].pressed = v;
            },
            [i, v] as [number, boolean]
        );
    const press = async (b: number) => {
        await setButton(b, true);
        await frames();
        await setButton(b, false);
        await frames();
    };
    // mouse: the Settings button opens it, Resume closes it; solo play pauses meanwhile
    await page.locator('.settings-chip').click();
    await expect(backdrop).toBeVisible();
    await expect(page.locator('[role=dialog]')).toHaveAttribute('aria-modal', 'true');
    expect(await lab(page, (l) => (l as unknown as { paused(): boolean }).paused())).toBe(true);
    await page.locator('.settings-row button', { hasText: 'Resume' }).click();
    await expect(backdrop).toBeHidden();
    // keyboard: Esc opens; E to Video; down to the field of view, right to widen it; Esc closes
    await page.keyboard.press('Escape');
    await expect(backdrop).toBeVisible();
    await expect(page.locator('.settings-row.current')).toContainText('Resume');
    await page.keyboard.press('KeyE');
    await page.keyboard.press('KeyE');
    const fov = page.locator('.settings-row', { hasText: 'Field of view' });
    while (!(await fov.evaluate((e) => e.classList.contains('current')))) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(fov.locator('output')).toHaveText('54°');
    await page.keyboard.press('Escape');
    await expect(backdrop).toBeHidden();
    expect(await lab(page, (l) => (l as unknown as { paused(): boolean }).paused())).toBe(false);
    // gamepad: Start opens (on the section used last); RB to Controls; down to "Invert gamepad Y";
    // A switches it on; B closes
    await press(9);
    await expect(backdrop).toBeVisible();
    const selected = page.locator('.settings-tabs [aria-selected=true]');
    await expect(selected).toHaveText('Video');
    await press(5);
    await expect(selected).toHaveText('Interface');
    await press(5);
    await press(5);
    await expect(selected).toHaveText('Controls');
    const invert = page.locator('.settings-row', { hasText: 'Invert gamepad Y' });
    for (let n = 0; n < 6 && !(await invert.evaluate((e) => e.classList.contains('current'))); n++) await press(13);
    await press(0);
    await expect(invert.locator('[role=switch]')).toHaveAttribute('aria-checked', 'true');
    await press(1);
    await expect(backdrop).toBeHidden();
    // the A that pressed the switch did not make anyone join or jump
    expect(await lab(page, (l) => l.stats().voxel.rejected)).toBe(0);
    // saved: a reload keeps both
    await page.reload();
    await page.waitForFunction(
        () => (window as unknown as { __riverLab?: { ready?: boolean } }).__riverLab?.ready === true,
        null,
        { timeout: 150_000 }
    );
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('uncivil.settings') ?? '{}'));
    expect(saved).toEqual({ fov: 54, invertPadY: true });
    await page.locator('.settings-chip').click();
    await page.locator('.settings-tabs button', { hasText: 'Video' }).click();
    await expect(fov.locator('output')).toHaveText('54°');
    expect(problems).toEqual([]);
});

test('UI boxes never overlap: portrait phone, portrait tablet, desktop and landscape phone', async ({ page }) => {
    const problems = await boot(page, '?level=yard&t=4&debug&quality=low#cell100');
    type Rect = { l: number; t: number; r: number; b: number };
    const rects = () =>
        page.evaluate(() => {
            const out: Record<string, { l: number; t: number; r: number; b: number } | null> = {};
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
                b.l >= 0 && b.t >= 0 && b.r <= w + 0.5 && b.b <= h + 0.5,
                `${label}: ${n} inside the viewport ${JSON.stringify(b)}`
            ).toBe(true);
            for (const m of names) if (m < n) expect(hit(r[n]!, r[m]!), `${label}: ${n} overlaps ${m}`).toBe(false);
        }
        return r;
    };
    for (const [w, h] of [
        [390, 844],
        [768, 1408],
        [1280, 720],
        [844, 390]
    ]) {
        await page.setViewportSize({ width: w, height: h });
        await page.waitForTimeout(400);
        await lab(page, (l) => (l as unknown as { showPanel(v: boolean): void }).showPanel(true));
        // the layout follows the HUD and dock sizes a frame after a resize (ResizeObserver); slow
        // software-GL frames on CI can take longer than a fixed wait, so retry until it settles
        await expect(async () => {
            const open = await assertLayout(`${w}x${h} panel open`, w, h);
            expect(open['.debug-panel']).not.toBeNull();
            expect(open['.hud']).not.toBeNull();
        }).toPass({ timeout: 20_000 });
        await lab(page, (l) => (l as unknown as { showPanel(v: boolean): void }).showPanel(false));
        await expect(async () => {
            await assertLayout(`${w}x${h} panel closed`, w, h);
        }).toPass({ timeout: 20_000 });
    }
    // narrow screens get >= 40 px touch targets
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.debug-chip').click();
    await page.waitForTimeout(200);
    for (const s of ['.debug-chip', '.settings-chip', '.debug-grid button']) {
        const box = await page.locator(s).first().boundingBox();
        expect(box!.height, `${s} touch height`).toBeGreaterThanOrEqual(40);
    }
    // the chip toggles the panel, H hides everything
    expect(await page.locator('.debug-panel').isVisible()).toBe(true);
    await page.locator('.debug-chip').click();
    expect(await page.locator('.debug-panel').isVisible()).toBe(false);
    await page.keyboard.press('KeyH');
    expect(await page.locator('.settings-chip').isVisible()).toBe(false);
    expect(await page.locator('.hud').isVisible()).toBe(false);
    await page.keyboard.press('KeyH');
    expect(await page.locator('.settings-chip').isVisible()).toBe(true);
    expect(problems).toEqual([]);
});

test('physics sandbox: grab and carry the plank, launch the ragdoll, switch to scripted props', async ({ page }) => {
    const problems = await boot(page, '?level=lab&t=0.01&quality=low&noui#cell100');
    await lab(page, (l) => l.action('pause')); // resume: the sandbox runs live from here
    await page.waitForTimeout(3000); // props settle
    const plank = (await lab(page, (l) => l.entities())).plank;
    // stand 1.6 m behind the plank (towards +Z) facing it, and aim the crosshair at it
    await page.evaluate(
        ([x, z]) => (window as unknown as { __riverLab: Lab }).__riverLab.setFirstPerson(x, z + 1.6, 0, -0.3),
        [plank.x, plank.z]
    );
    await lab(page, (l) => l.set('carry', false));
    await page.waitForTimeout(1500);
    const p = await lab(page, (l) => l.player());
    expect(p.grounded).toBe(true);
    const pitch = -Math.atan2(p.y + p.eyeHeight - plank.y, Math.hypot(plank.x - p.x, plank.z - p.z));
    await page.evaluate(
        ([x, z, pitch]) => (window as unknown as { __riverLab: Lab }).__riverLab.setFirstPerson(x, z + 1.6, 0, pitch),
        [plank.x, plank.z, pitch]
    );
    await page.waitForTimeout(500);
    await lab(page, (l) => l.input({ grab: true }));
    await page.waitForFunction(
        () => (window as unknown as { __riverLab: Lab }).__riverLab.player().holding === 4,
        null,
        {
            timeout: 60_000
        }
    );
    // look ahead: the hold point follows the view, so the plank is lifted to chest height
    await lab(page, (l) => l.look(0, 0));
    // lifted off the ground (software GL runs ~1 fps, so wait on sim progress, not wall time)
    await page.waitForFunction(
        (y0) => (window as unknown as { __riverLab: Lab }).__riverLab.entities().plank.y > y0 + 0.3,
        plank.y,
        { timeout: 120_000 }
    );
    expect((await lab(page, (l) => l.player())).holding).toBe(4);
    await lab(page, (l) => l.input({ throw: true }));
    // wait on sim progress, not wall time (slow CI runners simulate less per second)
    await page.waitForFunction(
        () => (window as unknown as { __riverLab: Lab }).__riverLab.player().holding === -1,
        null,
        {
            timeout: 60_000
        }
    );

    await lab(page, (l) => l.action('ragdoll'));
    await page.waitForFunction(
        () => (window as unknown as { __riverLab: Lab }).__riverLab.entities()['dummy-body'].visible,
        null,
        { timeout: 60_000 }
    );
    // the ragdoll's parts reach the voxel frames (wait on it, not wall time)
    await page.waitForFunction(
        () => (window as unknown as { __riverLab: Lab }).__riverLab.stats().voxel.objects >= 14,
        null,
        { timeout: 60_000 }
    );
    const e = await lab(page, (l) => l.entities());
    expect(e['dummy-body'].visible).toBe(true);
    let s = await lab(page, (l) => l.stats());
    expect(s.voxel.objects).toBeGreaterThanOrEqual(14);
    expect(s.voxel.rejected).toBe(0);

    await lab(page, (l) => l.set('props', 'scripted'));
    await lab(page, (l) => l.seek(5));
    await idle(page);
    s = await lab(page, (l) => l.stats());
    expect((await lab(page, (l) => l.entities())).plank.y).toBeGreaterThan(1.2); // the hovering specimen
    expect(s.voxel.objects).toBeGreaterThanOrEqual(7); // Epic 1 props (plus the comfort plank if carried)
    expect(problems).toEqual([]);
});

test('level 1, the Timber Yard: starts in first person with the objective, and the bucket delivery completes it', async ({
    page
}) => {
    const problems = await boot(page, '?level=yard&t=0.01&quality=low#cell100');
    expect(await lab(page, (l) => l.level)).toBe('yard');
    const st = await lab(page, (l) => l.state as unknown as { mode: string });
    expect(st.mode).toBe('firstPerson');
    await expect(page.locator('#hud-objective')).toContainText('bucket across the creek');
    const s = await lab(page, (l) => l.stats());
    // beaver, ute, bucket, six planks, two beams, three logs, the crate, the windsock, and logging:
    // the axe, the sawmill and the six stand markers (their cut band hidden until a tree is bitten)
    expect(s.voxel.objects).toBe(24);
    expect(s.voxel.rejected).toBe(0);
    const g = await page.evaluate(() => (window as unknown as { __riverLab: Lab }).__riverLab.verifyGrid());
    expect(g.misaligned).toBe(0);
    // deliver the bucket by hand (teleport) and let the sim run
    await lab(page, (l) => l.action('pause'));
    await lab(page, (l) => l.placeProp('bucket', -1, 1.2, -7));
    await page.waitForFunction(
        () => (window as unknown as { __riverLab: Lab }).__riverLab.progress().goalReached,
        null,
        { timeout: 120_000 }
    );
    await expect(page.locator('#hud-objective')).toHaveClass(/done/);
    await expect(page.locator('.toast')).toContainText('delivered');
    expect(problems).toEqual([]);
});

test('the Timber Yard ute: get in, drive it with the keyboard, get out', async ({ page }) => {
    test.setTimeout(300_000);
    // ?t= seeks and pauses (so boot can wait for the voxels); the pause action resumes it
    const problems = await boot(page, '?level=yard&t=0.01&quality=low#cell100');
    await lab(page, (l) => l.action('pause'));
    const u0 = await lab(page, (l) => l.ute());
    expect(u0.drivable).toBe(true);
    expect(u0.driver).toBe(-1);
    // stand by the driver's door (the ute's right, local -x) and look at it
    const sx = -Math.cos(u0.yaw);
    const sz = Math.sin(u0.yaw);
    await page.evaluate(
        ([x, z, yaw]) => {
            const l = (window as unknown as { __riverLab: Lab }).__riverLab;
            l.teleport(x, z, yaw);
            // down at the door from a beaver's 1.22 m eye
            l.look(yaw, -0.35);
        },
        [u0.x + sx * 2.2, u0.z + sz * 2.2, Math.atan2(sx, sz)]
    );
    // (no pointer lock in a headless browser, so read the prompt's source rather than the HUD)
    await page.waitForFunction(
        () => (window as unknown as { __riverLab: Lab }).__riverLab.interaction().target === 'ute',
        null,
        { timeout: 60_000 }
    );
    await lab(page, (l) => l.input({ grab: true }));
    await page.waitForFunction(() => (window as unknown as { __riverLab: Lab }).__riverLab.ute().driver === 0, null, {
        timeout: 30_000
    });
    expect(await lab(page, (l) => l.interaction().driving)).toBe(true);
    // look ahead along the ute and drive forward
    await page.evaluate(
        (yaw) => (window as unknown as { __riverLab: Lab }).__riverLab.look(yaw + Math.PI, -0.1),
        u0.yaw
    );
    await page.keyboard.down('KeyW');
    await page.waitForFunction(
        ([x, z]) => {
            const u = (window as unknown as { __riverLab: Lab }).__riverLab.ute();
            return Math.hypot(u.x - x, u.z - z) > 2;
        },
        [u0.x, u0.z],
        { timeout: 120_000 }
    );
    await page.keyboard.up('KeyW');
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'test-results/ute-driving.png' });
    // get out
    await lab(page, (l) => l.input({ grab: true }));
    await page.waitForFunction(() => (window as unknown as { __riverLab: Lab }).__riverLab.ute().driver === -1, null, {
        timeout: 30_000
    });
    const p = await lab(page, (l) => l.player());
    const u1 = await lab(page, (l) => l.ute());
    expect(Math.hypot(p.x - u1.x, p.z - u1.z)).toBeGreaterThan(1);
    expect(problems).toEqual([]);
});

test('the Valley: one streamed map, stages advance in order and the world follows the player', async ({ page }) => {
    const problems = await boot(page, '?level=valley&t=0.01&quality=low#cell100');
    expect(await lab(page, (l) => l.level)).toBe('valley');
    await expect(page.locator('#hud-objective')).toContainText('1/7 Timber Yard');
    type V = Lab & { teleport(x: number, z: number, yaw?: number): void; nearTiles(): number };
    const v = <T>(fn: (l: V) => T) => lab(page, fn as unknown as (l: Lab) => T);
    const tilesAtStart = await v((l) => l.nearTiles());
    expect(tilesAtStart).toBeGreaterThan(10);
    // stage 1: the bucket by the flag at the old bridge (route frame u -4.8, t -3.4)
    await lab(page, (l) => l.action('pause'));
    const at = (u: number, t: number) => ({ x: -64 + (u + t) / Math.SQRT2, z: 62 + (t - u) / Math.SQRT2 });
    const g = at(-4.8, -3.4);
    await page.evaluate(
        (p) => (window as unknown as { __riverLab: Lab }).__riverLab.placeProp('bucket', p.x, 1.2, p.z),
        g
    );
    await expect(page.locator('#hud-objective')).toContainText('2/7 Shallow Creek', { timeout: 120_000 });
    await expect(page.locator('.toast')).toContainText('Timber Yard done');
    // walk (teleport) up to the gorge: the near world streams in around the player
    const gorge = at(80, 0);
    await page.evaluate(
        (p) =>
            (
                window as unknown as { __riverLab: { teleport(x: number, z: number, yaw: number): void } }
            ).__riverLab.teleport(p.x, p.z, -Math.PI / 4),
        gorge
    );
    await page.waitForFunction(
        (p) => {
            const l = (
                window as unknown as {
                    __riverLab: { player(): { x: number; z: number }; nearBuiltAt(x: number, z: number): boolean };
                }
            ).__riverLab;
            return Math.hypot(l.player().x - p.x, l.player().z - p.z) < 2 && l.nearBuiltAt(p.x, p.z);
        },
        gorge,
        { timeout: 180_000 }
    );
    const s = await lab(page, (l) => l.stats());
    expect(s.voxel.rejected).toBe(0);
    expect(problems).toEqual([]);
});

test('local co-op: split screen renders both views, player 2 moves with their own commands', async ({ page }) => {
    const problems = await boot(page, '?level=yard&t=0.01&quality=low&noui#cell100');
    await lab(page, (l) => l.action('pause'));
    await lab(page, (l) => (l as unknown as { setPlayers(n: number): void }).setPlayers(2));
    // face different ways: player 1 north to the creek, player 2 west towards the shed
    await lab(page, (l) => {
        l.look(0, -0.1);
        (l as unknown as { look2(y: number, p: number): void }).look2(1.57, -0.1);
    });
    await page.waitForTimeout(4000);
    const shot = PNG.sync.read(await page.screenshot());
    const rowBrightness = (y: number) => {
        let sum = 0;
        for (let x = 0; x < shot.width; x += 8) {
            const i = (y * shot.width + x) * 4;
            sum += shot.data[i] + shot.data[i + 1] + shot.data[i + 2];
        }
        return sum / (shot.width / 8) / 3;
    };
    // both halves draw a lit scene (a failed split leaves one half black)
    expect(rowBrightness(Math.floor(shot.height * 0.3))).toBeGreaterThan(30);
    expect(rowBrightness(Math.floor(shot.height * 0.8))).toBeGreaterThan(30);
    // and they are different views
    expect(
        Math.abs(rowBrightness(Math.floor(shot.height * 0.3)) - rowBrightness(Math.floor(shot.height * 0.8)))
    ).toBeGreaterThan(1);
    const s = await lab(page, (l) => l.stats());
    expect(s.voxel.objects).toBe(26); // the yard's 24 plus two voxel beaver bodies
    // player 2 walks on their own commands
    const before = await page.evaluate(
        () =>
            (
                window as unknown as { __riverLab: { entities(): Record<string, { x: number; z: number }> } }
            ).__riverLab.entities()['avatar-1']
    );
    // keep walking until player 2 has moved (slow CI runners simulate less per wall second)
    let moved = 0;
    for (let i = 0; i < 240 && moved <= 0.1; i++) {
        await lab(page, (l) =>
            (l as unknown as { input2(c: Record<string, unknown>): void }).input2({ moveZ: 1, yaw: 1.57 })
        );
        await page.waitForTimeout(250);
        const after = await page.evaluate(
            () =>
                (
                    window as unknown as { __riverLab: { entities(): Record<string, { x: number; z: number }> } }
                ).__riverLab.entities()['avatar-1']
        );
        moved = Math.hypot(after.x - before.x, after.z - before.z);
    }
    expect(moved).toBeGreaterThan(0.1);
    // back to one player: one full view, player 2's body gone (player 1 keeps theirs, drawn
    // without the head for their own camera)
    await lab(page, (l) => (l as unknown as { setPlayers(n: number): void }).setPlayers(1));
    // player 2's body leaves with the next applied voxel frame (wait on it: slow CI runners lag)
    await page.waitForFunction(
        () => (window as unknown as { __riverLab: Lab }).__riverLab.stats().voxel.objects === 25,
        null,
        { timeout: 60_000 }
    );
    expect(problems).toEqual([]);
});

// ?net=local links pages of one browser with BroadcastChannel (the same sessions run over the
// claude.ai room in the published artifact); ?net=p2p is the itch.io transport, WebRTC between the
// pages, signalled through a local Nostr relay instead of the public ones
for (const transport of ['local', 'p2p'] as const)
    test(`online co-op (${transport}): a second device joins the host, plays as player 2 and renders the host world`, async ({
        page,
        context
    }) => {
        // two full game pages in software GL: on a busy CI runner this has taken 1–5 minutes
        test.setTimeout(600_000);
        const relay = transport === 'p2p' ? await startRelay() : null;
        const query =
            transport === 'p2p'
                ? `?level=yard&t=0.01&quality=low&net=p2p&ice=local&relays=${encodeURIComponent(relay!.url)}#cell100`
                : '?level=yard&t=0.01&quality=low&net=local#cell100';
        const problems = await boot(page, query);
        const guest = await context.newPage();
        const guestProblems: string[] = [];
        guest.on('pageerror', (e) => guestProblems.push(e.message));
        await guest.goto(`/${query}`);
        await guest.waitForFunction(
            () => (window as unknown as { __riverLab?: Lab }).__riverLab?.ready === true,
            null,
            {
                timeout: 150_000
            }
        );
        type Net = {
            net: {
                host(): Promise<void>;
                games(): { code: string }[];
                join(c: string): Promise<void>;
                connect(): Promise<void>;
                leave(): void;
                status(): { hosting: string | null; guests: number; guest: { slot: number; received: number } | null };
            };
        };
        const net = (p: Page, src: string, arg?: unknown) =>
            p.evaluate(
                ([s, a]) =>
                    new Function('l', 'a', `return (${s})(l, a)`)(
                        (window as unknown as { __riverLab: Net }).__riverLab,
                        a
                    ),
                [src, arg] as const
            );

        await lab(page, (l) => l.action('pause'));
        // the peer-to-peer lobby connects when the online panel opens (here: by hand)
        await Promise.all([net(page, '(l) => l.net.connect()'), net(guest, '(l) => l.net.connect()')]);
        await net(page, '(l) => l.net.host()');
        const code = ((await net(page, '(l) => l.net.status()')) as { hosting: string }).hosting;
        expect(code).toMatch(/^[a-z0-9]{4}$/);
        await guest.waitForFunction(
            (c) => (window as unknown as { __riverLab: Net }).__riverLab.net.games().some((g) => g.code === c),
            code,
            { timeout: 120_000 }
        );
        await net(guest, '(l, c) => l.net.join(c)', code);
        await guest.waitForFunction(
            () => ((window as unknown as { __riverLab: Net }).__riverLab.net.status().guest?.received ?? 0) > 5,
            null,
            { timeout: 120_000 }
        );
        const g = (await net(guest, '(l) => l.net.status()')) as { guest: { slot: number } };
        expect(g.guest.slot).toBe(1);
        expect(((await net(page, '(l) => l.net.status()')) as { guests: number }).guests).toBe(1);

        // the guest's input moves player 2 on the host
        const where = () =>
            page.evaluate(
                () =>
                    (
                        window as unknown as {
                            __riverLab: { entities(): Record<string, { x: number; z: number; visible: boolean }> };
                        }
                    ).__riverLab.entities()['avatar-1']
            );
        const before = await where();
        expect(before.visible).toBe(true);
        // hold W on the guest until player 2 has moved on the host: a held key reaches every guest
        // command, however few frames a slow CI runner draws (one-tick inputs barely moved it)
        await net(guest, '(l) => l.look(3.14, -0.1)');
        await guest.keyboard.down('KeyW');
        let moved = 0;
        for (let i = 0; i < 200 && moved <= 0.3; i++) {
            await guest.waitForTimeout(300);
            const after = await where();
            moved = Math.hypot(after.x - before.x, after.z - before.z);
        }
        await guest.keyboard.up('KeyW');
        expect(moved).toBeGreaterThan(0.3);
        // the guest renders the host's world: both beaver bodies and every prop, all on the grid
        // (voxel frames lag the snapshots in software GL, so wait for the frame that has both beavers)
        await guest.waitForFunction(
            () => (window as unknown as { __riverLab: Lab }).__riverLab.stats().voxel.objects === 26,
            null,
            { timeout: 60_000 }
        );
        const gs = await guest.evaluate(() => (window as unknown as { __riverLab: Lab }).__riverLab.stats());
        expect(gs.voxel.rejected).toBe(0);
        expect(
            (await guest.evaluate(() => (window as unknown as { __riverLab: Lab }).__riverLab.verifyGrid())).misaligned
        ).toBe(0);

        // leaving frees the slot on the host
        await net(guest, '(l) => l.net.leave()');
        await page.waitForFunction(
            () => (window as unknown as { __riverLab: Net }).__riverLab.net.status().guests === 0,
            null,
            { timeout: 30_000 }
        );
        await relay?.close();
        expect(problems).toEqual([]);
        expect(guestProblems).toEqual([]);
    });

// a bad network on purpose (?netsim: 150-250 ms one way, 10 % of updates lost), and a guest who
// reloads mid-game: the host keeps their player, and the same tab gets it back
test('online co-op over a bad network: the guest reloads and rejoins as the same player', async ({ page, context }) => {
    test.setTimeout(600_000);
    const query = '?level=yard&t=0.01&quality=low&net=local&netsim=150,100,0.1#cell100';
    const problems = await boot(page, query);
    const guest = await context.newPage();
    const guestProblems: string[] = [];
    guest.on('pageerror', (e) => guestProblems.push(e.message));
    const ready = (p: Page) =>
        p.waitForFunction(() => (window as unknown as { __riverLab?: Lab }).__riverLab?.ready === true, null, {
            timeout: 150_000
        });
    await guest.goto(`/${query}`);
    await ready(guest);
    type Status = {
        hosting: string | null;
        guests: number;
        dropped: number[];
        lag: (number | null)[];
        guest: { slot: number; received: number; lagMs: number | null } | null;
    };
    type Net = {
        net: {
            host(): Promise<void>;
            games(): { code: string }[];
            join(c: string): Promise<void>;
            status(): Status;
        };
    };
    const status = (p: Page) => p.evaluate(() => (window as unknown as { __riverLab: Net }).__riverLab.net.status());
    const until = (p: Page, src: string, timeout = 120_000) =>
        p.waitForFunction(
            (s) =>
                new Function('st', `return ${s}`)((window as unknown as { __riverLab: Net }).__riverLab.net.status()),
            src,
            { timeout, polling: 250 }
        );

    await page.evaluate(() => (window as unknown as { __riverLab: Net }).__riverLab.net.host());
    const code = (await status(page)).hosting!;
    await guest.waitForFunction(
        (c) => (window as unknown as { __riverLab: Net }).__riverLab.net.games().some((g) => g.code === c),
        code,
        { timeout: 120_000 }
    );
    await guest.evaluate((c) => (window as unknown as { __riverLab: Net }).__riverLab.net.join(c), code);
    await until(guest, '(st.guest?.received ?? 0) > 5');
    expect((await status(guest)).guest!.slot).toBe(1);
    // both sides measure the round trip: at least the two one-way delays
    await until(page, 'st.lag[0] !== null && st.lag[0] !== undefined');
    expect((await status(page)).lag[0]).toBeGreaterThanOrEqual(250);
    await until(guest, 'st.guest?.lagMs !== null');

    // player 2 walks well away from where a newcomer would appear (beside the host)
    const avatar2 = () =>
        page.evaluate(
            () =>
                (
                    window as unknown as {
                        __riverLab: { entities(): Record<string, { x: number; z: number }> };
                    }
                ).__riverLab.entities()['avatar-1']
        );
    const start = await avatar2();
    await guest.evaluate(() =>
        (window as unknown as { __riverLab: { look(y: number, p: number): void } }).__riverLab.look(3.14, -0.1)
    );
    await guest.keyboard.down('KeyW');
    let away = 0;
    for (let i = 0; i < 200 && away <= 1.5; i++) {
        await guest.waitForTimeout(300);
        const p = await avatar2();
        away = Math.hypot(p.x - start.x, p.z - start.z);
    }
    await guest.keyboard.up('KeyW');
    // (a fresh join would appear back on the start spot: 1.5 m off is well clear of 0.5 m)
    expect(away).toBeGreaterThan(1.5);
    await page.waitForTimeout(1500); // the last of the walk arrives and the player stops
    const left = await avatar2();

    // the guest reloads: the host holds player 2 where they stood...
    await guest.reload();
    await until(page, 'st.dropped.length === 1', 30_000);
    expect((await status(page)).dropped).toEqual([1]);
    expect((await status(page)).guests).toBe(0);
    // ...and the reloaded page gets that player back, still there (a fresh join would appear beside the host)
    await ready(guest);
    await until(guest, '(st.guest?.received ?? 0) > 5');
    expect((await status(guest)).guest!.slot).toBe(1);
    await until(page, 'st.guests === 1 && st.dropped.length === 0', 30_000);
    const back = await avatar2();
    expect(Math.hypot(back.x - left.x, back.z - left.z)).toBeLessThan(0.5);
    expect(problems).toEqual([]);
    expect(guestProblems).toEqual([]);
});

test("online co-op in the Valley: the guest streams its own world and follows the host's stages", async ({
    page,
    context
}) => {
    test.setTimeout(600_000);
    const query = '?level=valley&t=0.01&quality=low&net=local#cell100';
    const problems = await boot(page, query);
    const call = (p: Page, src: string, arg?: unknown) =>
        p.evaluate(
            ([s, a]) =>
                new Function('l', 'a', `return (${s})(l, a)`)(
                    (window as unknown as { __riverLab: unknown }).__riverLab,
                    a
                ),
            [src, arg] as const
        );
    await lab(page, (l) => l.action('pause'));
    await call(page, '(l) => l.net.connect()');
    await call(page, '(l) => l.net.host()');
    const code = ((await call(page, '(l) => l.net.status()')) as { hosting: string }).hosting;
    // the host's sim completes stage 1 before the guest's page loads (two Valley pages streaming at
    // once in software GL leave the host only a few frames a second)
    await page.evaluate(() =>
        (window as unknown as { __riverLab: Lab }).__riverLab.placeProp(
            'bucket',
            -64 + (-4.8 - 3.4) / Math.SQRT2,
            1.2,
            62 + (-3.4 + 4.8) / Math.SQRT2
        )
    );
    await expect(page.locator('#hud-objective')).toContainText('2/7', { timeout: 180_000 });
    // a second device joins: its objective is the host's stage, and its near world is its own
    const guest = await context.newPage();
    const guestProblems: string[] = [];
    guest.on('pageerror', (e) => guestProblems.push(e.message));
    await guest.goto(`/${query}`);
    await guest.waitForFunction(() => (window as unknown as { __riverLab?: Lab }).__riverLab?.ready === true, null, {
        timeout: 150_000
    });
    await call(guest, '(l) => l.net.connect()');
    await guest.waitForFunction(
        (c) =>
            (window as unknown as { __riverLab: { net: { games(): { code: string }[] } } }).__riverLab.net
                .games()
                .some((g) => g.code === c),
        code,
        { timeout: 120_000 }
    );
    await call(guest, '(l, c) => l.net.join(c)', code);
    await guest.waitForFunction(
        () =>
            ((
                window as unknown as { __riverLab: { net: { status(): { guest: { received: number } | null } } } }
            ).__riverLab.net.status().guest?.received ?? 0) > 5,
        null,
        { timeout: 120_000 }
    );
    await expect(guest.locator('#hud-objective')).toContainText('2/7 Shallow Creek', { timeout: 60_000 });
    expect(await call(guest, '(l) => l.nearTiles()')).toBeGreaterThan(10);
    const gs = await guest.evaluate(() => (window as unknown as { __riverLab: Lab }).__riverLab.stats());
    expect(gs.voxel.rejected).toBe(0);
    await call(guest, '(l) => l.net.leave()');
    expect(problems).toEqual([]);
    expect(guestProblems).toEqual([]);
});

test('a first visit starts the tutorial: step-by-step objective, the Levels menu lists the rest', async ({ page }) => {
    const problems = await boot(page, '?t=0.01&quality=low#cell100');
    expect(await lab(page, (l) => (l as unknown as { level: string }).level)).toBe('tutorial');
    await expect(page.locator('#hud-objective')).toContainText('Step 1/8');
    const s = await lab(page, (l) => l.stats());
    expect(s.voxel.rejected).toBe(0);
    await page.locator('.levels-chip').click();
    await expect(page.locator('.levels-panel')).toContainText('Timber Yard');
    await expect(page.locator('.levels-panel')).toContainText('Tutorial (playing)');
    expect(problems).toEqual([]);
});

test('the level designer opens on the starter level and places a box with a click', async ({ page }) => {
    const problems = await boot(page, '?level=custom&edit=1&quality=low#cell100');
    await expect(page.locator('.designer')).toContainText('Level designer');
    await page.locator('.designer-tools button', { hasText: 'Box' }).click();
    const box = (await page.locator('canvas').boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.6);
    const pieces = await lab(
        page,
        (l) => (l as unknown as { designer: { d: { pieces: unknown[] } } }).designer.d.pieces.length
    );
    expect(pieces).toBe(1);
    await expect(page.locator('.designer')).toContainText('not built yet');
    expect(problems).toEqual([]);
});

test('logging in the Timber Yard: chew a pine down, the voxel tree becomes a stump and a log; the sawmill lever sets beams', async ({
    page
}) => {
    test.setTimeout(300_000);
    const problems = await boot(page, '?level=yard&t=0.01&quality=low#cell100');
    await lab(page, (l) => l.action('pause'));
    expect((await lab(page, (l) => l.wood())).trees.length).toBe(6);
    // stand west of tree 2 (13.1, 7.3), looking at its trunk
    await lab(page, (l) => {
        l.teleport(12.1, 7.3, -Math.PI / 2);
        l.look(-Math.PI / 2, -0.75);
    });
    await page.waitForFunction(
        () => (window as unknown as { __riverLab: Lab }).__riverLab.interaction().target === 'tree-2',
        null,
        { timeout: 60_000 }
    );
    await page.screenshot({ path: 'test-results/logging-standing.png' });
    // a bite at a time: a bite takes 0.3 s of game time and presses in between are swallowed (the
    // software renderer runs the game slower than real time), so press again until it lands
    const tree2 = () => lab(page, (l) => l.wood().trees[2]);
    for (let n = 1; n <= 10 && (await tree2()).phase === 'standing'; n++) {
        for (let tries = 0; tries < 30; tries++) {
            await lab(page, (l) => l.input({ grab: true }));
            await page.waitForTimeout(500);
            const w = await tree2();
            if (w.phase === 'down' || w.cut >= n / 10 - 1e-6) break;
        }
    }
    await page.waitForFunction(
        () => (window as unknown as { __riverLab: Lab }).__riverLab.wood().trees[2].phase === 'down',
        null,
        { timeout: 60_000 }
    );
    // the felled log lies east; the static tree has gone from the voxel world, a stump stays (the
    // worker side is unit tested: tests/unit/forestry.test.ts; here, look at the screenshot)
    await page.waitForTimeout(4000);
    await lab(page, (l) => l.look(-Math.PI / 2 + 0.3, -0.45));
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'test-results/logging-felled.png' });
    // the sawmill's lever: walk up to the near post and grab it to set the saw to beams
    await lab(page, (l) => {
        // the lever is on the near (north) post: stand north of it, facing south (+z)
        l.teleport(4.8, 7.6, Math.PI);
        l.look(Math.PI, -0.58);
    });
    await page.waitForFunction(
        () => (window as unknown as { __riverLab: Lab }).__riverLab.interaction().target === 'sawmill',
        null,
        { timeout: 60_000 }
    );
    await page.screenshot({ path: 'test-results/logging-sawmill.png' });
    for (let tries = 0; tries < 20 && (await lab(page, (l) => l.wood().sawmill?.mode)) !== 'beam'; tries++) {
        await lab(page, (l) => l.input({ grab: true }));
        await page.waitForTimeout(500);
    }
    expect((await lab(page, (l) => l.wood())).sawmill?.mode).toBe('beam');
    expect(problems).toEqual([]);
});
