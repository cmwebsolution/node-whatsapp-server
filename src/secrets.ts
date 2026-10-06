import { open } from "node:fs/promises";
const names = [
  "DB_PASSWORD",
  "AUTH_ENCRYPTION_KEYS",
  "EVENT_SIGNING_KEYS",
  "PROVISION_TOKEN",
];
/** Support secret mounts without putting their contents into command arguments or logs. */
export async function loadSecretFiles() {
  for (const name of names) {
    const path = process.env[name + "_FILE"];
    if (!path) continue;
    if (process.env[name])
      throw new Error("Configure one secret source per setting");
    let file;
    try {
      file = await open(path, "r");
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 65536 || stat.mode & 0o022)
        throw new Error();
      const value = (await file.readFile("utf8")).replace(/\r?\n$/, "");
      if (!value || value.includes("\0")) throw new Error();
      process.env[name] = value;
    } catch {
      throw new Error("Secret file unavailable or unsafe");
    } finally {
      await file?.close();
    }
  }
}
