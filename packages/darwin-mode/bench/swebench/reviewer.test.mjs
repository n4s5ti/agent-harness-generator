#!/usr/bin/env node
// Pure-function tests for reviewer.mjs (ADR-195 Phase-2 #3). NO network: the review call + the revise
// round are stubbed. Run: node reviewer.test.mjs
import assert from 'node:assert';
import { parseReview, buildReviewPrompt, reviseFeedbackBlock, reviewerSolve } from './reviewer.mjs';

let pass = 0; const t = (name, fn) => { try { fn(); pass++; console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.message}`); process.exitCode = 1; } };
const ta = async (name, fn) => { try { await fn(); pass++; console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.message}`); process.exitCode = 1; } };

console.log('reviewer.mjs unit tests:');

t('parseReview reads explicit VERDICT lines', () => {
  assert(parseReview('Looks good.\nVERDICT: APPROVE').approved === true);
  assert(parseReview('Has a bug.\nVERDICT: REJECT').approved === false);
  assert(parseReview('VERDICT: ACCEPT').approved === true);
  assert(parseReview('VERDICT: FAIL').approved === false);
});

t('parseReview falls back to leading tokens and criticism heuristic', () => {
  assert(parseReview('APPROVE — minimal and correct').approved === true);
  assert(parseReview('REJECT, wrong file').approved === false);
  assert(parseReview('LGTM').approved === true);
  assert(parseReview('This introduces a regression in the parser').approved === false, 'criticism → reject');
  assert(parseReview('').approved === false, 'empty review never approves');
});

await ta('reviewer approves first patch → no revise rounds', async () => {
  let revises = 0;
  const r = await reviewerSolve({
    review: async () => ({ approved: true, reason: 'good', cost: 0.01 }),
    reviseRound: async () => { revises++; return { patch: 'x' }; },
    patch: 'base-patch', maxRevisions: 2,
  });
  assert(r.approved === true);
  assert(r.revisions === 0, 'no revise rounds when first review approves');
  assert(revises === 0, 'reviseRound never called');
  assert(r.patch === 'base-patch');
});

await ta('reject → revise → approve loop returns the revised patch', async () => {
  let reviewN = 0;
  const r = await reviewerSolve({
    review: async ({ patch }) => { reviewN++; return reviewN === 1 ? { approved: false, reason: 'fix the edge case', cost: 0.01 } : { approved: patch === 'revised-1', reason: 'ok now', cost: 0.01 }; },
    reviseRound: async ({ reason, prevPatch }) => { assert(/edge case/.test(reason), 'revise sees critique'); assert(prevPatch === 'base', 'revise sees prev patch'); return { patch: 'revised-1', cost: 0.02 }; },
    patch: 'base', maxRevisions: 2,
  });
  assert(r.approved === true, 'approved after one revise');
  assert(r.patch === 'revised-1', 'returns revised patch');
  assert(r.revisions === 1);
  assert(Math.abs(r.cost - (0.01 + 0.02 + 0.01)) < 1e-9, 'cost = review + revise + re-review');
});

await ta('bounded revisions exhausted → returns last revision, approved=false', async () => {
  let revises = 0;
  const r = await reviewerSolve({
    review: async () => ({ approved: false, reason: 'still wrong', cost: 0 }),
    reviseRound: async () => { revises++; return { patch: `rev-${revises}`, cost: 0 }; },
    patch: 'base', maxRevisions: 2,
  });
  assert(revises === 2, `exactly maxRevisions revise rounds, got ${revises}`);
  assert(r.approved === false);
  assert(r.patch === 'rev-2', 'last revision returned');
  assert(r.revisions === 2);
});

await ta('empty revise patch keeps the previous patch (no clobber)', async () => {
  const r = await reviewerSolve({
    review: async () => ({ approved: false, reason: 'x', cost: 0 }),
    reviseRound: async () => ({ patch: '  ' }), // empty revision
    patch: 'keep-me', maxRevisions: 1,
  });
  assert(r.patch === 'keep-me', 'empty revision does not clobber the base patch');
});

t('buildReviewPrompt includes issue + diff + optional trace', () => {
  const p = buildReviewPrompt('the issue text', 'diff --git a/x', 'pytest trace');
  assert(/the issue text/.test(p) && /diff --git/.test(p) && /pytest trace/.test(p));
  assert(/VERDICT: APPROVE/.test(p), 'asks for the verdict line');
  const noTrace = buildReviewPrompt('issue', 'diff');
  assert(!/in-loop test trace/.test(noTrace), 'trace section omitted when empty');
});

t('reviseFeedbackBlock wraps the critique', () => {
  const b = reviseFeedbackBlock('handle None input');
  assert(/CODE REVIEW/.test(b) && /handle None input/.test(b) && /revise your patch/.test(b));
});

console.log(`\n${pass} tests passed.`);
