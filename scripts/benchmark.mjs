// Synthetic transport only; this never connects to WhatsApp or submits real messages.
import { monitorEventLoopDelay } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
const build = spawnSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "-p", "tsconfig.test.json"],
  { stdio: "inherit" },
);
if (build.status !== 0) process.exit(1);
const { createApp } = await import("../.test-build/src/app.js");
const { Histogram } = await import("../.test-build/src/statistics.js");
const { Sessions } = await import("../.test-build/src/service.js");
const { MemoryStore } = await import("../.test-build/tests/fakes.js");
const { SqlStore, poolFromEnvironment } = await import(
  "../.test-build/src/store.js"
);
const { Vault } = await import("../.test-build/src/crypto.js");
const { migrate } = await import("../.test-build/src/schema.js");
const database = process.env.BENCHMARK_DATABASE === "true";
const store = database
  ? new SqlStore(
      poolFromEnvironment(),
      new Vault({ benchmark: Buffer.alloc(32, 7) }, "benchmark"),
    )
  : new MemoryStore();
if (database) await migrate(store.pool);
const seconds = Number(process.env.BENCHMARK_SECONDS ?? 60),
  accounts = Number(process.env.BENCHMARK_ACCOUNTS ?? 500),
  mediaBytes = Number(process.env.BENCHMARK_MEDIA_BYTES ?? 0);
if (
  !Number.isInteger(accounts) ||
  accounts < 1 ||
  accounts > 500 ||
  !Number.isFinite(seconds) ||
  seconds < 1 ||
  seconds > 86400 ||
  !Number.isInteger(mediaBytes) ||
  mediaBytes < 0 ||
  mediaBytes > 8 * 1024 * 1024
)
  throw new Error("Invalid benchmark limits.");
const app = "benchmark-" + randomUUID(),
  events = [],
  histogram = monitorEventLoopDelay({ resolution: 20 });
histogram.enable();
const sessions = new Sessions(store, async (_store, l, event) => {
  events.push(event);
  return {
    close: async () => {},
    logout: async () => {},
    send: async () => {
      await new Promise((r) => setTimeout(r, 20));
      return randomUUID();
    },
  };
});
const http = createApp(sessions, {
  [app]: (await import("node:crypto"))
    .createHash("sha256")
    .update("synthetic-token")
    .digest("hex"),
});
await http.listen({ host: "127.0.0.1", port: 0 });
const url = http.listeningOrigin;
const delays = new Histogram(),
  outcomes = {},
  cpu = process.cpuUsage();
let peakRSS = 0;
try {
  const startup = performance.now();
  for (let i = 0; i < accounts; i++) {
    await sessions.connect(app, String(i));
    const deadline = Date.now() + 5000;
    while (!events[i] && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 5));
    if (!events[i]) throw new Error("Synthetic socket startup unavailable");
    events[i]({ kind: "open", phone: "919876543210" });
  }
  await new Promise((r) => setTimeout(r, 50));
  const restoration = performance.now() - startup;
  const started = performance.now();
  let n = 0;
  while (performance.now() - started < seconds * 1000) {
    // Bursts of up to 50 requests distributed across accounts; 500 sends/minute average.
    const batch = Math.min(50, accounts, Math.ceil((seconds * 500) / 60) - n);
    if (batch <= 0) break;
    await Promise.all(
      Array.from({ length: batch }, async (_, offset) => {
        const t = performance.now();
        try {
          const body = mediaBytes
            ? {
                kind: "media",
                phone: "919876543210",
                media: {
                  mimetype: "application/pdf",
                  data: Buffer.concat([
                    Buffer.from("%PDF-"),
                    Buffer.alloc(Math.max(0, mediaBytes - 5)),
                  ]).toString("base64"),
                  filename: "synthetic.pdf",
                  caption: "",
                },
              }
            : { kind: "text", phone: "919876543210", message: "synthetic" };
          const response = await fetch(
            url +
              `/api/whatsapp/${(n + offset) % accounts}/${mediaBytes ? "send-media" : "send-message"}`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-whatsapp-app-id": app,
                authorization: "Bearer synthetic-token",
                "idempotency-key": randomUUID(),
              },
              body: JSON.stringify(
                mediaBytes
                  ? { phone: body.phone, media: body.media }
                  : { phone: body.phone, message: body.message },
              ),
              signal: AbortSignal.timeout(40000),
            },
          );
          const result = await response.json();
          if (!response.ok) throw new Error("Rejected");
          outcomes[result.state] = (outcomes[result.state] ?? 0) + 1;
        } catch {
          outcomes.rejected = (outcomes.rejected ?? 0) + 1;
        }
        delays.observe(performance.now() - t);
        peakRSS = Math.max(peakRSS, process.memoryUsage().rss);
      }),
    );
    n += batch;
    const wait = Math.min(
      started + seconds * 1000 - performance.now(),
      started + n * 120 - performance.now(),
    );
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  console.log(
    JSON.stringify(
      {
        transport: "synthetic_http_same_process_client",
        process_measurement_includes_client: true,
        timestamp: new Date().toISOString(),
        runtime: process.version,
        database_metrics: database ? await store.metrics() : undefined,
        api_metrics: http.operatingMetrics(),
        storage: database ? "sql" : "memory",
        accounts,
        seconds,
        media_bytes: mediaBytes,
        outcomes,
        initialize_ms: Math.round(restoration),
        latency: delays.snapshot(),
        peak_rss_mib: Math.round(peakRSS / 1048576),
        cpu_ms: Math.round(
          (process.cpuUsage(cpu).user + process.cpuUsage(cpu).system) / 1000,
        ),
        event_loop_p99_ms: Math.round(histogram.percentile(99) / 1e6),
        proves_real_account_capacity: false,
      },
      null,
      2,
    ),
  );
} finally {
  histogram.disable();
  await sessions.shutdown();
  await http.close();
  if (database) {
    await store.pool.query(
      "DELETE FROM wa_auth WHERE session_id IN (SELECT id FROM wa_sessions WHERE app_id=?)",
      [app],
    );
    await store.pool.query(
      "DELETE FROM wa_submissions WHERE session_id IN (SELECT id FROM wa_sessions WHERE app_id=?)",
      [app],
    );
    await store.pool.query("DELETE FROM wa_sessions WHERE app_id=?", [app]);
    await store.pool.query("DELETE FROM wa_events WHERE app_id=?", [app]);
    await store.pool.query("DELETE FROM wa_event_streams WHERE app_id=?", [
      app,
    ]);
  }
  await store.close();
}
