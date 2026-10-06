import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { poolFromEnvironment } from "../src/store.js";
import { migrate } from "../src/schema.js";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
test(
  "real HTTP process starts on Node 24, restarts and handles SIGTERM without leaking secrets",
  { skip: process.env.RUN_DATABASE_TESTS !== "1" },
  async () => {
    const pool = poolFromEnvironment();
    await migrate(pool);
    const token = randomBytes(32).toString("base64url"),
      app = "runtime-test",
      key = randomBytes(32).toString("base64");
    await pool.query(
      "INSERT INTO wa_applications (app_id,token_hash) VALUES (?,?)",
      [app, createHash("sha256").update(token).digest("hex")],
    );
    const children: ReturnType<typeof spawn>[] = [];
    let output = "";
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const child = spawn(process.execPath, [".test-build/src/server.js"], {
          env: {
            ...process.env,
            HOST: "127.0.0.1",
            PORT: "33318",
            AUTH_ENCRYPTION_KEYS: JSON.stringify({ v1: key }),
            EVENT_SIGNING_KEYS: JSON.stringify({
              [app]: {
                current: "v1",
                keys: { v1: randomBytes(32).toString("base64") },
              },
            }),
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        children.push(child);
        child.stdout?.on("data", (b) => {
          output += b;
        });
        child.stderr?.on("data", (b) => {
          output += b;
        });
        let ready = false;
        for (let i = 0; i < 100; i++) {
          try {
            ready = (await fetch("http://127.0.0.1:33318/ready")).ok;
          } catch {}
          if (ready) break;
          if (child.exitCode !== null) break;
          await wait(25);
        }
        assert.equal(ready, true, output);
        const response = await fetch(
          "http://127.0.0.1:33318/api/whatsapp/user/status",
          {
            headers: {
              authorization: `Bearer ${token}`,
              "x-whatsapp-app-id": app,
            },
          },
        );
        assert.equal(response.status, 200);
        assert.equal(((await response.json()) as any).status, "disconnected");
        const exited = new Promise<number | null>((resolve) =>
          child.once("exit", resolve),
        );
        child.kill("SIGTERM");
        assert.equal(await exited, 0);
      }
      assert.ok(!output.includes(token));
      assert.ok(!output.includes(key));
    } finally {
      for (const child of children)
        if (child.exitCode === null) child.kill("SIGKILL");
      await pool.query("DELETE FROM wa_applications WHERE app_id=?", [app]);
      await pool.end();
    }
  },
);
