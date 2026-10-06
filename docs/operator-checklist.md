# Operator checklist

Before enabling business sends:

- Record host, region, exact image/database versions, CPU/RAM allocations, file descriptor limits, outbound WSS policy and network/body/time limits.
- Confirm secrets are private, Node cannot access Laravel business storage, MySQL is unexposed, TLS is valid, and diagnostics contain only numeric metrics and generic errors.
- Verify provisioned application isolation, signing-key rotation, seven-day event retention, Laravel reconciliation scheduling, and retained intent lookup after Node retention expires.
- Pair a consenting account; verify text, PDF and PNG receipt using distinct persisted intent UUIDs. Restart and redeploy without rescanning, repeat sends with new intents, and confirm identical repeats do not dispatch.
- Run crash, network, database outage, interrupted-send and overlapping-owner drills. Record reconnect time and confirm unknown outcomes are never automatically replayed.
- Run staged session/media loads and 24-hour representative hosted operation at the proposed supported limit. Measure RSS, CPU, API/send latency, event-loop delay, DB acquisition/query pressure, reconnect storms and Laravel queue backlog.
- Restore an encrypted backup with separately recovered master keys into an isolated database. Measure recovery time and validate uncertain intent reconciliation.
- Perform actual rollout and rollback using recorded immutable digests. Verify health checks, alerts, restart behavior and graceful termination.
- Sign the release evidence; leave supported production sessions at zero until gates pass. Pilot configuration of one session is not capacity approval.

During an incident, pause Laravel dispatch first. Capacity rejection with `retry_safe=true` applies only to that attempt. Timeout, crash, lost response or missing ledger record requires lookup/reconciliation; none authorizes blind resend. Database failure should make readiness fail and stop socket activity after ownership renewal is lost. Preserve encrypted data and key versions while investigating.
