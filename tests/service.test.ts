import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createApp } from "../src/app.js";
import { Sessions, type DriverEvent } from "../src/service.js";
import { MemoryStore } from "./fakes.js";
const payload = {
  kind: "text" as const,
  phone: "919876543210",
  message: "Hello",
};
async function setup(ms = 1000) {
  const store = new MemoryStore();
  let sends = 0,
    closes = 0;
  const events = new Map<string, (e: DriverEvent) => void>();
  let send: () => Promise<string | null> = async () => {
    sends++;
    return "message-1";
  };
  const sessions = new Sessions(
    store,
    async (_store, l, event) => {
      events.set(l.id, event);
      return {
        send: () => send(),
        close: async () => {
          closes++;
        },
        logout: async () => {},
      };
    },
    500,
    ms,
  );
  await sessions.connect("a", "user");
  await new Promise((r) => setTimeout(r, 5));
  [...events.values()][0]({ kind: "open", phone: payload.phone });
  await new Promise((r) => setTimeout(r, 5));
  const app = createApp(sessions, {
    a: createHash("sha256").update("token").digest("hex"),
  });
  return {
    store,
    sessions,
    app,
    get sends() {
      return sends;
    },
    get closes() {
      return closes;
    },
    setSend: (f: typeof send) => {
      send = f;
    },
    events,
    close: async () => {
      await sessions.shutdown();
      await app.close();
    },
  };
}
const headers = {
  authorization: "Bearer token",
  "x-whatsapp-app-id": "a",
  "idempotency-key": "intent-1",
};
test("authenticated Laravel routes, mandatory key, duplicate replay and payload conflict", async () => {
  const x = await setup();
  try {
    assert.equal(
      (await x.app.inject({ url: "/api/whatsapp/user/status" })).statusCode,
      401,
    );
    assert.equal(
      (
        await x.app.inject({
          url: "/api/whatsapp/user/status",
          headers: { ...headers, "x-whatsapp-app-id": "b" },
        })
      ).statusCode,
      403,
    );
    const sent = await x.app.inject({
      method: "POST",
      url: "/api/whatsapp/user/send-message",
      headers,
      payload: { phone: payload.phone, message: payload.message },
    });
    assert.equal(sent.statusCode, 200);
    assert.equal(sent.json().state, "submitted");
    assert.equal(sent.json().message_id, "message-1");
    const repeat = await x.app.inject({
      method: "POST",
      url: "/api/whatsapp/user/send-message",
      headers,
      payload: { message: payload.message, phone: payload.phone },
    });
    assert.deepEqual(repeat.json(), sent.json());
    assert.equal(x.sends, 1);
    assert.equal(
      (
        await x.app.inject({
          method: "POST",
          url: "/api/whatsapp/user/send-message",
          headers,
          payload: { phone: payload.phone, message: "changed" },
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await x.app.inject({
          method: "POST",
          url: "/api/whatsapp/user/send-message",
          headers: { authorization: "Bearer token", "x-whatsapp-app-id": "a" },
          payload: { phone: payload.phone, message: "Hi" },
        })
      ).statusCode,
      422,
    );
    const lookup = await x.app.inject({
      url: "/api/whatsapp/user/submissions/intent-1",
      headers,
    });
    assert.equal(lookup.json().state, "submitted");
    assert.equal(lookup.headers["cache-control"], "no-store");
  } finally {
    await x.close();
  }
});
test("concurrent account sends serialize and duplicate observes pending", async () => {
  const x = await setup();
  let resolve!: (value: string) => void;
  x.setSend(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  try {
    const pending = x.sessions.send("a", "user", "one", payload);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(
      (await x.sessions.send("a", "user", "one", payload)).state,
      "pending",
    );
    await assert.rejects(x.sessions.send("a", "user", "two", payload), {
      code: "SEND_IN_PROGRESS",
    });
    resolve("id");
    assert.equal((await pending).state, "submitted");
  } finally {
    await x.close();
  }
});
test("timeout becomes unknown, closes socket, and survives restart without redispatch", async () => {
  const x = await setup(20);
  x.setSend(() => new Promise(() => {}));
  try {
    assert.equal(
      (await x.sessions.send("a", "user", "one", payload)).state,
      "unknown",
    );
    assert.ok(x.closes > 0);
    const other = new Sessions(x.store, async () => {
      throw new Error("must not create socket");
    });
    assert.equal(
      (await other.send("a", "user", "one", payload)).state,
      "unknown",
    );
    await other.shutdown();
  } finally {
    await x.close();
  }
});
test("database failure rejects before dispatch and readiness fails safely", async () => {
  const x = await setup();
  try {
    x.store.fail = true;
    await assert.rejects(x.sessions.send("a", "user", "one", payload));
    assert.equal(x.sends, 0);
    assert.equal((await x.app.inject({ url: "/ready" })).statusCode, 503);
  } finally {
    x.store.fail = false;
    await x.close();
  }
});
test("logout clears auth and app/user identities remain isolated", async () => {
  const x = await setup();
  try {
    assert.equal((await x.sessions.status("b", "user")).status, "disconnected");
    assert.equal(
      (await x.sessions.status("a", "other")).status,
      "disconnected",
    );
    await x.sessions.disconnect("a", "user");
    assert.equal((await x.sessions.status("a", "user")).status, "disconnected");
    assert.deepEqual(await x.store.restore(), []);
  } finally {
    await x.close();
  }
});
test("PDF/PNG supported; malformed JSON and invalid media rejected", async () => {
  const x = await setup();
  try {
    for (const [mimetype, filename, data] of [
      ["application/pdf", "bill.pdf", Buffer.from("%PDF-1.4\n%%EOF")],
      [
        "image/png",
        "image.png",
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
          "base64",
        ),
      ],
    ]) {
      const response = await x.app.inject({
        method: "POST",
        url: "/api/whatsapp/user/send-media",
        headers: {
          ...headers,
          "idempotency-key": String(filename).replace(".", "-"),
        },
        payload: {
          phone: payload.phone,
          media: {
            mimetype,
            filename,
            data: (data as Buffer).toString("base64"),
            caption: "",
          },
        },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().state, "submitted");
    }
    assert.equal(
      (
        await x.app.inject({
          method: "POST",
          url: "/api/whatsapp/user/send-message",
          headers: { ...headers, "content-type": "application/json" },
          payload: "{",
        })
      ).statusCode,
      422,
    );
  } finally {
    await x.close();
  }
});

test("QR lifetime, reconnect transitions and late events cannot revive a logged-out socket", async () => {
  const x = await setup();
  try {
    const event = [...x.events.values()][0];
    event({ kind: "qr", qr: "private-pairing-payload" });
    for (
      let i = 0;
      i < 40 && (await x.sessions.status("a", "user")).status !== "qr_required";
      i++
    )
      await new Promise((r) => setTimeout(r, 5));
    const qr = await x.sessions.status("a", "user", true);
    assert.equal(qr.status, "qr_required");
    assert.ok(qr.qr?.startsWith("data:image/png;base64,"));
    assert.ok(Date.parse(qr.expires_at!) > Date.now());
    event({ kind: "open", phone: payload.phone });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal((await x.sessions.status("a", "user", true)).qr, null);
    event({ kind: "close", loggedOut: false });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal((await x.sessions.status("a", "user")).status, "connecting");
    await x.sessions.disconnect("a", "user");
    event({ kind: "open", phone: payload.phone });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal((await x.sessions.status("a", "user")).status, "disconnected");
  } finally {
    await x.close();
  }
});
test("canonical media field order and extra properties do not change submission hash", async () => {
  const x = await setup();
  try {
    const media = {
      mimetype: "application/pdf",
      data: Buffer.from("%PDF-1.4").toString("base64"),
      filename: "bill.pdf",
      caption: "",
    };
    const first = await x.app.inject({
      method: "POST",
      url: "/api/whatsapp/user/send-media",
      headers,
      payload: { phone: payload.phone, media },
    });
    const second = await x.app.inject({
      method: "POST",
      url: "/api/whatsapp/user/send-media",
      headers,
      payload: {
        phone: payload.phone,
        media: {
          caption: "",
          filename: media.filename,
          data: media.data,
          mimetype: media.mimetype,
          ignored: "x",
        },
      },
    });
    assert.equal(first.statusCode, 200);
    assert.deepEqual(second.json(), first.json());
    assert.equal(x.sends, 1);
  } finally {
    await x.close();
  }
});
test("database failure after dispatch is unknown, never a safe-to-retry failure", async () => {
  const x = await setup();
  x.setSend(async () => {
    x.store.fail = true;
    return "accepted";
  });
  try {
    assert.equal(
      (await x.sessions.send("a", "user", "one", payload)).state,
      "unknown",
    );
  } finally {
    x.store.fail = false;
    await x.close();
  }
});

test("overall submission deadline includes a stalled reservation and forbids late dispatch", async () => {
  const x = await setup(20);
  const reserve = x.store.reserve.bind(x.store);
  let release!: () => void;
  x.store.reserve = async (...args) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return reserve(...args);
  };
  try {
    await assert.rejects(
      x.sessions.send("a", "user", "slow-storage", payload),
      { code: "SERVICE_UNAVAILABLE" },
    );
    assert.equal(x.sends, 0);
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(x.sends, 0);
    assert.equal(
      (await x.sessions.lookup("a", "user", "slow-storage")).state,
      "unknown",
    );
  } finally {
    await x.close();
  }
});

test("global execution capacity rejects immediately with retry metadata and no ledger reservation", async () => {
  const x = await setup();
  let release!: () => void;
  const held = new Promise<string>((r) => {
    release = () => r("accepted");
  });
  x.setSend(() => held);
  try {
    for (let i = 1; i < 50; i++) {
      await x.sessions.connect("a", "capacity-" + i);
      await new Promise((r) => setTimeout(r, 1));
      [...x.events.values()].at(-1)!({ kind: "open", phone: payload.phone });
    }
    await new Promise((r) => setTimeout(r, 5));
    const results: any[] = [];
    const requests = Array.from({ length: 50 }, (_, i) =>
      x.app
        .inject({
          method: "POST",
          url: `/api/whatsapp/${i === 0 ? "user" : "capacity-" + i}/send-message`,
          headers: { ...headers, "idempotency-key": "capacity-intent" },
          payload: { phone: payload.phone, message: payload.message },
        })
        .then((r) => {
          results.push(r);
          return r;
        }),
    );
    const deadline = Date.now() + 1000;
    while (results.length < 40 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(
      results.length,
      40,
      "Capacity errors must complete while the ten sends remain blocked",
    );
    for (const r of results) {
      assert.equal(r.statusCode, 503);
      assert.equal(r.json().code, "CAPACITY_EXCEEDED");
      assert.equal(r.json().retry_safe, true);
      assert.equal(r.headers["retry-after"], "2");
    }
    assert.equal(x.store.submissions.size, 10);
    assert.equal(x.store.slots, 10);
    release();
    const finished = await Promise.all(requests);
    assert.equal(finished.filter((r) => r.statusCode === 200).length, 10);
  } finally {
    release?.();
    await x.close();
  }
});
