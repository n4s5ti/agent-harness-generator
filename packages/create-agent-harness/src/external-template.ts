// SPDX-License-Identifier: MIT
//
// External template loader.
//
// `create-agent-harness` ships with bundled templates (templates/minimal,
// templates/vertical_*). When the user passes `--template-package
// @ruflo/vertical-trading`, this loader resolves the npm package, calls
// its `.load()`, and returns the on-disk template root for the existing
// walker to consume.

export interface ExternalTemplate {
  manifest: { id: string; description: string };
  templateRoot: string;
}

export interface PackModule {
  load?(): Promise<ExternalTemplate>;
  default?: { load?(): Promise<ExternalTemplate> };
}

/**
 * Resolve an external template package. Returns the loaded template or
 * throws with a clear message.
 */
export async function loadExternalTemplate(packageName: string): Promise<ExternalTemplate> {
  if (!packageName || typeof packageName !== 'string') {
    throw new Error('loadExternalTemplate: packageName is required');
  }
  let mod: PackModule;
  try {
    mod = await import(packageName) as PackModule;
  } catch (err) {
    throw new Error(
      `Could not import external template package "${packageName}": ${err instanceof Error ? err.message : String(err)}\n` +
      `Did you forget to install it? Try: npm install ${packageName}`,
    );
  }
  const load = mod.load ?? mod.default?.load;
  if (typeof load !== 'function') {
    throw new Error(
      `"${packageName}" does not export a load() function. ` +
      `External template packages must export either { load } or default { load }.`,
    );
  }
  const result = await load();
  if (!result || !result.manifest || !result.templateRoot) {
    throw new Error(
      `"${packageName}" load() returned a malformed result. Expected { manifest, templateRoot }.`,
    );
  }
  return result;
}
