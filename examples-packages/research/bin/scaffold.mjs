#!/usr/bin/env node
import { execSync } from 'node:child_process';
import process from 'node:process';

const [, , rawName, ...extraArgs] = process.argv;
const name = rawName && !rawName.startsWith('-') ? rawName : 'my-bot';
const forwarded = (rawName && rawName.startsWith('-') ? [rawName, ...extraArgs] : extraArgs)
  .map((a) => (a.includes(' ') ? JSON.stringify(a) : a))
  .join(' ');

const cmd = [
  'npx --yes metaharness@latest',
  JSON.stringify(name),
  '--template vertical:research',
  '--host claude-code',
  '--force',
  forwarded,
]
  .filter(Boolean)
  .join(' ');

try {
  execSync(cmd, { stdio: 'inherit' });
} catch (err) {
  console.error(`\nmetaharness failed (exit ${err.status ?? 1}). See output above.`);
  process.exit(err.status ?? 1);
}

console.log('');
console.log(`Next steps:`);
console.log(`  1. cd ${name} && npm install`);
console.log(`  2. npx harness doctor    # verify Claude Code + MCP servers`);
console.log(`  3. Open in Claude Code and run /research <your topic>`);
