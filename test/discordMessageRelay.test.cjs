'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepareDiscordPost } = require('../src/sources/prepareDiscordPost');
const { relayDiscordPost } = require('../src/relay/relayDiscordPost');
const { deliverRelay } = require('../src/relay/deliverRelay');
const { createDiscordRuntimeAdapter } = require('../src/relay/createDiscordRuntimeAdapter');

test('message relay filters bot posts and previews custom Markdown without delivery', () => {
  const config = { content_filter: { allowedAuthors: ['bot'], includeKeywords: ['release'], excludeKeywords: ['beta'] },
    output_config: { template: '**{title}**\n{summary}\n<{url}>', suffix: '*Read the release notes.*' } };
  const message = { author: { id: 'bot' }, content: 'New release!',
    embeds: [{ title: 'Version 2', description: 'New features.', url: 'https://example.com/release', fields: [] }] };
  const result = prepareDiscordPost(message, config);
  assert.equal(result.status, 'selected');
  assert.match(result.payload.content, /Read the release notes/);
  assert.deepEqual(result.payload.allowedMentions.parse, []);
  assert.equal(prepareDiscordPost({ ...message, content: 'Release beta' }, config).reason, 'excluded_keyword');
  assert.equal(prepareDiscordPost({ ...message, author: { id: 'other' } }, config).reason, 'author_not_allowed');
  assert.equal(prepareDiscordPost(message, { output_config: { template: '{unknown}' } }).status, 'invalid_output');
});

test('message relay rejects cross-server sources and its own bot/webhooks before storage', async () => {
  const config = { guild_id: 'guild', source_channel_id: 'source', parser: 'messages', enabled: true };
  const client = { user: { id: 'self' } };
  const pool = { connect() { throw Error('Must not access storage'); } };
  const message = { guildId: 'other', channelId: 'source', author: { id: 'bot' } };
  assert.equal((await relayDiscordPost({ pool, client, config, message })).status, 'ignored');
  assert.equal((await relayDiscordPost({ pool, client, config, message: { ...message, guildId: 'guild', author: { id: 'self' } } })).status, 'ignored');
  assert.equal((await relayDiscordPost({ pool, client, config, message: { ...message, guildId: 'guild', webhookId: 'webhook',
    fetchWebhook: async () => ({ owner: { id: 'self' } }) } })).status, 'ignored');
});

test('durable delivery reaches the real Discord adapter with an operation-bound evidence marker', async () => {
  const botId = '11111111111111111', targetId = '22222222222222222', sourceId = '33333333333333333';
  let sent;
  const client = { user: { id: botId }, channels: { fetch: async () => ({ id: targetId,
    messages: { fetch() {} }, send: async payload => { sent = payload; return { id: '44444444444444444' }; } }) } };
  const { transport } = createDiscordRuntimeAdapter({ client });
  const connection = { on() {}, release() {}, query: async sql => {
    if (sql.startsWith('SELECT * FROM relay_identity_v2.scopes')) return { rows: [{ scope_id: 'scope', guild_id: 'guild',
      target_channel_id: targetId, state: 'active', migration_ready: true }] };
    if (sql.startsWith('SELECT event_id')) return { rows: [{ event_id: 'discord-message:' + sourceId }] };
    return { rows: [] };
  } };
  const result = await deliverRelay({ connect: async () => connection }, { scopeId: 'scope', guildId: 'guild',
    eventId: 'discord-message:' + sourceId, sourceMessageId: sourceId, sourceRevision: 1000,
    sourceFingerprint: 'a'.repeat(64), payload: { content: 'Release notes' }, transport });
  assert.equal(result.status, 'created');
  assert.match(sent.content, /RelayOnMe ref: [0-9a-f]{32}$/);
  assert.deepEqual(sent.allowedMentions, { parse: [] });
});
