'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const discord = require('discord.js');

async function setup() {
  const callbacks = new Map();
  let saved;
  vm.runInNewContext(fs.readFileSync(require.resolve('../index.js'), 'utf8'), {
    require(name) {
      if (name === 'dotenv') return { config() {} };
      if (name === 'discord.js') return { ...discord, Client: class {
        user = { tag: 'test' }; once(event, callback) { callbacks.set(event, callback); }
        on(event, callback) { callbacks.set(event, callback); } login() {}
      } };
      if (name === './initDb') return { initDb: async () => {} };
      if (name === './db') return { pool: { query: async () => ({ rows: [{ ready: true }] }) } };
      if (name === './relayConfigStore') return { getRelayConfigByGuildAndSourceChannel: async () => null,
        saveRelayConfig: async input => { saved = input; return { parser: input.parser,
          source_channel_id: input.sourceChannelId, target_channel_id: input.targetChannelId, enabled: input.enabled }; } };
      if (name === './src/shared/supportDevelopment') return { maybeAddSupportMessage: text => text };
      if (name === './src/sources/matchRelayFilter') return require('../src/sources/matchRelayFilter');
      if (name === './src/output/renderRelayOutput') return require('../src/output/renderRelayOutput');
      return {};
    }, process: { env: {} }, console: { log() {}, error() {} }, TypeError, RangeError,
  });
  await callbacks.get('clientReady')();
  return { handle: callbacks.get('interactionCreate'), getSaved: () => saved };
}

function interaction(admin, replies) {
  return { isChatInputCommand: () => true, commandName: 'relay', guildId: 'guild',
    guild: { members: { me: {} } }, inGuild: () => true, memberPermissions: { has: () => admin },
    options: { getSubcommandGroup: () => 'config', getSubcommand: () => 'add',
      getString: name => ({ parser: 'messages', include: 'release | announcement', exclude: 'beta',
        template: '{original_content}', add_text: '**Community update**' })[name] ?? null,
      getRole: () => null, getUser: () => null,
      getChannel: name => ({ id: name, guildId: 'guild', permissionsFor: () => ({ has: () => true }) }) },
    reply: async payload => replies.push(payload),
  };
}

test('server admin saves filters and output with message relay disabled until tested', async () => {
  const state = await setup(), replies = [];
  await state.handle(interaction(true, replies));
  assert.equal(state.getSaved().enabled, false);
  assert.deepEqual([...state.getSaved().contentFilter.includeKeywords], ['release', 'announcement']);
  assert.equal(state.getSaved().outputConfig.suffix, '**Community update**');
  assert.equal(replies[0].flags, discord.MessageFlags.Ephemeral);
  assert.match(replies[0].content, /relay preview/);
});

test('non-admin cannot create or change a relay configuration', async () => {
  const state = await setup(), replies = [];
  await state.handle(interaction(false, replies));
  assert.equal(state.getSaved(), undefined);
  assert.match(replies[0].content, /do not have permission/);
});
