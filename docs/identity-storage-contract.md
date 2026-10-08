# Identity storage contract and offline migration plan

Implemented 2026-09-30. This step adds a schema proposal and a pure migration
planner. No PostgreSQL connection, DDL execution, data import or runtime wiring is
included. The existing bot and local changes are preserved.

## Schema boundary

`schema/relay-identity-v2.sql` proposes an isolated `relay_identity_v2` schema with
five tables. It is not loaded by initDb. It deliberately fails if the schema
already exists, rather than silently accepting incompatible existing objects.

| Table | Identity and protection |
| --- | --- |
| scopes | One row per legacy config ID and destination; stored guild/source/destination metadata; archived/active state; migration_ready defaults to false. |
| events | Composite scope/event primary key; references its scope. |
| aliases | Unique scope/type/value; composite event reference; at most one stable meetup ID per event. URL aliases are not globally unique. |
| deliveries | One row per scoped event; unique destination/message reference; destination must match the scope; delivered requires a message ID. |
| imports | Unique hashed legacy provenance and immutable snapshot hash pointing to a scoped event. Used to recognize repeats without overwriting newer state. |

No delete cascades are defined. Config ID is retained as historical metadata,
without an FK to the mutable legacy relay_configs table, so deletion of an old
configuration cannot erase delivery history. A later config writer must archive
scopes on removal and use a new scope for a different config ID or target. The
planner detects visible conflicts, but cannot reconstruct lost configuration
history which left no evidence in the supplied snapshots.

Role storage, source-observation persistence, send intents, previous-message
history, permission validation and delivery recovery are not in this initial
storage contract. Do not connect this schema alone to webhook sending. URL validity
and immutable identity ownership require application checks as well as constraints.
The schema uses [PostgreSQL composite unique and foreign-key constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)
for scope isolation. The SQL was subsequently verified against a temporary local
PostgreSQL 18.6 cluster: see [database verification](identity-postgres-verification.md).
The JavaScript unit tests below are separate from those database checks.

## Offline API

```javascript
const { planIdentityMigration } = require('../src/identity/planIdentityMigration');
const result = planIdentityMigration(legacySnapshot, existingV2Snapshot);
```

The legacy snapshot is the same version 1 format accepted by migrationDryRun. The
complete existing-state snapshot must explicitly contain version 2 and arrays
`scopes`, `events`, `aliases`, `deliveries`, `imports`. Use the snake_case columns
in the proposed SQL, including explicit scope state and migration_ready. Omitted
arrays are an error, not an empty database. PostgreSQL integer config IDs must be
JSON numbers. Incomplete but structurally valid exports cannot be detected here.

An optional third argument supplies the same trusted URL policy used by the pure
identity module. The default does not recognize legacy URL keys. The opt-in
campfireUrlPolicy may classify supported direct meetup URLs, retaining their URL
alias as well as the stable meetup-ID alias. Unknown short URLs still require
evidence and stay unresolved.

The API validates duplicate keys, missing references, destination mismatches and
malformed state before planning. Invalid state throws a fixed TypeError without
printing row values. It does not mutate either snapshot or invoke any I/O.

## Planning rules

- Unresolved legacy rows or blocked scopes yield an empty blocked plan. This
  first implementation intentionally does not attempt a partial import.
- Clean new mappings propose inserts only, preserving the old target/source
  message references. Multiple events in a config/destination reuse a scope.
- Existing equivalent scopes may have arbitrary IDs; the planner reuses them.
  Changed guild/source metadata, archived scopes and occupied target references
  require review instead of an overwrite.
- Matching stable alias plus an already delivered identical target permits
  adding provenance only. Newer source metadata is left untouched. A verified
  legacy URL alias may also be added if absent and not owned by another event.
- Pending, uncertain, missing or different existing deliveries are not repaired
  automatically. Existing URL aliases without a consistent stable alias are not
  merged by inference.
- The same provenance and snapshot hash returns already_imported, even if the
  live delivery subsequently changed or the scope was archived. No stale legacy
  target is restored. Conflicting provenance or alias ownership stops the plan.
- If any candidate conflicts, all operations are discarded. Row statuses can
  still show tentative decisions, but only operations represents the complete
  proposed insert set, and it is empty on a blocked plan.

Result status is `planned` or `blocked`. `operations` contains the five insert
arrays in dependency order, plus per-row decisions and the sanitized legacy
report outside that object. The API returns internal identifiers and references;
do not dump the whole result to a public log. There is no new CLI or automatic
execution path. `activationApproved` is always false.

Valid-shaped legacy role contexts are counted in contextReviewCount but never
copied into operations. They need explicit ownership/provenance validation before
activation. The identity-only planner cannot approve a complete migration.

## Future database application

A future writer must re-read both snapshots and re-plan in a transaction while
old writers are stopped and the required scope locks are held. Do not apply a
saved JSON plan against changed live state. Use parameterized inserts, foreign
keys and unique constraints; never ON CONFLICT DO UPDATE to force a plan through.
The import ledger and all corresponding identity rows must commit atomically.
Backups, restore rehearsal and post-write rollback strategy remain prerequisites.

Repeated offline planning, transaction rollback on a forced SQL failure, actual
constraint rejection and two-connection unique-index contention have now been
tested in a temporary local PostgreSQL cluster. Process termination during import
and the production transactional writer are not yet tested or implemented.
The next bounded step is that writer, with local database tests; this does not
authorize production migration or runtime activation.

## Validation in this step

15 isolated tests cover preserved references, repeat planning after newer live
changes, provenance conflicts, adoption without overwrites, uncertain deliveries,
target ownership, destination isolation, recreated configs, archived scopes,
all-or-nothing conflict handling, withheld roles, incomplete/malformed snapshots,
URL alias conflicts and existing arbitrary scope IDs.

```powershell
node --test test/planIdentityMigration.test.cjs
```
