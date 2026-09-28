import { describe, expect, it, vi } from 'vitest';
import { appError, err, ok } from '@lnwjud/domain';
import { RuntimeEngineeringEvidenceVerifier } from './engineering-evidence-verifier.js';

describe('RuntimeEngineeringEvidenceVerifier', () => {
  it('accepts only an actual successful host task in the same workspace', async () => {
    const process = { statusForGoalLiveness: vi.fn(async () => err(appError('PROCESS_NOT_FOUND', 'missing'))) };
    const shell = { statusForGoalLiveness: vi.fn(async (_workspaceId: string, taskId: string) => taskId === 'task-ok'
      ? ok({ state: 'completed', exit_code: 0 })
      : err(appError('PROCESS_NOT_FOUND', 'missing'))) };
    const verifier = new RuntimeEngineeringEvidenceVerifier({ process, shell });

    await expect(verifier.verify('workspace-1', {
      source: 'host_observed', observedAt: '2026-09-28T00:00:00Z', workspaceId: 'workspace-1',
      command: 'pnpm test', runId: 'task-ok', exitCode: 0,
    })).resolves.toBe(true);
    await expect(verifier.verify('workspace-1', {
      source: 'host_observed', observedAt: '2026-09-28T00:00:00Z', workspaceId: 'workspace-1',
      command: 'pnpm test', runId: 'fabricated', exitCode: 0,
    })).resolves.toBe(false);
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

    await expect(verifier.verify('workspace-1', { ...base, runId: 'failed', exitCode: 1 })).resolves.toBe(false);
    await expect(verifier.verify('workspace-1', { ...base, runId: 'running' })).resolves.toBe(false);
    await expect(verifier.verify('workspace-1', { ...base, runId: 'ok', exitCode: 1 })).resolves.toBe(false);
    await expect(verifier.verify('workspace-1', base)).resolves.toBe(false);
  });
});
