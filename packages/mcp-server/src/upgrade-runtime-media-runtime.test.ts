import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterEach, describe, expect, it } from 'vitest';
import { appError, err, ok } from '@lnwjud/domain';
import {
  resolveBundledMediaExecutable,
  resolveMediaExecutableCandidates,
  runMediaExecutableWithFallback,
} from './upgrade-runtime.js';

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

  it('reports every bundled location it searched, including the packaged resources directory', async () => {
    const root = await createRoot();
    const resolved = resolveBundledMediaExecutable('ffmpeg', {
      env: {},
      resourcesPath: path.join(root, 'resources'),
      execPath: path.join(root, 'lnwjud'),
      cwd: root,
    });

    // A missing bundle must stay visible as a search failure instead of silently
    // becoming an "install FFmpeg" instruction with no evidence. The resolver may
    // still find the repository's own build/media-runtime while the test runs from
    // a source checkout, but the packaged location must always be reported.
    expect(resolved.checked).toContain(path.join(root, 'resources', 'media-runtime', `ffmpeg${executableSuffix}`));
    expect(resolved.checked.length).toBeGreaterThan(1);
    if (resolved.source === 'bundled') {
      expect(resolved.executable).not.toBe(path.join(root, 'resources', 'media-runtime', `ffmpeg${executableSuffix}`));
    }
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

  it('accepts a configured folder and appends the executable name', async () => {
    const root = await createRoot();
    const tools = path.join(root, 'ffmpeg-bin');
    await mkdir(tools, { recursive: true });
    const executable = path.join(tools, `ffmpeg${executableSuffix}`);
    await writeFile(executable, 'stub');

    const resolved = resolveBundledMediaExecutable('ffmpeg', {
      env: { LNWJUD_FFMPEG_PATH: tools },
      resourcesPath: path.join(root, 'resources'),
      execPath: path.join(root, 'lnwjud.exe'),
      cwd: root,
    });

    expect(resolved.source).toBe('configured');
    expect(resolved.executable).toBe(executable);
  });

  it('strips surrounding quotes from a configured executable path', () => {
    const resolved = resolveBundledMediaExecutable('ffprobe', {
      env: { LNWJUD_FFPROBE_PATH: '"C:\\tools\\ffprobe.exe"' },
      execPath: 'C:\\app\\lnwjud.exe',
      cwd: 'C:\\app',
    });

    expect(resolved.source).toBe('configured');
    expect(resolved.executable).toBe('C:\\tools\\ffprobe.exe');
  });

  it.skipIf(process.platform !== 'win32')('expands Windows environment variables in a quoted configured path', () => {
    const resolved = resolveBundledMediaExecutable('ffprobe', {
      env: { LNWJUD_FFPROBE_PATH: '"%TOOLS%\\ffprobe.exe"', TOOLS: 'C:\\tools' },
      execPath: 'C:\\app\\lnwjud.exe',
      cwd: 'C:\\app',
    });

    expect(resolved.source).toBe('configured');
    expect(resolved.executable).toBe('C:\\tools\\ffprobe.exe');
  });

  it('keeps the bundled candidate after an unusable configured path', async () => {
    const root = await createRoot();
    const resources = path.join(root, 'resources');
    await mkdir(path.join(resources, 'media-runtime'), { recursive: true });
    const bundled = path.join(resources, 'media-runtime', `ffprobe${executableSuffix}`);
    await writeFile(bundled, 'stub');
    const configured = path.join(root, 'not-installed');

    const candidates = resolveMediaExecutableCandidates('ffprobe', {
      env: { LNWJUD_FFPROBE_PATH: configured },
      resourcesPath: resources,
      execPath: path.join(root, 'lnwjud.exe'),
      cwd: root,
    });

    expect(candidates[0]).toEqual({ executable: configured, source: 'configured' });
    expect(candidates).toContainEqual({ executable: bundled, source: 'bundled' });
    expect(candidates.at(-1)).toEqual({ executable: `ffprobe${executableSuffix}`, source: 'path' });
  });

  it('falls back to the bundled executable when the configured candidate cannot start', async () => {
    const root = await createRoot();
    const resources = path.join(root, 'resources');
    await mkdir(path.join(resources, 'media-runtime'), { recursive: true });
    const bundled = path.join(resources, 'media-runtime', `ffprobe${executableSuffix}`);
    await writeFile(bundled, 'stub');
    const configured = path.join(root, 'blocked', `ffprobe${executableSuffix}`);
    const attempted: string[] = [];

    const execution = await runMediaExecutableWithFallback('ffprobe', async (executable) => {
      attempted.push(executable);
      if (executable === configured) return err(appError('PROCESS_NOT_FOUND', `${executable} is unavailable (EACCES)`, true));
      return ok('probe-ok');
    }, {
      env: { LNWJUD_FFPROBE_PATH: configured },
      resourcesPath: resources,
      execPath: path.join(root, 'lnwjud.exe'),
      cwd: root,
    });

    expect(execution.result).toEqual(ok('probe-ok'));
    expect(execution.selection).toEqual({ executable: bundled, source: 'bundled' });
    expect(attempted).toEqual([configured, bundled]);
    expect(execution.attempts).toHaveLength(1);
    expect(execution.attempts[0]).toContain('EACCES');
  });

  it('reports every checked location and the real spawn failure when no candidate starts', async () => {
    const root = await createRoot();
    const resources = path.join(root, 'resources');
    await mkdir(resources, { recursive: true });
    const configured = path.join(root, 'missing-tools', `ffprobe${executableSuffix}`);

    const execution = await runMediaExecutableWithFallback('ffprobe', async (executable) => (
      err(appError('PROCESS_NOT_FOUND', `${executable} is unavailable (EACCES)`, true))
    ), {
      env: { LNWJUD_FFPROBE_PATH: configured },
      resourcesPath: resources,
      execPath: path.join(root, 'lnwjud.exe'),
      cwd: root,
    });

    expect(execution.result.ok).toBe(false);
    if (execution.result.ok) throw new Error('expected a missing executable failure');
    expect(execution.result.error.code).toBe('EXECUTABLE_NOT_FOUND');
    expect(execution.result.error.message).toContain(configured);
    expect(execution.result.error.message).toContain(path.join(resources, 'media-runtime', `ffprobe${executableSuffix}`));
    expect(execution.result.error.message).toContain('EACCES');
    expect(execution.result.error.message).toContain('LNWJUD_FFPROBE_PATH');
  });

  it('does not hide a real ffprobe exit failure by trying another binary', async () => {
    const root = await createRoot();
    const resources = path.join(root, 'resources');
    await mkdir(path.join(resources, 'media-runtime'), { recursive: true });
    await writeFile(path.join(resources, 'media-runtime', `ffprobe${executableSuffix}`), 'stub');
    const configured = path.join(root, 'broken', `ffprobe${executableSuffix}`);
    let calls = 0;

    const execution = await runMediaExecutableWithFallback('ffprobe', async () => {
      calls += 1;
      return err(appError('INTERNAL_ERROR', 'ffprobe query failed with exit code 1', true));
    }, {
      env: { LNWJUD_FFPROBE_PATH: configured },
      resourcesPath: resources,
      execPath: path.join(root, 'lnwjud.exe'),
      cwd: root,
    });

    expect(execution.result.ok).toBe(false);
    expect(execution.result.ok ? undefined : execution.result.error.message).toContain('exit code 1');
    expect(calls).toBe(1);
  });
});
