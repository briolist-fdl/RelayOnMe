# Transactional identity migration writer

Implemented 2026-09-30 in `src/identity/applyIdentityMigration.js`. This is an
explicit maintenance API, not a bot startup migration or a production command.
Importing it does not connect to a database. It accepts an already configured
pg Pool and does not load dotenv, credentials, a connection URL, or Discord code.

## Why a separate writer

A valid offline plan can become stale before execution. The writer therefore
does not accept precomputed operations. It takes locks, reads current legacy and
v2 rows, runs the existing planner, and inserts the resulting rows in one database
transaction. Identity, delivery references and provenance must commit together.

The caller must provide `expectedDatabase` and `writersStopped: true`. The database
name is verified before taking the migration locks. The stopped-writer flag is a
caller assertion, not proof that a bot is stopped. Stop and drain old webhook
writers before production use: database locks cannot undo a webhook already sent.
There is deliberately no CLI, automatic schema creation, or runtime import.

## Locking and writes

- Uses one checked-out connection and a READ COMMITTED transaction.
- Takes a transaction-scoped advisory lock for the migration, then SHARE ROW
  EXCLUSIVE locks on all three legacy tables and all five v2 tables in fixed order.
  This is a maintenance operation which blocks table writes, not a per-event
  runtime delivery protocol. It also protects against writers which do not use
  the advisory lock. Snapshots are read only after the locks are held.
- Reads only required columns from the explicit public and relay_identity_v2
  schemas. Uses fixed table/column names and parameterized row values.
- Replans and returns blocked after rollback if current state conflicts or legacy
  identity is unresolved. It never forces an upsert or repairs mappings by guessing.
- Inserts scopes, events, aliases, deliveries and imports in dependency order.
  Any error before COMMIT leads to rollback; newer existing rows are not overwritten.
- Sets local statement, lock and idle-transaction timeouts. Caller pool acquisition
  and connection timeouts remain the responsibility of the supplied Pool.
- Releases transaction locks on commit/rollback. Connections involved in a failed
  operation are discarded from the pool.

Existing role contexts are counted for review but not imported. Newly created
scopes retain migration_ready=false. Legacy rows are read, never updated. The
result always has activationApproved=false and contains counts, not identifiers
or profile data.

## Outcomes and uncertain commits

Success status is applied or noop; a conflicting plan returns blocked.
`IdentityMigrationError.outcome` is not_committed when COMMIT was not attempted,
and unknown when an error occurs during COMMIT. Errors expose only a fixed message
and a validated SQLSTATE if available, not raw database details.

Unknown must not be reported as a rollback. Reconcile using fresh database state
and the immutable import ledger. A later explicitly initiated run can recognize
the committed rows and return noop; the writer never retries by itself. A retry
after changed legacy input may correctly be blocked instead.

## Local verification

Verified 2026-09-30: all **25 PostgreSQL checks** (17 schema and 8 writer checks)
passed on PostgreSQL 18.6, and all **71 existing offline tests** passed. The local
test cluster was stopped and its temporary files removed. Existing local changes
were preserved; no production database or bot was started.

The disposable-cluster harness now invokes `scripts/identity-writer-checks.cjs`
after the 17 schema checks. Writer checks cover wrong-database rejection, committed
import and repeat after newer data, current-legacy conflict detection, forced
failure after the final insert, backend termination during the transaction, lost
COMMIT response, two concurrent migration calls, and preservation of legacy data
with activation disabled.

Tests run only against the local cluster created and guarded by the harness. The
fault cases wrap the test Pool; the writer has no fault-injection hooks. Terminated
backends belong to the temporary cluster. Lost COMMIT response is simulated by
throwing after a real successful COMMIT. It is not a live network-fault experiment.

```powershell
node scripts/test-identity-postgres.cjs '<local PostgreSQL bin directory>'
```

Production migration still requires verified backup/restore, stopped and drained
writers, schema/version validation, complete role-context treatment and a rollback
strategy. This step does not authorize or perform production migration, Discord
delivery, command registration, push or deploy.
