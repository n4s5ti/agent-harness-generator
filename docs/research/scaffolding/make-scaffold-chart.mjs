// SPDX-License-Identifier: MIT
//
// make-scaffold-chart.mjs — dependency-free SVG charts for the scaffolding ablation.
// Reads the summary.json emitted by packages/darwin-mode/bench/gaia/scaffold-ablation.mjs
// and renders two panels into docs/research/scaffolding/charts/:
//   01-scaffold-cost-resolve.svg  — cost↔resolve Pareto (X=$/task log, Y=resolve%, Wilson whiskers)
//   02-self-consistency-curve.svg — SC resolve vs N samples + verifier-BoN@N overlay (gen-verif gap)
//
// Run: node --experimental-strip-types make-scaffold-chart.mjs --summary <path> --outdir charts

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const rel = (p) => (isAbsolute(p) ? p : join(HERE, p));
const SUMMARY = rel(argv('--summary', '../../../packages/darwin-mode/bench/gaia/runs/summary.json'));
const OUTDIR = rel(argv('--outdir', 'charts'));
mkdirSync(OUTDIR, { recursive: true });

const S = JSON.parse(readFileSync(SUMMARY, 'utf8'));
const COLOR = { 'deepseek/deepseek-v4-pro': '#2563eb', 'z-ai/glm-5.2': '#ea580c' };
const SHORT = (m) => (m.includes('deepseek') ? 'deepseek-v4-pro' : m.includes('glm') ? 'glm-5.2' : m);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── Panel 1: cost↔resolve Pareto ──────────────────────────────────────────────
function paretoSvg() {
  const W = 760, H = 480, mL = 64, mR = 180, mT = 48, mB = 64;
  const pts = S.cells.filter((c) => (c.view === 'primary' || c.view === 'majority') && Number.isFinite(c.acc) && c.cost_per_task > 0);
  const costs = pts.map((p) => p.cost_per_task);
  const xMin = Math.min(...costs) * 0.7, xMax = Math.max(...costs) * 1.4;
  const lx = (c) => mL + (Math.log10(c) - Math.log10(xMin)) / (Math.log10(xMax) - Math.log10(xMin)) * (W - mL - mR);
  const yMax = Math.min(1, Math.max(...pts.map((p) => p.ci[1])) + 0.05), yMin = Math.max(0, Math.min(...pts.map((p) => p.ci[0])) - 0.05);
  const ly = (a) => mT + (1 - (a - yMin) / (yMax - yMin)) * (H - mT - mB);
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="system-ui,sans-serif" font-size="12">`;
  s += `<rect width="${W}" height="${H}" fill="#fff"/>`;
  s += `<text x="${mL}" y="24" font-size="15" font-weight="700">Scaffolding cost↔resolve (FRAMES n=${S.n}, seed ${S.seed}, reasoning OFF)</text>`;
  // gridlines (Y every 5pp)
  for (let a = Math.ceil(yMin * 20) / 20; a <= yMax; a += 0.05) { const y = ly(a); s += `<line x1="${mL}" y1="${y}" x2="${W - mR}" y2="${y}" stroke="#eee"/><text x="${mL - 8}" y="${y + 4}" text-anchor="end" fill="#666">${(a * 100).toFixed(0)}%</text>`; }
  // X ticks (log decades + the data costs)
  for (const c of [0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5]) { if (c < xMin || c > xMax) continue; const x = lx(c); s += `<line x1="${x}" y1="${mT}" x2="${x}" y2="${H - mB}" stroke="#f3f3f3"/><text x="${x}" y="${H - mB + 18}" text-anchor="middle" fill="#666">$${c}</text>`; }
  s += `<text x="${(mL + W - mR) / 2}" y="${H - 12}" text-anchor="middle" fill="#333">$/task (log scale) →</text>`;
  s += `<text transform="translate(16,${(mT + H - mB) / 2}) rotate(-90)" text-anchor="middle" fill="#333">resolve (EM, Wilson 95% CI)</text>`;
  for (const p of pts) {
    const x = lx(p.cost_per_task), y = ly(p.acc), col = COLOR[p.model] || '#444';
    const dashed = p.view === 'majority';
    s += `<line x1="${x}" y1="${ly(p.ci[0])}" x2="${x}" y2="${ly(p.ci[1])}" stroke="${col}" stroke-width="1.4" opacity="0.5"/>`;
    s += dashed
      ? `<rect x="${x - 4}" y="${y - 4}" width="8" height="8" fill="none" stroke="${col}" stroke-width="2"/>`
      : `<circle cx="${x}" cy="${y}" r="4.5" fill="${col}"/>`;
    s += `<text x="${x + 7}" y="${y - 6}" fill="${col}" font-size="10">${esc(p.scaffold)}</text>`;
  }
  // legend
  let ly0 = mT + 6;
  for (const [m, c] of Object.entries(COLOR)) { s += `<circle cx="${W - mR + 12}" cy="${ly0}" r="4.5" fill="${c}"/><text x="${W - mR + 22}" y="${ly0 + 4}" fill="#333">${SHORT(m)}</text>`; ly0 += 20; }
  s += `<rect x="${W - mR + 8}" y="${ly0 - 4}" width="8" height="8" fill="none" stroke="#666" stroke-width="2"/><text x="${W - mR + 22}" y="${ly0 + 4}" fill="#333">□ = majority-vote (SC) view</text>`;
  s += `<text x="${W - mR + 8}" y="${ly0 + 26}" fill="#888" font-size="10">up-left = better</text><text x="${W - mR + 8}" y="${ly0 + 40}" fill="#888" font-size="10">(lift per $).</text>`;
  s += `</svg>`; return s;
}

// ── Panel 2: Self-Consistency saturation curve ─────────────────────────────────
function curveSvg() {
  const W = 720, H = 460, mL = 60, mR = 170, mT = 48, mB = 56;
  const curves = S.cells.filter((c) => c.view === 'sc-curve' && c.sc_curve);
  const ks = [1, 3, 5, 7, 10];
  const accs = curves.flatMap((c) => ks.map((k) => c.sc_curve[`k${k}`]?.acc).filter(Number.isFinite));
  const bonPts = S.cells.filter((c) => c.view === 'primary' && /verifier-bon|ps-bon/.test(c.scaffold));
  const allAcc = [...accs, ...bonPts.map((b) => b.acc)];
  const yMax = Math.min(1, Math.max(...allAcc, 0.3) + 0.06), yMin = Math.max(0, Math.min(...allAcc, 0.3) - 0.06);
  const lx = (k) => mL + (k - 1) / 9 * (W - mL - mR);
  const ly = (a) => mT + (1 - (a - yMin) / (yMax - yMin)) * (H - mT - mB);
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="system-ui,sans-serif" font-size="12">`;
  s += `<rect width="${W}" height="${H}" fill="#fff"/>`;
  s += `<text x="${mL}" y="24" font-size="15" font-weight="700">Self-Consistency saturation vs verifier-BoN (FRAMES n=${S.n})</text>`;
  for (let a = Math.ceil(yMin * 20) / 20; a <= yMax; a += 0.05) { const y = ly(a); s += `<line x1="${mL}" y1="${y}" x2="${W - mR}" y2="${y}" stroke="#eee"/><text x="${mL - 8}" y="${y + 4}" text-anchor="end" fill="#666">${(a * 100).toFixed(0)}%</text>`; }
  for (const k of ks) { const x = lx(k); s += `<text x="${x}" y="${H - mB + 18}" text-anchor="middle" fill="#666">N=${k}</text>`; }
  s += `<text x="${(mL + W - mR) / 2}" y="${H - 10}" text-anchor="middle" fill="#333">samples N (majority vote) →</text>`;
  s += `<text transform="translate(14,${(mT + H - mB) / 2}) rotate(-90)" text-anchor="middle" fill="#333">resolve (EM)</text>`;
  for (const c of curves) {
    const col = COLOR[c.model] || '#444';
    let d = '';
    for (const k of ks) { const v = c.sc_curve[`k${k}`]; if (!v || !Number.isFinite(v.acc)) continue; d += (d ? 'L' : 'M') + lx(k) + ',' + ly(v.acc) + ' '; }
    s += `<path d="${d}" fill="none" stroke="${col}" stroke-width="2"/>`;
    for (const k of ks) { const v = c.sc_curve[`k${k}`]; if (!v) continue; s += `<circle cx="${lx(k)}" cy="${ly(v.acc)}" r="3.5" fill="${col}"/>`; }
  }
  // verifier-BoN overlay (stars) at N=samples
  for (const b of bonPts) {
    const col = COLOR[b.model] || '#444'; const n = (b.scaffold.includes('ps') ? 5 : 10);
    const x = lx(n), y = ly(b.acc);
    s += `<path d="M${x},${y - 6} L${x + 2},${y - 1} L${x + 6},${y - 1} L${x + 3},${y + 2} L${x + 4},${y + 7} L${x},${y + 4} L${x - 4},${y + 7} L${x - 3},${y + 2} L${x - 6},${y - 1} L${x - 2},${y - 1} Z" fill="${col}" stroke="#000" stroke-width="0.4"/>`;
    s += `<text x="${x + 8}" y="${y + 3}" fill="${col}" font-size="10">${esc(b.scaffold)}</text>`;
  }
  let ly0 = mT + 6;
  for (const [m, c] of Object.entries(COLOR)) { s += `<line x1="${W - mR + 8}" y1="${ly0}" x2="${W - mR + 22}" y2="${ly0}" stroke="${c}" stroke-width="2"/><text x="${W - mR + 28}" y="${ly0 + 4}" fill="#333">${SHORT(m)} SC</text>`; ly0 += 20; }
  s += `<text x="${W - mR + 8}" y="${ly0 + 8}" fill="#888" font-size="10">★ = verifier-gated BoN</text><text x="${W - mR + 8}" y="${ly0 + 22}" fill="#888" font-size="10">(star above line at same N</text><text x="${W - mR + 8}" y="${ly0 + 36}" fill="#888" font-size="10">= verifier beats vote).</text>`;
  s += `</svg>`; return s;
}

writeFileSync(join(OUTDIR, '01-scaffold-cost-resolve.svg'), paretoSvg());
writeFileSync(join(OUTDIR, '02-self-consistency-curve.svg'), curveSvg());
console.log(`wrote 2 charts → ${OUTDIR}`);
