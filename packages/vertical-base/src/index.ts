// SPDX-License-Identifier: MIT
//
// @ruflo/vertical-base — shared contract for @ruflo/vertical-* packs.
//
// Per ADR-013, vertical packs are PUBLISHED as standalone npm packages
// so each can be owned by a domain expert without touching the
// create-agent-harness package. This module is the contract those packs
// implement.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, posix, relative, sep } from 'node:path';

/** Variable declaration in a template manifest. */
export interface TemplateVar {
  readonly name: string;
  readonly prompt: string;
  readonly default?: string;
  readonly validate?: string;
  readonly choices?: readonly string[];
}

/** One file entry in a template manifest. */
export interface TemplateFileEntry {
  readonly src: string;
  readonly dst: string;
  readonly render: boolean;
}

/** Top-level manifest for a single template inside a vertical pack. */
export interface VerticalManifest {
  readonly id: string;
  readonly description: string;
  readonly domain?: string;
  readonly files: readonly TemplateFileEntry[];
  readonly vars: readonly TemplateVar[];
}

/**
 * A vertical pack exports either:
 *   - a default object implementing this interface, OR
 *   - named exports `manifest` + `templateRoot`
 *
 * `templateRoot` is the on-disk path to the directory containing the
 * `.tmpl` files referenced by `manifest.files[].src`. Packs ship that
 * directory inside their npm tarball under `files: [..., "templates/**"]`.
 */
export interface VerticalPack {
  readonly manifest: VerticalManifest;
  readonly templateRoot: string;
}

/**
 * Read a vertical pack's manifest.json from its on-disk root. Convention:
 *   <pack-root>/manifest.json
 *   <pack-root>/<src files>
 */
export async function readVerticalManifest(packRoot: string): Promise<VerticalManifest> {
  const path = join(packRoot, 'manifest.json');
  const raw = await readFile(path, 'utf-8');
  const parsed = JSON.parse(raw) as VerticalManifest;
  validateVerticalManifest(parsed);
  return parsed;
}

/**
 * Throw a descriptive error if the manifest is misshapen. Doesn't validate
 * file existence — that's the loader's job at read time.
 */
export function validateVerticalManifest(m: VerticalManifest): void {
  if (!m.id || typeof m.id !== 'string') throw new Error('manifest.id must be a string');
  if (!m.description || typeof m.description !== 'string') {
    throw new Error('manifest.description is required');
  }
  if (!Array.isArray(m.files)) throw new Error('manifest.files must be an array');
  for (const f of m.files) {
    if (!f.src) throw new Error(`manifest.files entry missing src`);
    if (!f.dst) throw new Error(`manifest.files entry "${f.src}" missing dst`);
    if (typeof f.render !== 'boolean') {
      throw new Error(`manifest.files entry "${f.src}" missing render flag`);
    }
  }
  if (!Array.isArray(m.vars)) throw new Error('manifest.vars must be an array');
  const seen = new Set<string>();
  for (const v of m.vars) {
    if (!v.name) throw new Error('manifest.vars entry missing name');
    if (seen.has(v.name)) throw new Error(`manifest.vars duplicate name: ${v.name}`);
    seen.add(v.name);
  }
}

function toPosix(p: string): string {
  return p.split(sep).join(posix.sep);
}

/**
 * Sanity-check that every file the manifest claims exists actually does
 * exist on disk under `templateRoot`. Pack authors run this at publish
 * time to catch dangling references before they ship.
 */
export async function verifyTemplateFilesPresent(pack: VerticalPack): Promise<{
  ok: boolean;
  missing: string[];
}> {
  const missing: string[] = [];
  for (const f of pack.manifest.files) {
    const full = join(pack.templateRoot, f.src);
    try {
      const s = await stat(full);
      if (!s.isFile()) missing.push(f.src);
    } catch {
      missing.push(f.src);
    }
  }
  return { ok: missing.length === 0, missing };
}
