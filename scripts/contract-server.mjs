// Test-only fake transport for exercising the real Laravel client against Fastify.
import { createHash } from "node:crypto";
import { createApp } from "../.test-build/src/app.js";
import { Sessions } from "../.test-build/src/service.js";
import { MemoryStore } from "../.test-build/tests/fakes.js";
import { SqlStore, poolFromEnvironment } from "../.test-build/src/store.js";
import { Vault } from "../.test-build/src/crypto.js";
import { migrate } from "../.test-build/src/schema.js";
const store =
  process.env.RUN_DATABASE_TESTS === "1"
    ? new SqlStore(
        poolFromEnvironment(),
        new Vault({ v1: Buffer.alloc(32, 1) }, "v1"),
      )
    : new MemoryStore();
if (store instanceof SqlStore) {
  await migrate(store.pool);
  await store.pool.query(
    "INSERT INTO wa_applications (app_id,token_hash) VALUES (?,?) ON DUPLICATE KEY UPDATE token_hash=VALUES(token_hash)",
    ["first-app", createHash("sha256").update("test-secret").digest("hex")],
  );
}
const sessions = new Sessions(store, async (store, lease, event) => {
  setTimeout(() => event({ kind: "open", phone: "919876543210" }), 10);
  return {
    send: async () => "wire-message",
    close: async () => {},
    logout: async () => {},
  };
});
await sessions.connect("first-app", "7");
await new Promise((resolve) => setTimeout(resolve, 30));
const app = createApp(
  sessions,
  {
    "first-app": createHash("sha256").update("test-secret").digest("hex"),
  },
  { "first-app": { current: "v1", keys: { v1: Buffer.alloc(32, 7) } } },
);
await app.listen({ host: "127.0.0.1", port: 33319 });
console.log("Synthetic Laravel wire contract fixture listening on loopback.");
process.on("SIGTERM", () => {
  void sessions
    .shutdown()
    .then(() => app.close())
    .then(() => store.close());
});
