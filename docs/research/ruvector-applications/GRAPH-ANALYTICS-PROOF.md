# ruvector Graph Analytics — Proof & Honest Verdict

**Subject:** `@ruvector/graph-node` v2.0.4 (native NAPI binding; pkg manifest says 2.0.3, runtime `version()` returns 2.0.4)
**Question:** Is ruvector's "graph analytics" an *optimal / competitive* application?
**Cost:** $0 — local benchmark only, no LLM, no paid API.
**Date:** 2026-06-28
**Binary under test:** `/home/ruvultra/projects/ruvector/node_modules/@ruvector/graph-node-linux-x64-gnu/ruvector-graph.node` (5.0 MB, loaded via `require('@ruvector/graph-node')`).

**Bench host:** AMD Ryzen 9 9950X (32 threads), 123 GiB RAM, Linux 6.17, Node v22.22.2. All numbers single-process, warm.

---

## TL;DR verdict

ruvector graph-node is **genuinely fast and competitive at exactly one thing: embedded property-graph *k-hop neighborhood expansion* + *vector/hyperedge semantic similarity search***. That is a GraphRAG / agent-memory retrieval substrate.

It is **NOT** a graph-analytics engine in the SOTA sense:

- **No graph algorithms at all** — `pageRank`, `shortestPath`, centrality, community detection, connected-components are **not exposed** in the API. The marketing term "graph analytics" is unsupported by the surface area.
- **"Cypher" is a misnomer** — the only query pattern that returns data is a **label-scoped node scan** (`MATCH (n:Label) RETURN n`). Every relationship pattern, variable-length path, `WHERE` clause, `RETURN` expression, aggregation, and `CREATE` returns **empty**. No edges are ever returned through the query interface.
- **A real consistency bug:** the label index that Cypher reads is populated by `createNode` **but not by `batchInsert`** — so the fastest ingest path makes nodes invisible to Cypher (though still traversable by kHop).

So the honest framing: **ruvector graph-node = a fast in-memory property-graph + HNSW-style vector store with undirected k-hop BFS. Use it for GraphRAG retrieval, not for Cypher OLAP or network-science analytics.**

---

## 1. API surface (what actually exists)

From `index.d.ts` + runtime introspection, `GraphDatabase` exposes:

| Method | Purpose | Works? |
|---|---|---|
| `createNode(node)` | insert node (id, Float32 embedding, labels, properties) | ✅ |
| `createEdge(edge)` | insert directed edge (from, to, description, embedding, confidence) | ✅ |
| `createHyperedge(h)` | insert hyperedge over N nodes + embedding | ✅ |
| `batchInsert({nodes,edges})` | bulk insert | ✅ (but see §5 — not label-indexed) |
| `kHopNeighbors(start, k)` | k-hop traversal | ✅ (undirected BFS, incl. self) |
| `searchHyperedges({embedding,k})` | vector kNN over hyperedges | ✅ |
| `query(cypher)` / `querySync(cypher)` | "Cypher" | ⚠️ label-scan only (see §4) |
| `stats()` | node/edge counts, avg degree | ✅ |
| `begin/commit/rollback` | transactions | present (not stress-tested) |
| `subscribe(cb)` | change stream | present |
| persistence: `open(path)`, `isPersistent()`, `getStoragePath()` | on-disk | ✅ (constructor `storagePath` works) |
| `pageRank` / `shortestPath` / centrality / community | **graph analytics** | ❌ **DO NOT EXIST** |

The absence of any algorithm method is the single most important finding for the stated question.

---

## 2. Ingest throughput

Synthetic **Barabási–Albert scale-free** graph (preferential attachment, m=5), deterministic PRNG. Measured two ingest paths.

| Path | Scale | nodes/sec | edges/sec | Notes |
|---|---|---|---|---|
| `batchInsert` (chunk 5000) | 10k nodes / 49,975 edges | **497,283** | **371,252** | ~388k elem/sec total; **NOT label-indexed** |
| `createNode` / `createEdge` (per-item async) | 10k / 49,975 | 80,291 | 90,809 | label-indexed; Cypher-visible |
| `createNode` / `createEdge` | 50k / 249,975 | 77,054 | 77,518 | scales ~linearly |
| `createNode` micro (2k sample) | — | 64,221 | 70,680 | per-call NAPI/Promise overhead |

**Memory:** batchInsert of 10k nodes + 50k edges (dim-8 embeddings) cost ~**84 MB RSS** (~1.4 KB / element). That is heavy per element (small embeddings + UUIDs + property maps + index overhead).

**Reading:** ingest is *fine* (hundreds of k/sec via batch) but the batch path trades away the label index. Single-element createNode (~64–90k/sec) is respectable for an embedded store but is dominated by per-Promise NAPI overhead.

---

## 3. k-Hop traversal latency (the strong suit)

createNode-built graph; 200 random start nodes; depth 1/2/3. kHop is **undirected BFS reachability including the start node** (characterized in §6).

| Scale | depth | mean | p50 | p95 | avg neighborhood | throughput |
|---|---|---|---|---|---|---|
| 10k / 50k edges | 1 | 0.015 ms | 0.012 | 0.025 | 10 nodes | **67,900 q/s** |
| 10k | 2 | 0.149 ms | 0.119 | 0.379 | 255 nodes | 6,700 q/s |
| 10k | 3 | 1.958 ms | 1.557 | 4.465 | 3,566 nodes (36% of graph) | 511 q/s |
| 50k / 250k edges | 1 | 0.014 ms | 0.012 | 0.026 | 11 nodes | **70,000 q/s** |
| 50k | 2 | 0.177 ms | 0.108 | 0.472 | 336 nodes | 5,600 q/s |
| 50k | 3 | 4.462 ms | 2.462 | 14.63 | 7,091 nodes (14% of graph) | 224 q/s |

**Reading:** 1-hop neighbor fetch at ~**0.015 ms / 67k qps** is excellent and effectively scale-invariant (index-free adjacency behavior). Depth-2 is sub-millisecond. Depth-3 latency is dominated by result-set size — on a small-world scale-free graph a 3-hop ball already covers 14–36% of the graph, so the cost is "materialize thousands of node ids," not traversal inefficiency. This is the genuinely competitive capability.

---

## 4. Cypher coverage — the real supported subset

Tested 17 query patterns against a known 5-node graph (A→B→C→D chain + A,B→E fan, with labels Person/Company/Project).

| Query | Result | Supported? |
|---|---|---|
| `MATCH (n:Person) RETURN n` | returns the 2 Person nodes | ✅ **label scan** |
| `MATCH (n:Company) RETURN n` | returns C,D | ✅ |
| `MATCH (n:DoesNotExist) RETURN n` | 0 | ✅ (correct empty) |
| `MATCH (n) RETURN n` | **0 nodes** | ❌ bare match broken |
| `MATCH (n) RETURN n LIMIT 2` | 0 | ❌ |
| `MATCH (a)-->(b) RETURN a,b` | 0 | ❌ **no relationship traversal** |
| `MATCH (a)-[r]->(b) RETURN a,r,b` | 0 | ❌ |
| `MATCH (a:Person)-[r]->(b) RETURN ...` | 0 | ❌ |
| `MATCH (a)-[:knows]->(b) RETURN a,b` | 0 | ❌ |
| `MATCH (a)-[*1..2]->(b) RETURN b` | 0 | ❌ **no var-length paths** |
| `MATCH (n:Person {name:"Alice"}) RETURN n` | **returns BOTH Person nodes** | ⚠️ **property filter ignored** |
| `MATCH (n) WHERE n.name="Alice" RETURN n` | 0 | ❌ **no WHERE** |
| `RETURN 1` | 0 | ❌ |
| `MATCH (n) RETURN count(n)` | 0 | ❌ **no aggregation** |
| `CREATE (n:Test {...}) RETURN n` | 0 | ❌ **no write via Cypher** |

**The entire supported Cypher subset is: `MATCH (n:<Label>) RETURN n`** — a label-indexed node scan that returns nodes only (never edges), and whose inline property map is silently ignored (it does not filter). This confirms and sharpens the earlier finding: label-scoped reads work; bare `MATCH (n)` and all relationship patterns return 0.

**Label-scan latency** (createNode-built): 10k graph → ~3.8 ms to return 2,500 nodes; 50k graph → ~19 ms to return 12,500 nodes. So ~1.5–2 µs per returned node — a linear scan/projection, not an indexed point lookup, but adequate.

---

## 5. The batchInsert ↔ Cypher consistency bug (proven)

| Ingest path | `MATCH (n:Person)` returns | kHop sees nodes? | in `stats()`? |
|---|---|---|---|
| 100 nodes via `createNode` | **100** | ✅ | ✅ |
| 100 nodes via `batchInsert` | **0** | ✅ (kHop works) | ✅ (counts correct) |
| mixed: 100 batch + 1 createNode | **1** (only the createNode one) | ✅ | ✅ |

`batchInsert` populates adjacency (kHop) and `stats()` but **not** the label index that `query()` reads. The high-throughput ingest path therefore makes data invisible to the only working Cypher pattern. A user who bulk-loads and then queries by label gets silent empty results.

---

## 6. kHop semantics & correctness (known-answer)

On the 5-node known graph (A→B→C→D, A→E, B→E):

| Call | Result | Interpretation |
|---|---|---|
| `kHop(A,1)` | {A,B,E} | self + 1-hop out-neighbors |
| `kHop(A,2)` | {A,B,C,E} | + C (via B→C) |
| `kHop(A,3)` | {A,B,C,D,E} | + D — full reachability |
| `kHop(D,1)` | {D,C} | found C via the **incoming** edge C→D → **traversal is undirected** |
| `kHop("ZZZ",1)` | {ZZZ} | missing node → returns just itself, no error |

So `kHopNeighbors(start,k)` = **the set of nodes within ≤k undirected hops, including `start` itself.** Correct as a reachability ball; note it is (a) undirected regardless of edge direction, and (b) self-inclusive, which a caller must account for. No directed-traversal option is exposed.

---

## 7. Hyperedge vector search (works — part of the real value prop)

`createHyperedge` + `searchHyperedges({embedding,k})` returns ranked results by embedding distance (lower = closer). Query embedding matching hyperedge h1 exactly → score 1.4e-10 (≈0 distance, ranked first); unrelated h2 → 0.240 (ranked second). **Correct kNN ranking.** This is the vector-store half of the engine and it functions as advertised. Persistence (`storagePath`, `isPersistent()`, `open()`) also works.

---

## 8. SOTA comparison (matched ~10k–50k-node scale)

Published reference figures for embedded/standard graph tooling (approximate, order-of-magnitude — sources cited):

| Capability | ruvector graph-node (measured) | KuzuDB (embedded) | Neo4j (embedded) | NetworkX (Python) |
|---|---|---|---|---|
| Bulk ingest | 388k elem/s (batch) / 77–90k/s (txn) | **Millions edges/s** via `COPY` columnar bulk loader [1] | ~10–50k/s txn; **~1M+/s** via `neo4j-admin import` [2] | ~0.1–1M edges/s (dict ops, in-RAM) [3] |
| 1-hop neighbor fetch | **0.015 ms / 67k qps** ✅ | sub-ms (factorized joins) [1] | sub-ms (index-free adjacency) [2] | ~µs (`G[node]` dict) but no persistence [3] |
| Multi-hop / var-length path query | ❌ not queryable (kHop ball only) | ✅ factorized `*1..k` paths, very fast [1] | ✅ `*1..k` Cypher [2] | ✅ `descendants_at_distance`, BFS [3] |
| Full Cypher (MATCH rel, WHERE, agg) | ❌ **label scan only** | ✅ broad openCypher subset [1] | ✅ reference Cypher [2] | n/a (Python API) |
| PageRank | ❌ **absent** | ✅ (algorithm extensions) | ✅ GDS library [4] | ✅ `nx.pagerank` (~sub-s @10k) [3] |
| Shortest path / centrality / community | ❌ **absent** | ✅ | ✅ (GDS) [4] | ✅ full suite [3] |
| Vector kNN over graph elements | ✅ hyperedge search | ✅ (vector index, recent) [1] | ✅ (vector index 5.x) [2] | ❌ |
| Embeddings as first-class node/edge attr | ✅ (native Float32 + distance metric) | partial | partial (vector index) | ❌ |

[1] Kùzu docs & benchmarks — columnar storage, `COPY` bulk loader, factorized join execution, openCypher: https://kuzudb.com/ , https://blog.kuzudb.com/
[2] Neo4j docs — `neo4j-admin database import` bulk loader throughput, index-free adjacency, Cypher reference: https://neo4j.com/docs/operations-manual/current/tools/neo4j-admin/neo4j-admin-import/
[3] NetworkX docs — pure-Python in-memory graph, algorithm suite incl. `pagerank`, BFS `descendants_at_distance`: https://networkx.org/documentation/stable/reference/algorithms/
[4] Neo4j Graph Data Science (GDS) — PageRank/centrality/community algorithm library: https://neo4j.com/docs/graph-data-science/current/

**Where ruvector wins / ties:** 1-hop neighbor retrieval throughput is in the same league as index-free-adjacency engines, and it ships **embeddings + vector kNN as first-class graph primitives** — something Neo4j/Kuzu only added recently and NetworkX lacks entirely. That combination (graph adjacency + native vector similarity in one embedded binary) is its differentiator.

**Where it falls short of SOTA (decisively):**
1. **No query language for relationships** — Kuzu/Neo4j answer "friends-of-friends who work at X" in Cypher; ruvector cannot express this at all (kHop returns an undifferentiated id ball with no edge/label/property filtering).
2. **No graph algorithms** — every network-science task (PageRank, shortest path, centrality, communities) is absent; NetworkX/igraph/graph-tool/Neo4j-GDS all provide them.
3. **Bulk-load consistency bug** — the fast ingest path desyncs from the label index.
4. **Per-element memory** (~1.4 KB) is high; Kuzu's columnar layout is far denser.

---

## 9. Verdict — the real optimal application

**Proven strengths (use these):**
- **Sub-20µs, ~67k-qps 1-hop neighbor expansion**, scale-invariant to 50k nodes — ideal for online GraphRAG context expansion ("given this node, pull its neighborhood").
- **Native embeddings on nodes/edges/hyperedges + correct vector kNN** (`searchHyperedges`) — a graph-structured vector memory.
- **Cheap label-scoped node scans** and working persistence.

**Proven limitations (do not use it for these):**
- Not a Cypher database — only `MATCH (n:Label) RETURN n` works; no relationship/path/WHERE/aggregation queries, no edges returned, property filters ignored.
- Not a graph-analytics engine — **no PageRank, shortest-path, centrality, or community algorithms exist.**
- Bulk-loaded (`batchInsert`) nodes are invisible to Cypher label-scan.

**Optimal application statement:**
> ruvector graph-node is an **embedded GraphRAG / agent-memory substrate**: a fast property-graph for *k-hop neighborhood retrieval* fused with a *vector store for semantic similarity over nodes and hyperedges*. It is **competitive (SOTA-adjacent) for shallow-traversal + vector-kNN retrieval**, and **not competitive — by absence of features, not by speed —** as a Cypher OLTP/OLAP database or a network-science analytics toolkit. The label "graph analytics" overstates the surface; the honest label is "graph-structured vector memory with k-hop expansion."

---

## 10. Reproduce

Scripts (run with `NODE_PATH=/home/ruvultra/projects/ruvector/node_modules` from the ruvector repo so the native binding resolves):

- `probe.js` — API + Cypher coverage on the 5-node known graph (§1,§4,§6)
- `bench.js` — batchInsert ingest + kHop + Cypher latency, BA graph (§2,§3,§5)
- `bench2.js N m` — createNode-built BA graph, kHop + Cypher latency at scale (§3,§4)
- `probe2.js` — batchInsert vs createNode label-index consistency (§5)
- `probe3.js` — hyperedge vector search + persistence (§7)

(Bench scripts are kept in the session scratchpad; the measured outputs above are the artifact of record.)
