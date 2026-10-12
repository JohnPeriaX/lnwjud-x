import { describe, expect, it } from 'vitest';
import { ok } from '@lnwjud/domain';
import { permissionProfiles, type PermissionProfile, type PermissionProfileName } from '@lnwjud/permissions';
import { DEFAULT_DESTRUCTIVE_AUTO_APPROVAL_POLICY, type DestructiveAutoApprovalPolicy } from '@lnwjud/shared';
import {
  ToolRegistry,
  type ExternalProjectAttachRequest,
  type McpApplicationServices,
  type WorkspaceScope,
} from './tool-registry.js';

const actor = { clientId: 'external-project-attach-test', clientName: 'external project attach test' };
const activeScope: WorkspaceScope = { workspaceId: 'workspace-a', rootPath: 'E:\\project-a' };
const attachedScope: WorkspaceScope = { workspaceId: 'workspace-b', rootPath: 'E:\\Script\\World-NextX' };

interface FileCall {
  readonly workspaceId: string | undefined;
  readonly path: string;
}

function fakeFileService(calls: FileCall[]): McpApplicationServices['file'] {
  return {
    async readFile(_actor: unknown, workspaceId: string | undefined, request: { path: string }): Promise<ReturnType<typeof ok>> {
      calls.push({ workspaceId, path: String(request.path) });
      return ok({ path: String(request.path), content: 'ok', encoding: 'utf8' });
    },
    async writeFile(_actor: unknown, workspaceId: string | undefined, request: { path: string }): Promise<ReturnType<typeof ok>> {
      calls.push({ workspaceId, path: String(request.path) });
      return ok({ path: String(request.path), bytesWritten: 1 });
    },
    async deleteFile(_actor: unknown, workspaceId: string | undefined, request: { path: string }): Promise<ReturnType<typeof ok>> {
      calls.push({ workspaceId, path: String(request.path) });
      return ok({ path: String(request.path), recoverable: true, recoveryId: 'recovery-1' });
    },
    async getFileInfo(_actor: unknown, workspaceId: string | undefined, request: { path: string }): Promise<ReturnType<typeof ok>> {
      calls.push({ workspaceId, path: String(request.path) });
      return ok({ path: String(request.path), isFile: true, isDirectory: false, isSymlink: false, sizeBytes: 1 });
    },
  } as unknown as McpApplicationServices['file'];
}

function compose(options: {
  readonly attach?: (request: ExternalProjectAttachRequest) => WorkspaceScope | null;
  readonly fullBypass?: boolean;
  readonly profileName?: PermissionProfileName;
  readonly autoApproveDelete?: boolean;
} = {}): { readonly registry: ToolRegistry; readonly calls: FileCall[]; readonly gitCalls: string[]; readonly attachCalls: ExternalProjectAttachRequest[] } {
  const calls: FileCall[] = [];
  const gitCalls: string[] = [];
  const attachCalls: ExternalProjectAttachRequest[] = [];
  const profileName = options.profileName ?? 'balanced';
  const registry = new ToolRegistry({
    file: fakeFileService(calls),
    git: {
      async status(_actor: unknown, workspaceId: string): Promise<ReturnType<typeof ok>> {
        gitCalls.push(workspaceId);
        return ok({ entries: [] });
      },
    } as unknown as McpApplicationServices['git'],
    workspaceInfo: {
      async info(_actor: unknown, workspaceId: string): Promise<ReturnType<typeof ok>> {
        return workspaceId === attachedScope.workspaceId
          ? ok({ id: attachedScope.workspaceId, displayName: 'World-NextX', realRootPath: attachedScope.rootPath, rootPath: attachedScope.rootPath })
          : ok({ ok: false });
      },
    } as unknown as McpApplicationServices['workspaceInfo'],
  }, actor, {
    profileProvider: (): PermissionProfile => permissionProfiles[profileName],
    ...(options.autoApproveDelete === true ? {
      destructivePolicyProvider: (): DestructiveAutoApprovalPolicy => ({
        ...DEFAULT_DESTRUCTIVE_AUTO_APPROVAL_POLICY,
        approvals: { ...DEFAULT_DESTRUCTIVE_AUTO_APPROVAL_POLICY.approvals, delete_file: true },
      }),
    } : {}),
    activeWorkspaceScopesProvider: async (): Promise<readonly WorkspaceScope[]> => [activeScope],
    ...(options.fullBypass === true
      ? { authorizationModeProvider: (): 'full_bypass' => 'full_bypass' }
      : {}),
    ...(options.attach === undefined ? {} : {
      externalProjectAttachProvider: (request: ExternalProjectAttachRequest): WorkspaceScope | null => {
        attachCalls.push(request);
        return options.attach!(request);
      },
    }),
  });
  return { registry, calls, gitCalls, attachCalls };
}

describe('external project attach boundary', () => {
  it('attaches an unregistered absolute path for a read without asking', async () => {
    const { registry, calls, attachCalls } = compose({ attach: () => attachedScope });

    const response = await registry.invoke('read_file', { path: `${attachedScope.rootPath}\\README.md` });

    expect(response.isError).not.toBe(true);
    expect(attachCalls).toEqual([{ path: `${attachedScope.rootPath}\\README.md`, toolName: 'read_file', approve: true }]);
    expect(calls).toEqual([{ workspaceId: attachedScope.workspaceId, path: `${attachedScope.rootPath}\\README.md` }]);
  });

  it('asks once before mutating a folder that is not an Active Project, then proceeds when confirmed', async () => {
    const pendingScope: WorkspaceScope = { ...attachedScope, requiresProjectApproval: true };
    const { registry, calls, attachCalls } = compose({
      attach: (request) => (request.approve ? attachedScope : pendingScope),
    });
    const input = { path: `${attachedScope.rootPath}\\src\\index.ts`, content: 'export const a = 1;' };

    const unconfirmed = await registry.invoke('write_file', input);

    expect(unconfirmed).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
    expect(String((unconfirmed.structuredContent as { error?: { message?: string } }).error?.message)).toContain(attachedScope.rootPath);
    expect(calls).toHaveLength(0);

    const confirmed = await registry.invoke('write_file', { ...input, userConfirmed: true });

    expect(confirmed.isError).not.toBe(true);
    expect(attachCalls.map((entry) => entry.approve)).toEqual([false, true]);
    expect(calls.at(-1)).toEqual({ workspaceId: attachedScope.workspaceId, path: input.path });
  });

  it('never calls the attach provider for a path already inside an Active Project', async () => {
    const { registry, calls, attachCalls } = compose({ attach: () => attachedScope });

    const response = await registry.invoke('write_file', { path: `${activeScope.rootPath}\\notes.txt`, content: 'ok', userConfirmed: true });

    expect(response.isError).not.toBe(true);
    expect(attachCalls).toHaveLength(0);
    expect(calls).toEqual([{ workspaceId: activeScope.workspaceId, path: `${activeScope.rootPath}\\notes.txt` }]);
  });

  it('keeps the original Active Project denial when the host refuses to attach', async () => {
    const { registry, calls } = compose({ attach: () => null });

    const response = await registry.invoke('write_file', { path: `${attachedScope.rootPath}\\notes.txt`, content: 'ok', userConfirmed: true });

    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
    expect(calls).toHaveLength(0);
  });

  it('collapses a multi-path call to its shared prefix instead of picking one side', async () => {
    const { registry, attachCalls } = compose({ attach: () => attachedScope });

    await registry.invoke('read_files', { files: [{ path: 'E:\\project-a\\a.txt' }, { path: 'E:\\other\\b.txt' }] });

    expect(attachCalls).toHaveLength(1);
    expect(attachCalls[0]?.path).toBe('E:\\');
  });

  it('does not let a saved destructive-family switch skip the first confirmation in a new folder', async () => {
    const pendingScope: WorkspaceScope = { ...attachedScope, requiresProjectApproval: true };
    const { registry, calls } = compose({
      attach: (request) => (request.approve ? attachedScope : pendingScope),
      autoApproveDelete: true,
    });

    const response = await registry.invoke('delete_file', { path: `${attachedScope.rootPath}\\tmp.txt` });

    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
    expect(calls).toHaveLength(0);
  });

  it('attaches a remembered workspaceId that is registered but no longer an Active Project', async () => {
    const { registry, calls, attachCalls } = compose({ attach: () => attachedScope });

    const response = await registry.invoke('write_file', { workspaceId: attachedScope.workspaceId, path: 'notes.txt', content: 'ok', userConfirmed: true });

    expect(response.isError).not.toBe(true);
    expect(attachCalls).toEqual([{ path: attachedScope.rootPath, toolName: 'write_file', approve: true }]);
    expect(calls).toEqual([{ workspaceId: attachedScope.workspaceId, path: 'notes.txt' }]);
  });

  it('routes a native office path field so it cannot be enforced without being attachable', async () => {
    const { registry, attachCalls } = compose({ attach: () => attachedScope });

    const response = await registry.invoke('office_powerpoint', {
      action: 'add_image',
      file_path: 'deck.pptx',
      image_path: `${attachedScope.rootPath}\\logo.png`,
      slide: 1,
      userConfirmed: true,
    });

    expect(attachCalls.map((entry) => entry.path)).toEqual([`${attachedScope.rootPath}\\logo.png`]);
    expect(response).not.toMatchObject({ structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
  });

  it('names a working retry when a scope denial survives, instead of implying manual registration', async () => {
    const { registry, attachCalls } = compose({ attach: () => null });

    const noTarget = await registry.invoke('write_file', { path: 'notes.txt', content: 'ok', userConfirmed: true });
    expect(noTarget).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
    const noTargetMessage = String((noTarget.structuredContent as { error?: { message?: string } }).error?.message);
    expect(noTargetMessage).toContain('absolute path');
    expect(noTargetMessage).toContain(activeScope.rootPath);

    const staleTarget = await registry.invoke('write_file', { workspaceId: attachedScope.workspaceId, path: 'notes.txt', content: 'ok', userConfirmed: true });
    expect(staleTarget).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
    expect(String((staleTarget.structuredContent as { error?: { message?: string } }).error?.message)).toContain(attachedScope.workspaceId);
    expect(attachCalls.map((entry) => entry.path)).toEqual([attachedScope.rootPath]);
  });

  it.each([
    ['inspect_pdf', { file: `${attachedScope.rootPath}\\report.pdf` }, `${attachedScope.rootPath}\\report.pdf`],
    ['get_file_info', { path: `${attachedScope.rootPath}\\report.pdf` }, `${attachedScope.rootPath}\\report.pdf`],
    ['compare_pdf_pages', { baseline_path: `${attachedScope.rootPath}\\a.pdf`, actual_path: `${attachedScope.rootPath}\\b.pdf` }, attachedScope.rootPath],
    ['lsp_diagnostics', { files: [`${attachedScope.rootPath}\\src\\main.ts`] }, `${attachedScope.rootPath}\\src\\main.ts`],
    ['git_worktree_spawn', { worktreePath: `${attachedScope.rootPath}\\.worktrees\\agent-1`, dryRun: true }, `${attachedScope.rootPath}\\.worktrees\\agent-1`],
  ] as const)('routes the absolute path carried by %s instead of reporting an unregistered workspace', async (tool, input, expectedPath) => {
    const { registry, attachCalls } = compose({ attach: () => attachedScope });

    const response = await registry.invoke(tool, input);

    expect(attachCalls.map((entry) => entry.path)).toEqual([expectedPath]);
    expect(response).not.toMatchObject({ structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
  });

  it('attaches a new folder with no prompt at all under the Full Access profile', async () => {
    const pendingScope: WorkspaceScope = { ...attachedScope, requiresProjectApproval: true };
    const { registry, calls, attachCalls } = compose({
      profileName: 'full',
      attach: (request) => (request.approve ? attachedScope : pendingScope),
    });

    const response = await registry.invoke('write_file', { path: `${attachedScope.rootPath}\\notes.txt`, content: 'ok' });

    expect(response.isError).not.toBe(true);
    expect(attachCalls).toEqual([{ path: `${attachedScope.rootPath}\\notes.txt`, toolName: 'write_file', approve: true }]);
    expect(calls).toEqual([{ workspaceId: attachedScope.workspaceId, path: `${attachedScope.rootPath}\\notes.txt` }]);
  });

  it('attaches without a chat confirmation under Full Bypass', async () => {
    const pendingScope: WorkspaceScope = { ...attachedScope, requiresProjectApproval: true };
    const { registry, calls } = compose({ profileName: 'full', attach: () => pendingScope, fullBypass: true });

    const response = await registry.invoke('write_file', { path: `${attachedScope.rootPath}\\notes.txt`, content: 'ok' });

    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    expect(calls).toEqual([{ workspaceId: attachedScope.workspaceId, path: `${attachedScope.rootPath}\\notes.txt` }]);
  });

  it('runs git_status against a folder named only by absolute path', async () => {
    const { registry, gitCalls, attachCalls } = compose({ attach: () => attachedScope });

    const response = await registry.invoke('git_status', { cwd: `${attachedScope.rootPath}\\src` });

    expect(response.isError).not.toBe(true);
    expect(attachCalls.map((entry) => entry.path)).toEqual([`${attachedScope.rootPath}\\src`]);
    expect(gitCalls).toEqual([attachedScope.workspaceId]);
  });

  it('tells git_status how to name a project when neither cwd nor workspaceId was given', async () => {
    const { registry, gitCalls } = compose({ attach: () => attachedScope });

    const response = await registry.invoke('git_status', {});

    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_INPUT' } } });
    expect(String((response.structuredContent as { error?: { message?: string } }).error?.message)).toContain('cwd');
    expect(gitCalls).toHaveLength(0);
  });
});
