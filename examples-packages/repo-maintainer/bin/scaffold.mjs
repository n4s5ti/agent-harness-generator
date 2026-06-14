#!/usr/bin/env node
import { execSync } from 'node:child_process';
import process from 'node:process';

const name = process.argv[2] || 'my-bot';
const extra = process.argv.slice(3);

const cmd = [
  'npx',
  '--yes',
  'metaharness@latest',
  name,
  '--template',
  'vertical:repo-maintainer',
  '--host',
  'claude-code',
  '--force',
  ...extra,
].join(' ');

try {
  execSync(cmd, { stdio: 'inherit' });
} catch (err) {
  console.error(`\nmetaharness failed: ${err.message}`);
  process.exit(typeof err.status === 'number' ? err.status : 1);
}

console.log(`\nScaffolded ${name}. Next steps:`);
console.log(`  cd ${name} && npm install`);
console.log(`  harness doctor`);
console.log(`  claude -p --plugin-dir . "/triage #1"`);
