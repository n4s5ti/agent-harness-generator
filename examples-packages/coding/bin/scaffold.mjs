#!/usr/bin/env node
import { execSync } from 'node:child_process';
import process from 'node:process';

const name = process.argv[2] || 'my-bot';
const extraArgs = process.argv.slice(3);

const cmd = [
  'npx',
  '--yes',
  'metaharness@latest',
  JSON.stringify(name),
  '--template',
  'vertical:coding',
  '--host',
  'claude-code',
  '--force',
  ...extraArgs.map((a) => JSON.stringify(a)),
].join(' ');

try {
  execSync(cmd, { stdio: 'inherit' });
} catch (err) {
  console.error('\nmetaharness failed to scaffold the coding vertical.');
  console.error(err && err.message ? err.message : err);
  process.exit(typeof err?.status === 'number' ? err.status : 1);
}

console.log('');
console.log(`Next steps:`);
console.log(`  cd ${name} && npm install`);
console.log(`  harness doctor`);
console.log(`  claude --plugin-dir . "Ship your first feature"`);
