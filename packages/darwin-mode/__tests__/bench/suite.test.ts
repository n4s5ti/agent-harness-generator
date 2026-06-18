// SPDX-License-Identifier: MIT
//
// Integration tests for the hash-pinned benchmark suite (ADR-076 anti-gaming).
// Covers hashTasks canonicality/stability, makeSuite/verifySuite, and the
// saveSuite→loadSuite round-trip plus the tamper-refusal control.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hashTasks,
  loadSuite,
  makeSuite,
  saveSuite,
  verifySuite,
} from '../../src/bench/suite.js';
import type { BenchmarkTask, BenchSuite } from '../../src/bench/types.js';

const tmpDirs: string[] = [];

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'darwin-suite-'));
  tmpDirs.push(dir);
  return dir;
}

/** A fully-specified task; override per test. */
function task(overrides: Partial<BenchmarkTask> = {}): BenchmarkTask {
  return {
    id: 't1',
    repo: 'https://example.test/repo',
    commit: 'deadbeef',
    title: 'fix the thing',
    prompt: 'make the test pass',
    publicTestCommand: 'node -e "process.exit(0)"',
    hiddenTestCommand: 'node -e "process.exit(0)"',
    regressionTestCommand: 'node -e "process.exit(0)"',
    timeoutMs: 5000,
    maxCostUsd: 1,
    allowedMutationFiles: ['a.ts', 'b.ts'],
    blockedFiles: ['secret.env'],
    successCriteria: ['public passes', 'hidden passes'],
    difficulty: 2,
    tags: ['unit', 'fast'],
    ...overrides,
  };
}

/**
 * Re-build the same logical task but with its OBJECT KEYS authored in a
 * different order. canonicalise() sorts keys, so the hash must be identical.
 */
function taskKeyShuffled(): BenchmarkTask {
  // Construct in a deliberately scrambled key order.
  const t = {
    tags: ['unit', 'fast'],
    difficulty: 2 as const,
    successCriteria: ['public passes', 'hidden passes'],
    blockedFiles: ['secret.env'],
    allowedMutationFiles: ['a.ts', 'b.ts'],
    maxCostUsd: 1,
    timeoutMs: 5000,
    regressionTestCommand: 'node -e "process.exit(0)"',
    hiddenTestCommand: 'node -e "process.exit(0)"',
    publicTestCommand: 'node -e "process.exit(0)"',
    prompt: 'make the test pass',
    title: 'fix the thing',
    commit: 'deadbeef',
    repo: 'https://example.test/repo',
    id: 't1',
  };
  return t as BenchmarkTask;
}

describe('hashTasks — stable and canonical', () => {
  it('is invariant to object-key authoring order', () => {
    const a = hashTasks([task()]);
    const b = hashTasks([taskKeyShuffled()]);
    expect(b).toBe(a);
  });

  it('is identical for the same task list re-built fresh (order-preserving)', () => {
    const list1 = [task({ id: 'a' }), task({ id: 'b' }), task({ id: 'c' })];
    const list2 = [task({ id: 'a' }), task({ id: 'b' }), task({ id: 'c' })];
    expect(hashTasks(list2)).toBe(hashTasks(list1));
  });

  it('changes when ARRAY order changes (order is part of the snapshot)', () => {
    const ab = hashTasks([task({ id: 'a' }), task({ id: 'b' })]);
    const ba = hashTasks([task({ id: 'b' }), task({ id: 'a' })]);
    expect(ba).not.toBe(ab);
  });

  it('changes when ANY task field changes', () => {
    const base = hashTasks([task()]);
    expect(hashTasks([task({ prompt: 'something else' })])).not.toBe(base);
    expect(hashTasks([task({ commit: 'cafef00d' })])).not.toBe(base);
    expect(hashTasks([task({ timeoutMs: 9999 })])).not.toBe(base);
    expect(hashTasks([task({ difficulty: 5 })])).not.toBe(base);
    expect(hashTasks([task({ tags: ['unit'] })])).not.toBe(base);
    expect(hashTasks([task({ allowedMutationFiles: ['a.ts'] })])).not.toBe(base);
  });

  it('is a 64-char hex SHA-256 digest', () => {
    expect(hashTasks([task()])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('makeSuite / verifySuite', () => {
  it('makeSuite pins taskHash = hashTasks(tasks)', () => {
    const tasks = [task({ id: 'x' }), task({ id: 'y' })];
    const suite = makeSuite('suite-1', '1.0.0', tasks);
    expect(suite.taskHash).toBe(hashTasks(tasks));
    expect(suite.id).toBe('suite-1');
    expect(suite.version).toBe('1.0.0');
    expect(suite.tasks).toBe(tasks);
  });

  it('verifySuite is ok for an untouched suite', () => {
    const suite = makeSuite('s', '1', [task()]);
    const check = verifySuite(suite);
    expect(check.ok).toBe(true);
    expect(check.actual).toBe(check.expected);
  });

  it('verifySuite is NOT ok after mutating a task in place', () => {
    const suite = makeSuite('s', '1', [task()]);
    suite.tasks[0].prompt = 'tampered goal'; // in-place mutation, hash not updated
    const check = verifySuite(suite);
    expect(check.ok).toBe(false);
    expect(check.actual).not.toBe(check.expected);
  });
});

describe('saveSuite / loadSuite round-trip and tamper-refusal', () => {
  it('round-trips an untouched suite', async () => {
    const dir = await makeTmp();
    const file = join(dir, 'nested', 'suite.json'); // forces mkdir recursive
    const suite = makeSuite('round', '2.0.0', [task({ id: 'r1' }), task({ id: 'r2' })]);
    await saveSuite(file, suite);
    const loaded = await loadSuite(file);
    expect(loaded).toEqual(suite);
  });

  it('loadSuite REJECTS a file whose task text was corrupted without updating taskHash', async () => {
    const dir = await makeTmp();
    const file = join(dir, 'suite.json');
    const suite = makeSuite('tamper', '1', [task({ id: 'keep' })]);
    await saveSuite(file, suite);

    // Corrupt one task's text on disk; leave taskHash stale (the attack).
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as BenchSuite;
    onDisk.tasks[0].prompt = 'silently edited to look better';
    await writeFile(file, JSON.stringify(onDisk, null, 2), 'utf8');

    await expect(loadSuite(file)).rejects.toThrow(/tampered/i);
  });
});
