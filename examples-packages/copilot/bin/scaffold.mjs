#!/usr/bin/env node
import { execSync } from 'node:child_process';
import process from 'node:process';

const args = process.argv.slice(2);
const name = args[0] && !args[0].startsWith('--') ? args[0] : 'my-bot';
const extra = (args[0] === name ? args.slice(1) : args).join(' ');

const cmd = `npx --yes metaharness@latest ${name} --template minimal --host copilot --force${extra ? ' ' + extra : ''}`;

try {
  execSync(cmd, { stdio: 'inherit' });
  console.log('');
  console.log(`Next steps:`);
  console.log(`  cd ${name} && npm install`);
  console.log(`  harness doctor   # verify VSCode + mcp.json are wired up`);
  console.log(`  code .           # open in VSCode and enable Copilot MCP servers`);
} catch (err) {
  console.error(`metaharness scaffold failed: ${err.message}`);
  process.exit(err.status || 1);
}
