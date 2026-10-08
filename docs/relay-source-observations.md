# Ordered source observations

Added 2026-10-02: `src/relay/planSourceObservation.js`, the explicit
`schema/relay-source-observation-v2.sql` extension, and the revised internal
`deliverRelay` contract. This is not runtime activation, a Discord command, or
an automatic migration. It contains no provider or game-specific behavior.

## Why ordering is durable

Source delivery order cannot be inferred safely from arrival order or a platform
timestamp. A trusted source adapter supplies an event-local, monotonic integer
`sourceRevision`, an immutable `sourceMessageId`, and a lowercase SHA-256
`sourceFingerprint` of its canonical normalized observation. The adapter must
increment revisions whenever a newer source state should replace an older state.
Gaps are allowed; reused revisions are not.

The relay persists the accepted source observation in the same transaction as
the durable send/edit intent. An older revision returns `stale_observation` and
never reaches transport. The same revision only repeats when both message ID and
fingerprint match; otherwise it returns `conflicting_observation`. No raw
payload is stored by this extension.

An exact retry returns `already_processed` after success, or the normal held
uncertain/target-missing status. An unresolved newest observation still blocks
subsequent delivery, since skipping past it could silently discard a change.

## Compatibility and recovery

This extension leaves imported legacy delivery rows without a source revision.
The revised delivery API requires all three source-observation fields for new
work. Replacement copies the parent observation identity, so reconciliation
does not invent a later source revision. Source observation rows have compound
scope/event keys and point to the associated attempt.

## Verification

Four local PostgreSQL checks cover stale updates never calling transport,
same-revision conflicts, exact-repeat idempotence, newest-before-late-middle
ordering, and storage only of accepted observations. Four pure offline tests
cover validation and comparison decisions. Tests use only synthetic data and a
temporary loopback PostgreSQL cluster; no Discord or production system is used.

Before activation, a real adapter must define its canonical fingerprint and
monotonic revision source, plus persist/recover that cursor across restarts.
