# Live Discord message relays

Use `/relay config add` with parser **Discord messages (filtered)**. Set a source
and a different target in the same server. Only Administrators, Manage Server
members or the configured relay admin role can configure or preview routes.

Optional `include` and `exclude` accept phrases separated with `|`; matching is
case-insensitive and any exclusion wins. `author` restricts the source to a
particular user or bot. `template` replaces the output, and `add_text` appends a
Markdown block. Example: `{original_content}` followed by `**Community update**`.

New and edited message configurations are saved **disabled**. Run
`/relay preview source_channel:<source> text:<sample>` to test selection and
output privately. Supply the optional sample `author` when testing an author
restriction. Then use `/relay config enable` to start listening for new posts.
No historical messages are backfilled. `/relay config disable` stops processing
new events; a delivery already in flight can finish.

Text and the first embed's title/description/fields are supported. Attachment
forwarding, interactive components and original embed layouts are not supported
in this first version. Empty/oversized output is held. All mentions are silent.
The bot skips its own messages and its own webhooks to prevent relay loops.

Message IDs are scoped by configuration and target. The durable v2 delivery
engine sends once, edits the same target when newer source content arrives and
holds uncertain outcomes or missing targets rather than blindly sending again.
If an edit stops matching the filter, no further update is sent; the prior target
is retained. Config updates affect future source events, not already posted text.

## BrioBots live example

Live generic demo: [rom-filter-source](https://discord.com/channels/1550119459891576852/1558258687032696952)
to [rom-filter-output](https://discord.com/channels/1550119459891576852/1558258733635739658).

Send `alpha hello` in the source to see it forwarded with an extra Markdown
text block. Send `alpha omega` to see it skipped. Editing the matching source
updates its existing output. The server owner confirmed the live test on
10 October 2026. Channel cleanup is configured separately by the server owner.

The existing Campfire example uses a separate channel pair and the RelayOnMe
Campfire add-on. This generic demo does not change its configuration.

The initial production database migration was already applied separately.
Startup adds two default-empty JSONB configuration columns. Discord message
routes require the complete v2 delivery schema and do not activate Campfire scopes.
