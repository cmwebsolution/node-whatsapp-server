# Shared WhatsApp server

A standalone Node.js service that lets independent Laravel applications link each authenticated user's WhatsApp account and submit text, PDF, or PNG messages. Sessions are isolated by application ID and user ID. The Laravel package used by HisabWala currently integrates text sending only.

**Production deployment:** [follow the live-server guide](docs/production.md).

## Does a build give me a URL?

No. `npm run build` compiles TypeScript into `dist/`. `npm start` runs the HTTP process. Hosting, DNS, and an HTTPS reverse proxy provide the public URL.

| Location | Example URL | Port |
| --- | --- | --- |
| Development, same machine | `http://127.0.0.1:3001` | Node: 3001 |
| Production, separate Laravel server | `https://whatsapp.yourdomain.com` | Public HTTPS: 443; internal Node: 3001 |
| Containers on the same private network | `http://whatsapp:3001` | Container: 3001 |

`whatsapp.yourdomain.com` is an example; choose a domain you own. The GitHub repository URL is source code, not the running API URL. You do not add `/api/whatsapp` to Laravel's `WHATSAPP_NODE_URL`.

## Local development

Use Node 22.12+ (the supplied `.nvmrc` selects Node 22).

```sh
nvm use
npm ci
cp .env.example .env
npm run provision -- billingapp
npm run build
npm test
npm run dev
```

If you do not use nvm, install a supported Node version and check `node --version`. `npm ci` downloads a compatible Puppeteer browser unless you deliberately set `PUPPETEER_SKIP_DOWNLOAD=true`. On Apple Silicon, install dependencies and run the service with the same CPU architecture. Set `CHROME_PATH` if using an existing Chromium executable. Keep Chromium's sandbox enabled for normal host development.

Provisioning creates `data/credentials/billingapp.token` with mode 600 and stores only its SHA-256 digest in `data/applications.json`. Install the token privately in Laravel's server environment; the provision command never prints it. Keep the app ID stable. Provision a different ID/token for each independent Laravel application.

**Restart Node after provisioning another application.** The credential registry is loaded at startup. A running service does not automatically see newly provisioned credentials. The UI never receives application tokens.

Production environments may inject variables without a physical `.env` file: `npm start` and `npm run provision:production` support that too. The latter uses compiled JavaScript and works after dev dependencies are removed.

## HisabWala / Laravel package settings

For local development on the same machine:

```dotenv
WHATSAPP_NODE_URL=http://127.0.0.1:3001
WHATSAPP_APP_ID=billingapp
WHATSAPP_NODE_TOKEN=<private-token-from-provisioning>
WHATSAPP_NODE_TIMEOUT=40
WHATSAPP_REQUIRE_HTTPS=false
```

For public production access:

```dotenv
WHATSAPP_NODE_URL=https://whatsapp.yourdomain.com
WHATSAPP_APP_ID=billingapp
WHATSAPP_NODE_TOKEN=<production-token>
WHATSAPP_NODE_TIMEOUT=40
WHATSAPP_REQUIRE_HTTPS=true
```

Use the [devclick Laravel package](https://github.com/devclick-technology/whatsapp-laravel) from authenticated controllers. Laravel owns business authorization, tenant/branch isolation, customer phone lookup, and bill formatting. Never accept a browser-supplied sender ID. After changing Laravel environment settings, refresh its config cache and reload persistent workers using your application's normal deployment procedure.

## API

All `/api/*` requests require both headers:

```http
Authorization: Bearer <application-token>
X-WhatsApp-App-Id: billingapp
```

| Method | Path | Body |
| --- | --- | --- |
| GET | `/health` | None; unauthenticated process probe |
| GET | `/ready` | None; unauthenticated service-readiness probe |
| POST | `/api/whatsapp/connect` | `{"user_id":"123"}` |
| GET | `/api/whatsapp/{user_id}/status` | None |
| GET | `/api/whatsapp/{user_id}/qr` | None |
| POST | `/api/whatsapp/{user_id}/disconnect` | None |
| POST | `/api/whatsapp/{user_id}/send-message` | `{"phone":"919876543210","message":"Hello"}` |
| POST | `/api/whatsapp/{user_id}/send-media` | `{"phone":"919876543210","media":{"mimetype":"application/pdf","data":"<base64>","filename":"bill.pdf","caption":"Bill"}}` |

User IDs are opaque UTF-8 strings, at most 256 bytes. URL-encode them as individual path segments. Matching user IDs in different apps remain isolated. Response fields are `success`, `status`, and `phone`; supported connection statuses are `disconnected`, `connecting`, `qr_required`, and `connected`. Only `connected` reports a linked phone. A missing session returns `disconnected`. Starting a connection does not mean a QR is available yet.

Poll status quietly every 5 seconds while linking. Fetch QR only on an explicit user action. QR responses contain a PNG data URI plus UTC `expires_at`; discard it on expiry, errors, connection, or leaving the page. QR refresh can require another status check while the transient client restarts. Authenticate and authorize the owning user's QR page; do not build a public QR endpoint.

Text uses 7–15 international digits starting with 1–9, without `+` or spaces, and nonblank text up to 4,096 Unicode code points. Media supports canonical base64 PDF/PNG only, at most 8 MiB decoded, with a safe filename and a caption up to 1,024 characters. PNGs are limited to 16 million pixels.

Successful submission returns `message_id`. If the maintained WhatsApp client completes without an ID, the service returns `message_id: null` and `confirmation: "client_completed"`. Neither result proves recipient delivery or reading. A failed/timed-out submission has an uncertain outcome: **check WhatsApp and never automatically retry a send** in Laravel, a job, a reverse proxy, or this service.

| HTTP | Error code | Next step |
| --- | --- | --- |
| 401 | UNAUTHENTICATED | Verify token and restart Node after provisioning |
| 403 | FORBIDDEN | Ensure app ID matches that token |
| 409 | SESSION_DISCONNECTED / NOT_CONNECTED | Link account or wait for readiness |
| 409 | QR_EXPIRED | Explicitly refresh QR |
| 409 | SEND_IN_PROGRESS | Check the previous submission; do not resubmit |
| 422 | INVALID_INPUT | Correct recipient/text/media |
| 429 | RATE_LIMITED | Wait |
| 502 | SEND_FAILED | Outcome uncertain; check WhatsApp before resubmitting |
| 503 | SERVICE_UNAVAILABLE | Check capacity, readiness, and service availability |

Requests are limited to 120/minute/application and 30/minute/session. Regular JSON bodies are limited to 24 KiB; authenticated media bodies to 12 MiB. Responses use `Cache-Control: no-store`. Secrets, QR payloads, recipients, and message bodies are not logged.

## Runtime and storage

Exactly one process owns each persistent session directory. Do not run a dev process and a production container against the same data. `data/` contains credentials and full Chromium authentication profiles: never commit, serve publicly, or discard it during updates. Protect encrypted backups. Do not scale to multiple replicas without implementing session ownership coordination.

SIGTERM/SIGINT closes clients without logout, preserving linked sessions. Explicit disconnect logs out and removes that user's local profile. A storage lock blocks duplicate owners. After an unclean shutdown, verify that neither Node nor its Chromium children owns the storage before removing only an empty stale `.owner-lock`. See [recovery steps](docs/production.md#storage-lock-recovery).

This uses [whatsapp-web.js](https://docs.wwebjs.dev/Client.html) and [LocalAuth](https://wwebjs.dev/guide/creating-your-bot/authentication.html), an unofficial WhatsApp Web integration. Browser/client changes can interrupt operation. Tests fake WhatsApp clients and do not send real messages; production pairing and delivery still require a consenting test recipient.

## Dependency advisory

The locked dependency tree currently reports five high-severity npm audit entries through `extract-zip`, Puppeteer, and whatsapp-web.js. The underlying advisory concerns browser-download archive extraction. The production image and CI skip Puppeteer's download and use distro Chromium for runtime, reducing exposure to that installation path; this does not remove the audit findings. Do not run `npm audit fix --force`: its suggested change downgrades the WhatsApp client. Review upstream fixes and your deployment requirements before public production use.

## Checks

```sh
npm run build
npm test
```

GitHub Actions checks the build, automated tests, and production Docker image on pushes and pull requests. That workflow does not deploy the service or create a public URL.
