import { createHash } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import QRCode from 'qrcode';
import type { Media } from './media.js';
export class ApiError extends Error {
    constructor(public status: number, public code: string, message: string) {
        super(message);
    }
}
export interface Driver extends EventEmitter {
    initialize(): Promise<void>;
    destroy(): Promise<void>;
    logout(): Promise<void>;
    phone(): string | null;
    ready(): Promise<boolean>;
    send(phone: string, message: string): Promise<string | null>;
    sendMedia(phone: string, media: Media): Promise<string | null>;
}
type Session = {
    status: 'disconnected' | 'connecting' | 'qr_required' | 'connected';
    phone: string | null;
    qr: string | null;
    expires: number;
    client?: Driver;
    generation: number;
    connectingSince: number;
    recoveries: number;
    hasReady: boolean;
    submission?: Promise<string | null>;
};
export const keyFor = (app: string, user: string) => createHash('sha256').update(JSON.stringify([app, user])).digest('hex');
export class Sessions {
    private sessions = new Map<string, Session>();
    private locks = new Map<string, Promise<unknown>>();
    private pending = new Map<string, number>();
    private submissionRequests = new Set<string>();
    public stopping = false;
    constructor(public root: string, private factory: (key: string) => Driver, private ttl = 20000, private max = 100, private operationMs = 15000, private connectionMs = 90000, private sendMs = 30000) {
    }
    private async lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
        const queued = this.pending.get(key) ?? 0;
        if (queued >= 16) {
            throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Session is busy.');
        }
        this.pending.set(key, queued + 1);
        const previous = this.locks.get(key) ?? Promise.resolve();
        const next = previous.catch(() => {
        }).then(fn);
        this.locks.set(key, next);
        try {
            return await next;
        }
        finally {
            const remaining = (this.pending.get(key) ?? 1) - 1;
            if (remaining) {
                this.pending.set(key, remaining);
            }
            else {
                this.pending.delete(key);
            }
            if (this.locks.get(key) === next) {
                this.locks.delete(key);
            }
        }
    }
    private state(key: string, store = true): Session {
        let s = this.sessions.get(key);
        if (!s) {
            s = { status: 'disconnected', phone: null, qr: null, expires: 0, generation: 0, connectingSince: 0, recoveries: 0, hasReady: false };
            if (store) {
                this.sessions.set(key, s);
            }
        }
        return s;
    }
    private response(s: Session, qr = false) {
        return { success: true, status: s.status, phone: s.status === 'connected' ? s.phone : null, ...(qr ? { qr: s.qr, expires_at: s.qr ? new Date(s.expires).toISOString() : null } : {}) };
    }
    private async bounded<T>(operation: Promise<T>, timeout = this.operationMs): Promise<T> {
        let timer: NodeJS.Timeout | undefined;
        try {
            return await Promise.race([operation, new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error('Operation timeout')), timeout);
                })]);
        }
        finally {
            if (timer) {
                clearTimeout(timer);
            }
        }
    }
    private async close(s: Session, logout: boolean) {
        s.generation++;
        const c = s.client;
        s.status = 'disconnected';
        s.phone = null;
        s.qr = null;
        s.expires = 0;
        if (c) {
            c.removeAllListeners();
            let logoutFailed = false;
            try {
                if (logout) {
                    await this.bounded(c.logout());
                }
            }
            catch {
                logoutFailed = true;
            }
            // Retain the client on close failure: a later connect must finish closing it first.
            await this.bounded(c.destroy());
            s.client = undefined;
            s.submission = undefined;
            if (logoutFailed) {
                throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Logout could not be confirmed. Retry disconnect.');
            }
        }
    }
    private async start(key: string, s: Session) {
        if (this.stopping || [...this.sessions.values()].filter(s => s.client).length >= this.max) {
            if (!s.client) {
                this.sessions.delete(key);
            }
            throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Service capacity unavailable.');
        }
        const c = this.factory(key);
        const generation = ++s.generation;
        s.client = c;
        s.hasReady = false;
        s.status = 'connecting';
        s.connectingSince = Date.now();
        s.phone = null;
        s.qr = null;
        const current = () => s.client === c && s.generation === generation;
        let qrSequence = 0;
        c.on('qr', (value: string) => {
            const sequence = ++qrSequence;
            const deadline = Date.now() + this.ttl;
            void QRCode.toDataURL(value, { type: 'image/png', width: 320 }).then(png => {
                if (current() && sequence === qrSequence && s.status !== 'connected' && png.length < 1048576 && deadline > Date.now()) {
                    s.qr = png;
                    s.expires = deadline;
                    s.status = 'qr_required';
                }
            }).catch(() => {
            });
        });
        c.on('authenticated', () => {
            if (current()) {
                qrSequence++;
                s.qr = null;
                s.expires = 0;
                if (s.status !== 'connected') s.status = 'connecting';
            }
        });
        c.on('ready', () => {
            if (current()) {
                s.hasReady = true;
                qrSequence++;
                const phone = c.phone();
                s.phone = phone && /^[1-9]\d{6,14}$/.test(phone) ? phone : null;
                s.status = s.phone ? 'connected' : 'connecting';
                s.qr = null;
            }
        });
        for (const event of ['disconnected', 'auth_failure']) {
            c.on(event, () => {
                if (current()) {
                    s.generation++;
                    s.status = 'disconnected';
                    s.phone = null;
                    s.qr = null;
                }
            });
        }
        // Initialization must not hold the lifecycle lock while waiting for a QR scan.
        void this.bounded(c.initialize(), 90000).catch(() => {
            void this.lock(key, async () => {
                if (!current()) return;
                const retry = s.status === 'connecting' && s.recoveries < 1 && !this.stopping;
                await this.close(s, false);
                if (retry) {
                    s.recoveries++;
                    await this.start(key, s);
                }
            }).catch(() => {});
        });
    }
    async connect(app: string, user: string) {
        const key = keyFor(app, user);
        return this.lock(key, async () => {
            const s = this.state(key);
            if (s.status === 'disconnected') {
                await this.close(s, false);
                s.recoveries = 0;
                await this.start(key, s);
            }
            return this.response(s);
        });
    }
    async status(app: string, user: string, qr = false) {
        const key = keyFor(app, user);
        return this.lock(key, async () => {
            const s = this.state(key, false);
            if (s.client && ['connecting', 'connected'].includes(s.status)) {
                const ready = s.hasReady && await this.bounded(s.client.ready()).catch(() => false);
                const phone = ready ? s.client.phone() : null;
                if (phone && /^[1-9]\d{6,14}$/.test(phone)) {
                    s.status = 'connected';
                    s.phone = phone;
                    s.qr = null;
                    s.expires = 0;
                } else {
                    if (s.status === 'connected') s.connectingSince = Date.now();
                    s.status = 'connecting';
                    s.phone = null;
                    if (Date.now() - s.connectingSince >= this.connectionMs) {
                        await this.close(s, false);
                        if (s.recoveries < 1 && !this.stopping) {
                            s.recoveries++;
                            await this.start(key, s);
                        }
                    }
                }
            }
            if (qr && s.qr && s.expires <= Date.now()) {
                await this.close(s, false);
                await this.start(key, s);
                throw new ApiError(409, 'QR_EXPIRED', 'QR expired. Poll for a refreshed QR.');
            }
            return this.response(s, qr);
        });
    }
    async disconnect(app: string, user: string) {
        const key = keyFor(app, user);
        return this.lock(key, async () => {
            const s = this.state(key, false);
            try {
                await this.close(s, true);
            }
            catch {
                throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Logout could not be confirmed. Retry disconnect.');
            }
            await rm(`${this.root}/session-${key}`, { recursive: true, force: true });
            this.sessions.delete(key);
            return this.response(s);
        });
    }
    async send(app: string, user: string, phone: string, message: string) {
        return this.submit(app, user, client => client.send(phone, message));
    }
    async sendMedia(app: string, user: string, phone: string, media: Media) {
        return this.submit(app, user, client => client.sendMedia(phone, media));
    }
    private async submit(app: string, user: string, operation: (client: Driver) => Promise<string | null>) {
        const key = keyFor(app, user);
        if (this.submissionRequests.has(key)) {
            throw new ApiError(409, 'SEND_IN_PROGRESS', 'A submission is already processing. Check WhatsApp before sending again.');
        }
        this.submissionRequests.add(key);
        try {
            return await this.lock(key, async () => {
                const s = this.state(key, false);
                if (!s.client || s.status === 'disconnected') {
                    throw new ApiError(409, 'SESSION_DISCONNECTED', 'Session is disconnected.');
                }
                if (s.submission) {
                    throw new ApiError(409, 'SEND_IN_PROGRESS', 'The previous submission is still processing. Check WhatsApp before sending again.');
                }
                if (s.status !== 'connected' || !await this.bounded(s.client.ready(), Math.min(this.operationMs, 5000)).catch(() => false)) {
                    throw new ApiError(409, 'NOT_CONNECTED', 'Session is not ready.');
                }
                try {
                    const submission = operation(s.client);
                    s.submission = submission;
                    void submission.finally(() => {
                        if (s.submission === submission) s.submission = undefined;
                    }).catch(() => {});
                    const id = await this.bounded(submission, this.sendMs);
                    if (id !== null && (typeof id !== 'string' || !id.trim())) throw new Error('Invalid submission result');
                    return { success: true, message_id: id, ...(id === null ? {confirmation: 'client_completed' as const} : {}) };
                }
                catch {
                    throw new ApiError(502, 'SEND_FAILED', 'Submission could not be confirmed. Do not automatically retry.');
                }
            });
        } finally {
            this.submissionRequests.delete(key);
        }
    }
    async restore() {
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        for (const name of await readdir(this.root)) {
            if (/^session-[a-f0-9]{64}$/.test(name)) {
                const key = name.slice(8);
                await this.lock(key, () => this.start(key, this.state(key)));
            }
        }
    }
    async shutdown() {
        this.stopping = true;
        await Promise.all([...this.sessions.keys()].map(key => this.lock(key, () => this.close(this.state(key), false))));
    }
}
