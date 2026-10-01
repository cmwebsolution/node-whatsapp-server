import { chmod, mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Credentials } from './app.js';

export class StartupError extends Error {
    constructor(public code: string, message: string) {
        super(message);
    }
}

export async function loadCredentials(path: string): Promise<Credentials> {
    try {
        await chmod(path, 0o600);
        const credentials: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
            throw new Error();
        }
        const values = Object.values(credentials);
        if (!values.length || values.some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) || new Set(values).size !== values.length) {
            throw new Error();
        }
        return credentials as Credentials;
    } catch {
        throw new StartupError('CREDENTIALS_UNAVAILABLE', 'Application credentials are missing, invalid, or unreadable. Check APP_CREDENTIALS_FILE and provision the application.');
    }
}

export async function acquireStorageLock(root: string): Promise<() => Promise<void>> {
    const lock = resolve(root, '.owner-lock');
    try {
        await mkdir(root, { recursive: true, mode: 0o700 });
        await chmod(root, 0o700);
        await mkdir(lock, { mode: 0o700 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new StartupError('STORAGE_LOCKED', 'Session storage is already locked. Another instance may be running, or an unclean shutdown left .owner-lock. Verify no Node or Chromium client owns this storage before removing only that lock directory.');
        }
        throw new StartupError('STORAGE_UNAVAILABLE', 'Session storage is inaccessible. Check SESSION_DIR and its owner permissions.');
    }
    return async () => { await rm(lock, { recursive: true, force: true }); };
}
