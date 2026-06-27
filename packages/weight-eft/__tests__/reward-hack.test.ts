// SPDX-License-Identifier: MIT
//
// Tests for the deterministic reward-hacking monitor (Ornith-1.0 borrow) and
// its integration into the exporter: a trajectory that read a withheld gold
// path (or tampered with the verification harness, or escaped the sandbox) is
// EXCLUDED from the training set with a logged reason and a surfaced count.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { detectRewardHack, isRewardHacked } from '../src/reward-hack.js';
import { exportTrainingData } from '../src/export.js';
import type { DarwinTrajectory } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const archive = JSON.parse(
  readFileSync(join(here, 'fixtures', 'reward-hack-archive.json'), 'utf8'),
) as DarwinTrajectory[];

const byId = (id: string) => archive.find((t) => t.instance_id === id)!;

describe('reward-hack monitor — deterministic detection', () => {
  it('flags a trajectory that READ a withheld gold path', () => {
    const findings = detectRewardHack(byId('cheater__cheater-goldread'));
    expect(findings.some((f) => f.kind === 'gold-read')).toBe(true);
    expect(isRewardHacked(byId('cheater__cheater-goldread'))).toBe(true);
  });

  it('flags a trajectory that MODIFIED the verification harness (conftest)', () => {
    const findings = detectRewardHack(byId('cheater__cheater-tamper'));
    expect(findings.some((f) => f.kind === 'verification-tamper')).toBe(true);
  });

  it('flags a trajectory that ESCAPED the sandbox (/etc write)', () => {
    const findings = detectRewardHack(byId('cheater__cheater-escape'));
    expect(findings.some((f) => f.kind === 'sandbox-escape')).toBe(true);
  });

  it('does NOT flag an honest trajectory (clean repo read + patch)', () => {
    expect(detectRewardHack(byId('honest__honest-1'))).toEqual([]);
    expect(isRewardHacked(byId('honest__honest-1'))).toBe(false);
  });
});

describe('reward-hack filter — exporter integration', () => {
  it('EXCLUDES reward-hacked successes from the training set and reports the count', () => {
    const { sft, report } = exportTrainingData(archive, { evalHoldout: [] });
    // 4 resolved trajectories, 3 of them reward-hacked → only the honest one survives.
    expect(report.droppedRewardHacked).toBe(3);
    expect(report.sftRows).toBe(1);
    expect(report.sftInstanceIds).toEqual(['honest__honest-1']);
    // a logged reason per drop, naming the instance and the kind
    expect(report.notes.filter((n) => n.includes('reward-hack drop')).length).toBe(3);
    expect(report.notes.some((n) => n.includes('cheater__cheater-goldread') && n.includes('gold-read'))).toBe(true);
    // the gold-read cheater's content never reaches SFT
    expect(sft.some((r) => r.messages.some((m) => (m.content ?? '').includes('WITHHELD gold')))).toBe(false);
  });

  it('reward-hacked cheap trajectories never enter DPO either', () => {
    const { dpo } = exportTrainingData(archive, { evalHoldout: [] });
    // no chosen completion may come from a cheater
    expect(dpo.length).toBe(0); // honest-1 has no failed sibling → no pair
  });

  it('the filter is separate from disjointness — both can drop the same instance', () => {
    const { report } = exportTrainingData(archive, {
      evalHoldout: ['cheater__cheater-goldread'],
    });
    // held-out cheater is excluded by the holdout guard FIRST (not double-counted)
    expect(report.excludedByHoldout).toBe(1);
    expect(report.droppedRewardHacked).toBe(2); // the other two cheaters
  });

  it('dropRewardHacked:false disables the filter (debug only) but still counts honest', () => {
    const { report } = exportTrainingData(archive, { evalHoldout: [], dropRewardHacked: false });
    expect(report.droppedRewardHacked).toBe(0);
    expect(report.sftRows).toBe(4); // all 4 resolved survive when the filter is off
  });
});
