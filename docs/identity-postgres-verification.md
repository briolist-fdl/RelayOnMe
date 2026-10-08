# Local PostgreSQL verification — 2026-09-30

Result: **17 checks passed against PostgreSQL 18.6**, using the installed local
PostgreSQL binaries, Node.js 24.14.1 and the existing pg dependency. No additional
software was installed. The SQL schema required no changes.

The harness `scripts/test-identity-postgres.cjs` created a fresh cluster under the
operating system's temporary directory, using a random available port and only
127.0.0.1. It validated the cluster's actual data directory before testing. The
database contained synthetic data only. No dotenv, database URL, external service,
Discord client or production database was accessed.

## Why this check matters

The offline planner can recommend the right inserts while SQL constraints still
contain mistakes. This test executes the actual schema, imports planner output,
and asks PostgreSQL to reject invalid relationships. Separate connections also
exercise the unique-index wait which protects identity ownership under contention.

Verified:

1. The actual schema applies successfully.
2. A forced SQL failure after all proposed inserts rolls back all five tables.
3. Planner output inserts without losing source/target references; replanning
   against the actual database snapshot proposes no repeated inserts.
4. Duplicate config/destination scope is rejected.
5. Duplicate alias within a scope is rejected.
6. A second stable meetup ID for one event is rejected.
7. Cross-scope event references are rejected.
8. A delivery destination different from its scope is rejected.
9. Reuse of an existing destination/message reference is rejected.
10. Delivered state without a message reference is rejected.
11. Duplicate import provenance is rejected.
12. An import referring to a missing event is rejected.
13. Deleting a populated scope is rejected rather than cascading through history.
14. The same meetup ID is allowed in another scope.
15. With two concurrent alias inserts, the second connection visibly waits on
    the first, then receives unique violation after the first commits. One owner remains.
16. If the first connection instead rolls back, the waiting second insert succeeds
    and becomes the sole owner.
17. Reapplying the schema is rejected instead of silently accepting existing objects.

Both contention checks observed pg_blocking_pids before releasing the first
transaction. These were separate database connections within one Node process,
not two bot processes and not a test of application advisory locks.

The first attempt uncovered an address-format assumption in the harness: casting
an inet address to text includes its mask. The guard now uses host(inet_server_addr()).
This changed only the test, not the schema or runtime code.

## Cleanup and boundaries

The test reported clusterStopped=true and temporaryFilesRemoved=true. It confirmed
the local server had stopped before recursively deleting its own marked temporary
directory, after checking its resolved parent and ownership marker. Child processes
were launched with hidden windows. No PostgreSQL service was installed.

Local trust authentication is used only in this disposable loopback cluster.
Do not reuse that configuration as a production database setup. The script never
accepts an external connection string and takes only a local PostgreSQL bin path.

```powershell
node scripts/test-identity-postgres.cjs '<local PostgreSQL bin directory>'
```

The insert routine belongs to the test harness. A production migration writer,
advisory locking protocol, full process-crash recovery, role-context migration and
webhook delivery recovery remain separate work. These results do not approve
production migration, runtime wiring, push or deploy.

## Tested file SHA-256

| File | SHA-256 |
| --- | --- |
| schema/relay-identity-v2.sql | A2A800F07F143DB070D7CB76E7AC92B8CDFC1FABE82E728154823303E21D4277 |
| scripts/test-identity-postgres.cjs | 4DA5A8B32C28AB08EB21F43E54BC44734E4C29580C0B83161AA0525B24382677 |
| src/identity/planIdentityMigration.js | 033A9BC0F64FC6CE24EB306B819438C673E8DB9F6754E99BDC6FE421A958BDB0 |
