# Production readiness — 6 October 2026

The lightweight service and separate Laravel package are implemented and locally verified. The deployment candidate is an independent Linux container host with dedicated MySQL 8.4; Laravel retains its own MySQL database and business queues. No external host has been provisioned or tested. **Approved real-account production capacity: zero. Pilot configuration: one session. Production release gate: open.**

## Implemented operating controls

The service bounds connection attempts to five, media body admission to four, and media execution to two. Existing limits remain 50 requests, 10 global sends, one send/account and a 30-second submission deadline. Capacity is rejected before dispatch with retry metadata; Node has no durable message scheduler. Reconnection uses bounded backoff and staggered restoration; lease loss stops socket work. Shutdown flushes/closes sockets before releasing ownership, with bounded parallel lease release.

Private mounted secret files are supported. Metrics use fixed-memory histograms and record process memory/CPU, event-loop delay, API/send latency, connection attempts, pool acquisition/query timing, SQL failures and database storage estimates. Backups stream transactional SQL through AES-256-GCM, authenticate completely before isolated restoration, and require independently recovered backup and auth master keys.

Deployment artifacts include a non-root health-checked image, private MySQL volume/network, restart policy, immutable-image configuration, explicit resource allocations, HTTPS reverse-proxy example, release-evidence checker, and operator rollout/rollback/restore procedures. Docker is unavailable locally: image build, Compose validation and runtime deployment remain unverified here; CI contains the image build gate.

## Local verification

- Node 24.21.0; Fastify 5.12.5; Baileys 6.7.24; mysql2 3.24.5; native isolated MySQL 8.4.11. Locked dependency resolutions are unchanged from the previously recorded zero-vulnerability audit.
- 25 Node tests passed without skips, including SQL transactions, isolation, idempotency, signed journal, stale ownership, admission/deadlines, media validation, credential/key persistence, graceful restart, actual process kill, TCP transport outage, database network outage, and encrypted backup tamper/restore checks.
- Two release-check tests passed; incomplete evidence fails closed.
- Separate Laravel package: 57 tests, 335 assertions, using MySQL and the actual Fastify HTTP interface with synthetic WhatsApp transport.
- Final fault run: crash recovery 30,477 ms; transport recovery 815 ms; storage recovery 50,123 ms. Five total dispatches; neither interrupted intent dispatched again. Recovery varies with lease expiry and the 30-second maintenance sweep.
- Build, formatting and whitespace checks passed. Local tests do not establish real WhatsApp recipient delivery or provider lifecycle behavior.

## Synthetic load evidence

These tests use real HTTP/MySQL and synthetic transport. RSS/CPU includes the load client in the service process. Stages were run on a local development machine; some short stages overlapped other isolated fixtures on the same MySQL engine. Server-wide database counts can therefore include other fixtures. There is no Laravel retry queue in this harness. Rejections are immediate capacity responses, not completed sends.

| Synthetic sessions | Duration | Offered | Submitted | Capacity rejected | Peak combined RSS | Event-loop p99 |
| ------------------ | -------- | ------- | --------- | ----------------- | ----------------- | -------------- |
| 1                  | 12s      | 100     | 100       | 0                 | 166 MiB           | 22 ms          |
| 10                 | 12s      | 100     | 100       | 0                 | 178 MiB           | 22 ms          |
| 50                 | 12s      | 100     | 42        | 58                | 225 MiB           | 22 ms          |
| 100                | 12s      | 100     | 42        | 58                | 189 MiB           | 21 ms          |
| 250                | 300s     | 2,500   | 825       | 1,675             | 254 MiB           | 22 ms          |
| 500                | 300s     | 2,500   | 855       | 1,645             | 265 MiB           | 22 ms          |
| 500                | 60s      | 500     | 178       | 322               | 232 MiB           | 23 ms          |
| 10; PDF 8 MiB      | 60s      | 500     | 100       | 400               | 1,037 MiB         | 176 ms         |

The 500-session minute had API p95 at most 500 ms and SQL pool-wait p95 at most 25 ms (histogram bucket upper bounds). Heavy media had API p95 at most 250 ms but client-observed p95 at most 500 ms, with substantially higher combined memory and event-loop delay. These are overhead observations, not sizing recommendations.

**The agreed throughput has not been proved.** Offering 500 requests/minute in bursts produces capacity deferrals; Laravel must retain and schedule those same intents. Representative testing must measure completed sends/minute, intent backlog/drain time, real socket resources, realistic send latency and reconnect storms with a separate load generator. The full 8-MiB attachment workload remains unapproved. A five-minute synthetic run cannot replace 24-hour representative hosted operation.

## Open gates and risks

| Gate                                                                     | Status                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------ |
| Local exact stack/MySQL/auth restoration                                 | Passed with synthetic transport                  |
| Process/storage/network fault recovery without uncertain replay          | Passed locally                                   |
| Encrypted backup restoration and separate key recovery                   | Passed locally; hosted recovery time/RPO pending |
| Container build/start and private secret permissions                     | CI/target-host verification pending              |
| Hosted deployment overlap and reproducible rollback                      | Pending                                          |
| Consenting account pairing and restart/redeployment without rescan       | Pending                                          |
| Recipient receipt of text, PDF and PNG after restart                     | Pending                                          |
| 500 real sessions, 500 completed sends/minute, attachment-heavy capacity | Not approved                                     |
| 24-hour representative sustained run and supported limit                 | Pending                                          |

Host resource allocations, WSS policy, network/HTTP limits, storage performance and backup operations need actual target-host evidence. Baileys remains an unofficial client with upstream/protocol and account-restriction risks; successful submission does not mean recipient delivery. Ambiguous sends remain unknown and require reconciliation rather than replay. A restored backup can omit later submissions, so retained Laravel intents must be reconciled before dispatch resumes.

Use [deployment instructions](deployment.md), [operator checklist](operator-checklist.md), and `deploy/release-gate.example.json`. The release checker validates attestation completeness, not evidence authenticity. Close live feasibility and supported-capacity gates only from the corresponding hosted evidence.

Sanitized raw measurements and source/dependency fingerprints: [Plan 3 local evidence](evidence/plan3-local.json). The five-minute 500-session run completed 855 synthetic sends (171/minute), with 1,645 immediate capacity deferrals; API p95 was at most 250 ms and SQL pool-wait p95 at most 50 ms.
