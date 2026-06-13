// SPDX-License-Identifier: MIT

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishCmd } from '../packages/create-agent-harness/src/publish-cmd.js';

const MANIFEST = {
  template: 'minimal',
  vars: { name: 'demo-bot' },
  hosts: ['claude-code'],
  files: {},
  generator_version: '0.1.0',
};

async function makeHarness(opts: { withManifest?: boolean } = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ahg-pub-'));
  if (opts.withManifest !== false) {
    await mkdir(join(dir, '.harness'), { recursive: true });
    await writeFile(join(dir, '.harness', 'manifest.json'), JSON.stringify(MANIFEST));
  }
  return dir;
}

describe('harness publish (dry-run path)', () => {
  let savedJwt: string | undefined;
  beforeEach(() => { savedJwt = process.env.PINATA_JWT; delete process.env.PINATA_JWT; });
  afterEach(() => { if (savedJwt !== undefined) process.env.PINATA_JWT = savedJwt; });

  it('dry-run (no --confirm) does not need PINATA_JWT', async () => {
    const dir = await makeHarness();
    try {
      const r = await publishCmd([dir]);
      expect(r.code, r.lines.join('\n')).toBe(0);
      expect(r.lines.join('\n')).toMatch(/DRY-RUN/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('dry-run reports manifest CID + size + confirmed:false', async () => {
    const dir = await makeHarness();
    try {
      const r = await publishCmd([dir]);
      const txt = r.lines.join('\n');
      expect(txt).toMatch(/manifest CID:/);
      expect(txt).toMatch(/confirmed: false/);
      expect(txt).toMatch(/Re-run with --confirm/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('dry-run fails cleanly on a directory with no manifest', async () => {
    const dir = await makeHarness({ withManifest: false });
    try {
      const r = await publishCmd([dir]);
      expect(r.code).toBe(1);
      expect(r.lines.join('\n')).toMatch(/no manifest/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('--confirm without PINATA_JWT exits 1 with a helpful message', async () => {
    const dir = await makeHarness();
    try {
      const r = await publishCmd([dir, '--confirm']);
      expect(r.code).toBe(1);
      const txt = r.lines.join('\n');
      expect(txt).toMatch(/PINATA_JWT env var not set/);
      expect(txt).toMatch(/harness secrets fetch PINATA_JWT/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('--name override flows through (DRY-RUN)', async () => {
    const dir = await makeHarness();
    try {
      const r = await publishCmd([dir, '--name=override-bot']);
      expect(r.code).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
