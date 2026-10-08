'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { resolveIdentity } = require('../src/identity/resolveIdentity');
const { campfireUrlPolicy: policy } = require('../src/identity/campfireUrlPolicy');
const fixture = require('./fixtures/campfire-short-route.sanitized.json');

test('existing adapter falls back from observed HEAD 405 to GET 307 without loading runtime', async () => {
  const calls = [];
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, '../adapters/campfireAdapter.js'), 'utf8');
  vm.runInNewContext(source, {
    module, URL, AbortController, setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    require(name) {
      assert.equal(name, '../relayEngine');
      return { relayOrEditMessage() { throw Error('Unexpected delivery'); } };
    },
    async fetch(url, options) {
      assert.equal(url, fixture.head.url);
      assert.equal(options.redirect, 'manual');
      calls.push(options.method);
      const response = options.method === 'HEAD' ? fixture.head : fixture.requests[0];
      return { status: response.status, headers: { get(name) {
        assert.equal(name, 'location'); return response.location;
      } } };
    },
  });
  const key = await module.exports.createCampfireRelayKey({ meetupUrl: fixture.head.url });
  assert.equal(key, 'campfire:meetup:' + fixture.meetupId);
  assert.deepEqual(calls, ['HEAD', 'GET']);
});

test('observed short-link chain proposes one identity and recovers it when resolution later fails', () => {
  const input = {
    scope: { id: 'scope', sourceChannelId: 'source', enabled: true }, policy, migrationReady: true,
    observation: { sourceMessageId: 'original', sourceChannelId: 'source', meetupUrl: fixture.head.url },
  };
  assert.equal(resolveIdentity(input).status, 'pending_identity');
  const first = resolveIdentity({ ...input, redirectChain: fixture.requests.map(row => row.url) });
  assert.equal(first.status, 'new_event');
  assert.equal(first.aliasesToAdd.length, 4);
  const events = [{ scopeId: 'scope', id: 'event' }];
  const aliases = first.aliasesToAdd.map(alias => ({ ...alias, scopeId: 'scope', eventId: 'event' }));
  const update = resolveIdentity({ ...input, events, aliases,
    observation: { ...input.observation, sourceMessageId: 'update', title: 'Changed',
      creatorDiscordUserId: 'other-editor' } });
  assert.equal(update.status, 'existing_event');
  assert.equal(update.eventId, 'event');
  assert.deepEqual(update.aliasesToAdd, []);
  for (const row of fixture.requests.slice(1)) {
    assert.equal(resolveIdentity({ ...input, events, aliases,
      observation: { ...input.observation, meetupUrl: row.url } }).eventId, 'event');
  }
});

test('a different unresolved short code is never merged on matching title or creator', () => {
  const result = resolveIdentity({
    scope: { id: 'scope', sourceChannelId: 'source', enabled: true }, policy, migrationReady: true,
    observation: { sourceMessageId: 'update', sourceChannelId: 'source',
      meetupUrl: 'https://cmpf.re/OTHER-SYNTHETIC', title: 'Same', creatorDiscordUserId: 'same' },
    events: [{ scopeId: 'scope', id: 'event' }],
    aliases: [{ scopeId: 'scope', eventId: 'event', type: 'meetup_url', value: fixture.head.url }],
  });
  assert.equal(result.status, 'pending_identity');
});
