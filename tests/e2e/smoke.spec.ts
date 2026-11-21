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
    const range = page.locator('.cell-size input[type=range]');
    await expect(range).toHaveAttribute('min', '5');
    await expect(range).toHaveAttribute('max', '10');
});

test('UI boxes never overlap: portrait phone, portrait tablet, desktop and landscape phone', async ({ page }) => {
    const problems = await boot(page, '?level=yard&t=4&debug&quality=low#cell100');
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
    await page.evaluate(
        ([x, z]) => (window as unknown as { __riverLab: Lab }).__riverLab.setFirstPerson(x, z + 1.6, 0, -0.3),
        [plank.x, plank.z]
    );
    await lab(page, (l) => l.set('carry', false));
    await page.waitForTimeout(1500);
    const p = await lab(page, (l) => l.player());
    expect(p.grounded).toBe(true);
    const pitch = -Math.atan2(p.y + 1.22 - plank.y, Math.hypot(plank.x - p.x, plank.z - p.z));
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
    // beaver, ute, bucket, six planks, two beams, three logs, the crate, the windsock
    expect(s.voxel.objects).toBe(16);
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
    expect(s.voxel.objects).toBe(18); // the yard's 16 plus two voxel beaver bodies
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
    // back to one player: one full view, bodies hidden
    await lab(page, (l) => (l as unknown as { setPlayers(n: number): void }).setPlayers(1));
    // the bodies leave with the next applied voxel frame (wait on it: slow CI runners lag)
    await page.waitForFunction(
        () => (window as unknown as { __riverLab: Lab }).__riverLab.stats().voxel.objects === 16,
        null,
        { timeout: 60_000 }
    );
    expect(problems).toEqual([]);
});

test('online co-op: a second device joins the host, plays as player 2 and renders the host world', async ({
    page,
    context
}) => {
    // ?net=local links pages of one browser with BroadcastChannel; the same sessions run over the
    // claude.ai room in the published artifact
    const query = '?level=yard&t=0.01&quality=low&net=local#cell100';
    const problems = await boot(page, query);
    const guest = await context.newPage();
    const guestProblems: string[] = [];
    guest.on('pageerror', (e) => guestProblems.push(e.message));
    await guest.goto(`/${query}`);
    await guest.waitForFunction(() => (window as unknown as { __riverLab?: Lab }).__riverLab?.ready === true, null, {
        timeout: 150_000
    });
    type Net = {
        net: {
            host(): Promise<void>;
            games(): { code: string }[];
            join(c: string): Promise<void>;
            leave(): void;
            status(): { hosting: string | null; guests: number; guest: { slot: number; received: number } | null };
        };
    };
    const net = (p: Page, src: string, arg?: unknown) =>
        p.evaluate(
            ([s, a]) =>
                new Function('l', 'a', `return (${s})(l, a)`)((window as unknown as { __riverLab: Net }).__riverLab, a),
            [src, arg] as const
        );

    await lab(page, (l) => l.action('pause'));
    await net(page, '(l) => l.net.host()');
    const code = ((await net(page, '(l) => l.net.status()')) as { hosting: string }).hosting;
    expect(code).toMatch(/^[a-z0-9]{4}$/);
    await guest.waitForFunction(
        (c) => (window as unknown as { __riverLab: Net }).__riverLab.net.games().some((g) => g.code === c),
        code,
        { timeout: 30_000 }
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
    // keep walking until player 2 has moved on the host (slow CI runners simulate less per second)
    let moved = 0;
    for (let i = 0; i < 300 && moved <= 0.3; i++) {
        await net(guest, '(l) => { l.look(3.14, -0.1); l.input({ moveZ: 1 }); }');
        await guest.waitForTimeout(300);
        const after = await where();
        moved = Math.hypot(after.x - before.x, after.z - before.z);
    }
    expect(moved).toBeGreaterThan(0.3);
    // the guest renders the host's world: both beaver bodies and every prop, all on the grid
    // (voxel frames lag the snapshots in software GL, so wait for the frame that has both beavers)
    await guest.waitForFunction(
        () => (window as unknown as { __riverLab: Lab }).__riverLab.stats().voxel.objects === 18,
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
