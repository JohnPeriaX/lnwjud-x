import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const bridgeScript = fileURLToPath(new URL('./windows-capability-bridge.ps1', import.meta.url));
const isWindows = process.platform === 'win32';
const systemPowerShell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const temporaryRoots: string[] = [];

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

interface BridgeResponse {
  readonly ok: boolean;
  readonly value?: { readonly pid?: number; readonly ffmpeg_source?: string; readonly ffmpeg_path?: string };
  readonly error?: { readonly code?: string; readonly message?: string };
}

/**
 * Runs the real packaged bridge layout: the script lives in <install>/resources and the
 * bundled FFmpeg beside it in <install>/resources/media-runtime. PATH is trimmed to
 * System32 so a host-installed FFmpeg can never satisfy the request.
 */
async function runBridgeScript(resourcesDirectory: string, request: Record<string, unknown>, tempDirectory: string): Promise<BridgeResponse> {
  const scriptPath = path.join(resourcesDirectory, 'windows-capability-bridge.ps1');
  await copyFile(bridgeScript, scriptPath);
  const system32 = path.dirname(systemPowerShell);

  return await new Promise<BridgeResponse>((resolve, reject) => {
    const child = spawn(systemPowerShell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      shell: false,
      windowsHide: true,
      env: { ...process.env, PATH: system32, TEMP: tempDirectory, TMP: tempDirectory },
    });
    let stdout = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('Windows capability bridge timed out'));
    }, 25_000);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.resume();
    child.once('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('Windows PowerShell could not start'));
    });
    child.once('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const line = stdout.trim().split('\n').at(-1) ?? '';
      try {
        resolve(JSON.parse(line) as BridgeResponse);
      } catch {
        reject(new Error(`Bridge returned no JSON: ${stdout.slice(0, 200)}`));
      }
    });
    child.stdin?.write(JSON.stringify(request));
    child.stdin?.end();
  });
}

describe('windows capability bridge bundled FFmpeg', () => {
  it.skipIf(!isWindows)('records with the FFmpeg bundled beside the packaged bridge script', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-bridge-ffmpeg-'));
    temporaryRoots.push(root);
    const resources = path.join(root, 'resources');
    const mediaRuntime = path.join(resources, 'media-runtime');
    await mkdir(mediaRuntime, { recursive: true });
    // Any real PE is a valid stand-in; the assertion is which path was selected.
    const standIn = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
    const bundled = path.join(mediaRuntime, 'ffmpeg.exe');
    await copyFile(standIn, bundled);

    const response = await runBridgeScript(resources, {
      capability: 'screen_record',
      input: { action: 'start', output_path: path.join(root, 'capture.mp4'), width: 320, height: 240, fps: 1 },
    }, root);

    try {
      expect(response.ok).toBe(true);
      expect(response.value?.ffmpeg_source).toBe('bundled');
      expect(response.value?.ffmpeg_path).toBe(bundled);
    } finally {
      if (typeof response.value?.pid === 'number') {
        try {
          process.kill(response.value.pid);
        } catch {
          // The stand-in process may already have exited.
        }
      }
    }
  }, 30_000);

  it.skipIf(!isWindows)('names the bundled media-runtime folder when the bundle is genuinely missing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-bridge-missing-'));
    temporaryRoots.push(root);
    const resources = path.join(root, 'resources');
    await mkdir(resources, { recursive: true });
    await writeFile(path.join(root, 'placeholder.txt'), 'kept so the directory is not pruned by cleanup');

    const response = await runBridgeScript(resources, {
      capability: 'screen_record',
      input: { action: 'start', output_path: path.join(root, 'capture.mp4') },
    }, root);

    expect(response.ok).toBe(false);
    const message = response.error?.message ?? '';
    expect(message).toContain('media-runtime');
    expect(message).toContain('LNWJUD_FFMPEG_PATH');
    // The old behaviour told users to install FFmpeg without ever mentioning the bundle.
    expect(message).not.toMatch(/^ffmpeg is not installed/);
  }, 30_000);

  it.skipIf(!isWindows)('honours LNWJUD_FFMPEG_PATH over the bundled copy', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-bridge-override-'));
    temporaryRoots.push(root);
    const resources = path.join(root, 'resources');
    const mediaRuntime = path.join(resources, 'media-runtime');
    await mkdir(mediaRuntime, { recursive: true });
    await copyFile(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), path.join(mediaRuntime, 'ffmpeg.exe'));
    const override = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe');
    process.env.LNWJUD_FFMPEG_PATH = override;
    try {
      const response = await runBridgeScript(resources, {
        capability: 'screen_record',
        input: { action: 'start', output_path: path.join(root, 'capture.mp4') },
      }, root);
      expect(response.ok).toBe(true);
      expect(response.value?.ffmpeg_source).toBe('configured');
      expect(response.value?.ffmpeg_path).toBe(override);
      if (typeof response.value?.pid === 'number') {
        try {
          process.kill(response.value.pid);
        } catch {
          // already exited
        }
      }
    } finally {
      delete process.env.LNWJUD_FFMPEG_PATH;
    }
  }, 30_000);
});
