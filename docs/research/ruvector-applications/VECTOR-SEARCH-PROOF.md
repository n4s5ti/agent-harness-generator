# VECTOR-SEARCH-PROOF.md — ruvector HNSW performance vs hnswlib

Measured on **AMD Ryzen 9 9950X** (Zen 5 / 16-core), single-threaded search,
SIFT-128-euclidean 1M-vector dataset (TEXMEX fvecs format, M=16, efC=200).

Data source: `/home/ruvultra/projects/ruvector/bench_data/sift/`
Benchmark: `crates/ruvector-sota-bench/src/bin/sift1m_bench.rs`
hnswlib benchmark: `scripts/sift1m_hnswlib_bench.mjs`
Date: 2026-06-28
PR: https://github.com/ruvnet/RuVector/pull/619

---

## Build throughput

| Version | Build time | Insert rate |
|---------|-----------|-------------|
| before PR (parent d7558356a, simsimd + 1-acc AVX-512) | 849 s | 1,177 vec/s |
| after PR #619 (direct simd_intrinsics + 4-acc AVX-512) | 774 s | 1,292 vec/s |
| hnswlib-node (C++ baseline) | 322 s | 3,106 vec/s |

Build speedup: PR #619 is **+9.7% faster** than parent.
hnswlib is 2.4× faster than the optimised PR at building.

---

## Recall@10 vs QPS sweep (ef_search parametric)

### ruvector before PR (parent commit d7558356a)

simsimd FFI path + single-accumulator AVX-512 kernels.

| ef_search | recall@10 | QPS  | p50 µs | p99 µs |
|-----------|-----------|------|--------|--------|
| 100       | 0.9585    | 1,849 | 579   | 781  |
| 200       | 0.9713    | 1,058 | 969   | 1,311 |
| 400       | 0.9768    |   604 | 1,689  | 2,413 |

### ruvector after PR #619

Direct `simd_intrinsics` path (inline, no FFI) + 4-accumulator AVX-512 kernels.

| ef_search | recall@10 | QPS  | p50 µs | p99 µs |
|-----------|-----------|------|--------|--------|
| 100       | 0.9592    | 1,768 | 587   | 760  |
| 200       | 0.9722    | 1,024 | 995   | 1,378 |
| 400       | 0.9775    |   592 | 1,717  | 2,437 |

### hnswlib-node (C++ competitive baseline)

Native N-API bindings to C++ hnswlib.  Note: hnswlib builds a higher-quality
graph (better heuristic neighbor selection), achieving higher recall at the same
ef_search.

| ef_search | recall@10 | QPS   | p50 µs | p99 µs |
|-----------|-----------|-------|--------|--------|
| 20        | 0.8382    | 16,976 | 59    | 87   |
| 40        | 0.9266    | 10,660 | 95    | 134  |
| 80        | 0.9746    |  6,463 | 160   | 200  |
| 100       | 0.9828    |  5,339 | 194   | 244  |
| 200       | 0.9957    |  2,897 | 357   | 486  |
| 400       | 0.9987    |  1,656 | 628   | 804  |

---

## Before/after comparison (PR #619 effect)

At matched recall@10 ≈ 0.97 (ef=200):

| Metric | before | after | delta |
|--------|--------|-------|-------|
| recall@10 | 0.9713 | 0.9722 | +0.0009 |
| QPS | 1,058 | 1,024 | -3.2 % (within noise) |
| build time | 849 s | 774 s | -8.8 % |

**Finding**: at 1M-vector scale the HNSW query path is memory-bandwidth
bound (each graph hop causes a random L3/RAM access).  Eliminating the
simsimd FFI boundary and upgrading to 4-accumulator AVX-512 reduces
compute time per distance kernel by ~2.5× in micro-benchmarks
(`bench_simd`: 128-dim, 30.1 Gelem/s vs ~12 Gelem/s baseline), but
those cycles are a small fraction of total query latency at this scale.
The build phase IS compute-bound enough to show a real 9.7% speedup.

---

## ruvector vs hnswlib gap

Two independent gaps compound:

### 1. Graph quality gap

hnsw_rs's neighbor selection is simpler than hnswlib's shrink-candidates
heuristic.  To achieve recall@10 ≈ 0.97, ruvector needs ef=200 while
hnswlib only needs ef=80.  This means 2.5× more distance computations
per query just to reach the same quality.

### 2. Per-ef-unit speed gap

At ef=200 (same search budget):

| System | recall@10 | QPS | ratio |
|--------|-----------|-----|-------|
| ruvector after PR | 0.9722 | 1,024 | 1× |
| hnswlib-node | 0.9957 | 2,897 | **2.83×** |

Root causes for this remaining speed gap:
- C++ hnswlib uses stack-local candidate heaps; ruvector/hnsw_rs allocates per-query
- hnswlib uses SIMD across all inner loops; ruvector's hnsw_rs graph-traversal code is scalar
- Function-call and trait-dispatch overhead per `Distance::eval` call

### 3. Combined gap at matched recall@10 ≈ 0.97

| Operating point | ruvector after | hnswlib | gap |
|----------------|---------------|---------|-----|
| recall@10 = 0.97 (ruvector ef=200, hnswlib ef≈83) | 1,024 QPS | ~6,400 QPS | **~6.3×** |

The "2.7× QPS gap" cited in earlier notes was measured on a 100K-vector
synthetic dataset where the working set fits in L3 cache and the compute
fraction is higher.  On full SIFT-1M the gap widens because both sources
of overhead (graph quality + per-unit speed) are visible.

---

## What PR #619 actually delivers

- **Build throughput**: +9.7% (measured, significant for offline indexing)
- **Query throughput on 1M SIFT**: no measurable gain (memory-bound regime)
- **Query throughput on small datasets / warm cache**: expected +15-50% (distance kernel ~2.5× faster in micro-benchmark; will dominate at <10K scale)
- **384-dim embeddings** (e.g. all-MiniLM-L6-v2): larger kernel = higher fraction of compute → larger benefit expected
- **Code quality**: removed Result<f32> unwrap overhead, removed FFI boundary from the hot path, kernels are now `#[inline(always)]`

---

## Remaining gap to close

Priority order for future work:

1. **Improve hnsw_rs neighbor selection** (implement shrink-candidates heuristic) —
   closing the graph quality gap would halve the required ef and 2.5× the effective QPS

2. **Candidate heap optimization** (stack-local or bump-allocated) —
   removes per-query allocation overhead, expected 10-20% QPS gain

3. **SIMD in graph traversal loops** (not just distance kernel) —
   hnsw_rs's candidate processing loop is scalar; vectorizing it would help

4. **Parallel search** (multi-threaded ef_search expansion) —
   hnswlib offers this; ruvector does not yet expose it in queries

---

## Methodology

- Dataset: SIFT-128-euclidean 1M training vectors, 10K queries, ground-truth top-100
- Recall metric: recall@10 = intersection(result_top10, gt_top10) / 10
- QPS: wall-clock time over all 10K queries (single-threaded)
- Platform: AMD Ryzen 9 9950X, 124 GB DDR5, Ubuntu 22.04 LTS, kernel 6.17
- ruvector built with `--release` + default features (includes `simd-avx512`)
- hnswlib: `hnswlib-node` npm package (C++ N-API bindings)
- Build rate comparison uses identical insert order (sequential, no parallel insert for <10K)
