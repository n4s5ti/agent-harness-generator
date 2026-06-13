#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Pre-flight `npm publish --dry-run` for every non-private workspace
// package. Stops the release train BEFORE any registry I/O happens if any
// package has a broken `files`, a missing `bin`, a non-resolvable workspace
// reference, or an invalid version range.
//
// Run as: node scripts/publish-dryrun.mjs
// Used as: publish.yml's pre-publish gate (along with validate-gcp-secrets.mjs).

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

const ROOT = process.cwd();
const PACKAGES_DIR = join(ROOT, 'packages');

function log(tag, msg) { process.stderr.write(`[publish-dryrun] ${tag}: ${msg}\n`); }

async function listPublishablePackages() {
  const out = [];
  const entries = await readdir(PACKAGES_DIR, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const pkgPath = join(PACKAGES_DIR, ent.name, 'package.json');
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
    if (pkg.private === true) continue;
    if (!pkg.name || !pkg.version) continue;
    out.push({ name: pkg.name, version: pkg.version, dir: join(PACKAGES_DIR, ent.name) });
  }
  return out;
}

function parseJsonLoose(s) {
  // Strip Node deprecation warnings and other non-JSON preludes before parse.
  const start = s.indexOf('{');
  if (start === -1) return null;
  try { return JSON.parse(s.slice(start)); } catch { return null; }
}

async function dryRunOne(pkg) {
  // Use shell:true on Windows so npm.cmd resolves; without it execFile ENOENTs.
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  let stdout = '', stderr = '', exitCode = 0;
  try {
    const r = await execFile(npmCmd, ['publish', '--dry-run', '--json'], {
      cwd: pkg.dir,
      maxBuffer: 1024 * 1024 * 8,
      windowsHide: true,
      shell: process.platform === 'win32',
    });
    stdout = r.stdout; stderr = r.stderr;
  } catch (e) {
    stdout = e.stdout || ''; stderr = e.stderr || ''; exitCode = e.code ?? 1;
  }

  const parsed = parseJsonLoose(stdout);
  const txt = (stderr + ' ' + stdout).toLowerCase();

  // Case 1: clean dry-run.
  if (exitCode === 0 && parsed?.name) {
    const fileCount = parsed.entryCount ?? parsed.files?.length ?? 0;
    const sz = parsed.unpackedSize ? `${(parsed.unpackedSize / 1024).toFixed(1)} KB` : '?';
    return { tag: 'PASS', msg: `${fileCount} files, ${sz} unpacked` };
  }

  // Case 2: pack built OK but version already published on registry.
  // npm exits 1 here, but the BUILD is fine — surface as warn-pass so the
  // publish gate doesn't block on a version-not-bumped condition (separate
  // concern handled by the actual publish step).
  if (txt.includes('cannot publish over') || txt.includes('cannot publish over the previously published version')) {
    return { tag: 'WARN', msg: 'build OK, version already on registry (bump before publish)' };
  }

  // Case 3: pack succeeded but no JSON metadata (e.g. dry-run output was
  // suppressed by a warning). Treat as PASS only if exit code was 0.
  if (exitCode === 0) {
    return { tag: 'PASS', msg: 'dry-run succeeded (no JSON metadata)' };
  }

  // Case 4: real failure.
  const oneLine = (stderr || stdout).split('\n').filter(l => l.trim()).slice(-3).join(' | ').slice(0, 300);
  return { tag: 'FAIL', msg: oneLine || 'unknown error' };
}

async function main() {
  const pkgs = await listPublishablePackages();
  if (pkgs.length === 0) {
    log('FAIL', 'no publishable packages found under packages/');
    process.exit(1);
  }
  log('INFO', `checking ${pkgs.length} publishable packages`);
  let pass = 0, warn = 0, fail = 0;
  for (const pkg of pkgs) {
    const r = await dryRunOne(pkg);
    log(r.tag, `${pkg.name}@${pkg.version} — ${r.msg}`);
    if (r.tag === 'PASS') pass++;
    else if (r.tag === 'WARN') warn++;
    else fail++;
  }
  log('INFO', `${pass} pass / ${warn} warn / ${fail} fail`);
  if (fail === 0) {
    log('INFO', 'ALL PACKAGES BUILD-READY — release gate OPEN');
    process.exit(0);
  }
  log('FAIL', `${fail}/${pkgs.length} packages have broken builds`);
  process.exit(1);
}

main().catch(err => {
  log('FAIL', `unexpected: ${err?.stack ?? err}`);
  process.exit(1);
});
