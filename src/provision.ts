import { loadSecretFiles } from "./secrets.js";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FileStore } from "./file-store.js";

await loadSecretFiles();
const id = process.argv[2],
  token = process.env.PROVISION_TOKEN || randomBytes(32).toString("base64url");
if (
  !id ||
  !/^[A-Za-z0-9_-]{1,100}$/.test(id) ||
  !token ||
  !/^[A-Za-z0-9_-]{43,128}$/.test(token)
)
  throw new Error(
    "Provide application ID and PROVISION_TOKEN secret (at least 32 random bytes, base64url).",
  );
const store = new FileStore();
try {
  await store.ready();
  await mkdir(join(store.root, "credentials"), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(join(store.root, "credentials", `${id}.token`), token, {
    mode: 0o600,
    flag: "wx",
  });
  await store.provision(id, token);
  console.log(
    "Application provisioned. Read its private token from data/credentials/<app-id>.token; restart the service.",
  );
} catch {
  console.error(
    "Provisioning failed: verify storage permissions, ownership and unique application/token.",
  );
  process.exitCode = 1;
} finally {
  await store.close();
}
