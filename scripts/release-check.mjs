import { readFile } from "node:fs/promises";
export function missingGates(report) {
  const missing = [];
  for (const gate of [
    "hosted_stack",
    "pairing",
    "restart_restoration",
    "redeployment_restoration",
    "text_received",
    "pdf_received",
    "png_received",
    "reliability_faults",
    "encrypted_restore",
    "rollback_drill",
    "representative_capacity",
  ]) {
    if (report[gate] !== true) missing.push(gate);
  }
  if (
    !Number.isInteger(report.supported_real_sessions) ||
    report.supported_real_sessions < 1 ||
    report.supported_real_sessions > 500
  )
    missing.push("supported_real_sessions");
  if (!(report.sustained_hours >= 24))
    missing.push("24_hour_sustained_operation");
  if (!/^.+@sha256:[a-f0-9]{64}$/.test(report.image_digest ?? ""))
    missing.push("immutable_image");
  for (const field of ["host", "operator"])
    if (typeof report[field] !== "string" || !report[field].trim())
      missing.push(field);
  const date = Date.parse(report.verified_at);
  if (!Number.isFinite(date) || date > Date.now()) missing.push("verified_at");
  if (
    !Array.isArray(report.evidence) ||
    !report.evidence.length ||
    report.evidence.some((x) => typeof x !== "string" || !x.trim())
  )
    missing.push("evidence");
  return missing;
}
if (process.argv[1]?.endsWith("/release-check.mjs")) {
  try {
    const report = JSON.parse(await readFile(process.argv[2], "utf8"));
    const missing = missingGates(report);
    console.log(
      JSON.stringify({
        release_ready: missing.length === 0,
        missing_gates: missing,
      }),
    );
    process.exitCode = missing.length ? 1 : 0;
  } catch {
    console.error("RELEASE_EVIDENCE_UNAVAILABLE");
    process.exitCode = 1;
  }
}
