#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Pre-publish GCP Secret Manager validation. Called from
// .github/workflows/publish.yml before any `npm publish` runs — exits
// non-zero if the publish-side secret fetch would fail.
//
// Verifies (in this order, fail-fast):
//   1. gcloud is on PATH
//   2. active gcloud project resolves
//   3. active gcloud auth principal exists
//   4. NPM_TOKEN secret exists in Secret Manager
//   5. the secret's latest version is fetchable
//   6. the fetched token passes `npm whoami`
//
// Reads required GCP_PROJECT, optional NPM_SECRET_NAME (default NPM_TOKEN)
// from env. Runs all 6 checks with structured output for CI grep.
//
// This is the "fail loud before publish" gate the user asked for.

import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

const PROJECT = process.env.GCP_PROJECT;
const SECRET = process.env.NPM_SECRET_NAME ?? 'NPM_TOKEN';
const VERBOSE = process.env.VERBOSE === '1' || process.argv.includes('--verbose');

function log(level, msg) {
  const tag = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', info: 'INFO' }[level] ?? level;
  process.stderr.write(`[gcp-validate] ${tag}: ${msg}\n`);
}

function fail(msg) {
  log('fail', msg);
  process.exit(1);
}

async function which(cmd) {
  return new Promise(resolve => {
    const tool = process.platform === 'win32' ? 'where' : 'which';
    const p = spawn(tool, [cmd], { stdio: 'ignore', windowsHide: true });
    p.on('error', () => resolve(false));
    p.on('exit', code => resolve(code === 0));
  });
}

async function gcloud(args, opts = {}) {
  try {
    const r = await execFile('gcloud', args, { maxBuffer: 1024 * 1024, windowsHide: true, ...opts });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message ?? '' };
  }
}

async function main() {
  if (!PROJECT) {
    fail('GCP_PROJECT env var is required (set in publish.yml from gcloud-auth output)');
  }

  // 1. gcloud on PATH
  if (!(await which('gcloud'))) {
    fail('gcloud CLI not on PATH (install: https://cloud.google.com/sdk/docs/install)');
  }
  log('pass', 'gcloud on PATH');

  // 2. Project resolves
  const proj = await gcloud(['config', 'get-value', 'project']);
  const activeProject = proj.stdout.trim();
  if (!activeProject || activeProject === '(unset)') {
    fail(`no active gcloud project — expected ${PROJECT}`);
  }
  if (activeProject !== PROJECT) {
    log('warn', `active project (${activeProject}) != requested (${PROJECT}) — using ${PROJECT}`);
  } else {
    log('pass', `project = ${PROJECT}`);
  }

  // 3. Auth
  const auth = await gcloud(['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)']);
  const principal = auth.stdout.trim();
  if (auth.code !== 0 || !principal) {
    fail('no active gcloud auth principal (in CI: WIF should have provisioned one)');
  }
  log('pass', `auth principal = ${principal.split('\n')[0]}`);

  // 4. Secret exists
  const desc = await gcloud([
    'secrets', 'describe', SECRET,
    `--project=${PROJECT}`,
    '--format=value(name)',
  ]);
  if (desc.code !== 0) {
    fail(`secret '${SECRET}' not found in project ${PROJECT}: ${desc.stderr.trim()}`);
  }
  log('pass', `secret '${SECRET}' exists`);

  // 5. Secret version fetchable
  const ver = await gcloud([
    'secrets', 'versions', 'access', 'latest',
    `--secret=${SECRET}`,
    `--project=${PROJECT}`,
  ]);
  if (ver.code !== 0) {
    fail(`cannot fetch latest version of '${SECRET}': ${ver.stderr.trim()}`);
  }
  const token = ver.stdout.trim();
  if (!token) {
    fail(`'${SECRET}' returned empty content`);
  }
  if (VERBOSE) log('info', `token length = ${token.length} chars`);
  log('pass', `fetched '${SECRET}' from Secret Manager`);

  // 6. npm whoami sanity-check
  try {
    const who = await execFile('npm', ['whoami', '--registry=https://registry.npmjs.org/'], {
      env: { ...process.env, npm_config__authToken: token },
      windowsHide: true,
    });
    const user = who.stdout.trim();
    if (!user) {
      fail(`npm whoami returned empty (token may be revoked)`);
    }
    log('pass', `npm whoami = ${user}`);
  } catch (e) {
    fail(`npm whoami failed: ${(e.stderr ?? e.message ?? '').toString().trim() || 'unknown'}`);
  }

  log('info', 'ALL CHECKS PASSED — publish gate OPEN');
  process.exit(0);
}

main().catch(err => {
  fail(`unexpected error: ${err?.message ?? err}`);
});
