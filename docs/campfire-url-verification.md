# Campfire URL verification — 2026-09-30

## Verified from public first-party resources

- The old [Discover page](https://campfire.nianticlabs.com/discover) redirects to
  [campfire.scopely.com/discover](https://campfire.scopely.com/discover).
- One publicly shared direct meetup URL was checked with automatic redirects
  disabled. The old nianticlabs host returned HTTP 301 with the same
  `/discover/meetup/<UUID>` path on campfire.scopely.com. The new URL returned 200.
  Only status, URL and Location are retained in
  `test/fixtures/campfire-public-route.observed.json`; no event content or profiles.
- The first-party page loads a dedicated dynamic meetup route:
  [meetup route resource](https://campfire-web-assets.nianticlabs.com/_next/static/chunks/app/(web)/discover/meetup/%5Bid%5D/page-942e43554b43ce32.js).
  This supports the route observation; HTTP 200 alone would not establish that an
  individual event exists or that every UUID is valid.
- The public client's [configuration resource](https://campfire-web-assets.nianticlabs.com/_next/static/chunks/3546-0af5da95661fa399.js)
  identifies `https://cmpf.re` as its short-link base. This verifies the host's use,
  not the semantics or permanence of individual short links. Full client bundles
  are not retained as fixtures.

These are dated implementation observations, not a published API contract or proof
that the path accepts only UUIDs. UUID-only handling remains a conservative subset.
The old reproduction script used a synthetic meetup URL, so it was not independent
evidence for production URL behavior.

## Implemented boundary

`src/identity/campfireUrlPolicy.js` exports an immutable, opt-in policy allowing
the two observed direct hosts and cmpf.re as a possible short-link host. The default
policy remains empty. No runtime module, network resolver or CLI configuration is
changed. Using the policy with the existing identity module preserves the same
event when a verified old-to-new domain redirect adds a URL alias.

The new tests replay the recorded public route entirely offline. The synthetic
cmpf.re test URL is explicitly not fetched. A recognized short-link host still
returns pending_identity until its meetup identity is proven. The CLI continues
to withhold legacy URL rows by default.

## User-supplied short-link check

On 2026-09-30 the user supplied a meetup short link. A read-only check with cookies
and automatic redirects disabled observed HEAD 405 without Location, followed by
GET 307 to the nianticlabs direct meetup path. That path returned 301 to the same
meetup UUID on scopely.com, which returned 200. Only response headers were read.
No additional redirect host was needed for this sample.

The fixture `test/fixtures/campfire-short-route.sanitized.json` retains the observed
hostnames, route shapes and status codes with a synthetic short code and UUID.
It is explicitly sanitized, not a byte-for-byte record of the user's URL.
`test/campfireShortRoute.test.cjs` verifies the existing adapter's HEAD-to-GET
fallback in an isolated VM, then verifies alias continuity and failure recovery
in the new identity module. The adapter already handles this HEAD 405 behavior;
the observation is not evidence of a new defect in that path.

## Still unverified

One successful trace does not establish short-link stability across edits, all
possible redirects, or behavior for app deep links and query-based identities.
No profile, group, or arbitrary query UUID may be treated as meetup identity.
Do not infer intermediate hosts or enable wildcard domains. A future resolver
must validate each hop, bound request duration, and preserve GET fallback when
HEAD provides no Location. It must supply genuine observed evidence to the pure
module; caller-supplied traces alone are not authenticated by that module.

The user reported finding no current duplicates, possibly none recently. No
incident pair or production logs were examined, so the historical cause remains
unconfirmed. There is no need to find an old duplicate to proceed with bounded
resolver work. Runtime integration, delivery locking and migration remain separate.

The [official Discord bot guide](https://niantic.helpshift.com/hc/de/34-campfire/faq/4496-how-to-add-the-campfire-bot-to-your-discord-server-and-how-to-link-your-campfire-account-to-discord/?l=en)
explains account/group linking but does not document a stable meetup URL contract
or establish that missing /link causes RelayOnMe duplicates. The historical cause
remains unconfirmed.

No bot, database migration, command registration, authentication, push or deploy
was performed. Public HTML/JavaScript and HTTP response metadata were read.
