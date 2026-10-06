import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open, unlink, mkdtemp, copyFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import { spawn } from "node:child_process";
const tables = [
  "wa_control",
  "wa_applications",
  "wa_sessions",
  "wa_auth",
  "wa_submissions",
  "wa_event_streams",
  "wa_events",
];
async function privateFile(path) {
  const f = await open(path, "r");
  try {
    const s = await f.stat();
    if (!s.isFile() || s.mode & 0o077 || s.size > 65536) throw new Error();
    return await f.readFile("utf8");
  } finally {
    await f.close();
  }
}
async function keys() {
  const raw = process.env.BACKUP_KEYS_FILE
    ? await privateFile(process.env.BACKUP_KEYS_FILE)
    : process.env.BACKUP_KEYS;
  if (process.env.BACKUP_KEYS_FILE && process.env.BACKUP_KEYS)
    throw new Error();
  const source = JSON.parse(raw ?? "{}"),
    result = {};
  for (const [id, value] of Object.entries(source)) {
    if (
      !/^[A-Za-z0-9_-]{1,32}$/.test(id) ||
      typeof value !== "string" ||
      !/^[A-Za-z0-9+/]{43}=$/.test(value)
    )
      throw new Error();
    result[id] = Buffer.from(value, "base64");
    if (result[id].length !== 32) throw new Error();
  }
  return result;
}
function identifier(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_]{1,64}$/.test(value))
    throw new Error();
  return value;
}
async function clientConfig() {
  if (!process.env.MYSQL_CLIENT_CONFIG) throw new Error();
  await privateFile(process.env.MYSQL_CLIENT_CONFIG);
  return "--defaults-extra-file=" + process.env.MYSQL_CLIENT_CONFIG;
}
async function write(stream, chunk) {
  if (stream.errored || stream.destroyed) throw new Error("Stream unavailable");
  if (!stream.write(chunk)) await once(stream, "drain");
}
function child(binary, args) {
  const p = spawn(binary, args, {
    stdio: ["pipe", "pipe", "ignore"],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C" },
  });
  p.stdin.on("error", () => {});
  const exit = new Promise((resolve, reject) => {
    p.once("error", reject);
    p.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error("Database client failed")),
    );
  });
  void exit.catch(() => {});
  return { p, exit };
}
export async function createBackup(path) {
  const all = await keys(),
    version = process.env.BACKUP_KEY_VERSION ?? "v1",
    key = all[version];
  if (!key) throw new Error();
  const config = await clientConfig(),
    database = identifier(process.env.DB_NAME);
  const header = Buffer.from(
    JSON.stringify({
      format: "wa-sql-v1",
      version,
      iv: randomBytes(12).toString("base64"),
      created_at: new Date().toISOString(),
    }) + "\n",
  );
  const info = JSON.parse(header.toString()),
    cipher = createCipheriv("aes-256-gcm", key, Buffer.from(info.iv, "base64"));
  cipher.setAAD(header);
  const output = createWriteStream(path, { flags: "wx", mode: 0o600 });
  output.on("error", () => {});
  await once(output, "open");
  const dump = child(process.env.MYSQL_DUMP_BINARY ?? "mysqldump", [
    config,
    "--single-transaction",
    "--quick",
    "--skip-lock-tables",
    "--skip-add-locks",
    "--no-tablespaces",
    "--set-gtid-purged=OFF",
    "--column-statistics=0",
    database,
    ...tables,
  ]);
  dump.p.stdin.end();
  try {
    await write(output, header);
    for await (const chunk of dump.p.stdout)
      await write(output, cipher.update(chunk));
    await dump.exit;
    await write(output, cipher.final());
    await write(output, cipher.getAuthTag());
    output.end();
    await finished(output);
    return {
      success: true,
      format: info.format,
      key_version: version,
      created_at: info.created_at,
    };
  } catch (e) {
    dump.p.kill("SIGKILL");
    output.destroy();
    await unlink(path).catch(() => {});
    throw e;
  }
}
async function envelope(path) {
  const f = await open(path, "r");
  try {
    const stat = await f.stat();
    if (!stat.isFile() || stat.mode & 0o077 || stat.size < 50)
      throw new Error();
    const buffer = Buffer.alloc(2048);
    const { bytesRead } = await f.read(buffer, 0, buffer.length, 0);
    const end = buffer.subarray(0, bytesRead).indexOf(10);
    if (end < 0) throw new Error();
    const header = buffer.subarray(0, end + 1),
      info = JSON.parse(header.toString());
    if (
      info.format !== "wa-sql-v1" ||
      typeof info.iv !== "string" ||
      !/^[A-Za-z0-9+/]{16}$/.test(info.iv) ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(info.created_at)
    )
      throw new Error();
    const all = await keys(),
      key = all[info.version];
    if (!key) throw new Error();
    const tag = Buffer.alloc(16);
    await f.read(tag, 0, 16, stat.size - 16);
    return { header, info, key, tag, start: end + 1, end: stat.size - 17 };
  } finally {
    await f.close();
  }
}
async function decrypt(path, envelope, consume) {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    envelope.key,
    Buffer.from(envelope.info.iv, "base64"),
  );
  decipher.setAAD(envelope.header);
  decipher.setAuthTag(envelope.tag);
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path, {
    start: envelope.start,
    end: envelope.end,
  })) {
    const plain = decipher.update(chunk);
    hash.update(plain);
    bytes += plain.length;
    await consume(plain);
  }
  const last = decipher.final();
  hash.update(last);
  bytes += last.length;
  await consume(last);
  return {
    success: true,
    format: envelope.info.format,
    key_version: envelope.info.version,
    created_at: envelope.info.created_at,
    plaintext_bytes: bytes,
    plaintext_sha256: hash.digest("hex"),
  };
}
export async function verifyBackup(path) {
  return decrypt(path, await envelope(path), async () => {});
}
export async function restoreBackup(path) {
  if (process.env.BACKUP_RESTORE_ALLOWED !== "true") throw new Error();
  const target = identifier(process.env.BACKUP_RESTORE_DATABASE);
  if (target === process.env.DB_NAME) throw new Error();
  // Freeze ciphertext privately, so replacement of an external artifact cannot change the verified SQL.
  const dir = await mkdtemp(join(tmpdir(), "wa-restore-")),
    snapshot = join(dir, "snapshot.waenc");
  let restore;
  try {
    await copyFile(path, snapshot);
    await chmod(snapshot, 0o600);
    const verified = await verifyBackup(snapshot),
      e = await envelope(snapshot),
      config = await clientConfig();
    restore = child(process.env.MYSQL_BINARY ?? "mysql", [
      config,
      "--database=" + target,
    ]);
    restore.p.stdout.resume();
    await decrypt(snapshot, e, (chunk) => write(restore.p.stdin, chunk));
    restore.p.stdin.end();
    await restore.exit;
    return { ...verified, restored: true };
  } catch (error) {
    restore?.p.kill("SIGKILL");
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
