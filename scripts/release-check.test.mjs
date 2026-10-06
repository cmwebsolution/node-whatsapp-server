import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { missingGates } from "./release-check.mjs";
test("unfinished release evidence cannot approve production", async () => {
  const report = JSON.parse(
    await readFile(
      new URL("../deploy/release-gate.example.json", import.meta.url),
    ),
  );
  assert.ok(missingGates(report).includes("representative_capacity"));
  assert.ok(missingGates(report).includes("supported_real_sessions"));
});
test("every hosted gate remains mandatory even when other attestations are complete", () => {
  const gates = [
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
  ];
  const complete = {
    ...Object.fromEntries(gates.map((g) => [g, true])),
    supported_real_sessions: 1,
    sustained_hours: 24,
    image_digest: "registry/image@sha256:" + "a".repeat(64),
    host: "test host",
    operator: "test operator",
    verified_at: new Date().toISOString(),
    evidence: ["hosted attestation"],
  };
  assert.deepEqual(missingGates(complete), []);
  for (const gate of gates)
    assert.ok(missingGates({ ...complete, [gate]: false }).includes(gate));
  assert.ok(missingGates({ ...complete, supported_real_sessions: 501 }).length);
  assert.ok(missingGates({ ...complete, sustained_hours: 5 }).length);
  assert.ok(missingGates({ ...complete, image_digest: "latest" }).length);
});
