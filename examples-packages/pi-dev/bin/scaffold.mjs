#!/usr/bin/env node
import { execSync } from 'node:child_process';
import process from 'node:process';

const [, , rawName, ...rest] = process.argv;
const name = rawName && !rawName.startsWith('-') ? rawName : 'my-bot';
const extraArgs = (rawName && rawName.startsWith('-') ? [rawName, ...rest] : rest)
  .map((a) => (a.includes(' ') ? JSON.stringify(a) : a))
  .join(' ');

const cmd = `npx --yes metaharness@latest ${name} --template minimal --host pi-dev --force${
  extraArgs ? ' ' + extraArgs : ''
}`;

try {
  execSync(cmd, { stdio: 'inherit' });
  console.log('');
  console.log(`Scaffolded pi.dev harness in ./${name}`);
  console.log(`Next: cd ${name} && npm install`);
  console.log(`Then: harness doctor`);
} catch (err) {
  console.error(`[@metaharness/pi-dev] metaharness failed: ${err.message}`);
  process.exit(typeof err.status === 'number' ? err.status : 1);
}
