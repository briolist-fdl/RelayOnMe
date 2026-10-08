'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveIdentity, parseUrl } = require('../src/identity/resolveIdentity');

const meetup = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const direct = `https://meetup.example/discover/meetup/${meetup}`;
const short = 'https://short.example/AbC?q=One&z=2';
const policy = { meetupHosts: ['meetup.example'], shortHosts: ['short.example'] };
const scope = { id: 'scope-one', sourceChannelId: 'source-one', enabled: true };
const observation = { sourceChannelId: 'source-one', sourceMessageId: 'message-one', meetupUrl: short };
const event = { scopeId: scope.id, id: 'event-one' };
const alias = (type, value, eventId = event.id, scopeId = scope.id) => ({ scopeId, eventId, type, value });
const base = extra => ({ scope, observation, policy, migrationReady: true, ...extra });

test('unresolved updates cannot acquire identity from mutable fields or mentions', () => {
  for (const type of ['created', 'updated', 'starting_soon']) {
    const result = resolveIdentity(base({ observation: { ...observation, type, title: 'Changed',
      starts: 'tomorrow', location: 'elsewhere', creatorDiscordUserId: 'editor' } }));
    assert.deepEqual(result, { status: 'pending_identity' });
  }
});

test('direct identity requires explicit approved URL policy and a completed migration', () => {
  const input = base({ observation: { ...observation, meetupUrl: direct } });
  assert.equal(resolveIdentity(input).status, 'new_event');
  assert.equal(resolveIdentity({ ...input, policy: {} }).status, 'pending_identity');
  assert.equal(resolveIdentity({ ...input, migrationReady: undefined }).status, 'blocked_migration');
});

test('failed then successful resolution preserves a known event and adds its stable ID', () => {
  const input = base({ events: [event], aliases: [alias('meetup_url', short)] });
  const first = resolveIdentity(input);
  assert.equal(first.eventId, event.id);
  assert.deepEqual(first.aliasesToAdd, []);
  const second = resolveIdentity({ ...input, redirectChain: [short, direct] });
  assert.equal(second.eventId, event.id);
  assert(second.aliasesToAdd.some(item => item.type === 'meetup_id' && item.value === meetup));
  const saved = second.aliasesToAdd.map(item => alias(item.type, item.value));
  assert.deepEqual(resolveIdentity({ ...input, redirectChain: [short, direct],
    aliases: [...input.aliases, ...saved] }).aliasesToAdd, []);
});

test('first failed resolution waits; successful resolution proposes one event with both aliases', () => {
  assert.equal(resolveIdentity(base()).status, 'pending_identity');
  const resolved = resolveIdentity(base({ redirectChain: [short, direct] }));
  assert.equal(resolved.status, 'new_event');
  assert.equal(resolved.aliasesToAdd.length, 3);
  assert.equal(resolveIdentity(base({ redirectChain: [short, direct], observations: [
    { ...observation, scopeId: scope.id, eventId: null, status: 'pending_identity' },
  ] })).status, 'new_event');
});

test('changed title, time, location and editor retain a stable mapping', () => {
  const result = resolveIdentity(base({ observation: { ...observation, meetupUrl: direct,
    title: 'New', starts: 'Later', location: 'New place', creatorDiscordUserId: 'other' },
    events: [event], aliases: [alias('meetup_id', meetup)], migrationReady: false }));
  assert.equal(result.status, 'existing_event');
  assert.equal(result.eventId, event.id);
});

test('the same meetup in another destination cannot reuse event or observation context', () => {
  const input = base({ scope: { ...scope, id: 'scope-two' },
    observation: { ...observation, meetupUrl: direct }, events: [event],
    aliases: [alias('meetup_id', meetup)],
    observations: [{ ...observation, scopeId: scope.id, eventId: event.id }] });
  assert.equal(resolveIdentity(input).status, 'new_event');
  assert.equal(resolveIdentity({ ...input, observation }).status, 'pending_identity');
});

test('different aliases and contradictory source observations stop without merging', () => {
  const input = base({ redirectChain: [short, direct], events: [event,
    { scopeId: scope.id, id: 'event-two' }],
    aliases: [alias('meetup_url', short), alias('meetup_id', meetup, 'event-two')] });
  assert.deepEqual(resolveIdentity(input), { status: 'identity_conflict' });
  assert.equal(resolveIdentity({ ...input, aliases: [alias('meetup_id', meetup)],
    observations: [{ ...observation, scopeId: scope.id, eventId: 'event-two' }] }).status, 'identity_conflict');
});

test('an observed event with an established meetup ID cannot acquire a different ID', () => {
  const result = resolveIdentity(base({ events: [event], aliases: [alias('meetup_id', other)],
    observations: [{ ...observation, scopeId: scope.id, eventId: event.id }],
    redirectChain: [short, direct] }));
  assert.equal(result.status, 'identity_conflict');
});

test('known source observation permits recovery but does not trust a changed short URL', () => {
  const result = resolveIdentity(base({ events: [event],
    observations: [{ ...observation, scopeId: scope.id, eventId: event.id }] }));
  assert.equal(result.eventId, event.id);
  assert.deepEqual(result.aliasesToAdd, []);
});

test('URL policy rejects arbitrary IDs, lookalike hosts, credentials, fragments and unsafe protocols', () => {
  for (const url of ['https://evil.example/?id=' + meetup,
    'https://meetup.example.evil.example/discover/meetup/' + meetup,
    'https://meetup.example/?id=' + meetup, direct + '/extra',
    direct.replace('https:', 'http:'), direct.replace('https://', 'https://user:pass@'),
    direct + '#fragment', direct.replace('meetup.example', 'meetup.example:444'),
    direct + ' ', 'https://meetup.example\\@evil.example/' + meetup]) {
    assert.equal(parseUrl(url, policy), null);
  }
  assert.equal(parseUrl(short, policy).url, short);
  assert.notEqual(parseUrl(short.toLowerCase(), policy).url, short);
});

test('redirect trace must begin at the observation and contain only approved bounded hops', () => {
  for (const redirectChain of [[direct], [short, 'https://evil.example/', direct],
    Array(10).fill(short)]) {
    assert.equal(resolveIdentity(base({ redirectChain })).status, 'invalid_evidence');
  }
  assert.equal(resolveIdentity(base({ redirectChain: [short, direct, direct.replace(meetup, other)] })).status,
    'identity_conflict');
});

test('invalid scope and dangling alias state cannot become new events', () => {
  assert.equal(resolveIdentity(base({ scope: { ...scope, enabled: false } })).status, 'invalid_scope');
  assert.equal(resolveIdentity(base({ scope: { ...scope, sourceChannelId: 'wrong' } })).status, 'invalid_scope');
  assert.equal(resolveIdentity(base({ aliases: [alias('meetup_url', short)] })).status, 'invalid_state');
});

test('decisions do not mutate their input or perform network I/O', () => {
  const input = base({ redirectChain: [short, direct], events: [event], aliases: [alias('meetup_url', short)] });
  const before = JSON.stringify(input);
  const savedFetch = global.fetch;
  global.fetch = () => { throw Error('Unexpected network call'); };
  try { resolveIdentity(input); } finally { global.fetch = savedFetch; }
  assert.equal(JSON.stringify(input), before);
});
