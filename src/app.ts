import express from 'express';
import { validateMedia } from './media.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ApiError, Sessions, keyFor } from './service.js';
export type Credentials = Record<string, string>;
export function createApp(sessions: Sessions, credentials: Credentials) {
    const app = express();
    app.disable('x-powered-by');
    app.use((_req, res, next) => {
        res.set('Cache-Control', 'no-store');
        next();
    });
    app.get('/', (_req, res) => res.json({ success: true, service: 'WhatsApp service', health: '/health', ready: '/ready' }));
    app.get('/health', (_req, res) => res.json({ success: true }));
    app.get('/ready', (_req, res) => res.status(sessions.stopping ? 503 : 200).json({ success: !sessions.stopping }));
    const limits = new Map<string, {
        count: number;
        until: number;
    }>();
    const limit = (key: string, max: number) => {
        const now = Date.now();
        if (limits.size > 10000) {
            for (const [k, v] of limits) {
                if (v.until < now) {
                    limits.delete(k);
                }
            }
        }
        let v = limits.get(key);
        if (!v || v.until < now) {
            v = { count: 0, until: now + 60000 };
            limits.set(key, v);
        }
        if (++v.count > max) {
            throw new ApiError(429, 'RATE_LIMITED', 'Request limit exceeded.');
        }
    };
    app.use('/api', (req, res, next) => {
        try {
            if (sessions.stopping) {
                throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Service is shutting down.');
            }
            const token = /^Bearer (\S+)$/.exec(req.get('Authorization') ?? '')?.[1];
            if (!token || token.length > 512) {
                throw new ApiError(401, 'UNAUTHENTICATED', 'Valid bearer credential required.');
            }
            const hash = createHash('sha256').update(token).digest();
            const owner = Object.entries(credentials).find(([, digest]) => timingSafeEqual(hash, Buffer.from(digest, 'hex')))?.[0];
            if (!owner) {
                throw new ApiError(401, 'UNAUTHENTICATED', 'Valid bearer credential required.');
            }
            if (req.get('X-WhatsApp-App-Id') !== owner) {
                throw new ApiError(403, 'FORBIDDEN', 'Credential is not authorized for this application.');
            }
            res.locals.appId = owner;
            limit(`app:${owner}`, 120);
            next();
        }
        catch (e) {
            next(e);
        }
    });
    app.use('/api/whatsapp/:user_id/send-media', express.json({limit: '12mb', strict: true}));
    app.use(express.json({ limit: '24kb', strict: true }));
    const user = (value: unknown): string => {
        if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > 256) {
            throw new ApiError(422, 'INVALID_INPUT', 'user_id must be a nonempty string up to 256 bytes.');
        }
        return value;
    };
    app.post('/api/whatsapp/connect', async (req, res) => {
        const u = user(req.body?.user_id);
        limit(keyFor(res.locals.appId, u), 30);
        res.json(await sessions.connect(res.locals.appId, u));
    });
    app.get('/api/whatsapp/:user_id/status', async (req, res) => {
        const u = user(req.params.user_id);
        limit(keyFor(res.locals.appId, u), 30);
        res.json(await sessions.status(res.locals.appId, u));
    });
    app.get('/api/whatsapp/:user_id/qr', async (req, res) => {
        const u = user(req.params.user_id);
        limit(keyFor(res.locals.appId, u), 30);
        res.json(await sessions.status(res.locals.appId, u, true));
    });
    app.post('/api/whatsapp/:user_id/disconnect', async (req, res) => {
        const u = user(req.params.user_id);
        limit(keyFor(res.locals.appId, u), 30);
        res.json(await sessions.disconnect(res.locals.appId, u));
    });
    app.post('/api/whatsapp/:user_id/send-message', async (req, res) => {
        const u = user(req.params.user_id);
        limit(keyFor(res.locals.appId, u), 30);
        const { phone, message } = req.body ?? {};
        if (typeof phone !== 'string' || !/^[1-9]\d{6,14}$/.test(phone) || typeof message !== 'string' || !message.trim() || [...message].length > 4096) {
            throw new ApiError(422, 'INVALID_INPUT', 'Provide international digits and a nonblank message up to 4096 characters.');
        }
        res.json(await sessions.send(res.locals.appId, u, phone, message));
    });
    app.post('/api/whatsapp/:user_id/send-media', async (req, res) => {
        const id = user(req.params.user_id);
        limit(keyFor(res.locals.appId, id), 30);
        const { phone, media } = req.body ?? {};
        if (typeof phone !== 'string' || !/^[1-9]\d{6,14}$/.test(phone)) throw new ApiError(422, 'INVALID_INPUT', 'Provide international digits for the recipient.');
        res.json(await sessions.sendMedia(res.locals.appId, id, phone, validateMedia(media)));
    });
    app.use((_req, res) => res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Endpoint not found.' }));
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        const e = err as {
            type?: string;
        };
        const safe = err instanceof ApiError ? err : new ApiError(e.type === 'entity.too.large' || err instanceof SyntaxError ? 422 : 503, e.type === 'entity.too.large' || err instanceof SyntaxError ? 'INVALID_INPUT' : 'SERVICE_UNAVAILABLE', 'Request could not be processed.');
        res.status(safe.status).json({ success: false, code: safe.code, message: safe.message });
    });
    return app;
}
