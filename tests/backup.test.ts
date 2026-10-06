import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import mysql from "mysql2/promise";
import { SqlStore, poolFromEnvironment } from "../src/store.js";
import { Vault } from "../src/crypto.js";
import { databaseAuth } from "../src/auth.js";
import { migrate } from "../src/schema.js";

test(
  "encrypted transactional backup verifies before restore and separately recovered auth keys restore buffers",
  { skip: process.env.RUN_BACKUP_TESTS !== "1", timeout: 30000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "wa-backup-")),
      app = "backup-" + randomUUID(),
      target = "wa_restore_" + randomUUID().replaceAll("-", "");
    const admin = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      user: "root",
      password: process.env.TEST_DB_ADMIN_PASSWORD ?? "",
    });
    const pool = poolFromEnvironment(),
      vault = new Vault({ v1: Buffer.alloc(32, 1) }, "v1"),
      store = new SqlStore(pool, vault);
    const config = join(dir, "client.cnf"),
      key = join(dir, "backup-keys.json"),
      artifact = join(dir, "backup.waenc");
    const env = {
      ...process.env,
      MYSQL_CLIENT_CONFIG: config,
      BACKUP_KEYS_FILE: key,
      BACKUP_KEY_VERSION: "backup-v1",
      BACKUP_RESTORE_DATABASE: target,
      BACKUP_RESTORE_ALLOWED: "true",
    };
    const run = (action: string) =>
      new Promise<{ code: number | null; output: string }>((resolve) => {
        let output = "";
        const c = spawn(
          process.execPath,
          ["scripts/backup.mjs", action, artifact],
          { env, stdio: ["ignore", "pipe", "pipe"] },
        );
        c.stdout.on("data", (b) => (output += b));
        c.stderr.on("data", (b) => (output += b));
        c.on("exit", (code) => resolve({ code, output }));
      });
    try {
      await migrate(pool);
      await pool.query(
        "INSERT INTO wa_applications(app_id,token_hash) VALUES (?,?)",
        [app, app.padEnd(64, "0")],
      );
      const lease = (await store.claim(
        app,
        "private-backup-user",
        "owner",
        500,
      ))!;
      const auth = await databaseAuth(store, lease);
      auth.state.creds.registered = true;
      await auth.save();
      await auth.state.keys.set({
        "pre-key": {
          backup: {
            public: Buffer.from("test-public"),
            private: Buffer.from("test-private"),
          },
        },
      });
      await writeFile(
        config,
        `[client]\nhost=${process.env.DB_HOST}\nport=${process.env.DB_PORT}\nuser=root\npassword=${process.env.TEST_DB_ADMIN_PASSWORD ?? ""}\n`,
        { mode: 0o600 },
      );
      await writeFile(
        key,
        JSON.stringify({ "backup-v1": Buffer.alloc(32, 2).toString("base64") }),
        { mode: 0o600 },
      );
      assert.equal((await run("create")).code, 0);
      assert.equal((await run("verify")).code, 0);
      const encrypted = await readFile(artifact);
      assert.ok(!encrypted.includes(Buffer.from("private-backup-user")));
      assert.ok(!encrypted.includes(Buffer.from("test-private")));
      await admin.query(`CREATE DATABASE ${target}`);
      assert.equal((await run("restore")).code, 0);
      const restoredPool = mysql.createPool({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT),
        user: "root",
        password: process.env.TEST_DB_ADMIN_PASSWORD ?? "",
        database: target,
        supportBigNumbers: true,
        bigNumberStrings: true,
      });
      try {
        await restoredPool.query(
          "UPDATE wa_sessions SET lease_until=TIMESTAMPADD(SECOND,-1,NOW(3)) WHERE id=?",
          [lease.id],
        );
        const recovered = new SqlStore(
          restoredPool,
          new Vault({ v1: Buffer.alloc(32, 1) }, "v1"),
        );
        const next = (await recovered.claim(
          app,
          "private-backup-user",
          "recovered",
          500,
        ))!;
        const recoveredAuth = await databaseAuth(recovered, next);
        assert.equal(recoveredAuth.state.creds.registered, true);
        assert.equal(
          (
            await recoveredAuth.state.keys.get("pre-key", ["backup"])
          ).backup.private.toString(),
          "test-private",
        );
        await assert.rejects(
          new SqlStore(
            restoredPool,
            new Vault({ v1: Buffer.alloc(32, 3) }, "v1"),
          ).auth(next, "creds", ["main"]),
        );
        // Tampering cannot modify the already restored database.
        encrypted[encrypted.length - 1] ^= 1;
        await writeFile(artifact, encrypted);
        assert.notEqual((await run("restore")).code, 0);
        assert.equal(
          (await recovered.auth(next, "creds", ["main"])).main.registered,
          true,
        );
      } finally {
        await restoredPool.end();
      }
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${target}`);
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
      await admin.end();
      await rm(dir, { recursive: true });
    }
  },
);
