// Scripted physics drop test evidence (Epic 2 gate): drops the plank with a fixed tilt and spin,
// rasterizes its continuous pose into the global grid at several ticks, and writes
//   docs/screenshots/epic2/drop-test-<cm>cm.png   front (X-Y) and top (X-Z) projections per capture
//   docs/screenshots/epic2/drop-test-<cm>cm.json  poses, rotation angles, cell counts, hashes
// Usage: node scripts/drop-test.ts            (UE_CELL_CM=10 for the 10 cm grid)
import fs from 'node:fs';

import pngjs from 'pngjs';

import { runDropTest } from '../src/sim/drop-test.ts';
import { initPhysics } from '../src/sim/physics/world.ts';
import { GRID_SIZE } from '../src/voxels/grid.ts';

const { PNG } = pngjs;
await initPhysics();
const TICKS = [0, 6, 12, 18, 24, 30, 36, 42, 48, 60, 90, 180];
const frames = runDropTest(TICKS);
const again = runDropTest(TICKS);
const deterministic = frames.every((f, i) => f.hash === again[i].hash);

const PANEL = 200;
const VIEW = 3; // metres shown per panel
const px = PANEL / (VIEW / GRID_SIZE); // pixels per cell
const W = PANEL * frames.length;
const H = PANEL * 2;
const png = new PNG({ width: W, height: H });
for (let i = 0; i < W * H; i++) png.data.set([24, 30, 36, 255], i * 4);

function rect(x0: number, y0: number, w: number, h: number, colour: number[]) {
    const c = colour.map((v) => Math.max(0, Math.min(255, Math.round(v))));
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(H, Math.ceil(y0 + h)); y++) {
        for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, Math.ceil(x0 + w)); x++)
            png.data.set(c, (y * W + x) * 4);
    }
}

frames.forEach((f, n) => {
    const ox = n * PANEL;
    const cx = Math.round(f.pose.p.x / GRID_SIZE);
    const cy = Math.round(f.pose.p.y / GRID_SIZE);
    const cz = Math.round(f.pose.p.z / GRID_SIZE);
    const half = PANEL / px / 2;
    // grid lines every 10 cells
    for (let g = -half; g <= half; g++) {
        if ((g + cx) % 10 === 0) rect(ox + (g + half) * px, 0, 1, H, [44, 52, 60, 255]);
        if ((g + cy) % 10 === 0) rect(ox, (half - g) * px, PANEL, 1, [44, 52, 60, 255]);
        if ((g + cz) % 10 === 0) rect(ox, PANEL + (g + half) * px, PANEL, 1, [44, 52, 60, 255]);
    }
    // front view (looking along -Z): colour by depth; top view (looking down): colour by height
    const front = new Map<string, number>();
    const top = new Map<string, number>();
    for (const [i, j, k] of f.cells) {
        const a = `${i},${j}`;
        front.set(a, Math.max(front.get(a) ?? -1e9, k));
        const b = `${i},${k}`;
        top.set(b, Math.max(top.get(b) ?? -1e9, j));
    }
    for (const [key, k] of front) {
        const [i, j] = key.split(',').map(Number);
        const shade = 150 + Math.max(-60, Math.min(80, (k - cz) * 12));
        rect(ox + (i - cx + half) * px, (half - (j - cy) - 1) * px, px, px, [
            shade + 40,
            shade * 0.75,
            shade * 0.45,
            255
        ]);
    }
    for (const [key, j] of top) {
        const [i, k] = key.split(',').map(Number);
        const shade = 150 + Math.max(-60, Math.min(80, (j - cy) * 12));
        rect(ox + (i - cx + half) * px, PANEL + (k - cz + half) * px, px, px, [
            shade * 0.55,
            shade * 0.8,
            shade + 40,
            255
        ]);
    }
    rect(ox + PANEL - 1, 0, 1, H, [90, 100, 110, 255]);
});
rect(0, PANEL - 1, W, 1, [90, 100, 110, 255]);

const cm = Math.round(GRID_SIZE * 1000) / 10;
fs.mkdirSync('docs/screenshots/epic2', { recursive: true });
fs.writeFileSync(`docs/screenshots/epic2/drop-test-${cm}cm.png`, PNG.sync.write(png));
const summary = {
    cellCm: cm,
    deterministic,
    note: 'columns = captures after the drop (ticks at 60 Hz); top row front view (X right, Y up), bottom row top view (X right, Z down); grid lines every 10 cells',
    frames: frames.map((f) => ({
        tick: f.tick,
        t: +(f.tick / 60).toFixed(3),
        y: +f.pose.p.y.toFixed(4),
        angleDeg: +((f.angle * 180) / Math.PI).toFixed(1),
        cells: f.cells.length,
        hash: f.hash
    }))
};
fs.writeFileSync(`docs/screenshots/epic2/drop-test-${cm}cm.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 1));
