import { type InvocationAuthorization, type Result } from '@lnwjud/domain';
import { TreeReader, type TreeOptions, type TreeResult } from '@lnwjud/filesystem';
import { WorkspacePathGuard, type WorkspaceRepository } from '@lnwjud/workspace';
import type { FileActor } from './file-service.js';
import { resolveWorkspaceForPath } from './workspace-locator.js';

export interface TreeRequest extends TreeOptions {
  readonly path?: string;
}

export class WorkspaceQueryService {
  public constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly guard: WorkspacePathGuard = new WorkspacePathGuard(),
    private readonly treeReader: TreeReader = new TreeReader(),
  ) {}

  public async tree(
    actor: FileActor,
    workspaceId: string | undefined,
    request: TreeRequest = {},
    authorization?: InvocationAuthorization,
  ): Promise<Result<TreeResult>> {
    void actor;
    const hintPath = request.path ?? '.';
    // The guard owns the host read-trust. Reusing it here keeps workspace_tree and read_file from
    // reaching opposite verdicts on the same explicit absolute path.
    const { platform, externalReadRoots, allowExplicitAbsoluteRead } = this.guard.readTrust;
    const workspace = await resolveWorkspaceForPath(this.workspaces, workspaceId, hintPath, authorization, platform, externalReadRoots, allowExplicitAbsoluteRead);
    if (!workspace.ok) return workspace;
    const resolved = await this.guard.resolveForRead(workspace.value, hintPath, authorization);
    if (!resolved.ok) return resolved;
    return this.treeReader.read(resolved.value.realPath ?? resolved.value.absolutePath, request);
  }
}
