#!/usr/bin/env node
import { execSync } from 'node:child_process';
import process from 'node:process';

const args = process.argv.slice(2);
const name = args[0] && !args[0].startsWith('-') ? args[0] : 'my-bot';
const extra = (args[0] && !args[0].startsWith('-') ? args.slice(1) : args)
  .map((a) => (/\s/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
  .join(' ');

const cmd = [
  'npx',
  '--yes',
  'metaharness@latest',
  name,
  '--template',
  'vertical:support',
  '--host',
  'claude-code',
  '--force',
  extra,
]
  .filter(Boolean)
  .join(' ');

try {
  execSync(cmd, { stdio: 'inherit' });
} catch (err) {
  console.error(`\nmetaharness failed: ${err.message || err}`);
  process.exit(typeof err.status === 'number' ? err.status : 1);
}

console.log(`\nScaffolded support harness at ./${name}`);
console.log(`Next: cd ${name} && npm install && harness doctor`);
console.log(`Then: claude -p --plugin-dir ${name} "Triage ticket: <paste ticket here>"`);
