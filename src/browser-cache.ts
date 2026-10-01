import { dirname, join, resolve } from 'node:path';

/** Build and runtime must locate the same browser outside disposable build folders. */
export function configureBrowserCache(env: NodeJS.ProcessEnv = process.env): string {
    const cache = env.PUPPETEER_CACHE_DIR
        ? resolve(env.PUPPETEER_CACHE_DIR)
        : join(dirname(resolve(env.APP_CREDENTIALS_FILE ?? './data/applications.json')), 'puppeteer');
    env.PUPPETEER_CACHE_DIR = cache;
    return cache;
}

configureBrowserCache();
