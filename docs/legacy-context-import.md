# Verified legacy context import

`planLegacyContextImport` is a pure maintenance planner for old creator and role
contexts. It is generic: it does not call Discord, read a database, apply SQL,
or activate runtime behavior.

An old context row is insufficient evidence by itself. Every import requires an
attestation bound to its one-based legacy row and SHA-256 snapshot hash. It must
identify an existing scoped event, supply a current role inventory, and list only
validated role IDs. A creator is imported only with namespace, ID, source
reference and `verified: true`; the old creator value is never promoted alone.

The proposal creates context, role and provenance-import rows together. Matching
provenance is replay-safe. Missing or changed evidence, unknown roles, an existing
context, or a changed target binding blocks the complete proposal.

`applyLegacyContextImport` is a separate maintenance entry point. It requires a
database name, explicit stopped-writer confirmation and attestations, takes a
transaction advisory lock, locks legacy and context tables, re-reads both sides,
replans, then commits all rows together. A lost commit acknowledgement is reported
as unknown and must be reconciled from the ledger. It has no runtime import.

Four synthetic offline tests cover verified proposals, absence of evidence,
invalid evidence, and replay safety. Three local PostgreSQL checks cover atomic
write, replay and changed-legacy blocking.
