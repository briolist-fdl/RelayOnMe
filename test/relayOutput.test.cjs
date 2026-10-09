'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compileRelayOutput } = require('../src/output/renderRelayOutput');
const { buildRelayDemo } = require('../src/demos/relayDemos');

test('output preserves configured Markdown and treats interpolated data as literal text', () => {
  const output = compileRelayOutput({ prefix: '## Community', template: '**{title}**\n<{url}>', suffix: '_See you there!_' });
  assert.equal(output.render({ title: 'A **bold** event {author}', link: 'https://example.com/event' }).content,
    '## Community\n\n**A \\*\\*bold\\*\\* event \\{author\\}**\n<https://example.com/event>\n\n_See you there!_');
});

test('mentions must be explicitly allowlisted and never enable everyone or source-supplied users', () => {
  const role = '12345678901234567';
  const result = compileRelayOutput({ template: '{role_mentions}\n{original_content}', roleIds: [role] })
    .render({ originalContent: '@everyone <@99999999999999999> hello' });
  assert.deepEqual(result.allowedMentions, { parse: [], roles: [role], users: [], repliedUser: false });
  assert.throws(() => compileRelayOutput({ roleIds: ['@everyone'] }));
});

test('unknown fields, unsafe links and oversized output are rejected before sending', () => {
  assert.throws(() => compileRelayOutput({ template: '{secret}' }));
  assert.throws(() => compileRelayOutput({ typo: 'text' }));
  assert.throws(() => compileRelayOutput({ template: '{url}' }).render({ link: 'javascript:alert(1)' }));
  assert.throws(() => compileRelayOutput().render({ summary: 'x'.repeat(1901) }));
  assert.throws(() => compileRelayOutput({ template: '{title}' }).render({}));
});

test('all product demos show selection, rejection and output without starting external integrations', () => {
  for (const id of ['news', 'jobs', 'releases', 'events']) {
    const result = buildRelayDemo(id);
    assert.deepEqual(result.allowedMentions, { parse: [] });
    const embed = result.embeds[0];
    assert.match(embed.fields[1].value, /✓ Selected/);
    assert.match(embed.fields[1].value, /— Skipped/);
    assert(embed.fields[2].value.length > 0);
    assert.match(embed.fields[3].value, /under development/);
  }
  assert.throws(() => buildRelayDemo('toString'));
});

test('demo accepts a custom output template and extra Markdown block', () => {
  const result = buildRelayDemo('news', { template: '**{title}**', suffix: '> Read more in our community channel.' });
  assert.match(result.embeds[0].fields[2].value, /Read more/);
});
