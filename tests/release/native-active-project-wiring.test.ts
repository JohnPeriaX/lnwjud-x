import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(repositoryRoot, relativePath), 'utf8');
}

describe('path-bearing native Active Project wiring', () => {
  it('binds Desktop and stdio hosts to their host-owned Active Project providers', async () => {
    const desktop = await source('apps/desktop/src/main/desktop-services.ts');
    expect(desktop).toContain('activeWorkspaceScopeProvider: async (): Promise<WorkspaceScope | null> => {');
    expect(desktop).toContain('return selected === null ? null : { workspaceId: selected.id, rootPath: selected.realRootPath };');
    expect(desktop).toContain('externalProjectAttachProvider: attachExternalProjectScope,');

    const stdio = await source('apps/cli/src/runtime/stdio-mcp-runtime.ts');
    expect(stdio).toContain('activeWorkspaceScopeProvider: async (): Promise<WorkspaceScope> => ({ workspaceId: workspace.id, rootPath: workspace.realRootPath })');
    expect(stdio).toContain('if (strictRoots) return null;');
    const stdioEntry = await source('apps/cli/src/bin/mcp-stdio.ts');
    expect(stdioEntry).toContain('externalProjectAttachProvider: runtime.attachExternalProjectScope,');
  });

  it('injects the host Active Project root into every path-bearing native request', async () => {
    const registry = await source('packages/mcp-server/src/tool-registry.ts');
    expect(registry).toContain("const NATIVE_ACTIVE_SCOPE_TOOLS = new Set(['dom_cdp', 'office', 'audio', 'screen_record', ...OFFICE_SEMANTIC_TOOL_NAMES]);");
    expect(registry).toContain('const nativePathScopeRequired = requiresNativePathScope(tool.name, activeRoutedInput);');
    expect(registry).toContain('await this.routeInputToActiveWorkspace(goalBoundInput, {');
    expect(registry).toContain('const matched = commonActiveWorkspaceScope(scopes, absolutePaths);');
    expect(registry).toContain('const attached = await this.attachExternalProject(absolutePaths, context.toolName, context.autoAttachApproved);');
    expect(registry).toContain('[CAPABILITY_ACTIVE_WORKSPACE_ROOT_METADATA_KEY]: normalizedRoot');
    // Routing and the native scope fence must read one shared key list. A field that is scope-
    // enforced but never routable dead-ends a valid absolute path instead of attaching its folder.
    expect(registry).toContain("const NATIVE_PATH_SCOPE_KEYS = ['file_path', 'target_path', 'output_path', 'source_path', 'image_path'] as const;");
    expect(registry).toContain('for (const key of PATH_SCOPE_KEYS) {');
    expect(registry).toContain('for (const key of NATIVE_PATH_SCOPE_KEYS) {');
    const declaredKeys = /const PATH_SCOPE_KEYS = \[([\s\S]*?)\] as const;/.exec(registry)?.[1] ?? '';
    const nativeKeys = (/const NATIVE_PATH_SCOPE_KEYS = \[([^\]]*)\]/.exec(registry)?.[1] ?? '')
      .split(',').map((entry) => entry.trim().replace(/'/g, '')).filter((entry) => entry.length > 0);
    expect(nativeKeys.length).toBeGreaterThan(0);
    for (const key of nativeKeys) {
      expect(declaredKeys, `native path field ${key} is scope-enforced but not routable`).toContain(`'${key}'`);
    }
  });

  it('makes the host Active Project root override every fallback native root, including unrestricted mode', async () => {
    const backend = await source('packages/capabilities/src/windows-native-backend.ts');
    expect(backend).toContain('const activeWorkspaceRoot = readCapabilityActiveWorkspaceRoot(input);');
    expect(backend).toContain('configured = [activeWorkspaceRoot];');
    expect(backend).toContain('} else if (this.options.allowedRootsProvider !== undefined) {');
    expect(backend).not.toContain('if (this.options.unrestricted === true) return ok(undefined);');
  });
});
