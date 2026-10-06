import { createHmac } from "node:crypto";
import { ApiError } from "./errors.js";
export type StatusEvent = {
  id: string;
  sequence: string;
  application_id: string;
  user_id: string;
  type: "connection" | "submission";
  revision: string;
  occurred_at: string;
  payload: Record<string, unknown>;
};
export type EventPage = {
  success: true;
  events: StatusEvent[];
  next_cursor: string;
  has_more: boolean;
};
export type ConnectionSnapshot = {
  user_id: string;
  status: string;
  phone: string | null;
  revision: string;
};
export type SnapshotPage = {
  success: true;
  sessions: ConnectionSnapshot[];
  cursor: string;
  next_after: string | null;
};
export type SigningKeys = Record<
  string,
  { current: string; keys: Record<string, Buffer> }
>;
export function signingKeysFromEnvironment(): SigningKeys {
  try {
    const source = JSON.parse(process.env.EVENT_SIGNING_KEYS ?? "{}");
    if (!source || typeof source !== "object" || Array.isArray(source))
      throw new Error();
    const result: SigningKeys = {};
    for (const [app, config] of Object.entries(source) as [string, any][]) {
      if (
        !/^[A-Za-z0-9_-]{1,100}$/.test(app) ||
        !config ||
        !/^[A-Za-z0-9_-]{1,32}$/.test(config.current) ||
        !config.keys ||
        typeof config.keys !== "object"
      )
        throw new Error();
      const keys: Record<string, Buffer> = {};
      for (const [id, value] of Object.entries(config.keys)) {
        if (
          !/^[A-Za-z0-9_-]{1,32}$/.test(id) ||
          typeof value !== "string" ||
          !/^[A-Za-z0-9+/]{43}=$/.test(value)
        )
          throw new Error();
        keys[id] = Buffer.from(value, "base64");
      }
      if (
        !keys[config.current] ||
        Object.values(keys).some((key) => key.length !== 32)
      )
        throw new Error();
      result[app] = { current: config.current, keys };
    }
    return result;
  } catch {
    throw new Error("Invalid event signing configuration");
  }
}
export function signResponse(
  config: SigningKeys[string] | undefined,
  app: string,
  nonce: unknown,
  body: string,
  timestamp = String(Math.floor(Date.now() / 1000)),
) {
  if (!config)
    throw new ApiError(
      503,
      "SIGNING_UNAVAILABLE",
      "Status signing unavailable.",
    );
  if (typeof nonce !== "string" || !/^[a-f0-9]{32,64}$/.test(nonce))
    throw new ApiError(
      422,
      "INVALID_INPUT",
      "A fresh X-WhatsApp-Nonce is required.",
    );
  const signature = createHmac("sha256", config.keys[config.current])
    .update([app, nonce, timestamp, body].join("\n"))
    .digest("hex");
  return {
    "x-whatsapp-key-id": config.current,
    "x-whatsapp-nonce": nonce,
    "x-whatsapp-timestamp": timestamp,
    "x-whatsapp-signature": signature,
  };
}
export function decimal(
  value: unknown,
  name: string,
  defaultValue = "0",
): string {
  if (value === undefined) return defaultValue;
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,18})$/.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    throw new ApiError(422, "INVALID_INPUT", `Invalid ${name}.`);
  return value;
}
