import { comparableHostPath, isHostPathWithin, type EphemeralWorkspaceRegistry, type Workspace, type WorkspaceRepository } from '@lnwjud/workspace';
import type { SqliteWorkspaceRepository } from './workspace-repository.js';

/**
 * Presents the runtime workspace view as stored projects plus the folders a call is working in
 * right now without becoming a project. Everything that resolves a path through this repository —
 * the locator, the path guard, search, git, office and file services — therefore agrees on one id
 * for one folder, while the durable registry and every management surface keep only what the user
 * actually opened. A stored registration always wins, so promoting an ephemeral folder to a project
 * needs no cleanup: the same root simply resolves through the stored row from then on.
 */
export class EphemeralWorkspaceRepository implements WorkspaceRepository {
  public constructor(
    private readonly inner: SqliteWorkspaceRepository,
    private readonly ephemeral: EphemeralWorkspaceRegistry,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  /** Runtime trust view: stored projects plus ephemeral folders that are not already covered. */
  public async list(): Promise<Workspace[]> {
    const stored = await this.inner.list();
    const covered = stored
      .map((workspace) => comparableHostPath(workspace.realRootPath, this.platform))
      .filter((root): root is string => root !== null);
    const extra = this.ephemeral.list().filter((workspace) => {
      const root = comparableHostPath(workspace.realRootPath, this.platform);
      if (root === null) return false;
      return !covered.some((storedRoot) => storedRoot === root || isHostPathWithin(storedRoot, root, this.platform));
    });
    return [...stored, ...extra];
  }

  /** Registered projects a caller can name: the durable rows, without ephemeral folders. */
  public async listDurable(): Promise<Workspace[]> {
    return this.inner.list();
  }

  /** Runtime lookup only. Ephemeral folders resolve here because no management surface owns them. */
  public async get(id: string): Promise<Workspace | null> {
    const stored = await this.inner.get(id);
    return stored ?? this.ephemeral.get(id);
  }

  public async insert(workspace: Workspace): Promise<void> {
    await this.inner.insert(workspace);
  }

  public async delete(id: string): Promise<void> {
    this.ephemeral.forget(id);
    await this.inner.delete(id);
  }

  /** Trusted management view including archived registrations: durable registrations only. */
  public async listAll(): Promise<Workspace[]> {
    return this.inner.listAll();
  }

  public async getAny(id: string): Promise<Workspace | null> {
    return this.inner.getAny(id);
  }

  public async archive(id: string, archivedAt?: string): Promise<void> {
    await this.inner.archive(id, archivedAt);
  }

  public async restore(id: string): Promise<void> {
    await this.inner.restore(id);
  }
}
