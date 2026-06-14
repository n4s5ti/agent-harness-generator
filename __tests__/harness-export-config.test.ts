// SPDX-License-Identifier: MIT
//
// iter 97 — `harness export-config` emits MCP servers + claims +
// permissions as a single JSON for sharing/auditing without zipping
// the whole harness.

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '..');

let scaffold: (opts: any) => Promise<any>;
let exportConfigCmd: (args: string[]) => Promise<{ code: number; lines: string[] }>;

beforeAll(async () => {
  const distDir = resolve(REPO_ROOT, 'packages', 'create-agent-harness', 'dist');
  if (!existsSync(join(distDir, 'export-config.js'))) {
    throw new Error('build first');
  }
  const idx = await import(`file://${join(distDir, 'index.js')}`);
  scaffold = idx.scaffold;
  const ec = await import(`file://${join(distDir, 'export-config.js')}`);
  exportConfigCmd = ec.exportConfigCmd;
});

describe('harness export-config (iter 97)', () => {
  it('emits a parseable JSON for a freshly scaffolded harness', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ahg-exp-'));
    try {
      await scaffold({
        name: 'exp-bot',
        template: 'minimal',
        host: 'claude-code',
        targetDir: dir,
        force: true,
        generatorVersion: '0.1.0',
      });
      const r = await exportConfigCmd([dir]);
      expect(r.code).toBe(0);
      const cfg = JSON.parse(r.lines.join('\n'));
      expect(cfg.schema).toBe(1);
      expect(typeof cfg.generatedAt).toBe('string');
      expect(cfg.host).toBe('claude-code');
      expect(cfg.hosts).toEqual(['claude-code']);
      expect(cfg.claudeSettings).toBeDefined();
      expect(cfg.manifestMeta?.surface).toBe('cli');
      expect(typeof cfg.manifestMeta?.kernel_version).toBe('string');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('redacts secret-like keys in claude settings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ahg-exp-secret-'));
    try {
      await mkdir(join(dir, '.harness'), { recursive: true });
      await writeFile(join(dir, '.harness', 'manifest.json'), JSON.stringify({
        schema: 1, generator: '0.1.0', template: 'minimal',
        vars: { name: 'x', host: 'claude-code' },
        hosts: ['claude-code'], files: {},
        generated_at: new Date(0).toISOString(),
        meta: { surface: 'cli', kernel_version: '0.1.0' },
      }, null, 2));
      await mkdir(join(dir, '.claude'), { recursive: true });
      await writeFile(join(dir, '.claude', 'settings.json'), JSON.stringify({
        permissions: { allow: ['Bash(npm test)'] },
        api_key: 'sk-real-secret',
        token: 'gh_token_real',
        env: { OPENAI_API_KEY: 'sk-real-2' },
      }, null, 2));
      const r = await exportConfigCmd([dir]);
      const cfg = JSON.parse(r.lines.join('\n'));
      expect(cfg.claudeSettings.api_key).toBe('<redacted>');
      expect(cfg.claudeSettings.token).toBe('<redacted>');
      expect(cfg.claudeSettings.env.OPENAI_API_KEY).toBe('<redacted>');
      expect(cfg.claudeSettings.permissions.allow).toEqual(['Bash(npm test)']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exits 2 + FAIL message when no manifest at path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ahg-exp-nodir-'));
    try {
      const r = await exportConfigCmd([dir]);
      expect(r.code).toBe(2);
      expect(r.lines.join('\n')).toMatch(/FAIL no \.harness\/manifest\.json/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
