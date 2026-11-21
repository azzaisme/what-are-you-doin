// Quick capture: node scripts/shot.mjs "<query>" out.png [waitMs]
import { launchBrowser } from './browser.mjs';
const [, , query = '', out = 'artifacts/shot.png', wait = '1500'] = process.argv;
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
const t0 = Date.now();
await page.goto(`http://localhost:4173/${query}`);
await page.waitForFunction(() => window.__riverLab?.ready, null, { timeout: 120000 });
console.log('ready after', Date.now() - t0, 'ms');
await page.waitForTimeout(Number(wait));
await page.screenshot({ path: out });
const stats = await page.evaluate(() => window.__riverLab.stats());
console.log(JSON.stringify(stats));
console.log(
    logs
        .filter((l) => !l.includes('Powered by'))
        .slice(0, 30)
        .join('\n')
);
await browser.close();
