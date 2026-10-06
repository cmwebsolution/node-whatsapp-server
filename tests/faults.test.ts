import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, connect, type Socket, type Server } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { once } from "node:events";
import { poolFromEnvironment, SqlStore, keyFor } from "../src/store.js";
import { Vault } from "../src/crypto.js";
import { migrate } from "../src/schema.js";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as { port: number }).port;
}
async function until(check: () => Promise<boolean>, timeout: number) {
  const start = performance.now();
  while (performance.now() - start < timeout) {
    if (await check().catch(() => false))
      return Math.round(performance.now() - start);
    await sleep(200);
  }
  throw new Error("Recovery deadline exceeded");
}

test(
  "actual SIGKILL, transport outage and MySQL network outage recover without replaying uncertain submissions",
  { skip: process.env.RUN_FAULT_TESTS !== "1", timeout: 150000 },
  async () => {
    const pool = poolFromEnvironment(),
      app = "fault-" + randomUUID(),
      token = randomBytes(32).toString("base64url"),
      master = randomBytes(32).toString("base64");
    const proxySockets = new Set<Socket>(),
      transportSockets = new Set<Socket>();
    let blockDb = false,
      blockTransport = false,
      hold = false,
      dispatches = 0,
      output = "";
    const upstream = createServer((socket) => {
      if (blockTransport) {
        socket.destroy();
        return;
      }
      transportSockets.add(socket);
      socket.on("close", () => transportSockets.delete(socket));
      socket.on("error", () => {});
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        while (buffer.includes("\n")) {
          buffer = buffer.slice(buffer.indexOf("\n") + 1);
          dispatches++;
          if (!hold)
            socket.write(
              JSON.stringify({ id: "fixture-message-" + dispatches }) + "\n",
            );
        }
      });
    });
    const upstreamPort = await listen(upstream);
    const proxy = createServer((client) => {
      if (blockDb) {
        client.destroy();
        return;
      }
      const remote = connect(Number(process.env.DB_PORT), process.env.DB_HOST);
      proxySockets.add(client);
      proxySockets.add(remote);
      client.on("error", () => {});
      remote.on("error", () => client.destroy());
      client.on("close", () => {
        remote.destroy();
        proxySockets.delete(client);
      });
      remote.on("close", () => {
        client.destroy();
        proxySockets.delete(remote);
      });
      client.pipe(remote).pipe(client);
    });
    const dbPort = await listen(proxy);
    const reserved = createServer();
    const httpPort = await listen(reserved);
    await new Promise<void>((r) => reserved.close(() => r()));
    const url = "http://127.0.0.1:" + httpPort,
      headers = { authorization: "Bearer " + token, "x-whatsapp-app-id": app };
    const children: ChildProcess[] = [];
    const start = () => {
      const child = spawn(
        process.execPath,
        [".test-build/tests/fixtures/fault-server.js"],
        {
          env: {
            ...process.env,
            DB_PORT: String(dbPort),
            PORT: String(httpPort),
            FAULT_UPSTREAM_PORT: String(upstreamPort),
            FAULT_APP_ID: app,
            FAULT_TOKEN: token,
            AUTH_ENCRYPTION_KEYS: JSON.stringify({ v1: master }),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      children.push(child);
      child.stdout!.on("data", (b) => (output += b));
      child.stderr!.on("data", (b) => (output += b));
      return child;
    };
    const request = async (
      path: string,
      method = "GET",
      body?: unknown,
      key?: string,
    ) =>
      fetch(url + path, {
        method,
        headers: {
          ...headers,
          ...(body ? { "content-type": "application/json" } : {}),
          ...(key ? { "idempotency-key": key } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(40000),
      });
    const connected = async () => {
      const r = await request("/api/whatsapp/user/status");
      return (
        transportSockets.size > 0 &&
        r.ok &&
        ((await r.json()) as any).status === "connected"
      );
    };
    const send = (key: string) =>
      request(
        "/api/whatsapp/user/send-message",
        "POST",
        { phone: "919876543210", message: "synthetic fault test" },
        key,
      );
    try {
      await migrate(pool);
      await pool.query(
        "INSERT INTO wa_applications(app_id,token_hash) VALUES (?,?)",
        [app, createHash("sha256").update(token).digest("hex")],
      );
      let child = start();
      await until(async () => (await request("/ready")).ok, 10000);
      await request("/api/whatsapp/connect", "POST", { user_id: "user" });
      await until(connected, 10000);
      const first = await send("before-crash");
      assert.equal(((await first.json()) as any).state, "submitted");
      assert.equal(dispatches, 1);
      hold = true;
      const interrupted = send("interrupted").catch(() => null);
      await until(async () => dispatches === 2, 10000);
      const dead = once(child, "exit");
      child.kill("SIGKILL");
      await dead;
      await interrupted;
      await until(async () => transportSockets.size === 0, 10000);
      hold = false;
      child = start();
      const crashRecovery = await until(connected, 45000);
      const uncertain = await send("interrupted");
      assert.equal(((await uncertain.json()) as any).state, "unknown");
      assert.equal(dispatches, 2);
      const durable = new SqlStore(
        pool,
        new Vault({ v1: Buffer.from(master, "base64") }, "v1"),
      );
      const [rows] = await pool.query<any[]>(
        "SELECT generation,owner FROM wa_sessions WHERE id=?",
        [keyFor(app, "user")],
      );
      const recovered = await durable.auth(
        {
          id: keyFor(app, "user"),
          owner: rows[0].owner,
          generation: Number(rows[0].generation),
        },
        "pre-key",
        ["fixture"],
      );
      assert.equal(recovered.fixture.private.toString(), "fixture-private");
      blockTransport = true;
      for (const s of transportSockets) s.destroy();
      await until(async () => !(await connected()), 10000);
      blockTransport = false;
      const networkRecovery = await until(connected, 15000);
      const networkSend = await send("after-network");
      assert.equal(((await networkSend.json()) as any).state, "submitted");
      assert.equal(dispatches, 3);
      hold = true;
      const storageInterrupted = send("storage-interrupted").catch(() => null);
      await until(async () => dispatches === 4, 10000);
      blockDb = true;
      for (const s of proxySockets) s.destroy();
      await until(async () => !(await request("/ready")).ok, 10000);
      const rejected = await send("during-db-outage");
      assert.equal(rejected.status, 503);
      assert.equal(dispatches, 4);
      await until(async () => transportSockets.size === 0, 20000);
      blockDb = false;
      hold = false;
      const dbRecovery = await until(connected, 65000).catch((error) => {
        console.error(
          output.replaceAll(token, "[token]").replaceAll(master, "[master]"),
        );
        throw error;
      });
      await storageInterrupted;
      assert.equal(
        ((await (await send("storage-interrupted")).json()) as any).state,
        "unknown",
      );
      assert.equal(dispatches, 4);
      assert.equal(
        ((await (await send("after-db")).json()) as any).state,
        "submitted",
      );
      assert.equal(dispatches, 5);
      const exited = once(child, "exit"),
        shutdown = performance.now();
      child.kill("SIGTERM");
      const [code] = await exited;
      assert.equal(code, 0);
      assert.ok(performance.now() - shutdown < 30000);
      for (const value of [
        token,
        master,
        "fixture-private",
        "919876543210",
        "synthetic fault test",
      ])
        assert.ok(!output.includes(value));
      console.log(
        JSON.stringify({
          event: "synthetic_fault_evidence",
          crash_recovery_ms: crashRecovery,
          network_recovery_ms: networkRecovery,
          database_recovery_ms: dbRecovery,
          dispatches,
          no_uncertain_replay: true,
          real_whatsapp: false,
        }),
      );
    } finally {
      for (const c of children)
        if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
      for (const s of [...proxySockets, ...transportSockets]) s.destroy();
      await Promise.all([
        new Promise<void>((r) => proxy.close(() => r())),
        new Promise<void>((r) => upstream.close(() => r())),
      ]);
      for (const table of ["wa_auth", "wa_submissions"])
        await pool.query(
          `DELETE FROM ${table} WHERE session_id IN (SELECT id FROM wa_sessions WHERE app_id=?)`,
          [app],
        );
      for (const table of [
        "wa_sessions",
        "wa_events",
        "wa_event_streams",
        "wa_applications",
      ])
        await pool.query(`DELETE FROM ${table} WHERE app_id=?`, [app]);
      await pool.end();
    }
  },
);
