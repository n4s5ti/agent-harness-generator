#!/usr/bin/env node
// Pure-function tests for localize.mjs (ADR-195 Phase-2 #1). NO network / NO ruvector native dep:
// the embedder is a deterministic stub, the vector index is an in-memory cosine index, the repo is a
// fake file map. Run: node localize.test.mjs
import assert from 'node:assert';
import {
  chunkFile, chunkRepo, isIndexable, gnnRerank, aggregateHits, localizeSeed, formatSeedForAgent,
} from './localize.mjs';

let pass = 0; const t = (name, fn) => { try { fn(); pass++; console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.message}`); process.exitCode = 1; } };
const ta = async (name, fn) => { try { await fn(); pass++; console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.message}`); process.exitCode = 1; } };

console.log('localize.mjs unit tests:');

t('chunkFile splits at def/class granularity', () => {
  const src = ['import os', '', 'def alpha(x):', '    return x + 1', '', 'class Beta:', '    def gamma(self):', '        return 2'].join('\n');
  const chunks = chunkFile('mod.py', src);
  const syms = chunks.map((c) => c.sym);
  assert(syms.includes('alpha'), 'alpha def chunked');
  assert(syms.includes('Beta'), 'Beta class chunked');
  for (const c of chunks) { assert(c.file === 'mod.py'); assert(c.start >= 1 && c.end >= c.start, '1-based inclusive range'); }
});

t('chunkFile falls back to windows for def-less files', () => {
  const src = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
  const chunks = chunkFile('data.py', src, { windowLines: 80 });
  assert(chunks.length === 3, `200 lines / 80 → 3 windows, got ${chunks.length}`);
  assert(chunks.every((c) => c.sym === '(file)'));
});

t('isIndexable accepts source, rejects tests/vendored/non-source', () => {
  assert(isIndexable('src/foo/bar.py'));
  assert(isIndexable('pkg/util.go'));
  assert(!isIndexable('tests/test_foo.py'), 'test dir skipped');
  assert(!isIndexable('node_modules/lib/x.js'), 'vendored skipped');
  assert(!isIndexable('README.md'), 'non-source skipped');
});

t('chunkRepo skips test dirs and caps maxChunks', () => {
  const files = {
    'pkg/a.py': 'def a():\n    pass',
    'pkg/b.py': 'def b():\n    pass',
    'tests/test_a.py': 'def test_a():\n    assert True', // must be excluded
    'docs/readme.txt': 'hello',                          // non-source excluded
  };
  const chunks = chunkRepo(files);
  assert(chunks.every((c) => !c.file.startsWith('tests/')), 'no test chunks');
  assert(chunks.some((c) => c.file === 'pkg/a.py'));
  const capped = chunkRepo(files, { maxChunks: 1 });
  assert(capped.length === 1, 'maxChunks cap honored');
});

t('gnnRerank diffuses score toward file-cluster mean and re-sorts', () => {
  const hits = [
    { id: '0', score: 0.9, metadata: { file: 'a.py' } },
    { id: '1', score: 0.1, metadata: { file: 'a.py' } }, // sibling pulls 'a.py' up via diffusion
    { id: '2', score: 0.6, metadata: { file: 'b.py' } }, // lone file — stays near its own score
  ];
  const out = gnnRerank(hits, { alpha: 0.5 });
  const byId = Object.fromEntries(out.map((h) => [h.id, h]));
  // a.py mean = 0.5; id0 diffused = 0.5*0.9 + 0.5*0.5 = 0.7 ; id2 = 0.5*0.6+0.5*0.6 = 0.6
  assert(Math.abs(byId['0'].score - 0.7) < 1e-9, `id0 diffused 0.7, got ${byId['0'].score}`);
  assert(Math.abs(byId['2'].score - 0.6) < 1e-9, `id2 stays 0.6, got ${byId['2'].score}`);
  assert(out[0].id === '0', 'sorted by diffused score desc');
  assert(byId['0'].rawScore === 0.9, 'rawScore preserved');
});

t('aggregateHits ranks files by best chunk score and collects symbols', () => {
  const chunks = [
    { file: 'a.py', sym: 'foo', start: 1, end: 5, text: 'def foo(): ...' },
    { file: 'a.py', sym: 'bar', start: 6, end: 9, text: 'def bar(): ...' },
    { file: 'b.py', sym: '(file)', start: 1, end: 3, text: 'x = 1' },
  ];
  const hits = [
    { id: '0', score: 0.8, metadata: chunks[0] },
    { id: '1', score: 0.5, metadata: chunks[1] },
    { id: '2', score: 0.9, metadata: chunks[2] },
  ];
  const { files, snippets } = aggregateHits(hits, chunks, { k: 5 });
  assert(files[0].file === 'b.py', 'highest-score file first');
  const aFile = files.find((f) => f.file === 'a.py');
  assert(aFile.score === 0.8, 'best chunk score per file');
  assert(aFile.symbols.includes('foo') && aFile.symbols.includes('bar'), 'symbols collected');
  assert(!files.find((f) => f.symbols.includes('(file)')), '(file) placeholder excluded from symbols');
  assert(snippets.length === 3 && snippets[0].text.includes('def foo'), 'snippets carry chunk text');
});

// --- deterministic stub embedder + in-memory cosine index for the end-to-end pure pipeline ---
// Embed = a tiny bag-of-keywords vector so the issue's keyword retrieves the matching chunk.
const VOCAB = ['parse', 'cache', 'render', 'auth', 'bug', 'fix'];
function stubEmbed(texts) {
  return texts.map((txt) => { const low = txt.toLowerCase(); return VOCAB.map((w) => (low.split(w).length - 1)); });
}
function cosine(a, b) { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return na && nb ? d / (Math.sqrt(na) * Math.sqrt(nb)) : 0; }
function makeMemIndex() {
  const items = [];
  return {
    async insertBatch(batch) { items.push(...batch); },
    async search({ vector, k }) { return items.map((it) => ({ id: it.id, score: cosine(vector, it.vector), metadata: it.metadata })).sort((a, b) => b.score - a.score).slice(0, k); },
  };
}

await ta('localizeSeed end-to-end retrieves the keyword-matching file (pure, no native dep)', async () => {
  const files = {
    'app/parser.py': 'def parse_token(s):\n    # parse the token\n    return s',
    'app/renderer.py': 'def render_page(p):\n    # render the page\n    return p',
    'app/auth.py': 'def authenticate(u):\n    # auth the user\n    return u',
  };
  const seed = await localizeSeed({
    files, problem: 'There is a bug in the parse logic, parse fails on empty token',
    embed: stubEmbed, makeIndex: makeMemIndex, k: 3, gnn: false,
  });
  assert(seed.files.length > 0, 'returns ranked files');
  assert(seed.files[0].file === 'app/parser.py', `parser ranked first, got ${seed.files[0].file}`);
  assert(seed.stats.n_chunks > 0 && seed.stats.gnn === false);
});

await ta('localizeSeed honors the gnn flag (sets stats.gnn=true, still returns a surface)', async () => {
  const files = { 'a.py': 'def cache_get(k):\n    return k', 'b.py': 'def render(x):\n    return x' };
  const seed = await localizeSeed({ files, problem: 'cache returns stale value bug', embed: stubEmbed, makeIndex: makeMemIndex, k: 2, gnn: true });
  assert(seed.stats.gnn === true, 'gnn flag recorded');
  assert(seed.files[0].file === 'a.py', 'cache file retrieved under gnn rerank');
});

await ta('localizeSeed degrades gracefully on an all-test/empty repo', async () => {
  const seed = await localizeSeed({ files: { 'tests/test_x.py': 'def test(): pass' }, problem: 'x', embed: stubEmbed, makeIndex: makeMemIndex });
  assert(seed.files.length === 0 && seed.stats.n_chunks === 0, 'no indexable chunks → empty surface, no throw');
});

t('formatSeedForAgent renders a HINT block with files + snippets, empty for empty seed', () => {
  const seed = { files: [{ file: 'app/parser.py', score: 0.9, symbols: ['parse_token'] }], snippets: [{ file: 'app/parser.py', sym: 'parse_token', start: 1, end: 3, text: 'def parse_token(s): return s' }] };
  const block = formatSeedForAgent(seed);
  assert(/RETRIEVAL-SEEDED LOCALIZATION/.test(block), 'has the hint header');
  assert(/app\/parser\.py/.test(block) && /parse_token/.test(block), 'lists file + symbol');
  assert(/HINT/.test(block), 'framed as a hint (agent may still explore)');
  assert(formatSeedForAgent({ files: [] }) === '', 'empty seed → empty string (no injection)');
});

console.log(`\n${pass} tests passed.`);
