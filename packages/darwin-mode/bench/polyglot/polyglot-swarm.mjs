export const meta = {
  name: 'polyglot-code-bench',
  description: 'Execution-scored code benchmark: 7 priced models × 6 languages (Python/JS/TS/Rust/C++/C) solve merge-intervals; each program is compiled and run against 8 hidden cases. Real OpenRouter calls + real execution. Tests whether cheap-beats-frontier holds for CODE across languages.',
  phases: [{ title: 'bench', detail: '42 model×language cells, compiled and executed' }],
}

const MODELS = [
  { id: 'anthropic/claude-opus-4',     price: 45, tier: 'frontier' },
  { id: 'openai/gpt-5',                price: 12, tier: 'frontier' },
  { id: 'anthropic/claude-sonnet-4',   price: 9,  tier: 'mid' },
  { id: 'google/gemini-2.5-pro',       price: 7,  tier: 'mid' },
  { id: 'anthropic/claude-haiku-4.5',  price: 3,  tier: 'cheap' },
  { id: 'openai/gpt-5-mini',           price: 2,  tier: 'cheap' },
  { id: 'google/gemini-2.5-flash',     price: 1,  tier: 'cheap' },
]
const LANGS = ['python', 'js', 'ts', 'rust', 'cpp', 'c']

const CELL_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    model: { type: 'string' }, lang: { type: 'string' },
    passed: { type: 'number' }, total: { type: 'number' }, quality: { type: 'number' },
    compile_ok: { type: 'boolean' }, tokens: { type: 'number' },
    cost_reported: { type: ['number', 'null'] }, latency_ms: { type: 'number' },
  },
  required: ['model', 'lang', 'passed', 'total', 'quality', 'compile_ok'],
}

const cells = []
for (const m of MODELS) for (const lang of LANGS) cells.push({ m, lang })

phase('bench')
const results = await parallel(cells.map(({ m, lang }) => () =>
  agent(
    `Run ONE polyglot benchmark cell. Execute exactly this (key is on disk):\n` +
    `  OPENROUTER_API_KEY=$(cat /tmp/.orkey) node /tmp/polyglot/run-cell.mjs ${JSON.stringify(m.id)} ${lang}\n` +
    `It calls OpenRouter for a ${lang} solution, compiles+runs it against 8 hidden tests, prints one JSON line, ` +
    `and writes /tmp/polyglot/out/<safe>__${lang}.json. Return that JSON line's fields. Do not edit any code yourself.`,
    { schema: CELL_SCHEMA, label: `${m.id}:${lang}`, phase: 'bench' },
  ).then((r) => r ? { ...r, tier: m.tier, price: m.price } : null)
))

const rows = results.filter(Boolean)
// Per-model aggregate across languages.
const byModel = {}
for (const r of rows) {
  const k = r.model
  byModel[k] ??= { model: k, tier: r.tier, price: r.price, qualitySum: 0, tokensSum: 0, n: 0, perLang: {} }
  byModel[k].qualitySum += r.quality
  byModel[k].tokensSum += r.tokens || 0
  byModel[k].n += 1
  byModel[k].perLang[r.lang] = r.quality
}
const agg = Object.values(byModel).map((a) => {
  const avgQuality = a.n ? a.qualitySum / a.n : 0
  const avgCostUSD = (a.tokensSum / a.n / 1e6) * a.price // blended price × mean tokens/cell
  return {
    model: a.model, tier: a.tier, price: a.price,
    avgQuality: Math.round(avgQuality * 10) / 10,
    cells: a.n, perLang: a.perLang,
    avgCostPerCellUSD: Math.round(avgCostUSD * 1e6) / 1e6,
    qualityPerUSD: avgCostUSD > 0 ? Math.round(avgQuality / avgCostUSD) : null,
  }
}).sort((x, y) => y.avgQuality - x.avgQuality)

log(`polyglot: ${rows.length}/${cells.length} cells executed across ${LANGS.length} languages`)
return { rows, agg }
