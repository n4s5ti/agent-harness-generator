// SPDX-License-Identifier: MIT
//
// ADR-041 validation stage — hard/soft constraint checks over a candidate harness
// design. The synthesis loop's "reject a candidate that fails a hard requirement"
// gate: a recommended design must compile-target a language, only reach for remote
// MCP when the repo warrants it, and ship the default-deny / audit / approval
// safety posture. Each constraint is a predicate over the repo profile + the
// recommended plan — real signals, no LLM, deterministic.

import type { RepoProfile, HarnessPlan } from './analyze-repo.js';

export interface ConstraintResult {
  id: string;
  label: string;
  /** hard = must pass (a failing hard constraint should block scaffolding);
   *  soft = advisory (a missing nicety worth flagging). */
  severity: 'hard' | 'soft';
  passed: boolean;
  detail?: string;
}

/** Non-code archetypes don't need a build command to be valid. */
const NON_CODE_TEMPLATES = new Set(['vertical:research', 'vertical:devops', 'vertical:business']);

/**
 * Check a recommended harness design against the constraint set. Pure +
 * deterministic — every check reads only the profile + plan.
 */
export function checkConstraints(profile: RepoProfile, plan: HarnessPlan): ConstraintResult[] {
  const p = plan.policy;
  const out: ConstraintResult[] = [];
  const add = (id: string, label: string, severity: 'hard' | 'soft', passed: boolean, detail?: string) =>
    out.push({ id, label, severity, passed, ...(detail ? { detail } : {}) });

  // HARD — a generated harness must be able to target this repo + stay safe.
  add('language-detected', 'A language was detected (compile target)', 'hard', profile.languages.length > 0,
    profile.languages.length ? undefined : 'no language signal — harness cannot reliably compile-target');
  add('mcp-warranted', 'Remote MCP only when the repo uses MCP', 'hard', plan.mcp !== 'remote' || profile.hasMcp,
    plan.mcp === 'remote' && !profile.hasMcp ? 'remote MCP recommended but repo shows no MCP usage (unjustified exposure)' : undefined);
  add('default-deny', 'Tool policy is default-deny', 'hard', p.defaultDeny);
  add('audit-log', 'Tool calls are audit-logged', 'hard', p.auditLog);
  add('approval-for-dangerous', 'Dangerous tools require approval', 'hard', p.requireApprovalForDangerous);
  add('bounded-tools', 'Tool calls per turn + timeout are bounded', 'hard',
    Number.isFinite(p.maxToolCallsPerTurn) && p.maxToolCallsPerTurn > 0 && Number.isFinite(p.toolTimeoutMs) && p.toolTimeoutMs > 0);

  // SOFT — advisory; missing these doesn't block, but the user should know.
  const needsBuild = !NON_CODE_TEMPLATES.has(plan.template);
  add('buildable', 'A build command was found', 'soft', !needsBuild || profile.buildCommands.length > 0,
    needsBuild && profile.buildCommands.length === 0 ? 'no build command detected — verify the harness builds' : undefined);
  add('testable', 'A test command was found', 'soft', profile.testCommands.length > 0,
    profile.testCommands.length ? undefined : 'no test command detected — smoke coverage will be thin');
  add('shell-off', 'Shell execution is disabled by default', 'soft', !p.allowShell);
  add('network-off', 'Network access is disabled by default', 'soft', !p.allowNetwork);

  return out;
}

export interface ConstraintSummary {
  hardPassed: number;
  hardTotal: number;
  softPassed: number;
  softTotal: number;
  /** true iff every HARD constraint passed (the scaffold gate). */
  allHardPass: boolean;
  failures: ConstraintResult[];
}

export function summarise(results: ConstraintResult[]): ConstraintSummary {
  const hard = results.filter((r) => r.severity === 'hard');
  const soft = results.filter((r) => r.severity === 'soft');
  return {
    hardPassed: hard.filter((r) => r.passed).length,
    hardTotal: hard.length,
    softPassed: soft.filter((r) => r.passed).length,
    softTotal: soft.length,
    allHardPass: hard.every((r) => r.passed),
    failures: results.filter((r) => !r.passed),
  };
}

/** Format the constraint report as lines. */
export function formatConstraints(results: ConstraintResult[]): string[] {
  const s = summarise(results);
  const lines = [
    `Constraints — hard ${s.hardPassed}/${s.hardTotal}${s.allHardPass ? ' ✓ (scaffold-ready)' : ' ✗ (blocked)'}, soft ${s.softPassed}/${s.softTotal}`,
    ``,
  ];
  for (const r of results) {
    const mark = r.passed ? 'PASS' : r.severity === 'hard' ? 'FAIL' : 'WARN';
    lines.push(`  ${mark} [${r.severity}] ${r.label}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  return lines;
}
