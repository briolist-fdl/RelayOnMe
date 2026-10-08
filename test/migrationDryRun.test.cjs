'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { migrationDryRun } = require('../src/identity/migrationDryRun');
const fixture = require('./fixtures/relay-migration.synthetic.json');
const fresh = () => structuredClone(fixture);
const context = snapshot => ({ relay_key: snapshot.messages[0].relay_key,
  relay_config_id: 1, creator_discord_user_id: 'private-creator', group_role_ids: ['private-role'] });

test('stable legacy proposal retains message references and is deterministic without mutating input', () => {
  const input = fresh();
  input.contexts.push(context(input));
  const before = JSON.stringify(input);
  const result = migrationDryRun(input);
  assert.equal(result.candidates[0].targetMessageId, input.messages[0].target_message_id);
  assert.equal(result.candidates[0].sourceMessageId, input.messages[0].source_message_id);
  assert.equal(result.report.summary.contextCandidates, 1);
  assert.equal(result.report.contexts[0].requiresRoleValidation, true);
  assert.equal(result.report.activationApproved, false);
  assert.deepEqual(migrationDryRun(input), result);
  assert.equal(JSON.stringify(input), before);
  assert(!JSON.stringify(result.report).includes('private-'));
});

test('mutable and unknown legacy identities block creation in their scope', () => {
  for (const key of ['campfire:fallback:private-title', 'legacy:target:message',
    'https://short.example/Unverified', 'campfire:meetup:not-a-uuid', 'https://evil.example/?id=123']) {
    const input = fresh();
    input.messages[0].relay_key = key;
    const { report, candidates } = migrationDryRun(input);
    assert.equal(candidates.length, 0);
    assert.equal(report.blockedScopes.length, 1);
    assert.equal(report.messages[0].reason, 'identity_unproven');
    assert(!JSON.stringify(report).includes(key));
  }
});

test('missing, changed or ambiguous destination blocks activation instead of guessing', () => {
  for (const mutate of [s => { s.configs = []; },
    s => { s.configs[0].target_channel_id = 'changed-target'; },
    s => { s.configs.push({ ...s.configs[0], id: 2 }); }]) {
    const input = fresh(); mutate(input);
    const { report, candidates } = migrationDryRun(input);
    assert.equal(candidates.length, 0);
    assert.equal(report.unplacedBlocker, true);
  }
});

test('every conflicting legacy key, destination reference and canonical identity is withheld', () => {
  for (const mutate of [s => s.messages.push({ ...s.messages[0] }),
    s => s.messages.push({ ...s.messages[0], relay_key: s.messages[0].relay_key.replaceAll('a', 'b') }),
    s => s.messages.push({ ...s.messages[0], target_message_id: 'different-message',
      relay_key: s.messages[0].relay_key.replace('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA') })]) {
    const input = fresh(); mutate(input);
    const { report, candidates } = migrationDryRun(input);
    assert.equal(candidates.length, 0);
    assert.equal(report.summary.messageUnresolved, 2);
    assert(report.messages.every(row => row.reason === 'duplicate_identity_or_target'));
  }
});

test('context from a different or recreated config is withheld and blocks affected scopes', () => {
  const input = fresh();
  input.contexts.push({ ...context(input), relay_config_id: 2 });
  const { report } = migrationDryRun(input);
  assert.equal(report.summary.contextUnresolved, 1);
  assert.equal(report.unplacedBlocker, true);
  assert.equal(report.blockedScopes.length, 1);
});

test('duplicate contexts and malformed role data cannot be candidates', () => {
  for (const mutate of [s => s.contexts.push(context(s), context(s)),
    s => s.contexts.push({ ...context(s), group_role_ids: 'not-an-array' })]) {
    const input = fresh(); mutate(input);
    const { report } = migrationDryRun(input);
    assert.equal(report.summary.contextCandidates, 0);
    assert.equal(report.summary.contextUnresolved, input.contexts.length);
  }
});

test('invalid config or duplicate config ID produces a global blocker', () => {
  for (const mutate of [s => { s.configs[0].guild_id = ''; },
    s => { s.configs.push({ ...s.configs[0], source_channel_id: 'other', target_channel_id: 'other' }); }]) {
    const input = fresh(); mutate(input);
    const { report } = migrationDryRun(input);
    assert.equal(report.unplacedBlocker, true);
    assert.equal(report.summary.messageCandidates, 0);
  }
});

test('disabled configs still own legacy mappings; removing a source reference requires review', () => {
  const input = fresh();
  input.configs[0].enabled = false;
  assert.equal(migrationDryRun(input).candidates.length, 1);
  delete input.messages[0].source_channel_id;
  assert.equal(migrationDryRun(input).report.unplacedBlocker, true);
});

test('missing snapshot tables cannot be silently treated as empty', () => {
  for (const input of [null, {}, { version: 1, configs: [], messages: [] },
    { version: 1, configs: [], messages: [null], contexts: [] }]) {
    assert.throws(() => migrationDryRun(input), /version 1 snapshot/);
  }
});

test('URL legacy identity requires explicit policy and a full supported meetup path', () => {
  const input = fresh();
  input.messages[0].relay_key = 'https://meetup.example/discover/meetup/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  assert.equal(migrationDryRun(input).candidates.length, 0);
  assert.equal(migrationDryRun(input, { meetupHosts: ['meetup.example'] }).candidates.length, 1);
});

test('CLI prints sanitized dry-run only and does not import runtime, credentials or database modules', () => {
  const run = spawnSync(process.execPath, [path.join(__dirname, '../scripts/relay-identity-dry-run.cjs'),
    path.join(__dirname, 'fixtures/relay-migration.synthetic.json')], { encoding: 'utf8',
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.summary.messageCandidates, 1);
  assert(!run.stdout.includes('synthetic-target-message'));
  assert.equal(report.activationApproved, false);
});

test('CLI error does not echo potentially sensitive input or filenames', () => {
  const run = spawnSync(process.execPath, [path.join(__dirname, '../scripts/relay-identity-dry-run.cjs'),
    'private-secret-missing.json'], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  assert(!run.stderr.includes('private-secret'));
});

test('CLI returns exit 2 for unresolved mappings without printing fallback titles', () => {
  const run = spawnSync(process.execPath, [path.join(__dirname, '../scripts/relay-identity-dry-run.cjs'),
    path.join(__dirname, 'fixtures/relay-migration.blocked.synthetic.json')], { encoding: 'utf8' });
  assert.equal(run.status, 2, run.stderr);
  assert.equal(JSON.parse(run.stdout).summary.messageUnresolved, 1);
  assert(!run.stdout.includes('PRIVATE_SYNTHETIC_TITLE'));
});
