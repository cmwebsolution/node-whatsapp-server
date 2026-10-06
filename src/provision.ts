import { loadSecretFiles } from "./secrets.js";
import { createHash } from "node:crypto";
import { poolFromEnvironment } from "./store.js";
await loadSecretFiles();
const id = process.argv[2],
  token = process.env.PROVISION_TOKEN;
if (
  !id ||
  !/^[A-Za-z0-9_-]{1,100}$/.test(id) ||
  !token ||
  !/^[A-Za-z0-9_-]{43,128}$/.test(token)
)
  throw new Error(
    "Provide application ID and PROVISION_TOKEN secret (at least 32 random bytes, base64url).",
  );
const pool = poolFromEnvironment();
try {
  await pool.execute(
    "INSERT INTO wa_applications (app_id,token_hash) VALUES (?,?)",
    [id, createHash("sha256").update(token).digest("hex")],
  );
  console.log(
    "Application provisioned; restart service to load its credential.",
  );
} catch {
  console.error(
    "Provisioning failed: verify database and unique application/token.",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
