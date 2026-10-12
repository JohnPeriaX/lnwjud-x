import { describe, expect, it, vi } from 'vitest';
import { appError, err, ok } from '@lnwjud/domain';
import { permissionProfiles } from '@lnwjud/permissions';
import { ActivityTracker } from './activity-tracker.js';
import { ToolRegistry, type McpApplicationServices } from './tool-registry.js';

const actor = { clientId: 'client-1', clientName: 'test', sessionId: 'session-a' };

function activeFence(): ReturnType<typeof ok> {
  return ok({ goalId: 'goal-1', leaseGeneration: 2 });
}

describe('scheduled continuation mutation fence', () => {
  it('blocks file mutation without the current goalLease proof before the file handler executes', async (): Promise<void> => {
    const inspectWorkspaceFence = vi.fn().mockResolvedValue(activeFence());
    const writeFile = vi.fn().mockResolvedValue(ok({ path: 'src/file.ts', bytesWritten: 1 }));
    const services = {
      goalMutationFence: { inspectWorkspaceFence },
      file: { writeFile },
    } as unknown as McpApplicationServices;

    const response = await new ToolRegistry(services, actor).invoke('write_file', {
      workspaceId: 'workspace-1',
      path: 'src/file.ts',
      content: 'x',
    });

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({ error: { code: 'CONFLICT' } });
    expect(inspectWorkspaceFence).toHaveBeenCalledWith(actor, 'workspace-1');
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('blocks Git mutation without the current goalLease proof before the Git handler executes', async (): Promise<void> => {
    const inspectWorkspaceFence = vi.fn().mockResolvedValue(activeFence());
    const run = vi.fn().mockResolvedValue(ok({ exitCode: 0, stdout: '', stderr: '' }));
    const services = {
      goalMutationFence: { inspectWorkspaceFence },
      git: { run },
    } as unknown as McpApplicationServices;

    const response = await new ToolRegistry(services, actor).invoke('git', {
      workspaceId: 'workspace-1',
      args: ['add', 'src/file.ts'],
    });

    expect(response.isError).toBe(true);
    expect(inspectWorkspaceFence).toHaveBeenCalledWith(actor, 'workspace-1');
    expect(run).not.toHaveBeenCalled();
  });

  it('blocks process execution without the current goalLease proof before the process handler executes', async (): Promise<void> => {
    const inspectWorkspaceFence = vi.fn().mockResolvedValue(activeFence());
    const start = vi.fn().mockResolvedValue(ok({ processId: 'process-1' }));
    const services = {
      goalMutationFence: { inspectWorkspaceFence },
      process: { start },
    } as unknown as McpApplicationServices;

    const response = await new ToolRegistry(services, actor).invoke('process_start', {
      workspaceId: 'workspace-1',
      executable: 'node',
      args: ['--version'],
    });

    expect(response.isError).toBe(true);
    expect(inspectWorkspaceFence).toHaveBeenCalledWith(actor, 'workspace-1');
    expect(start).not.toHaveBeenCalled();
  });

  it('blocks detected project commands without the current goalLease proof before preview or process start', async (): Promise<void> => {
    const inspectWorkspaceFence = vi.fn().mockResolvedValue(activeFence());
    const previewProjectCommand = vi.fn().mockResolvedValue(ok({ executable: 'pnpm', args: ['build'] }));
    const startProjectCommand = vi.fn().mockResolvedValue(ok({ processId: 'process-project' }));
    const services = {
      goalMutationFence: { inspectWorkspaceFence },
      process: { previewProjectCommand, startProjectCommand },
    } as unknown as McpApplicationServices;

    const response = await new ToolRegistry(services, actor).invoke('project_build', {
      workspaceId: 'workspace-1',
      userConfirmed: true,
    });

    expect(response.isError).toBe(true);
    expect(inspectWorkspaceFence).toHaveBeenCalledWith(actor, 'workspace-1');
    expect(previewProjectCommand).not.toHaveBeenCalled();
    expect(startProjectCommand).not.toHaveBeenCalled();
  });

  it('blocks incremental verification without the current goalLease proof before it can launch a typecheck', async (): Promise<void> => {
    const inspectWorkspaceFence = vi.fn().mockResolvedValue(activeFence());
    const services = {
      goalMutationFence: { inspectWorkspaceFence },
    } as unknown as McpApplicationServices;

    const response = await new ToolRegistry(services, actor).invoke('verify_incremental', {
      workspaceId: 'workspace-1',
      userConfirmed: true,
    });

    expect(response.isError).toBe(true);
    expect(inspectWorkspaceFence).toHaveBeenCalledWith(actor, 'workspace-1');
  });

  it('blocks delegated Codex mutation without the current goalLease proof before the Codex backend executes', async (): Promise<void> => {
    const inspectWorkspaceFence = vi.fn().mockResolvedValue(activeFence());
    const run = vi.fn().mockResolvedValue(ok({ codexTaskId: 'codex-1' }));
    const services = {
      goalMutationFence: { inspectWorkspaceFence },
      codex: { run },
    } as unknown as McpApplicationServices;

    const response = await new ToolRegistry(services, actor, { codexToolsEnabled: true }).invoke('codex_run', {
      workspaceId: 'workspace-1',
      instruction: 'edit the project',
      userConfirmed: true,
    });

    expect(response.isError).toBe(true);
    expect(inspectWorkspaceFence).toHaveBeenCalledWith(actor, 'workspace-1');
    expect(run).not.toHaveBeenCalled();
  });

  it('blocks Computer Use mutation without the current goalLease proof before any capability executes', async (): Promise<void> => {
    const inspectWorkspaceFence = vi.fn().mockResolvedValue(activeFence());
    const execute = vi.fn().mockResolvedValue(ok({ clicked: true }));
    const services = {
      goalMutationFence: { inspectWorkspaceFence },
      capabilities: { execute },
    } as unknown as McpApplicationServices;

    const response = await new ToolRegistry(services, actor).invoke('computer_use', {
      workspaceId: 'workspace-1',
      action: 'click',
      target: { x: 10, y: 20 },
      userConfirmed: true,
    });

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({ error: { code: 'CONFLICT' } });
    expect(inspectWorkspaceFence).toHaveBeenCalledWith(actor, 'workspace-1');
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not fence read-only file access', async (): Promise<void> => {
    const inspectWorkspaceFence = vi.fn().mockResolvedValue(activeFence());
    const readFile = vi.fn().mockResolvedValue(ok({ path: 'src/file.ts', content: 'ok', startLine: 1, endLine: 1 }));
    const services = {
      goalMutationFence: { inspectWorkspaceFence },
      file: { readFile },
    } as unknown as McpApplicationServices;

    const response = await new ToolRegistry(services, actor).invoke('read_file', {
      workspaceId: 'workspace-1',
      path: 'src/file.ts',
    });

    expect(response.isError).not.toBe(true);
    expect(readFile).toHaveBeenCalled();
    expect(inspectWorkspaceFence).not.toHaveBeenCalled();
  });

  it('still requires the current goal lease when Full Bypass is active and a rolling fence exists', async (): Promise<void> => {
    const inspectWorkspaceFence = vi.fn().mockResolvedValue(activeFence());
    const writeFile = vi.fn().mockResolvedValue(ok({ path: 'src/file.ts', bytesWritten: 1 }));
    const services = {
      goalMutationFence: { inspectWorkspaceFence },
      file: { writeFile },
    } as unknown as McpApplicationServices;

    const response = await new ToolRegistry(services, actor, {
      profileProvider: (): typeof permissionProfiles.full => permissionProfiles.full,
      authorizationModeProvider: (): 'full_bypass' => 'full_bypass',
    }).invoke('write_file', {
      workspaceId: 'workspace-1',
      path: 'src/file.ts',
      content: 'x',
    });

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({ error: { code: 'CONFLICT' } });
    expect(inspectWorkspaceFence).toHaveBeenCalledWith(actor, 'workspace-1');
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('preserves ordinary Full Bypass mutation when no rolling goal fence exists', async (): Promise<void> => {
    const inspectWorkspaceFence = vi.fn().mockResolvedValue(ok(null));
    const writeFile = vi.fn().mockResolvedValue(ok({ path: 'src/file.ts', bytesWritten: 1 }));
    const services = {
      goalMutationFence: { inspectWorkspaceFence },
      file: { writeFile },
    } as unknown as McpApplicationServices;

    const response = await new ToolRegistry(services, actor, {
      profileProvider: (): typeof permissionProfiles.full => permissionProfiles.full,
      authorizationModeProvider: (): 'full_bypass' => 'full_bypass',
    }).invoke('write_file', {
      workspaceId: 'workspace-1',
      path: 'src/file.ts',
      content: 'x',
    });

    expect(response.isError).not.toBe(true);
    expect(inspectWorkspaceFence).toHaveBeenCalledWith(actor, 'workspace-1');
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale Full Bypass goal lease before the file handler executes', async (): Promise<void> => {
    const inspectWorkspaceFence = vi.fn().mockResolvedValue(activeFence());
    const begin = vi.fn().mockResolvedValue(err(appError('CONFLICT', 'Goal lease is no longer valid (stale generation); read the latest goal and reacquire or claim the scheduled continuation before retrying', true)));
    const writeFile = vi.fn().mockResolvedValue(ok({ path: 'src/file.ts', bytesWritten: 1 }));
    const services = {
      goalMutationFence: { inspectWorkspaceFence, begin },
      file: { writeFile },
    } as unknown as McpApplicationServices;

    const response = await new ToolRegistry(services, actor, {
      profileProvider: (): typeof permissionProfiles.full => permissionProfiles.full,
      authorizationModeProvider: (): 'full_bypass' => 'full_bypass',
    }).invoke('write_file', {
      workspaceId: 'workspace-1',
      path: 'src/file.ts',
      content: 'x',
      goalLease: { goalId: 'goal-1', leaseToken: 'stale-token', leaseGeneration: 1 },
    });

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({ error: { code: 'CONFLICT', recoverable: true } });
    expect(inspectWorkspaceFence).toHaveBeenCalledWith(actor, 'workspace-1');
    expect(begin).toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('runs an ordinary mutation in a second unfenced project even when the call carries another goal lease', async (): Promise<void> => {
    // The failure this prevents: a session holds a durable goal bound to project A, the user drops
    // an absolute path in project B, lnwjud attaches B, and the model sends A's lease because it
    // believes a lease is always required. B carries no rolling fence, so A's lease governs nothing
    // here and must neither authorize nor block the work.
    const inspectWorkspaceFence = vi.fn(async (): Promise<ReturnType<typeof ok>> => ok(null));
    const validateGoalLease = vi.fn(async (): Promise<ReturnType<typeof ok>> => ok({ workspaceId: 'workspace-a' }));
    const run = vi.fn(async (): Promise<ReturnType<typeof ok>> => ok({ exitCode: 0, stdout: '', stderr: '' }));
    const tracker = new ActivityTracker();
    const bindVerifiedGoal = vi.spyOn(tracker, 'bindVerifiedGoal');
    const services = {
      goalMutationFence: { inspectWorkspaceFence },
      goals: { validateGoalLease },
      git: { run },
    } as unknown as McpApplicationServices;

    const response = await new ToolRegistry(services, actor, { activityTracker: tracker }).invoke('git', {
      workspaceId: 'workspace-b',
      args: ['add', 'src/file.ts'],
      userConfirmed: true,
      goalLease: { goalId: 'goal-a', leaseToken: 'token-a', leaseGeneration: 3 },
    });

    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    expect(inspectWorkspaceFence).toHaveBeenCalledWith(actor, 'workspace-b');
    expect(run).toHaveBeenCalledTimes(1);
    // Ignoring a foreign lease also means not mislabelling this call as that goal's verified work.
    expect(bindVerifiedGoal).not.toHaveBeenCalled();
  });

  it('still refuses when the target workspace is fenced by a goal the supplied lease does not belong to', async (): Promise<void> => {
    const inspectWorkspaceFence = vi.fn(async (): Promise<ReturnType<typeof ok>> => ok({ goalId: 'goal-b', leaseGeneration: 9 }));
    const begin = vi.fn(async (): Promise<ReturnType<typeof err>> => err(appError('CONFLICT', 'Goal fence workspace does not match the request', true)));
    const run = vi.fn(async (): Promise<ReturnType<typeof ok>> => ok({ exitCode: 0, stdout: '', stderr: '' }));
    const services = {
      goalMutationFence: { inspectWorkspaceFence, begin },
      git: { run },
    } as unknown as McpApplicationServices;

    const response = await new ToolRegistry(services, actor, {
      profileProvider: (): typeof permissionProfiles.full => permissionProfiles.full,
      authorizationModeProvider: (): 'full_bypass' => 'full_bypass',
    }).invoke('git', {
      workspaceId: 'workspace-b',
      args: ['commit', '-m', 'x'],
      userConfirmed: true,
      goalLease: { goalId: 'goal-a', leaseToken: 'token-a', leaseGeneration: 3 },
    });

    expect(response.isError).toBe(true);
    expect(begin).toHaveBeenCalledWith(actor, 'workspace-b', expect.any(String), { goalId: 'goal-a', leaseToken: 'token-a', leaseGeneration: 3 });
    expect(run).not.toHaveBeenCalled();
  });

  it('fails closed on a foreign lease when the target fence state cannot be read, and names the retry', async (): Promise<void> => {
    // A host without a fence provider cannot prove the workspace is unfenced, so the refusal stays,
    // but it must state both working retries instead of the old bare "Goal lease workspace mismatch".
    const validateGoalLease = vi.fn(async (): Promise<ReturnType<typeof ok>> => ok({ workspaceId: 'workspace-a' }));
    const run = vi.fn(async (): Promise<ReturnType<typeof ok>> => ok({ exitCode: 0, stdout: '', stderr: '' }));
    const services = {
      goals: { validateGoalLease },
      git: { run },
    } as unknown as McpApplicationServices;

    const response = await new ToolRegistry(services, actor).invoke('git', {
      workspaceId: 'workspace-b',
      args: ['add', 'src/file.ts'],
      userConfirmed: true,
      goalLease: { goalId: 'goal-a', leaseToken: 'token-a', leaseGeneration: 3 },
    });

    expect(response.isError).toBe(true);
    const message = (response.structuredContent as { error: { message: string } }).error.message;
    expect(message).toContain('goal-a');
    expect(message).toContain('Retry without goalLease');
    expect(run).not.toHaveBeenCalled();
  });
});
