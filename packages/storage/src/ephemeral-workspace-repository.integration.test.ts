import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EphemeralWorkspaceRegistry, type Workspace } from '@lnwjud/workspace';
import { EphemeralWorkspaceRepository } from './ephemeral-workspace-repository.js';
import { SqliteDatabase } from './database.js';
import { SqliteWorkspaceRepository } from './workspace-repository.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Windows syntax is pinned so the containment rules under test behave the same on every runner.
interface EphemeralRepositoryFixture {
  readonly database: SqliteDatabase;
  readonly ephemeral: EphemeralWorkspaceRegistry;
  readonly repository: EphemeralWorkspaceRepository;
  readonly stored: SqliteWorkspaceRepository;
}

async function openRepository(platform: NodeJS.Platform = 'win32'): Promise<EphemeralRepositoryFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-ephemeral-repo-'));
  temporaryRoots.push(root);
  const database = new SqliteDatabase(path.join(root, 'state.sqlite'));
  const stored = new SqliteWorkspaceRepository(database);
  const ephemeral = new EphemeralWorkspaceRegistry(8, platform);
  return {
    database,
    ephemeral,
    repository: new EphemeralWorkspaceRepository(stored, ephemeral, platform),
    stored,
  };
}

describe('EphemeralWorkspaceRepository', () => {
  it('adds ephemeral folders to the runtime view without touching the durable registry', async () => {
    const { repository, ephemeral, database, stored } = await openRepository();
    try {
      const project: Workspace = { id: 'stored-1', displayName: 'Project', rootPath: 'C:\\project', realRootPath: 'C:\\project', createdAt: new Date(0).toISOString() };
      await repository.insert(project);
      const remembered = ephemeral.remember({
        displayName: 'Claude',
        rootPath: 'C:\\Users\\me\\AppData\\Roaming\\Claude',
        realRootPath: 'C:\\Users\\me\\AppData\\Roaming\\Claude',
      });
      expect(remembered).not.toBeNull();

      await expect(repository.list()).resolves.toEqual([project, remembered]);
      await expect(repository.get(remembered?.id ?? '')).resolves.toEqual(remembered);
      // Management surfaces must still see only what the user registered.
      await expect(repository.listAll()).resolves.toEqual([project]);
      await expect(repository.getAny(remembered?.id ?? '')).resolves.toBeNull();
      await expect(stored.list()).resolves.toEqual([project]);
    } finally {
      database.close();
    }
  });

  it('lets a stored registration win over an ephemeral folder inside it', async () => {
    const { repository, ephemeral, database } = await openRepository();
    try {
      const project: Workspace = { id: 'stored-parent', displayName: 'Parent', rootPath: 'C:\\project', realRootPath: 'C:\\project', createdAt: new Date(0).toISOString() };
      await repository.insert(project);
      ephemeral.remember({ displayName: 'cache', rootPath: 'C:\\project\\cache', realRootPath: 'C:\\project\\cache' });

      await expect(repository.list()).resolves.toEqual([project]);
    } finally {
      database.close();
    }
  });

  it('forgets an ephemeral entry when a management surface deletes its id', async () => {
    const { repository, ephemeral, database } = await openRepository();
    try {
      const remembered = ephemeral.remember({ displayName: 'SDK', rootPath: 'C:\\Program Files\\Android', realRootPath: 'C:\\Program Files\\Android' });
      await expect(repository.list()).resolves.toHaveLength(1);
      await repository.delete(remembered?.id ?? '');
      expect(ephemeral.size).toBe(0);
      await expect(repository.list()).resolves.toEqual([]);
    } finally {
      database.close();
    }
  });

  it('restores the archived state of a stored row through the same id', async () => {
    const { repository, database } = await openRepository();
    try {
      const project: Workspace = { id: 'stored-archived', displayName: 'Old', rootPath: 'D:\\old', realRootPath: 'D:\\old', createdAt: new Date(0).toISOString() };
      await repository.insert(project);
      await repository.archive(project.id);
      await expect(repository.list()).resolves.toEqual([]);
      await repository.restore(project.id);
      await expect(repository.list()).resolves.toEqual([project]);
    } finally {
      database.close();
    }
  });
});
