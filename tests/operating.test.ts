import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "./fakes.js";
import { Sessions, type DriverEvent } from "../src/service.js";
import { loadSecretFiles } from "../src/secrets.js";
import { Histogram } from "../src/statistics.js";
import { runtimeSettings } from "../src/settings.js";
const tick = () => new Promise((r) => setTimeout(r, 10));
test("bounded connection attempts drain without starting extra sockets and shutdown closes before releasing ownership", async () => {
  const store = new MemoryStore();
  const callbacks: ((e: DriverEvent) => void)[] = [];
  let live = 0,
    peak = 0,
    closed = 0;
  const sessions = new Sessions(
    store,
    async (_s, _l, event) => {
      callbacks.push(event);
      live++;
      peak = Math.max(peak, live);
      return {
        send: async () => null,
        close: async () => {
          live--;
          closed++;
        },
        logout: async () => {},
      };
    },
    500,
    1000,
    { connectionConcurrency: 2, restoreStaggerMs: 10 },
  );
  try {
    for (let i = 0; i < 5; i++) await sessions.connect("app", String(i));
    await tick();
    assert.equal(callbacks.length, 2);
    assert.equal(sessions.snapshot().connections.queued, 3);
    callbacks[0]({ kind: "open", phone: "919876543210" });
    await tick();
    assert.equal(callbacks.length, 3);
    assert.equal(sessions.snapshot().connections.active_attempts, 2);
    const release = store.release.bind(store);
    store.release = async (l) => {
      assert.ok(closed >= 3, "Socket closure must begin before lease release");
      return release(l);
    };
    await sessions.shutdown();
    assert.equal(callbacks.length, 3);
    assert.equal(closed, 3);
    assert.equal(sessions.snapshot().owned, 0);
    assert.equal(sessions.snapshot().connections.active_attempts, 0);
    assert.equal(peak, 3);
  } finally {
    await sessions.shutdown();
  }
});
test("global media dispatch slots reject before reservation while text can still use other slots", async () => {
  const store = new MemoryStore(),
    leases = [];
  for (let i = 0; i < 4; i++)
    leases.push((await store.claim("app", String(i), "owner", 500))!);
  await store.reserve(leases[0], "a", "hash", "media");
  await store.reserve(leases[1], "b", "hash", "media");
  await assert.rejects(store.reserve(leases[2], "c", "hash", "media"), {
    code: "CAPACITY_EXCEEDED",
    retrySafe: true,
  });
  assert.equal(await store.lookup(leases[2].id, "c"), null);
  await store.reserve(leases[2], "text", "hash", "text");
  await store.finish(leases[0], "a", "submitted", "id");
  assert.equal(
    (await store.reserve(leases[3], "d", "hash", "media")).fresh,
    true,
  );
});
test("private secret files reject conflicting sources and writable mounts without leaking contents", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wa-secret-"));
  const file = join(dir, "secret");
  const old = process.env.PROVISION_TOKEN,
    oldFile = process.env.PROVISION_TOKEN_FILE;
  try {
    delete process.env.PROVISION_TOKEN;
    process.env.PROVISION_TOKEN_FILE = file;
    await writeFile(file, "secret-value\n", { mode: 0o600 });
    await loadSecretFiles();
    assert.equal(process.env.PROVISION_TOKEN, "secret-value");
    await assert.rejects(loadSecretFiles(), /one secret source/);
    delete process.env.PROVISION_TOKEN;
    await chmod(file, 0o666);
    await assert.rejects(
      loadSecretFiles(),
      /Secret file unavailable or unsafe/,
    );
  } finally {
    if (old === undefined) delete process.env.PROVISION_TOKEN;
    else process.env.PROVISION_TOKEN = old;
    if (oldFile === undefined) delete process.env.PROVISION_TOKEN_FILE;
    else process.env.PROVISION_TOKEN_FILE = oldFile;
    await rm(dir, { recursive: true });
  }
});
test("fixed-memory histograms and pilot defaults do not claim real-account capacity", () => {
  const h = new Histogram();
  for (const ms of [1, 2, 5, 10, 100]) h.observe(ms);
  assert.equal(h.snapshot().count, 5);
  assert.equal(h.snapshot().p95_ms, 100);
  assert.equal(h.snapshot().mean_ms, 24);
  const old = process.env.MAX_SESSIONS;
  delete process.env.MAX_SESSIONS;
  assert.equal(runtimeSettings().maxSessions, 1);
  process.env.MAX_SESSIONS = "501";
  assert.throws(runtimeSettings, /MAX_SESSIONS/);
  if (old === undefined) delete process.env.MAX_SESSIONS;
  else process.env.MAX_SESSIONS = old;
});
