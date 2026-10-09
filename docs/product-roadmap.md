# First public product

The first listing should describe RelayOnMe as selective community forwarding:
choose a source, decide which posts matter, choose how they look, and send them
to a channel. Preserve Tundraheim's existing Campfire relay throughout rollout.

## Implemented foundations

- Common include/exclude filters for words, categories and authors.
- Bounded RSS/Atom document parsing.
- Output templates with Markdown prefix/suffix, escaped data fields and explicit
  role allowlists. The existing v2 transport remains silent; notification support
  needs a separate explicit delivery policy before live use.
- Four synthetic, private `/relay demo` examples using the real filter and output
  functions. The command is wired but needs command registration on deployment.

## Release gates, in implementation order

1. **Persistent source configuration and item identity.** Guild-owned routes,
   validated configuration, and stable IDs scoped to a particular source.
   Current meetup URL identity cannot be reused as RSS/webhook identity.
2. **Usable RSS subscriptions.** Admin commands for add, preview, list, pause and
   remove; safe fetch with redirect/address checks, size and timeout bounds,
   conditional requests, and persistent deduplication across restarts. Default
   initial fetch establishes a baseline so old feed items do not flood a channel.
3. **Generic Discord forwarding.** Author/webhook restrictions, content filters,
   output templates, loop prevention, permissions checks and persisted delivery
   references. This supports existing webhook/RSS bots posting into Discord.
4. **Signed inbound webhooks.** Per-source secret handling, authentication over
   raw bytes, request/body limits, replay and duplicate protection, explicit
   mapping of supported event fields, and rotation without exposing secrets.
5. **Campfire add-on integration.** Keep parser, redirect policy and creator rules
   in the add-on; generic routing/output/delivery must reproduce the current
   Tundraheim result before switching its production route.
6. **Launch verification.** Exercise real RSS, Discord and webhook routes in a
   designated test server; restart and duplicate tests, privacy/storage notes,
   accurate `/relay status`, setup documentation and support-server demo channels.
   Publish the Top.gg listing only for demonstrated working features.

Defer digests, scheduled announcements, moderation approval and multi-destination
fan-out until the basic subscription and recovery behavior is reliable.

## Demo coverage

`/relay demo example:news` shows category selection and sponsored-post exclusion.
`jobs` combines categories and keywords. `releases` excludes prereleases and issue
events. `events` shows add-on data rendered by the same output engine. Optional
`template` and `add_text` let users try Markdown without saving or sending a route.
All examples are synthetic and clearly identify unfinished integrations.
