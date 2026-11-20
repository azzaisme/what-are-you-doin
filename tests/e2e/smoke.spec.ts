import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import pngjs from 'pngjs';

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
    player(): { x: number; y: number; z: number; holding: number; grounded: boolean };
    look(yaw: number, pitch: number): void;
    level: string;
    progress(): { goalReached: boolean; falls: number; recoveries: number; events: string[] };
    placeProp(name: string, x: number, y: number, z: number, yaw?: number): boolean;
};

const IGNORED = [/GPU stall due to ReadPixels/, /GL Driver Message/, /Powered by PlayCanvas/, /favicon/i, /status of 404/];

async function boot(page: Page, query = '?level=lab&t=4&noui'): Promise<string[]> {
    const problems: string[] = [];
    page.on('console', (m) => {
        if ((m.type() === 'error' || m.type() === 'warning') && !IGNORED.some((r) => r.test(m.text()))) problems.push(`${m.type()}: ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await page.goto(`/${query}`);
    await page.waitForFunction(() => (window as unknown as { __riverLab?: Lab }).__riverLab?.ready === true, null, { timeout: 150_000 });
    await idle(page);
    await page.waitForTimeout(1500);
    return problems;
}

/** Voxel frames are built in a worker: wait until none is in flight. */
async function idle(page: Page): Promise<void> {
    await page.waitForTimeout(150);
    await page.waitForFunction(() => (window as unknown as { __riverLab: Lab }).__riverLab.voxelIdle(), null, { timeout: 60_000 });
}

const lab = <T>(page: Page, fn: (l: Lab) => T) => page.evaluate((src) => new Function('l', `return (${src})(l)`)((window as unknown as { __riverLab: Lab }).__riverLab), fn.toString()) as Promise<T>;

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
    for (const hz of ['12', '30', '60', '20']) await page.evaluate((hz) => (window as unknown as { __riverLab: Lab }).__riverLab.set('hz', hz), hz);
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
    const range = page.locator('.cell-size input[type=range]');
    await expect(range).toHaveAttribute('min', '5');
    await expect(range).toHaveAttribute('max', '10');
});

test('UI boxes never overlap: portrait phone, portrait tablet, desktop and landscape phone', async ({ page }) => {
    const problems = await boot(page, '?t=4&debug&quality=low#cell100');
    type Rect = { l: number; t: number; r: number; b: number };
    const rects = () =>
        page.evaluate(() => {
            const out: Record<string, { l: number; t: number; r: number; b: number } | null> = {};
            for (const s of ['.hud', '.debug-panel', '.cell-size', '.debug-chip']) {
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
            expect(b.l >= 0 && b.t >= 0 && b.r <= w + 0.5 && b.b <= h + 0.5, `${label}: ${n} inside the viewport ${JSON.stringify(b)}`).toBe(true);
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
        await page.waitForTimeout(200);
        const open = await assertLayout(`${w}x${h} panel open`, w, h);
        expect(open['.debug-panel']).not.toBeNull();
        expect(open['.hud']).not.toBeNull();
        await lab(page, (l) => (l as unknown as { showPanel(v: boolean): void }).showPanel(false));
        await page.waitForTimeout(200);
        await assertLayout(`${w}x${h} panel closed`, w, h);
    }
    // narrow screens get >= 40 px touch targets
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.debug-chip').click();
    await page.waitForTimeout(200);
    for (const s of ['.debug-chip', '.cell-size button', '.debug-grid button']) {
        const box = await page.locator(s).first().boundingBox();
        expect(box!.height, `${s} touch height`).toBeGreaterThanOrEqual(40);
    }
    // the chip toggles the panel, H hides everything
    expect(await page.locator('.debug-panel').isVisible()).toBe(true);
    await page.locator('.debug-chip').click();
    expect(await page.locator('.debug-panel').isVisible()).toBe(false);
    await page.keyboard.press('KeyH');
    expect(await page.locator('.cell-size').isVisible()).toBe(false);
    expect(await page.locator('.hud').isVisible()).toBe(false);
    await page.keyboard.press('KeyH');
    expect(await page.locator('.cell-size').isVisible()).toBe(true);
    expect(problems).toEqual([]);
});

test('physics sandbox: grab and carry the plank, launch the ragdoll, switch to scripted props', async ({ page }) => {
    const problems = await boot(page, '?level=lab&t=0.01&quality=low&noui#cell100');
    await lab(page, (l) => l.action('pause')); // resume: the sandbox runs live from here
    await page.waitForTimeout(3000); // props settle
    const plank = (await lab(page, (l) => l.entities())).plank;
    // stand 1.6 m behind the plank (towards +Z) facing it, and aim the crosshair at it
    await page.evaluate(([x, z]) => (window as unknown as { __riverLab: Lab }).__riverLab.setFirstPerson(x, z + 1.6, 0, -0.3), [plank.x, plank.z]);
    await lab(page, (l) => l.set('carry', false));
    await page.waitForTimeout(1500);
    const p = await lab(page, (l) => l.player());
    expect(p.grounded).toBe(true);
    const pitch = -Math.atan2(p.y + 1.22 - plank.y, Math.hypot(plank.x - p.x, plank.z - p.z));
    await page.evaluate(([x, z, pitch]) => (window as unknown as { __riverLab: Lab }).__riverLab.setFirstPerson(x, z + 1.6, 0, pitch), [plank.x, plank.z, pitch]);
    await page.waitForTimeout(500);
    await lab(page, (l) => l.input({ grab: true }));
    await page.waitForTimeout(3000);
    expect((await lab(page, (l) => l.player())).holding).toBe(4);
    // look ahead: the hold point follows the view, so the plank is lifted to chest height
    await lab(page, (l) => l.look(0, 0));
    // lifted off the ground (software GL runs ~1 fps, so wait on sim progress, not wall time)
    await page.waitForFunction((y0) => (window as unknown as { __riverLab: Lab }).__riverLab.entities().plank.y > y0 + 0.3, plank.y, { timeout: 120_000 });
    expect((await lab(page, (l) => l.player())).holding).toBe(4);
    await lab(page, (l) => l.input({ throw: true }));
    await page.waitForTimeout(500);
    expect((await lab(page, (l) => l.player())).holding).toBe(-1);

    await lab(page, (l) => l.action('ragdoll'));
    await page.waitForFunction(() => (window as unknown as { __riverLab: Lab }).__riverLab.entities()['dummy-body'].visible, null, { timeout: 60_000 });
    await page.waitForTimeout(3000);
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

test('level 1, the Timber Yard: starts in first person with the objective, and the bucket delivery completes it', async ({ page }) => {
    const problems = await boot(page, '?t=0.01&quality=low#cell100');
    expect(await lab(page, (l) => l.level)).toBe('yard');
    const st = await lab(page, (l) => l.state as unknown as { mode: string });
    expect(st.mode).toBe('firstPerson');
    await expect(page.locator('#hud-objective')).toContainText('bucket across the creek');
    const s = await lab(page, (l) => l.stats());
    // beaver, ute, bucket, six planks, two beams, three logs, the crate
    expect(s.voxel.objects).toBe(15);
    expect(s.voxel.rejected).toBe(0);
    const g = await page.evaluate(() => (window as unknown as { __riverLab: Lab }).__riverLab.verifyGrid());
    expect(g.misaligned).toBe(0);
    // deliver the bucket by hand (teleport) and let the sim run
    await lab(page, (l) => l.action('pause'));
    await lab(page, (l) => l.placeProp('bucket', -1, 1.2, -7));
    await page.waitForFunction(() => (window as unknown as { __riverLab: Lab }).__riverLab.progress().goalReached, null, { timeout: 120_000 });
    await expect(page.locator('#hud-objective')).toHaveClass(/done/);
    await expect(page.locator('.toast')).toContainText('delivered');
    expect(problems).toEqual([]);
});
