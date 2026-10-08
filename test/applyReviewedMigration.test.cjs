'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseArguments, expectedDatabase, validateInputs, fingerprintBackup } = require('../scripts/apply-reviewed-v2-migration.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('reviewed migration requires an explicit apply command and absolute artifact paths', () => {
  assert.equal(parseArguments([]), null);
  assert.equal(parseArguments(['--apply', '--review=x', '--contexts=y']), null);
  assert.deepEqual(parseArguments(['--apply', '--backup=C:\\backup.dump', '--review=C:\\review.json', '--contexts=C:\\contexts.json']),
    { backupPath: 'C:\\backup.dump', reviewPath: 'C:\\review.json', contextPath: 'C:\\contexts.json' });
  assert.equal(expectedDatabase('postgresql://user:pass@host.example:5432/relay'), 'relay');
  assert.throws(() => expectedDatabase('https://example.com'));
  assert.doesNotThrow(() => validateInputs({ version: 1, activationApproved: false, reviewedExclusions: [] },
    { version: 1, activationApproved: false, attestations: [] }));
  assert.throws(() => validateInputs({}, {}));
});

test('reviewed migration requires a nonempty existing backup and emits a stable fingerprint', () => {
  const backup = path.join(os.tmpdir(), `relayonme-backup-${process.pid}.dump`);
  fs.writeFileSync(backup, 'backup bytes');
  try {
    assert.equal(fingerprintBackup(backup), '7171b7ccbaa1ac3767c1e75815c6c5bca6634f141b55b4d1a398ddf2a76b75df');
    assert.throws(() => fingerprintBackup(path.join(os.tmpdir(), 'does-not-exist.dump')));
  } finally { fs.unlinkSync(backup); }
});
