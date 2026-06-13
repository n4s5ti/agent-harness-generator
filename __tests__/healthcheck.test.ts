// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const execFile = promisify(execFileCb);
const ROOT = process.cwd();
const SCRIPT = join(ROOT, 'scripts', 'healthcheck.mjs');

async function run(args: string[] = []): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const r = await execFile('node', [SCRIPT, ...args], { cwd: ROOT, windowsHide: true });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('scripts/healthcheck.mjs', () => {
  it('the script exists', () => expect(existsSync(SCRIPT)).toBe(true));

  it('default run exits 0 with HEALTHY on the live repo', async () => {
    const r = await run();
    expect(r.code, `stderr:\n${r.stderr}`).toBe(0);
    expect(r.stderr).toMatch(/Result: HEALTHY/);
  }, 30_000);

  it('runs all 6 checks by default', async () => {
    const r = await run();
    expect(r.stderr).toMatch(/healthcheck — 6 checks/);
    for (const name of ['version', 'plugin', 'codex', 'workflows', 'pathguard', 'examples']) {
      expect(r.stderr).toContain(name);
    }
  }, 30_000);

  it('--json emits parseable JSON with results array + ok boolean', async () => {
    const r = await run(['--json']);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(parsed.results).toHaveLength(6);
    expect(typeof parsed.ok).toBe('boolean');
    expect(parsed.ok).toBe(true);
  }, 30_000);

  it('--check=plugin runs only the plugin check', async () => {
    const r = await run(['--check=plugin']);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/healthcheck — 1 check/);
    expect(r.stderr).toMatch(/PASS\s+plugin/);
  }, 30_000);

  it('unknown --check= produces a FAIL not a crash', async () => {
    const r = await run(['--check=nonexistent']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/unknown check/);
  }, 30_000);

  it('finishes fast (<5 seconds, no I/O beyond reading files)', async () => {
    const t0 = Date.now();
    await run();
    expect(Date.now() - t0).toBeLessThan(5000);
  }, 30_000);
});
