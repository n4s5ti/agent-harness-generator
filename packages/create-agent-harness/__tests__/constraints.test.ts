// SPDX-License-Identifier: MIT
// ADR-041 validation stage — constraint checks.

import { describe, it, expect } from 'vitest';
import { checkConstraints, summarise, formatConstraints } from '../src/constraints.js';
import type { RepoProfile, HarnessPlan } from '../src/analyze-repo.js';

const SAFE = {
  defaultDeny: true, allowNetwork: false, allowShell: false, allowFileWrite: false,
  requireApprovalForDangerous: true, toolTimeoutMs: 30_000, maxToolCallsPerTurn: 8, auditLog: true,
};
const profile: RepoProfile = {
  name: 'x', languages: ['typescript'], hasMcp: false, hasClaude: false, hasCodex: false,
  hasCi: true, buildCommands: ['tsc'], testCommands: ['vitest'], tokens: ['sdk', 'api'],
};
const plan = (over: Partial<HarnessPlan> = {}): HarnessPlan => ({
  name: 'x-harness', hosts: ['claude-code'], template: 'vertical:coding', archetypeId: 'typescript-sdk-harness',
  confidence: 0.8, engine: 'lexical', agents: ['a'], skills: [], commands: ['doctor'], mcp: 'local',
  policy: SAFE, riskProfile: 'safe', suggestedCommands: [], ...over,
});

describe('checkConstraints', () => {
  it('a healthy TS repo + SAFE plan passes all hard constraints', () => {
    const s = summarise(checkConstraints(profile, plan()));
    expect(s.allHardPass).toBe(true);
    expect(s.hardPassed).toBe(s.hardTotal);
  });

  it('FAILS hard when remote MCP is recommended for a non-MCP repo', () => {
    const s = summarise(checkConstraints(profile, plan({ mcp: 'remote' })));
    expect(s.allHardPass).toBe(false);
    expect(s.failures.some((f) => f.id === 'mcp-warranted' && f.severity === 'hard')).toBe(true);
  });

  it('remote MCP is allowed when the repo actually uses MCP', () => {
    const s = summarise(checkConstraints({ ...profile, hasMcp: true }, plan({ mcp: 'remote' })));
    expect(s.allHardPass).toBe(true);
  });

  it('FAILS hard when no language is detected', () => {
    const s = summarise(checkConstraints({ ...profile, languages: [] }, plan()));
    expect(s.failures.some((f) => f.id === 'language-detected')).toBe(true);
    expect(s.allHardPass).toBe(false);
  });

  it('FAILS hard when the policy is not default-deny', () => {
    const s = summarise(checkConstraints(profile, plan({ policy: { ...SAFE, defaultDeny: false } })));
    expect(s.allHardPass).toBe(false);
  });

  it('soft-WARNs (does not block) when a code repo has no build command', () => {
    const s = summarise(checkConstraints({ ...profile, buildCommands: [] }, plan()));
    expect(s.allHardPass).toBe(true); // hard still pass
    expect(s.failures.some((f) => f.id === 'buildable' && f.severity === 'soft')).toBe(true);
  });

  it('research template does not require a build command (soft passes)', () => {
    const s = summarise(checkConstraints({ ...profile, buildCommands: [] }, plan({ template: 'vertical:research' })));
    expect(s.failures.some((f) => f.id === 'buildable')).toBe(false);
  });
});

describe('formatConstraints', () => {
  it('renders a summary header + per-constraint lines', () => {
    const lines = formatConstraints(checkConstraints(profile, plan()));
    expect(lines[0]).toMatch(/Constraints — hard \d+\/\d+/);
    expect(lines.join('\n')).toMatch(/PASS \[hard\]/);
  });
});
