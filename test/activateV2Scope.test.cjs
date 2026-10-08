'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseArguments, validateDeltaResult } = require('../scripts/activate-v2-scope.cjs');

test('scope activation requires an explicit scope, backup, and saved delta result', () => {
  assert.equal(parseArguments([]), null);
  assert.equal(parseArguments(['--activate', '--scope=s', '--backup=C:\\backup.dump']), null);
  assert.deepEqual(parseArguments(['--activate', '--scope=s', '--backup=C:\\backup.dump', '--delta-result=C:\\delta.json']), {
    scopeId: 's', backupPath: 'C:\\backup.dump', deltaResultPath: 'C:\\delta.json'
  });
});

test('scope activation accepts only a reviewed delta tied to the same backup', () => {
  const backupSha256 = 'a'.repeat(64);
  assert.doesNotThrow(() => validateDeltaResult({ status: 'applied', activationApproved: false,
    backupSha256, identityInserted: 0, contextInserted: 0 }, backupSha256));
  assert.throws(() => validateDeltaResult({ status: 'applied', activationApproved: false,
    backupSha256: 'b'.repeat(64), identityInserted: 0, contextInserted: 0 }, backupSha256));
  assert.throws(() => validateDeltaResult({ status: 'applied', activationApproved: true,
    backupSha256, identityInserted: 0, contextInserted: 0 }, backupSha256));
});
