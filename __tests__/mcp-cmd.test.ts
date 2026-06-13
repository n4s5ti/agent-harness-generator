// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mcpLs, mcpInvoke, mcpDispatch } from '../packages/create-agent-harness/src/mcp-cmd.js';

const FUTURE_UNIX = Math.floor(Date.now() / 1000) + 86_400;

async function makeMcpDir(opts: { servers?: any[]; claims?: any[] } = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ahg-mcp-'));
  if (opts.servers !== undefined) {
    await mkdir(join(dir, '.mcp'), { recursive: true });
    await writeFile(join(dir, '.mcp', 'servers.json'), JSON.stringify({ mcpServers: opts.servers }));
  }
  if (opts.claims !== undefined) {
    await mkdir(join(dir, '.harness'), { recursive: true });
    await writeFile(join(dir, '.harness', 'claims.json'), JSON.stringify(opts.claims));
  }
  return dir;
}

describe('harness mcp ls', () => {
  it('reports when .mcp/servers.json is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ahg-mcp-empty-'));
    try {
      const r = await mcpLs([dir]);
      expect(r.code).toBe(0);
      expect(r.lines.join('\n')).toMatch(/no \.mcp\/servers\.json/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('lists servers + tools when present', async () => {
    const dir = await makeMcpDir({
      servers: [
        {
          name: 'mem', command: ['npx', 'memory-server'],
          description: 'memory store',
          tools: [
            { name: 'store', description: 'write a memory' },
            { name: 'search' },
          ],
        },
        { name: 'eval', command: 'eval-server', tools: [] },
      ],
    });
    try {
      const r = await mcpLs([dir]);
      expect(r.code).toBe(0);
      const txt = r.lines.join('\n');
      expect(txt).toMatch(/mem/);
      expect(txt).toMatch(/memory store/);
      expect(txt).toMatch(/store — write a memory/);
      expect(txt).toMatch(/eval/);
      expect(txt).toMatch(/2 MCP servers declared/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('handles empty servers array gracefully', async () => {
    const dir = await makeMcpDir({ servers: [] });
    try {
      const r = await mcpLs([dir]);
      expect(r.code).toBe(0);
      expect(r.lines.join('\n')).toMatch(/declares no servers/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('harness mcp invoke', () => {
  it('exits 2 on missing positional args', async () => {
    const r = await mcpInvoke([]);
    expect(r.code).toBe(2);
    expect(r.lines[0]).toMatch(/Usage/);
  });

  it('exits 2 on invalid --args= JSON', async () => {
    const r = await mcpInvoke(['mem', 'store', '--args=not-json']);
    expect(r.code).toBe(2);
    expect(r.lines.join('\n')).toMatch(/valid JSON/);
  });

  it('exits 2 on array --args= (must be object)', async () => {
    const r = await mcpInvoke(['mem', 'store', '--args=[1,2]']);
    expect(r.code).toBe(2);
    expect(r.lines.join('\n')).toMatch(/must be a JSON object/);
  });

  it('claim authorising the call → kind=result, exit 0', async () => {
    const dir = await makeMcpDir({
      claims: [{ capability: 'tool.invoke.mem.store', expires_at: FUTURE_UNIX }],
    });
    try {
      const r = await mcpInvoke(['mem', 'store', '--args={"key":"foo"}', dir]);
      expect(r.code, r.lines.join('\n')).toBe(0);
      expect(r.lines.join('\n')).toMatch(/kind:\s+result/);
      expect(r.lines.join('\n')).toMatch(/echoArgs.*foo/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('no matching claim → kind=denied, exit 1', async () => {
    const dir = await makeMcpDir({
      claims: [{ capability: 'tool.invoke.OTHER.x', expires_at: FUTURE_UNIX }],
    });
    try {
      const r = await mcpInvoke(['mem', 'store', '--args={}', dir]);
      expect(r.code).toBe(1);
      expect(r.lines.join('\n')).toMatch(/kind:\s+denied/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('no .harness/claims.json defaults to empty claims (denied)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ahg-mcp-noclaims-'));
    try {
      const r = await mcpInvoke(['mem', 'store', '--args={}', dir]);
      expect(r.code).toBe(1);
      expect(r.lines.join('\n')).toMatch(/denied/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('mcpDispatch (top-level)', () => {
  it('help is exit 0 and references the iter-34 integration test', async () => {
    const r = await mcpDispatch(['help']);
    expect(r.code).toBe(0);
    expect(r.lines.join('\n')).toMatch(/mcp-dispatch-integration/);
  });

  it('unknown subsub returns exit 2 + help pointer', async () => {
    const r = await mcpDispatch(['nope']);
    expect(r.code).toBe(2);
    expect(r.lines.join('\n')).toMatch(/Unknown mcp subcommand/);
  });

  it('default (no args) shows help', async () => {
    const r = await mcpDispatch([]);
    expect(r.code).toBe(0);
  });
});
