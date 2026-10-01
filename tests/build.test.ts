import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('production build compiles and honors browser download opt-out for system-Chromium deployments', { timeout: 30000 }, async () => {
    const cache = await mkdtemp(join(tmpdir(), 'wa-build-browser-'));
    try {
        const npmCli = process.env.npm_execpath;
        assert.ok(npmCli, 'Run this test through npm test');
        const result = spawnSync(process.execPath, [npmCli, 'run', 'build'], {
            env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: 'true', PUPPETEER_CACHE_DIR: cache },
            encoding: 'utf8',
            timeout: 25000,
        });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /Skipping browser installation/);
        await access('dist/server.js');
        await assert.rejects(access(join(cache, 'chrome')));
    } finally {
        await rm(cache, { recursive: true, force: true });
    }
});


test('managed build fails safely when an explicit browser executable is absent', { timeout: 30000 }, async () => {
    const cache = await mkdtemp(join(tmpdir(), 'wa-build-missing-browser-'));
    try {
        const npmCli = process.env.npm_execpath;
        assert.ok(npmCli);
        const result = spawnSync(process.execPath, [npmCli, 'run', 'build'], {
            env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: 'false', PUPPETEER_CACHE_DIR: cache, CHROME_PATH: join(cache, 'missing-browser') },
            encoding: 'utf8',
            timeout: 25000,
        });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /BROWSER_INSTALL_FAILED/);
        assert.ok(!result.stderr.includes('Bearer'));
    } finally {
        await rm(cache, { recursive: true, force: true });
    }
});
