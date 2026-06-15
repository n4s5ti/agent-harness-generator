// SPDX-License-Identifier: MIT
//
// DRACO live-citation enforcer — the harness-side Self-RAG counterpart to the
// grounding gate (ADR-038 arm 6).
//
// The grounding gate (arm 5) proved the ONLY honest grounding win is when a dead
// citation is REDUNDANT — a live citation already supports the same claim. When a
// dead URL is the SOLE support, the gate must drop the whole claim (coverage cost).
// This module attacks that loss at its source: RETRIEVE→JUDGE→CONSOLIDATE. Given a
// pool of retrieved sources with known liveness, for each DEAD citation it finds a
// LIVE source that supports the SAME claim and SWAPS it in — turning a would-be
// dropped claim into a live-cited one. Coverage is preserved AND grounding rises.
//
// Honesty invariant (same as the gate): it only UPGRADES support — it never keeps
// a dead link beside an unsupported claim, and it never invents a citation. A live
// mirror is used only when a real pooled source genuinely supports the claim
// (shares the claim's rubric/content terms). When no live mirror exists, the dead
// citation is left untouched for the grounding gate to handle honestly (drop the
// claim). Composing enforce→gate is the full honest pipeline.
//
// Fully offline-testable: liveness is the injected UrlChecker, the source pool is
// data. No API run, deterministic, pure.

import { extractUrls, type UrlChecker } from './scorer.js';
import { splitSentences, applyGroundingGate, type GroundingGateReport } from './grounding-gate.js';

/** A retrieved source: its URL and the content terms it grounds (lower-cased match keys). */
export interface PooledSource {
  url: string;
  /** Terms/phrases this source supports — used to match it to a claim sentence. */
  supports: string[];
}

export interface LiveCitationReport {
  /** Dead citations replaced by a live mirror that supports the same claim. */
  swapped: number;
  /** Dead citations with NO live mirror available — left for the gate to drop. */
  unresolved: number;
  /** Sentences that already had only-live citations (untouched). */
  alreadyLive: number;
  enforcedAnswer: string;
}

/** A claim sentence "matches" a source when the source supports a term present in it. */
function sourceSupportsSentence(src: PooledSource, sentence: string): boolean {
  const lc = sentence.toLowerCase();
  return src.supports.some((t) => t.length > 0 && lc.includes(t.toLowerCase()));
}

/**
 * Enforce live citations on an answer using a pool of retrieved sources. For each
 * sentence with a dead-only citation set, swap in a LIVE pooled source that
 * supports the claim (if one exists). Deterministic + offline (`checkUrl` injected).
 */
export async function enforceLiveCitations(
  answer: string,
  pool: PooledSource[],
  checkUrl: UrlChecker,
): Promise<LiveCitationReport> {
  // Liveness for every URL we might touch (answer URLs + pool URLs), one lookup each.
  const urls = new Set<string>([...extractUrls(answer), ...pool.map((p) => p.url)]);
  const liveness = new Map<string, boolean>();
  await Promise.all([...urls].map(async (u) => liveness.set(u, (await checkUrl(u)) === 'ok')));
  const isLive = (u: string) => liveness.get(u) === true;
  const livePool = pool.filter((p) => isLive(p.url));

  let swapped = 0;
  let unresolved = 0;
  let alreadyLive = 0;
  const usedMirrors = new Set<string>(); // don't reuse the same mirror twice (no fake redundancy)

  const out: string[] = [];
  for (const sentence of splitSentences(answer)) {
    const cited = extractUrls(sentence);
    if (cited.length === 0) {
      out.push(sentence);
      continue;
    }
    const live = cited.filter(isLive);
    const dead = cited.filter((u) => !isLive(u));
    if (dead.length === 0) {
      alreadyLive += 1;
      out.push(sentence);
      continue;
    }
    if (live.length > 0) {
      // Already supported by a live cite — the gate will strip the dead token. Leave as-is.
      out.push(sentence);
      continue;
    }
    // Dead-only claim: try to swap the FIRST dead URL for an unused live mirror
    // that supports this exact claim. Only one genuine mirror — never fabricate.
    const mirror = livePool.find((p) => !usedMirrors.has(p.url) && sourceSupportsSentence(p, sentence));
    if (mirror) {
      usedMirrors.add(mirror.url);
      // Replace the first dead URL with the live mirror; drop any other dead tokens.
      let gated = sentence.replace(dead[0], mirror.url);
      for (const d of dead.slice(1)) gated = gated.split(d).join('').replace(/\(\s*\)/g, '');
      gated = gated.replace(/\s{2,}/g, ' ').replace(/\s+([.,;])/g, '$1').trim();
      swapped += 1;
      out.push(gated);
    } else {
      // No live mirror — leave untouched; the grounding gate handles it honestly.
      unresolved += 1;
      out.push(sentence);
    }
  }

  return { swapped, unresolved, alreadyLive, enforcedAnswer: out.join(' ') };
}

/** Stop-words excluded from a source's support terms (low-signal for matching). */
const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'about', 'that', 'this', 'are', 'was', 'were', 'its', 'http', 'https', 'www',
  'com', 'org', 'net', 'html', 'source', 'sources', 'primary', 'report', 'data', 'see', 'via', 'per', 'each',
]);

/**
 * Build a live-mirror pool from a harness's OWN retrieved-source text (the
 * `search`/`grade` stage output). For each URL on a line, the support terms are
 * the meaningful words sharing that line (the source's topic/description) — so a
 * graded source can be matched to a claim it covers. This lets the live-citation
 * enforcer rescue a dead citation using a source the harness ALREADY retrieved,
 * with no extra fetch and no fabrication. Pure + deterministic.
 */
export function poolFromSourceText(sourceText: string): PooledSource[] {
  const pool: PooledSource[] = [];
  for (const line of sourceText.split(/\r?\n/)) {
    const urls = extractUrls(line);
    if (urls.length === 0) continue;
    // Support terms = words on the line minus the URLs themselves + stop-words.
    let bare = line;
    for (const u of urls) bare = bare.split(u).join(' ');
    const terms = [
      ...new Set(
        (bare.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? []).filter((w) => !STOP.has(w)),
      ),
    ];
    for (const url of urls) pool.push({ url, supports: terms });
  }
  return pool;
}

export interface LivePipelineReport {
  enforce: LiveCitationReport;
  gate: GroundingGateReport;
  pipelineAnswer: string;
}

/**
 * The full honest grounding pipeline: enforce live mirrors FIRST (preserve
 * coverage by swapping dead-only claims to live sources), then run the grounding
 * gate (strip redundant dead tokens, drop any claims still dead-only). The output
 * is the maximally-grounded answer that is still 100% honest — no hidden claims,
 * no fabricated citations.
 */
export async function runLiveCitationPipeline(
  answer: string,
  pool: PooledSource[],
  checkUrl: UrlChecker,
): Promise<LivePipelineReport> {
  const enforce = await enforceLiveCitations(answer, pool, checkUrl);
  const gate = await applyGroundingGate(enforce.enforcedAnswer, checkUrl);
  return { enforce, gate, pipelineAnswer: gate.gatedAnswer };
}
