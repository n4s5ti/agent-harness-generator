// SPDX-License-Identifier: MIT
//
// Tests for the weightAdapter genome gene (the @metaharness/weight-eft typed
// spec). Defaults to base/no-adapter so a genome that never opts in is
// byte-identical (by key) to a pre-gene genome. The concrete darwin-mode
// evolve-config wiring is tested separately in darwin-mode's bench suite.

import { describe, it, expect } from 'vitest';
import {
  BASE_ADAPTER,
  WEIGHT_ADAPTERS,
  normalizeWeightAdapter,
  weightAdapterSuffix,
  weightAdapterFlags,
  usesAdapter,
} from '../src/genome.js';

describe('weightAdapter gene — defaults to base/no-adapter', () => {
  it('absent / empty / "base" / "none" all normalize to BASE (null)', () => {
    expect(normalizeWeightAdapter(undefined)).toBe(BASE_ADAPTER);
    expect(normalizeWeightAdapter(null)).toBe(BASE_ADAPTER);
    expect(normalizeWeightAdapter('')).toBe(BASE_ADAPTER);
    expect(normalizeWeightAdapter('base')).toBe(BASE_ADAPTER);
    expect(normalizeWeightAdapter('none')).toBe(BASE_ADAPTER);
    expect(normalizeWeightAdapter('BASE')).toBe(BASE_ADAPTER);
  });

  it('BASE contributes NO key suffix and NO CLI flag (byte-identical genome)', () => {
    expect(weightAdapterSuffix(BASE_ADAPTER)).toBe('');
    expect(weightAdapterSuffix(undefined as unknown as null)).toBe('');
    expect(weightAdapterFlags(BASE_ADAPTER)).toEqual([]);
    expect(usesAdapter(BASE_ADAPTER)).toBe(false);
  });

  it('the control (BASE) is always the first selectable adapter', () => {
    expect(WEIGHT_ADAPTERS[0]).toBe(BASE_ADAPTER);
    expect(WEIGHT_ADAPTERS).toContain('sft');
    expect(WEIGHT_ADAPTERS).toContain('sft-dpo');
  });
});

describe('weightAdapter gene — a selected adapter is distinct + wired', () => {
  it('a real adapter normalizes to its id and yields a stable suffix', () => {
    expect(normalizeWeightAdapter('sft')).toBe('sft');
    expect(weightAdapterSuffix('sft')).toBe('+w:sft');
    expect(weightAdapterSuffix('sft-dpo')).toBe('+w:sft-dpo');
    expect(usesAdapter('sft')).toBe(true);
  });

  it('a selected adapter forwards --lora-adapter to the cheap-tier solver', () => {
    expect(weightAdapterFlags('sft')).toEqual(['--lora-adapter', 'sft']);
    expect(weightAdapterFlags('sft-dpo')).toEqual(['--lora-adapter', 'sft-dpo']);
  });

  it('base vs adapter produce distinct suffixes (selection can tell them apart)', () => {
    expect(weightAdapterSuffix(BASE_ADAPTER)).not.toBe(weightAdapterSuffix('sft'));
  });
});
