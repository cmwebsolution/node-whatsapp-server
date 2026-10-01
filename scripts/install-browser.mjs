import '../dist/browser-cache.js';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const skip = !['', '0', 'false', 'off'].includes((process.env.PUPPETEER_SKIP_DOWNLOAD ?? '').toLowerCase());
if (skip) {
    console.log('Skipping browser installation: system-Chromium deployment or CI.');
} else {
    try {
        if (process.env.CHROME_PATH) {
            await access(process.env.CHROME_PATH);
            console.log('Using configured CHROME_PATH; no browser download required.');
        } else {
            const result = spawnSync(process.execPath, [require.resolve('puppeteer/install.mjs')], {
                env: process.env,
                stdio: 'inherit',
            });
            if (result.error || result.status !== 0) throw new Error();
            const { default: puppeteer } = await import('puppeteer');
            await access(puppeteer.executablePath());
            console.log('Browser installation verified in the configured cache.');
        }
    } catch {
        console.error('[BROWSER_INSTALL_FAILED] Chrome could not be installed or found. Check the writable persistent cache, download access, and CHROME_PATH.');
        process.exit(1);
    }
}
