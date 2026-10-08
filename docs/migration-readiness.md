# Migration and publication readiness

Nothing in this package applies schema, migrates data, enables a scope, starts a
bot, registers commands or publishes code. Before those actions, run a
read-only `preflightRelayV2` against the intended database and require `ready`.
It verifies the exact database name, all v2 tables, and a transport/evidence
contract with send, edit, inspect, decorate and verify operations.

The command-line `scripts/relay-v2-live-preflight.cjs` checks only the database
name and presence of legacy and v2 tables. It reports `adapterCheck: not_run`,
because a command-line process cannot verify a future Discord runtime adapter.
It reads `DATABASE_URL` from its environment or `.env`, prints no connection
details, and makes only SELECT queries. `v2_schema_missing` is expected before
the explicit schema migration and is not approval to apply it.

`scripts/relay-v2-live-dry-run.cjs` reads the three legacy tables inside a
read-only transaction and reports candidate and unresolved counts, grouped by
reason. It does not print Discord IDs, relay keys or connection details. A
`legacy_candidates_ready` result only means the identity mappings are
unambiguous; context roles still need validation, and no migration or
activation is approved by the report.

For reviewed historical exclusions, see `docs/reviewed-legacy-quarantine.md`.
The extra `legacy_quarantines` table and exact hash-only review manifest are
required before the reviewed import path can be used. Context import checks that
the same review has already been applied; it never bypasses role validation.

The Discord transport is separate from the runtime. It resolves only the stored
target channel, forces `allowedMentions.parse=[]`, and maps Discord's exact
missing-message error only during edits. `createDiscordEvidence` supplies a
generic durable marker: it binds each bot message to the exact attempt, event,
operation and channel, and searches bounded history for positive proof after an
uncertain send. An absent marker remains inconclusive and never authorizes a
blind resend. The running bot still needs explicit runtime wiring before
activation.

Recommended order: back up and dry-run; apply reviewed schemas; run preflight;
stop legacy writers; apply identity and verified-context maintenance imports;
verify ledgers and mappings; enable one scope; observe outcomes and holds; then
repeat scope by scope. Do not run the legacy and v2 delivery engines for the same
scope. Roll back by disabling the v2 scope and preserving all attempts for
reconciliation; do not delete mappings or resend uncertain attempts.

`scripts/apply-reviewed-v2-migration.cjs` is the explicit maintenance command
for the reviewed path. It requires `--apply`, an existing nonempty `--backup` dump,
absolute paths to fresh review and context artifacts, `RELAY_WRITERS_STOPPED=yes`,
and an empty v2 schema. It records only the backup's SHA-256 fingerprint in its
result, never its path or connection details. It applies
the reviewed schemas, then identity/quarantine and context imports. It does not
enable a scope or start the v2 runtime. Take and validate a backup immediately
before calling it; it deliberately refuses an existing or partial v2 schema.

If the legacy service resumes after this initial import, use
`scripts/apply-reviewed-v2-delta.cjs` only after stopping legacy writers again,
taking a fresh backup and regenerating both review artifacts. It applies new
audited ledger rows to the existing v2 schema but cannot enable a scope.

Save the JSON emitted by that delta command beside the backup. After the v2
runtime has been deployed but before it processes a source message, the only
activation path is `scripts/activate-v2-scope.cjs --activate`. It requires the
same backup, that saved delta result, an explicit scope ID, and a second
`RELAY_WRITERS_STOPPED=yes` confirmation. It enables one already-active scope
only when it is still disabled. It has no Discord client or transport and cannot
dispatch a message itself. Start the v2 runtime in observation mode first, then
activate one scope only after its adapter contract has been checked in the
running process.
