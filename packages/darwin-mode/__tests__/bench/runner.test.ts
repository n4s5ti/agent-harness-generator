// SPDX-License-Identifier: MIT
//
// Integration tests for the benchmark runner (ADR-076).
//   - evaluateWithRunner with an INJECTED fake RunVariantFn (pure, fast): proves
//     the promotion decision reads FULL result objects (safetyViolations), not a
//     score proxy.
//   - runTaskForVariant against the REAL secure sandbox with a real baseline
//     variant: a passing task solves; an unsafe variant directory is disqualified.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateWithRunner, runTaskForVariant } from '../../src/bench/runner.js';
import { generateBaselineHarness } from '../../src/generator.js';
import { profileRepo } from '../../src/repo_profiler.js';
import type {
  BenchmarkResult,
  BenchmarkTask,
  RunVariantFn,
} from '../../src/bench/types.js';
import type { RepoProfile } from '../../src/types.js';

const tmpDirs: string[] = [];

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function makeTmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function task(overrides: Partial<BenchmarkTask> = {}): BenchmarkTask {
  return {
    id: 't1',
    repo: 'fixture',
    commit: 'c0ffee',
    title: 'pass',
    prompt: 'pass',
    publicTestCommand: 'node -e "process.exit(0)"',
    hiddenTestCommand: 'node -e "process.exit(0)"',
    regressionTestCommand: 'node -e "process.exit(0)"',
    timeoutMs: 10000,
    maxCostUsd: 1,
    allowedMutationFiles: [],
    blockedFiles: [],
    successCriteria: ['exit 0'],
    difficulty: 1,
    tags: ['fast'],
    ...overrides,
  };
}

/** A deterministic fake result; override per call. */
function fakeResult(
  variantId: string,
  taskId: string,
  finalScore: number,
  overrides: Partial<BenchmarkResult> = {},
): BenchmarkResult {
  return {
    taskId,
    variantId,
    parentId: variantId === 'child' ? 'parent' : null,
    repoCommit: 'c0ffee',
    solved: true,
    publicTestPassed: true,
    hiddenTestPassed: true,
    regressionPassed: true,
    durationMs: 100,
    costUsd: 0,
    changedFiles: [],
    blockedFileTouches: [],
    safetyViolations: [],
    hallucinatedFileRefs: false,
    traceQuality: 1,
    patchPath: '',
    tracePath: '',
    baseScore: finalScore,
    finalScore,
    ...overrides,
  };
}

describe('evaluateWithRunner (injected fake runner)', () => {
  const tasks = Array.from({ length: 8 }, (_, i) => task({ id: `t${i}` }));

  it('promotes a clearly-better, safe, non-regressing child with clean replay', async () => {
    const runVariant: RunVariantFn = async (variantId, t) =>
      fakeResult(variantId, t.id, variantId === 'child' ? 0.7 : 0.5);

    const out = await evaluateWithRunner({
      parentId: 'parent',
      childId: 'child',
      tasks,
      runVariant,
      cleanReplay: true,
      seed: 7,
    });

    expect(out.decision.promote).toBe(true);
    expect(out.parentResults.length).toBe(tasks.length);
    expect(out.childResults.length).toBe(tasks.length);
  });

  it('refuses promotion when child results carry safetyViolations (reads full results, not a score proxy)', async () => {
    // Child has a HIGHER finalScore than parent — a score proxy would promote it.
    // The full-object safety check must still block it.
    const runVariant: RunVariantFn = async (variantId, t) => {
      if (variantId === 'child') {
        return fakeResult('child', t.id, 0.7, {
          safetyViolations: ['blocked content in planner.ts: eval()'],
        });
      }
      return fakeResult('parent', t.id, 0.5);
    };

    const out = await evaluateWithRunner({
      parentId: 'parent',
      childId: 'child',
      tasks,
      runVariant,
      cleanReplay: true,
      seed: 7,
    });

    expect(out.decision.promote).toBe(false);
    expect(out.decision.childSafetyViolations).toBeGreaterThan(0);
    expect(out.decision.reasons.some((r) => /safety violations/.test(r))).toBe(true);
    expect(out.childResults.length).toBe(tasks.length);
  });
});

describe('runTaskForVariant (real sandbox)', () => {
  /** Build a fixture repo whose `test` script just exits 0. */
  async function makeFixtureRepo(): Promise<RepoProfile> {
    const repo = await makeTmp('darwin-runner-repo-');
    await writeFile(
      join(repo, 'package.json'),
      JSON.stringify(
        { name: 'fixture', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"' } },
        null,
        2,
      ),
      'utf8',
    );
    return profileRepo(repo);
  }

  it('a task whose three commands all pass ⇒ solved, finalScore>0, no safety violations', async () => {
    const profile = await makeFixtureRepo();
    const workRoot = await makeTmp('darwin-runner-work-');
    const variant = await generateBaselineHarness(profile, workRoot);

    const result = await runTaskForVariant(variant, profile, task());

    expect(result.solved).toBe(true);
    expect(result.publicTestPassed).toBe(true);
    expect(result.hiddenTestPassed).toBe(true);
    expect(result.regressionPassed).toBe(true);
    expect(result.safetyViolations).toEqual([]);
    expect(result.finalScore).toBeGreaterThan(0);
    expect(result.taskId).toBe('t1');
    expect(result.variantId).toBe(variant.id);
  });

  it('an unsafe variant directory ⇒ non-empty safetyViolations and not solved', async () => {
    const profile = await makeFixtureRepo();
    const workRoot = await makeTmp('darwin-runner-unsafe-');
    const variant = await generateBaselineHarness(profile, workRoot);

    // Write an extra, unapproved file into the variant dir — the ADR-071 gate
    // must disqualify it before any command runs.
    await writeFile(join(variant.dir, 'rogue.ts'), 'export const x = 1;\n', 'utf8');

    const result = await runTaskForVariant(variant, profile, task());

    expect(result.safetyViolations.length).toBeGreaterThan(0);
    expect(result.solved).toBe(false);
  });
});
