import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
rmSync(".test-build", { recursive: true, force: true });
for (const args of [
  ["node_modules/typescript/bin/tsc", "-p", "tsconfig.test.json"],
  ["--test", "--test-concurrency=1", ".test-build/tests/*.test.js"],
  ["--test", "scripts/release-check.test.mjs"],
]) {
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
