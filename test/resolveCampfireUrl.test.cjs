'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveCampfireUrl } = require('../src/identity/resolveCampfireUrl');
const { resolveIdentity } = require('../src/identity/resolveIdentity');
const { campfireUrlPolicy: policy } = require('../src/identity/campfireUrlPolicy');
const fixture = require('./fixtures/campfire-short-route.sanitized.json');
const short = fixture.head.url;
const direct = fixture.requests[1].url;
function response(status, location = null, onCancel = () => {}) {
  return { status, headers: { get(name) { assert.equal(name, 'location'); return location; } },
    body: { cancel() { onCancel(); return Promise.resolve(); } } };
}

test('observed HEAD 405/GET 307 supplies an identity trace without fetching event bodies', async () => {
  const calls = [];
  let cancelledBodies = 0;
  const resolved = await resolveCampfireUrl(short, { fetchImpl: async (url, options) => {
    calls.push([url, options.method]);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer');
    assert.deepEqual(Object.keys(options.headers), ['User-Agent']);
    const row = options.method === 'HEAD' ? fixture.head : fixture.requests[0];
    return response(row.status, row.location, () => { cancelledBodies++; });
  } });
  assert.deepEqual(calls, [[short, 'HEAD'], [short, 'GET']]);
  assert.equal(cancelledBodies, 2);
  assert.deepEqual(resolved, { status: 'resolved', meetupId: fixture.meetupId, redirectChain: [short, direct] });
  const identity = resolveIdentity({ scope: { id: 's', sourceChannelId: 'c', enabled: true },
    observation: { sourceChannelId: 'c', sourceMessageId: 'm', meetupUrl: short }, policy,
    migrationReady: true, redirectChain: resolved.redirectChain });
  assert.equal(identity.status, 'new_event');
  assert.equal(identity.aliasesToAdd.length, 3);
});

test('supported direct URLs are resolved locally without a network request', async () => {
  for (const url of fixture.requests.slice(1).map(row => row.url)) {
    const result = await resolveCampfireUrl(url, { fetchImpl: () => { throw Error('Must not fetch'); } });
    assert.equal(result.status, 'resolved');
    assert.deepEqual(result.redirectChain, [url]);
  }
});

test('invalid initial URLs are rejected before transport is called', async () => {
  let calls = 0;
  for (const url of ['http://cmpf.re/A', 'https://cmpf.re.evil.example/A',
    'https://user:password@cmpf.re/A', 'https://cmpf.re:444/A', short + '#fragment',
    'https://127.0.0.1/A', 'https://campfire.scopely.com/?id=' + fixture.meetupId, ' ' + short]) {
    assert.equal((await resolveCampfireUrl(url, { fetchImpl: () => { calls++; } })).status, 'rejected');
  }
  assert.equal(calls, 0);
});

test('unapproved redirect targets are rejected without following or falling back to GET', async () => {
  for (const location of ['http://cmpf.re/A', 'https://evil.example/A', '//127.0.0.1/A',
    'https://user:password@cmpf.re/A', 'javascript:alert(1)', '/A#fragment', 'https://cmpf.re\\@evil.example/A']) {
    const calls = [];
    const result = await resolveCampfireUrl(short, { fetchImpl: async (url, options) => {
      calls.push(options.method); return response(302, location);
    } });
    assert.deepEqual(result, { status: 'rejected', reason: 'unapproved_redirect' });
    assert.deepEqual(calls, ['HEAD']);
  }
});

test('relative redirects preserve path case and query and revalidate each hop', async () => {
  const calls = [];
  const result = await resolveCampfireUrl(short, { fetchImpl: async url => {
    calls.push(url);
    return response(302, calls.length === 1 ? '/AbC?x=One&y=2' : direct);
  } });
  assert.equal(result.status, 'resolved');
  assert.deepEqual(calls, [short, 'https://cmpf.re/AbC?x=One&y=2']);
  assert.deepEqual(result.redirectChain, [...calls, direct]);
});

test('loops and hop limits stop with no partial identity evidence', async () => {
  assert.deepEqual(await resolveCampfireUrl(short, { fetchImpl: async () => response(307, short) }),
    { status: 'unresolved', reason: 'redirect_loop' });
  let calls = 0;
  const limited = await resolveCampfireUrl(short, { maxRedirects: 2, fetchImpl: async () => {
    calls++; return response(302, '/hop-' + calls);
  } });
  assert.deepEqual(limited, { status: 'unresolved', reason: 'hop_limit' });
  assert.equal(calls, 2);
  assert.equal((await resolveCampfireUrl(short, { maxRedirects: 1,
    fetchImpl: async () => response(307, direct) })).status, 'resolved');
});

test('HEAD transport error falls back, but errors never expose the URL or exception', async () => {
  const calls = [];
  const result = await resolveCampfireUrl(short, { fetchImpl: async (url, options) => {
    calls.push(options.method);
    if (options.method === 'HEAD') throw Error('sensitive-network-detail');
    return response(307, direct);
  } });
  assert.equal(result.status, 'resolved');
  assert.deepEqual(calls, ['HEAD', 'GET']);
  const failure = await resolveCampfireUrl(short, { fetchImpl: async () => { throw Error('private-detail'); } });
  assert.deepEqual(failure, { status: 'unresolved', reason: 'network_error' });
});

test('Location on non-redirect status is not identity proof; unknown bodies are discarded', async () => {
  for (const status of [200, 401, 403, 404, 500]) {
    let cancelledBodies = 0;
    const result = await resolveCampfireUrl(short, { fetchImpl: async () =>
      response(status, direct, () => { cancelledBodies++; }) });
    assert.deepEqual(result, { status: 'unresolved', reason: 'no_redirect' });
    assert.equal(cancelledBodies, 2);
  }
});

test('rate limit returns immediately without retries', async () => {
  let calls = 0;
  const result = await resolveCampfireUrl(short, { fetchImpl: async () => { calls++; return response(429); } });
  assert.deepEqual(result, { status: 'unresolved', reason: 'rate_limited' });
  assert.equal(calls, 1);
});

test('per-request timeout aborts HEAD and leaves budget for GET fallback', async () => {
  let headSignal;
  const result = await resolveCampfireUrl(short, { requestTimeoutMs: 10, totalTimeoutMs: 1000,
    fetchImpl: (url, options) => {
      if (options.method === 'GET') return response(307, direct);
      headSignal = options.signal;
      return new Promise(() => {}); // deliberately ignores abort
    } });
  assert.equal(headSignal.aborted, true);
  assert.equal(result.status, 'resolved');
});

test('total deadline ends a hung transport even when it ignores AbortSignal', async () => {
  const signals = [];
  const result = await resolveCampfireUrl(short, { requestTimeoutMs: 50, totalTimeoutMs: 10,
    fetchImpl: (url, options) => { signals.push(options.signal); return new Promise(() => {}); } });
  assert.deepEqual(result, { status: 'unresolved', reason: 'timeout' });
  assert(signals.every(signal => signal.aborted));
});

test('cancellation stops requests and never turns into a GET retry', async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = await resolveCampfireUrl(short, { signal: controller.signal, fetchImpl: () => {
    calls++; controller.abort('private-reason'); return new Promise(() => {});
  } });
  assert.deepEqual(result, { status: 'cancelled' });
  assert.equal(calls, 1);
  assert.deepEqual(await resolveCampfireUrl(direct, { signal: controller.signal }), { status: 'cancelled' });
});

test('late responses are discarded after timeout without extending the result deadline', async () => {
  const late = [];
  let cancelledBodies = 0;
  const result = await resolveCampfireUrl(short, { requestTimeoutMs: 5, totalTimeoutMs: 1000,
    fetchImpl: () => new Promise(resolve => late.push(resolve)) });
  assert.equal(result.reason, 'timeout');
  for (const resolve of late) resolve(response(200, null, () => { cancelledBodies++; }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelledBodies, late.length);
});

test('transport which auto-follows redirects is rejected and its body is cancelled', async () => {
  let cancelled = false;
  const result = await resolveCampfireUrl(short, { fetchImpl: async () => ({
    ...response(200, null, () => { cancelled = true; }), redirected: true, url: direct,
  }) });
  assert.deepEqual(result, { status: 'rejected', reason: 'invalid_transport' });
  assert(cancelled);
});

test('invalid resource limits fail before fetching', async () => {
  for (const options of [{ maxRedirects: 9 }, { maxRedirects: -1 }, { requestTimeoutMs: 0 },
    { totalTimeoutMs: Infinity }, { requestTimeoutMs: 7001 }, { totalTimeoutMs: 30001 }]) {
    await assert.rejects(resolveCampfireUrl(short, options), /Invalid resolver options/);
  }
});
