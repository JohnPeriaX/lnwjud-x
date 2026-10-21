import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { FileActor } from '@lnwjud/application';
import { UpgradeRuntimeService } from './upgrade-runtime.js';
import type { McpApplicationServices } from './tools/tool-types.js';

const actor: FileActor = { clientId: 'test', clientName: 'test' };
const mediaRuntime = fileURLToPath(new URL('../../../apps/desktop/build/media-runtime', import.meta.url));
const ffmpeg = path.join(mediaRuntime, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const ffprobe = path.join(mediaRuntime, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const hasBundledMediaRuntime = process.platform === 'win32' && existsSync(ffmpeg) && existsSync(ffprobe);
const temporaryRoots: string[] = [];

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

interface MediaInspect {
  readonly mediaType: string;
  readonly ffprobe_source: string;
  readonly ffprobe_path: string;
  readonly metadata: { readonly width?: number; readonly height?: number };
}

interface MediaFrame {
  readonly mediaType: string;
  readonly ffprobe_source: string;
  readonly ffprobe_path: string;
  readonly ffmpeg_source?: string;
  readonly ffmpeg_path?: string;
  readonly frameCount: number;
  readonly images: readonly { readonly content: string; readonly mimeType: string }[];
}

describe.skipIf(!hasBundledMediaRuntime)('video media runtime', () => {
  it('falls back from an unusable configured path to the bundled ffprobe and ffmpeg', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-media-video-'));
    temporaryRoots.push(root);
    const videoPath = path.join(root, 'sample.mp4');
    execFileSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=0.4',
      '-c:v', 'mpeg4', '-q:v', '5', '-pix_fmt', 'yuv420p', '-y', videoPath,
    ], { stdio: 'pipe', timeout: 30_000 });
    const previousFfprobe = process.env.LNWJUD_FFPROBE_PATH;
    const previousFfmpeg = process.env.LNWJUD_FFMPEG_PATH;
    process.env.LNWJUD_FFPROBE_PATH = path.join(root, 'missing-tools');
    process.env.LNWJUD_FFMPEG_PATH = path.join(root, 'missing-tools');
    try {
      const runtime = new UpgradeRuntimeService({
        file: {} as McpApplicationServices['file'],
      }, actor);

      const inspect = await runtime.execute('media_read', { path: videoPath, action: 'inspect' });
      if (!inspect.ok) throw new Error(inspect.error.message);
      const inspectValue = inspect.value as MediaInspect;
      expect(inspectValue).toMatchObject({
        mediaType: 'video',
        ffprobe_source: 'bundled',
        ffprobe_path: ffprobe,
        metadata: { width: 64, height: 64 },
      });

      const frame = await runtime.execute('media_read', { path: videoPath, action: 'frame', timestamp_seconds: 0 });
      if (!frame.ok) throw new Error(frame.error.message);
      const frameValue = frame.value as MediaFrame;
      expect(frameValue).toMatchObject({
        mediaType: 'video',
        ffprobe_source: 'bundled',
        ffprobe_path: ffprobe,
        ffmpeg_source: 'bundled',
        ffmpeg_path: ffmpeg,
        frameCount: 1,
      });
      expect(frameValue.images[0]?.mimeType).toBe('image/jpeg');
      expect(frameValue.images[0]?.content.length).toBeGreaterThan(100);
    } finally {
      if (previousFfprobe === undefined) delete process.env.LNWJUD_FFPROBE_PATH;
      else process.env.LNWJUD_FFPROBE_PATH = previousFfprobe;
      if (previousFfmpeg === undefined) delete process.env.LNWJUD_FFMPEG_PATH;
      else process.env.LNWJUD_FFMPEG_PATH = previousFfmpeg;
    }
  }, 30_000);

  it('uses a configured media-runtime folder for both ffprobe and ffmpeg', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-media-video-configured-'));
    temporaryRoots.push(root);
    const videoPath = path.join(root, 'sample.mp4');
    execFileSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=48x32:d=0.4',
      '-c:v', 'mpeg4', '-q:v', '5', '-pix_fmt', 'yuv420p', '-y', videoPath,
    ], { stdio: 'pipe', timeout: 30_000 });
    const previousFfprobe = process.env.LNWJUD_FFPROBE_PATH;
    const previousFfmpeg = process.env.LNWJUD_FFMPEG_PATH;
    process.env.LNWJUD_FFPROBE_PATH = mediaRuntime;
    process.env.LNWJUD_FFMPEG_PATH = mediaRuntime;
    try {
      const runtime = new UpgradeRuntimeService({
        file: {} as McpApplicationServices['file'],
      }, actor);

      const inspect = await runtime.execute('media_read', { path: videoPath, action: 'inspect' });
      if (!inspect.ok) throw new Error(inspect.error.message);
      const inspectValue = inspect.value as MediaInspect;
      expect(inspectValue).toMatchObject({
        mediaType: 'video',
        ffprobe_source: 'configured',
        ffprobe_path: ffprobe,
        metadata: { width: 48, height: 32 },
      });

      const frame = await runtime.execute('media_read', { path: videoPath, action: 'frame', timestamp_seconds: 0 });
      if (!frame.ok) throw new Error(frame.error.message);
      const frameValue = frame.value as MediaFrame;
      expect(frameValue).toMatchObject({
        mediaType: 'video',
        ffprobe_source: 'configured',
        ffprobe_path: ffprobe,
        ffmpeg_source: 'configured',
        ffmpeg_path: ffmpeg,
        frameCount: 1,
      });
    } finally {
      if (previousFfprobe === undefined) delete process.env.LNWJUD_FFPROBE_PATH;
      else process.env.LNWJUD_FFPROBE_PATH = previousFfprobe;
      if (previousFfmpeg === undefined) delete process.env.LNWJUD_FFMPEG_PATH;
      else process.env.LNWJUD_FFMPEG_PATH = previousFfmpeg;
    }
  }, 30_000);
});
