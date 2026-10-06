> Historical Business-plan investigation. Deployment target was subsequently changed to an independent Linux container host; use [current deployment instructions](deployment.md). No Business account testing or live capacity approval has occurred.

# Hostinger Business deployment and feasibility gate

## Prepare the managed app

Use Hostinger Business Node hosting, one app process, Node 24.x (locally verified at 24.21.0), build command `npm run build`, output directory `dist`, and entry file `dist/server.js`. Select the backend/framework option accepted by hPanel; Fastify deployment detection itself must be verified on the account. Configure `HOST=0.0.0.0` and use the port supplied by the hosting environment, default 3001.

Use a dedicated MySQL 8.4 LTS database/user reachable from the Business Node app. Verify `SELECT VERSION()` on the actual endpoint before migration. Hostinger currently documents MariaDB for Web/Cloud databases; an hPanel “MySQL” label does not satisfy the MySQL-only requirement. Confirm an actual supported MySQL endpoint and connectivity with the provider. If unavailable, Business is infeasible under the current database constraint; keep the gate open. Configure `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_POOL_SIZE=10`, `AUTH_ENCRYPTION_KEYS`, and `AUTH_ENCRYPTION_KEY_VERSION` and `EVENT_SIGNING_KEYS` through environment secrets. Use certificate-verified `DB_TLS=true` for database connections requiring TLS; verify the provider's endpoint/network and certificate support rather than assuming it. Do not write authentication into `public_html` or `hbuilds`.

Run `npm ci`, build, then `npm run migrate:production` before starting. Provision each application using a privately generated `PROVISION_TOKEN` and `npm run provision:production -- app-id`. Provisioning rejects duplicate app IDs/token digests. Remove `PROVISION_TOKEN` from hosting configuration afterwards. Put the token into Laravel server secrets; restart Node to load registry changes. Ensure administrative migration/provision commands can run in the managed environment; inability to run them is a deployment constraint to resolve.

On managed deployment use hosting's supervisor. Do not use PM2 cluster mode, a second manually started process, or filesystem session directories. Confirm automatic restart after a crash and how deployments terminate/overlap processes. Outbound Baileys WSS is distinct from inbound browser WebSocket support; Laravel communicates with this service over ordinary HTTPS.

Configure the custom domain/HTTPS URL and Laravel settings, deploy the updated Laravel package, refresh config and reload persistent workers. Retain old Chromium storage securely for rollback; all accounts pair again on the new stack. Roll back the service and Laravel package together. Stop the new owner before restoring the previous stack. Never delete application credentials/authentication during a code-only deployment.

## Provider evidence required

Record account-specific answers/evidence in the feasibility report:

1. Long-lived **outbound** WSS to WhatsApp, allowed duration, idle timeout and connection limits.
2. Idle sleep, periodic recycling, restart-on-crash policy and response to abnormal termination.
3. SIGTERM delivery, shutdown grace and whether old/new instances overlap during deployments.
4. Actual CPU/RAM/process/file-descriptor/network limits and Node version selected at runtime.
5. Node-to-MySQL connectivity, InnoDB support, database/pool connection limits, TLS and backups.
6. Maximum authenticated JSON body, upstream HTTP timeout, and managed framework/startup behavior.
7. Whether persistent unofficial WhatsApp sessions are supported under the plan's usage policies.

Public documentation confirms Node/SQL availability, not 500-account capacity. If persistent WSS or SQL storage does not work, mark Business infeasible and keep the gate open; do not silently substitute a VPS.

## Real-account prototype procedure

Use a dedicated consenting test account and recipient. Store probe configuration privately: `WHATSAPP_NODE_URL`, `WHATSAPP_APP_ID`, `WHATSAPP_NODE_TOKEN`, `PROBE_USER_ID`. Run probes with `node --env-file=/private/path/probe.env scripts/probe.mjs <action>`. Probe output excludes secrets, phone and message contents. Do not expose this file or logs publicly.

1. Run `health`, `ready`, `connect`, and `status`. Request `qr` with `PROBE_QR_FILE` pointing to a new private local PNG. Scan using Linked Devices and delete the QR file. Confirm `connected`.
2. Set `PROBE_ALLOW_SEND=true`, `PROBE_RECIPIENT`, and a persisted UUID `PROBE_KEY`. Send `text` once. For each PDF/PNG, set `PROBE_ATTACHMENT`, select a fresh key and run `pdf` or `png`. Verify receipt and correct attachment content on the recipient device.
3. Repeat the identical request/key and verify one recipient message. Change payload under the same key and expect 409. Use `lookup` for pending/unknown outcomes; never resend them automatically.
4. Restart through hPanel. Confirm restoration without scanning, then send each supported type under fresh intent keys. Repeat after redeployment and provider-supported abrupt termination. Capture sanitized UTC timestamps, elapsed times, exact Node/npm/library versions, response state and recipient verification.
5. Test overlapping deployment: old owner closes or expires, new owner restores, stale generation cannot write, and no account has two dispatching owners. If hPanel cannot provide required lifecycle controls/evidence, record the limitation.
6. Exercise temporary database failure in staging and verify no pre-dispatch send, closed sockets on lease failure, readiness failure and restoration after recovery.

The scripts implement probes but no hosting account or real WhatsApp account has been exercised by the implementation session.

## Capacity and monitoring

Run synthetic benchmarks on a disposable database first. Then stage real connections at 1, 10, 50, 100, 250 and 500 only with account owners' authorization and within provider constraints. Measure steady-state and reconnect memory/CPU, event-loop p99, database pending/active counts, send latency, success/unknown rates, reconnect time and upstream throttling. Separately run small, typical and 8 MiB PDF/PNG workloads. Fifty near-limit base64 requests can retain hundreds of MiB; the attachment-heavy target must pass the actual Business memory limit.

For production approval require a 24-hour representative soak, successful restart/redeploy recovery, no duplicate submission, no provider resource kills, and zero unexplained ownership failures. Capacity approval additionally requires the actual 500-account target and 500 sends/minute with 50-request bursts to pass, p95 execution under 30 seconds, and peak memory/CPU below 80% of the confirmed allocation. Do not declare capacity from HTTP or fake socket benchmarks.

## Backup, key recovery and rotation

Back up all `wa_*` tables consistently using the provider's database backup or a transactional database dump. Protect backups: credentials/Signal keys are encrypted, but metadata, token digests and recipient-linked phones remain sensitive. Keep a separately protected, versioned backup of every master key required by retained backups.

In a private staging database, restore a backup and the corresponding key versions, provision access privately if necessary, then start only one owner. Confirm authentication decrypts and a test account reconnects without scanning. Validate submission replay/unknown behavior from the restored snapshot; a backup taken before a send can omit its idempotency record, so Laravel's business intent ledger must prevent replaying those sends. Never run the restored account concurrently with production.

For rotation add the new key version while preserving old keys, select it for new writes, and rewrite remaining authentication records through the vault in a controlled maintenance operation. No bulk rotation command is shipped in this prototype. Keep old keys for retained backups; loss of a required key forces accounts to pair again. Backup-and-reconnect verification remains part of the hosted gate.

## Polling setup and signing rotation

Configure Node `EVENT_SIGNING_KEYS` as `{ "app-id": { "current": "v1", "keys": { "v1": "<base64 32-byte secret>" } } }`. Configure Laravel `WHATSAPP_EVENT_KEYS` as `{ "v1": "<same signing secret>" }`. Generate independent random signing, authentication-encryption and bearer secrets; never commit live values. Deploy the package migrations, then schedule `whatsapp:reconcile` every minute and enable the consuming application's scheduler cron. During pairing continue the explicit five-second QR/status polling.

For rotation install v2 in Laravel's verification keys first, retain v1, configure both keys in Node and select v2 as current, refresh configuration/reload workers and restart Node. Verify successful polling before removing v1 after deployment overlap and the five-minute response window. Signed polling has no webhook URL and no Redis requirement. Reconciliation sends only GETs and never dispatches WhatsApp messages. Alert on persistent command failure or lag rather than adding automatic send retries.

At 500 sends/minute, seven days can contain approximately 5.04 million submissions and 10.08 million submission transition events, before connection events and indexes. Measure database storage/IO and lock pressure against the actual provider allocation. Laravel intent retention adds long-lived metadata storage; archive safely without permitting old intent replay. A 20-page event budget processes at most 2,000 events/minute, so the nominal workload leaves limited room for reconnect storms or slow lookups; monitor cursor lag and recovery time.
