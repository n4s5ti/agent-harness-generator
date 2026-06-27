// SPDX-License-Identifier: MIT
//
// HackerOne TUNE/OPTIMIZE tests — all $0 / offline (mocked GraphQL + in-memory
// cache fs). Covers:
//   - mapping validity: every mapped CWE exists in a (mock) live taxonomy
//   - cursor pagination (multi-page fetch assembles the full set)
//   - cache hit / miss / TTL expiry / degradation order (live → cache → static)
//   - 429 backoff: retryAfterMs honors Retry-After + exponential fallback,
//     and the client retries a 429 then succeeds (with an injected no-op sleep)
//   - read-surface capability probe (data / null / error per field)
//
// NONE of these hit the network or the real disk. The cache fs is in-memory.

import { describe, it, expect } from 'vitest';
import {
  HackerOneClient,
  staticWeaknessFallback,
  retryAfterMs,
  type FetchLike,
  type HeadersLike,
} from '../src/integrations/hackerone.js';
import { readCache, writeCache, type CacheFs } from '../src/integrations/h1-cache.js';
import { FAMILY_TAXONOMY } from '../src/integrations/cwe-cvss.js';
import { ALL_FAMILIES } from '../src/config/loader.js';
import type { AttackFamily } from '../src/types.js';

/** An in-memory CacheFs so tests never touch the real ~/.claude/redblue dir. */
function memFs(): CacheFs & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    read: (p) => {
      const v = store.get(p);
      if (v === undefined) throw new Error('ENOENT');
      return v;
    },
    write: (p, d) => {
      store.set(p, d);
    },
  };
}

/** Build N synthetic weakness pages with cursor paging, then `me`/probe shims. */
function pagedTaxonomyFetch(opts: {
  total: number;
  pageSize: number;
  retryAfterOn429?: number; // emit a 429 for the first K requests
  headerRetryAfter?: string;
}): { fetch: FetchLike; calls: () => number } {
  const all = Array.from({ length: opts.total }, (_, i) => ({
    node: { name: `Weakness ${i}`, external_id: `cwe-${i + 1}` },
  }));
  let n = 0;
  let served429 = 0;
  const fetch: FetchLike = async (_url, init) => {
    n++;
    const q = init?.body ?? '';
    if (opts.retryAfterOn429 && served429 < opts.retryAfterOn429) {
      served429++;
      const headers: HeadersLike = {
        get: (h) => (h.toLowerCase() === 'retry-after' ? opts.headerRetryAfter ?? '1' : null),
      };
      return { ok: false, status: 429, headers, json: async () => ({}) };
    }
    if (q.includes('weaknesses')) {
      // Parse the `after:"<cursor>"` to know which page to serve. Cursor = index.
      // The cursor is JSON-escaped inside the query body: after:\"123\"
    const m = /after:\\?"(\d+)\\?"/.exec(q);
      const start = m ? parseInt(m[1], 10) : 0;
      const slice = all.slice(start, start + opts.pageSize);
      const nextStart = start + opts.pageSize;
      const hasNext = nextStart < all.length;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            weaknesses: {
              total_count: opts.total,
              pageInfo: { hasNextPage: hasNext, endCursor: hasNext ? String(nextStart) : null },
              edges: slice,
            },
          },
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ data: {} }) };
  };
  return { fetch, calls: () => n };
}

describe('TUNE: mapping validity against a (mock) live taxonomy', () => {
  it('every CWE mapped by redblue exists in the fetched taxonomy', async () => {
    // Live taxonomy fixture: include exactly the CWEs the families map to, plus
    // some extras — proving the validator checks membership, not equality.
    const mappedIds = new Set<string>();
    for (const fam of ALL_FAMILIES as AttackFamily[]) {
      for (const c of FAMILY_TAXONOMY[fam].cwe) mappedIds.add(c.id);
    }
    const liveEdges = [...mappedIds, 'CWE-79', 'CWE-89', 'CWE-352'].map((id) => ({
      node: { name: id, external_id: id.toLowerCase() },
    }));
    const fetch: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          weaknesses: {
            total_count: liveEdges.length,
            pageInfo: { hasNextPage: false, endCursor: null },
            edges: liveEdges,
          },
        },
      }),
    });
    const client = new HackerOneClient({ credentials: { apiKey: 'k' }, fetchImpl: fetch, cache: false });
    const tax = await client.weaknessesFull();
    const liveIds = new Set(tax.weaknesses.map((w) => w.externalId));
    for (const id of mappedIds) {
      expect(liveIds.has(id), `${id} must exist in the live taxonomy`).toBe(true);
    }
  });

  it('static fallback also contains every mapped CWE (offline parity)', () => {
    const staticIds = new Set(staticWeaknessFallback().map((w) => w.externalId));
    for (const fam of ALL_FAMILIES as AttackFamily[]) {
      for (const c of FAMILY_TAXONOMY[fam].cwe) {
        expect(staticIds.has(c.id), `${c.id} must be in the static table`).toBe(true);
      }
    }
  });

  it('static fallback is refreshed from real H1 names (no MITRE-only labels)', () => {
    const byId = new Map(staticWeaknessFallback().map((w) => [w.id, w.name]));
    // These are the exact strings HackerOne returns (verified live 2026-06-27).
    expect(byId.get('CWE-200')).toBe('Information Disclosure');
    expect(byId.get('CWE-77')).toBe('Command Injection - Generic');
    expect(byId.get('CWE-1427')).toBe('Improper Neutralization of Input Used for LLM Prompting');
  });
});

describe('OPTIMIZE: cursor pagination', () => {
  it('assembles the full taxonomy across multiple cursor pages', async () => {
    const { fetch, calls } = pagedTaxonomyFetch({ total: 250, pageSize: 100 });
    const client = new HackerOneClient({
      credentials: { apiKey: 'k' },
      fetchImpl: fetch,
      cache: false,
      minIntervalMs: 0,
      sleepImpl: async () => {},
    });
    const r = await client.weaknessesFull({ pageSize: 100 });
    expect(r.source).toBe('live');
    expect(r.weaknesses.length).toBe(250);
    expect(r.totalCount).toBe(250);
    // 250/100 → 3 pages (100, 100, 50). One request per page.
    expect(calls()).toBe(3);
    expect(r.requests).toBe(3);
  });

  it('stops at hasNextPage:false (single page)', async () => {
    const { fetch, calls } = pagedTaxonomyFetch({ total: 40, pageSize: 100 });
    const client = new HackerOneClient({ credentials: { apiKey: 'k' }, fetchImpl: fetch, cache: false });
    const r = await client.weaknessesFull();
    expect(r.weaknesses.length).toBe(40);
    expect(calls()).toBe(1);
  });
});

describe('OPTIMIZE: cache hit / miss / TTL / degradation order', () => {
  const PATH = '/virtual/h1-weaknesses.json';

  it('writes the cache after a live fetch, then serves from cache (0 requests)', async () => {
    const fs = memFs();
    const { fetch, calls } = pagedTaxonomyFetch({ total: 120, pageSize: 100 });
    const c1 = new HackerOneClient({
      credentials: { apiKey: 'k' },
      fetchImpl: fetch,
      cachePath: PATH,
      cacheFs: fs,
      now: () => 1000,
      minIntervalMs: 0,
      sleepImpl: async () => {},
    });
    const r1 = await c1.weaknessesFull();
    expect(r1.source).toBe('live');
    expect(calls()).toBe(2); // 120/100 → 2 pages

    // Second client, same cache, slightly later but within TTL → cache hit.
    const c2 = new HackerOneClient({
      credentials: { apiKey: 'k' },
      fetchImpl: fetch,
      cachePath: PATH,
      cacheFs: fs,
      now: () => 2000,
    });
    const r2 = await c2.weaknessesFull();
    expect(r2.source).toBe('cache');
    expect(r2.weaknesses.length).toBe(120);
    expect(r2.requests).toBe(0);
    expect(calls()).toBe(2); // unchanged — no new requests
  });

  it('expired cache → re-fetches live', async () => {
    const fs = memFs();
    writeCache([{ id: 'CWE-1', name: 'old', externalId: 'CWE-1' }], 1, {
      path: PATH,
      fs,
      now: () => 0,
    });
    const { fetch } = pagedTaxonomyFetch({ total: 30, pageSize: 100 });
    const client = new HackerOneClient({
      credentials: { apiKey: 'k' },
      fetchImpl: fetch,
      cachePath: PATH,
      cacheFs: fs,
      cacheTtlMs: 1000,
      now: () => 10_000, // way past TTL
    });
    const r = await client.weaknessesFull();
    expect(r.source).toBe('live');
    expect(r.weaknesses.length).toBe(30);
  });

  it('degradation order: live fails → stale cache (not static) when cache present', async () => {
    const fs = memFs();
    // A stale cache (older than TTL) exists.
    writeCache([{ id: 'CWE-200', name: 'Information Disclosure', externalId: 'CWE-200' }], 1, {
      path: PATH,
      fs,
      now: () => 0,
    });
    const failing: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const client = new HackerOneClient({
      credentials: { apiKey: 'k' },
      fetchImpl: failing,
      cachePath: PATH,
      cacheFs: fs,
      cacheTtlMs: 1, // forces the initial read to miss (expired) → tries live
      now: () => 1_000_000,
    });
    const r = await client.weaknessesFull();
    // Live failed; the expired cache is still better than static → use it.
    expect(r.source).toBe('cache');
    expect(r.weaknesses[0].id).toBe('CWE-200');
  });

  it('degradation order: live fails AND no cache → static', async () => {
    const fs = memFs();
    const failing: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const client = new HackerOneClient({
      credentials: { apiKey: 'k' },
      fetchImpl: failing,
      cachePath: PATH,
      cacheFs: fs,
      now: () => 1000,
    });
    const r = await client.weaknessesFull();
    expect(r.source).toBe('static');
    expect(r.weaknesses.length).toBe(staticWeaknessFallback().length);
  });

  it('no key → static (cache untouched, 0 requests)', async () => {
    const fs = memFs();
    const client = new HackerOneClient({ credentials: null, cachePath: PATH, cacheFs: fs });
    const r = await client.weaknessesFull();
    expect(r.source).toBe('static');
    expect(r.requests).toBe(0);
    expect(fs.store.size).toBe(0);
  });

  it('readCache rejects a corrupt / wrong-version / empty file', () => {
    const fs = memFs();
    fs.store.set('/p', 'not json');
    expect(readCache({ path: '/p', fs })).toBeNull();
    fs.store.set('/p', JSON.stringify({ version: 99, fetchedAt: 0, totalCount: 0, weaknesses: [] }));
    expect(readCache({ path: '/p', fs })).toBeNull();
  });
});

describe('COMPLIANCE: 429 backoff', () => {
  it('retryAfterMs honors a numeric Retry-After (seconds → ms)', () => {
    expect(retryAfterMs('2', 0)).toBe(2000);
    expect(retryAfterMs('0', 3)).toBe(0);
  });

  it('retryAfterMs honors an HTTP-date Retry-After', () => {
    const now = 1_000_000;
    const when = new Date(now + 5000).toUTCString();
    const ms = retryAfterMs(when, 0, now);
    // toUTCString truncates to seconds, so allow a 1s slack window.
    expect(ms).toBeGreaterThanOrEqual(4000);
    expect(ms).toBeLessThanOrEqual(5000);
  });

  it('retryAfterMs falls back to exponential backoff with no header', () => {
    expect(retryAfterMs(null, 0)).toBe(500);
    expect(retryAfterMs(null, 1)).toBe(1000);
    expect(retryAfterMs(null, 2)).toBe(2000);
  });

  it('retryAfterMs is clamped to a 60s ceiling', () => {
    expect(retryAfterMs('99999', 0)).toBe(60_000);
    expect(retryAfterMs(null, 30)).toBe(60_000);
  });

  it('client retries a 429 (honoring Retry-After) then succeeds', async () => {
    let slept = 0;
    const { fetch, calls } = pagedTaxonomyFetch({
      total: 20,
      pageSize: 100,
      retryAfterOn429: 1,
      headerRetryAfter: '1',
    });
    const client = new HackerOneClient({
      credentials: { apiKey: 'k' },
      fetchImpl: fetch,
      cache: false,
      minIntervalMs: 0,
      sleepImpl: async (ms) => {
        slept += ms;
      },
    });
    const r = await client.weaknessesFull();
    expect(r.source).toBe('live');
    expect(r.weaknesses.length).toBe(20);
    // One 429 + one success = 2 fetch calls; backoff slept ~1000ms (mocked).
    expect(calls()).toBe(2);
    expect(slept).toBe(1000);
  });

  it('gives up after maxRetries and degrades (never hammers)', async () => {
    let attempts = 0;
    const always429: FetchLike = async () => {
      attempts++;
      return {
        ok: false,
        status: 429,
        headers: { get: () => '0' },
        json: async () => ({}),
      };
    };
    const client = new HackerOneClient({
      credentials: { apiKey: 'k' },
      fetchImpl: always429,
      cache: false,
      minIntervalMs: 0,
      maxRetries: 2,
      sleepImpl: async () => {},
    });
    const r = await client.weaknessesFull();
    expect(r.source).toBe('static'); // degraded, did not crash
    // maxRetries=2 → 1 initial + 2 retries = 3 attempts, then surfaced.
    expect(attempts).toBe(3);
  });
});

describe('TEST: read-surface capability probe (mocked)', () => {
  it('reports data / null / error per field', async () => {
    const fetch: FetchLike = async (_u, init) => {
      const q = init?.body ?? '';
      if (q.includes('weaknesses')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { weaknesses: { total_count: 1, edges: [] } } }),
        };
      }
      if (q.includes('team(')) {
        return { ok: true, status: 200, json: async () => ({ data: { team: { handle: 'x', state: 'public_mode' } } }) };
      }
      if (q.includes('clusters')) {
        return { ok: true, status: 200, json: async () => ({ data: { clusters: { edges: [] } } }) };
      }
      if (q.includes('me{')) {
        return { ok: true, status: 200, json: async () => ({ data: { me: null } }) };
      }
      // external_program / structured_scopes / cwe → schema errors
      return {
        ok: true,
        status: 200,
        json: async () => ({ errors: [{ message: "Field doesn't exist on type 'Query'" }] }),
      };
    };
    const client = new HackerOneClient({ credentials: { apiKey: 'k' }, fetchImpl: fetch, cache: false, minIntervalMs: 0 });
    const probes = await client.probeCapabilities();
    const byField = new Map(probes.map((p) => [p.field, p]));
    expect(byField.get('weaknesses')?.status).toBe('data');
    expect(byField.get('team(handle)')?.status).toBe('data');
    expect(byField.get('clusters')?.status).toBe('data');
    expect(byField.get('me')?.status).toBe('null');
    expect(byField.get('cwe')?.status).toBe('error');
    expect(byField.get('cwe')?.note).toMatch(/exist/);
    // The probe never surfaces VALUES — only status/note.
    for (const p of probes) {
      expect(Object.keys(p).sort().every((k) => ['field', 'status', 'note'].includes(k))).toBe(true);
    }
  });

  it('no key → empty probe list', async () => {
    const client = new HackerOneClient({ credentials: null });
    expect(await client.probeCapabilities()).toEqual([]);
  });
});
