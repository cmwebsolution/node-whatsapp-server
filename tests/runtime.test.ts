import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { once } from 'node:events';

async function unusedPort(): Promise<number> {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const port = address.port;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return port;
}

test('compiled provisioning and server run without .env and preserve safe startup/shutdown', { timeout: 15000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'wa-runtime-'));
    const registry = join(root, 'applications.json');
    const sessions = join(root, 'sessions');
    const env = { ...process.env, APP_CREDENTIALS_FILE: registry, SESSION_DIR: sessions, HOST: '127.0.0.1', MAX_SESSIONS: '2' };
    let child: ReturnType<typeof spawn> | undefined;
    let stopped: Promise<unknown> | undefined;
    try {
        const provision = spawnSync(process.execPath, ['--env-file-if-exists=.env', fileURLToPath(new URL('../src/provision.js', import.meta.url)), 'release-test'], { cwd: root, env, encoding: 'utf8' });
        assert.equal(provision.status, 0, provision.stderr);
        const token = (await readFile(join(root, 'credentials', 'release-test.token'), 'utf8')).trim();
        assert.ok(!provision.stdout.includes(token));
        assert.ok(!provision.stderr.includes(token));
        const credentials = JSON.parse(await readFile(registry, 'utf8'));
        assert.equal(credentials['release-test'], createHash('sha256').update(token).digest('hex'));

        const port = await unusedPort();
        child = spawn(process.execPath, ['--env-file-if-exists=.env', fileURLToPath(new URL('../src/server.js', import.meta.url))], { cwd: root, env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
        stopped = once(child, 'exit');
        let output = '';
        child.stdout?.on('data', chunk => { output += chunk.toString(); });
        child.stderr?.on('data', chunk => { output += chunk.toString(); });
        const base = `http://127.0.0.1:${port}`;
        let started = false;
        for (let attempt = 0; attempt < 100; attempt++) {
            assert.equal(child.exitCode, null, output);
            try {
                const response = await fetch(`${base}/ready`);
                if (response.ok) { started = true; break; }
            } catch { /* The process may still be loading dependencies. */ }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.ok(started, output);
        const health = await fetch(`${base}/health`);
        assert.deepEqual(await health.json(), { success: true });
        const denied = await fetch(`${base}/api/whatsapp/check/status`);
        assert.equal(denied.status, 401);
        const status = await fetch(`${base}/api/whatsapp/check/status`, { headers: { Authorization: `Bearer ${token}`, 'X-WhatsApp-App-Id': 'release-test' } });
        assert.equal(status.status, 200);
        assert.deepEqual(await status.json(), { success: true, status: 'disconnected', phone: null });
        assert.ok(!output.includes(token));
        child.kill('SIGTERM');
        await stopped;
        assert.equal(child.exitCode, 0, output);
        await assert.rejects(access(join(sessions, '.owner-lock')));
        await access(registry);
    } finally {
        if (child && child.exitCode === null) { child.kill('SIGTERM'); await stopped; }
        await rm(root, { recursive: true, force: true });
    }
});
