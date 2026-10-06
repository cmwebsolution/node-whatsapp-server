import { test } from "node:test";
import assert from "node:assert/strict";
import { Vault } from "../src/crypto.js";
import { databaseAuth } from "../src/auth.js";
import { MemoryStore } from "./fakes.js";
test("binary auth serialization, authenticated encryption and context isolation", () => {
  const vault = new Vault({ v1: Buffer.alloc(32, 1) }, "v1");
  const value = { secret: Buffer.from([0, 255, 4]) };
  const cipher = vault.seal(value, "account/key");
  assert.ok(!cipher.includes("secret"));
  assert.deepEqual(vault.open(cipher, "account/key"), value);
  assert.throws(() => vault.open(cipher, "other/key"));
  const envelope = JSON.parse(cipher);
  envelope.tag = Buffer.alloc(16).toString("base64");
  assert.throws(() => vault.open(JSON.stringify(envelope), "account/key"));
  assert.throws(() => new Vault({ v1: Buffer.alloc(2) }, "v1"));
});
test("key rotation can read old ciphertext", () => {
  const v1 = new Vault({ v1: Buffer.alloc(32, 1) }, "v1");
  const v2 = new Vault(
    { v1: Buffer.alloc(32, 1), v2: Buffer.alloc(32, 2) },
    "v2",
  );
  assert.deepEqual(v2.open(v1.seal({ a: 1 }, "x"), "x"), { a: 1 });
});
test("database auth saves credentials, restores buffers and deletes Signal keys", async () => {
  const store = new MemoryStore();
  const l = (await store.claim("a", "u", "owner", 1))!;
  const auth = await databaseAuth(store, l);
  await auth.state.keys.set({
    "pre-key": { "1": { public: Buffer.from("a"), private: Buffer.from("b") } },
  });
  assert.equal(
    (await auth.state.keys.get("pre-key", ["1"]))["1"].public.toString(),
    "a",
  );
  await auth.state.keys.set({ "pre-key": { "1": null } });
  assert.equal((await auth.state.keys.get("pre-key", ["1"]))["1"], undefined);
  auth.state.creds.registered = true;
  await auth.save();
  assert.equal((await databaseAuth(store, l)).state.creds.registered, true);
});
