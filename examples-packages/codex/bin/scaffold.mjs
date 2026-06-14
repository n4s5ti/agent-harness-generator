#!/usr/bin/env node
import { execSync } from 'node:child_process';
import process from 'node:process';

const [, , rawName, ...rest] = process.argv;
const name = rawName && !rawName.startsWith('-') ? rawName : 'my-bot';
const extraArgs = (rawName && rawName.startsWith('-') ? [rawName, ...rest] : rest)
  .map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg))
  .join(' ');

const cmd = `npx --yes metaharness@latest ${name} --template minimal --host codex --force${extraArgs ? ' ' + extraArgs : ''}`;

try {
  execSync(cmd, { stdio: 'inherit' });
} catch (err) {
  console.error(`\nmetaharness failed: ${err.message}`);
  process.exit(typeof err.status === 'number' ? err.status : 1);
}

console.log(`\nScaffold ready at ./${name}`);
console.log(`Next: cd ${name} && npm install`);
console.log(`Then: harness doctor`);
