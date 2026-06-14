// SPDX-License-Identifier: MIT
//
// iter 139 — one-shot synthesis: read the iter-136 swarm output and write
// examples-packages/<name>/{package.json, README.md, bin/scaffold.mjs,
// LICENSE}, plus stage the gist bodies under .gist-staging/<name>.md.
//
// Input path passed as argv[2]; defaults to the staged workflow output.
// Idempotent — overwrites.
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageJsonFor, LICENSE_MIT } from './publish-examples-helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

const INPUT = process.argv[2];
if (!INPUT || !existsSync(INPUT)) {
  console.error(`Usage: node write-example-packages.mjs <swarm-output.json>`);
  process.exit(1);
}

// Per-target metadata (mirror the workflow's TARGETS so package.json keywords
// and the kind/host columns are correct).
const KIND = {
  'claude-code': 'host', codex: 'host', hermes: 'host', 'pi-dev': 'host',
  openclaw: 'host', rvm: 'host', copilot: 'host', opencode: 'host',
  devops: 'vertical', legal: 'vertical', research: 'vertical', support: 'vertical',
  trading: 'vertical', education: 'vertical', sales: 'vertical', gaming: 'vertical',
  'repo-maintainer': 'vertical', coding: 'vertical',
};
const HOST_FLAG = {
  'claude-code': 'claude-code', codex: 'codex', hermes: 'hermes', 'pi-dev': 'pi-dev',
  openclaw: 'openclaw', rvm: 'rvm', copilot: 'copilot', opencode: 'opencode',
};

const raw = JSON.parse(readFileSync(INPUT, 'utf8'));
const results = raw.result?.results ?? raw.results ?? [];
if (!Array.isArray(results) || results.length === 0) {
  console.error('No results array found in input.'); process.exit(1);
}

const pkgRoot = join(repoRoot, 'examples-packages');
const gistRoot = join(repoRoot, '.gist-staging');
mkdirSync(pkgRoot, { recursive: true });
mkdirSync(gistRoot, { recursive: true });

let written = 0;
const summary = [];
for (const r of results) {
  if (!r || !r.name) { console.warn('skip malformed result'); continue; }
  const name = r.name;
  const kind = KIND[name] ?? 'vertical';
  const host = HOST_FLAG[name] ?? 'claude-code';
  const target = { name, kind, host };

  const dir = join(pkgRoot, name);
  mkdirSync(join(dir, 'bin'), { recursive: true });

  // package.json
  writeFileSync(join(dir, 'package.json'), packageJsonFor(target, r.description ?? `MetaHarness example — ${name}`), 'utf8');
  // README.md
  writeFileSync(join(dir, 'README.md'), (r.readme ?? `# @metaharness/${name}\n`).replace(/\r\n/g, '\n'), 'utf8');
  // LICENSE
  writeFileSync(join(dir, 'LICENSE'), LICENSE_MIT, 'utf8');
  // bin/scaffold.mjs
  let scaffold = (r.scaffoldJs ?? '').replace(/\r\n/g, '\n');
  if (!scaffold.startsWith('#!')) scaffold = '#!/usr/bin/env node\n' + scaffold;
  const binPath = join(dir, 'bin', 'scaffold.mjs');
  writeFileSync(binPath, scaffold, 'utf8');
  try { chmodSync(binPath, 0o755); } catch { /* windows */ }

  // gist staging — body + tweet header
  const gist = `<!-- tweet: ${(r.tweet ?? '').replace(/\n/g, ' ')} -->\n\n${(r.gistBody ?? '').replace(/\r\n/g, '\n')}`;
  writeFileSync(join(gistRoot, `${name}.md`), gist, 'utf8');

  written++;
  summary.push({ name, kind, host, readmeLen: (r.readme ?? '').length, gistLen: (r.gistBody ?? '').length });
}

console.log(`\n✓ wrote ${written} example packages to examples-packages/`);
console.table(summary);
