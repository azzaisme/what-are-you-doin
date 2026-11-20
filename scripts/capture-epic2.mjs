// Epic 2 evidence screenshots into docs/screenshots/epic2 (production build served on :4173):
//   npm run build && npm run start &   then   node scripts/capture-epic2.mjs
// Software GL is slow (~0.5 fps at 5 cm), so waits are on simulation state, not wall time.
import { launchBrowser } from './browser.mjs';

const OUT = 'docs/screenshots/epic2';
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:4173/?noui&t=0.01');
await page.waitForFunction(() => window.__riverLab?.ready, null, { timeout: 180000 });
const L = (src, arg) => page.evaluate(([s, a]) => new Function('l', 'a', `return (${s})(l, a)`)(window.__riverLab, a), [src, arg]);
const waitSim = (src, arg, timeout = 180000) => page.waitForFunction(([s, a]) => new Function('l', 'a', `return (${s})(l, a)`)(window.__riverLab, a), [src, arg], { timeout, polling: 500 });
const shot = async (name) => {
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/${name}.jpg`, quality: 85 });
    console.log('saved', name);
};

await L('(l) => l.action("pause")');
await page.waitForTimeout(8000); // props settle

// 1. the sandbox at rest, from the near bank
await L('(l) => l.setCamera(3.2, 2.1, 8.6, -0.6, 0.3, 3.4)');
await shot('01-sandbox-props');

// 2. first person: look at the plank and grab it, then lift it to carry height
const plank = await L('(l) => l.entities().plank');
await L('(l, a) => { l.set("carry", false); l.setFirstPerson(a.x, a.z + 1.6, 0, -0.5); }', plank);
await page.waitForTimeout(2000);
const p = await L('(l) => l.player()');
const pitch = -Math.atan2(p.y + 1.22 - plank.y, Math.hypot(plank.x - p.x, plank.z - p.z));
await L('(l, a) => l.look(0, a)', pitch);
await page.waitForTimeout(1500);
await shot('02-fp-aim-prompt');
await L('(l) => l.input({ grab: true })');
await waitSim('(l) => l.player().holding === 4');
await L('(l) => l.look(0.25, -0.12)');
await waitSim('(l, y) => l.entities().plank.y > y + 0.6', plank.y);
await page.waitForTimeout(3000);
await shot('03-fp-carrying-plank');

// 3. throw it, then the ragdoll
await L('(l) => l.input({ throw: true, pitch: 0.3 })');
await page.waitForTimeout(3000);
await L('(l) => l.look(0, -0.15)');
await L('(l) => l.action("ragdoll")');
await waitSim('(l) => l.entities()["dummy-body"].visible');
await page.waitForTimeout(2500);
await shot('04-fp-ragdoll-launch');
await page.waitForTimeout(12000);
await L('(l) => { const d = l.entities()["dummy-body"]; l.setCamera(d.x + 2.2, d.y + 1.3, d.z + 2.2, d.x, d.y, d.z); }');
await shot('05-ragdoll-landed');

// 4. collider wireframes (debug only) over the voxel reconstruction
await L('(l) => l.setCamera(3.2, 2.1, 8.6, -0.6, 0.3, 3.4)');
await L('(l) => l.set("colliders", true)');
await shot('06-physics-colliders');
await L('(l) => l.set("colliders", false)');

// 5. 25 moving bodies
await L('(l) => l.set("stress", "25")');
await page.waitForTimeout(15000);
await L('(l) => l.setCamera(1, 5.5, 12, 0, 1, 2)');
await shot('07-stress-25-bodies');
const s = await L('(l) => l.stats()');
console.log(JSON.stringify({ physics: s.physics, voxel: { objects: s.voxel.objects, rejected: s.voxel.rejected, totalMs: s.voxel.totalMs } }));
console.log('page errors', errors);
await browser.close();
