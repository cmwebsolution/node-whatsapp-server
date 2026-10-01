import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireStorageLock, loadCredentials } from '../src/startup.js';

test('storage lock rejects duplicate owners with an actionable safe error and permits a clean restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wa-owner-'));
    try {
        const release = await acquireStorageLock(root);
        await assert.rejects(acquireStorageLock(root), { code: 'STORAGE_LOCKED' });
        await release();
        const releaseAgain = await acquireStorageLock(root);
        await releaseAgain();
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('a preexisting stale lock is preserved until an operator verifies its owner is gone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wa-stale-'));
    try {
        await mkdir(join(root, '.owner-lock'));
        await assert.rejects(acquireStorageLock(root), { code: 'STORAGE_LOCKED' });
        await assert.rejects(acquireStorageLock(root), { code: 'STORAGE_LOCKED' });
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('missing or malformed credentials return a safe diagnostic without secret content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wa-invalid-registry-'));
    const file = join(root, 'applications.json');
    try {
        await assert.rejects(loadCredentials(file), { code: 'CREDENTIALS_UNAVAILABLE' });
        await writeFile(file, '{"secret-value-not-for-logs":');
        await assert.rejects(loadCredentials(file), (error: unknown) => {
            assert.equal((error as { code: string }).code, 'CREDENTIALS_UNAVAILABLE');
            assert.ok(!(error as Error).message.includes('secret-value-not-for-logs'));
            return true;
        });
    } finally { await rm(root, { recursive: true, force: true }); }
});
