import type { EngineeringGateEvidenceVerifier } from '@lnwjud/application';
import type { EngineeringGateEvidence, Result } from '@lnwjud/domain';

interface EngineeringEvidenceStatusProvider {
  statusForGoalLiveness(workspaceId: string, taskId: string): Result<unknown> | Promise<Result<unknown>>;
}

export interface RuntimeEngineeringEvidenceVerifierOptions {
  readonly process?: EngineeringEvidenceStatusProvider;
  readonly shell?: EngineeringEvidenceStatusProvider;
}

/**
 * Verifies a claimed host-observed gate against an actual host-owned task.
 * The caller still records the human-readable command in resumeContext, while
 * this verifier prevents a client/model from inventing a successful run ID.
 */
export class RuntimeEngineeringEvidenceVerifier implements EngineeringGateEvidenceVerifier {
  private readonly providers: readonly EngineeringEvidenceStatusProvider[];

  public constructor(options: RuntimeEngineeringEvidenceVerifierOptions) {
    this.providers = [options.process, options.shell]
      .filter((provider): provider is EngineeringEvidenceStatusProvider => provider !== undefined);
  }

  public async verify(workspaceId: string, evidence: EngineeringGateEvidence): Promise<boolean> {
    const runId = evidence.runId;
    if (runId === undefined || this.providers.length === 0) return false;
    const results = await Promise.all(this.providers.map(async (provider) => {
      try {
        return successfulObservation(await provider.statusForGoalLiveness(workspaceId, runId), evidence.exitCode);
      } catch {
        return false;
      }
    }));
    return results.some(Boolean);
  }
}

function successfulObservation(result: Result<unknown>, expectedExitCode: number | undefined): boolean {
  if (!result.ok || !isRecord(result.value) || typeof result.value.state !== 'string') return false;
  if (result.value.state !== 'completed' && result.value.state !== 'exited') return false;
  const actualExitCode = typeof result.value.exit_code === 'number'
    ? result.value.exit_code
    : typeof result.value.exitCode === 'number'
      ? result.value.exitCode
      : undefined;
  if (actualExitCode !== 0) return false;
  return expectedExitCode === undefined || expectedExitCode === actualExitCode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
