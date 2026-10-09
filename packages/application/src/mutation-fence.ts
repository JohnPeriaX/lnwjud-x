import { appError, err, ok, type Result } from '@lnwjud/domain';

export interface MutationFenceOptions {
  readonly signal?: AbortSignal | undefined;
}

/**
 * Process-local mutation fence shared by application services.
 *
 * Keys are canonical mutation targets. Multiple keys are acquired in sorted
 * order so multi-file mutations cannot deadlock. Authorization is deliberately
 * performed by the caller before entering the fence.
 */
export class MutationFence {
  private readonly tails = new Map<string, Promise<void>>();

  public async run<T>(
    keys: readonly string[],
    operation: () => Promise<Result<T>>,
    options: MutationFenceOptions = {},
  ): Promise<Result<T>> {
    const normalized = [...new Set(keys.filter((key) => key.length > 0))].sort();
    if (normalized.length === 0) return operation();

    const releases: Array<() => void> = [];
    try {
      for (const key of normalized) {
        const previous = this.tails.get(key);
        let release!: () => void;
        const current = new Promise<void>((resolve) => { release = resolve; });
        this.tails.set(key, current);
        releases.push(() => {
          if (this.tails.get(key) === current) this.tails.delete(key);
          release();
        });

        if (previous !== undefined) {
          if (options.signal?.aborted === true) return err(appError('PROCESS_TIMEOUT', 'Mutation was cancelled while waiting for a mutation fence', true));
          try {
            await waitForFence(previous, options.signal);
          } catch {
            return err(appError('PROCESS_TIMEOUT', 'Mutation was cancelled while waiting for a mutation fence', true));
          }
        }
      }

      if (options.signal?.aborted === true) {
        return err(appError('PROCESS_TIMEOUT', 'Mutation was cancelled before acquiring the mutation fence', true));
      }
      return await operation();
    } finally {
      for (const release of releases.reverse()) release();
    }
  }
}

export const applicationMutationFence = new MutationFence();

export function workspaceMutationKey(workspaceRoot: string): string {
  return `workspace:${canonicalKey(workspaceRoot)}`;
}

export function fileMutationKey(filePath: string): string {
  return `file:${canonicalKey(filePath)}`;
}

export function repositoryMutationKey(repositoryRoot: string): string {
  return workspaceMutationKey(repositoryRoot);
}

function canonicalKey(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

async function waitForFence(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) {
    await previous;
    return;
  }
  await Promise.race([
    previous,
    new Promise<never>((_, reject) => {
      if (signal.aborted) {
        reject(new Error('aborted'));
        return;
      }
      const onAbort = (): void => reject(new Error('aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
      void previous.finally(() => signal.removeEventListener('abort', onAbort));
    }),
  ]);
}
