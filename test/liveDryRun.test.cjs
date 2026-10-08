'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { migrationDryRun } = require('../src/identity/migrationDryRun');
const { summarize } = require('../scripts/relay-v2-live-dry-run.cjs');
const fixture = require('./fixtures/relay-migration.synthetic.json');

test('live dry-run summary exposes counts but no stored identifiers', () => {
  const snapshot = structuredClone(fixture);
  snapshot.messages[0].relay_key = 'campfire:fallback:private-title';
  const summary = summarize(migrationDryRun(snapshot).report, snapshot);
  assert.equal(summary.status, 'blocked');
  assert.deepEqual(summary.messageUnresolvedReasons, { identity_unproven: 1 });
  assert.equal(summary.summary.messageUnresolved, 1);
  assert.equal(summary.activationApproved, false);
  assert.deepEqual(summary.unprovenKeyKinds, { campfire_fallback: 1 });
  assert.deepEqual(summary.fallbackWithSourceMessage, { yes: 1, no: 0 });
  assert.deepEqual(summary.scopeMatchCounts, { no_matching_config: 0, multiple_matching_configs: 0 });
  assert(!JSON.stringify(summary).includes('private-title'));
  assert(!JSON.stringify(summary).includes('synthetic-target-message'));
});
