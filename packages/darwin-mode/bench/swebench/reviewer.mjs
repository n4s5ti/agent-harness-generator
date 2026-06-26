// SPDX-License-Identifier: MIT
//
// ADR-195 Phase-2 #3 — REVIEWER / critic sub-agent + bounded revise loop (production).
//
// A second agent reviews the candidate patch for correctness, regressions, and scope (ADR-176 SWE
// Conductor's review role), then drives a BOUNDED revision loop: if the reviewer rejects, the fixer
// gets the critique and revises; re-review; repeat up to a cap. Conformant — the reviewer sees only
// the issue + the diff (and optionally the in-loop repo-test trace), never the gold test.
//
// PURE + dependency-injected: the review LLM call and the revise-round function are injected, so the
// accept/reject parsing, the revise loop, and the bounding are unit-tested offline (no network).
// `solve-agentic.mjs` wires the real review LLM + a single agentic revise round when `--reviewer` set.

/**
 * Parse a reviewer verdict from raw model output. Tolerant: looks for an explicit VERDICT line, else
 * falls back to leading APPROVE/REJECT/LGTM tokens. Returns { approved:boolean, reason:string }.
 */
export function parseReview(raw) {
  const text = String(raw || '').trim();
  if (!text) return { approved: false, reason: 'empty review' };
  // Prefer an explicit "VERDICT: APPROVE|REJECT" line.
  const m = text.match(/VERDICT\s*[:=]\s*(APPROVE|REJECT|ACCEPT|PASS|FAIL)\b/i);
  if (m) {
    const v = m[1].toUpperCase();
    return { approved: v === 'APPROVE' || v === 'ACCEPT' || v === 'PASS', reason: text.slice(0, 1500) };
  }
  // Fallback: leading token.
  if (/^\s*(APPROVE|ACCEPT|LGTM|PASS)\b/i.test(text)) return { approved: true, reason: text.slice(0, 1500) };
  if (/^\s*(REJECT|FAIL|NEEDS?\s+WORK|CHANGES?\s+REQUESTED)\b/i.test(text)) return { approved: false, reason: text.slice(0, 1500) };
  // Default conservative: if it reads like criticism without an explicit approve, treat as reject so the
  // revise loop engages; an empty/uncertain review must not silently "approve".
  if (/\b(bug|regression|incorrect|wrong|missing|does not|doesn't|won't|will not|fails?)\b/i.test(text)) return { approved: false, reason: text.slice(0, 1500) };
  return { approved: true, reason: text.slice(0, 1500) };
}

/** The reviewer system prompt — correctness / regression / scope, with a required VERDICT line. */
export const REVIEW_SYSTEM = 'You are a meticulous code reviewer. Given a GitHub issue and a candidate patch, '
  + 'judge whether the patch CORRECTLY and MINIMALLY fixes the described issue. Check: (1) correctness — does it '
  + 'address the root cause described? (2) regressions — could it break unrelated behavior? (3) scope — is it '
  + 'minimal and on-target (no unrelated rewrites)? Reply with a short critique, then a FINAL line exactly of the '
  + 'form `VERDICT: APPROVE` or `VERDICT: REJECT`. Reject if the patch is empty, off-target, or risks regressions.';

/**
 * Build the review prompt (issue + diff + optional in-loop test trace). Pure.
 */
export function buildReviewPrompt(problem, patch, testTrace = '') {
  return [
    '--- GitHub issue ---',
    String(problem || '').slice(0, 4000),
    '--- candidate patch (unified diff) ---',
    String(patch || '(empty patch)').slice(0, 6000),
    testTrace && testTrace.trim() ? '--- in-loop test trace (the repo\'s own tests; NOT the gold tests) ---\n' + String(testTrace).slice(0, 1500) : '',
    '--- review it. End with `VERDICT: APPROVE` or `VERDICT: REJECT`. ---',
  ].filter(Boolean).join('\n');
}

/**
 * Build the revise instruction fed back to the fixer agent after a REJECT. Pure.
 */
export function reviseFeedbackBlock(reason) {
  return [
    '--- CODE REVIEW (a reviewer rejected your patch — address the critique and revise) ---',
    String(reason || '').slice(0, 2000),
    '--- revise your patch to satisfy the review, then resubmit. ---',
  ].join('\n');
}

/**
 * Run the reviewer + bounded revise loop.
 *
 * Injected:
 *   review        async ({ patch, testTrace }) => { approved:boolean, reason:string, cost?:number }
 *                 Review one candidate patch (wraps the review LLM + parseReview).
 *   reviseRound   async ({ reason, prevPatch }) => { patch:string, cost?:number, resolvedInLoop?:boolean, testTrace?:string }
 *                 One revise round given the reviewer's critique.
 *
 * Inputs:
 *   patch         the initial candidate patch (from the base solve)
 *   testTrace     optional in-loop test trace for the initial patch
 *
 * Options: { maxRevisions=2 }  (number of revise rounds AFTER the initial review)
 *
 * Returns { patch, approved, revisions, cost, history }.
 *   - approved : the final patch passed review.
 *   - patch    : the last reviewed candidate (approved one if approved; else the last revision).
 *
 * Honesty: an EMPTY initial patch with no revise capability returns approved=false (a reviewer never
 * approves nothing). The loop never expands scope beyond the injected revise rounds.
 */
export async function reviewerSolve({ review, reviseRound, patch = '', testTrace = '', maxRevisions = 2 } = {}) {
  let cost = 0;
  const history = [];
  let curPatch = patch;
  let curTrace = testTrace;

  const first = await review({ patch: curPatch, testTrace: curTrace });
  cost += first.cost || 0;
  history.push({ stage: 'review', round: 0, approved: !!first.approved, reason: (first.reason || '').slice(0, 200) });
  if (first.approved) return { patch: curPatch, approved: true, revisions: 0, cost, history };

  let reason = first.reason || '';
  for (let rev = 1; rev <= maxRevisions; rev++) {
    const r = await reviseRound({ reason, prevPatch: curPatch });
    cost += r.cost || 0;
    if (r.patch && r.patch.trim()) { curPatch = r.patch; }
    curTrace = r.testTrace ?? curTrace;
    history.push({ stage: 'revise', round: rev, patched: !!(r.patch && r.patch.trim()), resolvedInLoop: !!r.resolvedInLoop });

    const re = await review({ patch: curPatch, testTrace: curTrace });
    cost += re.cost || 0;
    reason = re.reason || reason;
    history.push({ stage: 'review', round: rev, approved: !!re.approved, reason: (re.reason || '').slice(0, 200) });
    if (re.approved) return { patch: curPatch, approved: true, revisions: rev, cost, history };
  }

  return { patch: curPatch, approved: false, revisions: maxRevisions, cost, history };
}
