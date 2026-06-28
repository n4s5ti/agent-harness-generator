#!/usr/bin/env node
// Dependency-free SVG chart generator for the cheap-vs-frontier report.
// Emits text SVG (renders inline in GitHub markdown). No Python, no deps.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const DATA = join(DIR, 'data');
const OUT = join(DIR, 'charts');
mkdirSync(OUT, { recursive: true });
const read = (f) => JSON.parse(readFileSync(join(DATA, f), 'utf8'));

const W = 820, H = 460, M = { t: 56, r: 200, b: 64, l: 64 };
const PW = W - M.l - M.r, PH = H - M.t - M.b;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const C = { frontier: '#2563eb', cheap: '#dc2626', knowledge: '#7c3aed', tooluse: '#16a34a', code: '#ea580c', grid: '#e5e7eb', axis: '#374151', text: '#111827', sub: '#6b7280' };

function frame(title, sub) {
  return `<rect width="${W}" height="${H}" fill="white"/>` +
    `<text x="${M.l}" y="26" font-family="system-ui,sans-serif" font-size="18" font-weight="700" fill="${C.text}">${esc(title)}</text>` +
    `<text x="${M.l}" y="45" font-family="system-ui,sans-serif" font-size="12" fill="${C.sub}">${esc(sub)}</text>`;
}
function legend(items) {
  return items.map((it, i) => {
    const y = M.t + 8 + i * 22, x = M.l + PW + 18;
    const mk = it.line ? `<line x1="${x}" y1="${y}" x2="${x + 18}" y2="${y}" stroke="${it.color}" stroke-width="3"/>` : `<circle cx="${x + 9}" cy="${y}" r="5" fill="${it.color}"/>`;
    return mk + `<text x="${x + 24}" y="${y + 4}" font-family="system-ui,sans-serif" font-size="11.5" fill="${C.text}">${esc(it.label)}</text>`;
  }).join('');
}
const sx = (v, lo, hi) => M.l + ((v - lo) / (hi - lo)) * PW;
const sy = (v, lo, hi) => M.t + PH - ((v - lo) / (hi - lo)) * PH;
function axes(xlab, ylab, xticks, yticks) {
  let s = `<line x1="${M.l}" y1="${M.t + PH}" x2="${M.l + PW}" y2="${M.t + PH}" stroke="${C.axis}" stroke-width="1.5"/>` +
          `<line x1="${M.l}" y1="${M.t}" x2="${M.l}" y2="${M.t + PH}" stroke="${C.axis}" stroke-width="1.5"/>`;
  for (const t of yticks) { const y = t.y; s += `<line x1="${M.l}" y1="${y}" x2="${M.l + PW}" y2="${y}" stroke="${C.grid}" stroke-width="1"/><text x="${M.l - 8}" y="${y + 4}" text-anchor="end" font-family="system-ui,sans-serif" font-size="11" fill="${C.sub}">${esc(t.label)}</text>`; }
  for (const t of xticks) { s += `<text x="${t.x}" y="${M.t + PH + 18}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" fill="${C.sub}">${esc(t.label)}</text>`; }
  s += `<text x="${M.l + PW / 2}" y="${H - 12}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" fill="${C.text}">${esc(xlab)}</text>`;
  s += `<text transform="translate(16,${M.t + PH / 2}) rotate(-90)" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" fill="${C.text}">${esc(ylab)}</text>`;
  return s;
}
const svg = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${inner}</svg>`;
const ts = (d) => new Date(d + 'T00:00:00Z').getTime();

// ---- Chart 1: MMLU-Pro score over time ----
function chart1() {
  const prog = read('frontier_score_vs_date.json').mmlu_pro.frontier_progression;
  const xs = prog.map(p => ts(p.date)), x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = 60, y1 = 92;
  const fr = prog.filter(p => p.type === 'frontier_US').sort((a, b) => ts(a.date) - ts(b.date));
  const ch = prog.filter(p => p.type === 'cheap_CN');
  let s = frame('MMLU-Pro: frontier vs cheap models over time', 'Cheap (CN) models track the US frontier with a ~7–8 month lag; absolute gap now 2–3 pts');
  const yticks = []; for (let v = 60; v <= 90; v += 10) yticks.push({ y: sy(v, y0, y1), label: v + '%' });
  const xticks = []; for (let yr = 2024; yr <= 2026; yr++) xticks.push({ x: sx(ts(yr + '-01-01'), x0, x1), label: String(yr) });
  s += axes('Release date', 'MMLU-Pro (%)', xticks, yticks);
  s += `<polyline fill="none" stroke="${C.frontier}" stroke-width="2.5" points="${fr.map(p => `${sx(ts(p.date), x0, x1)},${sy(p.score, y0, y1)}`).join(' ')}"/>`;
  for (const p of fr) s += `<circle cx="${sx(ts(p.date), x0, x1)}" cy="${sy(p.score, y0, y1)}" r="4" fill="${C.frontier}"/>`;
  for (const p of ch) s += `<circle cx="${sx(ts(p.date), x0, x1)}" cy="${sy(p.score, y0, y1)}" r="5.5" fill="${C.cheap}"/><text x="${sx(ts(p.date), x0, x1)}" y="${sy(p.score, y0, y1) - 9}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9.5" fill="${C.cheap}">${esc(p.model.replace('DeepSeek ', 'DS ').replace('GLM-', 'GLM'))}</text>`;
  s += legend([{ color: C.frontier, line: true, label: 'US frontier' }, { color: C.cheap, label: 'Cheap CN (DeepSeek/GLM)' }]);
  return svg(s);
}

// ---- Chart 2: lag in months over time ----
function chart2() {
  const series = read('lag_in_months.json').lag_series;
  const cat = (b) => /MCP|tau|TAU|tool|Atlas/i.test(b) ? 'tooluse' : /SWE|code|Live/i.test(b) ? 'code' : 'knowledge';
  const pts = series.map(p => ({ x: ts(p.cheap_release), lag: p.lag_months, c: cat(p.benchmark), b: p.benchmark }));
  const xs = pts.map(p => p.x), x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = -3, y1 = 12;
  let s = frame('Time-lag of cheap models behind the US frontier — shrinking', 'Tool-use lag has collapsed to ~0; knowledge/reasoning lag stable ~7–11 mo as the frontier also accelerated');
  const yticks = []; for (let v = 0; v <= 12; v += 3) yticks.push({ y: sy(v, y0, y1), label: v + 'mo' });
  const xticks = []; for (const m of ['2025-01-01', '2025-07-01', '2026-01-01', '2026-06-01']) xticks.push({ x: sx(ts(m), x0, x1), label: m.slice(0, 7) });
  s += axes('Cheap-model release date', 'Lag behind frontier (months)', xticks, yticks);
  s += `<line x1="${M.l}" y1="${sy(0, y0, y1)}" x2="${M.l + PW}" y2="${sy(0, y0, y1)}" stroke="${C.sub}" stroke-width="1" stroke-dasharray="4 3"/>`;
  for (const c of ['knowledge', 'tooluse', 'code']) {
    const g = pts.filter(p => p.c === c).sort((a, b) => a.x - b.x);
    if (g.length > 1) s += `<polyline fill="none" stroke="${C[c]}" stroke-width="2" opacity="0.6" points="${g.map(p => `${sx(p.x, x0, x1)},${sy(p.lag, y0, y1)}`).join(' ')}"/>`;
    for (const p of g) s += `<circle cx="${sx(p.x, x0, x1)}" cy="${sy(p.lag, y0, y1)}" r="5" fill="${C[c]}"/>`;
  }
  s += legend([{ color: C.knowledge, label: 'Knowledge/reasoning' }, { color: C.tooluse, label: 'Tool-use (→ 0)' }, { color: C.code, label: 'Hard code' }]);
  return svg(s);
}

// ---- Chart 3: cost-Pareto (SWE-bench Lite, log-x) ----
function chart3() {
  const pts = read('cost_pareto.json').darwin_cost_pareto_swe_bench_lite.points.filter(p => p.cost_per_instance_usd > 0);
  const lx = pts.map(p => Math.log10(p.cost_per_instance_usd));
  const x0 = Math.min(...lx) - 0.3, x1 = Math.max(...lx) + 0.3, y0 = 25, y1 = 65;
  let s = frame('Cost–performance Pareto: SWE-bench Lite (n=300, Darwin harness)', 'Cheap cascade reaches 51% resolve at $0.27/inst vs ~60% at $15+ frontier-only — the ~56× cost axis');
  const yticks = []; for (let v = 30; v <= 60; v += 10) yticks.push({ y: sy(v, y0, y1), label: v + '%' });
  const xticks = []; for (const c of [0.005, 0.05, 0.5, 15]) { const v = Math.log10(c); if (v >= x0 && v <= x1) xticks.push({ x: sx(v, x0, x1), label: '$' + c }); }
  s += axes('Cost per instance (USD, log scale)', 'Resolve %', xticks, yticks);
  const sorted = pts.slice().sort((a, b) => a.cost_per_instance_usd - b.cost_per_instance_usd);
  s += `<polyline fill="none" stroke="${C.sub}" stroke-width="1.5" stroke-dasharray="5 3" points="${sorted.map(p => `${sx(Math.log10(p.cost_per_instance_usd), x0, x1)},${sy(p.resolve_pct, y0, y1)}`).join(' ')}"/>`;
  for (const p of pts) {
    const x = sx(Math.log10(p.cost_per_instance_usd), x0, x1), y = sy(p.resolve_pct, y0, y1);
    const cheap = /cheap|GLM|Flash|cascade/i.test(p.label) && !/Opus|frontier/i.test(p.label);
    s += `<circle cx="${x}" cy="${y}" r="6" fill="${cheap ? C.cheap : C.frontier}"/>`;
    const short = p.label.replace(/\(.*?\)/, '').trim().slice(0, 22);
    s += `<text x="${x}" y="${y - 10}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="${C.text}">${esc(short)}</text>`;
  }
  s += legend([{ color: C.cheap, label: 'Cheap / cascade' }, { color: C.frontier, label: 'Frontier-only' }]);
  return svg(s);
}

// ---- Chart 4: FRAMES empirical (our measurement) ----
function chart4() {
  const rows = [
    { m: 'GLM-5.2', tier: 'cheap', em: 0.433, cpc: 0.095, ci: [0.357, 0.513] },
    { m: 'DeepSeek-V4-Pro', tier: 'cheap', em: 0.427, cpc: 0.055, ci: [0.350, 0.507] },
    { m: 'GPT-5.2', tier: 'frontier', em: 0.427, cpc: 0.268, ci: [0.350, 0.507] },
    { m: 'Opus-4.5', tier: 'frontier', em: 0.373, cpc: 0.870, ci: [0.300, 0.453] },
  ];
  const lx = rows.map(r => Math.log10(r.cpc));
  const x0 = Math.min(...lx) - 0.3, x1 = Math.max(...lx) + 0.3, y0 = 0.28, y1 = 0.54;
  let s = frame('FRAMES (our measurement, n=150, fair 18-step): accuracy vs cost per correct', 'All 4 models statistically indistinguishable — 95% Wilson CIs overlap; cheap matches gpt-5.2 (0.427) at 5–16× lower cost');
  const yticks = []; for (const v of [0.30, 0.40, 0.50]) yticks.push({ y: sy(v, y0, y1), label: v.toFixed(2) });
  const xticks = []; for (const c of [0.05, 0.1, 0.27, 0.5, 0.87]) { const v = Math.log10(c); if (v >= x0 && v <= x1) xticks.push({ x: sx(v, x0, x1), label: '$' + c }); }
  s += axes('Cost per correct answer (USD, log scale)', 'FRAMES EM accuracy', xticks, yticks);
  for (const r of rows) {
    const x = sx(Math.log10(r.cpc), x0, x1), y = sy(r.em, y0, y1);
    const col = r.tier === 'cheap' ? C.cheap : C.frontier;
    const yl = sy(r.ci[0], y0, y1), yh = sy(r.ci[1], y0, y1);
    s += `<line x1="${x}" y1="${yh}" x2="${x}" y2="${yl}" stroke="${col}" stroke-width="1.5" opacity="0.7"/><line x1="${x - 4}" y1="${yh}" x2="${x + 4}" y2="${yh}" stroke="${col}" stroke-width="1.5"/><line x1="${x - 4}" y1="${yl}" x2="${x + 4}" y2="${yl}" stroke="${col}" stroke-width="1.5"/>`;
    s += `<circle cx="${x}" cy="${y}" r="6" fill="${col}"/>`;
    s += `<text x="${x}" y="${yh - 6}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="600" fill="${C.text}">${esc(r.m)}</text>`;
  }
  s += legend([{ color: C.cheap, label: 'Cheap (DeepSeek/GLM)' }, { color: C.frontier, label: 'Older-frontier (GPT/Opus)' }, { color: C.sub, label: 'whiskers = 95% Wilson CI' }]);
  return svg(s);
}

// ---- Chart 5: BFCL tool-use (our measurement) ----
function chart5() {
  const rows = [
    { m: 'DeepSeek-V4-Pro', tier: 'cheap', acc: 0.96, cpt: 0.00071, ci: [0.915, 0.982] },
    { m: 'GLM-5.2', tier: 'cheap', acc: 0.88, cpt: 0.00082, ci: [0.818, 0.923] },
    { m: 'GPT-5.2', tier: 'frontier', acc: 0.833, cpt: 0.00154, ci: [0.765, 0.884] },
    { m: 'Opus-4.5 † artifact', tier: 'artifact', acc: 0.433, cpt: 0.00329, ci: [0.357, 0.513] },
  ];
  const lx = rows.map(r => Math.log10(r.cpt));
  const x0 = Math.min(...lx) - 0.25, x1 = Math.max(...lx) + 0.25, y0 = 0.35, y1 = 1.0;
  let s = frame('BFCL tool-use / function-calling (our measurement, n=150): accuracy vs cost', 'Cheap deepseek 0.96 > gpt-5.2 0.833 (non-overlapping 95% CI), glm 0.88 ≈ gpt, ~2× cheaper. †Opus = harness format artifact (true ~79%, MCP-Atlas)');
  const yticks = []; for (const v of [0.4, 0.6, 0.8, 1.0]) yticks.push({ y: sy(v, y0, y1), label: v.toFixed(1) });
  const xticks = []; for (const c of [0.0007, 0.001, 0.0015, 0.003]) { const v = Math.log10(c); if (v >= x0 && v <= x1) xticks.push({ x: sx(v, x0, x1), label: '$' + c }); }
  s += axes('Cost per task (USD, log scale)', 'BFCL accuracy', xticks, yticks);
  for (const r of rows) {
    const x = sx(Math.log10(r.cpt), x0, x1), y = sy(r.acc, y0, y1);
    const col = r.tier === 'cheap' ? C.cheap : r.tier === 'artifact' ? C.sub : C.frontier;
    const art = r.tier === 'artifact';
    const yl = sy(r.ci[0], y0, y1), yh = sy(r.ci[1], y0, y1);
    s += `<line x1="${x}" y1="${yh}" x2="${x}" y2="${yl}" stroke="${col}" stroke-width="1.5" opacity="${art ? 0.4 : 0.7}"/><line x1="${x - 4}" y1="${yh}" x2="${x + 4}" y2="${yh}" stroke="${col}" stroke-width="1.5" opacity="${art ? 0.4 : 1}"/><line x1="${x - 4}" y1="${yl}" x2="${x + 4}" y2="${yl}" stroke="${col}" stroke-width="1.5" opacity="${art ? 0.4 : 1}"/>`;
    s += `<circle cx="${x}" cy="${y}" r="6" fill="${col}"${art ? ' opacity="0.5"' : ''}/>`;
    s += `<text x="${x}" y="${yh - 6}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="600" fill="${C.text}">${esc(r.m)}</text>`;
  }
  s += legend([{ color: C.cheap, label: 'Cheap (DeepSeek/GLM)' }, { color: C.frontier, label: 'Frontier (GPT-5.2)' }, { color: C.sub, label: 'Opus (harness artifact)' }, { color: C.sub, label: 'whiskers = 95% Wilson CI' }]);
  return svg(s);
}

const charts = { '01-mmlu-score-over-time': chart1(), '02-lag-shrinking': chart2(), '03-cost-pareto-swebench': chart3(), '04-frames-empirical-pareto': chart4(), '05-bfcl-tooluse': chart5() };
for (const [name, s] of Object.entries(charts)) { writeFileSync(join(OUT, name + '.svg'), s); console.log('wrote charts/' + name + '.svg (' + s.length + ' bytes)'); }
