// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { parseArgs } from '../src/index.js';
import { wireWasm, markWasmDirCommonjs } from '../src/with-wasm.js';

describe('--with-wasm (GH #25)', () => {
  it('parseArgs captures --with-wasm <path>', () => {
    const a = parseArgs(['mybot', '--with-wasm', './crates/foo']);
    expect(a.withWasm).toBe('./crates/foo');
    expect(a.name).toBe('mybot');
  });

  it('wireWasm fails gracefully when the crate path has no Cargo.toml', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ww-'));
    const r = wireWasm(dir, dir); // dir has no Cargo.toml
    expect(r.ok).toBe(false);
    expect(r.lines.join('\n')).toMatch(/no Cargo.toml/);
  });
});

describe('markWasmDirCommonjs (GH #21)', () => {
  it('forces type:commonjs and removes the wasm-pack .gitignore', () => {
    // simulate a `wasm-pack --target nodejs` output dir
    const out = mkdtempSync(join(tmpdir(), 'wasmdir-'));
    writeFileSync(join(out, 'package.json'), JSON.stringify({ name: 'foo_wasm', main: 'foo_wasm.js' }));
    writeFileSync(join(out, '.gitignore'), '*\n'); // wasm-pack drops this — would prune wasm/ from tarball
    writeFileSync(join(out, 'foo_wasm.js'), '// cjs shim using __dirname\n');

    const entry = markWasmDirCommonjs(out);

    const pkg = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'));
    expect(pkg.type).toBe('commonjs');          // the actual #21 fix: CJS under an ESM harness
    expect(entry).toBe('foo_wasm.js');           // returns wasm-pack's `main`
    expect(existsSync(join(out, '.gitignore'))).toBe(false); // removed so wasm/ publishes
  });

  it('defaults the entry to index.js when package.json has no main', () => {
    const out = mkdtempSync(join(tmpdir(), 'wasmdir2-'));
    writeFileSync(join(out, 'package.json'), JSON.stringify({ name: 'bar' }));
    expect(markWasmDirCommonjs(out)).toBe('index.js');
    expect(JSON.parse(readFileSync(join(out, 'package.json'), 'utf8')).type).toBe('commonjs');
  });
});
