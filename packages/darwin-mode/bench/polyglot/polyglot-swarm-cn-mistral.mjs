export const meta = {
  name: 'polyglot-code-bench-cn-mistral',
  description: 'Execution-scored polyglot code benchmark, extended set: 5 Chinese models (DeepSeek-V3, DeepSeek-R1, Qwen2.5-Coder, Kimi-K2, GLM-4.6) + 3 Mistral (Large, Codestral, Medium-3) × 6 languages. Same merge-intervals task, compiled and run against 8 hidden cases. Real OpenRouter + real execution.',
  phases: [{ title: 'bench', detail: '48 model×language cells, compiled and executed' }],
}

// Approx blended USD/Mtok for the quality/$ display; the real per-cell spend is
// captured as cost_reported from OpenRouter usage in each cell's JSON.
const MODELS = [
  { id: 'deepseek/deepseek-chat',             price: 0.4, tier: 'cn-cheap',  origin: 'China (DeepSeek V3)' },
  { id: 'deepseek/deepseek-r1',               price: 1.0, tier: 'cn-reason', origin: 'China (DeepSeek R1)' },
  { id: 'qwen/qwen-2.5-coder-32b-instruct',   price: 0.3, tier: 'cn-cheap',  origin: 'China (Alibaba Qwen Coder)' },
  { id: 'moonshotai/kimi-k2',                 price: 1.0, tier: 'cn-mid',    origin: 'China (Moonshot Kimi K2)' },
  { id: 'z-ai/glm-4.6',                       price: 0.7, tier: 'cn-mid',    origin: 'China (Zhipu GLM-4.6)' },
  { id: 'mistralai/mistral-large',            price: 4.0, tier: 'eu-mid',    origin: 'France (Mistral Large)' },
  { id: 'mistralai/codestral-2508',           price: 0.5, tier: 'eu-code',   origin: 'France (Mistral Codestral)' },
  { id: 'mistralai/mistral-medium-3',         price: 0.8, tier: 'eu-mid',    origin: 'France (Mistral Medium 3)' },
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
  ).then((r) => r ? { ...r, tier: m.tier, price: m.price, origin: m.origin } : null)
))

const rows = results.filter(Boolean)
const byModel = {}
for (const r of rows) {
  byModel[r.model] ??= { model: r.model, tier: r.tier, price: r.price, origin: r.origin, qualitySum: 0, tokensSum: 0, n: 0, perLang: {} }
  const a = byModel[r.model]
  a.qualitySum += r.quality; a.tokensSum += r.tokens || 0; a.n += 1; a.perLang[r.lang] = r.quality
}
const agg = Object.values(byModel).map((a) => {
  const avgQuality = a.n ? a.qualitySum / a.n : 0
  const avgCostUSD = (a.tokensSum / a.n / 1e6) * a.price
  return {
    model: a.model, tier: a.tier, origin: a.origin, price: a.price,
    avgQuality: Math.round(avgQuality * 10) / 10, cells: a.n, perLang: a.perLang,
    avgCostPerCellUSD: Math.round(avgCostUSD * 1e6) / 1e6,
    qualityPerUSD: avgCostUSD > 0 ? Math.round(avgQuality / avgCostUSD) : null,
  }
}).sort((x, y) => y.avgQuality - x.avgQuality)

log(`polyglot CN+Mistral: ${rows.length}/${cells.length} cells across ${LANGS.length} languages`)
return { rows, agg }
