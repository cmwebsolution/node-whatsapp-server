import { rmSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
rmSync("dist", { recursive: true, force: true });
const result = spawnSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc"],
  { stdio: "inherit" },
);
if (result.status === 0)
  copyFileSync("scripts/host-entry.cjs", "dist/host-entry.cjs");
process.exit(result.status ?? 1);
