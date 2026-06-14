#!/usr/bin/env node
import { execSync } from 'node:child_process';
import process from 'node:process';

const name = process.argv[2] || 'my-bot';
const extra = process.argv.slice(3);

const args = [
  'npx',
  '--yes',
  'metaharness@latest',
  name,
  '--template',
  'vertical:sales',
  '--host',
  'claude-code',
  '--force',
  ...extra,
];

const cmd = args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ');

try {
  execSync(cmd, { stdio: 'inherit' });
  console.log('');
  console.log(`Sales pod scaffolded into ./${name}`);
  console.log(`Next: cd ${name} && npm install && harness doctor`);
  console.log(`Then: claude -p --plugin-dir ${name} "Run the sales pipeline on lead: <your lead>"`);
} catch (err) {
  console.error(`metaharness scaffold failed: ${err.message || err}`);
  process.exit(typeof err.status === 'number' ? err.status : 1);
}
