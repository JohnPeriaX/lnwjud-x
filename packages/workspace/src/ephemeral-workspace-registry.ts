import { createHash } from 'node:crypto';
import { comparableHostPath, hostPathApi, resolveHostPath } from './filesystem-root.js';
import type { Workspace } from './workspace-types.js';
import type { WorkspaceRepository } from './workspace-service.js';

/**
 * An in-process registration for a folder a call explicitly named that must never become a stored
 * workspace. It exists so every surface that resolves a path through the workspace repository still
 * agrees on one id for the folder, while the durable registry, the Active Project set and the
 * Desktop project list keep only the projects the user actually opened.
 *
 * Entries are bounded and least-recently-used, and the id is derived from the canonical root, so the
 * same folder keeps one id for the life of the process instead of growing a new scope per call.
 */
export class EphemeralWorkspaceRegistry {
  private readonly entries = new Map<string, Workspace>();

  public constructor(
    private readonly limit: number = 128,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  /** Id for one root, or null when the value is not a native absolute path. */
  public idFor(rootPath: string): string | null {
    return ephemeralWorkspaceId(rootPath, this.platform);
  }

  public remember(input: { readonly displayName: string; readonly rootPath: string; readonly realRootPath: string }): Workspace | null {
    const key = this.key(input.realRootPath);
    if (key === null) return null;
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      // Refresh recency without churning the id or the recorded creation time.
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing;
    }
    const id = ephemeralWorkspaceId(input.realRootPath, this.platform);
    if (id === null) return null;
    const workspace: Workspace = {
      id,
      displayName: input.displayName,
      rootPath: input.rootPath,
      realRootPath: input.realRootPath,
      createdAt: new Date().toISOString(),
    };
    this.entries.set(key, workspace);
    while (this.entries.size > Math.max(1, this.limit)) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return workspace;
  }

  public get(id: string): Workspace | null {
    for (const workspace of this.entries.values()) {
      if (workspace.id === id) return workspace;
    }
    return null;
  }

  public list(): readonly Workspace[] {
    return [...this.entries.values()];
  }

  public forget(id: string): boolean {
    for (const [key, workspace] of this.entries) {
      if (workspace.id !== id) continue;
      this.entries.delete(key);
      return true;
    }
    return false;
  }

  public get size(): number {
    return this.entries.size;
  }

  private key(rootPath: string): string | null {
    return comparableHostPath(rootPath, this.platform);
  }
}

/** One stable id per canonical root, so a folder the user never named twice is not registered twice. */
export function ephemeralWorkspaceId(rootPath: string, platform: NodeJS.Platform = process.platform): string | null {
  const resolved = resolveHostPath(rootPath, platform);
  if (resolved === null) return null;
  const canonical = hostPathApi(platform).normalize(resolved).replace(/[\\/]+$/, '');
  const comparable = platform === 'win32' ? canonical.toLowerCase() : canonical;
  if (comparable.length === 0) return null;
  return `ephemeral-${createHash('sha256').update(comparable).digest('hex').slice(0, 24)}`;
}

/**
 * Durable registrations only.
 *
 * Discovery surfaces — the project list a chat reads before it decides what to open, and the Desktop
 * project switcher — should answer with the projects the user actually has, not with the folders one
 * call passed through. Path resolution still needs the ephemeral view, so this helper keeps the two
 * apart without every consumer having to know about the overlay.
 */
export function listDurableWorkspaces(repository: WorkspaceRepository): Promise<Workspace[]> {
  const durable = (repository as { listDurable?: () => Promise<Workspace[]> }).listDurable;
  return typeof durable === 'function' ? durable.call(repository) : repository.list();
}
