# Generic relay creator and role context

Product direction, confirmed 2026-10-01: RelayOnMe is a general relay bot. Game
rules belong in optional add-ons. Source-specific parsing belongs in adapters.
No Pokémon GO, game-event, region, or ambassador rules belong in this module.

The new `src/relay/` modules depend only on the generic scoped-event storage
contract. They do not import the Campfire parser, URL policy, or migration code.
The existing Campfire integration is retained; this step does not turn that
historical integration into a complete general adapter framework.

## Why preserve context

The person editing a source item may differ from its creator. Looking up roles
from the latest mention can silently switch that item's group association. The
new planner accepts creator evidence only on a created notice and retains the
stored creator on updated/reminder notices. It never treats an editor as a new
creator. Conflicting verified creation evidence returns creator_conflict.

Adapters supply a namespace, creator ID and source reference with verified=true.
That flag is an assertion by trusted adapter code, not authentication performed
by this module. Do not copy it from message input or infer it from a first mention.
Namespaces and creator IDs are opaque; they can describe calendar, workshop, news
or other providers. Administrative creator correction is not implemented here.

`planRelayContext` accepts a trusted role policy with guildId, knownRoleIds,
defaultRoleIds and bindings of namespace/creatorId to roleIds. Role inventory
must be fresh and belong to the target guild. Missing/mismatched inventory returns
pending_validation. Unrecognized/deleted role IDs and the guild's everyone-role
ID are excluded. The module does not fetch Discord roles or authorize admins.

For a new context, matching creator roles take precedence over defaults. Missing
or unverified creator evidence keeps the creator null and uses validated defaults.
A later verified created notice can establish the creator and replace those
defaults with the creator's roles. Updates preserve existing role choices, except
that roles absent from the validated inventory are removed. New policy defaults
are not silently applied to existing items. No ping behavior is enabled here.

## Storage and concurrency

The explicit `schema/relay-context-v2.sql` extension adds event_contexts and
event_context_roles, each tied to an event through a composite scope/event key.
Creator identity must either be fully absent or include namespace, ID and source
reference. Role rows are unique per scoped event. No automatic schema upgrade or
deletion cascade is added. Discord role ownership remains an application check.

`saveRelayContext` uses a caller-provided pg Pool. It opens one transaction, locks
the scope row, checks actual guild/state and event membership, then re-reads context.
The caller must supply expectedRevision (null for initial creation). A stale
revision returns stale_context instead of overwriting another update. The scope
lock also serializes first-time creation when a context row does not yet exist.

Context and roles commit together. Fixed local timeouts bound database queries
and lock waits. Failed writes roll back; an error during COMMIT is reported as an
unknown outcome requiring reconciliation. The module does not retry or log private
context. Returned context is internal data, not intended for public logs.

## Boundaries

Existing global Campfire role contexts are not automatically imported. Their
creator provenance and role ownership still require verification before migration.
The legacy bot remains unchanged and does not call these modules. The identity
migration writer continues to leave activation disabled. Runtime delivery locks,
observation tracking, permissions and explicit adapter integration remain separate.

## Tests

Verified 2026-10-01: all 80 offline tests and 32 PostgreSQL checks passed on the
local PostgreSQL 18.6 cluster. The temporary server was stopped and its files
removed. No production migration, runtime activation, push or deploy occurred.

Nine offline tests cover multiple generic provider namespaces, editor preservation,
conflicting creation evidence, missing creator and later establishment, guild and
event isolation, deleted roles, everyone-role exclusion and immutable inputs.

The disposable PostgreSQL harness adds seven context checks: actual persistence,
editor preservation, invalid guild/event/creator rejection, one winner and one stale
result for concurrent changes, SQL integrity constraints, destination isolation,
and rollback restoring both roles and revision after a forced failure.

```powershell
node --test test/relayContext.test.cjs
node scripts/test-identity-postgres.cjs '<local PostgreSQL bin directory>'
```
