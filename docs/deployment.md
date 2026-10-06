# Shared WhatsApp service

Lightweight Fastify + Baileys service for Laravel. No Chromium, Docker, MySQL or migrations are required for normal operation. Authentication and submission records live in private files under `DATA_DIR`. One running process owns that directory.

## Local setup

Use Node 24.x (the version pinned in `.nvmrc` is recommended):

```sh
nvm install
nvm use
npm ci
cp -n .env.example .env
npm run provision -- billingapp
npm run dev
```

Provision once per application, with the server stopped. The command generates a private application token in `data/credentials/billingapp.token`; install that token in Laravel. It saves only the token digest in the application registry. You may supply `PROVISION_TOKEN` privately to retain an existing Laravel token. Restart after provisioning. Provisioning never prints secrets.

Minimal Node environment:

```dotenv
HOST=127.0.0.1
PORT=3001
DATA_DIR=./data
MAX_SESSIONS=20
```

The service generates its storage encryption key automatically. Keep the complete `data` directory, including `encryption-key.json`, across restarts/deployments. Authentication records are encrypted; the local master key must remain private with restricted filesystem access. Back up the stopped service's entire directory to protected storage. Losing the key requires pairing again; the service refuses to generate a replacement key over existing sessions.

Laravel environment:

```dotenv
WHATSAPP_NODE_URL=http://127.0.0.1:3001
WHATSAPP_APP_ID=billingapp
WHATSAPP_NODE_TOKEN=<private token from provisioning>
WHATSAPP_REQUIRE_HTTPS=false
```

The Laravel package uses direct HTTP by default. No package migrations or event-signing keys are required. Obtain `newIntent()` once and save its ID in your business record before sending. Pass it to `sendText` / `sendMedia`; use `submission(id)` after an uncertain result. Never create a fresh ID to retry an uncertain send. Node retains submission records for seven days; missing records do not authorize a resend.

## Running on a server

```sh
npm ci
npm run build
npm run provision:production -- billingapp
npm start
```

Use your hosting process supervisor to run `npm start`, with one instance and at least 40 seconds termination grace. Use a persistent private absolute `DATA_DIR` outside the public web directory. Configure the hosting-supplied port and `HOST=0.0.0.0` when needed; otherwise keep loopback behind an HTTPS reverse proxy. Laravel must use HTTPS for public connections. Do not enable process cluster mode or overlapping deployments against the same storage.

After an unclean crash, the service automatically recovers an owner lock when its recorded local PID is confirmed dead. Incomplete startup locks or reused PIDs need manual recovery. Stop the supervisor and verify the PID in `DATA_DIR/.owner-lock/owner.json` is no longer running. Only then remove that lock directory (and any stale `.recovery-lock`) and restart; preserve all other data.

## API and checks

Existing authenticated endpoints remain compatible: connect, status, QR, disconnect, send-message, send-media, and submission lookup. Send requests require a stable `Idempotency-Key`. Application tokens stay in Laravel server configuration, never browser code. Each app/user pair is isolated.

```sh
npm run build
npm test
curl --fail http://127.0.0.1:3001/health
curl --fail http://127.0.0.1:3001/ready
```

Readiness verifies storage availability, not every account's WhatsApp connection. Pair one real account, submit a consenting recipient's test message, and verify restoration after restart. Automated tests use fake WhatsApp transports. This storage implementation has not established 500-session production capacity.

Advanced signed event reconciliation remains optional (`EVENT_SIGNING_KEYS` on Node and corresponding keys on Laravel). The historical SQL adapter and its gated tests/tools remain for compatibility, but are not used by the server or normal provisioning. Earlier SQL capacity evidence does not validate the new file backend.

Managed hosts that load entries with `require()` (including LiteSpeed/Hostinger): set entry file to `dist/host-entry.cjs`. The build emits this CommonJS wrapper, which dynamically imports the ESM server. Direct `npm start` remains supported.
