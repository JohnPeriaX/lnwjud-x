import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceQueryService } from './workspace-query-service.js';
import { SecretPolicy, WorkspacePathGuard, type WorkspaceRepository, type Workspace } from '@lnwjud/workspace';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('WorkspaceQueryService', () => {
  it('returns a bounded tree for a registered workspace', async () => {
    const rawRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-query-'));
    temporaryRoots.push(rawRoot);
    const root = await realpath(rawRoot);
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src', 'index.ts'), 'export {};', 'utf8');
    const workspace: Workspace = { id: 'workspace-1', displayName: 'Fixture', rootPath: root, realRootPath: root, createdAt: new Date(0).toISOString() };
    const repository: WorkspaceRepository = {
      async list(): Promise<Workspace[]> { return [workspace]; },
      async get(id: string): Promise<Workspace | null> { return id === workspace.id ? workspace : null; },
      async insert(): Promise<void> {},
      async delete(): Promise<void> {},
    };

    const result = await new WorkspaceQueryService(repository).tree(
      { clientId: 'test', clientName: 'test' },
      workspace.id,
      { path: '.', maxDepth: 4, maxEntries: 20 },
    );

    expect(result).toMatchObject({ ok: true, value: { truncated: false } });
    if (result.ok) expect(result.value.entries.map((entry) => entry.path)).toEqual(['src', path.join('src', 'index.ts')]);
  });

  it('refuses an outside absolute path on the tree surface instead of borrowing the registered project', async () => {
    const projectRaw = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-query-project-'));
    const siblingRaw = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-query-sibling-'));
    temporaryRoots.push(projectRaw, siblingRaw);
    const projectRoot = await realpath(projectRaw);
    const siblingRoot = await realpath(siblingRaw);
    await writeFile(path.join(siblingRoot, 'notes.txt'), 'outside', 'utf8');
    const workspace: Workspace = { id: 'workspace-1', displayName: 'Fixture', rootPath: projectRoot, realRootPath: projectRoot, createdAt: new Date(0).toISOString() };
    const repository: WorkspaceRepository = {
      async list(): Promise<Workspace[]> { return [workspace]; },
      async get(id: string): Promise<Workspace | null> { return id === workspace.id ? workspace : null; },
      async insert(): Promise<void> {},
      async delete(): Promise<void> {},
    };
    const actor = { clientId: 'test', clientName: 'test' };

    // Fail closed remains the default: an untrusted host still refuses the outside directory.
    const refused = await new WorkspaceQueryService(repository).tree(actor, undefined, { path: siblingRoot });
    expect(refused).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });

    // A host that grants explicit absolute reads must still not report an unrelated project's tree.
    // The grant is honoured once the caller names the project the path is anchored to (workspaceId).
    const trusted = new WorkspaceQueryService(repository, new WorkspacePathGuard(new SecretPolicy(), {
      trustedWorkspaceAccess: true,
      allowExplicitAbsoluteRead: true,
    }));
    const unanchored = await trusted.tree(actor, undefined, { path: siblingRoot });
    expect(unanchored).toMatchObject({
      ok: false,
      error: { code: 'PATH_OUTSIDE_WORKSPACE', message: expect.stringContaining('not inside any registered project') },
    });
    const anchored = await trusted.tree(actor, workspace.id, { path: siblingRoot });
    expect(anchored).toMatchObject({ ok: true });
    if (anchored.ok) expect(anchored.value.entries.map((entry) => entry.path)).toContain('notes.txt');
  });
});
