import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  copyFile,
  readFile,
  rm,
  readdir,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore } from "../src/file-store.js";
import { keyFor } from "../src/store.js";
import { Sessions } from "../src/service.js";
import { createApp } from "../src/app.js";

test("private file storage restores encrypted auth buffers, fences stale owners and preserves uncertain submissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "wa-files-"));
  let store = new FileStore(root);
  try {
    await store.ready();
    await store.provision("app", "private-token");
    const lease = (await store.claim("app", "user", "owner", 2))!;
    await store.writeAuth(lease, [
      {
        type: "creds",
        id: "creds",
        value: { secret: "sensitive", bytes: Buffer.from("key") },
      },
    ]);
    await store.reserve(lease, "request", "hash");
    const raw = await readFile(
      join(root, "sessions", `${lease.id}.json`),
      "utf8",
    );
    assert.ok(!raw.includes("sensitive"));
    assert.equal(
      (await stat(join(root, "sessions", `${lease.id}.json`))).mode & 0o777,
      0o600,
    );
    await store.close();
    store = new FileStore(root);
    await store.ready();
    assert.deepEqual(await store.restore(), [{ app: "app", user: "user" }]);
    const next = (await store.claim("app", "user", "new-owner", 2))!;
    await assert.rejects(
      store.writeAuth(lease, [{ type: "creds", id: "creds", value: {} }]),
    );
    const auth = await store.auth(next, "creds", ["creds"]);
    assert.ok(Buffer.isBuffer(auth.creds.bytes));
    assert.equal(auth.creds.secret, "sensitive");
    assert.equal((await store.lookup(next.id, "request"))?.state, "unknown");
    assert.equal((await store.reserve(next, "request", "hash")).fresh, false);
    await assert.rejects(
      store.reserve(next, "request", "different"),
      /another payload/,
    );
    await store.writeAuth(next, [{ type: "creds", id: "creds", value: null }]);
    assert.deepEqual(await store.auth(next, "creds", ["creds"]), {});
    await store.clear(next);
    assert.deepEqual(await store.restore(), []);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("duplicate storage owners fail without removing the original lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "wa-owner-"));
  const a = new FileStore(root),
    b = new FileStore(root);
  try {
    await a.ready();
    await assert.rejects(b.ready());
    await b.close();
    await a.ready();
    assert.ok((await readdir(root)).includes(".owner-lock"));
  } finally {
    await a.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("file-backed HTTP supports simple bearer connection and durable text submissions without SQL or signing keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "wa-http-"));
  const store = new FileStore(root);
  await store.ready();
  await store.provision("app", "token");
  let sends = 0;
  const sessions = new Sessions(
    store,
    async (_store, _lease, event) => {
      setImmediate(() => event({ kind: "open", phone: "919876543210" }));
      return {
        close: async () => {},
        logout: async () => {},
        send: async () => {
          sends++;
          return "accepted";
        },
      };
    },
    2,
  );
  const app = createApp(sessions, await store.credentials());
  const headers = { authorization: "Bearer token", "x-whatsapp-app-id": "app" };
  try {
    assert.equal((await app.inject({ url: "/ready" })).statusCode, 200);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/whatsapp/connect",
          headers,
          payload: { user_id: "user" },
        })
      ).statusCode,
      200,
    );
    for (let i = 0; i < 50; i++) {
      if ((await sessions.status("app", "user")).status === "connected") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    for (let i = 0; i < 2; i++) {
      const response = await app.inject({
        method: "POST",
        url: "/api/whatsapp/user/send-message",
        headers: { ...headers, "idempotency-key": "request" },
        payload: { phone: "919876543210", message: "Hello" },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().state, "submitted");
    }
    assert.equal(sends, 1);
    assert.equal(
      (
        await app.inject({
          url: "/api/whatsapp/user/status",
          headers: { ...headers, "x-whatsapp-app-id": "other" },
        })
      ).statusCode,
      403,
    );
  } finally {
    await sessions.shutdown();
    await app.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("actual Node process provisions and restarts without database, Docker or manual encryption/signing configuration", async () => {
  const { spawn } = await import("node:child_process");
  const exitOf = (child: import("node:child_process").ChildProcess) =>
    new Promise<number | null>((resolve) =>
      child.once("exit", (code) => resolve(code)),
    );
  const root = await mkdtemp(join(tmpdir(), "wa-process-"));
  const env = {
    ...process.env,
    DATA_DIR: root,
    HOST: "127.0.0.1",
    PORT: "33429",
    EVENT_SIGNING_KEYS: "{}",
    PROVISION_TOKEN: "a".repeat(43),
  };
  const provision = spawn(
    process.execPath,
    [".test-build/src/provision.js", "app"],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  provision.stdout.on("data", (b) => (output += b));
  provision.stderr.on("data", (b) => (output += b));
  try {
    const code = await exitOf(provision);
    assert.equal(code, 0, output);
    assert.equal(
      await readFile(join(root, "credentials", "app.token"), "utf8"),
      "a".repeat(43),
    );
    await copyFile("scripts/host-entry.cjs", ".test-build/src/host-entry.cjs");
    for (let attempt = 0; attempt < 2; attempt++) {
      const child = spawn(
        process.execPath,
        attempt === 0
          ? [".test-build/src/server.js"]
          : ["-e", 'require("./.test-build/src/host-entry.cjs")'],
        {
          env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.stdout.on("data", (b) => (output += b));
      child.stderr.on("data", (b) => (output += b));
      const exited = exitOf(child);
      try {
        let ready = false;
        for (let i = 0; i < 100; i++) {
          try {
            ready = (await fetch("http://127.0.0.1:33429/ready")).ok;
          } catch {}
          if (ready) break;
          await new Promise((r) => setTimeout(r, 30));
        }
        assert.ok(ready, output);
      } finally {
        child.kill("SIGTERM");
        const exit = await exited;
        assert.equal(exit, 0, output);
      }
    }
    assert.ok(!output.includes("a".repeat(43)));
    assert.ok(!(await readdir(root)).includes(".owner-lock"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing encryption key over existing sessions fails closed without replacing authentication", async () => {
  const root = await mkdtemp(join(tmpdir(), "wa-key-"));
  const store = new FileStore(root);
  try {
    await store.ready();
    await store.provision("app", "token");
    const lease = (await store.claim("app", "user", "owner", 2))!;
    await store.writeAuth(lease, [
      { type: "creds", id: "creds", value: { secret: "saved" } },
    ]);
    await store.close();
    await rm(join(root, "encryption-key.json"));
    const next = new FileStore(root);
    await assert.rejects(next.ready(), /require their encryption key/);
    assert.ok(!(await readdir(root)).includes("encryption-key.json"));
    assert.ok(
      (await readdir(join(root, "sessions"))).includes(
        `${keyFor("app", "user")}.json`,
      ),
    );
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("confirmed dead process ownership is recovered on restart", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "wa-dead-"));
  const store = new FileStore(root);
  try {
    await mkdir(join(root, ".owner-lock"));
    await writeFile(
      join(root, ".owner-lock", "owner.json"),
      JSON.stringify({ pid: 2147483647 }),
    );
    await store.ready();
    assert.equal(
      JSON.parse(
        await readFile(join(root, ".owner-lock", "owner.json"), "utf8"),
      ).pid,
      process.pid,
    );
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("fresh unprovisioned service serves health and rejects unauthenticated API access", async () => {
  const { spawn } = await import("node:child_process");
  const root = await mkdtemp(join(tmpdir(), "wa-fresh-"));
  const child = spawn(process.execPath, [".test-build/src/server.js"], {
    env: {
      ...process.env,
      DATA_DIR: root,
      HOST: "127.0.0.1",
      PORT: "33430",
      EVENT_SIGNING_KEYS: "{}",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (b) => (output += b));
  child.stderr.on("data", (b) => (output += b));
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", resolve),
  );
  try {
    let healthy = false;
    for (let i = 0; i < 100; i++) {
      try {
        healthy = (await fetch("http://127.0.0.1:33430/health")).ok;
      } catch {}
      if (healthy) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.ok(healthy, output);
    assert.equal((await fetch("http://127.0.0.1:33430/")).status, 200);
    assert.equal((await fetch("http://127.0.0.1:33430/ready")).status, 200);
    const response = await fetch(
      "http://127.0.0.1:33430/api/whatsapp/user/status",
    );
    assert.equal(response.status, 401);
  } finally {
    child.kill("SIGTERM");
    await exited;
    await rm(root, { recursive: true, force: true });
  }
});
