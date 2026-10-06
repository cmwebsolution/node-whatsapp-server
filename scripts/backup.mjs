// No plaintext SQL is written to disk or displayed. Client credentials use a private option file.
import { createBackup, verifyBackup, restoreBackup } from "./lib/backup.mjs";
try {
  const [action, path] = process.argv.slice(2);
  if (!path || !["create", "verify", "restore"].includes(action))
    throw new Error();
  const fn = {
    create: createBackup,
    verify: verifyBackup,
    restore: restoreBackup,
  }[action];
  console.log(JSON.stringify(await fn(path)));
} catch {
  console.error(
    "BACKUP_OPERATION_FAILED: verify private files, key recovery, MySQL tools and isolated restore target.",
  );
  process.exitCode = 1;
}
