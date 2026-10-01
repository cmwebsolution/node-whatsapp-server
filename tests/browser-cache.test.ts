import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { configureBrowserCache } from '../src/browser-cache.js';

test('browser cache follows persistent credential storage and respects explicit overrides', () => {
    const env = { APP_CREDENTIALS_FILE: '/private/whatsapp/applications.json' } as NodeJS.ProcessEnv;
    assert.equal(configureBrowserCache(env), '/private/whatsapp/puppeteer');
    assert.equal(env.PUPPETEER_CACHE_DIR, '/private/whatsapp/puppeteer');
    assert.equal(configureBrowserCache({ PUPPETEER_CACHE_DIR: '/private/custom-browser', APP_CREDENTIALS_FILE: '/other/applications.json' }), '/private/custom-browser');
    assert.equal(configureBrowserCache({}), join(dirname(resolve('./data/applications.json')), 'puppeteer'));
});

test('the real runtime initializes Puppeteer with the persistent cache before loading the WhatsApp client', () => {
    const env: NodeJS.ProcessEnv = { ...process.env, APP_CREDENTIALS_FILE: '/private/runtime/applications.json' };
    delete env.PUPPETEER_CACHE_DIR;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        await import('./.test-build/src/driver.js');
        const { default: puppeteer } = await import('puppeteer');
        if (puppeteer.configuration.cacheDirectory !== '/private/runtime/puppeteer') process.exit(1);
    `], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
});
