import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
rmSync("dist", { recursive: true, force: true });
const result = spawnSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc"],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
