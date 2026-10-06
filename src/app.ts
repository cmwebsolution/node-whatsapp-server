import { Histogram } from "./statistics.js";
import Fastify from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { ApiError, Sessions } from "./service.js";
import { validateMedia } from "./media.js";
import { signResponse, decimal, type SigningKeys } from "./events.js";
export type Credentials = Record<string, string>;
export function createApp(
  sessions: Sessions,
  credentials: Credentials,
  signing: SigningKeys = {},
  mediaRequests = 4,
) {
  let ingress = 0,
    mediaIngress = 0;
  const mediaActive = new WeakSet<object>();
  const timing = new WeakMap<object, number>();
  const apiLatency = new Histogram();
  const apiCounts = { requests: 0, errors: 0, capacity_rejected: 0 };
  const active = new WeakSet<object>();
  const limits = new Map<string, { count: number; until: number }>();
  const limit = (id: string, max: number) => {
    const now = Date.now();
    if (limits.size > 10000)
      for (const [k, v] of limits) if (v.until < now) limits.delete(k);
    let bucket = limits.get(id);
    if (!bucket || bucket.until < now) {
      bucket = { count: 0, until: now + 60000 };
      limits.set(id, bucket);
    }
    if (++bucket.count > max)
      throw new ApiError(
        429,
        "RATE_LIMITED",
        "Request limit exceeded.",
        true,
        60,
      );
  };
  const app = Fastify({
    logger: false,
    bodyLimit: 24 * 1024,
    requestTimeout: 40000,
  });
  app.addHook("onRequest", async (req, reply) => {
    timing.set(req, performance.now());
    reply.header("Cache-Control", "no-store");
    if (!req.url.startsWith("/api/")) return;
    if (sessions.stopping)
      throw new ApiError(503, "SERVICE_UNAVAILABLE", "Service stopping.");
    const token = /^Bearer (\S+)$/.exec(
      String(req.headers.authorization ?? ""),
    )?.[1];
    if (!token || token.length > 512)
      throw new ApiError(
        401,
        "UNAUTHENTICATED",
        "Valid application credential required.",
      );
    const hash = createHash("sha256").update(token).digest();
    const owner = Object.entries(credentials).find(
      ([, digest]) =>
        /^[a-f0-9]{64}$/.test(digest) &&
        timingSafeEqual(hash, Buffer.from(digest, "hex")),
    )?.[0];
    if (!owner)
      throw new ApiError(
        401,
        "UNAUTHENTICATED",
        "Valid application credential required.",
      );
    if (req.headers["x-whatsapp-app-id"] !== owner)
      throw new ApiError(403, "FORBIDDEN", "Application credential mismatch.");
    limit(owner, 2000);
    if (/\/send-(message|media)(?:\?|$)/.test(req.url)) {
      if (ingress >= 50)
        throw new ApiError(
          503,
          "CAPACITY_EXCEEDED",
          "Request capacity exceeded.",
          true,
          2,
        );
      if (/\/send-media(?:\?|$)/.test(req.url)) {
        if (mediaIngress >= mediaRequests)
          throw new ApiError(
            503,
            "CAPACITY_EXCEEDED",
            "Media request capacity exceeded.",
            true,
            2,
          );
        mediaIngress++;
        mediaActive.add(req);
      }
      ingress++;
      active.add(req);
    }
  });
  const authenticated = new WeakSet<object>();
  app.addHook("preParsing", async (req, _reply, payload) => {
    if (
      req.url.startsWith("/api/") &&
      credentials[String(req.headers["x-whatsapp-app-id"])]
    )
      authenticated.add(req);
    return payload;
  });
  app.addHook("onSend", async (req, reply, payload) => {
    const signed =
      req.url.startsWith("/api/whatsapp/events") ||
      req.url.startsWith("/api/whatsapp/snapshots") ||
      (/\/submissions\//.test(req.url) &&
        req.headers["x-whatsapp-nonce"] !== undefined);
    if (
      signed &&
      authenticated.has(req) &&
      (reply.statusCode < 400 || [404, 410].includes(reply.statusCode))
    ) {
      const headers = signResponse(
        signing[String(req.headers["x-whatsapp-app-id"])],
        String(req.headers["x-whatsapp-app-id"]),
        req.headers["x-whatsapp-nonce"],
        String(payload),
      );
      for (const [name, value] of Object.entries(headers))
        reply.header(name, value);
    }
    return payload;
  });
  app.addHook("onResponse", async (req, reply) => {
    if (active.delete(req)) ingress--;
    if (mediaActive.delete(req)) mediaIngress--;
    if (req.url.startsWith("/api/")) {
      apiCounts.requests++;
      if (reply.statusCode >= 400) apiCounts.errors++;
      if (reply.statusCode === 503)
        apiCounts.capacity_rejected += Number(
          reply.getHeader("Retry-After") !== undefined,
        );
      apiLatency.observe(
        performance.now() - (timing.get(req) ?? performance.now()),
      );
    }
  });
  const operatingMetrics = () => ({
    api: {
      ...apiCounts,
      latency: apiLatency.snapshot(),
      active_requests: ingress,
      active_media_requests: mediaIngress,
      media_request_limit: mediaRequests,
    },
  });
  const user = (value: unknown) => {
    if (
      typeof value !== "string" ||
      !value ||
      Buffer.byteLength(value) > 256 ||
      value !== Buffer.from(value).toString()
    )
      throw new ApiError(422, "INVALID_INPUT", "Invalid user identifier.");
    return value;
  };
  const key = (value: unknown) => {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
      throw new ApiError(
        422,
        "INVALID_INPUT",
        "Idempotency-Key required: 1–128 letters, digits, underscores or hyphens.",
      );
    return value;
  };
  const phone = (value: unknown) => {
    if (typeof value !== "string" || !/^[1-9]\d{6,14}$/.test(value))
      throw new ApiError(
        422,
        "INVALID_INPUT",
        "Provide international recipient digits.",
      );
    return value;
  };
  app.get("/", async () => ({
    success: true,
    service: "WhatsApp service",
    health: "/health",
    ready: "/ready",
  }));
  app.get("/health", async () => ({ success: true }));
  app.get("/ready", async () => {
    if (sessions.stopping)
      throw new ApiError(503, "SERVICE_UNAVAILABLE", "Service stopping.");
    await sessions.store.ready();
    return { success: true };
  });
  const pageLimit = (value: unknown) => {
    if (value === undefined) return 100;
    if (
      typeof value !== "string" ||
      !/^[1-9][0-9]{0,2}$/.test(value) ||
      Number(value) > 100
    )
      throw new ApiError(422, "INVALID_INPUT", "Limit must be 1–100.");
    return Number(value);
  };
  const signedRequest = (appId: string, nonce: unknown) => {
    signResponse(signing[appId], appId, nonce, "");
  };
  app.get<{ Querystring: { after?: string; limit?: string } }>(
    "/api/whatsapp/events",
    async (req) => {
      const appId = String(req.headers["x-whatsapp-app-id"]);
      signedRequest(appId, req.headers["x-whatsapp-nonce"]);
      return sessions.store.events(
        appId,
        decimal(req.query.after, "cursor"),
        pageLimit(req.query.limit),
      );
    },
  );
  app.get<{ Querystring: { after?: string; limit?: string; cursor?: string } }>(
    "/api/whatsapp/snapshots",
    async (req) => {
      const appId = String(req.headers["x-whatsapp-app-id"]);
      signedRequest(appId, req.headers["x-whatsapp-nonce"]);
      const after = req.query.after ?? "";
      if (after !== "" && !/^[a-f0-9]{64}$/.test(after))
        throw new ApiError(
          422,
          "INVALID_INPUT",
          "Invalid snapshot continuation.",
        );
      return sessions.store.snapshots(
        appId,
        after,
        pageLimit(req.query.limit),
        req.query.cursor === undefined
          ? undefined
          : decimal(req.query.cursor, "snapshot cursor"),
      );
    },
  );
  app.post<{ Body: { user_id?: unknown } }>(
    "/api/whatsapp/connect",
    async (req) =>
      sessions.connect(
        String(req.headers["x-whatsapp-app-id"]),
        user(req.body?.user_id),
      ),
  );
  const prefix = "/api/whatsapp/:user_id";
  for (const action of ["status", "qr", "disconnect"] as const)
    app.route<{ Params: { user_id: string } }>({
      method: action === "disconnect" ? "POST" : "GET",
      url: `${prefix}/${action}`,
      handler: async (req) =>
        action === "disconnect"
          ? sessions.disconnect(
              String(req.headers["x-whatsapp-app-id"]),
              user(req.params.user_id),
            )
          : sessions.status(
              String(req.headers["x-whatsapp-app-id"]),
              user(req.params.user_id),
              action === "qr",
            ),
    });
  app.get<{ Params: { user_id: string; key: string } }>(
    `${prefix}/submissions/:key`,
    async (req) =>
      sessions.lookup(
        String(req.headers["x-whatsapp-app-id"]),
        user(req.params.user_id),
        key(req.params.key),
      ),
  );
  app.post<{
    Params: { user_id: string };
    Body: { phone?: unknown; message?: unknown };
  }>(`${prefix}/send-message`, async (req) => {
    const message = req.body?.message;
    if (
      typeof message !== "string" ||
      !message.trim() ||
      [...message].length > 4096
    )
      throw new ApiError(
        422,
        "INVALID_INPUT",
        "Nonblank text up to 4096 characters required.",
      );
    return sessions.send(
      String(req.headers["x-whatsapp-app-id"]),
      user(req.params.user_id),
      key(req.headers["idempotency-key"]),
      { kind: "text", phone: phone(req.body.phone), message },
    );
  });
  app.post<{
    Params: { user_id: string };
    Body: { phone?: unknown; media?: unknown };
  }>(`${prefix}/send-media`, { bodyLimit: 12 * 1024 * 1024 }, async (req) =>
    sessions.send(
      String(req.headers["x-whatsapp-app-id"]),
      user(req.params.user_id),
      key(req.headers["idempotency-key"]),
      {
        kind: "media",
        phone: phone(req.body?.phone),
        media: validateMedia(req.body?.media),
      },
    ),
  );
  app.setNotFoundHandler(async () => {
    throw new ApiError(404, "NOT_FOUND", "Endpoint not found.");
  });
  app.setErrorHandler((error, req, reply) => {
    const invalid = (error as { statusCode?: number }).statusCode;
    const safe =
      error instanceof ApiError
        ? error
        : new ApiError(
            invalid === 400 || invalid === 413 || invalid === 415 ? 422 : 503,
            invalid === 400 || invalid === 413 || invalid === 415
              ? "INVALID_INPUT"
              : "SERVICE_UNAVAILABLE",
            "Request could not be processed.",
          );
    if (safe.retryAfter !== undefined)
      reply.header("Retry-After", String(safe.retryAfter));
    reply.code(safe.status).send({
      success: false,
      code: safe.code,
      message: safe.message,
      retry_safe: safe.retrySafe,
      ...(safe.retryAfter !== undefined
        ? { retry_after: safe.retryAfter }
        : {}),
    });
  });
  return Object.assign(app, { operatingMetrics });
}
