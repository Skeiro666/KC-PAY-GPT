# KC-PAY-GPT Implementation, Operations and Deployment Handbook

Prepared: 2026-11-11. Scope: `E:\project\auto_chongzhi_chatgpt\KC-PAY-GPT`. The deleted KC-PAY-GPT-new directory is excluded.

This handbook follows current source and covers architecture, requirements, local setup, administration, deployment, recovery and troubleshooting. Production examples must be created and verified by the operator. No real payment, server installation or deployment was performed while writing it. Replace all REPLACE_* values and recharge.example.com. Linux commands are not PowerShell commands. Run commands from the project root unless specified.

## 1. Purpose and boundaries

This subscription activation service accepts a CDK and account Session, validates them, launches local browser automation or a third-party API worker, and stores/streams task and billing results.

Areas include CDK redemption, card/proxy/address pools, Sessions, monitoring, billing, subscription queries, renewal controls, administrator verification, Telegram and diagnostic media.

Package metadata mentions registration, but the current Session-based flow does not establish a complete registration feature. Finished-account download returns 410. Plan names, plan_name mappings, promotions and regions do not guarantee current upstream availability.

Normal activation can submit a real payment. Checkout-link debugging returns after creation but still contacts external services; it is not a complete pre-payment review. This project lacks the deleted version's PAYMENT_REVIEW_ONLY feature. Use only authorized accounts, payment instruments, genuine billing information and service configurations.

## 2. Architecture and stack

Request path: browser → HTTPS/Nginx → Express HTTP/WebSocket → MySQL/workers → Chromium or provider API.

- Node.js: CommonJS, Express for APIs/static files, ws for updates, mysql2/promise for storage and axios for HTTP.
- Frontend: HTML/CSS/native JS without npm run build. Inline code coexists with public/css/tokens.css, admin.css and public/js/admin-shell.js; preserve all assets.
- Browsers: Playwright/CDP and related Puppeteer dependencies. Runtime modes are standalone, pool and bitbrowser.
- MySQL 8: startup creates tables, adds columns, initializes settings and migrates card fields.
- Python helpers: torch, transformers, OpenCV, numpy, pillow, requests and Python Playwright. Their presence does not establish that every challenge works automatically. Use normal human verification when needed.
- Optional services: provider, Telegram and other integrations, with separate accounts/fees. Default CPU dependencies do not require a GPU.

Docker supplies Node/Python/browsers; native execution needs separate installations. The image is substantially heavier than an ordinary static website because both language environments and browser dependencies are installed.

## 3. Source responsibilities

| File/directory | Responsibility |
| --- | --- |
| server.js | dotenv, HTTP/auth, admission, workers, analysis, WebSocket |
| index.js | Session login, plan/region, Checkout, payment, subscription, cleanup |
| session-auth.js | Session parsing, token/email extraction, cookies/login |
| chatgpt.js / pricing-checkout.js | API / pricing-page UI checkout |
| browser-runtime.js | Runtime selection, worker environment, cleanup |
| browser-standalone.js | Independent Chromium launch per job |
| browser-pool.js / browser-pool-client.js | Warming, leasing, health, CDP |
| bitbrowser-client.js | Existing BitBrowser profile integration, serial use |
| payment-retry.js / stripe-payment.js | Card reservation, filling, decline rotation, billing |
| mysql-store.js / mysql-schema.sql | Storage, configuration, migrations, locks |
| card-crypto.js / redaction.js | AES-256-GCM card encryption and masking |
| subscription-check.js / auto-renew.js | Subscription and renewal operations |
| gpt-api-client.js | Plans, balance, inspection, orders and polling |
| admin-auth.js / admin-paths.js | Authentication, verification and entry paths |
| runtime-log.js / telegram-notify.js | Logs and notifications |
| public/ / test/ | Pages/assets and Vitest regressions |

Read reset-db.js and update-mysql-schema.js before using them; neither is a startup step. Never run node index.js as a health check: it is a payment worker.

## 4. Task execution and isolation

1. User validates a CDK, then submits a complete Session; backend checks remain authoritative.
2. Admission checks token, maintenance, concurrency, CDK/cooldown and mode-specific resources.
3. Same-CDK admission is mutually excluded in one process; capacity is reserved while checking. A conditional used_at IS NULL update claims the CDK in MySQL.
4. Create task_logs and transfer capacity to jobKey. Local mode launches index.js; provider mode runs the API worker.
5. Analyze worker output into status/progress, store it and broadcast to subscribers for that jobKey.
6. Local success/manual retain the claim. An exception after dispatch conservatively becomes manual when the outcome is uncertain. Known failures follow existing rollback logic.
7. Close task context, close standalone process or return pool slot, then release job capacity. Recording disabled must not skip context cleanup.

Pool mode reuses Chromium processes but creates new isolated contexts per job. Standalone launches/closes a process per job. BitBrowser serially opens the configured existing profile and closes it afterwards; it does not delete the profile or reinstall an engine.

Limitations: some outcome analysis depends on logs/progress rather than a persisted payment state machine. Manual proves neither a charge nor its absence. Provider idempotency, all retries and forced-exit cleanup are not fully audited. Restart recovery uses progress thresholds, not actual billing reconciliation.

Use one app instance. Do not directly enable PM2 cluster/multiple replicas against one database: capacity includes process-local state, while startup resets asset locks and processes running tasks, potentially affecting other instances.

## 5. Requirements and capacity

Prepare source, Docker Engine/Compose v2 (or native dependencies), MySQL storage, administrator identity/separate strong passwords, a fixed card key, domain/DNS/HTTPS, SSH and backup storage. Local mode also requires authorized Sessions/payment instruments/genuine billing details and network access. Provider mode needs permissions, plans and balance.

| Scenario | Estimated resources | Initial concurrent jobs |
| --- | --- | --- |
| Testing | 2 vCPU/4GB/60GB SSD | 1 |
| Small production | 4 vCPU/8GB/100GB SSD | 1, then 2 after observation |
| More headroom | 8 vCPU/16GB/150GB SSD | 3–4, then benchmark |
| Provider API only | Starting at 2 vCPU/4GB | Provider-dependent |

These are estimates, not benchmark guarantees. Builds, browsers, CPU inference and MySQL can peak together. Original Compose caps app at 6GB, excluding MySQL/OS; do not copy this onto a 4GB host. shm_size: 2gb is a shared-memory limit, not extra physical RAM. The code's 0.55GB/slot hint is not a guarantee. Retain roughly 20–30% RAM headroom and plan disk cleanup/expansion around 70–80% usage.

## 6. Local Docker on Windows

Install Docker Desktop with Linux containers/WSL2 and wait for the engine. Copy .env only if absent and replace credentials.

```powershell
Set-Location E:\project\auto_chongzhi_chatgpt\KC-PAY-GPT
if (-not (Test-Path -LiteralPath .env)) { Copy-Item .env.example .env }
notepad .env
docker version
docker compose version
docker compose -f docker-compose.yml config --quiet
docker compose -f docker-compose.yml up -d --build
docker compose -f docker-compose.yml ps
docker compose -f docker-compose.yml port app 3000
docker compose -f docker-compose.yml logs --tail 100 app
```

Original project name is kc-gpt-pay2. MySQL host port is 3310, while internal connections use mysql:3306. The app host mapping uses ${PORT:-3100}; PORT=3000 in .env.example changes it to 3000. Use the port command, then open / and /admin-login at that port.

Original Compose forwards only selected variables. An entry in .env does not automatically enter the container. Add required settings such as ADMIN_EMAIL, ADMIN_SECONDARY_PASSWORD, ADMIN_TOKEN_SECRET, CHECKOUT_MODE, CHECKOUT_UI_FALLBACK, AUTO_CANCEL_RENEW and RECORD_VIDEO to app environment, or use section 12. Recreate containers after environment changes; restart alone is insufficient.

## 7. Native development

The package declares Node >=20; Dockerfile still uses node:20-slim. A minimum requirement is not a support guarantee: consult the official lifecycle. Validate on Node 24 and upgrade the base in a separate release; this handbook does not claim that upgrade has passed.

Install Node and MySQL (the original Docker mysql service can be started with docker compose -f docker-compose.yml up -d mysql). For that database use DB_HOST=127.0.0.1, DB_PORT=3310, DB_NAME=plus_papay and matching credentials. Stop other apps sharing the database.

```powershell
node --version
npm --version
npm ci
npx playwright install chromium
npm test
node --check server.js
node --check index.js
npm start
```

Linux browser/system dependency installation uses npx playwright install --with-deps chromium. npm start stays in the foreground; Ctrl+C stops it. npm run start:headful is for local visible-browser diagnosis. Prefer HEADFUL=0 on headless Linux.

MySQL and the target database must already exist; ensureReady only creates/migrates tables. Connect interactively and create:

```sql
CREATE DATABASE plus_papay CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

The app user needs schema/data privileges within this database, not unnecessary server-wide privileges.

For existing Python helpers:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-hcaptcha.txt
.\.venv\Scripts\python.exe -m playwright install chromium
```

Linux uses python3 -m venv .venv and .venv/bin/python. Set HCAPTCHA_SOLVER_PYTHON to the absolute interpreter path. Modules/models may download separately; confirm actual health checks. Preserve the lockfile. Do not validate installation by running a live worker/account.

## 8. First administrator configuration

1. Default login is /admin-login and panel /admin; use configured paths if changed. Set email/login/secondary password before initialization. Editing .env afterwards does not reset existing passwords; use admin settings.
2. Replace defaults on a restricted network, configure verification/recovery and synchronize server time. Default admin token is 24 hours, secondary token 30 minutes, challenge five minutes. Memory-based limits do not replace edge controls.
3. Enable maintenance and start with foreground concurrency=1 and pool slots=1. Database settings can override env defaults; check effective settings.
4. Select local/provider mode, never while tasks are active.
5. Add/test proxies where required. Container 127.0.0.1 is itself. Docker Desktop may use host.docker.internal; Linux needs a reachable address.
6. Confirm regions/currencies: PH/PHP, US/USD, SG/SGD, MY/MYR. Plan region is not the same as actual billing address. Use genuine authorized details rather than random substitutes.
7. Dedicated card-pool import accepts number|expiry|CVC|holder, one per line, up to 500 per request. Follow UI/server expiry validation; legacy editors may use another delimiter. Import authorized data only and verify masking/key persistence.
8. Generate a few self-service CDKs for the intended plan, verify states and then distribute. Manual admin starts can also charge money.
9. Optionally test Telegram. Notification success is not payment success; notification failure must not trigger another payment.
10. Complete section 14 before disabling maintenance and opening limited traffic.

BitBrowser requires an installed/running external application, existing profile ID and reachable API. Set BROWSER_PROVIDER=bitbrowser and related settings. Docker does not install/create it. Use the single configured profile serially.

## 9. User operation and reconciliation

Enter CDK → validate plan → obtain full Session JSON from the user's own logged-in browser → paste → explicitly start → preserve jobKey/query CDK → verify subscription and billing.

Treat Sessions like passwords. Never place them in public chats or URLs. An accessToken is not the login cookie; token-only input can pass preliminary checks but fail authenticated Checkout. Supported fields are defined by session-auth.js. Pasting must not automatically pay. Do not resubmit/switch accounts while waiting.

Payment and renewal cancellation are separate. AUTO_CANCEL_RENEW=1 attempts to disable future renewal after payment; failure needs separate handling and does not negate payment. Cancel/resume controls alter real subscriptions and must reflect the account holder's intent.

For manual, timeout or disconnection, inspect task logs, external orders, subscription and actual billing. Do not unlock/retry until reconciled. The UI is not guaranteed to provide a one-click safe reset. Deleting a task or arbitrary SQL is not reconciliation.

The actual subscription route is `/subscription`, currently titled Invoice Assistant. Its capabilities depend on real responses; no particular invoice generation is guaranteed. For empty pools replenish authorized resources; distinguish issuer, funds, billing and page failures rather than blindly cycling cards.

## 10. Provider top-up mode

Configure a trusted Base URL/API key → test plans/balance → choose mappings → enable. A default URL is a code default, not an endorsement or availability guarantee. Compare 对接api.md with the provider's current contract, scopes and fees.

Client routes include /plans, /balance, /pay/inspect, /pay, /pay/orders/{order_id} and /tasks/{task_id}. Sessions are sent to the provider: confirm authorization, data processing, quota, plans and connectivity. Local card payment is bypassed, but startup may still warm browsers; disable the pool in admin settings for API-only operation and inspect logs. The image still installs Python/browsers.

Outer done is not business success. After timeout, query the existing order before creating another. Provider idempotency/live reconciliation were not verified while writing this document.


## 11. Prepare the production host

Start with one x86_64 Ubuntu 24.04 host, about 4 vCPU/8GB. Prepare SSH keys, an admin account and console recovery. Expose only 80/443 and restricted SSH; allow the actual SSH port before firewall changes.

Configure Docker's official Ubuntu apt repository before running these package commands. Inspect existing installations rather than blindly removing them. Host Node/Python are unnecessary. Keep MySQL, CDP 9222/19222+ and BitBrowser APIs private. Docker publishing can interact with host firewall rules; verify exposure externally.

Transfer reviewed source privately into /opt/kc-pay-gpt. Never put real .env, Sessions, cards, profiles, backups or logs in public repositories. Commands below assume this directory.

```bash
# After configuring Docker's official apt repository:
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker compose version
sudo mkdir -p /opt/kc-pay-gpt
# Transfer reviewed source into this directory, then:
cd /opt/kc-pay-gpt
```


## 12. Create an independent production configuration

This is a proposed template, not a deployment performed for you. Save it as compose.prod.yml in the project root. Always use -f compose.prod.yml -p kc-prod and keep original development volumes separate.

Copy .env.example to a private .env and set:

- DB_NAME=plus_papay; DB_PASSWORD for the app user; a separate new DB_ROOT_PASSWORD.
- Replace default ADMIN_EMAIL, ADMIN_PASSWORD and ADMIN_SECONDARY_PASSWORD; use an explicit random ADMIN_TOKEN_SECRET.
- Set a stable 64-hex CARD_ENCRYPTION_KEY. Generate with openssl rand -hex 32, and generate an independent value for the token secret. Use a private terminal and safe backups.
- Preserve the original key for migrated encrypted data. An incorrect environment key overrides a correct key file.
- BROWSER_PROVIDER=chrome, HEADFUL=0, BROWSER_POOL=1, BROWSER_POOL_SIZE=1, BROWSER_POOL_MAX_SIZE=2, RECORD_VIDEO=0 and MAX_PROCESS_ATTEMPTS=1; set admin capacity to one as well.
- Explicitly choose checkout mode/fallback and AUTO_CANCEL_RENEW. Use CHECKOUT_PROMO_CAMPAIGN=none when eligibility is uncertain.

Review the Node20 image base and upgrade separately after verification. Python packages are not fully pinned; lock/verify them for production. Browser/PyTorch downloads can be large.

**Build secrets**: extend .dockerignore to exclude data/, backups/, .venv/, *.log, private SQL, real Session files and temporary scripts. Current rules only exclude data/browser-pool; COPY . . could embed data/card-encryption.key. This handbook did not change ignore rules: the operator must do so.

The dedicated kc_app user receives target-database privileges for current migrations. App does not connect as root. MySQL has no host port; app binds to loopback 3100. Example caps for an 8GB host are 5GB app and 1GB MySQL; reduce concurrency/adjust if OOM occurs. Shared memory uses real capacity. Editing environment variables does not rotate passwords in existing volumes.

The env_file fixes missing forwarding but also gives app DB_ROOT_PASSWORD, which it does not use. Split app environment files for tighter isolation. Docker secrets integration is not implemented. Production uses image contents without source bind mounts.

```yaml
name: kc-prod
services:
  mysql:
    image: mysql:8.0
    restart: unless-stopped
    environment:
      MYSQL_ROOT_PASSWORD: ${DB_ROOT_PASSWORD:?Set DB_ROOT_PASSWORD}
      MYSQL_DATABASE: ${DB_NAME:-plus_papay}
      MYSQL_USER: kc_app
      MYSQL_PASSWORD: ${DB_PASSWORD:?Set DB_PASSWORD}
    volumes:
      - mysql_data:/var/lib/mysql
    mem_limit: 1g
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost"]
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 30s
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
  app:
    build: .
    image: kc-pay-gpt:${APP_IMAGE_TAG:-local}
    restart: unless-stopped
    init: true
    env_file:
      - .env
    environment:
      NODE_ENV: production
      PORT: "3000"
      DB_HOST: mysql
      DB_PORT: "3306"
      DB_USER: kc_app
      DB_NAME: ${DB_NAME:-plus_papay}
      DB_PASSWORD: ${DB_PASSWORD:?Set DB_PASSWORD}
      HEADFUL: "0"
    depends_on:
      mysql:
        condition: service_healthy
    ports:
      - "127.0.0.1:3100:3000"
    volumes:
      - ./data:/app/data
      - ./debug_screenshots:/app/debug_screenshots
      - ./product_files:/app/product_files
    shm_size: "2gb"
    mem_limit: 5g
    stop_grace_period: 60s
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
volumes:
  mysql_data:
```


### 12.1 Startup and health

Explicit Compose environment values override env_file. Internal 3000 and host 3100 are separate. Recreate containers after env changes; restart does not update injected variables.

Create persistence directories and protect .env. The current image runs as root; a non-root conversion also needs mount permissions and browser-path changes. Start MySQL, wait for health, then start app without public traffic. config --quiet validates structure only. Never publish full rendered config, which may contain passwords.

MySQL health only indicates a responding process. Runtime success establishes basic app operation, not payment acceptance.

```bash
cd /opt/kc-pay-gpt
chmod 600 .env
mkdir -p data debug_screenshots product_files
sudo docker compose -f compose.prod.yml -p kc-prod config --quiet
sudo docker compose -f compose.prod.yml -p kc-prod build app
sudo docker compose -f compose.prod.yml -p kc-prod up -d mysql
sudo docker compose -f compose.prod.yml -p kc-prod ps
# Wait until mysql is healthy before continuing.
sudo docker compose -f compose.prod.yml -p kc-prod up -d app
sudo docker compose -f compose.prod.yml -p kc-prod logs --tail 100 app
curl --fail http://127.0.0.1:3100/api/public/runtime
curl --fail http://127.0.0.1:3100/api/public/payment-region
```


## 13. Domain, Nginx and HTTPS

Point A to the host; add AAAA only with working IPv6. Install Nginx and save the block below as /etc/nginx/sites-available/kc-pay-gpt, replacing the domain. Preserve existing sites.

Reload only after nginx -t passes. Obtain a certificate once DNS/80 work. Ubuntu Certbot packages are shown; preserve an existing certificate-management setup if present. Verify HTTPS, redirects and renewal.

WebSocket shares the HTTP origin and needs Upgrade/Connection forwarding. Current code reads the first X-Forwarded-For value, so the sole edge example overwrites it with remote_addr rather than appending untrusted input. Configure trusted real-IP handling if adding CDN/multiple proxies. Keep origin 3100 private; never expose data/media as unrestricted static directories.

```nginx
server {
    listen 80;
    server_name recharge.example.com;
    client_max_body_size 15m;
    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_buffering off;
    }
}
```

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
# Save the configuration above before enabling it.
sudo ln -s /etc/nginx/sites-available/kc-pay-gpt /etc/nginx/sites-enabled/kc-pay-gpt
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d recharge.example.com
sudo certbot renew --dry-run
```


## 14. Go-live acceptance

- [ ] No restart loop, database errors, decryption failure or missing browser; local runtime/region work.
- [ ] Only intended ports are public; DB/CDP remain private and HTTPS works.
- [ ] Defaults replaced and token secret explicit; login, verification, logout and expiry work.
- [ ] Homepage/admin/mobile layout and resources work; invalid/maintenance states are clear.
- [ ] Pool/capacity settings and masked resources are correct; browser startup is not login verification.
- [ ] Explicitly choose checkout-link debugging before testing an authorized account. It exits after order creation without calling payment; it is not full card review.
- [ ] A live activation needs separate account, amount and timing authorization. Run one job and reconcile billing, subscription, CDK and renewal.
- [ ] Refresh/disconnection follows the original job, not a replacement. Manual retains the claim and requests review.
- [ ] Back up and restore in isolation, verifying original ciphertext can decrypt.

These live checks were not performed for you. Unit tests do not prove real charges, upstream behavior, cloud access or a complete image build.




## 15. Daily operations and shutdown

Check active/manual/failed tasks, usable cards, notifications, DB capacity, certificates and backups daily. Watch CPU/RAM peaks, OOMKilled, restarts and latency, not just average CPU. Images, media, logs and MySQL grow over time.

Build a jobKey timeline. Logs/media can expose personal information even after masking. Define retention, for example 7–14 days for diagnostic media adjusted to actual requirements. Preview cleanup targets and preserve active-task/incident evidence; DB records may retain references to deleted media.

Maintenance order: enable maintenance/drain → wait and reconcile → back up → stop app → change → start/check → reopen. Current SIGTERM cleans up and exits. stop_grace_period does not make the app wait for payments. Avoid restarts during payment.

Do not depend on swap for normal browser load. Reduce concurrency first; inspect contexts/processes/network/pages instead of endlessly restarting or recreating orders.

```bash
sudo docker compose -f compose.prod.yml -p kc-prod ps
sudo docker compose -f compose.prod.yml -p kc-prod logs --tail 200 app
sudo docker stats --no-stream
df -h
free -h
sudo docker compose -f compose.prod.yml -p kc-prod exec app node --version
```


## 16. Back up the database, original keys and files together

Include database, matching source/image tag, .env, compose.prod.yml, data (original card-encryption.key/config), required product_files and incident media. Sessions/configuration make dumps sensitive even when cards are encrypted.

Run below in the Linux project after draining. Keep backups outside source and use umask077. Stop app while MySQL stays running for a no-business-write consistency window. Mysqldump reads root credentials from container environment rather than host arguments; environment exposure remains, so this is not full secret management.

set -e stops on failure. Investigate before manually restoring app service. Encrypt off-host copies, verify hashes and rehearse restoration. Control access to database/keys separately. Lost keys cannot recover ciphertext; do not publish archives. Commands target section12, not original Compose names.

```bash
set -e
umask 077
cd /opt/kc-pay-gpt
backup_dir="/opt/kc-backups/$(date -u +%Y%m%dT%H%M%SZ)"
sudo install -d -m 700 -o "$(id -u)" -g "$(id -g)" "$backup_dir"
sudo docker compose -f compose.prod.yml -p kc-prod stop app
sudo docker compose -f compose.prod.yml -p kc-prod exec -T mysql sh -c   'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysqldump -uroot --single-transaction --routines --events --triggers --hex-blob --no-tablespaces "$MYSQL_DATABASE"'   > "$backup_dir/database.sql"
sudo tar -czf "$backup_dir/private-files.tar.gz" .env compose.prod.yml data product_files
sudo chown "$(id -u):$(id -g)" "$backup_dir/private-files.tar.gz"
chmod 600 "$backup_dir"/*
sha256sum "$backup_dir/database.sql" "$backup_dir/private-files.tar.gz" > "$backup_dir/SHA256SUMS"
sudo docker compose -f compose.prod.yml -p kc-prod up -d app
```


## 17. Restore, migrate and roll back

### 17.1 Restore procedure

1. Prepare matching source on a restricted host/in an empty isolated directory without traffic. Same-host rehearsals need distinct project names, paths and ports; never share production DB.
2. Verify SHA256SUMS and inspect archives with tar -tzf before extracting into the correct empty target. Do not overwrite live production.
3. Restore original env/keys/config/files and create a new MySQL volume using the original version. Verify database name/credentials; resolve name changes deliberately.
4. After MySQL is ready, import into the verified target below. This modifies data; use only an isolated or authorized restore target.
5. Verify original environment key and mount permissions before startup. Never generate a replacement; environment overrides the file.
6. Startup migrates and processes leftover running tasks. Inspect history, masking, decryption and maintenance. Progress-based CDK recovery does not establish external order failure.
7. Reconcile interrupted orders/subscriptions before switching DNS/proxy and avoid dual execution.

### 17.2 Releases and rollback

Drain, back up and record source/image versions before building, starting and checking. Use unique APP_IMAGE_TAG values rather than continually overwriting local. Recreate for configuration changes.

Rollback must match code/image/schema/original key. Older code may not work after migration. Snapshot restoration must account for subsequent real payments; never erase billing merely to revert UI.

Avoid docker compose down -v and unreviewed reset-db.js. Project names determine volume names. If changing -p hides old data, inspect mappings before initializing/deleting anything.

```bash
# Only after verifying an ISOLATED/authorized target database:
# Replace /secure/restore/database.sql with your verified dump.
sudo docker compose -f compose.prod.yml -p kc-prod exec -T mysql sh -c   'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot "$MYSQL_DATABASE"'   < /secure/restore/database.sql
```


## 18. Troubleshooting

| Symptom | First checks | Principle |
| --- | --- | --- |
| DB connection refused | Health, DB_HOST/PORT, network | Host port for native; mysql:3306 inside Docker |
| Access denied/unknown DB | Actual credentials, volume history | Env does not rotate old passwords; preserve volumes |
| Decryption fails | Original key, env precedence, mount | Restore original; new keys cannot fix old ciphertext |
| Admin password wrong | Initialization, actual DB, change history | Env is not a reset mechanism |
| 502 | App, loopback3100, upstream | Start at local runtime |
| 413 | Nginx body/JSON_BODY_LIMIT | Align reasonable limits |
| No progress | WebSocket101, Upgrade, jobKey/heartbeat | Do not create another activation |
| Missing browser | Build/install/system libs | Rebuild for dependency changes |
| Browser OOM | Exit state, RAM, shm, load | Reduce capacity, investigate peaks/leaks |
| Not logged in | Expiry, cookies, account | Token is not cookie |
| 403/challenge | Normal login/network/page | Human verification; no repeated orders |
| No purchase entry | Subscription/eligibility/UI | Existing subscriber may not buy again |
| Manual/timeout | Orders/subscription/billing/logs | Reconcile before release/retry |
| Provider401/403 | Key/scopes/base URL | Never print full key |
| Cancellation fails | Activation delay/upstream | Separate from payment |
| Settings unchanged | DB precedence/recreation | Identify actual source |

Follow one jobKey timeline and change one factor at a time. Simultaneously changing proxy, region, Session and payment code obscures causality.




## 19. Development checks and remaining work

Use an isolated DB. Run npm ci, npm test and node --check for JS changes. Regressions cover API contracts, encryption, redaction, renewal, Session/Checkout and lifecycle, not all UI, DB concurrency, clouds or real payments.

The historical result was 50 tests across10 files, not rerun as evidence for this document. Lifecycle cases include non-owner rollback prevention, CDK exclusion, admission reservation, cleanup without recording, exclusive health probing and CDK retention on success/manual/errors. Injected tests do not replace integration checks.

Remaining work includes persisted payment state/reconciliation, provider idempotency, distributed coordination, forced-exit cleanup, comprehensive sensitive-data audit, dependency pinning/image upgrades and UI automation. These are not completed claims.

Current npm scripts are start, start:headful, test and test:watch. Deleted-directory commands start:local, test:all and review:external do not exist here.




## 20. Handover and evidence boundaries

Hand over source/image identifiers, host/domain, actual Compose name/path, DB version/backup location, original-key custody, admin/verification recovery, mode/capacity, retention, known issues and latest reconciliation. Transfer passwords, Sessions, cards and proxy secrets privately outside this handbook.

Incident order: block new work → preserve jobKey/evidence → reconcile externally → decide recovery/rollback.

This is not proof of deployment, live payment success or payment-card compliance. Encrypted CVC is retained; encryption is not compliance certification. Resolve actual data-storage requirements and code limitations before commercial operation. Appendices are implementation indexes, not advice to expose every route or enable every variable.




## Appendix A: Configuration reference

Extracted only from public .env.example, not private credentials. Empty values require configuration or source fallbacks; commented entries are not necessarily active. Replace sample passwords. Some variables are legacy/optional, not mandatory worker inputs.

| Variable | Example value | Interpretation |
| --- | --- | --- |
| `PORT` | `3000` | port |
| `JSON_BODY_LIMIT` | `15mb` | json body limit |
| `ADMIN_TOKEN_SECRET` | `(empty)` | admin token secret; initial identity/password/path or runtime token secret |
| `ADMIN_EMAIL` | `admin@vru.cc` | admin email; initial identity/password/path or runtime token secret |
| `ADMIN_PASSWORD` | `admin123` | admin password; initial identity/password/path or runtime token secret |
| `ADMIN_SECONDARY_PASSWORD` | `admin123` | admin secondary password; initial identity/password/path or runtime token secret |
| `ADMIN_LOGIN_PATH` | `admin-login` | admin login path; initial identity/password/path or runtime token secret |
| `ADMIN_PANEL_PATH` | `admin` | admin panel path; initial identity/password/path or runtime token secret |
| `DB_HOST` | `127.0.0.1` | db host |
| `DB_PORT` | `3306` | db port |
| `DB_USER` | `root` | db user |
| `DB_PASSWORD` | `(empty)` | db password |
| `DB_NAME` | `plus_papay` | db name |
| `DB_POOL_LIMIT` | `60` | db pool limit |
| `HEADFUL` | `0` | headful |
| `CHROMIUM_CHANNEL` | `(empty)` | chromium channel |
| `BROWSER_POOL` | `1` | browser pool |
| `BROWSER_POOL_SIZE` | `2` | browser pool size |
| `BROWSER_POOL_MAX_SIZE` | `24` | browser pool max size |
| `BROWSER_POOL_BASE_PORT` | `19222` | browser pool base port |
| `BROWSER_PROVIDER` | `chrome` | browser provider |
| `BITBROWSER_API_URL` | `http://127.0.0.1:54345` | bitbrowser api url |
| `BITBROWSER_PROFILE_ID` | `(empty)` | bitbrowser profile id |
| `BITBROWSER_HEADLESS` | `1` | bitbrowser headless |
| `BITBROWSER_OPEN_TIMEOUT_MS` | `60000` | bitbrowser open timeout ms |
| `HCAPTCHA_VLM_API_KEY` | `sk-...` | hcaptcha vlm api key; optional existing integration, verify configuration/runtime |
| `HCAPTCHA_VLM_BASE_URL` | `https://api.openai.com/v1` | hcaptcha vlm base url; optional existing integration, verify configuration/runtime |
| `HCAPTCHA_VLM_MODEL` | `gpt-5.5` | hcaptcha vlm model; optional existing integration, verify configuration/runtime |
| `HCAPTCHA_CAPTCHA_PLATFORM_API_KEY` | `CAP-...` | hcaptcha captcha platform api key; optional existing integration, verify configuration/runtime |
| `HCAPTCHA_CAPTCHA_PLATFORM_API_URL` | `https://api.capsolver.com` | hcaptcha captcha platform api url; optional existing integration, verify configuration/runtime |
| `HCAPTCHA_CAPTCHA_PLATFORM_TIMEOUT` | `180` | hcaptcha captcha platform timeout; optional existing integration, verify configuration/runtime |
| `CHATGPT_SESSION_COOKIE` | `(empty)` | chatgpt session cookie |
| `HCAPTCHA_SOLVER_PYTHON` | `(empty)` | hcaptcha solver python; optional existing integration, verify configuration/runtime |
| `CHATGPT_TOKEN` | `(empty)` | chatgpt token |
| `STRIPE_KEY` | `(empty)` | stripe key |
| `CHECKOUT_MODE` | `ui` | checkout mode |
| `CHECKOUT_UI_FALLBACK` | `1` | checkout ui fallback |
| `RECORD_VIDEO` | `0` | record video |
| `CHECKOUT_PROMO_CAMPAIGN` | `plus-1-month-free` | checkout promo campaign |
| `CHECKOUT_UI_MODE` | `custom` | checkout ui mode |
| `AUTO_CANCEL_RENEW` | `1` | auto cancel renew |
| `AUTO_CANCEL_RENEW_DELAY_MS` | `8000` | auto cancel renew delay ms |
| `AUTO_CANCEL_RENEW_INTERVAL_MS` | `5000` | auto cancel renew interval ms |
| `AUTO_CANCEL_RENEW_RETRIES` | `6` | auto cancel renew retries |
| `BILLING_COUNTRY` | `US` | billing country; optional default, verify asset-driven call path |
| `BILLING_ADDRESS` | `(empty)` | billing address; optional default, verify asset-driven call path |
| `BILLING_CITY` | `(empty)` | billing city; optional default, verify asset-driven call path |
| `BILLING_STATE` | `(empty)` | billing state; optional default, verify asset-driven call path |
| `BILLING_ZIP` | `(empty)` | billing zip; optional default, verify asset-driven call path |
| `BILLING_NAME` | `(empty)` | billing name; optional default, verify asset-driven call path |
| `BILLING_PHONE` | `(empty)` | billing phone; optional default, verify asset-driven call path |
| `CARD_ENCRYPTION_KEY` | `(empty)` | card encryption key |
| `CARD_NUMBER` | `(empty)` | card number |
| `CARD_EXPIRY` | `(empty)` | card expiry |
| `CARD_CVC` | `(empty)` | card cvc |
| `PROXY` | `(empty)` | proxy |
| `INBOX_API_BASE` | `(empty)` | inbox api base; legacy/optional mailbox capability |
| `INBOX_EMAIL_DOMAINS` | `(empty)` | inbox email domains; legacy/optional mailbox capability |
| `RANDOM_EMAIL_DOMAIN` | `(empty)` | random email domain; legacy/optional mailbox capability |

Admin identity/passwords/paths primarily initialize storage; business settings live in app_config; connection/keys/browser/Checkout use process environment. Some integrations sync env into DB; inspect getters instead of assuming universal precedence.

DB_ROOT_PASSWORD and APP_IMAGE_TAG are template additions, not app inputs. Source also reads PROCESS_IDLE_TIMEOUT_MS (three-minute idle default), MAX_PROCESS_ATTEMPTS (one), PAYMENT_MAX_CARD_ATTEMPTS (three), ASSET_LOCK_STALE_MS (15 minutes). Do not blindly raise retries.

## Appendix B: Database and persistence boundaries

```text
app_config
phone_assets
card_assets
cdk_codes
task_logs
activation_attempt_limits
product_assets
pool_emails
tax_free_addresses
proxy_assets
billing_records
admin_login_logs
```

app_config stores settings/password hashes; card_assets ciphertext/last-four/state; cdk_codes.used_at also represents claims; task_logs Sessions/output; billing_records charges; proxy_assets/tax_free_addresses resources; activation_attempt_limits cooldown; admin_login_logs security events. phone_assets, pool_emails and product_assets include legacy features. Table presence does not imply active UI. Migrations add columns beyond initial SQL; consult live schema/ensureLegacyColumns. Card encryption does not imply Session/proxy encryption.

## Appendix C: HTTP route index

From server.js registrations, not a complete access contract. Most admin routes share authentication; earlier routes authenticate individually. Cards/CDKs/Sessions require secondary access. Inspect external/cards/push key checks. WebSocket subscription is not admin authorization; protect jobKeys. Read handlers for fields/responses. No payment-triggering curl is provided.

```text
GET /admin
GET /admin-login
GET /admin-login/
GET /admin-login.html
POST /api/admin/login
POST /api/admin/login/send-tg-code
POST /api/admin/login/verify-2fa
GET /api/admin/runtime-logs
POST /api/admin/runtime-logs/clear
POST /api/admin/proxy/test
POST /api/external/cards/push
GET /api/public/admin-paths
POST /api/public/subscription/check
GET /subscription
GET /api/public/payment-region
GET /api/public/runtime
GET /api/admin/session
GET /api/admin/security/status
GET /api/admin/login-logs
GET /api/admin/secondary/session
POST /api/admin/verify-secondary
POST /api/admin/security/2fa-mode
POST /api/admin/security/paths
POST /api/admin/2fa/setup
POST /api/admin/2fa/confirm
POST /api/admin/2fa/disable
POST /api/admin/change-secondary-password
GET /api/admin/task-logs
GET /api/admin/data
GET /api/admin/browser-pool
POST /api/admin/browser-pool/mode
POST /api/admin/browser-pool/reload
GET /api/admin/sessions
GET /api/admin/sessions/:jobKey
POST /api/admin/subscription/cancel-auto-renew
POST /api/admin/subscription/enable-auto-renew
POST /api/admin/subscription/batch-renewal-status
GET /api/admin/screenshots
GET /api/admin/video
GET /api/admin/screenshots/:subdir/:filename
DELETE /api/admin/task-logs/:jobKey
POST /api/admin/telegram
POST /api/admin/telegram/test
POST /api/admin/hcaptcha
POST /api/admin/hcaptcha/test
POST /api/admin/hcaptcha/test-vlm
POST /api/admin/hcaptcha/test-captcha-platform
GET /api/admin/hcaptcha/logs
GET /api/admin/gpt-api
POST /api/admin/gpt-api
POST /api/admin/gpt-api/test
GET /api/admin/gpt-api/status
POST /api/admin/config
GET /api/admin/region
PUT /api/admin/region
GET /api/admin/checkout/plans
POST /api/admin/checkout/generate
GET /api/admin/checkout/status/:jobKey
GET /api/admin/cards
POST /api/admin/cards/import
DELETE /api/admin/cards/:id
GET /api/admin/proxies
POST /api/admin/proxies
PUT /api/admin/proxies/:id
POST /api/admin/proxies/:id/test
DELETE /api/admin/proxies/:id
GET /api/admin/addresses
POST /api/admin/addresses
POST /api/admin/addresses/generate-random-us
DELETE /api/admin/addresses/unbound
PUT /api/admin/addresses/:id
DELETE /api/admin/addresses/:id
POST /api/admin/change-password
GET /api/admin/cdks
POST /api/admin/cdks/generate
POST /api/admin/cdks/import
POST /api/admin/cdks/:cdk/ship
DELETE /api/admin/cdks/:cdk
GET /api/admin/billing
GET /api/admin/billing/export
GET /api/admin/billing/summary/:cardLast4
DELETE /api/admin/billing/failed
DELETE /api/admin/billing/:id
POST /api/run-process
POST /api/admin/trigger-activation
POST /api/verify-cdk
GET /api/cdk/query
GET /api/cdk/download
```

## Appendix D: Official references

For installation, lifecycle and proxy checks; project behavior comes from local source, not endorsement. Docker apt requires its repository; Upgrade handling follows Nginx documentation; Chromium needs shared memory; review Node20 against the lifecycle.

- [Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
- [Docker Compose plugin](https://docs.docker.com/compose/install/linux/)
- [Playwright Docker](https://playwright.dev/docs/docker)
- [Nginx WebSocket proxying](https://nginx.org/en/docs/http/websocket.html)
- [Node.js release schedule](https://github.com/nodejs/Release#release-schedule)
