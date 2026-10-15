import { describe, expect, it } from 'vitest';
import { ok } from '@lnwjud/domain';
import { permissionProfiles, type PermissionProfile } from '@lnwjud/permissions';
import {
  ToolRegistry,
  type ExternalProjectAttachRequest,
  type McpApplicationServices,
  type WorkspaceScope,
} from './tool-registry.js';

/**
 * Covers the workspace target a caller names: an id that is really a folder path, a project's display
 * name, an id typed one character wrong, and an id that is registered but no longer an Active Project.
 * Every one of these used to end the call with WORKSPACE_NOT_FOUND or an unanswerable "not an Active
 * Project", and the retry repeated the same value.
 */

const actor = { clientId: 'workspace-id-routing-test', clientName: 'workspace id routing test' };
const activeScope: WorkspaceScope = { workspaceId: 'workspace-a', rootPath: 'E:\\project-a' };
const rememberedScope: WorkspaceScope = { workspaceId: 'workspace-b', rootPath: 'E:\\Script\\World-NextX' };
const gameScope: WorkspaceScope = { workspaceId: '15631bf2-70ca-4bf8-b9e4-923322c6c130', rootPath: 'C:\\Games\\NEWTHINGS\\bin\\newthings' };

interface GitCall { readonly workspaceId: string; }
interface FileCall { readonly workspaceId: string | undefined; readonly path: string; }
interface GoalCall { readonly workspaceId: string; readonly objective: string; }

function compose(options: {
  readonly attach?: (request: ExternalProjectAttachRequest) => WorkspaceScope | null;
  readonly profileName?: 'balanced' | 'full';
} = {}): {
  readonly registry: ToolRegistry;
  readonly gitCalls: GitCall[];
  readonly fileCalls: FileCall[];
  readonly goalCalls: GoalCall[];
  readonly attachCalls: ExternalProjectAttachRequest[];
} {
  const gitCalls: GitCall[] = [];
  const fileCalls: FileCall[] = [];
  const goalCalls: GoalCall[] = [];
  const attachCalls: ExternalProjectAttachRequest[] = [];
  const services: McpApplicationServices = {
    git: {
      async status(_actor: unknown, workspaceId: string): Promise<ReturnType<typeof ok>> {
        gitCalls.push({ workspaceId });
        return ok({ entries: [] });
      },
    } as unknown as McpApplicationServices['git'],
    file: {
      async readFile(_actor: unknown, workspaceId: string | undefined, request: { path: string }): Promise<ReturnType<typeof ok>> {
        fileCalls.push({ workspaceId, path: String(request.path) });
        return ok({ path: String(request.path), content: 'ok', encoding: 'utf8' });
      },
      async writeFile(_actor: unknown, workspaceId: string | undefined, request: { path: string }): Promise<ReturnType<typeof ok>> {
        fileCalls.push({ workspaceId, path: String(request.path) });
        return ok({ path: String(request.path), bytesWritten: 1 });
      },
    } as unknown as McpApplicationServices['file'],
    goals: {
      async runGoal(_actor: unknown, request: { workspaceId: string; objective: string }): Promise<ReturnType<typeof ok>> {
        goalCalls.push({ workspaceId: request.workspaceId, objective: request.objective });
        const now = new Date(0).toISOString();
        return ok({
          goalId: 'goal-1', goalKey: 'routing', workspaceId: request.workspaceId, objective: request.objective,
          status: 'active', revision: 0, currentPhase: 'start', plan: { steps: [] }, completedSteps: [], pendingSteps: [],
          nextAction: 'continue', blockers: [], activeTaskIds: [], lastCheckpoint: null, createdAt: now, updatedAt: now,
          leaseToken: 'lease', leaseExpiresAt: new Date(60_000).toISOString(), iterationCount: 0, continuation: null,
        });
      },
    } as unknown as McpApplicationServices['goals'],
    workspaceInfo: {
      async list(): Promise<ReturnType<typeof ok>> {
        return ok([
          { id: activeScope.workspaceId, displayName: 'project-a', rootPath: activeScope.rootPath, realRootPath: activeScope.rootPath },
          { id: rememberedScope.workspaceId, displayName: 'World-NextX', rootPath: rememberedScope.rootPath, realRootPath: rememberedScope.rootPath },
          { id: gameScope.workspaceId, displayName: 'newthings', rootPath: gameScope.rootPath, realRootPath: gameScope.rootPath },
        ]);
      },
      async info(_actor: unknown, workspaceId: string): Promise<ReturnType<typeof ok>> {
        const match = [activeScope, rememberedScope, gameScope].find((scope) => scope.workspaceId === workspaceId);
        return match === undefined
          ? ok({ error: { code: 'WORKSPACE_NOT_FOUND' } })
          : ok({ id: match.workspaceId, displayName: 'World-NextX', rootPath: match.rootPath, realRootPath: match.rootPath });
      },
    } as unknown as McpApplicationServices['workspaceInfo'],
  };
  const registry = new ToolRegistry(services, actor, {
    profileProvider: (): PermissionProfile => permissionProfiles[options.profileName ?? 'full'],
    activeWorkspaceScopesProvider: async (): Promise<readonly WorkspaceScope[]> => [activeScope],
    ...(options.attach === undefined ? {} : {
      externalProjectAttachProvider: (request: ExternalProjectAttachRequest): WorkspaceScope | null => {
        attachCalls.push(request);
        return options.attach!(request);
      },
    }),
  });
  return { registry, gitCalls, fileCalls, goalCalls, attachCalls };
}

function messageOf(response: { structuredContent?: unknown }): string {
  return String((response.structuredContent as { error?: { message?: string } }).error?.message);
}

describe('workspace target resolution in the tool registry', () => {
  it('routes a folder path typed into workspaceId to the project that owns it', async () => {
    const { registry, gitCalls } = compose();

    const response = await registry.invoke('git_status', { workspaceId: `${rememberedScope.rootPath}\\src` });

    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    expect(gitCalls).toEqual([{ workspaceId: rememberedScope.workspaceId }]);
  });

  it('resolves a uniquely named project when workspaceId carries its display name', async () => {
    const { registry, gitCalls } = compose();

    const response = await registry.invoke('git_status', { workspaceId: 'World-NextX' });

    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    expect(gitCalls).toEqual([{ workspaceId: rememberedScope.workspaceId }]);
  });

  it('attaches a path-shaped workspaceId for a folder that is not a project yet', async () => {
    const freshScope: WorkspaceScope = { workspaceId: 'workspace-c', rootPath: 'E:\\New folder\\Script\\SWEET-TOWN' };
    const { registry, gitCalls, attachCalls } = compose({ attach: () => freshScope });

    const response = await registry.invoke('git_status', { workspaceId: `${freshScope.rootPath}\\main.js` });

    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    expect(attachCalls.map((entry) => entry.path)).toEqual([`${freshScope.rootPath}\\main.js`]);
    expect(gitCalls).toEqual([{ workspaceId: freshScope.workspaceId }]);
  });

  it('refuses a path-shaped workspaceId the host cannot attach instead of picking some project', async () => {
    const { registry, gitCalls } = compose({ attach: () => null });

    const response = await registry.invoke('git_status', { workspaceId: 'E:\\nowhere\\path\\file.txt' });

    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_INPUT' } } });
    const message = messageOf(response);
    expect(message).toContain('is a folder path, not a project id');
    expect(message).toContain('Projects on this host');
    expect(gitCalls).toHaveLength(0);
  });

  it('passes a workspaceId the registry does not know straight to the tool instead of guessing a project', async () => {
    const { registry, gitCalls } = compose();
    const mistyped = '15631bf2-70ca-4bf2-b9e4-923322c6c130';

    const response = await registry.invoke('git_status', { workspaceId: mistyped });

    // A handle may belong to the tool rather than to a project, so resolution never rewrites it to
    // the nearest project. The value is what the service sees.
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    expect(gitCalls).toEqual([{ workspaceId: mistyped }]);
  });

  it('names the closest real project when a mistyped workspaceId blocks a mutation', async () => {
    const { registry, fileCalls } = compose();
    const mistyped = '15631bf2-70ca-4bf2-b9e4-923322c6c130';

    const response = await registry.invoke('write_file', { workspaceId: mistyped, path: 'notes.txt', content: 'ok', userConfirmed: true });

    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
    expect(fileCalls).toHaveLength(0);
    const message = messageOf(response);
    expect(message).toContain(mistyped);
    expect(message).toContain('The closest project is "newthings"');
    expect(message).toContain(gameScope.workspaceId);
    expect(message).toContain(gameScope.rootPath);
    expect(message).toContain(rememberedScope.rootPath);
  });

  it('keeps a remembered registered project usable for a goal tool through the attach path', async () => {
    const { registry, goalCalls, attachCalls } = compose({ attach: () => rememberedScope });

    const response = await registry.invoke('run_goal', {
      workspaceId: rememberedScope.workspaceId, goalKey: 'routing', objective: 'route the remembered project',
    });

    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    expect(attachCalls.map((entry) => entry.path)).toEqual([rememberedScope.rootPath]);
    expect(goalCalls).toEqual([{ workspaceId: rememberedScope.workspaceId, objective: 'route the remembered project' }]);
  });

  it('runs a shell call whose working directory belongs to another active project', async () => {
    const executed: Array<{ workspaceId: string | undefined; cwd: string | undefined }> = [];
    const registry = new ToolRegistry({
      capabilities: {
        async execute(_tool: string, input: Record<string, unknown>): Promise<ReturnType<typeof ok>> {
          executed.push({ workspaceId: input.workspaceId as string | undefined, cwd: input.cwd as string | undefined });
          return ok({ stdout: 'ok', stderr: '', exitCode: 0, durationMs: 1, signal: null, truncated: false });
        },
      },
      workspaceInfo: {
        async list(): Promise<ReturnType<typeof ok>> {
          return ok([{ id: 'workspace-a', rootPath: activeScope.rootPath, realRootPath: activeScope.rootPath }]);
        },
      } as unknown as McpApplicationServices['workspaceInfo'],
    } as unknown as McpApplicationServices, actor, {
      profileProvider: (): PermissionProfile => permissionProfiles.full,
      activeWorkspaceScopesProvider: async (): Promise<readonly WorkspaceScope[]> => [
        activeScope,
        { workspaceId: 'workspace-z', rootPath: 'E:\\other' },
      ],
    });

    const response = await registry.invoke('shell', {
      workspaceId: 'workspace-a', operation: 'run', executable: 'node', arguments: ['--version'], cwd: 'E:\\other',
    });

    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    // The working directory the caller named decides the project, and the reconciled id travels to
    // the executor instead of the stale id the call started with.
    expect(executed).toEqual([{ workspaceId: 'workspace-z', cwd: 'E:\\other' }]);
  });

  it('reads a file in an active project when workspaceId remembers a different one', async () => {
    const { registry, fileCalls } = compose();

    const response = await registry.invoke('read_file', {
      workspaceId: rememberedScope.workspaceId, path: `${activeScope.rootPath}\\notes.txt`,
    });

    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    expect(fileCalls).toEqual([{ workspaceId: activeScope.workspaceId, path: `${activeScope.rootPath}\\notes.txt` }]);
  });
});
