import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolRegistry, type ExternalProjectAttachRequest, type WorkspaceScope } from '@lnwjud/mcp-server';
import { permissionProfiles, type PermissionProfile } from '@lnwjud/permissions';
import { createDesktopRuntime } from '../src/main/desktop-services.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Desktop external project attach', () => {
  it('activates an outside folder only once the call is approved and never moves the Primary Project', async () => {
    const rawData = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-attach-data-'));
    const primaryRaw = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-attach-primary-'));
    const outsideRaw = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-attach-outside-'));
    temporaryRoots.push(rawData, primaryRaw, outsideRaw);
    const dataRoot = await realpath(rawData);
    const primaryRoot = await realpath(primaryRaw);
    const outsideRoot = await realpath(outsideRaw);
    const runtime = createDesktopRuntime(dataRoot, { hostMutationApprovalProvider: async () => true });
    try {
      const primary = await runtime.services.addWorkspace({ rootPath: primaryRoot });
      await runtime.services.selectWorkspace({ workspaceId: primary.id });
      const target = path.join(outsideRoot, 'src', 'index.ts');
      const request = { path: target, toolName: 'write_file' };

      const pending = await runtime.attachExternalProjectScope({ ...request, approve: false });
      expect(pending).toMatchObject({ rootPath: outsideRoot, requiresProjectApproval: true });
      expect((await runtime.getActiveWorkspaceScopes()).map((scope) => scope.workspaceId)).toEqual([primary.id]);
      expect((await runtime.services.getDashboard()).selectedWorkspace?.id).toBe(primary.id);

      const approved = await runtime.attachExternalProjectScope({ ...request, approve: true });
      expect(approved?.workspaceId).toBe(pending?.workspaceId);
      expect(approved?.requiresProjectApproval).toBeUndefined();
      expect((await runtime.getActiveWorkspaceScopes()).map((scope) => scope.workspaceId)).toEqual([primary.id, approved?.workspaceId]);
      expect((await runtime.services.getDashboard()).selectedWorkspace?.id).toBe(primary.id);

      const again = await runtime.attachExternalProjectScope({ ...request, approve: true });
      expect(again?.workspaceId).toBe(approved?.workspaceId);
      expect(await runtime.attachExternalProjectScope({ path: path.parse(outsideRoot).root, toolName: 'write_file', approve: true })).toBeNull();
    } finally {
      await runtime.close();
    }
  }, 60_000);

  it('runs real file and metadata tools end to end on a folder that was never an Active Project', async () => {
    const rawData = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-e2e-attach-data-'));
    const primaryRaw = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-e2e-attach-primary-'));
    const outsideRaw = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-e2e-attach-outside-'));
    const siblingRaw = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-e2e-attach-sibling-'));
    temporaryRoots.push(rawData, primaryRaw, outsideRaw, siblingRaw);
    const dataRoot = await realpath(rawData);
    const primaryRoot = await realpath(primaryRaw);
    const outsideRoot = await realpath(outsideRaw);
    const siblingRoot = await realpath(siblingRaw);
    const runtime = createDesktopRuntime(dataRoot, { hostMutationApprovalProvider: async () => true });
    try {
      const primary = await runtime.services.addWorkspace({ rootPath: primaryRoot });
      await runtime.services.selectWorkspace({ workspaceId: primary.id });
      const registryFor = (profile: PermissionProfile): ToolRegistry => new ToolRegistry(runtime.mcpServices, runtime.mcpActor, {
        profileProvider: (): PermissionProfile => profile,
        activeWorkspaceScopesProvider: async (): Promise<readonly WorkspaceScope[]> => runtime.getActiveWorkspaceScopes(),
        externalProjectAttachProvider: async (request: ExternalProjectAttachRequest): Promise<WorkspaceScope | null> => runtime.attachExternalProjectScope(request),
        hostMutationApprovalProvider: async (): Promise<boolean> => true,
      });
      const target = path.join(outsideRoot, 'src', 'index.ts');
      const write = { path: target, content: 'export const attached = true;\n' };

      // A read is the first contact with a folder this chat has never named. Routing must attach
      // it silently and the service layer must then agree, with no workspaceId and no registration.
      const siblingTarget = path.join(siblingRoot, 'README.md');
      await writeFile(siblingTarget, '# sibling\n', 'utf8');
      const firstRead = await registryFor(permissionProfiles.full).invoke('read_file', { path: siblingTarget });
      expect(firstRead.isError, JSON.stringify(firstRead)).not.toBe(true);
      const firstTree = await registryFor(permissionProfiles.full).invoke('workspace_tree', { path: siblingRoot });
      expect(firstTree.isError, JSON.stringify(firstTree)).not.toBe(true);

      // A stricter profile asks once for a brand-new folder and writes nothing on the first pass.
      const asked = await registryFor(permissionProfiles.balanced).invoke('write_file', write);
      expect(asked).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
      expect(await stat(target).then(() => true, () => false)).toBe(false);

      // Full Access attaches with no prompt at all, which is the DesktopCommander parity contract.
      const confirmed = await registryFor(permissionProfiles.full).invoke('write_file', write);
      expect(confirmed.isError, JSON.stringify(confirmed)).not.toBe(true);
      expect(await readFile(target, 'utf8')).toContain('export const attached');

      // Everything after that is ordinary access: reads, metadata and tree navigation all take
      // the absolute path with no workspaceId, and none of them moves the Primary Project.
      // (search_text is deliberately not asserted here: it needs the packaged ripgrep runtime,
      // which a source checkout does not put on PATH, so it would make this test environmental.)
      const registry = registryFor(permissionProfiles.full);
      for (const [tool, input] of [
        ['read_file', { path: target }],
        ['read_files', { files: [{ path: target }] }],
        ['get_file_info', { path: target }],
        ['workspace_tree', { path: outsideRoot }],
      ] as const) {
        const response = await registry.invoke(tool, input);
        expect(response.isError, `${tool}: ${JSON.stringify(response)}`).not.toBe(true);
      }

      expect((await runtime.services.getDashboard()).selectedWorkspace?.id).toBe(primary.id);
      expect(await readFile(path.join(primaryRoot, 'src', 'index.ts'), 'utf8').then(() => true, () => false)).toBe(false);
    } finally {
      await runtime.close();
    }
  }, 120_000);

  it('never re-activates a project the user switched off in the Desktop UI', async () => {
    const rawData = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-attach-deactivate-data-'));
    const primaryRaw = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-attach-deactivate-primary-'));
    const turnedOffRaw = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-attach-deactivate-off-'));
    temporaryRoots.push(rawData, primaryRaw, turnedOffRaw);
    const runtime = createDesktopRuntime(await realpath(rawData), { hostMutationApprovalProvider: async () => true });
    try {
      const primary = await runtime.services.addWorkspace({ rootPath: await realpath(primaryRaw) });
      const turnedOff = await runtime.services.addWorkspace({ rootPath: await realpath(turnedOffRaw) });
      await runtime.services.setWorkspaceActive({ workspaceId: turnedOff.id, active: false });

      for (const approve of [true, false]) {
        expect(await runtime.attachExternalProjectScope({
          path: path.join(turnedOff.rootPath, 'notes.txt'), toolName: 'write_file', approve,
        })).toBeNull();
      }
      expect((await runtime.getActiveWorkspaceScopes()).map((scope) => scope.workspaceId)).toEqual([primary.id]);
    } finally {
      await runtime.close();
    }
  }, 60_000);
});
