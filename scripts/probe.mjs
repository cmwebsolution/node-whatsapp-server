// Explicit actions only. Probe output excludes credentials, QR, phone and message content.
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const action = process.argv[2] ?? "health";
if (action === "new-key") {
  console.log(randomUUID());
  process.exit(0);
}
const base = process.env.WHATSAPP_NODE_URL,
  app = process.env.WHATSAPP_APP_ID,
  token = process.env.WHATSAPP_NODE_TOKEN,
  user = process.env.PROBE_USER_ID;
if (
  !base ||
  (!/^https:\/\//.test(base) &&
    !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(base))
)
  throw new Error("Configure an HTTPS base URL (loopback HTTP allowed).");
const path =
  "/api/whatsapp/" + encodeURIComponent(user ?? "").replace(/\./g, "%2E");
async function request(endpoint, method = "GET", body, key) {
  if (endpoint.startsWith("/api/") && (!app || !token || !user))
    throw new Error("Configure app/token/user privately.");
  const started = performance.now();
  const response = await fetch(base.replace(/\/$/, "") + endpoint, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "x-whatsapp-app-id": app ?? "",
      ...(body ? { "content-type": "application/json" } : {}),
      ...(key ? { "idempotency-key": key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(40000),
  });
  const result = await response.json();
  console.log(
    JSON.stringify({
      action,
      http: response.status,
      elapsed_ms: Math.round(performance.now() - started),
      success: result.success,
      status: result.status,
      state: result.state,
      code: result.code,
      message_id: result.message_id,
      expires_at: result.expires_at,
    }),
  );
  if (!response.ok)
    throw new Error("Probe failed; inspect sanitized result code.");
  return result;
}
try {
  if (action === "health" || action === "ready") await request("/" + action);
  else if (action === "connect")
    await request("/api/whatsapp/connect", "POST", { user_id: user });
  else if (action === "status") await request(path + "/status");
  else if (action === "qr") {
    const result = await request(path + "/qr");
    if (!result.qr || !process.env.PROBE_QR_FILE)
      throw new Error(
        "QR available only during pairing; set a private PROBE_QR_FILE path.",
      );
    await writeFile(
      process.env.PROBE_QR_FILE,
      Buffer.from(result.qr.split(",")[1], "base64"),
      { mode: 0o600, flag: "wx" },
    );
    console.log(
      "Private QR file created; open locally and delete after scanning.",
    );
  } else if (action === "lookup") {
    if (!process.env.PROBE_KEY) throw new Error("PROBE_KEY required.");
    await request(
      path + "/submissions/" + encodeURIComponent(process.env.PROBE_KEY),
    );
  } else if (["text", "pdf", "png"].includes(action)) {
    if (
      process.env.PROBE_ALLOW_SEND !== "true" ||
      !process.env.PROBE_RECIPIENT ||
      !process.env.PROBE_KEY
    )
      throw new Error(
        "Set PROBE_ALLOW_SEND=true, consenting recipient and a persisted PROBE_KEY.",
      );
    const phone = process.env.PROBE_RECIPIENT,
      key = process.env.PROBE_KEY;
    if (action === "text")
      await request(
        path + "/send-message",
        "POST",
        {
          phone,
          message: process.env.PROBE_TEXT ?? "WhatsApp feasibility test",
        },
        key,
      );
    else {
      if (!process.env.PROBE_ATTACHMENT)
        throw new Error("PROBE_ATTACHMENT path required.");
      const bytes = await readFile(process.env.PROBE_ATTACHMENT);
      if (bytes.length > 8 * 1024 * 1024)
        throw new Error("Attachment exceeds 8 MiB.");
      const media = {
        mimetype: action === "pdf" ? "application/pdf" : "image/png",
        data: bytes.toString("base64"),
        filename: action === "pdf" ? "probe.pdf" : "probe.png",
        caption: "",
      };
      await request(path + "/send-media", "POST", { phone, media }, key);
    }
  } else if (action === "new-key") console.log(randomUUID());
  else
    throw new Error(
      "Actions: health ready connect status qr text pdf png lookup new-key.",
    );
} catch {
  console.error("Probe incomplete. No automatic retry was performed.");
  process.exitCode = 1;
}
