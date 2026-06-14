#!/usr/bin/env node
import { execSync } from 'node:child_process';
import process from 'node:process';

const name = process.argv[2] || 'my-bot';
const extra = process.argv.slice(3);

const cmd = [
  'npx',
  '--yes',
  'metaharness@latest',
  JSON.stringify(name),
  '--template',
  'vertical:devops',
  '--host',
  'claude-code',
  '--force',
  ...extra.map((a) => JSON.stringify(a)),
].join(' ');

try {
  execSync(cmd, { stdio: 'inherit' });
  console.log('');
  console.log(`Next: cd ${name} && npm install`);
  console.log(`Then: npx harness doctor`);
  console.log(`Run:  claude -p --plugin-dir ${name} "page: <your incident here>"`);
} catch (err) {
  console.error('[@metaharness/devops] scaffold failed:', err?.message || err);
  process.exit(typeof err?.status === 'number' ? err.status : 1);
}
