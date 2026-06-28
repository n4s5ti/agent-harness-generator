// SPDX-License-Identifier: MIT
// GraphRagMemory + RuvectorMemory(local-rvf) unit tests. Run: node --test tests/graph-memory.test.mjs
//
// Dependency: local @ruvector/graph-node (pre-built) at
//   /home/ruvultra/projects/ruvector/npm/packages/graph-node
// and local rvf-node at:
//   /home/ruvultra/projects/ruvector/npm/packages/rvf-node
//
// These tests verify ADR-201 H3 measurability WITHOUT paid model runs ($0).
// Hash-based embedder (embedder.mjs) is used throughout — same as DenseMemory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphRagMemory, RuvectorMemory, DenseMemory, loadGraphNode, loadRvfNode } from '../memory-layer.mjs';

// ── shared corpus: two semantic clusters (biology / geology) linked by graph edges ────────────
// graph-node v2.0.4 builds edges for pairs with cosine >= 0.35.
// Edge map (verified at runtime): d2→d1 (sim:0.383), d3→d2 (sim:0.524)
// kHopNeighbors(d1, 2) = {d1, d2, d3}   (d1↔d2, d2↔d3 chain)
// kHopNeighbors(d4, 2) = {d4, d5, d6}   (if d4/d5/d6 are also edge-connected)
const CORPUS = [
  { id: 'd1', text: 'photosynthesis converts sunlight into chemical energy stored in glucose molecules in plants' },
  { id: 'd2', text: 'chlorophyll absorbs red and blue light wavelengths enabling photosynthesis in plant cells' },
  { id: 'd3', text: 'plant cells use carbon dioxide and water during the Calvin cycle to produce sugars via photosynthesis' },
  { id: 'd4', text: 'plate tectonics describes the movement of earths crustal plates causing earthquakes and volcanoes' },
  { id: 'd5', text: 'seismic waves travel through the earths interior providing information about tectonic activity' },
  { id: 'd6', text: 'the ring of fire is a region of intense tectonic activity surrounding the pacific ocean' },
];
const PLANT_QUERY = 'how do plants use sunlight to produce energy';

// ── loader availability ──────────────────────────────────────────────────────────────────────

test('loadGraphNode resolves the local pre-built graph-node v2.0.4', () => {
  const gn = loadGraphNode();
  assert.ok(gn !== null, 'local @ruvector/graph-node should be loadable');
  assert.equal(gn.version, '2.0.4');
  assert.ok(typeof gn.GraphDatabase === 'function');
});

test('loadRvfNode resolves the local pre-built rvf-node', () => {
  const rv = loadRvfNode();
  assert.ok(rv !== null, 'local rvf-node should be loadable');
  assert.ok(typeof rv.RvfDatabase === 'function');
});

// ── GraphRagMemory: basic contract ──────────────────────────────────────────────────────────

test('GraphRagMemory: index builds a graph with nodes and edges', async () => {
  const g = new GraphRagMemory({ dim: 64 });
  assert.equal(g.kind, 'graph');
  const { count } = await g.index(CORPUS);
  assert.equal(count, 6);

  const stats = await g.db.stats();
  assert.equal(stats.totalNodes, 6);
  assert.ok(stats.totalEdges >= 2, `expected >=2 edges above 0.35 threshold, got ${stats.totalEdges}`);
  assert.ok(g.edges.length >= 2, 'JS edge list should mirror graph DB edges');
});

test('GraphRagMemory: query returns k hits with required fields', async () => {
  const g = new GraphRagMemory({ dim: 64 });
  await g.index(CORPUS);
  const { hits, tokens, ms, graphHits, candidateCount } = await g.query(PLANT_QUERY, { k: 4 });

  assert.equal(hits.length, 4);
  assert.ok(tokens > 0);
  assert.ok(ms >= 0);
  assert.ok(typeof graphHits === 'number');
  assert.ok(typeof candidateCount === 'number');

  for (const h of hits) {
    assert.ok(h.id && typeof h.text === 'string' && typeof h.score === 'number');
    assert.ok('graphExpanded' in h);
  }
  // Sorted descending by score
  for (let i = 0; i < hits.length - 1; i++) {
    assert.ok(hits[i].score >= hits[i + 1].score, 'hits must be sorted descending');
  }
});

test('GraphRagMemory: graph expansion expands candidate pool beyond direct top-k', async () => {
  const g = new GraphRagMemory({ dim: 64 });
  await g.index(CORPUS);
  const { graphExpandedCount, candidateCount } = await g.query(PLANT_QUERY, { k: 4 });

  // kHopNeighbors(d1, 2) includes d2 and d3 — at least d2 is not in direct top-4 by cosine
  // so the candidate pool is larger than k=4
  assert.ok(graphExpandedCount > 0, `graph must expand to neighbors of the anchor (got graphExpandedCount=${graphExpandedCount})`);
  assert.ok(candidateCount >= 4, 'candidate pool must have at least k nodes');
});

test('GraphRagMemory: candidate pool IS different from dense (H3 measurable)', async () => {
  // Dense evaluates ALL docs globally and returns the k highest.
  // Graph evaluates kHop(anchor) ∪ directTopK — structurally different from pure kNN.
  //
  // graphExpandedCount = size of kHop(anchor) neighborhood  (verified: {d1,d2,d3} = 3)
  // candidateCount     = |kHop ∪ directTopK|               (verified: {d1,d2,d3,d4,d5} = 5 for k=4)
  //
  // The candidate pool is larger than k AND contains at least one node (d2) that is in the
  // kHop neighborhood but NOT in the dense arm's final top-4. This is the H3 structural difference.
  const g = new GraphRagMemory({ dim: 64 });
  const d = new DenseMemory({ dim: 64 });
  await g.index(CORPUS);
  await d.index(CORPUS);

  const gR = await g.query(PLANT_QUERY, { k: 4 });
  const dR = await d.query(PLANT_QUERY, { k: 4 });

  // Graph's candidate pool is a superset of directTopK (kHop adds extra nodes)
  assert.ok(gR.candidateCount > 4,
    `graph candidate pool (${gR.candidateCount}) should exceed k=4 due to kHop expansion`);

  // kHop neighborhood is non-trivial (graph has edges; expansion worked)
  assert.ok(gR.graphExpandedCount > 0,
    `kHop should expand to at least one node (got graphExpandedCount=${gR.graphExpandedCount})`);

  // d2 (chlorophyll, graph-reachable from d1) is in the graph candidate pool
  // but NOT in the dense arm's final top-4 (it ranks 6th globally by cosine)
  const dTopIds = dR.hits.map(h => h.id);
  // graphExpandedCount=3 ({d1,d2,d3}); d2 is NOT in dense top-4 → proves pools differ
  assert.ok(!dTopIds.includes('d2'),
    `d2 (graph-reachable) should be absent from dense top-4 (dense top-4: ${dTopIds})`);
});

test('GraphRagMemory: feedback lifts graph-expanded doc into top-k, dense does not (H3 divergence)', async () => {
  // d2 (chlorophyll) is graph-reachable from d1 (anchor) but scores below direct top-4.
  // After 5 positive feedbacks on d2, the reward bias brings d2 into graph top-4.
  // A fresh DenseMemory (no feedback) keeps d2 out of its top-4.
  // This proves the two arms diverge after outcome feedback — H3 is measurable.
  const g = new GraphRagMemory({ dim: 64 });
  await g.index(CORPUS);
  for (let i = 0; i < 5; i++) {
    await g.feedback({ retrievedIds: ['d2'], resolved: true, weight: 0.05 });
  }

  const d = new DenseMemory({ dim: 64 });
  await d.index(CORPUS);

  const gR = await g.query(PLANT_QUERY, { k: 4 });
  const dR = await d.query(PLANT_QUERY, { k: 4 });

  const gIds = gR.hits.map(h => h.id);
  const dIds = dR.hits.map(h => h.id);

  assert.ok(gIds.includes('d2'), `graph top-4 should include d2 after feedback (got: ${gIds})`);
  assert.ok(!dIds.includes('d2'), `fresh dense top-4 should NOT include d2 (got: ${dIds})`);
  assert.notDeepEqual(gIds, dIds, 'graph and dense top-4 must differ — H3 is measurable');
});

// ── GraphRagMemory: branch / snapshot / mutate ──────────────────────────────────────────────

test('GraphRagMemory: branch is an independent COW clone', async () => {
  const g = new GraphRagMemory({ dim: 64 });
  await g.index(CORPUS.slice(0, 3));   // d1, d2, d3
  const child = await g.branch('c1');

  await child.mutate({ upsert: [{ id: 'cnew', text: 'monsoon rainfall brings water to south asia monsoon season' }] });
  assert.ok(child.docs.has('cnew'), 'child should have new doc');
  assert.ok(!g.docs.has('cnew'), 'parent should NOT see child mutation (COW isolation)');
  assert.equal(child.kind, 'graph');
});

test('GraphRagMemory: snapshot returns a branch with independent state', async () => {
  const g = new GraphRagMemory({ dim: 64 });
  await g.index(CORPUS.slice(0, 2));
  const snap = await g.snapshot();
  assert.ok(snap !== g);
  assert.equal(snap.docs.size, g.docs.size);
  snap.docs.delete('d1');
  assert.ok(g.docs.has('d1'), 'parent retains d1 after child delete');
});

test('GraphRagMemory: mutate delete removes doc from JS layer (node stays in graph DB)', async () => {
  const g = new GraphRagMemory({ dim: 64 });
  await g.index(CORPUS.slice(0, 2));
  await g.mutate({ delete: ['d1'] });
  assert.ok(!g.docs.has('d1'), 'd1 removed from JS layer');
  const { hits } = await g.query(PLANT_QUERY, { k: 4 });
  assert.ok(!hits.some(h => h.id === 'd1'), 'd1 excluded from query results');
});

test('GraphRagMemory: maxTokens budget trims context (same contract as DenseMemory)', async () => {
  const g = new GraphRagMemory({ dim: 64 });
  const big = 'word '.repeat(200);
  await g.index([
    { id: 'a', text: big },
    { id: 'b', text: big },
    { id: 'c', text: big },
  ]);
  const { hits, tokens } = await g.query('word word word', { k: 3, maxTokens: 300 });
  assert.ok(hits.length < 3, 'token budget should cap hits below k=3');
  assert.ok(tokens <= 300 + Math.ceil(big.length / 4), 'within budget');
});

test('GraphRagMemory: empty corpus returns empty hits', async () => {
  const g = new GraphRagMemory({ dim: 64 });
  const { hits, tokens, graphHits } = await g.query('any query', { k: 4 });
  assert.equal(hits.length, 0);
  assert.equal(tokens, 0);
  assert.equal(graphHits, 0);
});

test('GraphRagMemory: close() does not throw', async () => {
  const g = new GraphRagMemory({ dim: 64 });
  await g.index(CORPUS.slice(0, 1));
  await assert.doesNotReject(() => g.close());
});

// ── RuvectorMemory: local-rvf backend ───────────────────────────────────────────────────────

test('RuvectorMemory: uses local-rvf backend when rvf-node is available', async () => {
  const rv = new RuvectorMemory({ dim: 64 });
  assert.equal(rv._backend, 'local-rvf', 'should prefer local-rvf over npm ruvector@0.2.32');
  assert.equal(rv.kind, 'ruvector');
  await rv.close();
});

test('RuvectorMemory: index + query returns correct multi-vector results (no rvfDegraded)', async () => {
  const rv = new RuvectorMemory({ dim: 64 });
  await rv.index(CORPUS);
  const { hits, tokens, rvfDegraded, backend } = await rv.query(PLANT_QUERY, { k: 4 });

  assert.equal(backend, 'local-rvf');
  assert.equal(rvfDegraded, false, 'local RvfDatabase should return k hits without degraded fallback');
  assert.equal(hits.length, 4, 'should return exactly k=4 results');
  assert.ok(tokens > 0);
  for (const h of hits) assert.ok(h.id && typeof h.score === 'number');
  // Most-similar doc (d1, photosynthesis) should rank first
  assert.equal(hits[0].id, 'd1', 'photosynthesis doc should rank first for plant-energy query');
  await rv.close();
});

test('RuvectorMemory: branch uses derive() for COW (local-rvf path)', async () => {
  const rv = new RuvectorMemory({ dim: 64 });
  await rv.index(CORPUS.slice(0, 3));
  const child = await rv.branch('test-child');
  assert.equal(child._backend, 'local-rvf');
  assert.equal(child.docs.size, 3);
  // Child should be independent
  await child.mutate({ upsert: [{ id: 'x', text: 'monsoon winds bring rain' }] });
  assert.ok(child.docs.has('x'));
  assert.ok(!rv.docs.has('x'));
  await rv.close();
  await child.close();
});

test('RuvectorMemory: feedback reward-rerank (no gold field)', async () => {
  const rv = new RuvectorMemory({ dim: 64 });
  await rv.index(CORPUS);
  const { applied, delta, mode } = await rv.feedback({ retrievedIds: ['d1', 'd3'], resolved: true, weight: 0.1 });
  assert.equal(applied, 2);
  assert.ok(delta > 0, 'resolved feedback should apply positive delta');
  assert.equal(mode, 'reward-rerank');
  await rv.close();
});
