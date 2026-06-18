// SPDX-License-Identifier: MIT
//
// End-to-end integration test for evaluateChildAgainstParent (ADR-076 / ADR-075).
// Exercises the FULL rigorous path: a real fixture repo, a hash-pinned BenchSuite,
// real baseline + child variant directories, and the real secure sandbox.
//
//   - Reproducibility (the Repro gate): the SAME seed yields a byte-identical
//     decision across two independent runs.
//   - Benchmark-tampering control: a corrupted suite.taskHash makes the evaluator
//     throw before running anything.
//
// Kept modest: 1 task, fast commands (`node -e "process.exit(0)"`).

import { afterEach, describe, expect, it } from 'vitest';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateChildAgainstParent } from '../../src/bench/runner.js';
import { scoreBenchmark } from '../../src/bench/score.js';
import { makeSuite } from '../../src/bench/suite.js';
import { generateBaselineHarness } from '../../src/generator.js';
import { profileRepo } from '../../src/repo_profiler.js';
import type { BenchmarkTask, BenchSuite } from '../../src/bench/types.js';
import type { HarnessVariant, RepoProfile } from '../../src/types.js';

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

function oneTask(): BenchmarkTask {
  return {
    id: 'e2e-1',
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
  };
}

/** Fixture repo + profile + a parent and a (cloned) child variant directory. */
async function buildScenario(): Promise<{
  profile: RepoProfile;
  parent: HarnessVariant;
  child: HarnessVariant;
  suite: BenchSuite;
}> {
  const repo = await makeTmp('darwin-e2e-repo-');
  await writeFile(
    join(repo, 'package.json'),
    JSON.stringify(
      { name: 'fixture', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"' } },
      null,
      2,
    ),
    'utf8',
  );
  const profile = await profileRepo(repo);

  const workRoot = await makeTmp('darwin-e2e-work-');
  const baseline = await generateBaselineHarness(profile, workRoot);

  // Parent: the baseline, given a distinct id (the byId map needs unique ids).
  const parent: HarnessVariant = { ...baseline, id: 'parent' };

  // Child: copy the baseline's seven approved files into a second directory so
  // it passes the safety gate identically and produces the same scores.
  const childDir = join(workRoot, 'variants', 'child');
  await cp(baseline.dir, childDir, { recursive: true });
  const child: HarnessVariant = {
    ...baseline,
    id: 'child',
    parentId: 'parent',
    generation: 1,
    dir: childDir,
  };

  const suite = makeSuite('e2e-suite', '1.0.0', [oneTask()]);
  return { profile, parent, child, suite };
}

describe('evaluateChildAgainstParent — reproducibility (Repro gate)', () => {
  // ───────────────────────────────────────────────────────────────────────────
  // The Repro gate holds: given the SAME repo, suite, seed and sandbox,
  // evaluateChildAgainstParent yields a byte-identical, deep-equal
  // PromotionDecision.
  //
  // `scoreBenchmark` is — and remains — a faithful PURE function of its inputs,
  // INCLUDING `durationMs` (test #1 below proves that). The reproducibility fix
  // lives in `runTaskForVariant` (src/bench/runner.ts): it now feeds a
  // DETERMINISTIC duration (0) into the score while still recording the real
  // wall-clock in `BenchmarkResult.durationMs` for observability. At prototype
  // level every variant runs the identical task command, so wall-clock is pure
  // noise; excluding it from the scored value is what makes the decision (and the
  // winner) reproducible. Real latency scoring returns with the LLM evaluator,
  // where per-variant latency is a metered, reproducible signal.
  // ───────────────────────────────────────────────────────────────────────────
  it('scoreBenchmark is a faithful pure function of durationMs (the runner feeds it a fixed 0)', () => {
    const baseInput = {
      publicTestPassed: true,
      hiddenTestPassed: true,
      regressionPassed: true,
      safetyViolations: [] as string[],
      blockedFileTouches: [] as string[],
      hallucinatedFileRefs: false,
      costUsd: 0,
      maxCostUsd: 1,
      timeoutMs: 30000,
    };
    const fast = scoreBenchmark({ ...baseInput, durationMs: 100 });
    const slow = scoreBenchmark({ ...baseInput, durationMs: 250 });
    // Same logical outcome, different wall-clock ⇒ different finalScore. This
    // non-determinism is what flows through runTaskForVariant into the decision.
    expect(slow.finalScore).not.toBe(fast.finalScore);
  });

  it(
    'decision is byte-identical across two same-seed runs (Repro gate enforced)',
    async () => {
      const { profile, parent, child, suite } = await buildScenario();
      const args = { parent, child, profile, suite, cleanReplay: true, seed: 42 };

      const a = await evaluateChildAgainstParent(args);
      const b = await evaluateChildAgainstParent(args);

      expect(JSON.stringify(b.decision)).toBe(JSON.stringify(a.decision));
    },
    60_000,
  );

  it('runs both variants over the hash-pinned suite (sanity: structure is stable even if scores are not)', async () => {
    const { profile, parent, child, suite } = await buildScenario();
    const out = await evaluateChildAgainstParent({
      parent,
      child,
      profile,
      suite,
      cleanReplay: true,
      seed: 42,
    });

    // Parent and child each scored against the single hash-pinned task.
    expect(out.parentResults.length).toBe(1);
    expect(out.childResults.length).toBe(1);
    expect(out.parentResults[0].solved).toBe(true);
    expect(out.childResults[0].solved).toBe(true);
    // These structural fields ARE deterministic (no latency dependence).
    expect(out.decision.childVerifiedSolveRate).toBe(1);
    expect(out.decision.parentVerifiedSolveRate).toBe(1);
    expect(out.decision.childSafetyViolations).toBe(0);
    expect(out.decision.cleanReplay).toBe(true);
  });
});

describe('evaluateChildAgainstParent — benchmark-tampering control', () => {
  it('throws when suite.taskHash no longer matches the tasks', async () => {
    const { profile, parent, child, suite } = await buildScenario();

    // Corrupt the pinned hash (simulating tampering with the snapshot).
    const tampered: BenchSuite = { ...suite, taskHash: 'deadbeef'.repeat(8) };

    await expect(
      evaluateChildAgainstParent({
        parent,
        child,
        profile,
        suite: tampered,
        cleanReplay: true,
        seed: 42,
      }),
    ).rejects.toThrow(/tampered/i);
  });
});
