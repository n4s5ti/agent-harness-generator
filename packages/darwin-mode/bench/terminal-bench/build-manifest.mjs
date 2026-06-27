// SPDX-License-Identifier: MIT
//
// Terminal-Bench MANIFEST builder (the hardest-first task list). Mirrors livecodebench/build-manifest.py:
// read the OFFICIAL downloaded dataset, emit a small JSON manifest the harness + our hardest-first
// scheduler consume. We do NOT invent tasks or scores — we only read the task.yaml metadata the
// dataset ships (difficulty, category, tags) and a difficulty PROXY (reference-solution length).
//
// Hardest-first ordering (the crack-the-tail pattern): primary key = declared `difficulty`
// (hard > medium > easy), tiebreak = reference-solution byte length (longer ≈ more steps). The
// scheduler runs the head of this list first, then walks up.
//
// Usage:
//   node build-manifest.mjs \
//     [--dataset ~/.cache/terminal-bench/terminal-bench-core/0.1.1] \
//     [--out tbench-manifest.json]
//
// Output: { dataset, version, n, byDifficulty:{hard,medium,easy}, tasks:[
//   { task_id, difficulty, rank, category, tags, solution_bytes, instruction_chars } ] }
// `tasks` is ALREADY sorted hardest-first; `rank` is the 0-based hardest-first index.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const rel = (p) => (isAbsolute(p) ? p : join(HERE, p));

const DATASET = (argv('--dataset', join(homedir(), '.cache/terminal-bench/terminal-bench-core/0.1.1')))
  .replace(/^~/, homedir());
const OUT = rel(argv('--out', 'tbench-manifest.json'));

const DIFF_RANK = { hard: 0, medium: 1, easy: 2, unknown: 3 };

// Minimal task.yaml field extractor (avoids a YAML dep — these files are flat scalars + small lists).
function readTaskMeta(taskDir) {
  const yamlPath = join(taskDir, 'task.yaml');
  if (!existsSync(yamlPath)) return null;
  const txt = readFileSync(yamlPath, 'utf8');
  const scalar = (k) => {
    const m = txt.match(new RegExp(`^${k}:\\s*(.+)$`, 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : undefined;
  };
  // tags is a YAML block list under `tags:`; collect indented `- x` lines
  const tags = [];
  const tagBlock = txt.match(/^tags:\s*\n((?:\s+-\s+.+\n?)+)/m);
  if (tagBlock) for (const l of tagBlock[1].split('\n')) { const m = l.match(/^\s+-\s+(.+)$/); if (m) tags.push(m[1].trim()); }
  // instruction is a block scalar (|- or |); approximate its size by counting until the next top-level key
  const instrM = txt.match(/^instruction:\s*\|[-+]?\s*\n([\s\S]*?)(?=^\w[\w-]*:)/m);
  const instruction_chars = instrM ? instrM[1].replace(/\s+/g, ' ').trim().length : 0;
  return { difficulty: (scalar('difficulty') || 'unknown').toLowerCase(), category: scalar('category') || '', tags, instruction_chars };
}

function solutionBytes(taskDir) {
  for (const f of ['solution.sh', 'solution.yaml']) {
    const p = join(taskDir, f);
    if (existsSync(p)) return statSync(p).size;
  }
  return 0;
}

function main() {
  if (!existsSync(DATASET)) {
    console.error(`Dataset not found: ${DATASET}\nDownload it first: tb datasets download -d terminal-bench-core==0.1.1`);
    process.exit(1);
  }
  const taskDirs = readdirSync(DATASET, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(DATASET, e.name));

  const tasks = [];
  for (const dir of taskDirs) {
    const meta = readTaskMeta(dir);
    if (!meta) continue;
    tasks.push({
      task_id: basename(dir),
      difficulty: meta.difficulty,
      category: meta.category,
      tags: meta.tags,
      solution_bytes: solutionBytes(dir),
      instruction_chars: meta.instruction_chars,
    });
  }

  // hardest-first: difficulty primary, longer reference solution as the within-band tiebreak.
  tasks.sort((a, b) =>
    (DIFF_RANK[a.difficulty] ?? 3) - (DIFF_RANK[b.difficulty] ?? 3)
    || b.solution_bytes - a.solution_bytes
    || a.task_id.localeCompare(b.task_id));
  tasks.forEach((t, i) => { t.rank = i; });

  const byDifficulty = tasks.reduce((m, t) => { m[t.difficulty] = (m[t.difficulty] || 0) + 1; return m; }, {});
  const manifest = {
    dataset: 'terminal-bench-core',
    version: '0.1.1',
    dataset_path: DATASET,
    n: tasks.length,
    byDifficulty,
    generated: new Date().toISOString(),
    note: 'tasks[] sorted HARDEST-FIRST (difficulty then reference-solution bytes). rank = hardest-first index.',
    tasks,
  };
  writeFileSync(OUT, JSON.stringify(manifest, null, 2));
  console.log(`Wrote ${OUT}: ${tasks.length} tasks  ${JSON.stringify(byDifficulty)}`);
  console.log('Hardest 8:');
  for (const t of tasks.slice(0, 8)) console.log(`  #${t.rank} ${t.task_id}  [${t.difficulty}/${t.category}]  sol=${t.solution_bytes}B`);
}

main();
