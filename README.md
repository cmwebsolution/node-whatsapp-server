# Shared WhatsApp service

Fastify + Baileys service for authenticated Laravel applications. WhatsApp credentials and Signal keys are stored by Node in encrypted MySQL records. Chromium and filesystem authentication are no longer used.

**Production candidate:** independent Linux VPS/container hosting with dedicated MySQL. **Production approval remains open** until the hosted real-account gate passes. Start with [deployment instructions](docs/deployment.md), [API contract](docs/contract.md), and [readiness evidence](docs/readiness.md).

## Stack and checks

Node 24.21.0, Fastify 5.12.5, Baileys 6.7.24, mysql2 3.24.5, pino 9.14.0 and qrcode 1.5.4. Dependency resolutions are locked in `package-lock.json`; Baileys' Git-based libsignal dependency is locked to a commit. No automatic switch to a prerelease is permitted.

```sh
nvm install
nvm use
npm ci
npm run build
npm test
```

Default tests use a synthetic WhatsApp transport. SQL/lifecycle tests require a **dedicated disposable test database**, then:

```sh
RUN_DATABASE_TESTS=1 npm test
```

Set `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD` privately. Compose supplies a local MySQL 8.4.11 LTS test database on loopback port 3307; it is not a production deployment recommendation. CI runs the SQL suite against MySQL 8.4.11 LTS. The build cleans old compiled browser modules.

## First deployment

Configure a dedicated MySQL 8.4 LTS endpoint reachable from the independent Node host. Confirm the actual engine first; the startup guard requires MySQL. Configure the variables in `.env.example` through hosting secrets, run `npm run migrate:production`, provision an application using `PROVISION_TOKEN` and `npm run provision:production -- application-id`, remove `PROVISION_TOKEN`, and start `dist/server.js`. `PROVISION_TOKEN` is the same private bearer token installed in Laravel; the database retains only its SHA-256 digest.

Generate a random 32-byte application token and a separate random 32-byte encryption master key using your private secret-management workflow. The token is base64url; the encryption key is standard base64. `AUTH_ENCRYPTION_KEYS` is a JSON map, such as `{"v1":"<private-base64-key>"}`. Never put actual keys in source code, chat, or logs. `AUTH_ENCRYPTION_KEY_VERSION=v1` selects new writes. Preserve old key versions until all records and retained backups have been re-encrypted or expired.

## Laravel changes

The sibling `whatsapp-laravel` source has been updated with these methods:

```php
$session = WhatsApp::forUser(auth()->user());
$result = $session->sendText($phone, $message, $intent->idempotency_key);
$result = $session->sendMedia($phone, $media, $mediaIntent->idempotency_key);
$result = $session->submission($intent->idempotency_key);
```

Persist one UUID per authorized business send intent **before** contacting Node. Reuse it for that intent. Store and display `pending`, `submitted`, `failed`, and `unknown` results. Look up uncertain submissions; never automatically resend them. Protect older intents in Laravel beyond Node's seven-day retention. Sending a new intent needs an explicit user action.

Install the updated package release in Laravel; editing package source does not update an application's installed vendor directory. Set `WHATSAPP_NODE_URL`, `WHATSAPP_APP_ID`, `WHATSAPP_NODE_TOKEN`, `WHATSAPP_NODE_TIMEOUT=40`, and `WHATSAPP_REQUIRE_HTTPS=true`; rebuild Laravel config and reload persistent workers. Existing send callers need the new required key argument. Existing Chromium-linked accounts must pair again.

## Synthetic workload tools

```sh
npm run benchmark
BENCHMARK_DATABASE=true npm run benchmark
BENCHMARK_SECONDS=60 BENCHMARK_MEDIA_BYTES=8388608 npm run benchmark
```

The defaults represent 500 synthetic sessions, 500 sends/minute and bursts of up to 50 requests. They never connect to WhatsApp. SQL benchmarks create and remove records under a random benchmark application ID and must use a disposable test database. Results are overhead measurements, not proof of 500 real connected accounts.

For the real Laravel HTTP wire test, first run `npm test`, then `node scripts/contract-server.mjs`; in the sibling package run `RUN_WIRE_CONTRACT=1 vendor/bin/phpunit`. Stop the loopback fixture afterward. It uses a synthetic transport and fixed test credentials, and must never be deployed.

Plan 2 adds immediate execution backpressure, a transactional append-only event journal, versioned HMAC signatures, and paginated reconciliation snapshots. Set `EVENT_SIGNING_KEYS` independently from authentication encryption keys. The reusable Laravel package supplies persistent intent/snapshot/dedup/cursor migrations and `whatsapp:reconcile`; the consuming app runs it every minute and owns its queues and business authorization. See [production setup](docs/production.md) and [API contract](docs/contract.md). HisabWala changes are outside this phase.

## Production readiness

See [deployment and rollback](docs/deployment.md) and the [operator checklist](docs/operator-checklist.md). Production defaults to one pilot session; no real-account capacity is approved. Encrypted backups use `node scripts/backup.mjs create|verify|restore PATH`. Run storage/crash drills only against a disposable database with `RUN_DATABASE_TESTS=1 RUN_BACKUP_TESTS=1 RUN_FAULT_TESTS=1 npm test`. Backup tests additionally need MySQL client binaries and isolated test administrative credentials.
