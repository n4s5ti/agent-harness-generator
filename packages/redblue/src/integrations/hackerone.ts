// SPDX-License-Identifier: MIT
//
// Read-only HackerOne API client (GraphQL).
//
// SAFETY / SECRETS (strict):
//   - Auth is a single API token sent as `X-Auth-Token: <HACKERONE_API_KEY>`
//     against the GraphQL endpoint (https://hackerone.com/graphql). The token is
//     read at RUNTIME from the process environment (or a local .env loaded at
//     runtime — never imported into source, never written to any file).
//   - The token is NEVER logged, printed, echoed, or returned.
//   - The API is used READ-ONLY here: it fetches the weakness taxonomy (CWE).
//     This client has no write/submit method at all. (Report "export" produces a
//     draft only; see reports/hackerone.ts. A live submit, if ever built, is
//     hard-gated in the CLI and default-off — it is not in this module.)
//   - With no token present, every method falls back to a built-in static CWE
//     map so offline/CI works deterministically at $0.
//
// NOTE on auth: HackerOne's v1 REST API uses HTTP Basic (username:api_token),
// but a personal API token issued without an identifier authenticates instead
// via the GraphQL endpoint with the X-Auth-Token header (no username). This
// client uses the GraphQL path, which is what the configured token requires.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AttackFamily } from '../types.js';
import { FAMILY_TAXONOMY } from './cwe-cvss.js';
import {
  readCache,
  writeCache,
  DEFAULT_CACHE_TTL_MS,
  type CacheFs,
} from './h1-cache.js';

const HACKERONE_GRAPHQL_ENDPOINT = 'https://hackerone.com/graphql';

/** A weakness entry from the HackerOne taxonomy (CWE-bearing). */
export interface HackerOneWeakness {
  /** HackerOne weakness name. */
  name: string;
  /**
   * External taxonomy id as returned by HackerOne, e.g. "cwe-79" / "capec-597".
   * Normalized to upper-case CWE form ("CWE-79") when it is a CWE; left as-is
   * otherwise. Undefined when HackerOne has no external id for the weakness.
   */
  externalId?: string;
  /** Stable id used for the static fallback (the CWE id). */
  id: string;
}

export interface HackerOneCredentials {
  /** The single API token (sent as X-Auth-Token). */
  apiKey: string;
}

/**
 * Minimal, dependency-free .env reader (KEY=VALUE lines). Used ONLY at runtime
 * to populate the token when it is not already in process.env. It never persists
 * anything and only reads the single HackerOne key it needs.
 *
 * Lines: `KEY=VALUE`, `#` comments and blank lines ignored, optional surrounding
 * quotes stripped, no interpolation. Deliberately tiny + auditable.
 */
function readEnvFile(path: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Resolve the HackerOne API token at RUNTIME.
 *
 * Order: process.env first, then a local .env (the provided path or ./.env) —
 * loaded only here, only when needed, never imported into source. Returns null
 * when no token is available (the no-key path), which keeps the static fallback
 * active. The returned value is for in-process use only; never logged or stored.
 */
export function resolveCredentials(opts?: {
  envFilePath?: string;
  env?: NodeJS.ProcessEnv;
}): HackerOneCredentials | null {
  const env = opts?.env ?? process.env;
  let apiKey = (env.HACKERONE_API_KEY || '').trim();

  if (!apiKey) {
    // Runtime-only .env fallback (gitignored). Read just the single key.
    const envPath = resolve(opts?.envFilePath ?? '.env');
    const fileEnv = readEnvFile(envPath);
    apiKey = (fileEnv.HACKERONE_API_KEY || '').trim();
  }

  if (!apiKey) return null;
  return { apiKey };
}

/** True if a live HackerOne call can be made (token present at runtime). */
export function hasHackerOneKey(opts?: {
  envFilePath?: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  return resolveCredentials(opts) !== null;
}

/** Normalize a HackerOne external id ("cwe-79") to canonical CWE form. */
function normalizeExternalId(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const m = /^cwe-(\d+)$/i.exec(raw.trim());
  if (m) return `CWE-${m[1]}`;
  return raw.trim();
}

/**
 * Curated static CWE table, REFRESHED from the LIVE HackerOne taxonomy
 * (fetched 2026-06-27; ADR-197). Names are the exact strings HackerOne shows.
 * This is the offline/no-key fallback — a representative slice of the ~973
 * unique CWEs the API returns, biased toward the LLM/agent-security weaknesses
 * redblue cares about, so offline mode resembles reality rather than a 9-entry
 * skeleton. (The full 1631-entry set comes from the live API + disk cache.)
 */
const STATIC_CWE_TABLE: ReadonlyArray<{ id: string; name: string }> = [
  // LLM / generative-AI specific
  { id: 'CWE-1427', name: 'Improper Neutralization of Input Used for LLM Prompting' },
  { id: 'CWE-1426', name: 'Improper Validation of Generative AI Output' },
  {
    id: 'CWE-1039',
    name: 'Automated Recognition Mechanism with Inadequate Detection or Handling of Adversarial Input Perturbations',
  },
  // Injection
  { id: 'CWE-77', name: 'Command Injection - Generic' },
  { id: 'CWE-78', name: 'OS Command Injection' },
  { id: 'CWE-94', name: 'Code Injection' },
  { id: 'CWE-95', name: "Improper Neutralization of Directives in Dynamically Evaluated Code ('Eval Injection')" },
  { id: 'CWE-79', name: 'Cross-site Scripting (XSS) - Generic' },
  { id: 'CWE-89', name: 'SQL Injection - Generic' },
  // Information disclosure
  { id: 'CWE-200', name: 'Information Disclosure' },
  { id: 'CWE-201', name: 'Information Exposure Through Sent Data' },
  { id: 'CWE-668', name: 'Exposure of Resource to Wrong Sphere' },
  // Authorization / privilege
  { id: 'CWE-250', name: 'Execution with Unnecessary Privileges' },
  { id: 'CWE-269', name: 'Improper Privilege Management' },
  { id: 'CWE-285', name: 'Improper Authorization' },
  { id: 'CWE-862', name: 'Missing Authorization' },
  { id: 'CWE-863', name: 'Incorrect Authorization' },
  { id: 'CWE-639', name: 'Insecure Direct Object Reference (IDOR)' },
  // Resource consumption / rate
  { id: 'CWE-400', name: 'Uncontrolled Resource Consumption' },
  { id: 'CWE-770', name: 'Allocation of Resources Without Limits or Throttling' },
  { id: 'CWE-799', name: 'Improper Control of Interaction Frequency' },
];

/**
 * Build the static CWE taxonomy fallback. Returns the curated live-refreshed
 * table UNION every CWE referenced by the redblue families (so a mapped CWE is
 * guaranteed present even if the curated table drifts), de-duplicated and sorted.
 * Deterministic, $0, offline-safe.
 */
export function staticWeaknessFallback(): HackerOneWeakness[] {
  const seen = new Map<string, HackerOneWeakness>();
  // Curated live-refreshed table first.
  for (const c of STATIC_CWE_TABLE) {
    if (!seen.has(c.id)) seen.set(c.id, { id: c.id, name: c.name, externalId: c.id });
  }
  // Guarantee every mapped CWE is present (family mapping is the source of truth).
  for (const family of Object.keys(FAMILY_TAXONOMY) as AttackFamily[]) {
    for (const cwe of FAMILY_TAXONOMY[family].cwe) {
      if (!seen.has(cwe.id)) {
        seen.set(cwe.id, { id: cwe.id, name: cwe.name, externalId: cwe.id });
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * A minimal Headers-like reader. The real `fetch` Response#headers satisfies
 * this (it has `.get(name)`), and tests can pass a plain `{ get }` shim. Used
 * only to read `Retry-After` on a 429.
 */
export interface HeadersLike {
  get(name: string): string | null;
}

/** Injectable fetch (defaults to global fetch) — lets tests mock the network. */
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  headers?: HeadersLike;
  json(): Promise<unknown>;
}>;

export interface HackerOneClientOptions {
  /** Override credential resolution (tests pass explicit creds or null). */
  credentials?: HackerOneCredentials | null;
  /** Injectable fetch for tests. */
  fetchImpl?: FetchLike;
  /** Path to a runtime .env fallback (defaults to ./.env). */
  envFilePath?: string;
  /** Environment to read (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /**
   * Cache-first behavior for the taxonomy fetch (COMPLIANCE: minimizes request
   * volume against HackerOne's documented read rate limit). Set `cache: false`
   * to disable disk caching entirely.
   */
  cache?: false;
  /** Override the cache file path (defaults to ~/.claude/redblue/h1-weaknesses.json). */
  cachePath?: string;
  /** Cache TTL in ms (defaults to 7 days). */
  cacheTtlMs?: number;
  /** Injectable cache fs (tests). */
  cacheFs?: CacheFs;
  /** Override "now" for deterministic cache TTL tests. */
  now?: () => number;
  /**
   * Per-request rate-limit knobs (COMPLIANCE: stay well under H1's 600 reads/min).
   * `minIntervalMs` spaces consecutive requests; `maxRetries` caps 429 backoff.
   */
  minIntervalMs?: number;
  maxRetries?: number;
  /** Injectable sleep (tests pass a no-op so backoff doesn't slow CI). */
  sleepImpl?: (ms: number) => Promise<void>;
}

/** Result of a full-taxonomy fetch (source tells the caller where it came from). */
export interface WeaknessFetchResult {
  weaknesses: HackerOneWeakness[];
  /** Where the data came from. */
  source: 'live' | 'cache' | 'static';
  /** total_count reported by the API (live), the cached count (cache), or the
   * static-set size (static). */
  totalCount: number;
  /** Number of HTTP requests issued (0 for cache/static — a compliance signal). */
  requests: number;
}

/** A single capability-probe outcome (for the read-surface matrix). */
export interface CapabilityProbe {
  /** Short label for the probed field. */
  field: string;
  /** 'data' = returned usable data; 'null' = resolved but null; 'error' = GraphQL/HTTP error. */
  status: 'data' | 'null' | 'error';
  /** First GraphQL error message, if any (never contains account data). */
  note?: string;
}

/**
 * Read-only HackerOne GraphQL client.
 *
 * Network methods (ALL read-only): `weaknessesFull()` (paginated taxonomy),
 * `weaknesses()` (first page), `authSmoke()` (auth check), and
 * `probeCapabilities()` (read-surface map). There is intentionally NO
 * submit/create mutation anywhere on this client.
 *
 * COMPLIANCE: requests are spaced by `minIntervalMs` (concurrency 1), a 429
 * triggers exponential backoff honoring the `Retry-After` header (capped by
 * `maxRetries`), and the full taxonomy is served cache-first to minimize volume
 * against HackerOne's documented 600 reads/min budget.
 */
export class HackerOneClient {
  private readonly creds: HackerOneCredentials | null;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly cacheEnabled: boolean;
  private readonly cachePath?: string;
  private readonly cacheTtlMs: number;
  private readonly cacheFs?: CacheFs;
  private readonly now: () => number;
  private lastRequestAt = 0;

  constructor(options: HackerOneClientOptions = {}) {
    this.creds =
      options.credentials !== undefined
        ? options.credentials
        : resolveCredentials({ envFilePath: options.envFilePath, env: options.env });
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.sleep =
      options.sleepImpl ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    // Default ~150ms spacing → ≤~400 req/min worst case, comfortably under 600/min.
    this.minIntervalMs = Math.max(0, options.minIntervalMs ?? 150);
    this.maxRetries = Math.max(0, options.maxRetries ?? 4);
    this.cacheEnabled = options.cache !== false;
    this.cachePath = options.cachePath;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.cacheFs = options.cacheFs;
    this.now = options.now ?? Date.now;
  }

  /** True when live credentials are available. */
  isLive(): boolean {
    return this.creds !== null;
  }

  /** Space consecutive requests to respect the configured min interval. */
  private async throttle(): Promise<void> {
    if (this.minIntervalMs <= 0) return;
    const wait = this.lastRequestAt + this.minIntervalMs - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = this.now();
  }

  /**
   * POST a GraphQL query with the X-Auth-Token header. Token NEVER logged.
   *
   * On HTTP 429, backs off honoring `Retry-After` (seconds or HTTP-date) with
   * exponential fallback, retrying up to `maxRetries` times before surfacing the
   * 429 to the caller (which degrades to cache/static). Never hammers.
   */
  private async graphql(
    query: string,
  ): Promise<{ ok: boolean; status: number; body: { data?: unknown; errors?: unknown } }> {
    if (!this.creds) throw new Error('HackerOneClient: no credentials');
    let attempt = 0;
    for (;;) {
      await this.throttle();
      const res = await this.fetchImpl(HACKERONE_GRAPHQL_ENDPOINT, {
        method: 'POST',
        headers: {
          'X-Auth-Token': this.creds.apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ query }),
      });

      if (res.status === 429 && attempt < this.maxRetries) {
        const delay = retryAfterMs(res.headers?.get('retry-after') ?? null, attempt, this.now());
        await this.sleep(delay);
        attempt++;
        continue;
      }

      let body: { data?: unknown; errors?: unknown } = {};
      try {
        body = ((await res.json()) as { data?: unknown; errors?: unknown }) ?? {};
      } catch {
        body = {};
      }
      return { ok: res.ok, status: res.status, body };
    }
  }

  /**
   * Fetch the FULL weakness taxonomy (all ~1631 entries), cache-first.
   *
   * Order (graceful degradation): fresh disk cache → live paginated API →
   * static fallback. A successful live fetch refreshes the cache. The live path
   * pages with proper cursors (`pageInfo.endCursor` / `after:`) at concurrency 1,
   * stopping at `hasNextPage:false` (with a hard page cap as a safety net).
   *
   * `force:true` skips the cache read (still writes the cache after a live fetch).
   */
  async weaknessesFull(opts: { pageSize?: number; force?: boolean } = {}): Promise<WeaknessFetchResult> {
    // 1) Cache-first (compliance: zero requests when warm).
    if (this.cacheEnabled && !opts.force) {
      const cached = readCache({
        path: this.cachePath,
        ttlMs: this.cacheTtlMs,
        fs: this.cacheFs,
        now: this.now,
      });
      if (cached) {
        return {
          weaknesses: cached.weaknesses,
          source: 'cache',
          totalCount: cached.totalCount,
          requests: 0,
        };
      }
    }

    // 2) No token → static.
    if (!this.creds) {
      const s = staticWeaknessFallback();
      return { weaknesses: s, source: 'static', totalCount: s.length, requests: 0 };
    }

    // 3) Live paginated fetch.
    try {
      const pageSize = Math.max(1, Math.min(100, Math.trunc(opts.pageSize ?? 100)));
      const all: HackerOneWeakness[] = [];
      let after: string | null = null;
      let totalCount = 0;
      let requests = 0;
      const MAX_PAGES = 50; // safety net (1631/100 ≈ 17 pages; 50 is generous).
      for (let page = 0; page < MAX_PAGES; page++) {
        const afterArg = after ? `,after:"${after}"` : '';
        const query =
          `query{weaknesses(first:${pageSize}${afterArg}){total_count ` +
          `pageInfo{hasNextPage endCursor} edges{node{name external_id}}}}`;
        const { ok, body } = await this.graphql(query);
        requests++;
        if (!ok || body.errors) {
          // Mid-pagination failure: degrade. Prefer cache, else static.
          return this.degradeToCacheOrStatic();
        }
        const conn = (body.data as { weaknesses?: WeaknessConnection } | undefined)?.weaknesses;
        if (!conn || !Array.isArray(conn.edges)) return this.degradeToCacheOrStatic();
        if (typeof conn.total_count === 'number') totalCount = conn.total_count;
        for (const edge of conn.edges) {
          const w = normalizeWeakness(edge);
          if (w) all.push(w);
        }
        if (!conn.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) break;
        after = conn.pageInfo.endCursor;
      }
      if (all.length === 0) return this.degradeToCacheOrStatic();
      // 4) Refresh cache (compliance: next run reads disk, not the API).
      if (this.cacheEnabled) {
        writeCache(all, totalCount || all.length, {
          path: this.cachePath,
          fs: this.cacheFs,
          now: this.now,
        });
      }
      return { weaknesses: all, source: 'live', totalCount: totalCount || all.length, requests };
    } catch {
      return this.degradeToCacheOrStatic();
    }
  }

  /** Degradation helper: a (possibly stale) cache beats static; else static. */
  private degradeToCacheOrStatic(): WeaknessFetchResult {
    if (this.cacheEnabled) {
      // Accept an EXPIRED cache here (Infinity TTL) — real data beats the static
      // skeleton when the live path just failed.
      const stale = readCache({
        path: this.cachePath,
        ttlMs: Number.POSITIVE_INFINITY,
        fs: this.cacheFs,
        now: this.now,
      });
      if (stale) {
        return {
          weaknesses: stale.weaknesses,
          source: 'cache',
          totalCount: stale.totalCount,
          requests: 0,
        };
      }
    }
    const s = staticWeaknessFallback();
    return { weaknesses: s, source: 'static', totalCount: s.length, requests: 0 };
  }

  /**
   * Fetch the weakness taxonomy (CWE). Backwards-compatible convenience wrapper
   * around {@link weaknessesFull} that returns just the array.
   *
   * No token / cold path → static or cache as appropriate. `first` is honored as
   * the page size; the method still paginates fully (the whole taxonomy), which
   * is what every caller wants. Any error degrades gracefully.
   */
  async weaknesses(first = 100): Promise<HackerOneWeakness[]> {
    const r = await this.weaknessesFull({ pageSize: first });
    return r.weaknesses;
  }

  /**
   * Read-only auth smoke. Confirms the token authenticates without returning any
   * account contents to the caller.
   *
   * NOTE: this token's `me{username}` resolves to null (limited scope), so we
   * use the `weaknesses` taxonomy query as the auth probe instead: a valid token
   * returns data; an invalid one returns 401 / GraphQL auth errors. Returns only
   * a boolean + HTTP status — NEVER the response body.
   *
   * No token → { ok: false, status: 0, live: false }.
   */
  async authSmoke(): Promise<{ ok: boolean; status: number; live: boolean }> {
    if (!this.creds) return { ok: false, status: 0, live: false };
    try {
      const { ok, status, body } = await this.graphql(
        'query{weaknesses(first:1){edges{node{external_id}}}}',
      );
      const data = body.data as { weaknesses?: { edges?: unknown } } | undefined;
      // Auth succeeded iff HTTP 200, no GraphQL errors, and data was returned.
      const authed =
        status === 200 && ok && !body.errors && Array.isArray(data?.weaknesses?.edges);
      return { ok: authed, status, live: true };
    } catch {
      return { ok: false, status: 0, live: true };
    }
  }

  /**
   * Probe the token's READ surface (read-only). Issues a small handful of
   * targeted queries and reports, per field, whether it returned data / null /
   * an error — WITHOUT surfacing any account contents (only field presence,
   * connection shape, and GraphQL error messages, which describe the schema, not
   * account data). Used to build an honest capability matrix.
   *
   * No token → empty list (nothing to probe).
   */
  async probeCapabilities(): Promise<CapabilityProbe[]> {
    if (!this.creds) return [];
    const probes: Array<{ field: string; query: string; key: string }> = [
      { field: 'weaknesses', key: 'weaknesses', query: 'query{weaknesses(first:1){total_count edges{node{external_id}}}}' },
      { field: 'team(handle)', key: 'team', query: 'query{team(handle:"security"){handle state}}' },
      { field: 'clusters', key: 'clusters', query: 'query{clusters(first:1){edges{node{id name}}}}' },
      { field: 'me', key: 'me', query: 'query{me{username}}' },
      { field: 'external_program', key: 'external_program', query: 'query{external_program(handle:"security"){id}}' },
      { field: 'structured_scopes', key: 'structured_scopes', query: 'query{structured_scopes(first:1){edges{node{id}}}}' },
      { field: 'cwe', key: 'cwe', query: 'query{cwe(first:1){edges{node{id}}}}' },
    ];
    const out: CapabilityProbe[] = [];
    for (const p of probes) {
      try {
        const { ok, body } = await this.graphql(p.query);
        if (!ok || body.errors) {
          const msg = firstErrorMessage(body.errors);
          out.push({ field: p.field, status: 'error', note: msg });
          continue;
        }
        const data = body.data as Record<string, unknown> | undefined;
        const val = data ? data[p.key] : undefined;
        // We never surface VALUES — only whether the field resolved to data/null.
        out.push({ field: p.field, status: val == null ? 'null' : 'data' });
      } catch {
        out.push({ field: p.field, status: 'error', note: 'request failed' });
      }
    }
    return out;
  }
}

/** GraphQL weakness connection shape (only the fields we read). */
interface WeaknessConnection {
  total_count?: number;
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  edges?: unknown[];
}

/**
 * Compute a backoff delay (ms) for a 429.
 *
 * Honors `Retry-After` first: a numeric value is seconds; an HTTP-date is the
 * absolute time to wait until. Falls back to exponential backoff
 * (base 500ms * 2^attempt) when the header is absent/unparseable. Clamped to a
 * sane ceiling so a hostile header can't wedge us.
 */
export function retryAfterMs(
  retryAfter: string | null,
  attempt: number,
  now: number = Date.now(),
): number {
  const MAX = 60_000; // never wait more than 60s on a single backoff.
  if (retryAfter != null) {
    const trimmed = retryAfter.trim();
    if (/^\d+$/.test(trimmed)) {
      return Math.min(MAX, Math.max(0, parseInt(trimmed, 10) * 1000));
    }
    const when = Date.parse(trimmed);
    if (!Number.isNaN(when)) {
      return Math.min(MAX, Math.max(0, when - now));
    }
  }
  // Exponential fallback: 500ms, 1s, 2s, 4s, ...
  return Math.min(MAX, 500 * 2 ** Math.max(0, attempt));
}

/** First GraphQL error message (schema-level only — never account data). */
function firstErrorMessage(errors: unknown): string | undefined {
  if (!Array.isArray(errors) || errors.length === 0) return undefined;
  const first = errors[0] as { message?: unknown };
  return typeof first?.message === 'string' ? first.message : undefined;
}

/** Normalize a GraphQL weakness edge into our shape. */
function normalizeWeakness(edge: unknown): HackerOneWeakness | null {
  if (typeof edge !== 'object' || edge === null) return null;
  const node = (edge as { node?: unknown }).node;
  if (typeof node !== 'object' || node === null) return null;
  const obj = node as { name?: unknown; external_id?: unknown };
  const name = typeof obj.name === 'string' ? obj.name : undefined;
  if (!name) return null;
  const externalId = normalizeExternalId(obj.external_id);
  return { name, externalId, id: externalId ?? name };
}
