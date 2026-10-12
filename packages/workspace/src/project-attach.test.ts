import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAttachableProjectRoot } from './project-attach.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('resolveAttachableProjectRoot', () => {
  it('resolves a file target to its containing directory and a missing path to its nearest ancestor', async () => {
    const raw = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-attach-root-'));
    temporaryRoots.push(raw);
    const root = await realpath(raw);

    expect(resolveAttachableProjectRoot(path.join(root, 'README.md'))).toBe(root);
    expect(resolveAttachableProjectRoot(path.join(root, 'src', 'deep', 'file.ts'))).toBe(root);
  });

  it('refuses machine roots, the home directory, and foreign host syntax', () => {
    const api = path[process.platform === 'win32' ? 'win32' : 'posix'];
    expect(resolveAttachableProjectRoot(api.parse(api.resolve(os.homedir())).root)).toBeNull();
    expect(resolveAttachableProjectRoot(os.homedir())).toBeNull();
    expect(resolveAttachableProjectRoot(process.platform === 'win32' ? '/etc/passwd' : 'C:\\project\\file.ts')).toBeNull();
  });
});
