'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const discord = require('discord.js');

function runtime() {
  const handlers = new Map();
  const source = fs.readFileSync(require.resolve('../index.js'), 'utf8');
  vm.runInNewContext(source, {
    require(name) {
      if (name === 'dotenv') return { config() {} };
      if (name === 'discord.js') return { ...discord, Client: class {
        once() {} on(event, handler) { handlers.set(event, handler); } login() {}
      } };
      if (name === './src/demos/relayDemos') return require('../src/demos/relayDemos');
      return {};
    },
    process: { env: {} }, console: { log() {}, error() {} }, TypeError, RangeError,
  });
  return handlers.get('interactionCreate');
}

test('Discord demo replies privately with preview and never requires a live source', async () => {
  const replies = [];
  await runtime()({ isChatInputCommand: () => true, commandName: 'relay',
    options: { getSubcommandGroup: () => null, getSubcommand: () => 'demo',
      getString: name => name === 'example' ? 'news' : null },
    reply: async payload => replies.push(payload),
  });
  assert.equal(replies.length, 1);
  assert.equal(replies[0].flags, discord.MessageFlags.Ephemeral);
  assert.equal(replies[0].allowedMentions.parse.length, 0);
  assert.match(replies[0].embeds[0].title, /Selected news/);
});

test('bad user template produces a private actionable validation response', async () => {
  const replies = [];
  await runtime()({ isChatInputCommand: () => true, commandName: 'relay',
    options: { getSubcommandGroup: () => null, getSubcommand: () => 'demo',
      getString: name => ({ example: 'news', template: '{unsupported}' })[name] ?? null },
    reply: async payload => replies.push(payload),
  });
  assert.equal(replies[0].flags, discord.MessageFlags.Ephemeral);
  assert.match(replies[0].content, /Supported:/);
});

test('real Discord command builder serializes four demo choices and bounded custom text', async () => {
  let commands;
  vm.runInNewContext(fs.readFileSync(require.resolve('../deploy-commands.js'), 'utf8'), {
    require(name) {
      if (name === 'dotenv') return { config() {} };
      if (name === 'discord.js') return { ...discord, REST: class {
        setToken() { return this; } async put(route, body) { commands = body.body; }
      } };
      throw Error('Unexpected import');
    },
    process: { env: { DISCORD_TOKEN: 'test', DISCORD_CLIENT_ID: '12345678901234567', DEPLOY_GLOBAL_COMMANDS: 'true' },
      exit() { throw Error('Registration failed'); } }, console: { log() {}, error() {} },
  });
  await new Promise(resolve => setImmediate(resolve));
  const demo = commands.find(command => command.name === 'relay').options.find(option => option.name === 'demo');
  for (const command of commands) {
    assert.deepEqual(Array.from(command.contexts), [discord.InteractionContextType.Guild]);
    assert.deepEqual(Array.from(command.integration_types), [discord.ApplicationIntegrationType.GuildInstall]);
  }
  assert.equal(demo.options[0].choices.length, 4);
  assert.equal(demo.options[1].max_length, 1500);
  assert.equal(demo.options[2].max_length, 500);
});
