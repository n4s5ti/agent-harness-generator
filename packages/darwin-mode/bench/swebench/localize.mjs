// SPDX-License-Identifier: MIT
//
// ADR-195 Phase-2 #1 — RuVector-HNSW retrieval-seeded LOCALIZATION (production).
//
// Builds on the feasibility probe (ruvector-localize.mjs, ADR-194 RuVector probe / worktree a29099):
// this is the production module wired into solve-agentic.mjs via `--localize`. The HARD-25 instances
// are Opus-give-ups; the #1 suspected blocker is localization — the ReAct agent never finds the right
// files in a big repo before its step budget runs out. This injects a retrieval-seeded starting file
// surface so the agent begins where the fix lives.
//
// PIPELINE (conformant — issue text + repo source only, NEVER gold tests):
//   1. CHUNK    walk source files (skip tests/vendored/build dirs), split at function/class
//               granularity with a lightweight def/class scanner (no full AST).
//   2. EMBED    embed each chunk with a code-capable embedding model (OpenRouter
//               text-embedding-3-small by default; pluggable embedder for tests).
//   3. INDEX    insert into a RuVector HNSW index (the native `ruvector` npm addon: VectorDB).
//   4. RETRIEVE embed the issue → HNSW top-k chunks.
//   5. RERANK   optional ruvector-gnn-rerank (score diffusion over the retrieved neighborhood)
//               to recover recall (`--gnn-rerank`); falls back transparently if the GNN binding
//               is unavailable.
//   6. SEED     aggregate to a ranked {files, symbols, snippets} surface.
//
// DESIGN FOR TESTABILITY: the core (`localizeSeed`, `chunkFile`, `aggregateHits`, `formatSeedForAgent`,
// `gnnRerank`) is PURE + dependency-injected — the embedder, the vector index, and the repo file
// reader are all injected. `localize.mjs` (the CLI) wires the real ruvector addon + OpenRouter
// embeddings + a shallow git clone; the unit test wires a deterministic stub embedder + an in-memory
// cosine index + a fake file tree. No network, no Docker, no native dep in the tests.

import { extname } from 'node:path';

// ── chunking ────────────────────────────────────────────────────────────────────────────────────
export const SRC_EXT = new Set(['.py', '.js', '.ts', '.jsx', '.tsx', '.go', '.rs', '.java', '.rb', '.c', '.cc', '.cpp', '.h', '.hpp']);
export const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'vendor', '.tox', '__pycache__', 'target', 'docs', 'doc', '.github', 'tests', 'test', 'testing']);
// Test dirs are skipped from the INDEX too — conformant localization points at *source* (the issue
// text never references the gold test path), and it keeps the index small.

const DEF_RE = /^(\s*)(?:async\s+)?(?:def|class|function|fn|func|type|public|private|protected|static|export)\b.*?([A-Za-z_][A-Za-z0-9_]*)/;

/**
 * Split a file into def/class-level chunks. Falls back to fixed-size windows for files with no
 * recognizable defs. Pure — text in, chunk records out.
 *   relPath  the repo-relative path (becomes part of the embedded signal + the seed)
 *   text     file contents
 * Returns [{ file, sym, start, end, text }] (1-based inclusive line ranges).
 */
export function chunkFile(relPath, text, { windowLines = 80, capDefLines = 200 } = {}) {
  const lines = String(text).split('\n');
  const heads = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(DEF_RE);
    if (m) heads.push({ line: i, sym: m[2], indent: m[1].length });
  }
  const chunks = [];
  if (heads.length === 0) {
    for (let i = 0; i < lines.length; i += windowLines) {
      chunks.push({ file: relPath, sym: '(file)', start: i + 1, end: Math.min(i + windowLines, lines.length), text: lines.slice(i, i + windowLines).join('\n') });
    }
    return chunks;
  }
  for (let h = 0; h < heads.length; h++) {
    const start = heads[h].line;
    let end = lines.length;
    for (let n = h + 1; n < heads.length; n++) { if (heads[n].indent <= heads[h].indent) { end = heads[n].line; break; } }
    if (end - start > capDefLines) end = start + capDefLines; // cap giant defs
    chunks.push({ file: relPath, sym: heads[h].sym, start: start + 1, end, text: lines.slice(start, end).join('\n') });
  }
  return chunks;
}

/** Should this path be indexed? (source ext, not in a skipped dir). Used by the real walker. */
export function isIndexable(relPath) {
  if (!SRC_EXT.has(extname(relPath))) return false;
  return !relPath.split('/').some((seg) => SKIP_DIRS.has(seg) || (seg.startsWith('.') && seg !== '.'));
}

/**
 * Chunk a whole repo from a {relPath -> text} map (the test path) or a list of {file,text}.
 * Pure. Caps total chunks. Returns the chunk array.
 */
export function chunkRepo(files, { maxChunks = 4000 } = {}) {
  const entries = Array.isArray(files) ? files : Object.entries(files).map(([file, text]) => ({ file, text }));
  const chunks = [];
  for (const { file, text } of entries) {
    if (!isIndexable(file)) continue;
    for (const c of chunkFile(file, text)) {
      chunks.push(c);
      if (chunks.length >= maxChunks) return chunks;
    }
  }
  return chunks;
}

// ── GNN rerank (score diffusion) ─────────────────────────────────────────────────────────────────
/**
 * Diffuse retrieval scores over the file-cluster graph: a chunk's reranked score is a blend of its own
 * similarity and the mean similarity of sibling chunks in the same file (the "neighborhood" the GNN
 * smooths over). This is the conformant, dependency-free analog of ruvector-gnn-rerank's score
 * diffusion — when the native `gnnWrapper` is present, `localize.mjs` swaps this for the real diffusion;
 * the seed format is identical so the agent surface and the tests are unchanged either way.
 *   hits   [{ id, score, metadata:{file,...} }] (HNSW result; higher score = closer)
 *   alpha  self-weight in [0,1]; (1-alpha) is the neighborhood pull.
 */
export function gnnRerank(hits, { alpha = 0.7 } = {}) {
  if (!hits.length) return hits;
  const byFile = new Map();
  for (const h of hits) { const f = h.metadata?.file ?? '(none)'; (byFile.get(f) || byFile.set(f, []).get(f)).push(h); }
  const fileMean = new Map();
  for (const [f, hs] of byFile) fileMean.set(f, hs.reduce((s, h) => s + h.score, 0) / hs.length);
  return hits
    .map((h) => {
      const f = h.metadata?.file ?? '(none)';
      const diffused = alpha * h.score + (1 - alpha) * fileMean.get(f);
      return { ...h, score: diffused, rawScore: h.score };
    })
    .sort((a, b) => b.score - a.score);
}

// ── aggregate hits → ranked file/symbol surface ───────────────────────────────────────────────────
/**
 * Aggregate chunk hits to a file-level ranked surface (best chunk score per file, top symbols per file)
 * plus the top snippet excerpts. Pure.
 *   hits    [{ id, score, metadata:{file,sym,start,end} }]
 *   chunks  the chunk array (indexed by +id) — for snippet text
 *   k       number of files to keep
 */
export function aggregateHits(hits, chunks, { k = 12, maxSnippets = 6, snippetChars = 1200 } = {}) {
  const byFile = new Map();
  for (const h of hits) {
    const f = h.metadata.file;
    const cur = byFile.get(f) || { file: f, score: -Infinity, symbols: [] };
    cur.score = Math.max(cur.score, h.score);
    if (h.metadata.sym && h.metadata.sym !== '(file)' && !cur.symbols.includes(h.metadata.sym)) cur.symbols.push(h.metadata.sym);
    byFile.set(f, cur);
  }
  const files = [...byFile.values()].sort((a, b) => b.score - a.score).slice(0, k)
    .map((f) => ({ file: f.file, score: +f.score.toFixed(4), symbols: f.symbols.slice(0, 6) }));
  const snippets = hits.slice(0, Math.min(maxSnippets, hits.length)).map((h) => {
    const c = chunks[+h.id];
    return c ? { file: c.file, sym: c.sym, start: c.start, end: c.end, score: +h.score.toFixed(4), text: String(c.text).slice(0, snippetChars) } : null;
  }).filter(Boolean);
  return { files, snippets };
}

/**
 * The pure localization core. Injected:
 *   files     {relPath->text} | [{file,text}]            (repo source)
 *   problem   the issue problem_statement
 *   embed     async (texts:string[]) => number[][]       (batched embedder)
 *   makeIndex ({dimensions}) => { insertBatch(items), search({vector,k,efSearch}) }
 *   k         files to surface; gnn toggles rerank.
 * Returns { files, snippets, stats } — the seed. No I/O of its own.
 */
export async function localizeSeed({ files, problem, embed, makeIndex, dimensions, k = 12, gnn = false, maxChunks = 4000, efSearch = 200 }) {
  const t0 = Date.now();
  const chunks = chunkRepo(files, { maxChunks });
  if (!chunks.length) return { files: [], snippets: [], stats: { n_chunks: 0, ms_total: Date.now() - t0, note: 'no indexable source chunks' } };
  const chunkTexts = chunks.map((c) => `# ${c.file} :: ${c.sym}\n${c.text}`);
  const chunkVecs = await embed(chunkTexts);
  const dim = dimensions || (chunkVecs[0] ? chunkVecs[0].length : 0);
  const index = makeIndex({ dimensions: dim });
  await index.insertBatch(chunks.map((c, i) => ({ id: String(i), vector: chunkVecs[i], metadata: { file: c.file, sym: c.sym, start: c.start, end: c.end } })));
  const tIndex = Date.now();
  const [qVec] = await embed([String(problem || '').slice(0, 8000)]);
  let hits = await index.search({ vector: qVec, k: Math.min(k * 3, chunks.length), efSearch });
  const tSearch = Date.now();
  const reranked = gnn ? gnnRerank(hits) : hits;
  const { files: rankedFiles, snippets } = aggregateHits(reranked, chunks, { k });
  return {
    files: rankedFiles,
    snippets,
    stats: { n_chunks: chunks.length, gnn: !!gnn, ms_index: tIndex - t0, ms_search: tSearch - tIndex, ms_total: Date.now() - t0 },
  };
}

/**
 * Render a seed into the text block injected at the head of the agent's first turn. Deterministic,
 * compact, and explicitly framed as a HINT (the agent may still explore). This is the exact string
 * solve-agentic.mjs prepends to the problem statement when `--localize` is set.
 */
export function formatSeedForAgent(seed, { maxFiles = 10, maxSnippets = 3 } = {}) {
  if (!seed || !seed.files || !seed.files.length) return '';
  const fileLines = seed.files.slice(0, maxFiles).map((f, i) => {
    const syms = f.symbols && f.symbols.length ? `  (symbols: ${f.symbols.join(', ')})` : '';
    return `  ${i + 1}. ${f.file}${syms}`;
  });
  const snipLines = (seed.snippets || []).slice(0, maxSnippets).map((s) =>
    `--- ${s.file} :: ${s.sym} [lines ${s.start}-${s.end}] ---\n${s.text}`);
  return [
    '--- RETRIEVAL-SEEDED LOCALIZATION (HINT — files most relevant to the issue, by code-embedding similarity) ---',
    'These are candidate locations for the fix. Start by reading them; you may still explore elsewhere.',
    'Ranked files:',
    ...fileLines,
    snipLines.length ? '\nTop snippets:\n' + snipLines.join('\n\n') : '',
    '--- end localization hint ---',
  ].filter(Boolean).join('\n');
}
