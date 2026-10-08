# Generic delivery reconciliation and replacement

Added 2026-10-01 as `src/relay/recoverRelay.js` with the explicit
`schema/relay-recovery-v2.sql` extension. This is internal adapter-facing code,
not a Discord command, runtime activation or automatic database migration.
No game-specific logic is included.

## Why reconciliation is separate

A missing acknowledgement does not prove a missing message. Reconciliation asks
a trusted adapter to verify the exact attempt and destination before adopting a
message reference. It never matches on title, creator, time or similar content.
Replacement is a separate, explicit action for an authoritatively missing edit
target. An unsuccessful search for an uncertain create/replace does not authorize
another send.

The delivery transport receives attemptId, scopeId, eventId and sourceMessageId
in addition to its previous fields. `createDiscordEvidence` now supplies a
generic Discord marker and bounded history search for positive attempt proof. It
verifies bot authorship, channel, operation and the exact marker. A partial or
empty search remains inconclusive. This strategy is implemented but is not yet
wired into the running bot.

## API and evidence contract

`recoverRelay(pool, request)` requires scopeId, guildId, eventId, attemptId,
action (`reconcile` or `replace`), a trusted transport, and optional timeoutMs
(1–30000, default 10000). Replacement also uses payload and transport.send.
The transport's inspect method receives stored destination, previous target,
operation, source notification and attempt identity, plus AbortSignal.

A confirmed proof must contain matching scopeId, eventId, attemptId and
targetChannelId, a messageId and nonempty evidenceRef. The adapter must verify that
the particular operation completed on that message. For edits, mere existence of
the old post is insufficient: the adapter must prove the requested update was
applied. The generic core checks binding consistency, not cryptographic provenance.
Never construct this proof directly from untrusted message input or an unverified
user-supplied message ID.

A missing proof must authoritatively identify the stored previous message of an
edit attempt. Timeouts, access failures, partial history/search results or absent
correlation markers are inconclusive. Other results keep the attempt unresolved.
The API has no force-clear or blind-retry option.

## Database behavior

Recovery uses the same session-scoped advisory lock as delivery. Scope/guild/state
are validated before inspection and checked again under a row lock before writes.
The target mapping must still match the attempt's previous target. Confirmation
atomically saves the message mapping, succeeds the attempt and records evidenceRef.
Target ownership conflicts roll back and leave the hold intact.

For explicit replacement after missing proof, one transaction marks the old edit
attempt superseded, adds a linked replace attempt, and marks delivery pending.
The old message ID and evidence reference remain in history. Only after that
intent commits does the trusted transport receive a silent replacement send.
Result mapping and success commit together. The send must return a new message ID.

The schema permits one attempt per scope/event/source/operation and one replacement
per superseded attempt. The parent FK includes scope and event; a replacement
cannot point across events. The existing unique unresolved-attempt index remains.
The delivery reader now treats superseded as terminal but always checks for an
unresolved replacement before deduplicating the source notification.

Repeated requests on a superseded attempt return replacementAttemptId, allowing
the caller to inspect the replacement rather than initiate another send. Uncertain
replacement outcomes block delivery and can themselves be reconciled with proof.
A lost success-COMMIT response is reported as uncertain without downgrading a
succeeded record. An already-resolved attempt does not call the transport again.

Transport calls have bounded waits and request cancellation. Inspect and send each
have their own timeout budget. A cancelled transport can still complete externally
if it ignores AbortSignal; durable attempts therefore remain held until verified.
Connections are destroyed after use to release session locks. Payloads and raw
exceptions are not logged; evidence references should be minimal operational
identifiers, not credentials or profile dumps.

## Verification scope

Verified 2026-10-01: all 50 PostgreSQL checks and 80 offline tests passed.
The temporary PostgreSQL 18.6 cluster listened only on loopback, was stopped,
and its temporary files were removed. No production database or bot was used.

Eight additional local PostgreSQL checks cover:

- Confirmed uncertain send adopted without redelivery and repeated reconciliation.
- Inconclusive evidence, wrong scope, permission failure and absent uncertain create.
- Concurrent replacements producing one send with preserved parent history.
- Subsequent normal delivery editing the replacement target.
- Failed result storage after replacement, held retries and later reconciliation.
- Conflicting target ownership rolling back reconciliation.
- Inspection timeout preserving the hold.
- Lost reconciliation-COMMIT response preserving the succeeded record.

The transport and evidence provider in tests are synthetic. The SQL is executed
only in a new, temporary local cluster managed by the existing harness. No Discord
post is inspected, sent, edited or deleted by these tests.

Remaining before runtime activation: a real adapter implementing evidence and
silent sends, source-observation revisions/order, role-context migration,
operator permission checks and a concrete rollout/recovery procedure. This work
does not establish exactly-once external delivery or authorize production use.
