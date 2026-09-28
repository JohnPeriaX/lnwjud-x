import type { EngineeringGateEvidenceVerifier } from '@lnwjud/application';
import type { EngineeringGateEvidence, Result } from '@lnwjud/domain';
import { engineeringCommandFingerprint, formatEngineeringCommand } from '@lnwjud/shared';

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

  public async verify(workspaceId: string, evidence: EngineeringGateEvidence, gateId: string): Promise<boolean> {
    const runId = evidence.runId;
    // These gates need source SHA, target-host or artifact provenance from an
    // authoritative provider. A successful local process proves none of them.
    if (gateId === 'exact_sha_ci' || gateId === 'cross_platform' || gateId === 'package') return false;
    const command = evidence.command;
    if (runId === undefined || command === undefined || this.providers.length === 0) return false;
    const results = await Promise.all(this.providers.map(async (provider) => {
      try {
        return successfulObservation(await provider.statusForGoalLiveness(workspaceId, runId), command, evidence.exitCode);
      } catch {
        return false;
      }
    }));
    return results.some(Boolean);
  }
}

function successfulObservation(result: Result<unknown>, claimedCommand: string, expectedExitCode: number | undefined): boolean {
  if (!result.ok || !isRecord(result.value) || typeof result.value.state !== 'string') return false;
  if (result.value.state !== 'completed' && result.value.state !== 'exited') return false;
  const actualExitCode = typeof result.value.exit_code === 'number'
    ? result.value.exit_code
    : typeof result.value.exitCode === 'number'
      ? result.value.exitCode
      : undefined;
  if (actualExitCode !== 0) return false;
  const actualCommand = typeof result.value.executable === 'string' && Array.isArray(result.value.args) && result.value.args.every((arg) => typeof arg === 'string')
    ? formatEngineeringCommand(result.value.executable, result.value.args as string[])
    : typeof result.value.executable === 'string' && Array.isArray(result.value.arguments) && result.value.arguments.every((arg) => typeof arg === 'string')
      ? formatEngineeringCommand(result.value.executable, result.value.arguments as string[])
      : undefined;
  const matches = actualCommand === claimedCommand
    || result.value.command_fingerprint === engineeringCommandFingerprint(claimedCommand);
  if (!matches) return false;
  return expectedExitCode === undefined || expectedExitCode === actualExitCode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
