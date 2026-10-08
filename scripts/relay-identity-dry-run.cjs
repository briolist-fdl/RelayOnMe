'use strict';

const fs = require('node:fs');
const { migrationDryRun } = require('../src/identity/migrationDryRun');

function main(args) {
  if (args.length !== 1 || args[0].startsWith('-')) {
    process.stderr.write('Usage: node scripts/relay-identity-dry-run.cjs <snapshot.json>\n');
    return 1;
  }
  try {
    const stat = fs.statSync(args[0]);
    if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new Error('invalid input');
    const snapshot = JSON.parse(fs.readFileSync(args[0], 'utf8'));
    const { report } = migrationDryRun(snapshot);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.unplacedBlocker || report.blockedScopes.length ? 2 : 0;
  } catch {
    // Parser and file errors can contain input values; never echo them.
    process.stderr.write('Dry-run failed: input must be a valid version 1 snapshot, at most 10 MiB.\n');
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { main };
