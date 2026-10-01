# Live-server deployment

## What creates the URL?

The repository holds source code. `npm run build` produces compiled files; it does not upload them, start a process, assign an IP, or create a URL.

For the deployment below, your VPS supplies a public IP. You point an owned domain such as `whatsapp.yourdomain.com` to that IP. Caddy accepts HTTPS on port **443** and forwards to Node on loopback port **3001**. Laravel uses `https://whatsapp.yourdomain.com`, without `:3001` or an API path.

```text
Laravel server -> HTTPS :443 -> Caddy on VPS -> 127.0.0.1:3001 -> Node container :3001
```

If a container hosting provider gives you an HTTPS URL instead, use the URL shown in its dashboard. This service needs a persistent disk, Chromium support, and exactly one replica; it is not a static website, GitHub Pages project, or short-lived serverless function. This guide does not assume a provider or claim that anything has already been deployed.

## Recommended: Linux VPS with Docker Compose and Caddy

Prerequisites: a Linux server with persistent storage, Docker Engine and its Compose plugin, an owned domain, and SSH administration access. Use [Docker's official installation instructions](https://docs.docker.com/engine/install/) and [Caddy's installation instructions](https://caddyserver.com/docs/install). Choose capacity based on concurrently linked accounts; each active account uses a Chromium browser. Start with a small `MAX_SESSIONS`, monitor memory, and increase only after load testing.

### 1. Fetch the code

```sh
git clone https://github.com/devclick-technology/node-whatsapp-server.git
cd node-whatsapp-server
cp .env.example .env
```

For a private repository, use your normal authenticated Git credentials; never put a GitHub token into a clone URL or this project's `.env`.

Keep the checked-out directory outside the public web root. Compose uses `.env` for interpolation, not by automatically copying all its variables into the container. This project's Compose file explicitly configures the container.

### 2. Prepare storage and build

For a fresh installation only, create the bind-mounted directory for the image's non-root UID/GID 1000:

```sh
sudo install -d -o 1000 -g 1000 -m 0700 data
docker compose build
```

For existing storage, preserve its content and verify ownership rather than deleting/recreating it. Session directories must stay writable by UID 1000; the registry must be readable by that user. Never fix permissions with `chmod 777`.

The runtime image includes system Chromium and compiled JavaScript, with dev dependencies removed. Chromium's sandbox is disabled only in this container configuration; keep it isolated for this workload. `tini` forwards graceful termination signals. Compose persists `./data`, allows shared memory for Chromium, and gives shutdown 35 seconds.

### 3. Provision the Laravel application

On a fresh installation, before starting the service:

```sh
docker compose run --rm --no-deps whatsapp node dist/provision.js billingapp
```

The token is saved at `data/credentials/billingapp.token`, not printed. Use a privileged private editor or secret-management workflow to copy its value into Laravel's production secrets. The file is mode 600, and the credential directory is protected. Do not paste the token into chat, commit it, expose it through a download route, or save it in logs. Once installed, remove that temporary plaintext token file while retaining `data/applications.json` and the session directories. The digest in `applications.json` is what authenticates Laravel.

For another independent application, provision a different stable ID. Do not run provisioning concurrently. After changing the registry, restart Node: credentials are loaded at startup. To add an app later:

```sh
docker compose stop whatsapp
docker compose run --rm --no-deps whatsapp node dist/provision.js another-app
docker compose up -d whatsapp
```

Install that app's own token in its Laravel environment. Re-running provisioning for an existing ID intentionally fails; see credential rotation below.

### 4. Start and verify Node

```sh
docker compose up -d whatsapp
docker compose ps
curl --fail http://127.0.0.1:3001/health
curl --fail http://127.0.0.1:3001/ready
```

Both probes normally return `{"success":true}`. `/ready` confirms the HTTP service can accept requests; it does not prove that every WhatsApp account is connected.

Compose publishes **only** `127.0.0.1:3001`. It is intentionally unreachable on the server's public IP. If port 3001 is already occupied, set `WHATSAPP_HOST_PORT=3002` in `.env`, run `docker compose up -d whatsapp`, and change local probe/reverse-proxy targets to port 3002. The container still listens on 3001. Do not change `PORT` in `.env` expecting it to change the container's fixed port.

### 5. Set DNS and HTTPS

Add a DNS A record for your chosen hostname pointing to the VPS public IPv4 address. Add an AAAA record only if IPv6 reaches this server correctly. Allow inbound ports 80 and 443 for Caddy, plus your administration access. Keep port 3001 closed publicly. In your cloud firewall, you can restrict application access to Laravel's fixed outbound IP where practical, while retaining the reachability required for TLS certificate issuance/renewal.

After installing Caddy on the **host**, add the following site to `/etc/caddy/Caddyfile`; preserve any existing sites. Replace the example hostname:

```caddyfile
whatsapp.yourdomain.com {
    reverse_proxy 127.0.0.1:3001 {
        transport http {
            response_header_timeout 65s
        }
    }
}
```

Caddy's [automatic HTTPS](https://caddyserver.com/docs/automatic-https) obtains/renews certificates when DNS and network reachability are correct. Do not enable proxy retries for send requests. Keep headers/bodies containing bearer tokens, QR codes, contacts, and message content out of access/debug logs.

Validate and reload your host Caddy configuration:

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl --fail https://whatsapp.yourdomain.com/health
```

If Caddy runs inside Docker, `127.0.0.1` refers to the Caddy container itself. Put it on the WhatsApp service's Docker network and proxy to `whatsapp:3001` instead. See [Docker service-name networking](https://docs.docker.com/compose/how-tos/networking/).

### 6. Set Laravel production variables

```dotenv
WHATSAPP_NODE_URL=https://whatsapp.yourdomain.com
WHATSAPP_APP_ID=billingapp
WHATSAPP_NODE_TOKEN=<private-production-token>
WHATSAPP_NODE_TIMEOUT=40
WHATSAPP_REQUIRE_HTTPS=true
```

Use the actual hostname you configured, not the example or GitHub URL. Leave off `:3001` and `/api/whatsapp`.

Deploy Laravel's updated environment, rebuild its config cache, and reload persistent workers using its normal deployment flow. In a traditional Laravel installation:

```sh
php artisan config:cache
# Only when using Octane:
php artisan octane:reload
```

Allow PHP/proxy request timeouts to exceed the package's 40-second timeout. Keep send attempts at one; a timeout might happen after WhatsApp submitted the message.

Open the authenticated WhatsApp page in HisabWala, connect, show QR, and scan it from WhatsApp > Linked devices. Test one sales bill to a consenting recipient and verify the sender account, recipient, and text. Do not treat an HTTP success as recipient delivery confirmation.

## Direct Node hosting without Docker

Install supported Node and the OS libraries required by Chromium. Run `npm ci`, `npm run build`, and provision the app with `npm run provision -- billingapp`. Use a process supervisor to run `npm start` in the project directory, with restart-on-failure and a shutdown timeout above 30 seconds. The process must run as the user who owns protected persistent storage.

For production-only installed dependencies, use `npm run provision:production -- billingapp` after building. `npm start` reads `.env` when present; environment variables injected by your hosting provider also work without that file. Set `HOST=0.0.0.0` only when a private container/router needs to reach the process. Keep it on loopback when a host reverse proxy is used. Restart after provisioning or changing startup variables.

Use one supervised owner, not multiple PM2 cluster workers or replicas. A process-local session map cannot be shared by multiple workers. Continue to use HTTPS for public Laravel-to-Node access.

## Dependency review

Review the [dependency advisory in the README](../README.md#dependency-advisory) before production use. The production image skips Puppeteer downloads, but the locked tree still has five inherited high-severity audit entries. Automated build/test success does not clear those advisories or verify real WhatsApp pairing/delivery.

## Updates and rollback

Before an update, keep protected backups of the registry and linked-session storage. Pull and rebuild the code, then let Compose stop the old owner gracefully before replacing it:

```sh
git pull --ff-only
docker compose build
docker compose up -d whatsapp
docker compose ps
curl --fail http://127.0.0.1:3001/ready
```

Do not use `docker compose down -v`, remove `data/`, or rerun initial provisioning for an existing app. To roll back code, check out a previously verified Git revision, rebuild, and recreate the same single service against the same protected data. Verify `/ready` and the authenticated connection status after either operation; restoration reports `connecting` until WhatsApp is actually ready.

## Credential rotation

Keep the stable application ID. Stop the service, back up its registry, deliberately remove only that app's digest and any leftover temporary token file, and provision that same ID again. Install the new token in the matching Laravel app, then start Node and refresh Laravel's configuration/workers. Old tokens must stop working. Do not delete session profiles or change the app ID as a rotation shortcut.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Laravel configuration error on local HTTP | Set `WHATSAPP_REQUIRE_HTTPS=false` only for an intentional local/private HTTP connection; public production requires HTTPS |
| Node 401 after adding an app | Registry was loaded before provisioning; restart Node, then verify token privately |
| Node 403 | Laravel app ID does not match the token's owner |
| Package reports `INVALID_RESPONSE` | Upstream 401/403 may be translated to this safe error; check the registry/token/app ID and restart history |
| `node: bad option: --env-file...` | Supervisor selected an old Node runtime; verify Node 22.12+ and its executable path |
| Connection refused | Service is stopped, wrong port, or wrong network; localhost means the calling host/container |
| `connecting` but no QR yet | Chromium is initializing/restoring; wait for `qr_required` and fetch QR explicitly |
| Service exits before listening | Check credential file, storage ownership, configured port/capacity, and existing owner lock |
| Sessions disappear after deployment | Persistent `data/` was missing, changed, or replaced |
| A send failed/timed out | Outcome may be unknown; inspect WhatsApp before any explicit resubmission |

### Storage lock recovery

A graceful restart releases `data/sessions/.owner-lock`. An unclean crash can leave it behind. Confirm the old Node process **and all of its Chromium children** are gone and no other instance owns the same volume. Only then remove the empty lock directory:

```sh
sudo rmdir data/sessions/.owner-lock
docker compose up -d whatsapp
```

Never remove an active lock, `applications.json`, or the session profile directories to make startup succeed. Investigate repeated crashes first.

## Hostinger Business / managed Node web apps

Keep the dashboard **Build command** as `npm run build`, **Output directory** as `dist`, and **Entry file** as `dist/server.js`. Use Node 22.12+ and npm. The repository's `.npmrc` includes development dependencies during installation, even with `NODE_ENV=production`. Build compiles TypeScript, installs the compatible browser, and verifies its executable exists. A failed browser download now fails deployment rather than silently leaving the app unable to connect.

For the existing Hostinger account, configure these environment variables in hPanel (available during build and runtime):

```dotenv
NODE_ENV=production
HOST=0.0.0.0
APP_CREDENTIALS_FILE=/home/u276729028/whatsapp-data/applications.json
SESSION_DIR=/home/u276729028/whatsapp-data/sessions
PUPPETEER_SKIP_DOWNLOAD=false
```

Keep the host-provided `PORT` when available; otherwise the service defaults to 3001. The browser cache automatically defaults to `/home/u276729028/whatsapp-data/puppeteer`, beside the credential registry. An explicit `PUPPETEER_CACHE_DIR` overrides this; the same absolute path must be used during build and runtime. Remove a Docker-only `CHROME_PATH=/usr/bin/chromium` if that executable is absent on this host. Do not set `CHROME_NO_SANDBOX` merely to hide an unrelated startup failure.

The existing `applications.json` and private `billingapp.token` were provisioned separately; code deployment does not generate or rotate them. Keep the protected persistent directory outside `public_html` and Hostinger's build/version directories. Never move `hbuilds` into `public_html`. For another hosting account, replace the `/home/u276729028/` portion with its real private writable directory.

Redeploy from GitHub after changing settings. Visiting `/` returns a service identification response; `/health` checks the process and `/ready` checks service readiness. Neither proves that Chrome can run. Click Connect once in Laravel, explicitly request a QR, scan it, verify `connected`, then send a consenting recipient a test text. After a controlled restart, verify the linked account restores without re-scanning. Inspect runtime logs for safe diagnostic codes if startup fails.

Browser download does not install Linux shared libraries or grant sandbox permissions. If logs show `CHROME_DEPENDENCIES` or `CHROME_SANDBOX`, Hostinger must provide compatible libraries/permissions. When the hosting plan cannot supply them, use the supplied Docker deployment on a VPS or compatible container host. Run exactly one session-owning process against the storage directory.

Docker and CI deliberately set `PUPPETEER_SKIP_DOWNLOAD=true`; Docker's runtime separately installs system Chromium. Explicit `CHROME_PATH` is supported for an already installed browser. The build's opt-out does not weaken runtime readiness checks.
