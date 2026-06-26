#!/usr/bin/env node
// Pure-function tests for repro-gate.mjs (ADR-195 Phase-2 #2). NO network / NO Docker: the repro
// writer, the solve round, and the repro runner are all stubbed. Run: node repro-gate.test.mjs
import assert from 'node:assert';
import { reproGateSolve, reproFeedbackBlock } from './repro-gate.mjs';

let pass = 0; const ta = async (name, fn) => { try { await fn(); pass++; console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.message}`); process.exitCode = 1; } };
const t = (name, fn) => { try { fn(); pass++; console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.message}`); process.exitCode = 1; } };

console.log('repro-gate.mjs unit tests:');

await ta('gate fires on the round whose patch makes the self-written repro pass', async () => {
  const calls = [];
  const r = await reproGateSolve({
    writeRepro: async () => ({ valid: true, repro: 'def test(): assert fix', cost: 0.01 }),
    solveRound: async ({ round, reproTrace }) => { calls.push({ round, hadTrace: !!reproTrace }); return { patch: `patch-r${round}`, cost: 0.02, resolvedInLoop: false }; },
    // first round's patch fails the repro, second round passes
    runRepro: ({ patch }) => ({ ran: true, passed: patch === 'patch-r2', logTail: 'AssertionError' }),
    maxRounds: 3,
  });
  assert(r.reproValid === true, 'gate armed');
  assert(r.reproPassed === true, 'gate fired');
  assert(r.patch === 'patch-r2', 'returns the passing patch');
  assert(r.rounds === 2, '2 rounds taken');
  assert(calls[1].hadTrace === true, 'round 2 received the round-1 failure trace');
  assert(Math.abs(r.cost - (0.01 + 0.02 + 0.02)) < 1e-9, 'cost accumulates writer + 2 rounds');
});

await ta('gate exhausts bounded rounds when the repro never passes; returns last patch', async () => {
  let rounds = 0;
  const r = await reproGateSolve({
    writeRepro: async () => ({ valid: true, repro: 'r', cost: 0 }),
    solveRound: async ({ round }) => { rounds++; return { patch: `p${round}`, cost: 0 }; },
    runRepro: () => ({ ran: true, passed: false, logTail: 'still failing' }),
    maxRounds: 3,
  });
  assert(rounds === 3, `exactly maxRounds solve rounds, got ${rounds}`);
  assert(r.reproPassed === false, 'never passed');
  assert(r.patch === 'p3', 'best-effort last patch returned');
  assert(r.rounds === 3);
});

await ta('invalid repro → gate cannot arm → single plain solve round, reproValid=false', async () => {
  let solveCount = 0;
  const r = await reproGateSolve({
    writeRepro: async () => ({ valid: false, repro: '', cost: 0.005 }),
    solveRound: async () => { solveCount++; return { patch: 'fallback', cost: 0.01, resolvedInLoop: true }; },
    runRepro: () => { throw new Error('runRepro must NOT be called when the gate cannot arm'); },
    maxRounds: 3,
  });
  assert(r.reproValid === false, 'gate not armed');
  assert(r.reproPassed === false);
  assert(solveCount === 1, 'exactly one fallback solve');
  assert(r.patch === 'fallback', 'fallback patch returned so caller still gets a prediction');
});

await ta('empty patch in a round stops the loop (no wasted repro run)', async () => {
  let reproRuns = 0;
  const r = await reproGateSolve({
    writeRepro: async () => ({ valid: true, repro: 'r', cost: 0 }),
    solveRound: async () => ({ patch: '   ', cost: 0 }), // whitespace-only = no edits
    runRepro: () => { reproRuns++; return { ran: true, passed: true }; },
    maxRounds: 3,
  });
  assert(reproRuns === 0, 'never ran the repro on an empty diff');
  assert(r.reproPassed === false);
});

t('reproFeedbackBlock embeds the repro and (post-round-1) the failure trace', () => {
  const b1 = reproFeedbackBlock('def test(): assert x == 1', '');
  assert(/REPRODUCTION TEST/.test(b1) && /assert x == 1/.test(b1), 'round-1 block has the repro');
  assert(!/STILL FAILING/.test(b1), 'round-1 has no failure trace');
  const b2 = reproFeedbackBlock('def test(): ...', 'AssertionError: expected 1 got 2');
  assert(/STILL FAILING/.test(b2) && /AssertionError/.test(b2), 'later block carries the trace');
  assert(/Iterate your fix/.test(b2), 'instructs the agent to iterate');
});

console.log(`\n${pass} tests passed.`);
