import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveBundledMediaExecutable } from './upgrade-runtime.js';

const temporaryRoots: string[] = [];
const executableSuffix = process.platform === 'win32' ? '.exe' : '';

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-media-runtime-'));
  temporaryRoots.push(root);
  return root;
}

describe('bundled media runtime resolution', () => {
  it('uses the FFmpeg bundled next to the packaged Electron resources', async () => {
    const root = await createRoot();
    const resources = path.join(root, 'resources');
    await mkdir(path.join(resources, 'media-runtime'), { recursive: true });
    const bundled = path.join(resources, 'media-runtime', `ffmpeg${executableSuffix}`);
    await writeFile(bundled, 'stub');

    const resolved = resolveBundledMediaExecutable('ffmpeg', {
      env: {},
      resourcesPath: resources,
      execPath: path.join(root, 'lnwjud'),
      cwd: root,
    });

    expect(resolved.source).toBe('bundled');
    expect(resolved.executable).toBe(bundled);
  });

  it('finds the bundle from the install directory when resourcesPath is unavailable', async () => {
    const root = await createRoot();
    const installDirectory = path.join(root, 'app');
    await mkdir(path.join(installDirectory, 'resources', 'media-runtime'), { recursive: true });
    const bundled = path.join(installDirectory, 'resources', 'media-runtime', `ffprobe${executableSuffix}`);
    await writeFile(bundled, 'stub');

    const resolved = resolveBundledMediaExecutable('ffprobe', {
      env: {},
      execPath: path.join(installDirectory, `lnwjud${executableSuffix}`),
      cwd: root,
    });

    expect(resolved.source).toBe('bundled');
    expect(resolved.executable).toBe(bundled);
  });

  it('reports every bundled location it searched before falling back to PATH', async () => {
    const root = await createRoot();
    const resolved = resolveBundledMediaExecutable('ffmpeg', {
      env: {},
      resourcesPath: path.join(root, 'resources'),
      execPath: path.join(root, 'lnwjud'),
      cwd: root,
    });

    // A missing bundle must stay visible as a search failure instead of silently
    // becoming an "install FFmpeg" instruction with no evidence.
    expect(resolved.source).toBe('path');
    expect(resolved.checked).toContain(path.join(root, 'resources', 'media-runtime', `ffmpeg${executableSuffix}`));
    expect(resolved.checked.length).toBeGreaterThan(1);
  });

  it('honours an explicit executable override before any bundled candidate', () => {
    const resolved = resolveBundledMediaExecutable('ffmpeg', {
      env: { LNWJUD_FFMPEG_PATH: 'C:\\custom\\ffmpeg.exe' },
      execPath: 'C:\\app\\lnwjud.exe',
      cwd: 'C:\\app',
    });

    expect(resolved.source).toBe('configured');
    expect(resolved.executable).toBe('C:\\custom\\ffmpeg.exe');
  });
});
