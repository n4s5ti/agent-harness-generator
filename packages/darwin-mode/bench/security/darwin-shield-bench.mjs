// SPDX-License-Identifier: MIT
//
// DARWIN-SHIELD-BENCH runner (ADR-155 §benchmark plan). Evolves the defensive
// security harness over the seeded corpus, scores it against the three fixed
// baselines (static / LLM single-pass / fixed agent), checks every acceptance
// gate, and writes the receipts:
//
//   bench/results/darwin-shield-bench.json   — full machine-readable report
//   bench/results/DARWIN-SHIELD-RESULTS.md   — human-readable summary
//
// Fully deterministic (seeded): re-running from a clean checkout reproduces the
// byte-identical report — the reproducibility gate proving itself.
//
// Run: npm run build && node bench/security/darwin-shield-bench.mjs [--cycles N] [--population N] [--seed N]

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBenchmark, renderReport } from '../../dist/security/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const resultsDir = join(here, '..', 'results');

function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : Number(process.argv[i + 1] ?? fallback);
}

const config = {
  population: flag('--population', 16),
  cycles: flag('--cycles', 50),
  seed: flag('--seed', 0),
};

process.stdout.write(`DARWIN-SHIELD-BENCH — population ${config.population}, cycles ${config.cycles}, seed ${config.seed}\n`);
const report = runBenchmark(config);

mkdirSync(resultsDir, { recursive: true });
const jsonPath = join(resultsDir, 'darwin-shield-bench.json');
const mdPath = join(resultsDir, 'DARWIN-SHIELD-RESULTS.md');
writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n');
writeFileSync(mdPath, renderReport(report));

process.stdout.write(renderReport(report));
process.stdout.write(`\nWrote ${jsonPath}\n`);
process.stdout.write(`Wrote ${mdPath}\n`);
process.stdout.write(`\nOverall: ${report.passed ? 'PASS ✅' : 'FAIL ❌'}\n`);
process.exit(report.passed ? 0 : 1);
