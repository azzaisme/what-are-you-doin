// Captures the Epic 1 review evidence from the production build (vite preview on :4173):
// JPEG screenshots in docs/screenshots and motion frames for docs/media/river-lab.mp4.
// Deterministic: every capture seeks the simulation to an exact time first.
// Usage: node scripts/capture.mjs [--video | --video-only]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

import { launchBrowser } from './browser.mjs';

const W = 1280;
const H = 720;
const OUT = 'docs/screenshots';
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync('docs/media', { recursive: true });

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.goto('http://localhost:4173/?t=4&noui');
await page.waitForFunction(() => window.__riverLab?.ready, null, { timeout: 240000 });
const L = (fn, arg) => page.evaluate(fn, arg);
const settle = (ms = 2600) => page.waitForTimeout(ms);
const shot = async (name) => {
    await settle();
    await page.screenshot({ path: `${OUT}/${name}.jpg`, type: 'jpeg', quality: 88 });
    console.log('captured', name);
};
const idle = async () => {
    await page.waitForTimeout(150);
    await page.waitForFunction(() => window.__riverLab.voxelIdle(), null, { timeout: 120000 });
};
const at = async (t) => {
    await L((t) => window.__riverLab.seek(t), t);
    await idle();
};
const cam = async (c) => L((c) => window.__riverLab.setCamera(...c), c);
const set = async (k, v) => L(([k, v]) => window.__riverLab.set(k, v), [k, v]);
const ent = async (name) => (await L(() => window.__riverLab.entities()))[name];

const videoOnly = process.argv.includes('--video-only');
if (!videoOnly) {
// 1. hero: default composition across the river
await at(4);
await cam([-1.5, 2.6, 5.5, -1.0, 0.8, -5.5]);
await shot('01-hero-across-river');

// 2. beaver portrait (standing phase, facing camera)
await at(18.6);
let b = await ent('beaver');
await cam([b.x + Math.sin(b.yaw) * 2.0, b.y + 1.05, b.z + Math.cos(b.yaw) * 2.0, b.x, b.y + 0.8, b.z]);
await shot('02-beaver-portrait');

// 3. beaver walking, three-quarter
await at(3.2);
b = await ent('beaver');
await cam([b.x + Math.sin(b.yaw + 0.9) * 2.4, b.y + 1.2, b.z + Math.cos(b.yaw + 0.9) * 2.4, b.x, b.y + 0.7, b.z]);
await shot('03-beaver-walking');

// 4. global grid overlay on moving and static geometry
await at(4);
await set('gridLines', true);
await cam([0.9, 1.9, 0.6, 1.5, 1.0, -4.4]);
await shot('04-grid-overlay');
await set('gridLines', false);

// 5/6. same instant: voxel reconstruction vs conventional smooth reference (debug only)
await at(5.3);
await cam([0.2, 1.8, 0.4, 0.4, 1.2, -4.5]);
await shot('05-voxel-plank-log');
await set('reference', true);
await idle();
await shot('06-reference-plank-log');
await set('reference', false);

// 7. ute close-up
await at(6.0);
const u = await ent('ute');
await cam([u.x + 3.2, 1.8, u.z + 4.0, u.x, 0.8, u.z]);
await shot('07-ute');

// 8. low reflection view: the mirror shows the same reconstructed cells
await at(9.0);
await cam([1.5, 0.35, 2.4, 1.5, 0.9, -5.0]);
await shot('08-reflection-low');

// 9. first person carrying a plank (plank is voxelized in world space)
await L(() => window.__riverLab.setFirstPerson(-0.8, 3.2, 0.15, -0.18));
await set('carry', true);
await at(4.5);
await shot('09-first-person-carry');
await set('mode', 'orbit');

// 10. plank rotation strip: fixed camera, six voxel frames
await cam([0.6, 1.7, 0.2, 0.6, 1.5, -3.4]);
for (let i = 0; i < 6; i++) {
    await at(10 + i * 0.25);
    await settle(1800);
    await page.screenshot({ path: `/tmp/strip-${i}.png`, clip: { x: W / 2 - 260, y: H / 2 - 200, width: 520, height: 400 } });
}
console.log('captured strip frames');

// 11. stress: 25 extra moving objects
await set('stress', '25');
await at(12);
await idle();
await cam([0, 6, 9.5, 0, 1.5, -1.5]);
await shot('11-stress-25');
await set('stress', '0');

const stats = await L(() => window.__riverLab.stats());
fs.writeFileSync('docs/screenshots/stats-at-capture.json', JSON.stringify(stats, null, 2));
}

// motion recording: deterministic frames at 30 fps, 20 Hz voxel clock, slowly moving camera
if (process.argv.includes('--video') || videoOnly) {
    // FRAME_START resumes an interrupted capture (frames are deterministic per index)
    const start = Number(process.env.FRAME_START || 0);
    if (!start) fs.rmSync('/tmp/frames', { recursive: true, force: true });
    fs.mkdirSync('/tmp/frames', { recursive: true });
    // software rendering is slow: a smaller frame, one render per captured frame
    await page.setViewportSize({ width: 960, height: 540 });
    const FPS = 24;
    const SECONDS = Number(process.env.SECONDS_LEN || 6);
    for (let f = start; f < FPS * SECONDS; f++) {
        const t = 2 + f / FPS;
        const a = f / (FPS * SECONDS);
        await at(t);
        // continuous dolly: the camera moves every frame, the voxels only on the 20 Hz clock
        await cam([-3.0 + a * 5.0, 1.9 - a * 0.4, 3.6 - a * 0.6, -1.4 + a * 4.6, 0.8, -6.0]);
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
        await page.screenshot({ path: `/tmp/frames/${String(f).padStart(4, '0')}.png` });
        if (f % 30 === 0) console.log('frame', f);
    }
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', '/tmp/frames/%04d.png', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', 'docs/media/river-lab.mp4']);
    console.log('video written');
}
await browser.close();
