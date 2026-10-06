import { loadSecretFiles } from "./secrets.js";
import { runtimeSettings } from "./settings.js";
import { signingKeysFromEnvironment } from "./events.js";
import { createApp } from "./app.js";
import { driver } from "./driver.js";
import { Sessions } from "./service.js";
import { poolFromEnvironment, SqlStore } from "./store.js";
import { startMetrics } from "./metrics.js";
import { Vault } from "./crypto.js";
await loadSecretFiles();
const tuning = runtimeSettings();
const max = tuning.maxSessions,
  port = Number(process.env.PORT ?? 3001);
if (
  !Number.isInteger(max) ||
  max < 1 ||
  max > 500 ||
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535
)
  throw new Error("Invalid runtime limits");
const store = new SqlStore(poolFromEnvironment(), Vault.environment());
const sessions = new Sessions(store, driver, max, 30000, tuning);
let app: ReturnType<typeof createApp> | undefined;
let closing = false;
let stopMetrics: (() => void) | undefined;
async function shutdown() {
  if (closing) return;
  closing = true;
  stopMetrics?.();
  const timer = setTimeout(() => process.exit(1), tuning.shutdownMs);
  timer.unref();
  try {
    await sessions.shutdown();
    await app?.close();
    await store.close();
  } finally {
    clearTimeout(timer);
  }
}
process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown();
});
try {
  await store.ready();
  const credentials = await store.credentials();
  if (!Object.keys(credentials).length)
    throw new Error("No applications provisioned");
  const signing = signingKeysFromEnvironment();
  if (Object.keys(credentials).some((id) => !signing[id]))
    throw new Error("Configure every application signing key");
  app = createApp(sessions, credentials, signing, tuning.mediaRequests);
  await app.listen({ port, host: process.env.HOST ?? "127.0.0.1" });
  stopMetrics = startMetrics(async () => ({
    ...sessions.snapshot(),
    ...app!.operatingMetrics(),
    database: await store.metrics(),
  }));
  sessions.startMaintenance();
  void sessions.restore().catch(() => {
    console.error("RESTORATION_UNAVAILABLE");
  });
  console.log("WhatsApp service listening.");
} catch {
  console.error(
    "STARTUP_UNAVAILABLE: verify database, migrations, application credentials, encryption and signing configuration.",
  );
  await shutdown();
  process.exitCode = 1;
}
