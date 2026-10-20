import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyExternalAttachPersistence, resolveAttachableProjectRoot } from './project-attach.js';

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

const windowsContext = {
  platform: 'win32' as const,
  home: 'C:\\Users\\me',
  tempDirectory: 'C:\\Users\\me\\AppData\\Local\\Temp',
  environment: {
    SystemRoot: 'C:\\Windows',
    windir: 'C:\\Windows',
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    ProgramData: 'C:\\ProgramData',
    APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
  },
};

describe('classifyExternalAttachPersistence', () => {
  it('keeps the folders a chat is actually pointed at as projects', () => {
    expect(classifyExternalAttachPersistence('C:\\Users\\me\\Downloads\\alyn_mobile', windowsContext)).toBe('project');
    expect(classifyExternalAttachPersistence('C:\\Users\\me\\Desktop\\Working\\repo', windowsContext)).toBe('project');
    expect(classifyExternalAttachPersistence('D:\\New folder\\Script\\World-NextX\\gamemodes', windowsContext)).toBe('project');
    expect(classifyExternalAttachPersistence('C:\\Users\\me\\code\\skills-capable\\app', windowsContext)).toBe('project');
    // The host scratch directory is where tools hand each other real working files, so it is not an
    // application configuration store even though it lives under AppData.
    expect(classifyExternalAttachPersistence('C:\\Users\\me\\AppData\\Local\\Temp\\lnwjud-job\\src', windowsContext)).toBe('project');
  });

  it('classifies installed software, tool caches, other applications state and library roots as ephemeral', () => {
    for (const root of [
      'C:\\Program Files',
      'C:\\Program Files\\Android',
      'C:\\Program Files (x86)\\Somedll\\bin',
      'C:\\Windows\\System32',
      'C:\\ProgramData\\SomeApp',
      'C:\\Users\\me\\AppData\\Roaming\\Claude',
      'C:\\Users\\me\\AppData\\Local\\Programs\\SomeApp',
      'C:\\Users\\me\\AppData',
      'C:\\Users\\me\\.jdks\\jbr-21',
      'C:\\Users\\me\\.claude\\skills',
      'C:\\Users\\me\\.gradle\\daemon\\8.13-milestone-3',
      'C:\\Users\\me\\Videos',
      'C:\\Users\\me\\OneDrive',
    ]) {
      expect(classifyExternalAttachPersistence(root, windowsContext), root).toBe('ephemeral');
    }
  });

  it('applies the same rules to a POSIX host', () => {
    const posixContext = { platform: 'linux' as const, home: '/home/me', tempDirectory: '/tmp', environment: {} };
    expect(classifyExternalAttachPersistence('/usr/lib/node_modules/pkg', posixContext)).toBe('ephemeral');
    expect(classifyExternalAttachPersistence('/Applications/Some.app/Contents', posixContext)).toBe('ephemeral');
    expect(classifyExternalAttachPersistence('/home/me/.cache/projects/x', posixContext)).toBe('ephemeral');
    expect(classifyExternalAttachPersistence('/home/me/Videos', posixContext)).toBe('ephemeral');
    expect(classifyExternalAttachPersistence('/home/me/projects/app', posixContext)).toBe('project');
    expect(classifyExternalAttachPersistence('/tmp/build/out', posixContext)).toBe('project');
    expect(classifyExternalAttachPersistence('/mnt/data/repos/app', posixContext)).toBe('project');
  });

  it('falls back to project semantics for a path that is not native to the host', () => {
    expect(classifyExternalAttachPersistence('/etc/passwd', windowsContext)).toBe('project');
  });
});
