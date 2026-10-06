import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHmac, createHash } from "node:crypto";
import { SqlStore, poolFromEnvironment } from "../src/store.js";
import { Vault } from "../src/crypto.js";
import { migrate } from "../src/schema.js";
import { signResponse } from "../src/events.js";
import { createApp } from "../src/app.js";
import { Sessions } from "../src/service.js";
import { MemoryStore } from "./fakes.js";

test("signatures bind exact bytes, app, nonce, time and version; authenticated feed excludes private payloads", async () => {
  const key = Buffer.alloc(32, 7),
    nonce = "a".repeat(32),
    config = { current: "v2", keys: { v2: key } };
  const signed = signResponse(
    config,
    "app",
    nonce,
    '{"success":true}',
    "1791288000",
  );
  assert.equal(signed["x-whatsapp-key-id"], "v2");
  assert.equal(
    signed["x-whatsapp-signature"],
    createHmac("sha256", key)
      .update(["app", nonce, "1791288000", '{"success":true}'].join("\n"))
      .digest("hex"),
  );
  for (const body of ['{"success":false}', '{"success":true} '])
    assert.notEqual(
      signResponse(config, "app", nonce, body, "1791288000")[
        "x-whatsapp-signature"
      ],
      signed["x-whatsapp-signature"],
    );
  const store = new MemoryStore(),
    sessions = new Sessions(store, async () => ({
      send: async () => null,
      close: async () => {},
      logout: async () => {},
    }));
  const app = createApp(
    sessions,
    { app: createHash("sha256").update("token").digest("hex") },
    { app: config },
  );
  const headers = {
    authorization: "Bearer token",
    "x-whatsapp-app-id": "app",
    "x-whatsapp-nonce": nonce,
  };
  try {
    const lease = (await store.claim("app", "user", "owner", 500))!;
    await store.update(lease, "connected", "919876543210");
    await store.writeAuth(lease, [
      { type: "creds", id: "main", value: "secret-credential" },
    ]);
    const r = await app.inject({
      url: "/api/whatsapp/events?after=0&limit=1",
      headers,
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().has_more, true);
    assert.equal(r.json().next_cursor, "1");
    assert.equal(
      r.headers["x-whatsapp-signature"],
      signResponse(
        config,
        "app",
        nonce,
        r.body,
        String(r.headers["x-whatsapp-timestamp"]),
      )["x-whatsapp-signature"],
    );
    assert.ok(!r.body.includes("secret-credential"));
    assert.ok(!r.body.includes("qr"));
    const snapshot = await app.inject({
      url: "/api/whatsapp/snapshots",
      headers,
    });
    assert.equal(snapshot.json().sessions[0].revision, "2");
    const missing = await app.inject({
      url: "/api/whatsapp/user/submissions/missing",
      headers,
    });
    assert.equal(missing.statusCode, 404);
    assert.ok(missing.headers["x-whatsapp-signature"]);
    assert.equal(
      (
        await app.inject({
          url: "/api/whatsapp/events",
          headers: { ...headers, "x-whatsapp-nonce": "bad" },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (await app.inject({ url: "/api/whatsapp/events" })).headers[
        "x-whatsapp-signature"
      ],
      undefined,
    );
  } finally {
    await app.close();
    await sessions.shutdown();
  }
});

test(
  "MySQL journal rollback, concurrent writers, commit ordering, snapshot replay and cursor retention",
  { skip: process.env.RUN_DATABASE_TESTS !== "1" },
  async () => {
    const pool = poolFromEnvironment(),
      store = new SqlStore(pool, new Vault({ v1: Buffer.alloc(32, 1) }, "v1")),
      app = "journal-" + randomUUID();
    let trigger = false;
    try {
      await migrate(pool);
      await pool.query(
        "INSERT INTO wa_applications(app_id,token_hash) VALUES (?,?)",
        [app, createHash("sha256").update(app).digest("hex")],
      );
      const leases = [];
      for (let i = 0; i < 8; i++)
        leases.push((await store.claim(app, "user-" + i, "owner", 500))!);
      const before = await store.events(app, "0", 100);
      await pool.query(
        `ALTER TABLE wa_events ADD CONSTRAINT wa_test_event_failure CHECK (app_id <> '${app}' OR event_type <> 'connection' OR JSON_UNQUOTE(JSON_EXTRACT(payload,'$.status')) <> 'connected')`,
      );
      trigger = true;
      await assert.rejects(
        store.update(leases[0], "connected", "919876543210"),
      );
      assert.equal((await store.status(leases[0].id)).status, "connecting");
      assert.deepEqual(await store.events(app, "0", 100), before);
      await pool.query(
        "ALTER TABLE wa_events DROP CHECK wa_test_event_failure",
      );
      trigger = false;
      await Promise.all(
        leases.map((l) => store.update(l, "connected", "919876543210")),
      );
      const all = await store.events(app, "0", 100);
      assert.equal(all.events.length, 16);
      assert.deepEqual(
        all.events.map((e) => e.sequence),
        Array.from({ length: 16 }, (_, i) => String(i + 1)),
      );
      const first = await store.events(app, "0", 3),
        second = await store.events(app, first.next_cursor, 3);
      assert.equal(second.events[0].sequence, "4");
      const snapshot = await store.snapshots(app, "", 2);
      assert.equal(snapshot.cursor, "16");
      assert.ok(snapshot.next_after);
      await store.update(leases[0], "connecting");
      const next = await store.snapshots(
        app,
        snapshot.next_after!,
        2,
        snapshot.cursor,
      );
      assert.equal(next.cursor, "16");
      assert.equal(
        (await store.events(app, snapshot.cursor, 100)).events[0].revision,
        "3",
      );
      // A reader waits behind an uncommitted stream writer; its cursor cannot skip it.
      const c = await pool.getConnection();
      await c.beginTransaction();
      await c.query(
        "SELECT * FROM wa_event_streams WHERE app_id=? FOR UPDATE",
        [app],
      );
      let done = false;
      const writing = store.update(leases[1], "connecting").then(() => {
        done = true;
      });
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(done, false);
      const reading = store.events(app, "17", 100);
      await c.commit();
      c.release();
      await writing;
      const read = await reading;
      assert.equal(read.next_cursor, "18");
      await store.reserve(leases[0], "uncertain", "hash");
      await pool.query(
        "UPDATE wa_submissions SET dispatch_until=TIMESTAMPADD(SECOND,-1,NOW(3)) WHERE session_id=?",
        [leases[0].id],
      );
      await store.cleanup();
      assert.equal(
        (await store.lookup(leases[0].id, "uncertain"))?.state,
        "unknown",
      );
      assert.ok(
        (await store.events(app, "18", 100)).events.some(
          (e) => e.payload.state === "unknown",
        ),
      );
      await pool.query(
        "UPDATE wa_events SET created_at=TIMESTAMPADD(DAY,-8,NOW(3)) WHERE app_id=?",
        [app],
      );
      await store.cleanup();
      await assert.rejects(store.events(app, "0", 100), {
        code: "EVENT_CURSOR_EXPIRED",
      });
      const fresh = await store.snapshots(app, "", 100);
      assert.equal(
        (await store.events(app, fresh.cursor, 100)).events.length,
        0,
      );
    } finally {
      if (trigger)
        await pool.query(
          "ALTER TABLE wa_events DROP CHECK wa_test_event_failure",
        );
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
      await store.close();
    }
  },
);

test("MySQL-only engine guard rejects incompatible engines before schema mutations", async () => {
  const { verifyMySQL } = await import("../src/schema.js");
  await assert.rejects(
    verifyMySQL({
      query: async () => [[{ version: "11.4.13-MariaDB" }]],
    } as any),
    /MySQL database required/,
  );
  await verifyMySQL({ query: async () => [[{ version: "8.4.11" }]] } as any);
});
