// SPDX-License-Identifier: MIT
//
// iter 100 (MILESTONE) — interactive wizard for `npx create-agent-harness`.
//
// New users encountering the CLI for the first time don't yet know
// the 19 vertical IDs or the 6 host IDs. The arg-driven flow assumes
// they've already read the README. The wizard offers a 4-question
// pickable form:
//
//   1. Harness name (validated against validateHarnessName())
//   2. Template (numeric pick from the catalog)
//   3. Host (numeric pick from HOSTS)
//   4. One-line description
//
// All non-TTY environments error out immediately — there's no point
// running the wizard in CI; the arg-driven form is what CI should use.

import { createInterface } from 'node:readline';
import type { Interface } from 'node:readline';

export interface WizardAnswers {
  name: string;
  template: string;
  host: string;
  description: string;
}

interface WizardCatalogEntry {
  id: string;
  name: string;
  description?: string;
}

export interface WizardCatalog {
  templates: WizardCatalogEntry[];
  hosts: ReadonlyArray<string>;
}

// One canonical contract — we accept a question-asker so this module
// stays test-friendly. The default implementation reads from stdin
// via readline; the tests inject a deterministic asker.
export type Asker = (prompt: string) => Promise<string>;

export function makeReadlineAsker(): { ask: Asker; close: () => void } {
  const rl: Interface = createInterface({ input: process.stdin, output: process.stdout });
  const ask: Asker = (prompt) => new Promise((resolve) => rl.question(prompt, resolve));
  return { ask, close: () => rl.close() };
}

function validateName(raw: string): string | null {
  const name = raw.trim();
  if (!name) return 'Name cannot be empty.';
  // Kebab-case, lowercase, no leading number, no leading/trailing/double
  // hyphens, ≤ 214 chars (npm rule, mirrors validateHarnessName in
  // renderer.ts so the wizard's verdict is the same as the scaffolder's).
  if (name.length > 214) return 'Name must be ≤ 214 characters (npm rule).';
  if (!/^[a-z]/.test(name)) return 'Name must start with a lowercase letter (npm rule).';
  if (!/^[a-z0-9-]+$/.test(name)) return 'Name must be kebab-case (lowercase letters, digits, hyphens only).';
  if (/--/.test(name)) return 'Name cannot contain consecutive hyphens.';
  if (name.endsWith('-')) return 'Name cannot end with a hyphen.';
  return null;
}

/**
 * Run the wizard against a catalog + an asker. Returns the validated
 * answers ready to feed into scaffold().
 *
 * The wizard does NOT scaffold — it just collects answers. The caller
 * (the bin) decides whether to scaffold immediately or print the
 * equivalent CLI invocation for copy-pasting.
 */
export async function runWizard(catalog: WizardCatalog, ask: Asker): Promise<WizardAnswers> {
  // 1. Name (loop until valid)
  let name = '';
  while (true) {
    const raw = await ask('Harness name (kebab-case, e.g. my-coding-bot): ');
    const err = validateName(raw);
    if (err) {
      process.stderr.write(`  ${err}\n`);
      continue;
    }
    name = raw.trim();
    break;
  }

  // 2. Template
  process.stdout.write('\nAvailable templates:\n');
  catalog.templates.forEach((t, i) => {
    const lbl = t.name ? `${t.name} (${t.id})` : t.id;
    process.stdout.write(`  ${String(i + 1).padStart(2)}. ${lbl}\n`);
  });
  let template = '';
  while (true) {
    const raw = await ask(`\nPick a template (1-${catalog.templates.length}, or paste an id): `);
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) {
      const idx = Number(trimmed) - 1;
      if (idx >= 0 && idx < catalog.templates.length) {
        template = catalog.templates[idx].id;
        break;
      }
      process.stderr.write(`  Out of range (1-${catalog.templates.length}).\n`);
      continue;
    }
    const found = catalog.templates.find(t => t.id === trimmed);
    if (found) {
      template = found.id;
      break;
    }
    process.stderr.write(`  Unknown template: ${trimmed}\n`);
  }

  // 3. Host
  process.stdout.write('\nAvailable hosts:\n');
  catalog.hosts.forEach((h, i) => {
    process.stdout.write(`  ${String(i + 1).padStart(2)}. ${h}\n`);
  });
  let host = '';
  while (true) {
    const raw = await ask(`\nPick a host (1-${catalog.hosts.length}, or paste an id) [claude-code]: `);
    const trimmed = raw.trim();
    if (trimmed === '') {
      host = 'claude-code';
      break;
    }
    if (/^\d+$/.test(trimmed)) {
      const idx = Number(trimmed) - 1;
      if (idx >= 0 && idx < catalog.hosts.length) {
        host = catalog.hosts[idx];
        break;
      }
      process.stderr.write(`  Out of range (1-${catalog.hosts.length}).\n`);
      continue;
    }
    if (catalog.hosts.includes(trimmed)) {
      host = trimmed;
      break;
    }
    process.stderr.write(`  Unknown host: ${trimmed}\n`);
  }

  // 4. Description (optional)
  const descRaw = await ask('\nOne-line description (Enter to skip): ');
  const description = descRaw.trim() || `${name} — an AI agent harness`;

  return { name, template, host, description };
}

/**
 * Build the equivalent `npx create-agent-harness ...` invocation for
 * the answers. Useful for the "next time, you can skip the wizard with
 * this command:" hint we print after a successful scaffold.
 */
export function answersToInvocation(answers: WizardAnswers): string {
  const parts = ['npx create-agent-harness', answers.name];
  if (answers.template !== 'minimal') parts.push(`--template ${answers.template}`);
  if (answers.host !== 'claude-code') parts.push(`--host ${answers.host}`);
  if (answers.description) parts.push(`--description "${answers.description}"`);
  return parts.join(' ');
}
