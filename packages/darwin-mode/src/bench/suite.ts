// SPDX-License-Identifier: MIT
//
// Benchmark suite handling (ADR-076 §anti-gaming): a task set is an IMMUTABLE,
// hash-pinned snapshot. `hashTasks` canonicalises the tasks and hashes them;
// `verifySuite` recomputes and compares. Replay refuses to run on a mismatch, so
// a self-improving agent cannot quietly edit the task files to look better
// (benchmark tampering control).

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BenchSuite, BenchmarkTask } from './types.js';

/** Recursively sort object keys so JSON is canonical regardless of authoring order. */
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalise((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Stable SHA-256 over the canonicalised task list. */
export function hashTasks(tasks: BenchmarkTask[]): string {
  const canonical = JSON.stringify(canonicalise(tasks));
  return createHash('sha256').update(canonical).digest('hex');
}

/** Build a hash-pinned suite from a task list. */
export function makeSuite(id: string, version: string, tasks: BenchmarkTask[]): BenchSuite {
  return {
    id,
    version,
    createdAt: new Date().toISOString(),
    taskHash: hashTasks(tasks),
    tasks,
  };
}

/** Recompute the hash and compare it to the recorded one. */
export function verifySuite(suite: BenchSuite): { ok: boolean; expected: string; actual: string } {
  const actual = hashTasks(suite.tasks);
  return { ok: actual === suite.taskHash, expected: suite.taskHash, actual };
}

/** Load a suite from disk and verify its hash (throws on tamper). */
export async function loadSuite(file: string): Promise<BenchSuite> {
  const raw = await readFile(file, 'utf8');
  const suite = JSON.parse(raw) as BenchSuite;
  const check = verifySuite(suite);
  if (!check.ok) {
    throw new Error(
      `benchmark suite tampered: taskHash ${check.expected} != recomputed ${check.actual}`,
    );
  }
  return suite;
}

/** Persist a suite as pretty JSON, creating the parent directory. */
export async function saveSuite(file: string, suite: BenchSuite): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(suite, null, 2), 'utf8');
}
