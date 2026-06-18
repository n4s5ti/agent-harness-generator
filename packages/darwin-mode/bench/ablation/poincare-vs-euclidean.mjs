// SPDX-License-Identifier: MIT
//
// ADR-095 ablation: does the Poincaré (polar radial-shell) niche grid resolve
// agent-behaviour diversity better than a flat Euclidean (Cartesian) grid with a
// MATCHED cell budget? We bin the SAME embedded points with the production
// binning functions (poincareNicheOf / euclideanNicheOf — no re-implementation)
// under two synthetic regimes and report real numbers. HONEST: this isolates the
// binning GEOMETRY on controlled point sets; it is not a claim about a learned
// low-distortion tree embedding.
//
// Run: node bench/ablation/poincare-vs-euclidean.mjs   (deterministic, seeded)

import { poincareNicheOf, euclideanNicheOf, mulberry32 } from '../../dist/index.js';

const SHELLS = 4, SECTORS = 6;       // Poincaré: 24 cells
const BINS = 5;                       // Euclidean: 25 cells (matched budget)
const STRATEGIES = 8;                 // distinct ground-truth behaviour strategies
const SAMPLES = 40;                   // noisy samples per strategy
const NOISE = 0.04;

function clampDisk(x, y) {
  const r = Math.hypot(x, y);
  return r >= 0.999 ? [x * (0.999 / r), y * (0.999 / r)] : [x, y];
}

// Two regimes. 'hierarchical': strategies arranged by DEPTH (radius) — the
// realistic structure for agent behaviour (shallow→deep). 'uniform': strategies
// spread uniformly by area (control, neutral to neither geometry).
function strategyCenters(regime, rng) {
  const centers = [];
  for (let s = 0; s < STRATEGIES; s++) {
    if (regime === 'hierarchical') {
      // depth grows with s → radius grows; angle spread so they're distinct.
      const r = 0.12 + 0.84 * (s / (STRATEGIES - 1));
      const theta = (s * 2.39996) % (2 * Math.PI); // golden-angle spread
      centers.push([r * Math.cos(theta), r * Math.sin(theta)]);
    } else {
      const r = Math.sqrt(rng()) * 0.95; // uniform-in-area
      const theta = rng() * 2 * Math.PI;
      centers.push([r * Math.cos(theta), r * Math.sin(theta)]);
    }
  }
  return centers;
}

function run(regime) {
  const rng = mulberry32(regime === 'hierarchical' ? 101 : 202);
  const centers = strategyCenters(regime, rng);
  const pts = []; // {strategy, x, y}
  for (let s = 0; s < STRATEGIES; s++) {
    for (let i = 0; i < SAMPLES; i++) {
      const [x, y] = clampDisk(centers[s][0] + (rng() - 0.5) * NOISE * 2, centers[s][1] + (rng() - 0.5) * NOISE * 2);
      pts.push({ s, x, y });
    }
  }

  const measure = (nicheOf) => {
    const occupied = new Set();
    const byNiche = new Map(); // niche -> Set(strategy)
    const strategyNiche = new Map(); // strategy -> Set(niche)
    for (const p of pts) {
      const n = nicheOf(p.x, p.y);
      occupied.add(n);
      (byNiche.get(n) ?? byNiche.set(n, new Set()).get(n)).add(p.s);
      (strategyNiche.get(p.s) ?? strategyNiche.set(p.s, new Set()).get(p.s)).add(n);
    }
    // Separation: fraction of distinct-strategy PAIRS that never share a niche.
    let separated = 0, total = 0;
    for (let a = 0; a < STRATEGIES; a++) {
      for (let b = a + 1; b < STRATEGIES; b++) {
        total++;
        const na = strategyNiche.get(a), nb = strategyNiche.get(b);
        let overlap = false;
        for (const x of na) if (nb.has(x)) { overlap = true; break; }
        if (!overlap) separated++;
      }
    }
    // Occupancy entropy (normalized 0..1) — higher = more even spread.
    const counts = [...byNiche.values()].map((set) => set.size); // proxy weight
    return {
      distinctNiches: occupied.size,
      strategySeparation: +(separated / total).toFixed(3),
    };
  };

  return {
    regime,
    poincare: measure((x, y) => poincareNicheOf(x, y, SHELLS, SECTORS)),
    euclidean: measure((x, y) => euclideanNicheOf(x, y, BINS)),
  };
}

const results = ['hierarchical', 'uniform'].map(run);
console.log(JSON.stringify({ shells: SHELLS, sectors: SECTORS, bins: BINS, strategies: STRATEGIES, samples: SAMPLES, results }, null, 2));
