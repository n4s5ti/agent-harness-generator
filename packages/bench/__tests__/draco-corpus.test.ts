// SPDX-License-Identifier: MIT
// DRACO M1 — corpus integrity gate (ADR-037)
// Validates structure, coverage, uniqueness, and pins the SHA-256 so silent
// mutation breaks CI before a score comparison can lie.

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRACO_DIR = join(__dirname, '..', 'draco');

// ── Load artifacts ──────────────────────────────────────────────────────────

// Normalise line endings before anything hashes this — git may check the file
// out with CRLF on Windows, which would change the bytes (and the SHA) even
// though the content is identical. The pin below is the LF hash, so we hash LF.
const corpusRaw = readFileSync(join(DRACO_DIR, 'corpus.json'), 'utf8').replace(/\r\n/g, '\n');

interface Rubric {
  must_cite: string[];
  must_contain: string[];
  must_not: string[];
  grader: string;
}

interface Question {
  id: string;
  domain: string;
  prompt: string;
  rubric: Rubric;
}

interface Corpus {
  version: number;
  questions: Question[];
}

const corpus = JSON.parse(corpusRaw) as Corpus;

// ── §1 SHA-256 pin ──────────────────────────────────────────────────────────
// This is the mutation guard. Update this constant ONLY via a deliberate
// corpus version bump; do NOT update it to silence a failing test.
const CORPUS_V1_SHA256 =
  '8313aea814ef60efd56bebe3592884dc9e3f2d42e875b70dcde99f9460e4fe4f';

describe('DRACO corpus — SHA-256 pin (ADR-037 §1)', () => {
  it('corpus.json has not been silently mutated', () => {
    const actual = createHash('sha256').update(corpusRaw).digest('hex');
    expect(actual).toBe(CORPUS_V1_SHA256);
  });
});

// ── §2 Shape validation ─────────────────────────────────────────────────────
// Manual structural checks replace ajv so we have zero new dependencies.

describe('DRACO corpus — shape validation (ADR-037 §1)', () => {
  it('top-level has version (integer) and questions (array)', () => {
    expect(typeof corpus.version).toBe('number');
    expect(Number.isInteger(corpus.version)).toBe(true);
    expect(Array.isArray(corpus.questions)).toBe(true);
  });

  it('every question has id, domain, prompt, and rubric fields', () => {
    for (const q of corpus.questions) {
      expect(typeof q.id, `${q.id}: id must be string`).toBe('string');
      expect(typeof q.domain, `${q.id}: domain must be string`).toBe('string');
      expect(typeof q.prompt, `${q.id}: prompt must be string`).toBe('string');
      expect(typeof q.rubric, `${q.id}: rubric must be object`).toBe('object');
    }
  });

  it('every rubric has must_cite, must_contain, must_not (arrays) and grader (string)', () => {
    for (const q of corpus.questions) {
      const r = q.rubric;
      expect(Array.isArray(r.must_cite), `${q.id}: must_cite must be array`).toBe(true);
      expect(Array.isArray(r.must_contain), `${q.id}: must_contain must be array`).toBe(true);
      expect(Array.isArray(r.must_not), `${q.id}: must_not must be array`).toBe(true);
      expect(typeof r.grader, `${q.id}: grader must be string`).toBe('string');
    }
  });

  it('every prompt is at least 20 characters', () => {
    for (const q of corpus.questions) {
      expect(
        q.prompt.length,
        `${q.id}: prompt too short (${q.prompt.length} chars)`,
      ).toBeGreaterThanOrEqual(20);
    }
  });
});

// ── §3 Coverage requirements ────────────────────────────────────────────────

describe('DRACO corpus — coverage invariants (ADR-037 §1)', () => {
  const questions = corpus.questions;
  const ALLOWED_DOMAINS = [
    'science',
    'finance',
    'law',
    'current-events',
    'technical',
  ] as const;

  it('corpus version is 1', () => {
    expect(corpus.version).toBe(1);
  });

  it('has at least 15 questions', () => {
    expect(questions.length).toBeGreaterThanOrEqual(15);
  });

  it('covers at least 5 distinct domains', () => {
    const domains = new Set(questions.map(q => q.domain));
    expect(domains.size).toBeGreaterThanOrEqual(5);
  });

  it('every question domain is one of the five DRACO domains', () => {
    for (const q of questions) {
      expect(
        (ALLOWED_DOMAINS as readonly string[]).includes(q.domain),
        `Question ${q.id} has unknown domain "${q.domain}"`,
      ).toBe(true);
    }
  });

  it('each domain has at least 3 questions', () => {
    const counts: Record<string, number> = {};
    for (const q of questions) {
      counts[q.domain] = (counts[q.domain] ?? 0) + 1;
    }
    for (const domain of ALLOWED_DOMAINS) {
      expect(
        counts[domain] ?? 0,
        `Domain "${domain}" has fewer than 3 questions`,
      ).toBeGreaterThanOrEqual(3);
    }
  });
});

// ── §4 Uniqueness ────────────────────────────────────────────────────────────

describe('DRACO corpus — uniqueness (ADR-037 §1)', () => {
  const questions = corpus.questions;

  it('no duplicate question ids', () => {
    const ids = questions.map(q => q.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('every id matches the pattern <domain-prefix>-<3-digit-number>', () => {
    const pattern = /^[a-z]+-[0-9]{3}$/;
    for (const q of questions) {
      expect(
        pattern.test(q.id),
        `Question id "${q.id}" does not match pattern`,
      ).toBe(true);
    }
  });

  it('no duplicate prompts', () => {
    const prompts = questions.map(q => q.prompt);
    const unique = new Set(prompts);
    expect(unique.size).toBe(prompts.length);
  });
});

// ── §5 Rubric sanity ─────────────────────────────────────────────────────────

describe('DRACO corpus — rubric sanity (ADR-037 §1)', () => {
  it('every question has non-empty must_cite, must_contain, and must_not arrays', () => {
    for (const q of corpus.questions) {
      expect(
        q.rubric.must_cite.length,
        `${q.id}: must_cite is empty`,
      ).toBeGreaterThan(0);
      expect(
        q.rubric.must_contain.length,
        `${q.id}: must_contain is empty`,
      ).toBeGreaterThan(0);
      expect(
        q.rubric.must_not.length,
        `${q.id}: must_not is empty`,
      ).toBeGreaterThan(0);
    }
  });

  it('grader field is one of the three allowed values', () => {
    const allowed = new Set(['llm-judge', 'deterministic', 'hybrid']);
    for (const q of corpus.questions) {
      expect(
        allowed.has(q.rubric.grader),
        `${q.id}: grader "${q.rubric.grader}" is not allowed`,
      ).toBe(true);
    }
  });
});
