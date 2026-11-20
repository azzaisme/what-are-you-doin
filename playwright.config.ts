import fs from 'node:fs';

import { defineConfig } from '@playwright/test';

// Browser choice:
//  - CHROME_PATH set: use that browser.
//  - /usr/bin/google-chrome present (Linux CI / agent sandbox): use it with SwiftShader (no GPU).
//  - otherwise: Playwright's bundled Chromium (run `npx playwright install chromium` once).
// SwiftShader frame rates are NOT representative of real hardware.
const systemChrome = '/usr/bin/google-chrome';
const executablePath = process.env.CHROME_PATH || (fs.existsSync(systemChrome) ? systemChrome : undefined);
const software = process.env.SOFTWARE_GL === '1' || (!process.env.CHROME_PATH && executablePath === systemChrome);

export default defineConfig({
    testDir: 'tests/e2e',
    timeout: 300_000,
    workers: 1,
    reporter: [['list']],
    use: {
        baseURL: 'http://localhost:4173',
        viewport: { width: 1280, height: 720 },
        launchOptions: {
            executablePath,
            args: software ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'] : ['--ignore-gpu-blocklist', '--enable-webgl']
        }
    },
    webServer: {
        command: 'npx vite preview --port 4173 --strictPort',
        url: 'http://localhost:4173',
        reuseExistingServer: true,
        timeout: 60_000
    }
});
