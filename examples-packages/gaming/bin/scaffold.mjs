#!/usr/bin/env node
import { execSync } from 'node:child_process';
import process from 'node:process';

const [, , rawName, ...extra] = process.argv;
const name = rawName && !rawName.startsWith('-') ? rawName : 'my-bot';
const forwarded = rawName && rawName.startsWith('-') ? [rawName, ...extra] : extra;

const args = [
  'npx',
  '--yes',
  'metaharness@latest',
  name,
  '--template',
  'vertical:gaming',
  '--host',
  'claude-code',
  '--force',
  ...forwarded,
];

try {
  execSync(args.join(' '), { stdio: 'inherit' });
} catch (err) {
  process.exit(typeof err?.status === 'number' ? err.status : 1);
}

process.stdout.write(
  [
    '',
    `  Next steps:`,
    `    cd ${name}`,
    `    npm install && harness doctor`,
    `    claude -p --plugin-dir . "/pitch a co-op deckbuilder set on a generation ship"`,
    '',
  ].join('\n'),
);
