# External sources and selective relays

RelayOnMe can treat an RSS entry or webhook payload as a normalized source item:
`title`, `summary`, `link`, `author`, and `categories`. The provider adapter owns
fetching, signature verification and mapping its payload into that shape. The
core filter has no provider-specific code.

`compileRelayFilter` supports these explicit rules:

- `includeKeywords`: at least one phrase must occur in title or summary.
- `excludeKeywords`: any matching phrase blocks the item.
- `includeCategories`: at least one normalized category must match.
- `excludeCategories`: any matching category blocks the item.
- `allowedAuthors`: only these normalized author names may pass.
- `requireLink`: posts without an HTTP(S) link are held.

Exclusions always win. An adapter should record the returned reason and should
not attempt delivery for an item that does not match. This makes filters useful
for common cases such as one selected RSS category, posts by a specific author,
or webhooks marked `announcement`, while avoiding broad keyword guessing.

The next integration step is a persisted source configuration and a bounded RSS
poller or signed webhook endpoint. The RSS/Atom adapter now parses documents
with a bounded XML parser and returns only normalized items with a stable feed
ID (or a link when no ID exists). `selectFeedItems` applies the common filter
and records why each non-selected item was held. It performs no network request
or Discord delivery.

Each adapter must still assign a monotonically ordered revision and persist its
cursor before it invokes the delivery core. That is the next integration step,
along with persisted source configuration.
