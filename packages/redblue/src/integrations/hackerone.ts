// SPDX-License-Identifier: MIT
//
// Read-only HackerOne API client.
//
// SAFETY / SECRETS (strict):
//   - Auth is HTTP Basic `username:api_key`. Both are read at RUNTIME from the
//     process environment (or a local .env loaded at runtime — never imported
//     into source, never written to any file).
//   - The credentials are NEVER logged, printed, echoed, or returned.
//   - The API is used READ-ONLY here: it fetches the weakness taxonomy (CWE).
//     This client has no write/submit method at all. (Report "export" produces a
//     draft only; see reports/hackerone.ts. A live submit, if ever built, is
//     hard-gated in the CLI and default-off — it is not in this module.)
//   - With no key present, every method falls back to a built-in static CWE map
//     so offline/CI works deterministically at $0.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AttackFamily } from '../types.js';
import { FAMILY_TAXONOMY } from './cwe-cvss.js';

const HACKERONE_API_BASE = 'https://api.hackerone.com/v1';
const DEFAULT_USERNAME = 'ruvnet';

/** A weakness entry from the HackerOne taxonomy (CWE-bearing). */
export interface HackerOneWeakness {
  /** HackerOne weakness id (opaque string) — or a CWE id for the fallback. */
  id: string;
  name: string;
  /** External CWE id, e.g. "CWE-77", when present. */
  externalId?: string;
  description?: string;
}

export interface HackerOneCredentials {
  username: string;
  apiKey: string;
}

/**
 * Minimal, dependency-free .env reader (KEY=VALUE lines). Used ONLY at runtime
 * to populate credentials when they are not already in process.env. It never
 * persists anything and only reads the two HackerOne keys it needs.
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
 * Resolve HackerOne credentials at RUNTIME.
 *
 * Order: process.env first, then a local .env (cwd) as a fallback — loaded only
 * here, only when needed, never imported into source. Returns null when no API
 * key is available (the no-key path), which keeps the static fallback active.
 *
 * The returned object is for in-process use only; it is never logged or stored.
 */
export function resolveCredentials(opts?: {
  envFilePath?: string;
  env?: NodeJS.ProcessEnv;
}): HackerOneCredentials | null {
  const env = opts?.env ?? process.env;
  let apiKey = (env.HACKERONE_API_KEY || '').trim();
  let username = (env.HACKERONE_USERNAME || '').trim();

  if (!apiKey) {
    // Runtime-only .env fallback (gitignored). Read just the two keys.
    const envPath = resolve(opts?.envFilePath ?? '.env');
    const fileEnv = readEnvFile(envPath);
    apiKey = (apiKey || fileEnv.HACKERONE_API_KEY || '').trim();
    username = (username || fileEnv.HACKERONE_USERNAME || '').trim();
  }

  if (!apiKey) return null;
  return { username: username || DEFAULT_USERNAME, apiKey };
}

/** True if a live HackerOne call can be made (credentials present at runtime). */
export function hasHackerOneKey(opts?: {
  envFilePath?: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  return resolveCredentials(opts) !== null;
}

/**
 * Build the static CWE taxonomy fallback from the family mapping. This is what
 * `weaknesses()` returns when no key is present — every CWE referenced by the
 * redblue families, de-duplicated. Deterministic, $0, offline-safe.
 */
export function staticWeaknessFallback(): HackerOneWeakness[] {
  const seen = new Map<string, HackerOneWeakness>();
  for (const family of Object.keys(FAMILY_TAXONOMY) as AttackFamily[]) {
    for (const cwe of FAMILY_TAXONOMY[family].cwe) {
      if (!seen.has(cwe.id)) {
        seen.set(cwe.id, { id: cwe.id, name: cwe.name, externalId: cwe.id });
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Injectable fetch (defaults to global fetch) — lets tests mock the network. */
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface HackerOneClientOptions {
  /** Override credential resolution (tests pass explicit creds or null). */
  credentials?: HackerOneCredentials | null;
  /** Injectable fetch for tests. */
  fetchImpl?: FetchLike;
  /** Path to a runtime .env fallback (defaults to ./.env). */
  envFilePath?: string;
  /** Environment to read (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Read-only HackerOne client. The ONLY network method is `weaknesses()`
 * (GET /v1/weaknesses) plus an auth smoke (`me()` → GET /v1/me/programs).
 * There is intentionally NO submit/create method on this client.
 */
export class HackerOneClient {
  private readonly creds: HackerOneCredentials | null;
  private readonly fetchImpl: FetchLike;

  constructor(options: HackerOneClientOptions = {}) {
    this.creds =
      options.credentials !== undefined
        ? options.credentials
        : resolveCredentials({ envFilePath: options.envFilePath, env: options.env });
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  /** True when live credentials are available. */
  isLive(): boolean {
    return this.creds !== null;
  }

  /** Build the Basic auth header. NEVER logged. */
  private authHeader(): string {
    if (!this.creds) throw new Error('HackerOneClient: no credentials');
    const token = Buffer.from(`${this.creds.username}:${this.creds.apiKey}`).toString('base64');
    return `Basic ${token}`;
  }

  /**
   * Fetch the weakness taxonomy (CWE). Read-only.
   *
   * No key → returns the static fallback (offline/CI safe). With a key, calls
   * GET /v1/weaknesses and normalizes the JSON:API payload into HackerOneWeakness[].
   * Any network/parse error degrades gracefully to the static fallback so a
   * flaky API never breaks a report export.
   */
  async weaknesses(): Promise<HackerOneWeakness[]> {
    if (!this.creds) return staticWeaknessFallback();
    try {
      const res = await this.fetchImpl(`${HACKERONE_API_BASE}/weaknesses`, {
        method: 'GET',
        headers: { Authorization: this.authHeader(), Accept: 'application/json' },
      });
      if (!res.ok) return staticWeaknessFallback();
      const body = (await res.json()) as { data?: unknown };
      const data = Array.isArray(body?.data) ? body.data : [];
      const parsed = data
        .map((item) => normalizeWeakness(item))
        .filter((w): w is HackerOneWeakness => w !== null);
      return parsed.length > 0 ? parsed : staticWeaknessFallback();
    } catch {
      return staticWeaknessFallback();
    }
  }

  /**
   * Read-only auth smoke. Confirms the Basic credentials authenticate without
   * returning any account contents to the caller. Returns only a boolean +
   * HTTP status — NEVER the response body (which could contain account data).
   *
   * No key → { ok: false, live: false }. (Not an error; just no live path.)
   */
  async authSmoke(): Promise<{ ok: boolean; status: number; live: boolean }> {
    if (!this.creds) return { ok: false, status: 0, live: false };
    try {
      const res = await this.fetchImpl(`${HACKERONE_API_BASE}/me/programs`, {
        method: 'GET',
        headers: { Authorization: this.authHeader(), Accept: 'application/json' },
      });
      // Deliberately do NOT read or surface res.json() — only the status.
      return { ok: res.ok, status: res.status, live: true };
    } catch {
      return { ok: false, status: 0, live: true };
    }
  }
}

/** Normalize a HackerOne JSON:API weakness object into our shape. */
function normalizeWeakness(item: unknown): HackerOneWeakness | null {
  if (typeof item !== 'object' || item === null) return null;
  const obj = item as { id?: unknown; attributes?: Record<string, unknown> };
  const id = obj.id !== undefined ? String(obj.id) : undefined;
  const attrs = obj.attributes ?? {};
  const name = typeof attrs.name === 'string' ? attrs.name : undefined;
  if (!id || !name) return null;
  const externalId =
    typeof attrs.external_id === 'string' ? attrs.external_id : undefined;
  const description =
    typeof attrs.description === 'string' ? attrs.description : undefined;
  return { id, name, externalId, description };
}
