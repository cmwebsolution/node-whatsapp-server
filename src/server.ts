import { resolve } from 'node:path';
import { createApp } from './app.js';
import { acquireStorageLock, loadCredentials, StartupError } from './startup.js';
import { Sessions } from './service.js';
import { driver } from './driver.js';
async function main(): Promise<void> {
    process.umask(0o077);
    const root = resolve(process.env.SESSION_DIR ?? './data/sessions');
    const credentialsPath = process.env.APP_CREDENTIALS_FILE ?? './data/applications.json';
    const credentials = await loadCredentials(credentialsPath);
    const maxSessions = Number(process.env.MAX_SESSIONS ?? 20);
    const port = Number(process.env.PORT ?? 3001);
    if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 100 || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new StartupError('INVALID_CONFIGURATION', 'PORT must be 1–65535 and MAX_SESSIONS must be 1–100.');
    }
    const releaseLock = await acquireStorageLock(root);
    const sessions = new Sessions(root, key => driver(key, root), 20000, maxSessions);
    try {
        await sessions.restore();
    }
    catch {
        await sessions.shutdown().catch(() => {
        });
        await releaseLock();
        throw new StartupError('RESTORATION_UNAVAILABLE', 'Persisted sessions could not be restored. Check available capacity and protected storage.');
    }
    const host = process.env.HOST ?? '127.0.0.1';
    const server = createApp(sessions, credentials).listen(port, host, () => console.log(`WhatsApp service listening on http://${host}:${port}`));
    server.requestTimeout = 30000;
    server.headersTimeout = 10000;
    server.timeout = 45000;
    server.maxConnections = 200;
    server.on('error', () => {
        console.error('HTTP listener unavailable.');
        void shutdown(1);
    });
    let exiting = false;
    async function shutdown(exitCode = 0): Promise<void> {
        if (exiting) {
            return;
        }
        exiting = true;
        sessions.stopping = true;
        server.close();
        const deadline = setTimeout(() => process.exit(1), 30000);
        deadline.unref();
        try {
            await sessions.shutdown();
        }
        catch {
            console.error('Graceful session shutdown incomplete.');
            process.exit(1);
        }
        await releaseLock();
        process.exit(exitCode);
    }
    process.on('SIGTERM', () => void shutdown());
    process.on('SIGINT', () => void shutdown());
}
void main().catch((error: unknown) => {
    console.error(error instanceof StartupError ? `[${error.code}] ${error.message}` : "Service startup failed. Check configuration and protected storage.");
    process.exit(1);
});
