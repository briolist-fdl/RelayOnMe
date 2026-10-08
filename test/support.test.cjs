const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute only the support helper with isolated environment and Discord constants.
// No entry point, dotenv, database or Discord connection is loaded.
function loadSupport(env = {}, random = 0.1) {
  let source = fs.readFileSync(path.join(__dirname, '../src/shared/supportDevelopment.js'), 'utf8');
  source = source.replace(/^import .*;\r?\n/gm, '').replace(/export \{/, 'module.exports = {');
  const bot = { name: 'Test bot', githubUrl: 'https://example.com', supportMessageChance: 0.33 };
  const getBotConfig = () => bot;
  const MessageFlags = { Ephemeral: 64 };
  const context = {
    module: { exports: {} }, process: { env },
    Math: Object.assign(Object.create(Math), { random: () => random }),
    MessageFlags, getBotConfig,
    require(name) {
      if (name === 'discord.js') return { MessageFlags };
      if (name === './botDirectory') return { getBotConfig };
      throw Error(`Unexpected import: ${name}`);
    },
  };
  vm.runInNewContext(source, context);
  return context.module.exports;
}

test('unset, blank and invalid chance use the bot default', () => {
  for (const chance of [undefined, '', '  ', 'invalid']) {
    const helper = loadSupport({ SUPPORT_MESSAGE_CHANCE: chance });
    assert.match(helper.maybeAddSupportMessage('Done'), /Test bot/);
  }
});
test('explicit zero and disabled support preserve the response', () => {
  assert.equal(loadSupport({ SUPPORT_MESSAGE_CHANCE: '0' }).maybeAddSupportMessage('Done'), 'Done');
  assert.equal(loadSupport({ SUPPORT_MESSAGES_ENABLED: 'false' }).maybeAddSupportMessage('Done'), 'Done');
});
test('support footer cannot make a valid response exceed 2000 characters', () => {
  const helper = loadSupport({ SUPPORT_MESSAGE_CHANCE: '1' });
  for (const length of [1900, 1999, 2000]) {
    const content = 'x'.repeat(length);
    assert.equal(helper.maybeAddSupportMessage(content), content);
  }
  assert.match(helper.maybeAddSupportMessage('Done'), /Test bot/);
});
test('chance threshold and reply visibility are retained', () => {
  assert.equal(loadSupport({}, 0.5).maybeAddSupportMessage('Done'), 'Done');
  const helper = loadSupport();
  assert.equal(helper.successReply('Done').flags, 64);
  assert.equal(helper.plainEphemeralReply('Done').content, 'Done');
  assert.equal(helper.successEdit('Done').flags, undefined);
});
