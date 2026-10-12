import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

interface DivergenceMarker {
  readonly file: string;
  readonly contains: string;
}

interface DivergenceCustomization {
  readonly id: string;
  readonly summary: string;
  readonly markers: readonly DivergenceMarker[];
  readonly proofTests: readonly string[];
}

interface DivergenceRegistry {
  readonly upstreamRemote: string;
  readonly customizations: readonly DivergenceCustomization[];
}

async function readRegistry(): Promise<DivergenceRegistry> {
  return JSON.parse(await readFile(path.join(repositoryRoot, 'scripts', 'upstream-divergence.json'), 'utf8')) as DivergenceRegistry;
}

async function exists(relativePath: string): Promise<boolean> {
  try {
    await readFile(path.join(repositoryRoot, relativePath));
    return true;
  } catch {
    return false;
  }
}

/**
 * Merging https://github.com/engasnm111/lnwjud into this fork can delete lnwjud-x behaviour while
 * still producing a clean merge, because upstream simply does not have those lines. This test is the
 * loud half of the sync contract: every registered customization keeps a source marker and a proof
 * test, so a merge that silently drops one fails here instead of shipping.
 */
describe('upstream divergence registry', () => {
  it('registers every fork-only behavior with a unique id and real proof', async () => {
    const registry = await readRegistry();
    expect(registry.upstreamRemote).toBe('upstream');
    expect(registry.customizations.length).toBeGreaterThanOrEqual(6);

    const ids = registry.customizations.map((customization) => customization.id);
    expect(new Set(ids).size, 'duplicate customization id').toBe(ids.length);

    for (const customization of registry.customizations) {
      expect(customization.id).toMatch(/^[a-z][a-z0-9-]+$/);
      expect(customization.summary.length, `${customization.id} needs a summary a future merge can act on`).toBeGreaterThan(30);
      expect(customization.markers.length, `${customization.id} needs at least one source marker`).toBeGreaterThan(0);
      expect(customization.proofTests.length, `${customization.id} needs at least one proof test`).toBeGreaterThan(0);
    }
  });

  it('keeps every registered source marker present, so an upstream merge cannot drop it silently', async () => {
    const registry = await readRegistry();
    const contents = new Map<string, string>();

    for (const customization of registry.customizations) {
      for (const marker of customization.markers) {
        if (!contents.has(marker.file)) {
          const absolute = path.join(repositoryRoot, marker.file);
          contents.set(marker.file, await readFile(absolute, 'utf8').catch(() => {
            throw new Error(`Divergence marker file is missing: ${marker.file}`);
          }));
        }
        expect(
          contents.get(marker.file),
          `lnwjud-x customization "${customization.id}" is missing its marker "${marker.contains}" in ${marker.file}. `
          + 'An upstream merge most likely removed fork-only behavior; re-apply it before continuing. '
          + `Proof tests: ${customization.proofTests.join(', ')}`,
        ).toContain(marker.contains);
      }
    }
  });

  it('points each customization at proof tests that still exist', async () => {
    const registry = await readRegistry();
    for (const customization of registry.customizations) {
      for (const proofTest of customization.proofTests) {
        expect(await exists(proofTest), `"${customization.id}" is proven by ${proofTest}, which no longer exists`).toBe(true);
      }
    }
  });

  it('never classifies a behavior-critical file as auto-healable version noise', async () => {
    const registry = await readRegistry();
    const { isVersionSurfacePath, VERSION_SURFACE_PATHS } = await import(pathToFileURL(path.join(repositoryRoot, 'scripts', 'set-version.mjs')).href) as {
      isVersionSurfacePath: (relativePath: string) => boolean;
      VERSION_SURFACE_PATHS: readonly string[];
    };

    for (const customization of registry.customizations) {
      for (const marker of customization.markers) {
        expect(
          VERSION_SURFACE_PATHS.includes(marker.file),
          `${marker.file} carries fork-only behavior and must not be listed in VERSION_SURFACE_PATHS`,
        ).toBe(false);
      }
    }
    // The classifier itself stays honest about the noise it is used to auto-resolve.
    expect(isVersionSurfacePath('packages/mcp-server/package.json')).toBe(true);
    expect(isVersionSurfacePath('packages/mcp-server/src/tool-registry.ts')).toBe(false);
  });

  it('keeps the What\'s New registry free of duplicate version entries after a union merge', async () => {
    // release-notes.ts conflicts on almost every upstream sync because both sides append entries.
    // A union resolution that simply keeps both sides produces two objects for the same version:
    // it merges cleanly, type-checks, and then shows the wrong notes in-app. Cheap to assert,
    // invisible otherwise.
    const source = await readFile(
      path.join(repositoryRoot, 'apps/desktop/src/renderer/features/release-notes/release-notes.ts'),
      'utf8',
    );
    const versions = [...source.matchAll(/version:\s*'([^']+)'/g)].map((match) => match[1] ?? '');
    expect(versions.length).toBeGreaterThan(0);
    const duplicated = versions.filter((version, index) => versions.indexOf(version) !== index);
    expect([...new Set(duplicated)], 'duplicate version entries in the in-app What\'s New registry').toEqual([]);
  });
});
