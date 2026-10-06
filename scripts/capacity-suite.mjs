// Synthetic HTTP/MySQL characterization only. Run on an explicitly disposable database.
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
if (process.env.CAPACITY_DISPOSABLE_DATABASE !== "true")
  throw new Error("A disposable database must be explicitly selected.");
const seconds = Number(process.env.CAPACITY_STAGE_SECONDS ?? 60);
const soak = Number(process.env.CAPACITY_SOAK_SECONDS ?? 300);
for (const n of [seconds, soak])
  if (!Number.isInteger(n) || n < 1 || n > 86400)
    throw new Error("Invalid duration.");
const scenarios = [1, 10, 50, 100, 250, 500].map((accounts) => ({
  accounts,
  seconds,
  media: 0,
}));
scenarios.push(
  { accounts: 500, seconds: soak, media: 0 },
  { accounts: 10, seconds, media: 8 * 1024 * 1024 },
);
const results = [];
for (const scenario of scenarios) {
  console.error(
    `Synthetic stage: ${scenario.accounts} sessions, ${scenario.seconds}s, ${scenario.media} media bytes`,
  );
  const child = spawn(process.execPath, ["scripts/benchmark.mjs"], {
    env: {
      ...process.env,
      BENCHMARK_DATABASE: "true",
      BENCHMARK_ACCOUNTS: String(scenario.accounts),
      BENCHMARK_SECONDS: String(scenario.seconds),
      BENCHMARK_MEDIA_BYTES: String(scenario.media),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (b) => {
    output += b;
    if (output.length > 1048576) child.kill("SIGTERM");
  });
  // Generic error only: never echo SQL/environment diagnostics into shared reports.
  child.stderr.resume();
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (status !== 0)
    throw new Error("Synthetic stage failed; inspect private diagnostics.");
  results.push(JSON.parse(output));
}
const report = {
  scope: "synthetic_http_mysql",
  proves_real_account_capacity: false,
  lock_sha256: createHash("sha256")
    .update(await readFile("package-lock.json"))
    .digest("hex"),
  results,
};
if (process.argv[2])
  await writeFile(process.argv[2], JSON.stringify(report, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
else console.log(JSON.stringify(report, null, 2));
