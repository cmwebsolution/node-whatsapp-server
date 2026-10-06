// Test-only TCP transport. Production server has no synthetic-driver or fault-control switch.
import { connect } from "node:net";
import { createHash } from "node:crypto";
import { createApp } from "../../src/app.js";
import { databaseAuth } from "../../src/auth.js";
import { Vault } from "../../src/crypto.js";
import { Sessions } from "../../src/service.js";
import { SqlStore, poolFromEnvironment } from "../../src/store.js";
const store = new SqlStore(poolFromEnvironment(), Vault.environment());
const sessions = new Sessions(
  store,
  async (s, l, event) => {
    const auth = await databaseAuth(s, l),
      restored = auth.state.creds.registered === true;
    if (!restored) {
      auth.state.creds.registered = true;
      await auth.save();
      await auth.state.keys.set({
        "pre-key": {
          fixture: {
            public: Buffer.from("fixture-public"),
            private: Buffer.from("fixture-private"),
          },
        },
      });
    } else {
      const keys = await auth.state.keys.get("pre-key", ["fixture"]);
      if (!Buffer.isBuffer(keys.fixture.private))
        throw new Error("Fixture key restoration failed");
    }
    const socket = connect(
      Number(process.env.FAULT_UPSTREAM_PORT),
      "127.0.0.1",
    );
    let stopped = false,
      buffer = "";
    let sending:
      | { resolve: (id: string) => void; reject: (e: Error) => void }
      | undefined;
    socket.on("connect", () => {
      if (!stopped) event({ kind: "open", phone: "919876543210" });
    });
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const end = buffer.indexOf("\n");
      if (end >= 0 && sending) {
        const response = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        sending.resolve(response.id);
        sending = undefined;
      }
    });
    socket.on("close", () => {
      sending?.reject(new Error("Transport unavailable"));
      sending = undefined;
      if (!stopped) event({ kind: "close", loggedOut: false });
    });
    return {
      close: async () => {
        stopped = true;
        socket.destroy();
        sending?.reject(new Error("Transport closed"));
        sending = undefined;
        await auth.flush();
      },
      logout: async () => {
        stopped = true;
        socket.destroy();
      },
      send: async (payload) => {
        await auth.flush();
        return new Promise<string>((resolve, reject) => {
          sending = { resolve, reject };
          socket.write(JSON.stringify({ kind: payload.kind }) + "\n");
        });
      },
    };
  },
  500,
);
const id = process.env.FAULT_APP_ID!,
  token = process.env.FAULT_TOKEN!;
const app = createApp(
  sessions,
  { [id]: createHash("sha256").update(token).digest("hex") },
  { [id]: { current: "v1", keys: { v1: Buffer.alloc(32, 7) } } },
);
await app.listen({ host: "127.0.0.1", port: Number(process.env.PORT) });
sessions.startMaintenance();
await sessions.restore();
let closing = false;
process.on("SIGTERM", () => {
  if (closing) return;
  closing = true;
  void sessions
    .shutdown()
    .then(() => app.close())
    .then(() => store.close());
});
