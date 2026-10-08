# Generic relay delivery coordinator

Added 2026-10-01: `src/relay/deliverRelay.js` and the explicit
`schema/relay-delivery-v2.sql` extension. The current bot and legacy engine do not
import these files. No automatic schema application or production activation is
included. No game-specific fields or Campfire parsing are used.

## Why persist intent before sending

A lock can stop two callers from sending at once, but cannot atomically commit
both an external message and a database reference. Therefore a delivery attempt
is durably recorded before calling the transport. After a crash or uncertain
response, a started/uncertain attempt blocks automatic redelivery. This trades
automatic progress for avoiding blind duplicate creation; it is not exactly-once
delivery. Even an attempt which crashed just before sending requires reconciliation.

## API and locking

`deliverRelay(pool, request)` accepts scopeId, guildId, eventId, sourceMessageId,
payload, transport, and optional timeoutMs (1–30000, default 10000).
The Pool and transport are trusted application dependencies. No credentials,
environment files, Discord client, profiles or logs are loaded by the module.

The coordinator takes a session advisory lock keyed by the scope on a dedicated
connection. That lock spans intent COMMIT, transport execution and result COMMIT.
Reads are repeated after locking. New context/event writers must follow their
documented lock protocols; migration remains a separate stopped-writer operation.
The connection is destroyed on completion so session locks/settings cannot return
to the pool. This initial implementation prioritizes correctness over connection
reuse. Hash collisions can serialize unrelated scopes, not mix their data.

The stored scope must be active, belong to the supplied guild, and contain the
event. The destination is taken from storage, not from the request. New posts need
migration_ready=true; known delivered targets may be edited while migration is
blocked. Existing pending/uncertain rows are held. The caller still owns permission
checks, source validation, event identity resolution and role policy.

Attempts are unique per scope/event/sourceMessageId. That value must identify an
immutable source notification. Same-message edits with new content require a
separate revision-aware observation design; do not silently reuse that ID for
different delivery requests. Ordering of distinct out-of-order notifications is
not solved by this coordinator.

## Transport contract

The adapter supplies async send and edit methods receiving targetChannelId,
messageId (null for create), payload, notify=false and AbortSignal. It returns
`{ messageId }`. An edit must return the same message ID. Adapter code must enforce
silent notification behavior, including suppressing mentions in platform payloads;
the generic core does not rewrite arbitrary platform payloads. The current legacy
Discord adapter is not wired to this contract.

The coordinator waits at most timeoutMs for transport, aborts on timeout and
requests cancellation on connection loss. A transport which ignores cancellation
may still complete externally; the durable attempt continues to block retries.
No payload or raw exception is persisted or logged by this module.

After confirmed transport success, target mapping and attempt success commit
together. On uncertainty the attempt stays started or becomes uncertain. If an
acknowledgement is lost after a successful result COMMIT, the succeeded record is
not downgraded. A repeated notification then returns already_processed.

## Outcomes and explicit limits

- created / edited: external result and database mapping confirmed.
- already_processed: the source notification has a succeeded attempt.
- uncertain: external or commit outcome cannot safely be inferred. Do not resend.
- target_missing: trusted adapter explicitly confirmed a missing edit target.
- migration_blocked / invalid_scope / invalid_event: transport was not called.
- not_dispatched: failure before a confirmed intent commit and before transport.

Target-missing is not inferred from timeout, permissions or a generic transport
error. The adapter must map only its authoritative missing-message signal to
`error.kind = 'target_missing'`. This first coordinator holds such events for a
future explicit replacement flow; it does not automatically create a replacement.
Attempt history retains the previous target reference.

Uncertain results return an internal attemptId where known. Reconciliation and
replacement are intentionally separate operations requiring verified evidence;
they are not implemented here. No blind retry, automatic state clearing, or
operator-facing command is added. Runtime activation must wait for these flows
and adapter integration.

## Verification

Verified 2026-10-01: all 42 PostgreSQL checks and 80 offline tests passed. The
temporary PostgreSQL 18.6 server was stopped and its files removed. No production
database, bot runtime, command registration, push or deployment was changed.

The disposable PostgreSQL harness adds ten checks with simulated transport:
two concurrent notifications visibly wait on the scope lock and send once;
known targets are edited; guild/migration gates prevent dispatch; timeout,
send-success/save-failure, connection termination and uncertain intent COMMIT
prevent retries; lost result-COMMIT acknowledgement reconciles from the succeeded
record; missing targets are held; another destination receives its own delivery.

All transport calls in tests are synthetic. Connection termination targets only
the temporary local cluster. No real Discord message is sent, edited or deleted.

```powershell
node scripts/test-identity-postgres.cjs '<local PostgreSQL bin directory>'
```
