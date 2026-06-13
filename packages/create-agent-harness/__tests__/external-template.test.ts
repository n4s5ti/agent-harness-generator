// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { loadExternalTemplate } from '../src/external-template.js';

describe('loadExternalTemplate', () => {
  it('throws on empty packageName', async () => {
    await expect(loadExternalTemplate('')).rejects.toThrow(/packageName/);
  });

  it('throws with actionable message on import failure', async () => {
    await expect(loadExternalTemplate('@ruflo/this-package-definitely-does-not-exist-12345'))
      .rejects.toThrow(/Did you forget to install it/);
  });
});
