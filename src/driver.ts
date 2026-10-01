import './browser-cache.js';
import whatsapp from 'whatsapp-web.js';
import { EventEmitter } from 'node:events';
import type { Driver } from './service.js';
export function acceptedMessageId(message: unknown): string | null {
    const id = (message as {id?: {_serialized?: unknown; $1?: unknown}} | undefined)?.id;
    const value = id?._serialized ?? id?.$1;
    if (typeof value !== 'string' || !value.trim()) {
        return null;
    }
    return value;
}
export function driver(key: string, root: string): Driver {
    const client = new whatsapp.Client({
        authStrategy: new whatsapp.LocalAuth({ clientId: key, dataPath: root }),
        authTimeoutMs: 60000,
        qrMaxRetries: 10,
        puppeteer: {
            headless: true,
            timeout: 30000,
            executablePath: process.env.CHROME_PATH || undefined,
            args: process.env.CHROME_NO_SANDBOX === 'true' ? ['--no-sandbox', '--disable-setuid-sandbox'] : [],
        },
    });
    return createDriver(client);
}
export function createDriver(client: whatsapp.Client): Driver {
    const bridge = new EventEmitter() as Driver;
    let initialization: Promise<void> | undefined;
    let stopping = false;
    let destruction: Promise<void> | undefined;
    let authenticated = false;
    client.on('authenticated', () => {
        authenticated = true;
    });
    for (const event of ['qr', 'ready', 'authenticated', 'disconnected', 'auth_failure']) {
        client.on(event, (...args: unknown[]) => {
            if (!stopping) {
                bridge.emit(event, ...args);
            }
        });
    }
    bridge.initialize = () => {
        initialization = client.initialize();
        return initialization;
    };
    const destroy = async () => {
        stopping = true;
        // Closing while initialize launches must also close a browser assigned later.
        const interval = setInterval(() => {
            void client.destroy().catch(() => {
            });
        }, 100);
        try {
            await client.destroy();
            await initialization?.catch(() => {
            });
            await client.destroy();
        }
        finally {
            clearInterval(interval);
        }
    };
    bridge.destroy = () => destruction ??= destroy();
    bridge.logout = async () => {
        if (authenticated) {
            await client.logout();
        }
    };
    bridge.phone = () => client.info?.wid?.user ?? null;
    bridge.ready = async () => !stopping && await client.getState() === 'CONNECTED';
    bridge.send = async (phone, message) => acceptedMessageId(await client.sendMessage(`${phone}@c.us`, message, {sendSeen: false, waitUntilMsgSent: true}));
    bridge.sendMedia = async (phone, media) => {
        const attachment = new whatsapp.MessageMedia(media.mimetype, media.data, media.filename);
        return acceptedMessageId(await client.sendMessage(`${phone}@c.us`, attachment, {sendSeen: false, waitUntilMsgSent: true, caption: media.caption, sendMediaAsDocument: media.mimetype === 'application/pdf'}));
    };
    return bridge;
}
