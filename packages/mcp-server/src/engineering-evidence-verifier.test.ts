import { describe, expect, it, vi } from 'vitest';
import { appError, err, ok } from '@lnwjud/domain';
import { RuntimeEngineeringEvidenceVerifier } from './engineering-evidence-verifier.js';

describe('RuntimeEngineeringEvidenceVerifier', () => {
  it('accepts only an actual successful host task in the same workspace', async () => {
    const process = { statusForGoalLiveness: vi.fn(async () => err(appError('PROCESS_NOT_FOUND', 'missing'))) };
    const shell = { statusForGoalLiveness: vi.fn(async (_workspaceId: string, taskId: string) => taskId === 'task-ok'
      ? ok({ state: 'completed', exit_code: 0, executable: 'pnpm', arguments: ['test'] })
      : err(appError('PROCESS_NOT_FOUND', 'missing'))) };
    const verifier = new RuntimeEngineeringEvidenceVerifier({ process, shell });

    await expect(verifier.verify('workspace-1', {
      source: 'host_observed', observedAt: '2026-09-28T00:00:00Z', workspaceId: 'workspace-1',
      command: 'pnpm test', runId: 'task-ok', exitCode: 0,
    }, 'focused_validation')).resolves.toBe(true);
    await expect(verifier.verify('workspace-1', {
      source: 'host_observed', observedAt: '2026-09-28T00:00:00Z', workspaceId: 'workspace-1',
      command: 'pnpm test', runId: 'fabricated', exitCode: 0,
    }, 'focused_validation')).resolves.toBe(false);
    expect(shell.statusForGoalLiveness).toHaveBeenCalledWith('workspace-1', 'task-ok');
  });

  it('rejects failed, nonterminal, mismatched-exit, or missing run IDs', async () => {
    const shell = { statusForGoalLiveness: vi.fn(async (_workspaceId: string, taskId: string) => ok(
      taskId === 'failed' ? { state: 'failed', exit_code: 1 }
        : taskId === 'running' ? { state: 'running' }
          : { state: 'completed', exit_code: 0 },
    )) };
    const verifier = new RuntimeEngineeringEvidenceVerifier({ shell });
    const base = { source: 'host_observed' as const, observedAt: '2026-09-28T00:00:00Z', workspaceId: 'workspace-1', command: 'pnpm test' };

    await expect(verifier.verify('workspace-1', { ...base, runId: 'failed', exitCode: 1 }, 'focused_validation')).resolves.toBe(false);
    await expect(verifier.verify('workspace-1', { ...base, runId: 'running' }, 'focused_validation')).resolves.toBe(false);
    await expect(verifier.verify('workspace-1', { ...base, runId: 'ok', exitCode: 1 }, 'focused_validation')).resolves.toBe(false);
    await expect(verifier.verify('workspace-1', base, 'focused_validation')).resolves.toBe(false);
  });

  it('rejects an unrelated successful command and an observation without command identity', async () => {
    const shell = { statusForGoalLiveness: vi.fn(async (_workspaceId: string, taskId: string) => ok(
      taskId === 'unidentified'
        ? { state: 'completed', exit_code: 0 }
        : { state: 'completed', exit_code: 0, executable: 'echo', arguments: ['hello'] },
    )) };
    const verifier = new RuntimeEngineeringEvidenceVerifier({ shell });
    const evidence = { source: 'host_observed' as const, observedAt: '2026-09-28T00:00:00Z', workspaceId: 'workspace-1', command: 'pnpm test', exitCode: 0 };

    await expect(verifier.verify('workspace-1', { ...evidence, runId: 'unrelated' }, 'focused_validation')).resolves.toBe(false);
    await expect(verifier.verify('workspace-1', { ...evidence, runId: 'unidentified' }, 'focused_validation')).resolves.toBe(false);
  });

  it('does not treat a successful local command as hosted CI, target-platform, or package proof', async () => {
    const shell = { statusForGoalLiveness: vi.fn(async () => ok({ state: 'completed', exit_code: 0, executable: 'pnpm', arguments: ['test'] })) };
    const verifier = new RuntimeEngineeringEvidenceVerifier({ shell });
    const evidence = { source: 'host_observed' as const, observedAt: '2026-09-28T00:00:00Z', workspaceId: 'workspace-1', command: 'pnpm test', runId: 'task-ok', exitCode: 0 };
    for (const gateId of ['exact_sha_ci', 'cross_platform', 'package']) {
      await expect(verifier.verify('workspace-1', evidence, gateId)).resolves.toBe(false);
    }
    expect(shell.statusForGoalLiveness).not.toHaveBeenCalled();
  });
});
