// Frozen-frame pixel comparison between two builds (the verify-pixels skill): captures fixed scenes
// with rendering frozen and reads the canvas back, then counts differing pixels.
//
// Usage:
//   node scripts/verify-pixels.mjs capture <base url> <label> <scenes.json>   -> .vp/<label>/*.raw
//   node scripts/verify-pixels.mjs compare <label a> <label b>
// e.g. serve each build with `npx vite preview --port 4391 --outDir <dir>`, capture both, compare.
// Capture the same build twice first: the two must match exactly, or the harness is noisy.
//
// A scene is { name, q (query string), cams: [...], fp?: true }. With no fp, a cam is
// [px, py, pz, fx, fy, fz] for the orbit camera, or null for the level's own view. With fp, a cam
// is [x, z, yaw, pitch]: the player is placed there in first person, then the sim runs on to an
// exact time (1 s, 2 s, ... for cam 0, 1, ...) and pauses, the same in every run.
// Frozen: the app's time scale is 0 and the water script's own clock is pinned, then exactly one
// frame is rendered and read back (480 x 270 canvas, SwiftShader unless CHROME_PATH is set).
// Each capture also saves the voxel stats' latticeMasks and latticeHidden beside it.
import fs from 'node:fs';
import path from 'node:path';

import { launchBrowser } from './browser.mjs';

const [cmd, ...args] = process.argv.slice(2);
const OUT = '.vp';
const hook = fs.readFileSync(
    path.join(import.meta.dirname, '../.claude/skills/inspect-runtime/scripts/devtools-hook.js'),
    'utf8'
);

async function capture(base, label, scenesFile) {
    const scenes = JSON.parse(fs.readFileSync(scenesFile, 'utf8'));
    fs.mkdirSync(`${OUT}/${label}`, { recursive: true });
    const browser = await launchBrowser();
    for (const sc of scenes) {
        const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
        await page.addInitScript(hook);
        await page.goto(`${base}/${sc.q}`);
        await page.waitForFunction(() => window.__riverLab?.ready === true, null, { timeout: 200_000 });
        for (const [i, cam] of sc.cams.entries()) {
            if (sc.fp)
                // place the player (two sim steps), then run the sim to a fixed time and pause there
                await page.evaluate(
                    ([c, t]) => {
                        window.__riverLab.setFirstPerson(...c);
                        window.__riverLab.seek(t);
                    },
                    [cam, 1 + i]
                );
            else if (cam) await page.evaluate((c) => window.__riverLab.setCamera(...c), cam);
            await page.waitForTimeout(2500);
            await page.waitForFunction(() => window.__riverLab.voxelIdle(), null, { timeout: 120_000 });
            await page.waitForTimeout(2500);
            const px = await page.evaluate(async () => {
                const app = [...globalThis.__playcanvasApps.keys()][0];
                app.autoRender = false;
                app.timeScale = 0;
                await new Promise((r) => app.once('frameend', r));
                await new Promise((r) => app.once('frameend', r));
                // the water script's own clock (wall time) drives its waves: pin it
                for (const e of app.root.find((n) => !!n.script))
                    for (const s of e.script.scripts) if ('_time' in s) s._time = 1;
                app.renderNextFrame = true;
                await new Promise((r) => app.once('frameend', r));
                const c = app.graphicsDevice.canvas;
                const gl = app.graphicsDevice.gl;
                const buf = new Uint8Array(c.width * c.height * 4);
                gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, buf);
                app.autoRender = true;
                app.timeScale = 1;
                let s = '';
                for (let i = 0; i < buf.length; i += 8192) s += String.fromCharCode(...buf.subarray(i, i + 8192));
                const v = window.__riverLab.stats().voxel;
                return { b64: btoa(s), masks: v.latticeMasks ?? null, hidden: v.latticeHidden ?? null };
            });
            const file = `${OUT}/${label}/${sc.name}-${i}`;
            fs.writeFileSync(`${file}.raw`, Buffer.from(px.b64, 'base64'));
            fs.writeFileSync(`${file}.json`, JSON.stringify({ latticeMasks: px.masks, latticeHidden: px.hidden }));
            console.log(`${label} ${sc.name}-${i}`);
        }
        await page.close();
    }
    await browser.close();
}

function compare(a, b) {
    for (const f of fs.readdirSync(`${OUT}/${a}`).filter((n) => n.endsWith('.raw'))) {
        const x = fs.readFileSync(`${OUT}/${a}/${f}`);
        const y = fs.readFileSync(`${OUT}/${b}/${f}`);
        let differ = 0;
        let worst = 0;
        for (let i = 0; i < x.length; i += 4) {
            let d = 0;
            for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(x[i + k] - y[i + k]));
            if (d > 0) differ++;
            worst = Math.max(worst, d);
        }
        const stats = fs.readFileSync(`${OUT}/${b}/${f.replace('.raw', '.json')}`, 'utf8');
        console.log(`${f}: ${differ} of ${x.length / 4} pixels differ (largest by ${worst}); ${b}: ${stats}`);
    }
}

if (cmd === 'capture') await capture(args[0], args[1], args[2]);
else if (cmd === 'compare') compare(args[0], args[1]);
else console.log('usage: capture <base url> <label> <scenes.json> | compare <label a> <label b>');
