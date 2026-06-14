// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { dispatch } from '../packages/create-agent-harness/src/subcommands.js';

describe('CLI conventional flags', () => {
  it('`--help` is an alias for help', async () => {
    const r = await dispatch('--help', []);
    expect(r.code).toBe(0);
    expect(r.lines.join('\n')).toMatch(/Usage:/);
  });

  it('`-h` is an alias for help', async () => {
    const r = await dispatch('-h', []);
    expect(r.code).toBe(0);
    expect(r.lines.join('\n')).toMatch(/Usage:/);
  });

  it('`--version` prints version line', async () => {
    const r = await dispatch('--version', []);
    expect(r.code).toBe(0);
    expect(r.lines.join('\n')).toMatch(/harness \d+\.\d+\.\d+/);
  });

  it('`-v` prints version line', async () => {
    const r = await dispatch('-v', []);
    expect(r.code).toBe(0);
    expect(r.lines.join('\n')).toMatch(/harness \d+\.\d+\.\d+/);
  });

  it('help text lists all 16 subcommands (incl. completions + flags)', async () => {
    const r = await dispatch('help', []);
    const txt = r.lines.join('\n');
    // iter 97: refreshed 15 → 16 with export-config. Every subcommand
    // the dispatcher honours MUST be visible in `harness help`, or
    // users can't find it.
    for (const cmd of [
      'sign', 'verify', 'doctor', 'federate', 'secrets', 'validate',
      'mcp', 'publish', 'upgrade', 'completions', 'sbom', 'audit',
      'mcp-scan', 'analyze-repo', 'diag', 'export-config',
    ]) {
      expect(txt, `help missing ${cmd}`).toContain(cmd);
    }
    expect(txt).toMatch(/--help, -h/);
    expect(txt).toMatch(/--version, -v/);
  });
});

describe('harness completions', () => {
  it('bash output looks like a bash completion script', async () => {
    const r = await dispatch('completions', ['bash']);
    expect(r.code).toBe(0);
    const out = r.lines.join('\n');
    expect(out).toMatch(/_harness_completion/);
    expect(out).toMatch(/complete -F _harness_completion harness/);
    expect(out).toContain('compgen');
  });

  it('zsh output is a zsh completion script (#compdef)', async () => {
    const r = await dispatch('completions', ['zsh']);
    expect(r.code).toBe(0);
    expect(r.lines.join('\n')).toMatch(/^#compdef harness/m);
  });

  it('fish output uses fish complete syntax', async () => {
    const r = await dispatch('completions', ['fish']);
    expect(r.code).toBe(0);
    const out = r.lines.join('\n');
    expect(out).toMatch(/complete -c harness/);
    expect(out).toMatch(/__fish_use_subcommand/);
  });

  it('unknown shell exits 2', async () => {
    const r = await dispatch('completions', ['powershell']);
    expect(r.code).toBe(2);
    expect(r.lines.join('\n')).toMatch(/Unknown shell/);
  });

  it('no shell shows help (exit 0)', async () => {
    const r = await dispatch('completions', []);
    expect(r.code).toBe(0);
    expect(r.lines.join('\n')).toMatch(/Usage: harness completions/);
  });

  it('all three shells list every harness subcommand in their completion', async () => {
    // iter 67: list every subcommand the dispatcher honours so missing
    // entries in the SUBCOMMANDS list fail loudly. New since iter 48:
    // sbom, audit, mcp-scan, analyze-repo, diag.
    const subs = [
      'sign', 'verify', 'doctor', 'federate', 'secrets', 'validate',
      'mcp', 'publish', 'upgrade', 'sbom', 'audit',
      'mcp-scan', 'analyze-repo', 'diag', 'export-config',
    ];
    for (const shell of ['bash', 'zsh', 'fish']) {
      const r = await dispatch('completions', [shell]);
      const out = r.lines.join('\n');
      for (const s of subs) {
        expect(out, `${shell} completion missing ${s}`).toContain(s);
      }
    }
  });
});
