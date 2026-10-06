import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SqlStore, poolFromEnvironment, keyFor } from "../src/store.js";
import { Vault } from "../src/crypto.js";
import { migrate } from "../src/schema.js";
import { databaseAuth } from "../src/auth.js";
test(
  "SQL transactions: ownership, encrypted auth, restart, idempotency, capacity and retention",
  { skip: process.env.RUN_DATABASE_TESTS !== "1" },
  async () => {
    const pool = poolFromEnvironment();
    const store = new SqlStore(
      pool,
      new Vault({ v1: Buffer.alloc(32, 1) }, "v1"),
    );
    const app = "test-" + randomUUID();
    try {
      await migrate(pool);
      await migrate(pool);
      await store.ready();
      await pool.query(
        "INSERT INTO wa_applications (app_id,token_hash) VALUES (?,?)",
        [app, app.padEnd(64, "0")],
      );
      const [first, second] = await Promise.all([
        store.claim(app, "same", "owner-a", 500),
        store.claim(app, "same", "owner-b", 500),
      ]);
      assert.equal([first, second].filter(Boolean).length, 1);
      const lease = (first ?? second)!;
      const auth = await databaseAuth(store, lease);
      auth.state.creds.registered = true;
      await auth.save();
      await auth.state.keys.set({
        "pre-key": {
          "1": {
            public: Buffer.from("secret-public"),
            private: Buffer.from("secret-private"),
          },
        },
      });
      const [rows] = await pool.query<any[]>(
        "SELECT key_type,key_id,payload FROM wa_auth WHERE session_id=?",
        [lease.id],
      );
      assert.ok(rows.every((r: any) => !r.payload.includes("secret-private")));
      // Restore encrypted rows from a snapshot with a separately recovered master key.
      await pool.query("DELETE FROM wa_auth WHERE session_id=?", [lease.id]);
      for (const row of rows)
        await pool.query(
          "INSERT INTO wa_auth (session_id,key_type,key_id,payload) VALUES (?,?,?,?)",
          [lease.id, row.key_type, row.key_id, row.payload],
        );
      const recoveredStore = new SqlStore(
        pool,
        new Vault({ v1: Buffer.alloc(32, 1) }, "v1"),
      );
      const restored = await databaseAuth(recoveredStore, lease);
      assert.equal(restored.state.creds.registered, true);
      assert.equal(
        (await restored.state.keys.get("pre-key", ["1"]))[
          "1"
        ].private.toString(),
        "secret-private",
      );
      await restored.state.keys.set({ "pre-key": { "1": null } });
      assert.equal(
        (await restored.state.keys.get("pre-key", ["1"]))["1"],
        undefined,
      );
      assert.ok(
        (await store.restore()).some((r) => r.app === app && r.user === "same"),
      );
      assert.equal((await store.reserve(lease, "intent", "hash")).fresh, true);
      assert.equal((await store.reserve(lease, "intent", "hash")).fresh, false);
      await assert.rejects(store.reserve(lease, "intent", "different"), {
        code: "IDEMPOTENCY_CONFLICT",
      });
      await pool.query(
        "UPDATE wa_sessions SET lease_until=TIMESTAMPADD(SECOND,-1,NOW(3)) WHERE id=?",
        [lease.id],
      );
      await assert.rejects(
        store.writeAuth(lease, [
          { type: "creds", id: "main", value: { bad: true } },
        ]),
        { code: "LEASE_LOST" },
      );
      const expiredRevision = (await store.status(lease.id)).revision!;
      const expiryEvents = await store.events(app, "0", 100);
      assert.ok(
        expiryEvents.events.some(
          (e) =>
            e.type === "connection" &&
            e.revision === expiredRevision &&
            e.payload.status === "connecting",
        ),
      );
      const next = (await store.claim(app, "same", "owner-c", 500))!;
      assert.ok(
        BigInt((await store.status(next.id)).revision!) >
          BigInt(expiredRevision),
      );
      assert.equal(next.generation, lease.generation + 1);
      assert.equal((await store.lookup(lease.id, "intent"))?.state, "unknown");
      await assert.rejects(store.finish(lease, "intent", "submitted", "bad"), {
        code: "LEASE_LOST",
      });
      await store.reserve(next, "new", "hash");
      await store.finish(next, "new", "submitted", "message-id");
      assert.equal(
        (await store.lookup(next.id, "new"))?.message_id,
        "message-id",
      );
      assert.equal(await store.lookup(keyFor("other", "same"), "new"), null);
      // Database semaphore applies across owners and processes.
      const leases = [];
      for (let i = 0; i < 11; i++)
        leases.push((await store.claim(app, "slot-user-" + i, "owner", 500))!);
      for (let i = 0; i < 10; i++)
        await store.reserve(leases[i], "slot", "hash");
      await assert.rejects(store.reserve(leases[10], "slot", "hash"), {
        code: "CAPACITY_EXCEEDED",
        retrySafe: true,
      });
      assert.equal(await store.lookup(leases[10].id, "slot"), null);
      await assert.rejects(store.reserve(leases[0], "other", "hash"), {
        code: "SEND_IN_PROGRESS",
        retrySafe: true,
      });
      for (let i = 0; i < 10; i++)
        await store.finish(leases[i], "slot", "failed");
      for (const l of leases) await store.release(l);
      await store.reserve(next, "expired", "hash");
      await pool.query(
        "UPDATE wa_submissions SET dispatch_until=TIMESTAMPADD(SECOND,-1,NOW(3)) WHERE session_id=? AND idempotency_key=?",
        [next.id, "expired"],
      );
      assert.equal((await store.lookup(next.id, "expired"))?.state, "unknown");
      await store.cleanup();
      const mediaLeases = [];
      for (let i = 0; i < 3; i++)
        mediaLeases.push((await store.claim(app, "media-" + i, "owner", 500))!);
      await store.reserve(mediaLeases[0], "pdf", "hash", "media");
      await store.reserve(mediaLeases[1], "png", "hash", "media");
      await assert.rejects(
        store.reserve(mediaLeases[2], "full", "hash", "media"),
        { code: "CAPACITY_EXCEEDED", retrySafe: true },
      );
      assert.equal(await store.lookup(mediaLeases[2].id, "full"), null);
      for (let i = 0; i < 2; i++)
        await store.finish(
          mediaLeases[i],
          i === 0 ? "pdf" : "png",
          "submitted",
          "id",
        );
      for (const l of mediaLeases) await store.release(l);
      const leased = await store.claim(app, "other", "owner-d", 500);
      assert.ok(leased);
      await assert.rejects(store.claim(app, "over-capacity", "owner-e", 1), {
        code: "CAPACITY_EXCEEDED",
      });
      await store.release(leased!);
      await store.clear(next);
      assert.equal((await store.auth(next, "creds", ["main"])).main, undefined);
      await store.release(next);
      assert.equal((await store.status(next.id)).status, "disconnected");
      await pool.query(
        "UPDATE wa_submissions SET created_at=TIMESTAMPADD(DAY,-8,NOW(3)) WHERE session_id=?",
        [next.id],
      );
      await store.cleanup();
      assert.equal(await store.lookup(next.id, "new"), null);
    } finally {
      await pool.query(
        "DELETE FROM wa_auth WHERE session_id IN (SELECT id FROM wa_sessions WHERE app_id=?)",
        [app],
      );
      await pool.query(
        "DELETE FROM wa_submissions WHERE session_id IN (SELECT id FROM wa_sessions WHERE app_id=?)",
        [app],
      );
      await pool.query("DELETE FROM wa_sessions WHERE app_id=?", [app]);
      await pool.query("DELETE FROM wa_events WHERE app_id=?", [app]);
      await pool.query("DELETE FROM wa_event_streams WHERE app_id=?", [app]);
      await pool.query("DELETE FROM wa_applications WHERE app_id=?", [app]);
      await store.close();
    }
  },
);
