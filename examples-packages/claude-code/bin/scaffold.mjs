#!/usr/bin/env node
import { execSync } from 'node:child_process';
import process from 'node:process';

const [, , rawName, ...extra] = process.argv;
const name = rawName && !rawName.startsWith('-') ? rawName : 'my-bot';
const forwarded = (rawName && rawName.startsWith('-') ? [rawName, ...extra] : extra)
  .map((arg) => (arg.includes(' ') ? JSON.stringify(arg) : arg))
  .join(' ');

const cmd = [
  'npx --yes metaharness@latest',
  JSON.stringify(name),
  '--template minimal',
  '--host claude-code',
  '--force',
  forwarded,
]
  .filter(Boolean)
  .join(' ');

try {
  execSync(cmd, { stdio: 'inherit' });
} catch (err) {
  console.error(`\n[@metaharness/claude-code] metaharness failed to scaffold "${name}".`);
  process.exit(typeof err?.status === 'number' ? err.status : 1);
}

console.log('');
console.log(`Next steps:`);
console.log(`  cd ${name} && npm install`);
console.log(`  npx harness doctor`);
console.log(`  claude -p --plugin-dir . "summarize the repo and propose a first task"`);
