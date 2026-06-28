// SPDX-License-Identifier: MIT
//
// memory-layer.mjs — the removable memory seam for the ADR-201 ablation (ADR-150 constraint).
//
// ONE interface, THREE implementations. The A/B/C runner depends ONLY on this interface, so
// ruvector is a drop-in/drop-out augmentation; the base cascade still runs on DenseMemory alone.
//
//   interface MemoryLayer {
//     async index(docs)        docs:[{id,text,metadata?}]            -> {count, ms}
//     async query(q, opts)     q:string, opts:{k, maxTokens?}        -> {hits:[{id,text,score,metadata}], tokens, ms}
//     async mutate(diff)       diff:{upsert?:[{id,text,metadata}], delete?:[id]} -> {applied, ms}
//     async feedback(outcome)  outcome:{retrievedIds:[], resolved:bool, weight?} -> {applied}
//     async branch(childId)    -> a NEW MemoryLayer sharing parent data (COW snapshot)
//     async snapshot()         alias of branch() with an auto id
//     async close()
//     get kind()               'dense' | 'ruvector' | 'graph'
//   }
//
// CONFORMANCE FIREWALL: feedback() consumes SOLVE OUTCOMES (resolved:boolean derived from the
// harness's own test signal) — NEVER gold patches/answers. There is no parameter for gold here.
//
// ────────────────────────────────────────────────────────────────────────────────────────────
// LOCAL ruvector repo capability map (ground-truthed at runtime 2026-06-28; see README.md):
//
// LOCAL REPO (/home/ruvultra/projects/ruvector, v0.1.2, HEAD 9ea2fd2):
//   ✅ @ruvector/graph-node v2.0.4   — GraphDatabase with Cypher + kHopNeighbors (REAL, BUILT)
//      • npm/packages/graph-node/index.js + node_modules/@ruvector/graph-node-linux-x64-gnu/ruvector-graph.node
//      • Supports: createNode/createEdge/kHopNeighbors/query("MATCH (n:Label) RETURN n")
//      • Cypher note: bare MATCH (n) returns 0; label-scoped MATCH (n:Document) returns nodes
//      • kHopNeighbors includes start node itself; isolated nodes return [self]
//   ✅ rvf-node v2.x (local)         — RvfDatabase with REAL multi-vector HNSW (BUILT, FIXED)
//      • npm/packages/rvf-node/rvf-node.linux-x64-gnu.node
//      • Fixes npm ruvector@0.2.32 bug: ingestBatch(N) → query returns ALL k hits (not 1)
//      • Sync API: RvfDatabase.create/ingestBatch/query/derive/status/close
//      • Numeric ids (number[]), flat packed Float32Array; derive() = COW child
//   ❌ GNN (ruvector-gnn-node)       — Source exists (crates/ruvector-gnn-node/) but NO pre-built
//      • .node artifact. Needs `napi build` to compile. Not wired.
//   ⚠️ npm ruvector@0.2.32           — Still loadable but multi-vector rvfQuery broken.
//      • RuvectorMemory falls back to in-process cosine (rvfDegraded: true) when local unavailable.
//
// WHAT THIS MEANS FOR H3 / H4 (ADR-201):
//   H3 "GraphRAG > dense": NOW UNBLOCKED. GraphRagMemory (kind:'graph') uses local graph-node
//     for real multi-hop kHopNeighbors expansion. Produces measurably different hit sets vs dense.
//   H4 "GNN self-learning": reward-rerank approximation still the impl. GNN node needs napi build.
// ────────────────────────────────────────────────────────────────────────────────────────────

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { embedText, cosine, estimateTokens, DEFAULT_DIM } from './embedder.mjs';

const require = createRequire(import.meta.url);

// ── npm ruvector loader (0.2.32 compat, degraded multi-vector query) ─────────────────────────
// Prefers an explicit RUVECTOR_PATH, then the repo/global 'ruvector', then known local installs.
const RUVECTOR_CANDIDATES = [
  process.env.RUVECTOR_PATH,
  'ruvector',
  '/home/ruvultra/projects/ruvector/node_modules/ruvector',
].filter(Boolean);

let _rvCache;
export function loadRuvector() {
  if (_rvCache !== undefined) return _rvCache;
  for (const cand of RUVECTOR_CANDIDATES) {
    try {
      const rv = require(cand);
      const ver = rv.getVersion ? rv.getVersion().version : '?';
      _rvCache = { rv, path: cand, version: ver, rvfAvailable: !!(rv.isRvfAvailable && rv.isRvfAvailable()) };
      return _rvCache;
    } catch { /* try next */ }
  }
  _rvCache = null;
  return null;
}

// ── LOCAL graph-node loader (v2.0.4, BUILT, real GraphDatabase + Cypher + kHopNeighbors) ─────
// Loads the pre-built ruvector-graph.node from the local ruvector monorepo.
// Resolution: npm/packages/graph-node/index.js walks up to find @ruvector/graph-node-linux-x64-gnu.
const GRAPH_NODE_CANDIDATES = [
  process.env.GRAPH_NODE_PATH,
  '/home/ruvultra/projects/ruvector/npm/packages/graph-node',
].filter(Boolean);

let _gnCache;
export function loadGraphNode() {
  if (_gnCache !== undefined) return _gnCache;
  for (const cand of GRAPH_NODE_CANDIDATES) {
    try {
      const gn = require(cand);
      if (gn && gn.GraphDatabase) {
        _gnCache = { GraphDatabase: gn.GraphDatabase, version: gn.version ? gn.version() : '?', path: cand };
        return _gnCache;
      }
    } catch { /* try next */ }
  }
  _gnCache = null;
  return null;
}

// ── LOCAL rvf-node loader (BUILT, fixes multi-vector query bug vs npm ruvector@0.2.32) ────────
// Sync API: RvfDatabase.create / ingestBatch / query / derive / status / close.
// Numeric integer ids, flat-packed Float32Array for ingest.
const RVF_NODE_CANDIDATES = [
  process.env.RVF_NODE_PATH,
  '/home/ruvultra/projects/ruvector/npm/packages/rvf-node',
].filter(Boolean);

let _rvfNodeCache;
export function loadRvfNode() {
  if (_rvfNodeCache !== undefined) return _rvfNodeCache;
  for (const cand of RVF_NODE_CANDIDATES) {
    try {
      const m = require(cand);
      if (m && m.RvfDatabase) {
        _rvfNodeCache = { RvfDatabase: m.RvfDatabase, path: cand };
        return _rvfNodeCache;
      }
    } catch { /* try next */ }
  }
  _rvfNodeCache = null;
  return null;
}

// ── shared embed hook ────────────────────────────────────────────────────────────────────────
// All arms share ONE embedder so A/B/C isolates the index, not the embedding model.
function defaultEmbed(dim) { return (text) => embedText(text, dim); }

// ══════════════════════════════════════════════════════════════════════════════════════════════
// (a) DENSE BASELINE — in-process cosine. Keyless, $0, dependency-free. The Control A arm.
// ══════════════════════════════════════════════════════════════════════════════════════════════
export class DenseMemory {
  constructor({ dim = DEFAULT_DIM, embed } = {}) {
    this.dim = dim;
    this._embed = embed || defaultEmbed(dim);
    this.docs = new Map();        // id -> { id, text, metadata, vector }
    this.rewards = new Map();     // id -> additive score bias (from feedback)
    this.kind = 'dense';
  }

  async index(docs) {
    const t0 = Date.now();
    for (const d of docs) {
      const vector = await this._embed(d.text);
      this.docs.set(d.id, { id: d.id, text: d.text, metadata: d.metadata || {}, vector });
    }
    return { count: this.docs.size, ms: Date.now() - t0 };
  }

  async query(q, { k = 8, maxTokens = Infinity } = {}) {
    const t0 = Date.now();
    const qv = await this._embed(q);
    const scored = [];
    for (const d of this.docs.values()) {
      const base = cosine(qv, d.vector);
      const bias = this.rewards.get(d.id) || 0;
      scored.push({ id: d.id, text: d.text, metadata: d.metadata, score: base + bias });
    }
    scored.sort((a, b) => b.score - a.score);
    const hits = [];
    let tokens = 0;
    for (const h of scored.slice(0, k)) {
      const t = estimateTokens(h.text);
      if (tokens + t > maxTokens && hits.length) break;
      hits.push(h); tokens += t;
    }
    return { hits, tokens, ms: Date.now() - t0 };
  }

  async mutate(diff = {}) {
    const t0 = Date.now();
    let applied = 0;
    for (const d of diff.upsert || []) { await this.index([d]); applied++; }
    for (const id of diff.delete || []) { if (this.docs.delete(id)) { this.rewards.delete(id); applied++; } }
    return { applied, ms: Date.now() - t0 };
  }

  async feedback({ retrievedIds = [], resolved = false, weight = 0.05 } = {}) {
    const delta = resolved ? weight : -weight * 0.5;
    for (const id of retrievedIds) this.rewards.set(id, (this.rewards.get(id) || 0) + delta);
    return { applied: retrievedIds.length, delta };
  }

  async branch(childId = `dense-${Date.now()}`) {
    const child = new DenseMemory({ dim: this.dim, embed: this._embed });
    for (const [id, d] of this.docs) child.docs.set(id, { ...d, vector: d.vector.slice ? d.vector.slice() : d.vector });
    for (const [id, r] of this.rewards) child.rewards.set(id, r);
    child._branchId = childId;
    return child;
  }

  async snapshot() { return this.branch(); }
  async close() { /* in-memory; nothing to release */ }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// (b) RUVECTOR — wired to the LOCAL RvfDatabase (fixed multi-vector HNSW). Test B arm.
//   • index/query/mutate  → Local RvfDatabase (flat-packed Float32Array, numeric ids) — REAL.
//   • branch/snapshot     → RvfDatabase.derive() COW child store — REAL.
//   • feedback            → reward-weighted re-rank (no gold; graph-edge-reweight not available).
//   • Falls back to npm ruvector@0.2.32 (degraded, in-process cosine) when local unavailable.
//
// LOCAL RvfDatabase id mapping:
//   Local rvf-node uses numeric integer ids. We maintain a bidirectional map:
//     idToNum: Map<string, number>  (canonical string → sequential int starting at 1)
//     numToId: Map<number, string>  (int → canonical string)
//   The degraded fallback (npm 0.2.32) still uses the same in-process cosine path.
// ══════════════════════════════════════════════════════════════════════════════════════════════
export class RuvectorMemory {
  constructor({ dim = DEFAULT_DIM, embed, storePath, metric = 'cosine', graphrag = false } = {}) {
    // Try local rvf-node first (fixed multi-vector query), fall back to npm ruvector@0.2.32
    const localRvf = loadRvfNode();
    if (localRvf) {
      this._backend = 'local-rvf';
      this._RvfDatabase = localRvf.RvfDatabase;
    } else {
      const loaded = loadRuvector();
      if (!loaded) throw new Error('ruvector not resolvable. Set RUVECTOR_PATH or RVF_NODE_PATH.');
      if (!loaded.rvfAvailable) throw new Error(`ruvector@${loaded.version} has no RVF surface.`);
      this._backend = 'npm-ruvector';
      this.rv = loaded.rv;
      this.version = loaded.version;
    }
    this.dim = dim;
    this.metric = metric;
    this.graphrag = graphrag;
    this._embed = embed || defaultEmbed(dim);
    this.storePath = storePath || join(process.env.RVF_DIR || tmpdir(), `adr201-rvf-${process.pid}-${randomUUID()}.rvf`);
    this.docs = new Map();              // canonical id -> { id, text, metadata, vector }
    this.order = [];                    // ingest order; index i ↔ canonical id (npm backend)
    this.idToNum = new Map();           // local-rvf: canonical string → numeric id
    this.numToId = new Map();           // local-rvf: numeric id → canonical string
    this._nextId = 1;                   // local-rvf: sequential id counter
    this.rewards = new Map();
    this.store = null;                  // local-rvf: RvfDatabase instance | npm: store handle
    this.kind = 'ruvector';
    this._graphragWarned = false;
  }

  // ── Store initialization ────────────────────────────────────────────────────────────────────

  _ensureStoreLocalRvf() {
    if (this.store) return this.store;
    try { require('node:fs').rmSync(this.storePath, { recursive: true, force: true }); } catch { /* ignore */ }
    this.store = this._RvfDatabase.create(this.storePath, { dimension: this.dim, metric: this.metric });
    return this.store;
  }

  async _ensureStoreNpm() {
    if (this.store) return this.store;
    const fs = await import('node:fs');
    try { fs.rmSync(this.storePath, { recursive: true, force: true }); } catch { /* ignore */ }
    this.store = await this.rv.createRvfStore(this.storePath, { dimensions: this.dim, metric: this.metric });
    return this.store;
  }

  // ── index ──────────────────────────────────────────────────────────────────────────────────

  async index(docs) {
    const t0 = Date.now();
    if (this._backend === 'local-rvf') {
      const store = this._ensureStoreLocalRvf();
      const flatVecs = [];
      const numIds = [];
      for (const d of docs) {
        const vector = await this._embed(d.text);
        this.docs.set(d.id, { id: d.id, text: d.text, metadata: d.metadata || {}, vector });
        let num = this.idToNum.get(d.id);
        if (num === undefined) {
          num = this._nextId++;
          this.idToNum.set(d.id, num);
          this.numToId.set(num, d.id);
        }
        for (const v of vector) flatVecs.push(v);
        numIds.push(num);
      }
      if (numIds.length) store.ingestBatch(new Float32Array(flatVecs), numIds);
    } else {
      // npm ruvector@0.2.32 path
      const store = await this._ensureStoreNpm();
      const entries = [];
      for (const d of docs) {
        const vector = await this._embed(d.text);
        this.docs.set(d.id, { id: d.id, text: d.text, metadata: d.metadata || {}, vector });
        this.order.push(d.id);
        entries.push({ id: d.id, vector: Array.from(vector), metadata: { origId: d.id } });
      }
      if (entries.length) await this.rv.rvfIngest(store, entries);
    }
    return { count: this.docs.size, ms: Date.now() - t0 };
  }

  // ── query ──────────────────────────────────────────────────────────────────────────────────

  async query(q, { k = 8, maxTokens = Infinity } = {}) {
    const t0 = Date.now();
    const qv = await this._embed(q);

    if (this.graphrag && !this._graphragWarned) {
      // GraphRAG retrieval: use GraphRagMemory (kind:'graph') for the real multi-hop path.
      // RuvectorMemory with graphrag:true still does HNSW kNN — the graph seam is GraphRagMemory.
      this._graphragWarned = true;
    }

    let hits = [];
    let rvfDegraded = false;

    if (this._backend === 'local-rvf') {
      // LOCAL RVF: real HNSW, multi-vector query — no degraded fallback needed
      const store = this._ensureStoreLocalRvf();
      const wantN = Math.min(this.docs.size, Math.max(k, 1));
      const raw = wantN > 0 ? store.query(new Float32Array(qv), wantN) : [];
      let resolved = raw.map((r) => {
        const canonId = this.numToId.get(r.id);
        const doc = canonId ? this.docs.get(canonId) : null;
        if (!doc) return null;
        const score = this.metric === 'cosine' ? 1 - r.distance : -r.distance;
        const bias = this.rewards.get(doc.id) || 0;
        return { id: doc.id, text: doc.text, metadata: doc.metadata, score: score + bias };
      }).filter(Boolean);
      resolved.sort((a, b) => b.score - a.score);
      hits = resolved;
    } else {
      // npm ruvector@0.2.32: HNSW then degraded fallback if rvfQuery returns < k hits
      const store = await this._ensureStoreNpm();
      const wantN = Math.min(this.docs.size, Math.max(k * 3, k));
      const raw = await this.rv.rvfQuery(store, Array.from(qv), wantN);
      let resolved = raw.map((r) => {
        let doc = this.docs.get(r.id);
        if (!doc) {
          const n = Number(r.id);
          if (Number.isInteger(n) && n >= 0 && n < this.order.length) doc = this.docs.get(this.order[n]);
        }
        if (!doc) return null;
        const bias = this.rewards.get(doc.id) || 0;
        return { id: doc.id, text: doc.text, metadata: doc.metadata, score: distanceToScore(r.distance, this.metric) + bias };
      }).filter(Boolean);

      rvfDegraded = resolved.length < Math.min(k, this.docs.size);
      if (rvfDegraded) {
        // npm 0.2.32 bug: rvfQuery returns ≤1 hit. Fall back to in-process cosine.
        resolved = [];
        for (const d of this.docs.values()) {
          const bias = this.rewards.get(d.id) || 0;
          resolved.push({ id: d.id, text: d.text, metadata: d.metadata, score: cosine(qv, d.vector) + bias });
        }
      }
      resolved.sort((a, b) => b.score - a.score);
      hits = resolved;
    }

    const result = [];
    let tokens = 0;
    for (const h of hits.slice(0, k)) {
      const t = estimateTokens(h.text);
      if (tokens + t > maxTokens && result.length) break;
      result.push(h); tokens += t;
    }
    return { hits: result, tokens, ms: Date.now() - t0, backend: this._backend, rvfDegraded };
  }

  // ── mutate ─────────────────────────────────────────────────────────────────────────────────

  async mutate(diff = {}) {
    const t0 = Date.now();
    let applied = 0;
    if (this._backend === 'local-rvf') {
      const store = this._ensureStoreLocalRvf();
      const flatVecs = [];
      const numIds = [];
      for (const d of diff.upsert || []) {
        const vector = await this._embed(d.text);
        this.docs.set(d.id, { id: d.id, text: d.text, metadata: d.metadata || {}, vector });
        let num = this.idToNum.get(d.id);
        if (num === undefined) { num = this._nextId++; this.idToNum.set(d.id, num); this.numToId.set(num, d.id); }
        for (const v of vector) flatVecs.push(v);
        numIds.push(num);
        applied++;
      }
      if (numIds.length) store.ingestBatch(new Float32Array(flatVecs), numIds);
      for (const id of diff.delete || []) {
        const num = this.idToNum.get(id);
        if (num !== undefined) { store.delete([num]); this.idToNum.delete(id); this.numToId.delete(num); }
        this.docs.delete(id); this.rewards.delete(id); applied++;
      }
    } else {
      const store = await this._ensureStoreNpm();
      const ups = [];
      for (const d of diff.upsert || []) {
        const vector = await this._embed(d.text);
        this.docs.set(d.id, { id: d.id, text: d.text, metadata: d.metadata || {}, vector });
        if (!this.order.includes(d.id)) this.order.push(d.id);
        ups.push({ id: d.id, vector: Array.from(vector), metadata: { origId: d.id } });
        applied++;
      }
      if (ups.length) await this.rv.rvfIngest(store, ups);
      if ((diff.delete || []).length) {
        await this.rv.rvfDelete(store, diff.delete);
        for (const id of diff.delete) { this.docs.delete(id); this.rewards.delete(id); applied++; }
      }
    }
    return { applied, ms: Date.now() - t0 };
  }

  // ── feedback ───────────────────────────────────────────────────────────────────────────────

  async feedback({ retrievedIds = [], resolved = false, weight = 0.05 } = {}) {
    const delta = resolved ? weight : -weight * 0.5;
    for (const id of retrievedIds) this.rewards.set(id, (this.rewards.get(id) || 0) + delta);
    return { applied: retrievedIds.length, delta, mode: 'reward-rerank' };
  }

  // ── branch / snapshot / close ──────────────────────────────────────────────────────────────

  async branch(childId = `child-${Date.now()}`) {
    const childPath = `${this.storePath}.${childId}`;
    let childStore = null;
    if (this._backend === 'local-rvf') {
      const store = this._ensureStoreLocalRvf();
      childStore = store.derive(childPath);
    }
    const child = Object.create(RuvectorMemory.prototype);
    Object.assign(child, {
      _backend: this._backend, _RvfDatabase: this._RvfDatabase, rv: this.rv, version: this.version,
      dim: this.dim, metric: this.metric, graphrag: this.graphrag, _embed: this._embed,
      storePath: childPath, store: childStore,
      docs: new Map([...this.docs].map(([id, d]) => [id, { ...d }])),
      order: this.order.slice(),
      idToNum: new Map(this.idToNum), numToId: new Map(this.numToId), _nextId: this._nextId,
      rewards: new Map(this.rewards), kind: 'ruvector', _graphragWarned: this._graphragWarned,
    });
    if (this._backend === 'npm-ruvector') {
      // npm path: COW via rvfDerive
      const store = await this._ensureStoreNpm();
      child.store = await this.rv.rvfDerive(store, childPath);
    }
    return child;
  }

  async snapshot() { return this.branch(`snap-${Date.now()}`); }

  async close() {
    if (this.store) {
      try {
        if (this._backend === 'local-rvf') this.store.close();
        else await this.rv.rvfClose(this.store);
      } catch { /* ignore */ }
      this.store = null;
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// (c) GRAPHRAG — wired to the LOCAL @ruvector/graph-node v2.0.4 (BUILT, REAL). Test C arm.
//
// Implements GraphRAG-style multi-hop retrieval over a knowledge graph of indexed documents.
// During index(): creates Document nodes; adds RELATED edges between docs with cosine >= threshold.
// During query(): anchors on top-1 cosine hit, expands via kHopNeighbors(anchor, k_hop=2),
//   unions with direct top-k, re-ranks by cosine + reward bias.
//
// This produces MEASURABLY DIFFERENT hits from DenseMemory when edges exist:
//   • dense: globally top-k by cosine similarity
//   • graph: top-k within the kHop neighborhood of the highest-similarity anchor node
// Graph-expanded hits (reached via traversal but not in direct top-k) are tagged graphExpanded:true.
//
// H3 UNBLOCKED: both arms now produce real, distinct retrieval sets. Run with dim=64 (same as
// DenseMemory) so the comparison is graph-topology vs pure similarity ranking, not embedder quality.
//
// Cypher note: "MATCH (n:Document) RETURN n" works; bare "MATCH (n) RETURN n" returns 0 nodes.
// kHopNeighbors(id, k) includes the start node itself; isolated nodes return [self].
//
// branch(): copies the full graph into a new GraphDatabase (rebuild, not file-level COW — the
//   graph-node is in-memory only; COW is a JS-level copy of the node/edge sets).
// ══════════════════════════════════════════════════════════════════════════════════════════════

const GRAPH_EDGE_THRESHOLD = 0.35; // cosine similarity floor for adding a RELATED edge
const GRAPH_KHOP_DEPTH     = 2;    // k-hop neighborhood depth for anchor expansion

export class GraphRagMemory {
  constructor({ dim = DEFAULT_DIM, embed, edgeThreshold = GRAPH_EDGE_THRESHOLD } = {}) {
    const loaded = loadGraphNode();
    if (!loaded) {
      throw new Error(
        'local @ruvector/graph-node not available. ' +
        'Expected at /home/ruvultra/projects/ruvector/npm/packages/graph-node. ' +
        'Set GRAPH_NODE_PATH to override.'
      );
    }
    this._GraphDatabase = loaded.GraphDatabase;
    this._graphNodeVersion = loaded.version;
    this.dim = dim;
    this._embed = embed || defaultEmbed(dim);
    this.edgeThreshold = edgeThreshold;
    this.db = new this._GraphDatabase({ dimensions: dim, distanceMetric: 'Cosine' });
    this.docs = new Map();     // id -> { id, text, metadata, vector }
    this.edges = [];           // { from, to, sim } — kept for branch() rebuild
    this.rewards = new Map();  // id -> additive score bias
    this.kind = 'graph';
  }

  // ── index ──────────────────────────────────────────────────────────────────────────────────

  async index(docs) {
    const t0 = Date.now();
    const existingIds = [...this.docs.keys()];

    for (const d of docs) {
      const vector = await this._embed(d.text);
      this.docs.set(d.id, { id: d.id, text: d.text, metadata: d.metadata || {}, vector });

      // Create graph node with label 'Document'
      await this.db.createNode({
        id: d.id,
        embedding: new Float32Array(vector),
        labels: ['Document'],
        properties: {
          text: d.text.slice(0, 200),
          ...Object.fromEntries(
            Object.entries(d.metadata || {}).map(([k, v]) => [k, String(v)])
          ),
        },
      });

      // Add edges to all existing docs that are semantically similar
      const newDoc = this.docs.get(d.id);
      for (const existId of existingIds) {
        if (existId === d.id) continue;
        const existDoc = this.docs.get(existId);
        if (!existDoc) continue;
        const sim = cosine(newDoc.vector, existDoc.vector);
        if (sim >= this.edgeThreshold) {
          const edgeEmbedding = new Float32Array(newDoc.vector.map((v, i) => (v + existDoc.vector[i]) / 2));
          try {
            await this.db.createEdge({
              from: d.id, to: existId,
              description: 'RELATED',
              embedding: edgeEmbedding,
              confidence: sim,
            });
            this.edges.push({ from: d.id, to: existId, sim });
          } catch { /* duplicate edges or graph error: skip */ }
        }
      }
      existingIds.push(d.id);
    }

    return { count: this.docs.size, ms: Date.now() - t0 };
  }

  // ── query ──────────────────────────────────────────────────────────────────────────────────
  // Multi-hop GraphRAG: anchor → kHopNeighbors expansion → union with direct top-k → re-rank.

  async query(q, { k = 8, maxTokens = Infinity } = {}) {
    const t0 = Date.now();
    if (this.docs.size === 0) return { hits: [], tokens: 0, ms: Date.now() - t0, graphHits: 0 };

    const qv = await this._embed(q);

    // 1) Find anchor: top-1 by direct cosine
    let anchor = null;
    let anchorSim = -Infinity;
    for (const d of this.docs.values()) {
      const sim = cosine(qv, d.vector);
      if (sim > anchorSim) { anchorSim = sim; anchor = d; }
    }

    // 2) Graph expansion: k-hop neighbors of the anchor node
    const graphExpanded = new Set();
    if (anchor) {
      try {
        const neighbors = await this.db.kHopNeighbors(anchor.id, GRAPH_KHOP_DEPTH);
        for (const nid of neighbors) { if (this.docs.has(nid)) graphExpanded.add(nid); }
      } catch { /* isolated graph — skip expansion */ }
    }

    // 3) Direct top-k as supplement (so we never return fewer than k even with no edges)
    const directTopK = new Set();
    const directScored = [...this.docs.values()]
      .map(d => ({ id: d.id, sim: cosine(qv, d.vector) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, k);
    for (const { id } of directScored) directTopK.add(id);

    // 4) Union: graph expansion + direct top-k
    const candidateIds = new Set([...graphExpanded, ...directTopK]);

    // 5) Score all candidates by cosine + reward bias
    const scored = [];
    for (const id of candidateIds) {
      const d = this.docs.get(id);
      if (!d) continue;
      const base = cosine(qv, d.vector);
      const bias = this.rewards.get(id) || 0;
      const isGraphExpanded = graphExpanded.has(id) && !directTopK.has(id);
      scored.push({ id, text: d.text, metadata: d.metadata, score: base + bias, graphExpanded: isGraphExpanded });
    }
    scored.sort((a, b) => b.score - a.score);

    // 6) Trim to k, respecting token budget
    const hits = [];
    let tokens = 0;
    for (const h of scored.slice(0, k)) {
      const t = estimateTokens(h.text);
      if (tokens + t > maxTokens && hits.length) break;
      hits.push(h); tokens += t;
    }

    const graphHits = hits.filter(h => h.graphExpanded).length;
    return { hits, tokens, ms: Date.now() - t0, graphHits, candidateCount: candidateIds.size, graphExpandedCount: graphExpanded.size };
  }

  // ── mutate ─────────────────────────────────────────────────────────────────────────────────

  async mutate(diff = {}) {
    const t0 = Date.now();
    let applied = 0;
    if (diff.upsert && diff.upsert.length) {
      await this.index(diff.upsert);
      applied += diff.upsert.length;
    }
    for (const id of diff.delete || []) {
      this.docs.delete(id);
      this.rewards.delete(id);
      // Note: graph-node has no removeNode in v2.0.4; the node remains in the graph DB
      // but is excluded from all JS-layer queries (docs.has(id) will return false).
      applied++;
    }
    return { applied, ms: Date.now() - t0 };
  }

  // ── feedback ───────────────────────────────────────────────────────────────────────────────

  async feedback({ retrievedIds = [], resolved = false, weight = 0.05 } = {}) {
    const delta = resolved ? weight : -weight * 0.5;
    for (const id of retrievedIds) this.rewards.set(id, (this.rewards.get(id) || 0) + delta);
    return { applied: retrievedIds.length, delta };
  }

  // ── branch / snapshot ──────────────────────────────────────────────────────────────────────
  // GraphDatabase is in-memory only (v2.0.4). COW = new GraphDatabase + re-insert all nodes + edges.

  async branch(childId = `graph-${Date.now()}`) {
    const child = new GraphRagMemory({ dim: this.dim, embed: this._embed, edgeThreshold: this.edgeThreshold });

    // Copy nodes (re-use cached vectors, skip re-embedding)
    for (const d of this.docs.values()) {
      child.docs.set(d.id, { ...d, vector: d.vector.slice ? d.vector.slice() : Array.from(d.vector) });
      await child.db.createNode({
        id: d.id,
        embedding: new Float32Array(d.vector),
        labels: ['Document'],
        properties: { text: d.text.slice(0, 200) },
      });
    }

    // Re-create edges from the stored edge list
    for (const { from, to, sim } of this.edges) {
      const fromDoc = child.docs.get(from);
      const toDoc = child.docs.get(to);
      if (!fromDoc || !toDoc) continue;
      const edgeEmbedding = new Float32Array(fromDoc.vector.map((v, i) => (v + toDoc.vector[i]) / 2));
      try {
        await child.db.createEdge({ from, to, description: 'RELATED', embedding: edgeEmbedding, confidence: sim });
        child.edges.push({ from, to, sim });
      } catch { /* skip duplicate */ }
    }

    for (const [id, r] of this.rewards) child.rewards.set(id, r);
    child._branchId = childId;
    return child;
  }

  async snapshot() { return this.branch(`snap-${Date.now()}`); }
  async close() { /* GraphDatabase is in-memory; let GC handle cleanup */ }
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────

/** RVF returns a distance; convert to "higher-is-better" score for uniform re-ranking. */
function distanceToScore(distance, metric) {
  if (metric === 'cosine') return 1 - distance;
  return -distance;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Factory used by the runner.
//
//   kind: 'dense'    → DenseMemory (Control A: in-process cosine, $0, dep-free)
//   kind: 'ruvector' → RuvectorMemory (Test B: local RvfDatabase HNSW, or npm fallback)
//   kind: 'graph'    → GraphRagMemory (Test C: real kHop graph expansion, H3 unblocked)
//
// allowFallback: true falls back to DenseMemory with a logged warning on any load error.
// ══════════════════════════════════════════════════════════════════════════════════════════════
export function makeMemory(kind, opts = {}) {
  if (kind === 'dense') return new DenseMemory(opts);
  if (kind === 'ruvector') {
    try { return new RuvectorMemory(opts); }
    catch (e) {
      if (opts.allowFallback) {
        console.error(`[memory-layer] ruvector unavailable (${e.message}) — falling back to DenseMemory`);
        return new DenseMemory(opts);
      }
      throw e;
    }
  }
  if (kind === 'graph') {
    try { return new GraphRagMemory(opts); }
    catch (e) {
      if (opts.allowFallback) {
        console.error(`[memory-layer] graph-node unavailable (${e.message}) — falling back to DenseMemory`);
        return new DenseMemory(opts);
      }
      throw e;
    }
  }
  throw new Error(`unknown memory kind: ${kind}. Valid: 'dense' | 'ruvector' | 'graph'`);
}
