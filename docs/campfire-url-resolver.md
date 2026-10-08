# Standalone Campfire URL resolver

Implemented 2026-09-30 in `src/identity/resolveCampfireUrl.js`. This adds the
bounded resolver previously described in the URL verification notes. It is not
imported by the running bot, legacy adapter, database initializer or dry-run CLI.

## Behavior

`await resolveCampfireUrl(sourceUrl, options)` uses Node's built-in fetch when
invoked, unless a trusted test transport is supplied as `options.fetchImpl`.
Importing the module makes no requests. No environment variables, credentials,
database modules or Discord modules are loaded. There are no logs or file writes.

Only the immutable `campfireUrlPolicy` hosts are allowed. Initial URLs and every
redirect destination must pass the existing HTTPS/host/path validation. Relative
Location values are resolved against the current URL and then validated. Redirects
are manual. Only 301/302/303/307/308 Location values can extend the evidence chain;
Location on a non-redirect response is not evidence. Loops, unapproved targets and
transports that auto-follow redirects are rejected or left unresolved.

The resolver stops when it reaches a supported direct meetup URL. It does not
fetch that event page, check attendance, prove the event exists or follow further
redirects from a direct URL. For the verified short-link fixture, this means HEAD
405 then GET 307 to the Niantic meetup URL; the later Scopely page need not be
requested to extract the ID. A directly supplied supported meetup URL needs no
network request at all.

HEAD is tried first. If it supplies no usable redirect, including a transport
failure or per-request timeout, GET is tried within the remaining total budget.
An invalid redirect is rejected immediately, not retried. HTTP 429 returns
rate_limited without a retry. Unknown pages and request errors stay unresolved.

Default limits: 4 seconds per request, 12 seconds total, and 8 redirects. Trusted
options may lower these limits or increase request/total time to at most 7/30
seconds. Redirect count cannot exceed 8. An optional AbortSignal cancels work.
A timeout both aborts the request and resolves the caller even if an injected
transport ignores abort. Node event-loop blocking can delay any timer; these are
asynchronous deadlines, not hard real-time guarantees.

Response bodies are cancelled without reading them, including late responses.
Cancellation is initiated without awaiting an unbounded stream. No cookies,
authorization headers or referrer are supplied. Failure results use fixed reason
codes and never echo exception messages, URLs or headers. Successful results
contain the validated URLs; keep these internal rather than logging them.

## Results and integration boundary

- `resolved`: meetupId plus the actual observed redirectChain (or a single
  directly supplied URL). Pass this trace to resolveIdentity using the same policy.
- `unresolved`: timeout, network_error, no_redirect, rate_limited, redirect_loop
  or hop_limit. Never convert this result into a mutable fallback identity.
- `rejected`: unapproved_url, unapproved_redirect or invalid_transport.
- `cancelled`: caller cancellation, without a GET retry.

Invalid resource-limit options throw a fixed TypeError. Options and fetchImpl must
come from trusted application code; they are not Discord message fields. The
standard transport relies on normal DNS/TLS for the exact approved hosts; it is
not a general-purpose arbitrary-URL proxy or a custom DNS-pinning implementation.

On failure, a future caller may still ask the identity module to recover an
existing verified URL/observation alias. It must not fabricate a trace or store
an unverified short URL as a new event. On success, event creation and alias writes
still need a scope lock, transactional uniqueness, and a fresh state read. This
module does not send messages, migrate data, or implement exactly-once delivery.

## Verification

15 offline tests exercise the sanitized observed HEAD/GET behavior, pure-module
composition, direct URLs without network I/O, host and protocol rejection,
relative hops, loops and exact hop limits, error redaction, non-redirect Location,
rate limits, request/total timeouts, cancellation, late-body cleanup and a transport
that incorrectly follows redirects. No live request is required by these tests.

```powershell
node --test test/resolveCampfireUrl.test.cjs
```

The implementation follows the [Node fetch and AbortController interfaces](https://nodejs.org/api/globals.html#fetch)
and cancels unused bodies as described by [Undici's response-body guidance](https://github.com/nodejs/undici#garbage-collection).

Next bounded task: implement the offline storage contract and migration plan for
scope/event/alias uniqueness, with explicit existing-state conflict handling.
Actual PostgreSQL application and runtime wiring remain later steps.
