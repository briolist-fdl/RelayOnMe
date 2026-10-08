# Reviewed legacy quarantine

The live audit found 79 unambiguous old message mappings, two visible historical
duplicates, and nine mappings from a removed channel configuration. Neither
duplicate post is deleted. The old tables remain untouched.

`schema/relay-legacy-quarantine-v2.sql` adds a ledger for exact old rows excluded
from active v2 event ownership. Each entry stores only provenance, a hash of the
five legacy message columns, a generic reason, and a hash of the review evidence.
It stores no message content, token, URL or Discord ID. It is a separate, explicit
schema migration after the base v2 identity schema.

`scripts/relay-v2-build-review-manifest.cjs` reads the current legacy snapshot in
a read-only transaction. For every unresolved row, it checks the exact source
message from the expected Campfire bot and its approved short link. For an orphan
it confirms that no configuration owns the channel pair and checks whether the
old target exists. For a historical duplicate it resolves the short link through
the approved redirect chain, requires exactly one stable-key mapping in the same
pair, and verifies both target posts exist. It prints a hash-only review manifest.
This source-specific evidence collector is separate from the generic v2 planner.

`planReviewedIdentityMigration` requires an explicit exclusion for **every**
unresolved row. An exclusion cannot hide a candidate mapping or a context row.
The exact legacy row fingerprint, reason and duplicate's canonical provenance
must match the current snapshot. New or changed rows, unexpected contexts,
conflicting v2 state or changed quarantine records block the entire plan. The
original strict planner remains the default.

`applyIdentityMigration` accepts `reviewedExclusions` only during an explicit
maintenance call with stopped writers. It rereads current legacy/v2 rows under
locks and commits imports and quarantine entries in one transaction. It does not
activate a scope. `applyLegacyContextImport` can accept the same exclusions, but
only after it confirms the identity import and all quarantine entries are already
applied exactly; role/creator attestations remain separate requirements.

The manifest is a review input, not a reusable permission or a migration command.
Generate it again immediately before any migration and check its counts and
evidence. A changed database row blocks application. Back up the database and
stop/drain the legacy writer before applying any schema or migration. No part of
this workflow runs automatically at bot startup.

`scripts/relay-v2-live-context-audit.cjs` also has an explicit read-only
attestation mode. It checks current guild role inventory and the exact source
message for each legacy context. A creator is attested only when an unedited
creation notice from the expected source bot mentions that stored user. Otherwise
the attestation leaves creator empty while retaining currently valid roles. It
validates all attestations against the reviewed identity proposal before output.
The output includes Discord IDs needed by the context writer and should be kept
outside the repository and regenerated before use.
