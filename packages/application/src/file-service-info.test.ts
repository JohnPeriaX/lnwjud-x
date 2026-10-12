import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileService } from './file-service.js';
import { WorkspacePathGuard, type Workspace, type WorkspaceRepository } from '@lnwjud/workspace';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function repository(workspace: Workspace): WorkspaceRepository {
  return {
    async list(): Promise<Workspace[]> { return [workspace]; },
    async get(id: string): Promise<Workspace | null> { return id === workspace.id ? workspace : null; },
    async insert(): Promise<void> {},
    async delete(): Promise<void> {},
  };
}

const actor = { clientId: 'file-service-info-test', clientName: 'file service info test' };

describe('FileService.getFileInfo', () => {
  it('reports metadata for a file without returning any content', async () => {
    const rawRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-fileinfo-'));
    temporaryRoots.push(rawRoot);
    const root = await realpath(rawRoot);
    const workspace: Workspace = { id: 'workspace-1', displayName: 'Fixture', rootPath: root, realRootPath: root, createdAt: new Date(0).toISOString() };
    await writeFile(path.join(root, 'notes.txt'), 'hello world');

    const result = await new FileService(repository(workspace), new WorkspacePathGuard()).getFileInfo(actor, workspace.id, { path: 'notes.txt' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ path: 'notes.txt', isFile: true, isDirectory: false, isSymlink: false, sizeBytes: 11 });
    expect(result.value.absolutePath).toBe(path.join(root, 'notes.txt'));
    expect(Date.parse(result.value.modifiedAt)).not.toBeNaN();
    expect(result.value).not.toHaveProperty('content');
  });

  it('describes a directory as a directory', async () => {
    const rawRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-fileinfo-'));
    temporaryRoots.push(rawRoot);
    const root = await realpath(rawRoot);
    const workspace: Workspace = { id: 'workspace-1', displayName: 'Fixture', rootPath: root, realRootPath: root, createdAt: new Date(0).toISOString() };
    const nested = path.join(root, 'src');
    await mkdir(nested);

    const result = await new FileService(repository(workspace), new WorkspacePathGuard()).getFileInfo(actor, workspace.id, { path: 'src' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.isDirectory).toBe(true);
    expect(result.value.isFile).toBe(false);
  });

  it('refuses a missing target and a path that escapes the workspace', async () => {
    const rawRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-fileinfo-'));
    temporaryRoots.push(rawRoot);
    const root = await realpath(rawRoot);
    const workspace: Workspace = { id: 'workspace-1', displayName: 'Fixture', rootPath: root, realRootPath: root, createdAt: new Date(0).toISOString() };
    const service = new FileService(repository(workspace), new WorkspacePathGuard());

    expect(await service.getFileInfo(actor, workspace.id, { path: 'missing.txt' }))
      .toMatchObject({ ok: false, error: { code: 'FILE_NOT_FOUND' } });
    expect(await service.getFileInfo(actor, workspace.id, { path: '../outside.txt' }))
      .toMatchObject({ ok: false });
  });
});
