import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Workspace, WorkspaceRepository } from '@lnwjud/workspace';
import { resolveSharedWorkspace, resolveWorkspaceForPath } from './workspace-locator.js';

function repository(workspaces: readonly Workspace[]): WorkspaceRepository {
  return {
    async list(): Promise<Workspace[]> { return [...workspaces]; },
    async get(id: string): Promise<Workspace | null> { return workspaces.find((entry) => entry.id === id) ?? null; },
    async insert(): Promise<void> {},
    async delete(): Promise<void> {},
  };
}

describe('resolveWorkspaceForPath', () => {
  const drive: Workspace = {
    id: 'drive-c',
    displayName: 'C',
    rootPath: 'C:\\',
    realRootPath: 'C:\\',
    createdAt: new Date(0).toISOString(),
  };
  const nested: Workspace = {
    id: 'project',
    displayName: 'Project',
    rootPath: 'C:\\Users\\me\\proj',
    realRootPath: 'C:\\Users\\me\\proj',
    createdAt: new Date(0).toISOString(),
  };

  it('requires workspaceId for relative paths', async () => {
    const result = await resolveWorkspaceForPath(repository([drive]), undefined, 'src\\file.ts', undefined, 'win32');
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('picks the longest matching workspace for an absolute path', async () => {
    const result = await resolveWorkspaceForPath(
      repository([drive, nested]),
      undefined,
      'C:\\Users\\me\\proj\\docs\\plan.md',
      undefined, 'win32',
    );
    expect(result).toMatchObject({ ok: true, value: { id: 'project' } });
  });

  it('rejects an absolute path outside the given workspaceId', async () => {
    const result = await resolveWorkspaceForPath(
      repository([drive, nested]),
      nested.id,
      'C:\\Windows\\notepad.exe',
      undefined, 'win32',
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
  });

  it('keeps the explicit workspace as an audit anchor for an allowed external read root', async () => {
    const result = await resolveWorkspaceForPath(
      repository([drive, nested]),
      nested.id,
      'D:\\Shared\\Screenshots\\proof.png',
      undefined,
      'win32',
      ['D:\\Shared\\Screenshots'],
    );
    expect(result).toMatchObject({ ok: true, value: { id: 'project' } });
  });

  it('keeps the explicit workspace as an audit anchor for an outside absolute path under Full Bypass', async () => {
    const result = await resolveWorkspaceForPath(
      repository([drive, nested]),
      nested.id,
      'D:\\outside\\proof.txt',
      { mode: 'full_bypass', applicationApproved: true, bypassApplicationAuthorization: true, source: 'full_bypass' },
      'win32',
    );
    expect(result).toMatchObject({ ok: true, value: { id: 'project' } });
  });

  it('refuses an absolute path outside every registered project instead of borrowing the first one', async () => {
    const result = await resolveWorkspaceForPath(
      repository([drive, nested]),
      undefined,
      'D:\\Elsewhere\\report.md',
      undefined,
      'win32',
      [],
      true,
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
    if (result.ok) throw new Error('A path that belongs to no project must never resolve to a project');
    expect(result.error.message).toContain('D:\\Elsewhere\\report.md');
    expect(result.error.message).toContain('is not inside any registered project');
    expect(result.error.message).toContain(path.win32.join('C:', 'Users', 'me', 'proj'));
  });

  it('refuses an unmatched absolute path under Full Bypass without naming an unrelated project', async () => {
    const result = await resolveWorkspaceForPath(
      repository([nested, drive]),
      undefined,
      'D:\\Elsewhere\\report.md',
      { mode: 'full_bypass', applicationApproved: true, bypassApplicationAuthorization: true, source: 'full_bypass' },
      'win32',
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
    if (result.ok) throw new Error('Full Bypass skips prompts; it does not invent a project');
  });

  it('names the containing folder as the project to add', async () => {
    const result = await resolveWorkspaceForPath(repository([nested]), undefined, 'D:\\Elsewhere\\report.md', undefined, 'win32', [], true);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'PATH_OUTSIDE_WORKSPACE', message: expect.stringContaining('add "D:\\Elsewhere" as a project') },
    });
  });

  it('requires source and destination to share one workspace', async () => {
    const other: Workspace = {
      id: 'drive-d',
      displayName: 'D',
      rootPath: 'D:\\',
      realRootPath: 'D:\\',
      createdAt: new Date(0).toISOString(),
    };
    const result = await resolveSharedWorkspace(
      repository([drive, other]),
      undefined,
      path.win32.join('C:\\', 'a.txt'),
      path.win32.join('D:\\', 'a.txt'),
      undefined, 'win32',
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
  });

  it('does not separator-rewrite foreign persisted paths on POSIX', async () => {
    const project: Workspace = {
      id: 'posix-project',
      displayName: 'Project',
      rootPath: '/home/alice/project',
      realRootPath: '/home/alice/project',
      createdAt: new Date(0).toISOString(),
    };
    const result = await resolveWorkspaceForPath(repository([project]), undefined, 'C:\\home\\alice\\project\\file.txt', undefined, 'linux');
    expect(result).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
  });
});
