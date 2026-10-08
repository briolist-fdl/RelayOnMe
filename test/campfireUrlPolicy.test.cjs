'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { campfireUrlPolicy: policy } = require('../src/identity/campfireUrlPolicy');
const { resolveIdentity, parseUrl } = require('../src/identity/resolveIdentity');
const { migrationDryRun } = require('../src/identity/migrationDryRun');
const fixture = require('./fixtures/campfire-public-route.observed.json');

test('observed old and new Campfire direct routes produce the same meetup identity offline', () => {
  for (const request of fixture.requests) {
    assert.equal(parseUrl(request.url, policy).meetupId, fixture.meetupId);
    assert.equal(parseUrl(request.url), null); // production policy remains opt-in
  }
});

test('recorded domain redirect preserves the existing event and proposes the new URL alias', () => {
  const oldUrl = fixture.requests[0].url;
  const newUrl = fixture.requests[1].url;
  const result = resolveIdentity({
    scope: { id: 'scope', sourceChannelId: 'source', enabled: true },
    observation: { sourceChannelId: 'source', sourceMessageId: 'message', meetupUrl: oldUrl },
    redirectChain: [oldUrl, newUrl], policy,
    events: [{ scopeId: 'scope', id: 'event' }],
    aliases: [{ scopeId: 'scope', eventId: 'event', type: 'meetup_url', value: oldUrl }],
  });
  assert.equal(result.status, 'existing_event');
  assert.equal(result.eventId, 'event');
  assert(result.aliasesToAdd.some(alias => alias.type === 'meetup_url' && alias.value === newUrl));
  assert(result.aliasesToAdd.some(alias => alias.type === 'meetup_id' && alias.value === fixture.meetupId));
});

test('knowing the short-link host never makes an unresolved short link a new event', () => {
  const result = resolveIdentity({
    scope: { id: 'scope', sourceChannelId: 'source', enabled: true },
    observation: { sourceChannelId: 'source', sourceMessageId: 'message',
      meetupUrl: 'https://cmpf.re/SYNTHETIC-NOT-FETCHED', type: 'updated' },
    policy, migrationReady: true,
  });
  assert.deepEqual(result, { status: 'pending_identity' });
});

test('legacy direct URL is only a candidate when the caller explicitly enables verified hosts', () => {
  const snapshot = structuredClone(require('./fixtures/relay-migration.synthetic.json'));
  snapshot.messages[0].relay_key = fixture.requests[1].url;
  assert.equal(migrationDryRun(snapshot).candidates.length, 0);
  assert.equal(migrationDryRun(snapshot, policy).candidates[0].meetupId, fixture.meetupId);
});

test('real-host policy rejects lookalikes and arbitrary query IDs and cannot be mutated', () => {
  assert.equal(parseUrl(fixture.requests[1].url.replace('scopely.com', 'scopely.com.evil.example'), policy), null);
  assert.equal(parseUrl('https://campfire.scopely.com/?id=' + fixture.meetupId, policy), null);
  assert.throws(() => policy.shortHosts.push('evil.example'), TypeError);
  assert.throws(() => { policy.meetupHosts = []; }, TypeError);
});
