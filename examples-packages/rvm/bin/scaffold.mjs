#!/usr/bin/env node
import { execSync } from 'node:child_process';
import process from 'node:process';

const name = process.argv[2] || 'my-bot';
const extraArgs = process.argv.slice(3);

const cmd = [
  'npx',
  '--yes',
  'metaharness@latest',
  name,
  '--template',
  'minimal',
  '--host',
  'rvm',
  '--force',
  ...extraArgs,
].join(' ');

try {
  execSync(cmd, { stdio: 'inherit' });
  console.log('');
  console.log(`Next steps:`);
  console.log(`  cd ${name} && npm install`);
  console.log(`  harness doctor   # verify the rvm partition is wired correctly`);
} catch (err) {
  process.exit(typeof err.status === 'number' ? err.status : 1);
}
