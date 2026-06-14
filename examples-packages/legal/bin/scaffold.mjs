#!/usr/bin/env node
import { execSync } from 'node:child_process';
import process from 'node:process';

const name = process.argv[2] || 'my-bot';
const extra = process.argv.slice(3);

const args = [
  '--yes',
  'metaharness@latest',
  name,
  '--template',
  'vertical:legal',
  '--host',
  'claude-code',
  '--force',
  ...extra,
];

try {
  execSync(`npx ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`, {
    stdio: 'inherit',
  });
} catch (err) {
  process.exit(typeof err?.status === 'number' ? err.status : 1);
}

console.log('');
console.log(`Next steps:`);
console.log(`  cd ${name} && npm install`);
console.log(`  harness doctor   # verify Claude Code + MCP wiring, then drop contracts into inputs/`);
