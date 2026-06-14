#!/usr/bin/env node
import { execSync } from 'node:child_process';
import process from 'node:process';

const args = process.argv.slice(2);
const name = args[0] && !args[0].startsWith('-') ? args[0] : 'my-bot';
const extra = (args[0] && !args[0].startsWith('-') ? args.slice(1) : args)
  .map((a) => JSON.stringify(a))
  .join(' ');

const cmd = `npx --yes metaharness@latest ${JSON.stringify(name)} --template minimal --host openclaw --force${extra ? ' ' + extra : ''}`;

try {
  execSync(cmd, { stdio: 'inherit' });
} catch (err) {
  console.error(`\nmetaharness failed: ${err && err.message ? err.message : err}`);
  process.exit(typeof err?.status === 'number' ? err.status : 1);
}

console.log('');
console.log(`Next steps:`);
console.log(`  1. cd ${name}`);
console.log(`  2. npm install`);
console.log(`  3. harness doctor   # verify the .openclaw/ config`);
