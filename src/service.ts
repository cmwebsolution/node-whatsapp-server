import { createHash, randomUUID } from "node:crypto";
import { Histogram } from "./statistics.js";
import QRCode from "qrcode";
import type { Media } from "./media.js";
import { ApiError } from "./errors.js";
import { keyFor, type Lease, type Store, type Submission } from "./store.js";
export { ApiError, keyFor };
export type Payload = {
  kind: "text" | "media";
  phone: string;
  message?: string;
  media?: Media;
};
export type DriverEvent =
  | { kind: "qr"; qr: string }
  | { kind: "open"; phone: string }
  | { kind: "close"; loggedOut: boolean; terminal?: boolean };
export interface Driver {
  close(): Promise<void>;
  logout(): Promise<void>;
  send(payload: Payload): Promise<string | null>;
}
export type Factory = (
  store: Store,
  lease: Lease,
  event: (e: DriverEvent) => void,
) => Promise<Driver>;
type Session = {
  lease: Lease;
  driver?: Driver;
  qr?: string;
  expires: number;
  epoch: number;
  retry: number;
  stopped: boolean;
  renew?: NodeJS.Timeout;
  timeout?: NodeJS.Timeout;
  reconnect?: NodeJS.Timeout;
  deadline: number;
  busy: boolean;
  events: Promise<void>;
  watchdog?: NodeJS.Timeout;
  connectionSlot?: boolean;
  attemptStarted?: number;
};
type SendContext = {
  cancelled: boolean;
  reserved: boolean;
  dispatched: boolean;
  hash: string;
  session?: Session;
};
export function submissionResult(s: Submission) {
  return {
    success: true,
    state: s.state,
    message_id: s.message_id,
    ...(s.revision ? { revision: s.revision } : {}),
    ...(s.state === "submitted" && !s.message_id
      ? { confirmation: "client_completed" }
      : {}),
  };
}
export class Sessions {
  stopping = false;
  private sendMetrics = {
    dispatched: 0,
    submitted: 0,
    unknown: 0,
    failed: 0,
    elapsed_ms: 0,
  };
  private owner = randomUUID();
  private sessions = new Map<string, Session>();
  private requests = 0;
  private maintenance?: NodeJS.Timeout;
  private restoring = false;
  private connectionQueue: Session[] = [];
  private connecting = 0;
  private connectLatency = new Histogram();
  private sendLatency = new Histogram();
  private reconnects = 0;
  private opened = 0;
  private attempts = 0;
  private shutdownConcurrency = 10;
  constructor(
    public store: Store,
    private factory: Factory,
    private max = 500,
    private operationMs = 30000,
    private tuning = { connectionConcurrency: 5, restoreStaggerMs: 100 },
  ) {}
  private async bounded<T>(p: Promise<T>, ms = this.operationMs): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Timeout")), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  private async lose(s: Session) {
    if (s.stopped) return;
    s.stopped = true;
    this.releaseConnection(s);
    s.epoch++;
    clearInterval(s.renew);
    clearInterval(s.watchdog);
    clearTimeout(s.timeout);
    clearTimeout(s.reconnect);
    s.qr = undefined;
    this.sessions.delete(s.lease.id);
    await this.bounded(s.driver?.close() ?? Promise.resolve(), 5000).catch(
      () => {},
    );
    await this.store.release(s.lease).catch(() => {});
  }
  async connect(app: string, user: string) {
    if (this.stopping)
      throw new ApiError(503, "SERVICE_UNAVAILABLE", "Service stopping.");
    const id = keyFor(app, user);
    if (!this.sessions.has(id)) {
      const lease = await this.store.claim(app, user, this.owner, this.max);
      if (lease) {
        const s: Session = {
          lease,
          expires: 0,
          epoch: 0,
          retry: 0,
          stopped: false,
          deadline: Date.now() + 25000,
          busy: false,
          events: Promise.resolve(),
        };
        this.sessions.set(id, s);
        s.renew = setInterval(() => {
          void this.bounded(this.store.renew(lease), 4000)
            .then(() => {
              s.deadline = Date.now() + 25000;
            })
            .catch(() => this.lose(s));
        }, 10000);
        // A local watchdog stops socket work before the database lease expires, even if renewal hangs.
        s.watchdog = setInterval(() => {
          if (Date.now() >= s.deadline) void this.lose(s);
        }, 1000);
        s.watchdog.unref();
        this.enqueueConnection(s);
      }
    }
    return this.status(app, user);
  }
  private enqueueConnection(s: Session) {
    if (s.stopped || this.stopping || this.connectionQueue.includes(s)) return;
    this.connectionQueue.push(s);
    this.drainConnections();
  }
  private drainConnections() {
    while (
      !this.stopping &&
      this.connecting < this.tuning.connectionConcurrency &&
      this.connectionQueue.length
    ) {
      const s = this.connectionQueue.shift()!;
      if (s.stopped) continue;
      s.connectionSlot = true;
      s.attemptStarted = performance.now();
      this.connecting++;
      this.attempts++;
      void this.start(s);
    }
  }
  private releaseConnection(s: Session) {
    if (!s.connectionSlot) return;
    s.connectionSlot = false;
    this.connecting--;
    queueMicrotask(() => this.drainConnections());
  }
  private async start(s: Session) {
    const epoch = ++s.epoch;
    s.qr = undefined;
    try {
      await this.store.update(s.lease, "connecting");
      s.timeout = setTimeout(() => {
        s.events = s.events
          .then(() => this.event(s, epoch, { kind: "close", loggedOut: false }))
          .catch(() => this.lose(s));
      }, 30000);
      const d = await this.factory(this.store, s.lease, (e) => {
        s.events = s.events
          .then(() => this.event(s, epoch, e))
          .catch(() => this.lose(s));
      });
      if (s.stopped || epoch !== s.epoch) {
        await d.close();
        return;
      }
      s.driver = d;
    } catch {
      if (!s.stopped)
        await this.event(s, epoch, { kind: "close", loggedOut: false }).catch(
          () => this.lose(s),
        );
    }
  }
  private async event(s: Session, epoch: number, event: DriverEvent) {
    if (s.stopped || epoch !== s.epoch) return;
    if (Date.now() >= s.deadline) {
      await this.lose(s);
      return;
    }
    if (event.kind === "qr") {
      this.releaseConnection(s);
      clearTimeout(s.timeout);
      const expiry = Date.now() + 45000;
      const qr = await QRCode.toDataURL(event.qr);
      if (s.stopped || epoch !== s.epoch) return;
      s.qr = qr;
      s.expires = expiry;
      await this.store.update(s.lease, "qr_required");
    } else if (event.kind === "open") {
      this.releaseConnection(s);
      if (s.attemptStarted !== undefined)
        this.connectLatency.observe(performance.now() - s.attemptStarted);
      this.opened++;
      clearTimeout(s.timeout);
      s.qr = undefined;
      s.retry = 0;
      await this.store.update(s.lease, "connected", event.phone);
    } else {
      this.releaseConnection(s);
      this.reconnects++;
      s.epoch++;
      clearTimeout(s.timeout);
      s.qr = undefined;
      await this.bounded(s.driver?.close() ?? Promise.resolve(), 5000).catch(
        () => {},
      );
      s.driver = undefined;
      if (event.loggedOut || event.terminal) {
        await this.store.clear(s.lease);
        await this.store.release(s.lease);
        await this.lose(s);
        return;
      }
      await this.store.update(s.lease, "connecting");
      const delay =
        Math.min(60000, 1000 * 2 ** Math.min(s.retry++, 6)) *
        (0.75 + Math.random() * 0.25);
      s.reconnect = setTimeout(() => {
        this.enqueueConnection(s);
      }, delay);
    }
  }
  async status(app: string, user: string, qr = false) {
    const id = keyFor(app, user),
      state = await this.store.status(id),
      s = this.sessions.get(id);
    if (
      qr &&
      state.status === "qr_required" &&
      (!s?.qr || s.expires <= Date.now())
    )
      throw new ApiError(
        409,
        "QR_EXPIRED",
        "Pairing QR unavailable or expired. Request connect/status and refresh.",
      );
    return {
      success: true,
      ...state,
      ...(qr
        ? {
            qr: state.status === "qr_required" ? s?.qr : null,
            expires_at:
              state.status === "qr_required"
                ? new Date(s!.expires).toISOString()
                : null,
          }
        : {}),
    };
  }
  async disconnect(app: string, user: string) {
    const id = keyFor(app, user);
    let s = this.sessions.get(id);
    if (!s) {
      await this.connect(app, user);
      s = this.sessions.get(id);
    }
    if (!s)
      throw new ApiError(
        409,
        "NOT_CONNECTED",
        "Session owned by another process.",
      );
    if (s.busy)
      throw new ApiError(
        409,
        "SEND_IN_PROGRESS",
        "Submission is still processing.",
      );
    // Invalidate connection events before logout to prevent automatic reconnection.
    s.epoch++;
    clearTimeout(s.reconnect);
    clearTimeout(s.timeout);
    try {
      if (s.driver) await this.bounded(s.driver.logout());
      await this.store.clear(s.lease);
      await this.store.release(s.lease);
    } finally {
      await this.lose(s);
    }
    return { success: true, status: "disconnected", phone: null };
  }
  async lookup(app: string, user: string, key: string) {
    const s = await this.store.lookup(keyFor(app, user), key);
    if (!s) throw new ApiError(404, "NOT_FOUND", "Submission not found.");
    return submissionResult(s);
  }
  async send(app: string, user: string, key: string, payload: Payload) {
    const context: SendContext = {
      cancelled: false,
      reserved: false,
      dispatched: false,
      hash: "",
    };
    try {
      return await this.bounded(
        this.performSend(app, user, key, payload, context),
      );
    } catch (error) {
      if (error instanceof ApiError) throw error;
      context.cancelled = true;
      // Deadline replies do not wait for database cleanup. Socket closure starts synchronously.
      if (context.dispatched && context.session)
        void this.lose(context.session);
      if (context.reserved && context.session)
        void this.store
          .finish(
            context.session.lease,
            key,
            context.dispatched ? "unknown" : "failed",
          )
          .catch(() => {});
      if (!context.reserved)
        throw new ApiError(
          503,
          "SERVICE_UNAVAILABLE",
          "Submission storage unavailable.",
        );
      return submissionResult({
        state: context.dispatched ? "unknown" : "failed",
        message_id: null,
        hash: context.hash,
        dispatched: context.dispatched,
      });
    }
  }
  private async performSend(
    app: string,
    user: string,
    key: string,
    payload: Payload,
    context: SendContext,
  ) {
    if (this.stopping)
      throw new ApiError(503, "SERVICE_UNAVAILABLE", "Service stopping.");
    const id = keyFor(app, user),
      hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    context.hash = hash;
    const existing = await this.store.lookup(id, key);
    if (context.cancelled)
      throw new ApiError(
        503,
        "SERVICE_UNAVAILABLE",
        "Submission deadline elapsed.",
      );
    if (existing) {
      if (existing.hash !== hash)
        throw new ApiError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Key already used for another payload.",
        );
      return submissionResult(existing);
    }
    const s = this.sessions.get(id);
    if (
      !s ||
      s.stopped ||
      !s.driver ||
      Date.now() >= s.deadline ||
      (await this.store.status(id)).status !== "connected"
    )
      throw new ApiError(409, "NOT_CONNECTED", "WhatsApp not connected.");
    if (this.requests >= 50)
      throw new ApiError(
        503,
        "CAPACITY_EXCEEDED",
        "Request capacity exceeded.",
        true,
        2,
      );
    if (s.busy)
      throw new ApiError(
        409,
        "SEND_IN_PROGRESS",
        "Account has an active submission.",
        true,
        2,
      );
    context.session = s;
    if (context.cancelled)
      throw new ApiError(
        503,
        "SERVICE_UNAVAILABLE",
        "Submission deadline elapsed.",
      );
    s.busy = true;
    this.requests++;
    let reserved = false,
      dispatched = false;
    const started = performance.now();
    let outcome: "submitted" | "failed" | "unknown" = "failed";
    try {
      const r = await this.store.reserve(s.lease, key, hash, payload.kind);
      if (!r.fresh) return submissionResult(r.submission);
      reserved = true;
      context.reserved = true;
      const deadline = Date.now() + this.operationMs;
      dispatched = true;
      context.dispatched = true;
      this.sendMetrics.dispatched++;
      outcome = "unknown";
      if (context.cancelled || s.stopped || Date.now() >= s.deadline)
        throw new Error("Ownership lost");
      const messageId = await this.bounded(
        s.driver.send(payload),
        Math.max(1, deadline - Date.now()),
      );
      if (context.cancelled) throw new Error("Submission deadline elapsed");
      await this.store.finish(s.lease, key, "submitted", messageId);
      outcome = "submitted";
      const result = await this.store.lookup(id, key);
      if (!result) throw new Error("Submission unavailable");
      return submissionResult(result);
    } catch (error) {
      if (!reserved && error instanceof ApiError) throw error;
      if (dispatched)
        await this.bounded(s.driver?.close() ?? Promise.resolve(), 5000).catch(
          () => {},
        );
      if (reserved)
        await this.store
          .finish(s.lease, key, dispatched ? "unknown" : "failed")
          .catch(() => {});
      // Stop a potentially still-running socket send before allowing further account work.
      if (dispatched) await this.lose(s);
      if (!reserved)
        throw new ApiError(
          503,
          "SERVICE_UNAVAILABLE",
          "Submission storage unavailable.",
        );
      return submissionResult({
        state: dispatched ? "unknown" : "failed",
        message_id: null,
        hash,
        dispatched,
      });
    } finally {
      s.busy = false;
      this.requests--;
      if (reserved) {
        this.sendMetrics[outcome]++;
        this.sendMetrics.elapsed_ms += performance.now() - started;
        this.sendLatency.observe(performance.now() - started);
      }
    }
  }
  async restore() {
    this.restoring = true;
    try {
      for (const r of await this.store.restore()) {
        if (this.stopping) break;
        await this.connect(r.app, r.user);
        await new Promise((resolve) =>
          setTimeout(resolve, this.tuning.restoreStaggerMs),
        );
      }
    } finally {
      this.restoring = false;
    }
  }
  startMaintenance() {
    this.maintenance = setInterval(() => {
      void this.store.cleanup().catch(() => {});
      if (!this.stopping && !this.restoring)
        void this.restore().catch(() => {});
    }, 30000);
    this.maintenance.unref();
  }
  snapshot() {
    return {
      owned: this.sessions.size,
      active_requests: this.requests,
      sends: { ...this.sendMetrics, latency: this.sendLatency.snapshot() },
      connections: {
        attempts: this.attempts,
        opened: this.opened,
        reconnects: this.reconnects,
        active_attempts: this.connecting,
        queued: this.connectionQueue.filter((s) => !s.stopped).length,
        concurrency: this.tuning.connectionConcurrency,
        open_latency: this.connectLatency.snapshot(),
      },
      stopping: this.stopping,
    };
  }
  async shutdown() {
    this.stopping = true;
    clearInterval(this.maintenance);
    this.connectionQueue = [];
    const owned = [...this.sessions.values()];
    // Close every socket before slower lease-release writes can exhaust the pool.
    const closing: Promise<unknown>[] = [];
    for (const s of owned) {
      s.stopped = true;
      s.epoch++;
      this.releaseConnection(s);
      clearInterval(s.renew);
      clearInterval(s.watchdog);
      clearTimeout(s.timeout);
      clearTimeout(s.reconnect);
      s.qr = undefined;
      closing.push(
        this.bounded(s.driver?.close() ?? Promise.resolve(), 5000).catch(
          () => {},
        ),
      );
    }
    this.sessions.clear();
    await Promise.all(closing);
    let next = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(this.shutdownConcurrency, owned.length) },
        async () => {
          while (next < owned.length) {
            const s = owned[next++];
            await this.store.release(s.lease).catch(() => {});
          }
        },
      ),
    );
  }
}
