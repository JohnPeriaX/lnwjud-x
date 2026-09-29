import type { EngineeringGateEvidenceVerifier } from '@lnwjud/application';
import type { EngineeringGateEvidence, Result } from '@lnwjud/domain';
import { engineeringCommandFingerprint, formatEngineeringCommand } from '@lnwjud/shared';

interface EngineeringEvidenceStatusProvider {
  statusForGoalLiveness(workspaceId: string, taskId: string): Result<unknown> | Promise<Result<unknown>>;
}

export interface EngineeringSourceState {
  readonly commit: string;
  readonly clean: boolean;
}

interface EngineeringGitCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
}

type EngineeringGitRunner = (
  workspaceId: string,
  args: readonly string[],
) => Result<EngineeringGitCommandResult> | Promise<Result<EngineeringGitCommandResult>>;

export function createEngineeringSourceStateProvider(runGit: EngineeringGitRunner): (workspaceId: string) => Promise<EngineeringSourceState | undefined> {
  return async (workspaceId: string): Promise<EngineeringSourceState | undefined> => {
    try {
      const [commitResult, statusResult] = await Promise.all([
        runGit(workspaceId, ['rev-parse', 'HEAD']),
        runGit(workspaceId, ['status', '--porcelain=v1', '--untracked-files=no']),
      ]);
      if (!commitResult.ok || !statusResult.ok || commitResult.value.exitCode !== 0 || statusResult.value.exitCode !== 0) return undefined;
      const commit = commitResult.value.stdout.trim();
      if (!/^[0-9a-f]{40}$/i.test(commit)) return undefined;
      return { commit, clean: statusResult.value.stdout.trim().length === 0 };
    } catch {
      return undefined;
    }
  };
}

export interface RuntimeEngineeringEvidenceVerifierOptions {
  readonly process?: EngineeringEvidenceStatusProvider;
  readonly shell?: EngineeringEvidenceStatusProvider;
  readonly sourceState?: (workspaceId: string) => Promise<EngineeringSourceState | undefined>;
}

/**
 * Verifies a claimed host-observed gate against an actual host-owned task.
 * The caller still records the human-readable command in resumeContext, while
 * this verifier prevents a client/model from inventing a successful run ID.
 */
export class RuntimeEngineeringEvidenceVerifier implements EngineeringGateEvidenceVerifier {
  private readonly providers: readonly EngineeringEvidenceStatusProvider[];
  private readonly sourceState: RuntimeEngineeringEvidenceVerifierOptions['sourceState'];

  public constructor(options: RuntimeEngineeringEvidenceVerifierOptions) {
    this.providers = [options.process, options.shell]
      .filter((provider): provider is EngineeringEvidenceStatusProvider => provider !== undefined);
    this.sourceState = options.sourceState;
  }

  public async verify(workspaceId: string, evidence: EngineeringGateEvidence, gateId: string): Promise<boolean> {
    const runId = evidence.runId;
    const command = evidence.command;
    if (runId === undefined || command === undefined || this.providers.length === 0 || gateId === 'cross_platform') return false;
    if ((gateId === 'exact_sha_ci' || gateId === 'package') && !(await this.matchesCurrentTrackedSource(workspaceId, evidence))) return false;
    const results = await Promise.all(this.providers.map(async (provider) => {
      try {
        const result = await provider.statusForGoalLiveness(workspaceId, runId);
        if (!successfulObservation(result, command, evidence.exitCode)) return false;
        if (gateId === 'exact_sha_ci') return exactShaCiObservation(result, evidence);
        if (gateId === 'package') return packageObservation(result, evidence);
        return true;
      } catch {
        return false;
      }
    }));
    return results.some(Boolean);
  }

  private async matchesCurrentTrackedSource(workspaceId: string, evidence: EngineeringGateEvidence): Promise<boolean> {
    if (this.sourceState === undefined || typeof evidence.commit !== 'string' || !/^[0-9a-f]{40}$/i.test(evidence.commit)) return false;
    try {
      const current = await this.sourceState(workspaceId);
      return current !== undefined
        && current.clean
        && /^[0-9a-f]{40}$/i.test(current.commit)
        && current.commit.toLowerCase() === evidence.commit.toLowerCase();
    } catch {
      return false;
    }
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

function exactShaCiObservation(result: Result<unknown>, evidence: EngineeringGateEvidence): boolean {
  if (!result.ok || !isRecord(result.value) || !isCanonicalCommand(result.value, /^gh(?:\.exe)?$/i, ['run', 'view'], ['--json', 'headSha,status,conclusion'])) return false;
  if (typeof evidence.commit !== 'string' || !/^[0-9a-f]{40}$/i.test(evidence.commit) || evidence.conclusion !== 'success') return false;
  if (typeof result.value.stdout !== 'string') return false;
  try {
    const output: unknown = JSON.parse(result.value.stdout.trim());
    return isRecord(output)
      && output.status === 'completed'
      && output.conclusion === 'success'
      && typeof output.headSha === 'string'
      && output.headSha.toLowerCase() === evidence.commit.toLowerCase();
  } catch {
    return false;
  }
}

function packageObservation(result: Result<unknown>, evidence: EngineeringGateEvidence): boolean {
  if (!result.ok || !isRecord(result.value) || !isCanonicalCommand(result.value, /^node(?:\.exe)?$/i, [], ['apps/desktop/scripts/verify-release-evidence.mjs'])) return false;
  if (typeof evidence.commit !== 'string' || !/^[0-9a-f]{40}$/i.test(evidence.commit) || typeof evidence.artifact !== 'string' || evidence.artifact.length === 0) return false;
  if (typeof result.value.stdout !== 'string') return false;
  const match = /Release evidence verified for lnwjud (\S+) (win32|darwin|linux)\/(x64|arm64) commit ([0-9a-f]{40})/i.exec(result.value.stdout);
  if (match?.[4]?.toLowerCase() !== evidence.commit.toLowerCase()) return false;
  const artifactName = evidence.artifact.replace(/\\/g, '/').split('/').at(-1);
  const expectedNames = packageArtifactNames(match[2]?.toLowerCase(), match[1], match[3]?.toLowerCase());
  const normalizedArtifact = evidence.artifact.replace(/\\/g, '/');
  return artifactName !== undefined
    && expectedNames.includes(artifactName)
    && normalizedArtifact.endsWith(`apps/desktop/dist/installers/${artifactName}`);
}

function packageArtifactNames(platform: string | undefined, version: string | undefined, arch: string | undefined): readonly string[] {
  if (version === undefined || (arch !== 'x64' && arch !== 'arm64')) return [];
  if (platform === 'win32') return [`lnwjud-Setup-${version}.exe`, `lnwjud-Portable-${version}.exe`];
  if (platform === 'darwin') return [`lnwjud-${version}-${arch}.dmg`, `lnwjud-${version}-${arch}.zip`];
  if (platform === 'linux') return [`lnwjud-${version}-${arch}.AppImage`, `lnwjud-${version}-${arch}.deb`];
  return [];
}

function isCanonicalCommand(record: Record<string, unknown>, executablePattern: RegExp, prefixArgs: readonly string[], suffixArgs: readonly string[]): boolean {
  if (typeof record.executable !== 'string' || !executablePattern.test(record.executable.split(/[\\/]/).at(-1) ?? '')) return false;
  let args: string[];
  if (Array.isArray(record.arguments) && record.arguments.every((arg) => typeof arg === 'string')) args = record.arguments as string[];
  else if (Array.isArray(record.args) && record.args.every((arg) => typeof arg === 'string')) args = record.args as string[];
  else return false;
  if (args.length !== prefixArgs.length + suffixArgs.length + (prefixArgs.length > 0 ? 1 : 0)) return false;
  if (!prefixArgs.every((arg, index) => args[index] === arg)) return false;
  if (prefixArgs.length > 0 && !/^\d+$/.test(args[prefixArgs.length] ?? '')) return false;
  return suffixArgs.every((arg, index) => args[args.length - suffixArgs.length + index] === arg);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
