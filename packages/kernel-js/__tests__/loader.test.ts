// SPDX-License-Identifier: MIT
//
// Loader + pure-JS fallback backend (ADR-002a §fallback). These tests pin the
// invariant that made every generated harness fail before: loadKernel() must
// ALWAYS resolve to a working backend, even with no native NAPI package and no
// wasm pkg/ present. On a plain CI host that means the js backend answers.

import { describe, it, expect } from 'vitest';
import { loadKernel } from '../src/index.js';

describe('loadKernel — always resolves a backend', () => {
  it('returns a backend with a non-empty version and a known kind', async () => {
    const kernel = await loadKernel();
    expect(['native', 'wasm', 'js']).toContain(kernel.backend);
    expect(typeof kernel.version()).toBe('string');
    expect(kernel.version().length).toBeGreaterThan(0);
  });

  it('kernelInfo reports version + git_sha + target', async () => {
    const info = (await loadKernel()).kernelInfo();
    expect(typeof info.version).toBe('string');
    expect(info.version.length).toBeGreaterThan(0);
    expect(typeof info.git_sha).toBe('string');
    expect(typeof info.target).toBe('string');
  });

  it('caches — repeated calls return the same instance', async () => {
    expect(await loadKernel()).toBe(await loadKernel());
  });
});

describe('mcpValidate — mirrors crates/kernel/src/mcp.rs::validate', () => {
  it('accepts a stdio (command) server', async () => {
    const k = await loadKernel();
    expect(k.mcpValidate(JSON.stringify({ name: 'x', command: ['node', 's.js'] }))).toBeNull();
  });

  it('accepts an http (url) server', async () => {
    const k = await loadKernel();
    expect(k.mcpValidate(JSON.stringify({ name: 'x', url: 'http://localhost:3000' }))).toBeNull();
  });

  it('rejects an empty server name', async () => {
    const k = await loadKernel();
    expect(k.mcpValidate(JSON.stringify({ name: '', command: ['x'] }))).toBe('server name is empty');
  });

  it('rejects both command and url (mutually exclusive)', async () => {
    const k = await loadKernel();
    expect(k.mcpValidate(JSON.stringify({ name: 'x', command: ['a'], url: 'http://y' }))).toBe(
      'command and url are mutually exclusive',
    );
  });

  it('rejects neither command nor url', async () => {
    const k = await loadKernel();
    expect(k.mcpValidate(JSON.stringify({ name: 'x' }))).toBe('either command or url must be set');
  });

  it('throws on unparseable spec json', async () => {
    const k = await loadKernel();
    expect(() => k.mcpValidate('{not json')).toThrow(/invalid spec json/);
  });
});
