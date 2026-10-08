# Live migration audit — 2026-10-08

Read-only checks used the Railway public PostgreSQL URL supplied through the
clipboard. The connection string was not saved or printed. The URL database name
matched `current_database()`. All three legacy tables exist; none of the ten v2
tables exists yet. No schema or data was changed.

The legacy snapshot contains two configs, 90 message mappings and 45 context
rows. The identity dry-run found 79 message candidates and 11 unresolved
mappings. Nine mappings have no config with the same source and target channel;
none has multiple matching configs. Two use `campfire:fallback:` keys, which do
not prove a stable meetup identity. Both configs have valid shape and distinct
IDs. All 45 contexts match a candidate mapping, but their creator and role
facts require validation before context import.

The current writer rejects the entire snapshot while any of these mappings is
unresolved. The nine orphan mappings need a reviewed historical scope decision;
the two fallback mappings need source evidence for a stable identity or an
explicit reviewed disposition. Do not infer identity from title, time, author or
the target message alone. The 45 contexts require role validation and bound
attestations. Re-run the read-only dry-run after any reviewed resolution because
legacy data may change before migration.

Additional read-only Discord checks found that all 11 referenced source messages
are still accessible, were sent by the Campfire bot, contain approved short
links, and have no edit timestamp. Both fallback short links now resolve through
the approved redirect chain to stable IDs, but each ID is already represented by
another legacy mapping in the same channel pair. Both fallback target posts and
both established target posts still exist. They are visible historical duplicates;
do not silently merge or delete either copy.

The nine orphan rows belong to one old source/target channel pair. Their current
short-link redirects leave the approved host set, so they provide no new identity
proof. Two of their target posts still exist; seven return Discord's exact
missing-message response. Two orphan rows already carry stable meetup keys, but
the missing historical config still prevents an unambiguous v2 scope assignment.
These observations support preserving the old rows and posts while preparing an
explicit quarantine/partial-import design; they do not make the current writer
safe to run as-is. The Discord requests respected rate limits and neither read
nor changed any unrelated messages.

The reviewed, read-only manifest now covers all 11 exclusions and proposes 79
identity imports. The optional maintenance writer stores imports and quarantine
entries atomically, while the default strict writer still blocks on unresolved
legacy rows. No live schema or data change has been made. The manifest is bound
to exact row hashes and must be regenerated and rechecked at migration time.

All 45 legacy context rows have one stored role reference. A live Discord role
inventory confirmed that all 45 roles still exist in the matching guild. All 45
source messages are readable and from the expected Campfire bot. Only four show
an unedited creation notice mentioning the stored creator; the other 41 creator
values remain unverified. Read-only context attestations therefore propose all
45 current roles, four verified creators and no creator for the other 41. The
context plan validated against the 79 proposed events, but no context has been
imported. Regenerate these attestations before any maintenance run.

The core relay remains source-agnostic. `campfire:fallback:` is a legacy source
key shape encountered during migration, not a requirement that the v2 core
depend on Campfire or Pokémon Go. A generic Discord evidence strategy and an
explicit ready-client adapter factory now exist, but the existing runtime has
not been cut over. This audit does not authorize schema application, migration,
command registration or deployment.
