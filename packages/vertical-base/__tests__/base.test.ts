// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateVerticalManifest,
  readVerticalManifest,
  verifyTemplateFilesPresent,
  type VerticalManifest,
} from '../src/index.js';

function good(): VerticalManifest {
  return {
    id: 'vertical:demo',
    description: 'demo pack',
    files: [
      { src: 'package.json.tmpl', dst: 'package.json', render: true },
    ],
    vars: [{ name: 'name', prompt: 'name?' }],
  };
}

describe('validateVerticalManifest', () => {
  it('accepts a well-formed manifest', () => {
    expect(() => validateVerticalManifest(good())).not.toThrow();
  });

  it('rejects missing id', () => {
    expect(() => validateVerticalManifest({ ...good(), id: '' } as VerticalManifest))
      .toThrow(/id/);
  });

  it('rejects missing description', () => {
    expect(() => validateVerticalManifest({ ...good(), description: '' } as VerticalManifest))
      .toThrow(/description/);
  });

  it('rejects files entry missing src/dst/render', () => {
    expect(() => validateVerticalManifest({
      ...good(),
      files: [{ src: '', dst: 'x', render: true }],
    } as VerticalManifest)).toThrow(/src/);
    expect(() => validateVerticalManifest({
      ...good(),
      files: [{ src: 'a', dst: '', render: true }],
    } as VerticalManifest)).toThrow(/dst/);
    expect(() => validateVerticalManifest({
      ...good(),
      files: [{ src: 'a', dst: 'b' } as unknown as { src: string; dst: string; render: boolean }],
    } as VerticalManifest)).toThrow(/render/);
  });

  it('rejects vars with duplicate name', () => {
    expect(() => validateVerticalManifest({
      ...good(),
      vars: [
        { name: 'x', prompt: 'a' },
        { name: 'x', prompt: 'b' },
      ],
    } as VerticalManifest)).toThrow(/duplicate name/);
  });
});

describe('readVerticalManifest', () => {
  it('reads + validates manifest.json from a pack root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vb-read-'));
    await writeFile(join(root, 'manifest.json'), JSON.stringify(good()));
    const m = await readVerticalManifest(root);
    expect(m.id).toBe('vertical:demo');
  });

  it('throws on misshapen JSON', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vb-bad-'));
    await writeFile(join(root, 'manifest.json'), '{ not valid json');
    await expect(readVerticalManifest(root)).rejects.toThrow();
  });
});

describe('verifyTemplateFilesPresent', () => {
  it('reports missing files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vb-missing-'));
    const r = await verifyTemplateFilesPresent({
      manifest: good(),
      templateRoot: root,
    });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['package.json.tmpl']);
  });

  it('reports ok when every file is present', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vb-ok-'));
    await writeFile(join(root, 'package.json.tmpl'), 'noop');
    const r = await verifyTemplateFilesPresent({
      manifest: good(),
      templateRoot: root,
    });
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });
});
