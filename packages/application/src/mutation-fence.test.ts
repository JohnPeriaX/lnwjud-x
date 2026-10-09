import { describe, expect, it } from 'vitest';
import { err, ok, type Result } from '@lnwjud/domain';
import { MutationFence, fileMutationKey, workspaceMutationKey } from './mutation-fence.js';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('MutationFence', () => {
  it('serializes the same target while allowing independent workspace targets to overlap', async () => {
    const fence = new MutationFence();
    let active = 0;
    let sameTargetActive = 0;
    let sameTargetMax = 0;
    let independentOverlap = false;
    const first = fence.run([workspaceMutationKey('workspace-a'), fileMutationKey('a.txt')], async (): Promise<Result<string>> => {
      active += 1;
      sameTargetActive += 1;
      sameTargetMax = Math.max(sameTargetMax, sameTargetActive);
      await delay(25);
      sameTargetActive -= 1;
      active -= 1;
      return ok('first');
    });
    const second = fence.run([workspaceMutationKey('workspace-a'), fileMutationKey('a.txt')], async (): Promise<Result<string>> => {
      sameTargetActive += 1;
      sameTargetMax = Math.max(sameTargetMax, sameTargetActive);
      active += 1;
      await delay(5);
      active -= 1;
      sameTargetActive -= 1;
      return ok('second');
    });
    const independent = fence.run([workspaceMutationKey('workspace-b'), fileMutationKey('b.txt')], async (): Promise<Result<string>> => {
      independentOverlap = active > 0;
      await delay(5);
      return ok('independent');
    });

    await expect(Promise.all([first, second, independent])).resolves.toEqual([
      { ok: true, value: 'first' },
      { ok: true, value: 'second' },
      { ok: true, value: 'independent' },
    ]);
    expect(sameTargetMax).toBe(1);
    expect(independentOverlap).toBe(true);
  });

  it('releases the fence after a failed operation', async () => {
    const fence = new MutationFence();
    const failed = await fence.run(['target'], async (): Promise<Result<void>> => err({ code: 'INTERNAL_ERROR', message: 'boom', recoverable: true }));
    expect(failed.ok).toBe(false);

    await expect(fence.run(['target'], async (): Promise<Result<string>> => ok('released')))
      .resolves.toEqual({ ok: true, value: 'released' });
  });

  it('releases queued keys when cancellation wins while waiting', async () => {
    const fence = new MutationFence();
    let release!: () => void;
    const blocker = fence.run(['target'], async (): Promise<Result<void>> => {
      await new Promise<void>((resolve) => { release = resolve; });
      return ok(undefined);
    });
    const controller = new AbortController();
    const cancelled = fence.run(['target'], async (): Promise<Result<void>> => ok(undefined), { signal: controller.signal });
    controller.abort();

    await expect(cancelled).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    release();
    await blocker;
    await expect(fence.run(['target'], async (): Promise<Result<string>> => ok('available')))
      .resolves.toEqual({ ok: true, value: 'available' });
  });
});
