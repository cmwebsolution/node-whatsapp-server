# Production API contract

## Identity and connection lifecycle

All `/api/*` routes require `Authorization: Bearer <application-token>` and `X-WhatsApp-App-Id`. The token must belong to the supplied app. Laravel alone authorizes the signed-in user, tenant, business record and recipient. Sender IDs never come from untrusted browser input.

Sessions are isolated by app ID and opaque UTF-8 user ID (1–256 bytes). Encode user IDs as path segments. Application tokens are separate; equal user IDs in different apps remain isolated. Application credential digests are loaded at startup; restart after provisioning or credential rotation.

| Method | Route                                       | Request                                                                                                                          |
| ------ | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/health`                                   | Unauthenticated process probe                                                                                                    |
| GET    | `/ready`                                    | Unauthenticated database/service probe                                                                                           |
| POST   | `/api/whatsapp/connect`                     | `{"user_id":"123"}`                                                                                                              |
| GET    | `/api/whatsapp/{user_id}/status`            | None                                                                                                                             |
| GET    | `/api/whatsapp/{user_id}/qr`                | None                                                                                                                             |
| POST   | `/api/whatsapp/{user_id}/disconnect`        | None                                                                                                                             |
| POST   | `/api/whatsapp/{user_id}/send-message`      | `{"phone":"919876543210","message":"Hello"}`                                                                                     |
| POST   | `/api/whatsapp/{user_id}/send-media`        | `{"phone":"919876543210","media":{"mimetype":"application/pdf","data":"<canonical base64>","filename":"bill.pdf","caption":""}}` |
| GET    | `/api/whatsapp/{user_id}/submissions/{key}` | Submission lookup                                                                                                                |

Connection responses retain `success`, `status`, `phone`, and these states:

- `disconnected`: no enabled session, explicit logout, or terminal authentication failure.
- `connecting`: connection attempt, restart restoration, network reconnection, or awaiting expired-owner takeover.
- `qr_required`: pairing is required. QR retrieval is explicit and returns a PNG data URI and UTC `expires_at`.
- `connected`: authentication writes have completed and the socket opened. Only this state reports a linked phone.

Pair using QR, not a phone-number pairing code. Poll quietly every five seconds while linking; discard QR on expiry or leaving the page. QR is capped at 45 seconds and invalidated on connection/socket replacement. Connect initiates background work and returns promptly. A connection attempt has a 30-second timeout. Reconnection uses exponential backoff with jitter capped at 60 seconds; restoration is staggered by 100 ms/account. No message is automatically resent during restoration.

One managed application process is the supported deployment shape. Database leases prevent concurrent socket ownership during replacement; they do not make the service a horizontally routed cluster. Renew every 10 seconds, expire after 30, and close socket activity if renewal fails. A local watchdog stops an owner before its last known lease deadline. Authentication, status and submission mutations check owner/generation under a database row lock. During overlap, the new process can report status, but cannot send or expose another owner's QR until ownership transfers.

Graceful shutdown closes without logout, preserving authentication. Explicit disconnect logs out and deletes encrypted authentication. If remote logout fails, disconnect is not acknowledged as successful. Terminal replaced/bad/mismatched sessions require pairing again. Old Chromium profiles are preserved on disk but never imported or used.

## Submission semantics

Both send routes require `Idempotency-Key`: 1–128 ASCII letters, digits, underscores or hyphens. A persisted UUID is recommended. Scope is app/user/key. Node hashes the normalized payload, atomically reserves the key, and records dispatch before calling Baileys. Media field order and unrelated properties do not affect the hash.

A response is `{"success":true,"state":"submitted","message_id":"..."}`. Submission lookup and duplicate requests use the same shape:

| State       | Meaning                                                | Action                                                            |
| ----------- | ------------------------------------------------------ | ----------------------------------------------------------------- |
| `pending`   | Reserved or currently executing                        | Look up later; do not create another key                          |
| `submitted` | Client completed submission                            | Record the result; recipient delivery is separate                 |
| `failed`    | No dispatch occurred                                   | Review the cause; a new send intent requires an explicit decision |
| `unknown`   | Dispatch occurred but completion cannot be established | Check WhatsApp; never automatically resend                        |

`success:true` means the submission record was handled; Laravel must inspect `state`. A submitted result without a client ID uses `message_id:null` and `confirmation:"client_completed"`. Pending/failed/unknown use `message_id:null`. A changed payload with an existing key returns HTTP 409 `IDEMPOTENCY_CONFLICT`. Matching repeats never dispatch again, including after process restart. Before dispatch, invalid input, disconnected sessions, concurrency and admission failures can return an error without a submission record.

An HTTP timeout does not cancel WhatsApp submission or establish failure. Capacity is reserved in the same transaction as the submission and marked dispatched conservatively before socket invocation. A crash after reservation is recovered as unknown, even if the socket call might not have started. Database failure during acknowledgement also yields unknown. This is repeat-dispatch protection, not an exactly-once recipient guarantee.

Records remain at least seven days from creation; terminal records are cleaned periodically. Laravel must prevent replaying old intents after that period. The service stores payload hashes and result metadata, not message bodies or media attachments.

## Limits and errors

- Target workload: 500 connections, 500 sends/minute average, 50 concurrent send requests. These are validation targets, not production capacity approval.
- Admission: 50 concurrent send requests per process, including body parsing. Execution: one active send per account; a second distinct request gets `SEND_IN_PROGRESS`. Database execution semaphore: 10 active dispatches globally. Capacity is rejected immediately, with no wait loop or durable message queue. Accepted requests have a 30-second service deadline, including storage and dispatch.
- Timed-out socket work is closed before allowing fresh account work. Database connect/query/acquisition operations are bounded at five seconds; deadline replies do not wait for database cleanup. Laravel keeps a 40-second timeout.
- Application request rate: 2,000/minute/process. This replaces the prior 120/minute limit to accommodate the agreed send workload. Health/readiness are outside that limit.
- Text: international 7–15 digits, nonblank text, at most 4,096 Unicode code points. Captions: 1,024 code points.
- PDF/PNG: canonical base64, safe filename, matching signature/extension, at most 8 MiB decoded; PNG dimensions at most 16 million pixels. These are basic signature/dimension checks, not antivirus scanning or complete file parsing.
- Ordinary JSON: 24 KiB; authenticated media JSON: 12 MiB. All responses use `Cache-Control: no-store`.

Errors return `{"success":false,"code":"...","message":"..."}`. Supported codes include 401 `UNAUTHENTICATED`, 403 `FORBIDDEN`, 404 `NOT_FOUND`, 409 `NOT_CONNECTED`/`SEND_IN_PROGRESS`/`QR_EXPIRED`/`IDEMPOTENCY_CONFLICT`, 422 `INVALID_INPUT`, 429 `RATE_LIMITED`, and 503 `CAPACITY_EXCEEDED`/`SERVICE_UNAVAILABLE`/`LEASE_LOST`. Underlying database/WhatsApp errors, QR payloads, application tokens, recipients and message bodies are not logged.

Runtime metrics emit every minute: memory, CPU, event-loop p99, owned session/request counts, cumulative submission counts/timing, database lease/pending/dispatch counts, and pool limit. Restrict access to runtime logs. `/ready` does not assert that all accounts are connected.

## Signed polling and reconciliation

MySQL 8.4 LTS with InnoDB is the database target. Migration and readiness reject a MariaDB engine; the provider's UI label does not establish the actual engine. Ownership is application/user across tenants. Laravel must authorize the current tenant's business operation; no tenant discriminator is added to Node session ownership.

`GET /api/whatsapp/events?after=0&limit=100` requires the existing bearer/application headers and a fresh `X-WhatsApp-Nonce` (32–64 lowercase hex characters). Response fields are `success`, `events`, `next_cursor` (decimal string), and `has_more`. Events carry UUID `id`, application-scoped decimal `sequence`, `application_id`, opaque `user_id`, `type`, decimal `revision`, UTC `occurred_at`, and `payload`. Connection payloads contain `status`/linked `phone`; submission payloads contain `idempotency_key`, `state`, `message_id`, and optional `confirmation`. No recipient, content, attachment, QR, credential or Signal key is journaled. Recipient delivery/read receipts are outside this interface.

State/revision changes and journal insertion commit atomically. Ownership acquisition/restoration, owner release/expiry and logout advance the connection revision even when the public state remains unchanged. Application stream writers take an exclusive row lock before sequence allocation, so a feed cursor cannot skip an earlier uncommitted event. Revisions and cursors are decimal strings in the interoperable signed 64-bit range. Cleanup removes a contiguous seven-day prefix; a cursor below that retained floor returns signed HTTP 410 `EVENT_CURSOR_EXPIRED`. A cursor equal to the floor remains usable. Replay requests use the same stable event IDs and revisions.

`GET /api/whatsapp/snapshots?after=&limit=100` returns `sessions` (`user_id`, `status`, `phone`, `revision`), starting `cursor` and `next_after`. Pass the returned `cursor` unchanged on every subsequent snapshot page; `after` is the opaque 64-character session pagination token. Scan connections, look up locally pending/uncertain intents, then replay events after the starting cursor. New sessions or status changes during the scan are covered by the replay. Revision comparison prevents older snapshots/events overwriting newer observations. An expired snapshot cursor restarts the scan. Status and submission responses also expose entity revisions.

Feed, snapshot and nonce-bearing submission-lookup responses (including 404/410) carry `X-WhatsApp-Key-Id`, `X-WhatsApp-Nonce`, `X-WhatsApp-Timestamp`, and `X-WhatsApp-Signature`. Signature is lowercase hex HMAC-SHA256 over `application_id + "\n" + nonce + "\n" + unix_timestamp_seconds + "\n" + exact_UTF8_response_bytes`. The versioned 32-byte signing key is separate from bearer and encryption keys. Laravel verifies key, nonce, ±300-second timestamp and exact bytes before parsing/persisting. HTTPS is still required. Nonces prevent response reuse across polling requests; clocks must be synchronized.

Capacity errors return `Retry-After`, `retry_after` and `retry_safe:true` only for known pre-dispatch admission/execution rejection. This proves this attempt did not dispatch; it does not resolve an earlier uncertain attempt. Matching existing keys return their existing result before fresh capacity acquisition. Rejected fresh attempts create no submission record or event. Laravel stores a deferred intent and its scheduler decides whether/when to retry that same intent.

Laravel retains minimal intent records beyond Node's seven days. Created/deferred are local states; Node states remain pending/submitted/failed/unknown. A transport failure marks the local intent unknown and requires lookup. Missing Node records never authorize resubmission. `whatsapp:reconcile` uses a database lease, at most 20 event pages and a 55-second network/work budget; interrupted repair retains cursor and page progress. Database query/lock timeouts in the consuming application must fit this budget. Deduplication, newer revisions and cursor advancement commit together; package domain events dispatch after commit. Domain notifications are best-effort after commit; applications needing durable downstream jobs should reconcile stored snapshots and maintain their own business queue/outbox.

Production runtime defaults to one pilot session (`MAX_SESSIONS=1`); approved real-account capacity remains zero until hosted gates pass. Connection concurrency defaults to five; media admission/execution limits are four/two. See [deployment configuration](deployment.md) and [readiness evidence](readiness.md).
