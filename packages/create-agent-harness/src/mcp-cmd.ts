// SPDX-License-Identifier: MIT
//
// `harness mcp <ls|invoke>` subcommand.
//
// Surfaces the iter-10/13/34 MCP dispatch layer to the CLI:
//
//   harness mcp ls [path]
//     List MCP servers + tools declared in <path>/.mcp/servers.json.
//
//   harness mcp invoke <server> <tool> [--args=<json>] [path]
//     Dispatch a tool through the kernel's claim-checked dispatcher,
//     using the harness's local claim set. Prints the structured
//     outcome (result / denied / not-found / bad-args).
//
// The ToolDispatcher itself lives in @ruflo/kernel/dispatch.js (TS)
// + crates/kernel/src/dispatch.rs (Rust). This module is just the
// CLI surface that loads the harness's MCP config + claim set and
// hands them off.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type SubcommandResult = { code: number; lines: string[] };

interface McpServer {
  name: string;
  command: string | string[];
  description?: string;
  tools?: Array<{ name: string; description?: string }>;
}

interface McpConfig {
  mcpServers?: McpServer[];
}

async function readMcpConfig(harnessDir: string): Promise<McpConfig | null> {
  const path = join(harnessDir, '.mcp', 'servers.json');
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(await readFile(path, 'utf-8'));
    return Array.isArray(raw) ? { mcpServers: raw } : raw;
  } catch {
    return null;
  }
}

async function readClaims(harnessDir: string): Promise<Array<{ capability: string; resource?: string; expires_at: number }>> {
  const path = join(harnessDir, '.harness', 'claims.json');
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(await readFile(path, 'utf-8'));
    return Array.isArray(raw) ? raw : (raw.claims ?? []);
  } catch {
    return [];
  }
}

/** `harness mcp ls [path]` — list MCP servers + tools declared. */
export async function mcpLs(args: string[]): Promise<SubcommandResult> {
  const dir = resolve(args.find(a => !a.startsWith('--')) ?? process.cwd());
  const lines: string[] = [`harness mcp ls — ${dir}`];
  const cfg = await readMcpConfig(dir);
  if (!cfg) {
    lines.push('  no .mcp/servers.json present (scaffold with --mcp to add one)');
    return { code: 0, lines };
  }
  const servers = cfg.mcpServers ?? [];
  if (servers.length === 0) {
    lines.push('  .mcp/servers.json present but declares no servers');
    return { code: 0, lines };
  }
  for (const s of servers) {
    const cmd = Array.isArray(s.command) ? s.command.join(' ') : s.command;
    lines.push(`  ${s.name}`);
    if (s.description) lines.push(`    ${s.description}`);
    lines.push(`    command: ${cmd}`);
    if (Array.isArray(s.tools) && s.tools.length) {
      lines.push(`    tools:`);
      for (const t of s.tools) {
        lines.push(`      - ${t.name}${t.description ? ` — ${t.description}` : ''}`);
      }
    } else {
      lines.push(`    tools: <not declared statically; query the server at runtime>`);
    }
  }
  lines.push('', `${servers.length} MCP server${servers.length === 1 ? '' : 's'} declared.`);
  return { code: 0, lines };
}

/**
 * `harness mcp invoke <server> <tool> --args=<json> [path]` — dispatch
 * a tool through the kernel-style claim check and print the outcome.
 *
 * We re-use the TS ToolDispatcher here. For a real-world harness this
 * would talk to the actual MCP server over stdio/HTTP; the CLI command
 * is the same shape so users learn the dispatch model without bringing
 * up infrastructure.
 */
export async function mcpInvoke(args: string[]): Promise<SubcommandResult> {
  const positional = args.filter(a => !a.startsWith('--'));
  const [server, tool] = positional;
  if (!server || !tool) {
    return {
      code: 2,
      lines: ['Usage: harness mcp invoke <server> <tool> [--args=<json>] [path]'],
    };
  }
  const dir = resolve(positional[2] ?? process.cwd());
  const argsJson = args.find(a => a.startsWith('--args='))?.slice('--args='.length) ?? '{}';
  let argsObj: Record<string, unknown>;
  try {
    argsObj = JSON.parse(argsJson);
    if (typeof argsObj !== 'object' || Array.isArray(argsObj) || argsObj === null) {
      return { code: 2, lines: [`--args must be a JSON object`] };
    }
  } catch (e) {
    return { code: 2, lines: [`--args must be valid JSON: ${e instanceof Error ? e.message : e}`] };
  }

  const lines: string[] = [`harness mcp invoke ${server}/${tool}`];

  // Dynamically load the kernel-js dispatcher so the CLI doesn't pay
  // its import cost on every help/ls invocation.
  let DispatcherClass: any;
  try {
    const mod = await import('@ruflo/kernel/dispatch');
    DispatcherClass = (mod as any).ToolDispatcher;
  } catch (e) {
    return { code: 1, lines: [`failed to load dispatcher: ${e instanceof Error ? e.message : e}`] };
  }

  const dispatcher = new DispatcherClass();
  // For the CLI flow we don't have a real handler — we wire a no-op so
  // claim-denials surface but successes return a placeholder. The
  // structured outcome is the user-visible thing.
  dispatcher.register(server, tool, async (a: Record<string, unknown>) => ({
    note: 'CLI dispatch — no real handler bound; this confirms the CLAIMS layer authorises the call',
    echoArgs: a,
  }));

  const claims = await readClaims(dir);
  const outcome = await dispatcher.dispatch({ server, tool, args: argsObj, claims });

  lines.push(`  kind:   ${outcome.kind}`);
  if (outcome.kind === 'result') {
    lines.push(`  output: ${JSON.stringify(outcome.output)}`);
    return { code: 0, lines };
  }
  if (outcome.kind === 'denied') {
    lines.push(`  reason: ${outcome.reason}`);
    return { code: 1, lines };
  }
  if (outcome.kind === 'not-found') {
    lines.push(`  server/tool: ${outcome.server}/${outcome.tool} not registered`);
    return { code: 1, lines };
  }
  // bad-args
  lines.push(`  reason: ${outcome.reason}`);
  return { code: 2, lines };
}

/** Top-level dispatcher for `harness mcp <subsub> ...`. */
export async function mcpDispatch(args: string[]): Promise<SubcommandResult> {
  const [subsub = 'help', ...rest] = args;
  switch (subsub) {
    case 'ls':
      return mcpLs(rest);
    case 'invoke':
      return mcpInvoke(rest);
    case 'help':
      return {
        code: 0,
        lines: [
          'Usage: harness mcp <subcommand> [args]',
          '',
          'Subcommands:',
          '  ls [path]                                          — list MCP servers + tools',
          '  invoke <server> <tool> [--args=<json>] [path]      — dispatch one tool through the claim check',
          '',
          'Notes:',
          '  - `ls` reads <path>/.mcp/servers.json',
          '  - `invoke` reads <path>/.harness/claims.json for the local claim set',
          '  - The kernel dispatch surface is the same one tested in',
          '    __tests__/mcp-dispatch-integration.test.ts (iter 34)',
        ],
      };
    default:
      return {
        code: 2,
        lines: [`Unknown mcp subcommand: ${subsub}`, `Run 'harness mcp help' for usage.`],
      };
  }
}
