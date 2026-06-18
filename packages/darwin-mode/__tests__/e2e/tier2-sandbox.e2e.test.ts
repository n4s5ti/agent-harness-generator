// SPDX-License-Identifier: MIT
//
// End-to-end: the Tier-2 agent sandbox (ADR-106) executes a variant's REAL
// surface code in a child `node --experimental-strip-types` process. A variant
// with a wider contextBuilder window must solve strictly MORE agent tasks than
// the baseline — proving the surfaces' actual logic (not extracted params)
// drives the outcome. Requires Node ≥ 22; skipped otherwise.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileRepo } from '../../src/repo_profiler.js';
import { generateBaselineHarness } from '../../src/generator.js';
import { runVariantTasksAgent } from '../../src/tier2-sandbox.js';

const nodeMajor = Number(process.versions.node.split('.')[0]);
const solved = (traces: { exitCode: number }[]) => traces.filter((t) => t.exitCode === 0).length;

describe.skipIf(nodeMajor < 22)('Tier-2 agent sandbox (real surface-code execution)', () => {
  let repo: string;
  let wr: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'darwin-t2-repo-'));
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'package.json'), '{"name":"t2","version":"1.0.0","private":true}');
    await writeFile(join(repo, 'src', 'i.js'), 'export const x = 1;\n');
    wr = await mkdtemp(join(tmpdir(), 'darwin-t2-wr-'));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(wr, { recursive: true, force: true });
  });

  it('a wider contextBuilder window solves strictly more tasks (real code drives it)', async () => {
    const profile = await profileRepo(repo);
    const base = await generateBaselineHarness(profile, wr);

    // A copy whose contextBuilder window is widened 30 → 90.
    const wideDir = join(wr, 'variants', 'wide');
    await cp(base.dir, wideDir, { recursive: true });
    const cb = await readFile(join(wideDir, 'context_builder.ts'), 'utf8');
    await writeFile(join(wideDir, 'context_builder.ts'), cb.replace('.slice(0, 30)', '.slice(0, 90)'));
    const wide = { ...base, id: 'wide', dir: wideDir };

    const baseTraces = await runVariantTasksAgent(base);
    const wideTraces = await runVariantTasksAgent(wide);

    // Both ran the real surfaces (traces present, one per default agent task).
    expect(baseTraces.length).toBe(wideTraces.length);
    expect(baseTraces.length).toBeGreaterThan(0);
    // The wider window locates buggy files the narrow one misses → solves more.
    expect(solved(wideTraces)).toBeGreaterThan(solved(baseTraces));
  }, 60_000);
});
