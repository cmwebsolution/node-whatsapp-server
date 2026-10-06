> Plan 3 deployment candidate: independent Linux VPS/container with dedicated MySQL. Laravel remains a separate application with its own MySQL. Historical Business-only constraints below are retained as investigation evidence, not the selected deployment target.

# Feasibility report — 6 October 2026

**Decision:** deploy Fastify/Baileys with encrypted MySQL authentication independently of Laravel on a Linux container host. See [Plan 3 readiness](readiness.md). **Requested completion gate: OPEN. 500-account capacity: NOT APPROVED.**

## Verified implementation evidence

| Area                                      | Evidence                                                                                                                                                    | Status                                        |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Runtime/stack                             | Node 24.21.0, Fastify 5.12.5, Baileys 6.7.24, mysql2 3.24.5, pino 9.14.0, qrcode 1.5.4                                                                      | Locked; build passes locally                  |
| Node validation                           | 25 Node tests plus two release-check tests; disposable MySQL 8.4.11, process crashes, storage/transport faults, encrypted restore                           | Passed locally                                |
| Durable authentication                    | AES-256-GCM, credential/buffer restoration, Signal-key deletion, stale-generation rejection                                                                 | Passed locally                                |
| Submission/capacity                       | Atomic key/slot reservation; immediate overload/Retry-After; per-account/global limits; crash/timeout recovery without resend                               | Synthetic tests passed                        |
| Journal/signing                           | Transaction rollback; concurrent writers; ordered pagination; revision/snapshot replay; retention; exact-byte HMAC                                          | MySQL tests passed                            |
| Laravel                                   | 57 tests / 335 assertions, using MySQL 8.4.11 and actual Fastify HTTP with synthetic WhatsApp transport                                                     | Passed locally                                |
| Reconciliation                            | Signature/nonce/time/key rotation checks; atomic dedup/cursor; interrupted repair; initial quiet-session snapshot; database lease; case-sensitive isolation | Passed locally                                |
| Dependency audit                          | npm audit: zero reported vulnerabilities                                                                                                                    | Checked 6 October 2026                        |
| CI/container                              | Node and Laravel workflows use MySQL 8.4.11; local Compose uses the same image                                                                              | CI/container execution pending                |
| Business database                         | MySQL-only requirement conflicts with Hostinger's documented included MariaDB engine                                                                        | Provider-compatible MySQL endpoint unresolved |
| Real WhatsApp pairing/restoration/receipt | No real account paired or message submitted                                                                                                                 | Pending                                       |
| Hostinger deployment/lifecycle/resources  | No hosting app/access supplied                                                                                                                              | Pending                                       |
| Encrypted backup restore + real reconnect | Encrypted row/key restoration tested locally; live reconnect not run                                                                                        | Pending                                       |

All database tests use isolated temporary databases. Existing user databases and HisabWala were not changed. The Fastify wire fixture uses real SQL storage and the reusable PHP client but replaces WhatsApp transport; it does not prove pairing or recipient delivery. Earlier MariaDB experiments are superseded by the user's MySQL-only decision and are not the chosen stack evidence.

## Public-source findings

- Hostinger documents Business managed Node apps and Node 24 selection. [Hosting options](https://www.hostinger.com/support/node-js-hosting-options-at-hostinger/), [runtime selection](https://www.hostinger.com/support/how-to-select-the-node-js-version-for-your-application/).
- Hostinger says its included Web/Cloud databases use MariaDB. This conflicts with the MySQL-only requirement even when hPanel calls them MySQL databases; confirm an actual MySQL endpoint reachable from Business hosting before closing feasibility. [Database engine](https://www.hostinger.com/support/1583226-which-database-management-system-is-used-at-hostinger/), [Node documentation](https://www.hostinger.com/support/hostinger-dashboard/node-js/).
- Deployment directories are overwritten; authentication must live outside them, here in SQL. [Deployment guide](https://www.hostinger.com/support/how-to-deploy-a-nodejs-website-in-hostinger/).
- Node 24 is LTS; Fastify 5 supports Node 20+ and publishes an LTS policy. [Node releases](https://nodejs.org/en/about/previous-releases), [Fastify migration](https://fastify.dev/docs/v5.10.x/Guides/Migration-Guide-V5/), [Fastify maintenance](https://github.com/fastify/fastify/blob/main/docs/Reference/LTS.md).
- Baileys publishes stable 6.7.24 and 7.0 release candidates. Its authentication helper recommends a proper SQL/NoSQL adapter for production. [Releases](https://github.com/WhiskeySockets/Baileys/releases), [upstream authentication helper](https://github.com/WhiskeySockets/Baileys/blob/master/src/Utils/use-multi-file-auth-state.ts).

MySQL 8.4 is an LTS line: [MySQL release policy](https://dev.mysql.com/doc/refman/8.4/en/mysql-releases.html). These sources establish availability/maintenance activity, not guaranteed Business resources, Baileys support SLA, or the real-account completion gate. The stable Baileys line remains pinned until an explicitly reviewed upgrade; production updates require repeating the real pairing/restart/send checks.

## Workload and unresolved risks

Agreed target: 500 connected accounts, one send/account/minute average, 50 simultaneous requests, and PDF/PNG up to 8 MiB. Execution defaults: one active send/account, 10 global database dispatch slots, 50 request admission, 10 database connections. The old 100-session validation cap and browser-per-account architecture have been removed.

The selected Linux host's connection, process, memory and lifecycle limits remain unmeasured. Independent Node hosting was authorized by the user; a specific host has not been selected or validated. Attachment-heavy bursts and reconnection storms need separate hosted tests. Incoming WhatsApp traffic and protocol state can add unmeasured load beyond outbound frequency.

Baileys is unofficial. Protocol changes, revoked devices, account restrictions, and upstream maintenance can interrupt service independently of application correctness. npm's zero-advisory result does not establish protocol stability or eliminate all supply-chain risk; libsignal is a pinned Git dependency.

Submission idempotency prevents repeat dispatch while records exist. WhatsApp delivery is not an atomic database operation. Crash, database failure, lease takeover and restored-old backups can leave uncertainty; no automatic retry is allowed. Horizontal routing is out of scope. The hosted prototype must verify lease timing under managed-process replacement.

## Remaining gate evidence

Record exact hosted versions and database engine; provider answers listed in `production.md`; sanitized pairing and restart/redeploy/crash timestamps; receipt of text/PDF/PNG after restart; overlapping-owner and database-failure results; backup/key recovery; staged capacity/24-hour soak measurements. Keep this report's gates open until those results exist.

## Local synthetic measurements

Six-second smoke samples on the developer workstation with a fake 20 ms transport and 500 synthetic session objects. The burst contains 50 distinct account requests. With immediate backpressure some requests are intentionally rejected; the Laravel/application scheduler owns their retry policy.

| Storage/payload   | Requests | Submitted | Rejected | Request p95 | Peak RSS | Event-loop p99 |
| ----------------- | -------- | --------- | -------- | ----------- | -------- | -------------- |
| Memory/text       | 50       | 10        | 40       | 23 ms       | 134 MiB  | 21 ms          |
| MySQL 8.4.11/text | 50       | 17        | 33       | 86 ms       | 148 MiB  | 22 ms          |
| Memory/8 MiB PDF  | 50       | 10        | 40       | 798 ms      | 650 MiB  | 37 ms          |

SQL startup for the 500 fake session objects took 821 ms. The SQL burst can submit more than ten in total because some slots complete while later requests acquire the database control lock; active execution remains bounded at ten. Request percentiles include rejections and are not recipient-delivery latency. The attachment sample measures service/hash/base64 overhead, not actual network upload or PDF receipt; sustained attachment-heavy SQL/hosting validation remains pending.

These replace the earlier waiting-loop samples. They do not establish sustained 500 sends/minute or 500 real-account capacity. At this average rate the ten slots require mean active send time below roughly 1.2 seconds to avoid a growing Laravel backlog. Representative WhatsApp/Business measurements must establish achievable throughput, connection memory, journal/database pressure and reconnect-storm behavior separately.
