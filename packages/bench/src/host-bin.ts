#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Cross-host config-gen bench runner.
//
// Usage:
//   node ./dist/host-bin.js                       # 1000 iters per host
//   BENCH_HOST_ITERS=10000 node ./dist/host-bin.js
//   BENCH_HOST_OUT=./host-bench.json node ./dist/host-bin.js
//
// Prints a markdown table to stdout and (when BENCH_HOST_OUT is set)
// writes a JSON report for CI artifact upload.

import { writeFileSync } from 'node:fs';
import { benchAllHosts, formatResultsTable } from './host-bench.js';

const iters = parseInt(process.env.BENCH_HOST_ITERS ?? '1000', 10);
const out = process.env.BENCH_HOST_OUT;

const t0 = Date.now();
const results = benchAllHosts(iters);
const elapsedMs = Date.now() - t0;

process.stdout.write(`# Cross-host config-gen benchmark (${iters} iters/host)\n\n`);
process.stdout.write(formatResultsTable(results) + '\n\n');
process.stdout.write(`Total wall time: ${elapsedMs}ms across ${results.length} hosts.\n`);

if (out) {
  writeFileSync(out, JSON.stringify({
    iterations: iters,
    elapsedMs,
    results,
    timestamp: new Date().toISOString(),
  }, null, 2));
  process.stderr.write(`[host-bench] wrote ${out}\n`);
}
