const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function simulate(extraEnv) {
  const calls = [];
  const exits = [];
  function builder() {
    return new Proxy({}, { get(_, key) {
      if (key === 'toJSON') return () => ({});
      return (...args) => { for (const arg of args) if (typeof arg === 'function') arg(builder()); return builder(); };
    } });
  }
  const discord = {
    SlashCommandBuilder: function () { return builder(); },
    ChannelType: { GuildText: 0, GuildAnnouncement: 5 },
    REST: class { setToken() { return this; } async put(route) { calls.push(route); } },
    Routes: { applicationCommands: id => `global/${id}`, applicationGuildCommands: (id, guild) => `guild/${id}/${guild}` },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../deploy-commands.js'), 'utf8'), {
    require(name) {
      if (name === 'dotenv') return { config() {} };
      if (name === 'discord.js') return discord;
      throw Error(`Unexpected import: ${name}`);
    },
    process: { env: { DISCORD_TOKEN: 'fake-test-token', DISCORD_CLIENT_ID: 'app', ...extraEnv }, exit: code => exits.push(code) },
    console: { log() {}, error() {} },
  });
  await new Promise(resolve => setImmediate(resolve));
  return { calls, exits };
}
test('global registration does not require a guild ID', async () => {
  assert.deepEqual(await simulate({ DEPLOY_GLOBAL_COMMANDS: 'true' }), { calls: ['global/app'], exits: [] });
});
test('guild registration targets only the specified guild', async () => {
  assert.deepEqual(await simulate({ GUILD_ID: 'test-guild' }), { calls: ['guild/app/test-guild'], exits: [] });
});
test('missing guild ID in default mode never sends registration', async () => {
  assert.deepEqual(await simulate({}), { calls: [], exits: [1] });
});
