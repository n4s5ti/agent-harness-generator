// SPDX-License-Identifier: MIT
//
// iter 100 (MILESTONE) — tests for the interactive wizard.
//
// We use a scripted asker that returns canned answers in order, so
// the wizard runs deterministically without a TTY.

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '..');

let wiz: typeof import('../packages/create-agent-harness/dist/wizard.js');

beforeAll(async () => {
  const distPath = resolve(REPO_ROOT, 'packages', 'create-agent-harness', 'dist', 'wizard.js');
  if (!existsSync(distPath)) throw new Error('build first');
  wiz = await import(`file://${distPath}`);
});

function scriptedAsker(responses: string[]) {
  const queue = [...responses];
  return async (_prompt: string): Promise<string> => {
    if (queue.length === 0) throw new Error('asker ran out of scripted responses');
    return queue.shift() as string;
  };
}

const CATALOG = {
  templates: [
    { id: 'minimal', name: 'Minimal' },
    { id: 'vertical:coding', name: 'Advanced Coding' },
    { id: 'vertical:education', name: 'Education / Tutoring' },
  ],
  hosts: ['claude-code', 'codex', 'pi-dev', 'hermes', 'openclaw', 'rvm'] as const,
};

describe('runWizard (iter 100)', () => {
  it('happy path: name → template by number → host by number → description', async () => {
    const ask = scriptedAsker([
      'my-coding-bot',
      '2',
      '2',
      'A coding pod',
    ]);
    const answers = await wiz.runWizard(CATALOG, ask);
    expect(answers).toEqual({
      name: 'my-coding-bot',
      template: 'vertical:coding',
      host: 'codex',
      description: 'A coding pod',
    });
  });

  it('template can also be picked by pasted id', async () => {
    const ask = scriptedAsker([
      'edu-bot',
      'vertical:education',
      '1',
      '',
    ]);
    const answers = await wiz.runWizard(CATALOG, ask);
    expect(answers.template).toBe('vertical:education');
    expect(answers.host).toBe('claude-code');
    expect(answers.description).toBe('edu-bot — an AI agent harness');
  });

  it('host defaults to claude-code on empty Enter', async () => {
    const ask = scriptedAsker(['def-bot', '1', '', '']);
    const answers = await wiz.runWizard(CATALOG, ask);
    expect(answers.host).toBe('claude-code');
  });

  it('re-prompts on invalid name then accepts a valid one', async () => {
    const ask = scriptedAsker([
      'BAD NAME',
      'my-bot',
      '1',
      '1',
      '',
    ]);
    const answers = await wiz.runWizard(CATALOG, ask);
    expect(answers.name).toBe('my-bot');
  });

  it('re-prompts on out-of-range template, then accepts valid number', async () => {
    const ask = scriptedAsker([
      'bot1',
      '99',
      '1',
      '1',
      '',
    ]);
    const answers = await wiz.runWizard(CATALOG, ask);
    expect(answers.template).toBe('minimal');
  });

  it('answersToInvocation builds a copy-pasteable npx command', () => {
    const inv = wiz.answersToInvocation({
      name: 'my-bot',
      template: 'vertical:coding',
      host: 'codex',
      description: 'A coding pod',
    });
    expect(inv).toBe('npx create-agent-harness my-bot --template vertical:coding --host codex --description "A coding pod"');
  });

  it('answersToInvocation omits defaults (minimal + claude-code)', () => {
    const inv = wiz.answersToInvocation({
      name: 'my-bot',
      template: 'minimal',
      host: 'claude-code',
      description: 'A bot',
    });
    expect(inv).toBe('npx create-agent-harness my-bot --description "A bot"');
  });
});
