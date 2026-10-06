# Independent Node deployment

The Node service and Laravel application deploy separately. Each uses its own MySQL database. The production candidate is a Linux VPS/container host with controllable outbound WSS, restart policy, resource allocations, and shutdown deadlines. Hostinger Business is no longer the required target following the user's deployment clarification. No host has been provisioned or verified.

## Prepare

1. Build `docker build -t YOUR_REGISTRY/whatsapp:RELEASE .`, scan it, push it, and record its immutable digest. The image runs Node 24.21.0 as UID/GID 1000 with no Chromium. Container build/runtime verification remains necessary on a Docker-capable host.
2. Install a private `/etc/whatsapp/secrets` directory, owned by root with mode 0700. Generate independent database/root passwords, auth encryption key map, and per-application signing key map. Mounted Node secret files must be readable by UID/GID 1000: root:1000 mode 0640 inside the private parent. Root database password is root:root mode 0600. File-backed Compose secret ownership may be inherited from the host; verify access before launch. Never put secrets in source control, image layers, URLs, chat, or logs.
3. Copy `deploy/runtime.env.example` to private `/etc/whatsapp/runtime.env`. Set image digest and CPU/memory allocations. Start with `SUPPORTED_SESSION_LIMIT=1`. Resources are deliberately unset: measurements on the actual host must determine them. Configure firewall ingress for HTTPS/admin access only; MySQL has no published port.
4. Run `docker compose --env-file /etc/whatsapp/runtime.env -f deploy/compose.production.yaml config --quiet`. Start the database. Run the service image as a one-off with `node dist/migrate.js`; run provisioning with an additional privately mounted `PROVISION_TOKEN_FILE` and `node dist/provision.js APPLICATION_ID`. Remove that provisioning secret afterward. Configure the application's separate signing key before starting the normal service.
5. Start the service with Compose. Install the adapted `deploy/nginx.conf.example` and valid certificate on the host; test Nginx before reloading. Verify `/health` and `/ready` over HTTPS. Health is process liveness; readiness requires database access. Docker health status alone does not restart an unhealthy running process; process crashes restart through `unless-stopped`. Monitor prolonged failed readiness and alert an operator.
6. Install/publish Laravel package migrations and signing configuration in the separate Laravel app. Set HTTPS Node URL, app ID, server-only bearer token, and timeout 40 seconds. Schedule `whatsapp:reconcile` every minute and keep pairing status polling at five seconds. Laravel owns durable business queues and retries only explicitly safe pre-dispatch deferrals with the original persisted intent key.

## Operating limits

Admission: 50 requests; execution: 10 global sends, one per account, two media sends. At most four media bodies are admitted before parsing. Connection attempts default to five; startup restoration staggers 100 ms. Configure media execution limit during migration so all processes observe the same database limit. Re-run migration when changing `MEDIA_SEND_CONCURRENCY`.

Node shutdown is bounded to 30 seconds; Compose grants 40 seconds. Shutdown closes sockets and flushes auth before releasing ownership. Crash takeover waits for the 30-second lease; renewal runs every 10 seconds, with a local 25-second watchdog. Maintenance restoration runs every 30 seconds. Do not lower shutdown grace without repeating interruption tests. Keep the single replica initially; overlap is guarded by database leases but still requires a hosted deployment drill.

## Backup and restoration

On a private operator host with Node 24 and matching MySQL client tools, create a mode-0600 MySQL option file (`[client]`, host, port, user, password; enable certificate verification for remote TLS). Set `MYSQL_CLIENT_CONFIG` to its path, `DB_NAME=whatsapp`, and `BACKUP_KEYS_FILE` to a separate mode-0600 JSON map of version to base64 32-byte backup keys. Set `BACKUP_KEY_VERSION=v1`.

Run `node scripts/backup.mjs create /private/backups/DATE.wa-backup`, then `verify` on that artifact. These commands stream a transactional dump through AES-256-GCM; no plaintext SQL is written to disk. Store encrypted artifacts off-host with restricted access and retention. Independently escrow auth master key versions and backup encryption key versions. Losing either prevents recovery; a database dump alone is insufficient.

Create an empty isolated restore database with an appropriately privileged restore account. Set `BACKUP_RESTORE_ALLOWED=true` and `BACKUP_RESTORE_DATABASE=whatsapp_restore`, then run `node scripts/backup.mjs restore ARTIFACT`. The target must differ from `DB_NAME`. Authentication of the complete backup occurs before any SQL import. Import failure may leave a partial isolated database; discard it and repeat. Validate keys, credentials, submission ledger, event cursors and application tokens before promotion.

Pause Laravel dispatch and stop all Node owners before promoting a restored database. A backup can omit later submissions. Reconcile Laravel's retained pending/uncertain intents; missing Node records never authorize replay. Preserve evidence and require an explicit new business intent for any new send. Record backup recovery time and recovery-point age during the hosted drill.

## Release and rollback

Keep the previous image digest, package artifact, runtime configuration and all retained encryption/signing key versions. Back up before migration. Current migrations are additive; code rollback must still be verified against the migrated schema. Do not downgrade MySQL or automatically rewind its volume.

For rollout: pause Laravel dispatch, verify no new sends, stop the old owner gracefully, migrate, start the chosen immutable image, verify readiness/restoration, reconcile intents, then resume dispatch. For rollback: pause dispatch, stop the new image, select the verified prior digest, start it against the compatible current database, check readiness and restore/reconcile sessions before resuming. Do not roll back to Chromium profiles as though Baileys auth were compatible.

Complete `deploy/release-gate.example.json` with hosted evidence and operator attestation. `node scripts/release-check.mjs PATH` fails closed while any gate is incomplete. This checks completeness of an attestation, not authenticity of evidence. Production approval requires representative hosted capacity and a 24-hour sustained run as well as one consenting live account receiving text/PDF/PNG after restart/redeployment. Synthetic measurements cannot satisfy those fields.

## Repeatable synthetic characterization

On a dedicated disposable database, set `CAPACITY_DISPOSABLE_DATABASE=true` and the private DB variables, then run `npm run capacity -- /private/reports/capacity.json`. The suite runs 1/10/50/100/250/500 synthetic sessions, a five-minute 500-session run, and a separate 8-MiB PDF run. `CAPACITY_STAGE_SECONDS` and `CAPACITY_SOAK_SECONDS` control duration up to 24 hours. Do not run concurrently with other database fixtures: limits and pressure are shared.

This harness calls real Fastify HTTP endpoints and MySQL but substitutes the WhatsApp transport. It does not model real socket memory, encryption/network costs, recipient delivery or a Laravel deferred-intent queue. Its process RSS/CPU includes the HTTP load client, so use separate load-generator and service hosts for capacity approval. Burst overloads are deliberately counted rather than automatically retried. A 500-per-minute offered load is not equivalent to 500 completed sends per minute. Record both and measure Laravel backlog during the hosted end-to-end test.

Initial administrative commands after the private runtime configuration is ready:

```sh
docker compose --env-file /etc/whatsapp/runtime.env -f deploy/compose.production.yaml up -d database
docker compose --env-file /etc/whatsapp/runtime.env -f deploy/compose.production.yaml run --rm service node dist/migrate.js
docker compose --env-file /etc/whatsapp/runtime.env -f deploy/compose.production.yaml run --rm \
  --volume /etc/whatsapp/secrets/provision-token:/run/secrets/provision_token:ro \
  --env PROVISION_TOKEN_FILE=/run/secrets/provision_token \
  service node dist/provision.js APPLICATION_ID
docker compose --env-file /etc/whatsapp/runtime.env -f deploy/compose.production.yaml up -d service
```

The provisioning file follows the same restricted directory/read permissions as other Node secrets. Delete it after provisioning. Migration and provisioning commands use the same release image and secret mounts as the service.
