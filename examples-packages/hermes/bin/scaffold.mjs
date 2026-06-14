#!/usr/bin/env node
import { execSync } from 'node:child_process';
import process from 'node:process';

const [, , rawName, ...extra] = process.argv;
const name = rawName && !rawName.startsWith('-') ? rawName : 'my-bot';
const passthrough = (rawName && rawName.startsWith('-') ? [rawName, ...extra] : extra)
  .map((arg) => (arg.includes(' ') ? JSON.stringify(arg) : arg))
  .join(' ');

const cmd = [
  'npx --yes metaharness@latest',
  JSON.stringify(name),
  '--template minimal',
  '--host hermes',
  '--force',
  passthrough,
]
  .filter(Boolean)
  .join(' ');

try {
  execSync(cmd, { stdio: 'inherit' });
} catch (err) {
  console.error('\n[hermes] metaharness scaffold failed.');
  process.exit(typeof err.status === 'number' ? err.status : 1);
}

console.log('');
console.log(`Scaffolded ${name} with the Hermes minimal harness.`);
console.log(`Next: cd ${name} && npm install`);
console.log('Then: npx harness doctor');
