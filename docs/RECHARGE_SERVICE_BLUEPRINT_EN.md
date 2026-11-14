# Automated Top-up and Subscription Services: Implementation and Build Blueprint

English edition · 2026-11-11

## 1. What this document explains

This document explains how a service purchases a digital entitlement on behalf of a user, and what is needed to build, test and deploy such a service from scratch. It is not an installation guide for a particular repository. Existing implementations are not automatically recommended architectures.

First define the product: adding account balance, redeeming usage credits and purchasing a monthly subscription are different operations. The main example here is a user redeeming a code to activate a subscription on a specified account. More server capacity does not grant access to an upstream purchasing interface.

Capacity figures are planning estimates, not benchmarks. Modules, tables and endpoints are proposed designs, not claims about an existing implementation. Recheck actual upstream plans, prices, eligibility and rules during integration.

## 2. The business model: two transactions and one fulfillment

Three separate outcomes commonly exist:

1. The customer pays you or holds a previously purchased redemption code.
2. You purchase from upstream, paying a subscription charge or spending provider balance.
3. Upstream grants the target account its entitlement.

Customer payment does not prove upstream purchasing succeeded. Successful upstream payment does not always prove that the entitlement is already active. A reliable service links and verifies these outcomes separately.

A CDK is generally your database's fulfillment credential, not an official code from the target platform. It identifies a purchased product and permitted fulfillment count. Generating a random string cannot itself activate an external subscription.

Example: customer purchases a monthly-subscription code → validate the code → identify the target account → create an upstream purchase → pay/call provider → verify entitlement → consume the code. Preserve references and evidence whenever any stage is uncertain.

## 3. Three implementation routes

| Route | Mechanism | Prerequisites | Main limitations |
| --- | --- | --- | --- |
| Official/authorized partner API | Backend calls permitted purchasing/entitlement APIs and queries results | Integration permission, account identifier, credentials, contract and settlement relationship | Access eligibility is crucial; generally best for a stable integration |
| Authorized provider API | Provider performs purchasing; your service submits account/product and queries outcome | Provider account, scopes, balance, mappings and data authorization | Provider reliability, quotas, status and idempotency support |
| Permitted browser workflow | Browser automation completes normal login, selection, checkout and verification | Permission, authorized login state, payment method and genuine billing information | Page changes, challenges, browser resources and human intervention |

Prefer clearly authorized interfaces with durable order queries and idempotency. Browser workflows need a human handoff path; do not promise unattended completion of every challenge or payment.

Distinguish your own payment merchant account from another merchant's checkout. Owning a Stripe account does not authorize your key to query another merchant's Checkout or subscription, nor deliver that merchant's webhooks to you.

## 4. End-to-end execution: inputs, actions and outputs

### Step 1: Accept a request

Inputs: redemption code, product/order reference, target account identifier and only credentials actually required by the route. Determine whether an account ID or scoped authorization suffices; do not collect entire Sessions or passwords merely for convenience.

Validate format, identity, limits and code. Show product, billing period and renewal arrangement, and obtain explicit confirmation. A disabled button is only a UI feature: enforce duplicate protection on the server.

Output a local order_id and request idempotency key. Repeating the same key returns the same order; different content with that key produces a conflict.

### Step 2: Verify account and eligibility

Read the authorized account identity, current plan, purchase eligibility and credential expiry. Detect account switching and handle existing subscriptions according to upstream rules. Token syntax alone does not establish purchasing access.

Expired credentials require normal reauthorization. Human or cardholder verification requires a user/operator handoff through the normal flow, not fabricated verification results.

### Step 3: Atomically reserve code and create work

Within a database transaction, establish validity and exclusive reservation, bind the code to this order, and create pending work. Use database constraints, not merely process-local sets or a short Redis lock.

Call external services after commit. Do not hold a database transaction open during a multi-minute payment. A transactional outbox can bridge committed orders to the queue without losing work between storage and publication.

### Step 4: Claim the job

Workers acquire expiring leases and record worker_id, lease_until and attempt. Renew periodically. Version/fencing checks prevent a stale worker from updating results after ownership changes.

Design for at-least-once delivery: duplicate jobs must not purchase twice. Serialize critical purchases for the same target account, even when separate redemption codes are used.

### Step 5: Create an upstream order

For APIs, submit permitted account/product fields with a stable upstream idempotency key. Persist provider_order_id, amount, currency and a sanitized request digest.

For browser execution, create isolation, install authorized login state, use the normal purchasing entry, confirm account/product/period/total/currency, and retain the newly created checkout reference. Historical checkout links are not proof of a new order.

On creation timeout, query by idempotency key or existing reference. If upstream offers neither query nor idempotency, require review instead of blindly creating another order.

### Step 6: Execute payment/provider debit

Proceed only with authorization and the confirmed amount. Some provider order calls already debit balance; do not initiate a second payment outside that contract.

In browser execution, use the normal payment form, preferably with customer/provider-hosted payment information. Additional authentication becomes a waiting-for-user state. No page redirect does not prove no charge occurred.

Persist the payment_attempt and the imminent irreversible-operation boundary before submission. External requests cannot join a local database transaction atomically; recovery requires idempotency, queries and reconciliation.

### Step 7: Confirm procurement outcome

When controlling the relevant merchant account, verify webhook signatures, deduplicate and persist events, and query the payment object when required. Handle asynchronous payments; a success landing page is insufficient.

When buying a third-party subscription, use authorized account/order queries or provider results. Without that merchant's permission, do not assume access to private Stripe APIs. Browser UI evidence offers limited assurance; unresolved outcomes require review.

### Step 8: Verify entitlement

Read the target account's actual plan, credits and effective/expiry data using permitted mechanisms. A successful payment with delayed activation is fulfillment-verifying, not permission to pay again. Poll the original order within bounded limits.

### Step 9: Commit fulfillment

In a transaction, mark FULFILLED, insert a unique fulfillment record, consume the code, update the ledger and emit a notification event. Failed notifications retry independently rather than repurchasing.

### Step 10: Clean up and reconcile

Close contexts and remove temporary files/short-lived credentials. Release runtime resources while retaining necessary order references, audit trails and unresolved-payment evidence. Renewal cancellation is a separate authorized action with separate state/retries, not part of proving the original payment.

## 5. State machine and retry policy

Suggested main path:

CREATED → VALIDATING → RESERVED → QUEUED → RUNNING → UPSTREAM_ORDER_CREATED → PAYMENT_PENDING → VERIFYING → FULFILLED.

Branches: WAITING_USER, FAILED_SAFE, UNKNOWN, MANUAL_REVIEW and CANCELLED. UNKNOWN indicates uncertain side effects, not failure. Queue DONE is not business FULFILLED.

| Condition | Policy |
| --- | --- |
| Invalid input, expired login, insufficient resources before payment | Release reservations only after establishing no side effects; correct and retry |
| Upstream429 or transient query failure | Bounded exponential backoff with jitter, respecting limits |
| Order-creation timeout | Query original reference or recover using the same idempotency key |
| Payment timeout/worker death | Retain code/payment reservations, enter UNKNOWN and reconcile |
| Definitive decline | Follow its meaning; do not endlessly retry or bypass issuer restrictions |
| Paid but entitlement delayed | Query original purchase, never pay again automatically |
| Notification failure | Retry notification independently |
| Human confirms no payment | Permit audited release/re-execution |

A transaction, distributed lock or queue alone cannot guarantee exactly-once external charging. Aim for at-least-once processing, idempotent effects, queryable orders and recoverable reconciliation.

## 6. Modules to build

| Module | Minimum responsibility |
| --- | --- |
| User interface | Product/redemption/authorization/status; refresh follows original order |
| API | Authentication, validation, rate limits, idempotency; enqueue without waiting for long work |
| Orders/codes | Reserve, consume, release, expire, history and uniqueness |
| Queue/scheduling | Delays, leases, capacity, dead letters and priority |
| Upstream adapters | Consistent order/query/cancel capabilities across providers |
| Payment orchestration | Amount checks, attempts and uncertain-result isolation |
| Entitlement/reconciliation | Query original order, verify account rights, periodic reconciliation |
| Administration | Tasks, billing, resources, roles, manual operations and audit |
| Notifications | Success/failure/action alerts independent of payment |
| Operations | Metrics, backups, recovery, certificates, logs and keys |

Example stack: TypeScript/Node.js, native pages or React/Vue, PostgreSQL/MySQL, Redis with a BullMQ-like queue, and optional Playwright. This is an optional combination, not a version-compatibility guarantee. A small MVP can use a database job table, but still needs leases and idempotency.

## 7. Suggested data model

- users/accounts: internal owner and upstream account references with minimal personal data.
- products: upstream mappings, period, currency and version, not just display names.
- redemption_codes: high-entropy code digest, product, state, bound order and expiry; reveal plaintext only during issuance.
- orders: local ID, owner/account/product, state, amount/currency, idempotency key and version.
- upstream_orders: provider references/IDs, sanitized request/response digests and last query time.
- payment_attempts: stable attempt ID, money, upstream reference, submission boundary and known/unknown outcome.
- tasks: stage, lease, worker, attempts, next execution and error classification.
- fulfillment_records: unique entitlement confirmation per order.
- ledger_entries: customer receipts, procurement cost and refunds/compensation. Use currency-aware integer minor units or fixed-point values, not casual floating-point arithmetic.
- webhook_events/outbox: event deduplication, restricted original payloads and processing state.
- audit_logs: actor, object, before/after, reason, timestamp and correlation IDs.

Enforce uniqueness for request idempotency, provider+order ID, fulfillment-per-order and provider+event ID. Claim codes through conditional updates/transactions. Do not aggregate different currencies directly. A customer refund does not automatically cancel an upstream subscription.

## 8. Browser worker design

Playwright BrowserContexts isolate cookies and local storage. Usually create a fresh context per job and close it in finally. Process restart frequency depends on isolation, memory and stability requirements. [Official isolation documentation](https://playwright.dev/docs/browser-contexts)

A browser process may be reused with bounded contexts, memory/page monitoring and idle recycling. Reuse still shares a crash domain and is not VM-level isolation. Separate processes/containers offer stronger separation at additional cost.

Never concurrently switch accounts in one persistent profile. Remove temporary authorization after tasks. Restrict diagnostic media, which can include identity/payment details, and set retention. Containers need matched browser/system dependencies and sufficient shared memory; otherwise Chromium can crash. [Docker documentation](https://playwright.dev/docs/docker)

Use stable, permitted network access. A proxy does not guarantee purchasing eligibility. Region/fingerprint/proxy changes are not universal fixes for bank or eligibility limits. Normal verification must remain a user action where required, represented as a waiting state.

## 9. Prerequisites before development

1. Define product, account identification, procurement channel, settlement currency, term, refunds and renewal rules.
2. Obtain authorized documentation, sandbox/test accounts, credentials, scopes, limits, query and idempotency contracts. Do not invent unsupported endpoints.
3. Choose a stack and install a supported runtime/package manager, Git, editor, database, optional Redis and Docker.
4. Separate API/database/worker development configuration. Keep secrets out of Git and use isolated test data.
5. Prepare metrics/logging, domain/certificates, backups, notifications and a human incident owner.
6. If login state is collected, establish necessity, authorization, minimum retention, revocation and breach response. Prefer scoped access rather than passwords/full Sessions by default.

A development machine with16GB RAM and20–40GB free SSD is a reasonable starting point for dependencies/images. API-only development can start at8GB. Running browsers and databases together reduces practical parallelism on smaller machines. A discrete GPU is not mandatory.

## 10. Implementation sequence and deliverables

1. Write business contracts/state diagrams: define success/failure/unknown and ownership of funds/rights. Deliver a state table and upstream capability matrix.
2. Prove a minimal adapter: read-only queries, then sandbox order/query. Demonstrate durable identity for one order with contract tests.
3. Build database/idempotent API: concurrent redemption must create one fulfillment target. Deliver transaction/concurrency tests.
4. Add queue/workers: simulate duplicates, lease expiry and restarts. Deliver recoverable execution.
5. Integrate sandbox payment/entitlement checks: cover timeouts, asynchronous results and paid-but-not-active. Do not replace tests with real charges.
6. Add operator reconciliation: only authorized actors release/retry/compensate, with reasons/audit.
7. Add progress/query UI backed by server states, without invented percentages or new orders on refresh.
8. Add security, alerts, backup restoration and load tests. Record exact versions/scenarios/results.
9. Start a single-instance rollout. After explicit authorization, run one controlled live acceptance purchase, reconcile it fully, then increase traffic.

Do not finish a large UI before discovering upstream cannot query orders. Do not increase browser concurrency before establishing payment idempotency.

## 11. Deployment topology and server sizing

Start with HTTPS edge → API → database/queue → worker. Keep database/Redis private and browser-debug ports inaccessible publicly. API/workers may share a host but should have separate processes/containers and resource budgets.

| Stage | Estimated starting budget | Notes |
| --- | --- | --- |
| Provider API trial | 2vCPU,4GB RAM,40–60GB SSD | One instance/light workers; provider limits dominate |
| Single browser trial | 2–4vCPU,4–8GB,60–100GB SSD | 4GB is tight; builds/inference add load |
| Small browser production | 4vCPU,8GB,100GB SSD | Start1–2 active jobs and benchmark |
| More browser capacity | 8vCPU,16GB,150GB SSD | Validate3–4 jobs first; not a fixed guarantee |
| Scaling | API nodes, independent DB/queue, worker fleet | Measure and implement distributed coordination first |

A10–20Mbps connection can be an initial planning estimate, but pages/images/media/downloads can change demand substantially. Measure actual latency/reachability. Budget transfer quotas, storage, backups and provider fees separately. Do not buy expensive GPUs before measuring.

Visitors are not active payment jobs. If tasks average four minutes and arrivals are one per minute, average in-flight work is roughly four jobs, before peaks/retries. Estimate RAM as base services+database+queue+worker baseline+concurrency×measured job peak+headroom. p95/p99 latency and peaks are more useful than averages alone.

## 12. Deployment software and configuration

- Supported Linux, for example Ubuntu24.04 x86_64; verify dependency/platform support at deployment time.
- Docker Engine/Compose or equivalent, fixed release images/dependencies and rollback identifiers.
- Nginx/Caddy, DNS and HTTPS; configure reverse proxy support for chosen SSE/WebSocket progress.
- Persistent MySQL/PostgreSQL and scoped DB users. Redis used as durable queue needs persistence/recovery, not disposable-cache assumptions.
- Environment: DB/queue connectivity, upstream credentials, encryption keys, domain/callbacks, timeout/capacity/retry policies, retention and alert destination.
- Minimal exposed ports and restricted administration. Inject/mount secrets, never bake them into images or log full configurations.
- Separate liveness/readiness; monitor workers through heartbeats/leases. Health probes must never create purchases.

Separate your customer-payment merchant configuration from third-party procurement. Your webhook secret verifies only its corresponding merchant events. Prefer hosted payment entry/tokenization over storing PAN/CVC. Encryption alone does not resolve payment-data storage requirements.

## 13. Deployment sequence from an empty host

1. Provision host/SSH keys, clock sync, updates and restricted management with console recovery.
2. Install runtime/containers; create persistence paths, restricted users and backup destination; keep customer submissions closed.
3. Deploy DB/queue, passwords, private networking, persistence and schema; verify connectivity/recovery.
4. Inject private configuration; deploy API/workers with capacity1; verify environment/accounts/timezone.
5. Configure DNS/HTTPS, origin, progress transport and own-merchant webhooks where applicable; test certificates/signatures.
6. Run sandbox end-to-end with disconnections, duplicate requests/events, worker exits, queue redelivery and temporary DB failure.
7. Ensure paid-but-unconfirmed/UNKNOWN never automatically releases codes or charges again, and restart follows original orders.
8. Restore backups in isolation with matching keys; configure alerts, operators and maintenance.
9. Authorize a specific live acceptance transaction, then reconcile customer receipt, procurement debit, entitlement, code and renewal.
10. Open limited traffic; monitor failures, UNKNOWN share, queue delay and resource peaks before increasing concurrency. Do not bypass coordination by copying instances.

## 14. Reliability, security and operational acceptance

Test same-code concurrency, multiple orders for one account, lost responses, at-least-once delivery, payment timeout, delayed entitlement, failed notifications, stale workers after lease expiry, restoration and wrong configuration/keys.

Invariants: no duplicate procurement for one fulfillment target; UNKNOWN is not safe failure; users access only their orders; billing/manual retries are audited; failures still clean up browser resources; restarts do not release another task's claim.

Monitor stage latency, queue backlog, upstream limits, uncertain payments, fulfillment success, RAM/CPU/OOM, browser pages, DB connections and backup age. Correlate order_id/task_id/attempt_id without logging full tokens/payment credentials.

Back up DB, release version, original keys and essential configuration together. Encrypt off-host copies and rehearse. Drain before updates, record previous release/snapshot and verify afterwards. Code rollback after schema changes may not be safe. Real payments cannot disappear just because a local snapshot is restored.

## 15. Decision checklist

Before building, answer: who grants entitlement; what interfaces are authorized; who receives customer money and pays upstream; how identity/activation is confirmed; how an order is recovered after timeout; whether idempotency exists; who reconciles; how renewal is authorized.

Resolve missing integration contracts before buying larger servers. A sound starting point is one API instance, durable storage, recoverable queue, a small worker pool and explicit UNKNOWN/reconciliation, scaling from measurements.

## References and applicability

Stripe references apply only where you have the relevant merchant permission, not as proof of access to another platform's payments. Playwright references explain isolation/container behavior. Other modules, sizing and build steps are engineering proposals, not official capacity guarantees.

- [Stripe payment fulfillment: do not rely solely on landing pages](https://docs.stripe.com/payments/existing-customers?platform=web&ui=stripe-hosted)
- [Playwright BrowserContext isolation](https://playwright.dev/docs/browser-contexts)
- [Playwright Docker requirements and shared memory](https://playwright.dev/docs/docker)
