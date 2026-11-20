// Shared browser launch for capture scripts: same rules as playwright.config.ts.
import fs from 'node:fs';

import { chromium } from '@playwright/test';

export function launchBrowser() {
    const systemChrome = '/usr/bin/google-chrome';
    const executablePath = process.env.CHROME_PATH || (fs.existsSync(systemChrome) ? systemChrome : undefined);
    const software = process.env.SOFTWARE_GL === '1' || (!process.env.CHROME_PATH && executablePath === systemChrome);
    return chromium.launch({
        executablePath,
        args: software
            ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
            : ['--ignore-gpu-blocklist']
    });
}
