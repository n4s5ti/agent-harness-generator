// SPDX-License-Identifier: MIT
//
// Tests for scripts/release.mjs orchestrator.
//
// We exercise the dry-run path against the real repo (no side effects)
// and confirm the 5-step plan prints in the right order. Anything that
// would mutate state (write files, git tag, git push) is gated behind
// non-dry-run so this test is hermetic by construction.

import { describe, it, expect } from 'vitest';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const execFile = promisify(execFileCb);

const ROOT = process.cwd();
const SCRIPT = join(ROOT, 'scripts', 'release.mjs');

async function runRelease(args: string[] = []): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const r = await execFile('node', [SCRIPT, ...args], {
      cwd: ROOT,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('scripts/release.mjs', () => {
  it('the script exists', () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  it('--dry-run runs without mutating the repo', async () => {
    const r = await runRelease(['patch', '--dry-run']);
    expect(r.code, `stderr:\n${r.stderr}`).toBe(0);
    expect(r.stderr).toMatch(/DRY-RUN complete/);
    // Specifically: NO git tag created during dry-run
    const tagsBefore = await execFile('git', ['tag', '-l', 'v0.1.1'], { cwd: ROOT });
    expect(tagsBefore.stdout.trim()).toBe('');
  }, 60_000);

  it('prints the 5-step plan in order', async () => {
    const r = await runRelease(['patch', '--dry-run']);
    const text = r.stderr;
    const i1 = text.indexOf('1/5');
    const i2 = text.indexOf('2/5');
    const i3 = text.indexOf('3/5');
    const i4 = text.indexOf('4/5');
    const i5 = text.indexOf('5/5');
    expect(i1).toBeGreaterThan(0);
    expect(i2).toBeGreaterThan(i1);
    expect(i3).toBeGreaterThan(i2);
    expect(i4).toBeGreaterThan(i3);
    expect(i5).toBeGreaterThan(i4);
  }, 60_000);

  it('honors --skip-preflight + --skip-marketplace + --skip-pack in dry-run', async () => {
    const r = await runRelease(['patch', '--dry-run', '--skip-preflight', '--skip-marketplace', '--skip-pack']);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/SKIP: 2\/5  preflight/);
    expect(r.stderr).toMatch(/SKIP: 3\/5  marketplace-entry/);
    expect(r.stderr).toMatch(/SKIP: 4\/5  publish-dryrun/);
  }, 60_000);

  it('semver bump kinds are forwarded to version-bump', async () => {
    // We're in dry-run so version stays 0.1.0, but the bump label shows
    // the next intended version.
    const minor = await runRelease(['minor', '--dry-run']);
    expect(minor.stderr).toMatch(/version-bump minor/);
    const major = await runRelease(['major', '--dry-run']);
    expect(major.stderr).toMatch(/version-bump major/);
  }, 60_000);

  it('explicit version: forwards 0.5.7-rc.1 to version-bump', async () => {
    const r = await runRelease(['0.5.7-rc.1', '--dry-run']);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/version-bump 0\.5\.7-rc\.1/);
  }, 60_000);

  // iter 77 — release.mjs now passes --probe-pages to preflight so real
  // releases gate on the live Studio. The dry-run skips preflight entirely,
  // so we can only assert the wiring exists in the source.
  it('release.mjs source passes --probe-pages to preflight (iter 77)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(process.cwd(), 'scripts', 'release.mjs'), 'utf-8');
    // The preflight invocation must include --probe-pages so real releases
    // gate on the deployed Studio being alive. Test pins the wiring.
    expect(src).toMatch(/scripts\/preflight\.mjs[^]*--probe-pages/);
  });

  it('preflight.mjs honors --probe-pages flag (iter 77)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(process.cwd(), 'scripts', 'preflight.mjs'), 'utf-8');
    expect(src).toMatch(/probePages\s*=\s*args\.has\('--probe-pages'\)/);
    expect(src).toMatch(/healthcheck\.mjs --probe-pages/);
  });
});
