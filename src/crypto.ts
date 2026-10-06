import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { BufferJSON } from "@whiskeysockets/baileys";
export class Vault {
  constructor(
    private keys: Record<string, Buffer>,
    private current: string,
  ) {
    if (!keys[current] || Object.values(keys).some((k) => k.length !== 32))
      throw new Error("Invalid encryption key configuration");
  }
  seal(value: unknown, context: string): string {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.keys[this.current], iv);
    cipher.setAAD(Buffer.from(context));
    const data = Buffer.concat([
      cipher.update(JSON.stringify(value, BufferJSON.replacer)),
      cipher.final(),
    ]);
    return JSON.stringify({
      v: this.current,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    });
  }
  open(value: string, context: string): any {
    const e = JSON.parse(value),
      key = this.keys[e.v];
    if (!key) throw new Error("Encryption key unavailable");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(e.iv, "base64"),
    );
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(e.tag, "base64"));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(e.data, "base64")),
        decipher.final(),
      ]).toString(),
      BufferJSON.reviver,
    );
  }
  static environment() {
    let values: unknown;
    try {
      values = JSON.parse(process.env.AUTH_ENCRYPTION_KEYS ?? "{}");
    } catch {
      throw new Error("Invalid encryption configuration");
    }
    if (!values || typeof values !== "object" || Array.isArray(values))
      throw new Error("Invalid encryption configuration");
    const keys: Record<string, Buffer> = {};
    for (const [id, value] of Object.entries(values)) {
      if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value))
        throw new Error("Invalid encryption key");
      keys[id] = Buffer.from(value, "base64");
    }
    return new Vault(keys, process.env.AUTH_ENCRYPTION_KEY_VERSION ?? "v1");
  }
}
