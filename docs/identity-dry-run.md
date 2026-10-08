# Offline identity and migration dry-run

This is a standalone CommonJS implementation. The current bot, adapter, database
initializer and command registration do not import it. No schema changes or
delivery changes are included. No dependencies have been added.

## Run with synthetic data

From the RelayOnMe repository:

```powershell
node --test test/identity.test.cjs test/migrationDryRun.test.cjs
node scripts/relay-identity-dry-run.cjs test/fixtures/relay-migration.synthetic.json
node scripts/relay-identity-dry-run.cjs test/fixtures/relay-migration.blocked.synthetic.json
```

The CLI reads one local JSON file and prints a sanitized JSON report. It never
loads dotenv, the bot, PostgreSQL, Discord or a URL resolver, and never writes
files. Exit 0 means no classification blockers were found; exit 2 means unresolved
rows or invalid configurations; exit 1 means invalid arguments/input. None of
these results certifies that deployment or database migration is safe.

Snapshot format: `{ "version": 1, "configs": [], "messages": [], "contexts": [] }`.
Use the columns of relay_configs, relay_messages and relay_campfire_meetup_context.
All three arrays are required. Include disabled configurations and all legacy
rows. The tool cannot detect an incomplete export that has valid structure.
The CLI accepts files up to 10 MiB. There is no export or database connection
feature; obtaining a real snapshot is a separate authorized operation.

The report includes every input message/context row by one-based position and a
hashed provenance reference. It omits raw relay keys, source/target message IDs,
creator IDs, role IDs and arbitrary extra columns. Hashes are correlation references,
not a guarantee of anonymity; treat reports as operational data. Errors omit input
values and paths. The in-memory API additionally returns `candidates` preserving
message references; do not log or automatically apply that collection.

## Pure identity API

`resolveIdentity` receives a scope, source observation, current events/aliases and
resolved source observations. Pending observations may have null eventId. It
returns existing_event, new_event, pending_identity, blocked_migration,
identity_conflict, invalid_scope, invalid_evidence or invalid_state.

The scope requires id, sourceChannelId and enabled. Its id must come from a trusted
scope store keyed by relay configuration and target; this pure function does not
derive or authenticate guild/channel ownership. State arrays must be a complete,
trusted snapshot for the scope. Callers must validate configuration and own all
state reads; message content must never supply migrationReady or policy.

No host is trusted by default. A caller may explicitly supply `policy.meetupHosts`
and `policy.shortHosts`. The supported direct grammar is HTTPS on an exact approved
host, `/discover/meetup/<UUID>` with optional trailing slash. Generic query IDs and
arbitrary UUIDs elsewhere are rejected. Fragments, credentials, non-default ports
and non-HTTPS URLs are rejected. URL path case and query are preserved.

The core decision tests use `.example` hosts. A separate offline test now replays
one observed public old-to-new Campfire domain redirect. The opt-in
`campfireUrlPolicy` and evidence limits are documented in
[Campfire URL verification](campfire-url-verification.md). No runtime policy is
enabled. One actual short-link trace has now been verified and replayed with a
sanitized fixture, including HEAD 405 / GET 307 fallback. Short-link stability
across edits remains unverified. The direct UUID grammar deliberately rejects
other possible formats until verified.

`redirectChain` is an optional, trusted trace including the original URL and at
most eight redirect destinations, ending in the resolved URL. This module checks
the original URL, every allowed host, the hop count and conflicting meetup IDs.
It cannot prove that HTTP redirects actually occurred. A future trusted resolver
must provide that evidence with timeouts and validation on every hop. User input
must never be treated as a verified trace. There is no network resolver here.

Without a proven meetup ID, an unknown short URL stays pending. A previously
verified alias can recover its event when resolution fails. Successful resolution
adds the URL and meetup ID aliases to the same event. Conflicting alias ownership,
or a contradictory established meetup ID, is never automatically merged.

`aliasesToAdd` is a proposal, not a mutation. New events have null eventId; the
future persistence layer assigns it once. No caller may treat this result alone
as authorization to send. Scope locks, transactional uniqueness, delivery intents,
ping policy, creator context rules and send-uncertainty handling remain to be built.
In particular, concurrent calls can both propose new_event until the persistence
layer serializes and re-reads state under a scope lock.

## Migration classification

`migrationDryRun(snapshot, policy)` accepts the same explicit optional URL policy.
The CLI has no policy override and therefore holds all legacy URL keys for review.
UUID-based `campfire:meetup:` legacy keys are classified as candidates, not newly
verified external identity. The historical extractor accepted broad URL patterns;
the report cannot establish that those historical keys were correct.

Candidate mappings require exactly one configuration matching source and target,
a valid target-message reference, a stable legacy key, and no duplicate legacy key,
target reference or canonical identity. Scope/event references are deterministic
hashes; rerunning a dry-run gives the same proposals, but this does not implement
idempotent database migration. The report marks unresolved scopes and unplaced
global blockers. Candidates in a blocked scope must not be imported automatically.

Contexts require a matching candidate key/config, valid data shape and no duplicate
key. They still require role ownership and creator-provenance validation before
use. A missing historical configuration, overwritten mapping, or deleted/recreated
configuration cannot be reliably reconstructed from a snapshot alone. Conflicting
contexts are withheld and affected scopes blocked. If configuration history has
been lost without leaving evidence, this tool cannot detect that fact.

Fallback keys, legacy references without stable identity, changed destinations,
ambiguous configurations and malformed records stay unresolved. No title/time
similarity, creator mention or cross-server event match can resolve them.

The report always states `activationApproved: false`. This is a legacy classifier,
not an importer or an existing-v2 conflict detector. Before implementation of a
real importer, add v2 reconciliation, migration provenance, transactional uniqueness,
backup/restore and rollback rehearsal. No old table is changed by this work.
