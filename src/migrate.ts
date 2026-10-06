import { loadSecretFiles } from "./secrets.js";
import { poolFromEnvironment } from "./store.js";
import { migrate } from "./schema.js";
await loadSecretFiles();
const pool = poolFromEnvironment();
try {
  await migrate(pool);
  console.log("Database schema ready.");
} catch {
  console.error("Database migration failed.");
  process.exitCode = 1;
} finally {
  await pool.end();
}
