// SPDX-License-Identifier: MIT
//
// iter 140 — batch-publish the @metaharness/* example packages.
//
// PREREQUISITE: the @metaharness npm ORG must exist (create it at
// npmjs.com/org/create with ruvnet as owner). `npm org` CLI only manages
// members — it cannot create the org.
//
// Usage:
//   node scripts/publish-examples-batch.mjs            # publish all
//   node scripts/publish-examples-batch.mjs --dry-run  # pack only, no publish
//   node scripts/publish-examples-batch.mjs hermes devops   # subset
//
// Idempotent-ish: npm rejects a re-publish of an existing version, which
// the script reports as SKIP rather than a hard failure, so re-running
// after a partial batch only publishes the missing ones.
import { execSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', 'examples-packages');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const only = args.filter((a) => !a.startsWith('--'));

const all = readdirSync(root).filter((d) => existsSync(join(root, d, 'package.json')));
const targets = only.length ? all.filter((d) => only.includes(d)) : all;

const results = [];
for (const name of targets) {
  const dir = join(root, name);
  try {
    if (dryRun) {
      execSync('npm pack --dry-run', { cwd: dir, stdio: 'pipe' });
      results.push({ name, status: 'PACK-OK' });
    } else {
      execSync('npm publish --access public', { cwd: dir, stdio: 'pipe' });
      results.push({ name, status: 'PUBLISHED' });
    }
  } catch (err) {
    const msg = String(err.stderr ?? err.message ?? err);
    if (/cannot publish over|previously published|403/.test(msg)) {
      results.push({ name, status: 'SKIP (exists)' });
    } else if (/Scope not found|404/.test(msg)) {
      results.push({ name, status: 'FAIL — @metaharness org not created yet' });
    } else {
      results.push({ name, status: 'FAIL', detail: msg.slice(0, 120) });
    }
  }
}

console.log('\n@metaharness/* publish batch:');
for (const r of results) {
  console.log(`  ${r.name.padEnd(18)} ${r.status}${r.detail ? ' — ' + r.detail : ''}`);
}
const failed = results.filter((r) => r.status.startsWith('FAIL'));
console.log(`\n${results.length - failed.length}/${results.length} ok`);
process.exit(failed.length ? 1 : 0);
