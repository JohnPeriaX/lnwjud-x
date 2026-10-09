/* global Buffer, process */

import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { fetchWithRetry } from './fetch-with-retry.mjs';

const require = createRequire(import.meta.url);
const { Open: openZip } = require('unzipper');

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDependencies = JSON.parse(await readFile(path.join(desktopRoot, 'src', 'main', 'runtime-dependencies.json'), 'utf8'));
const dependency = runtimeDependencies?.ffmpeg;
if (runtimeDependencies?.schemaVersion !== 1 || typeof dependency?.version !== 'string' || dependency.version.length === 0) {
  throw new Error('Bundled FFmpeg dependency manifest is invalid');
}

const platform = process.env.LNWJUD_RUNTIME_TARGET ?? process.platform;
const rawArch = process.env.LNWJUD_RUNTIME_ARCH ?? process.arch;
if (platform !== 'win32' || rawArch !== 'x64') {
  process.stdout.write(`Bundled FFmpeg is currently prepared only for Windows x64; skipping ${platform}/${rawArch}\n`);
  process.exit(0);
}

const target = dependency.targets?.[`${platform}-${rawArch}`];
if (target === undefined
  || target.archive !== 'ffmpeg-release-essentials.zip'
  || target.kind !== 'zip'
  || !/^[0-9a-f]{64}$/iu.test(target.archiveSha256 ?? '')
  || target.ffmpegExecutable !== 'ffmpeg.exe'
  || target.ffprobeExecutable !== 'ffprobe.exe') {
  throw new Error(`Bundled FFmpeg target declaration is invalid for ${platform}/${rawArch}`);
}

const RELEASE_BASE = dependency.baseUrl;
const archiveName = target.archive;
const archivePath = path.join(desktopRoot, 'build', 'vendor', `ffmpeg-v${dependency.version}`, archiveName);
const extractRoot = path.join(desktopRoot, 'build', 'vendor', `ffmpeg-v${dependency.version}`, 'extract');
const bundleRoot = path.join(desktopRoot, 'build', 'media-runtime');

await mkdir(path.dirname(archivePath), { recursive: true });
await assertCanonicalDirectory(path.dirname(archivePath));
await downloadIfNeeded(`${RELEASE_BASE}/${archiveName}`, archivePath, target.archiveSha256, 'FFmpeg');
await rm(extractRoot, { recursive: true, force: true });
await mkdir(extractRoot, { recursive: true });
await assertCanonicalDirectory(extractRoot);
const archive = await openZip.file(archivePath);
await archive.extract({ path: path.resolve(extractRoot) });

const ffmpegSource = await findUniqueFile(extractRoot, target.ffmpegExecutable);
const ffprobeSource = await findUniqueFile(extractRoot, target.ffprobeExecutable);
for (const executable of [ffmpegSource, ffprobeSource]) {
  const metadata = await stat(executable);
  if (!metadata.isFile()) throw new Error(`FFmpeg runtime executable is not a regular file: ${executable}`);
}

await rm(bundleRoot, { recursive: true, force: true });
await mkdir(bundleRoot, { recursive: true });
await assertCanonicalDirectory(bundleRoot);
await copyFile(ffmpegSource, path.join(bundleRoot, target.ffmpegExecutable));
await copyFile(ffprobeSource, path.join(bundleRoot, target.ffprobeExecutable));

for (const notice of await findNotices(extractRoot)) {
  await copyFile(notice, path.join(bundleRoot, path.basename(notice)));
}

const manifest = {
  schemaVersion: 1,
  product: 'lnwjud',
  runtime: 'ffmpeg',
  source: {
    provider: 'gyan.dev',
    project: 'FFmpeg',
    version: dependency.version,
    license: 'GPL-3.0-or-later',
    url: 'https://www.gyan.dev/ffmpeg/builds/',
  },
  platform,
  arch: rawArch,
  archive: archiveName,
  archiveSha256: target.archiveSha256,
  executables: {
    ffmpeg: { name: target.ffmpegExecutable, sha256: await sha256(path.join(bundleRoot, target.ffmpegExecutable)) },
    ffprobe: { name: target.ffprobeExecutable, sha256: await sha256(path.join(bundleRoot, target.ffprobeExecutable)) },
  },
};
await writeAtomic(path.join(bundleRoot, 'BUNDLED_FFMPEG.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await verifyExecutableVersion(path.join(bundleRoot, target.ffmpegExecutable), dependency.version, 'ffmpeg');
await verifyExecutableVersion(path.join(bundleRoot, target.ffprobeExecutable), dependency.version, 'ffprobe');
process.stdout.write(`Prepared bundled FFmpeg ${dependency.version} for Windows x64\n`);

async function findUniqueFile(root, name) {
  const matches = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) matches.push(absolute);
    }
  }
  await visit(root);
  if (matches.length !== 1) throw new Error(`Expected exactly one ${name} in FFmpeg archive; found ${matches.length}`);
  return matches[0];
}

async function findNotices(root) {
  const matches = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && /^(?:license|copying|notice|readme)(?:\.|$)/iu.test(entry.name)) matches.push(absolute);
    }
  }
  await visit(root);
  return matches;
}

async function downloadIfNeeded(url, destination, expectedSha256, label) {
  try {
    await assertCanonicalFile(destination);
    if ((await sha256(destination)) === expectedSha256.toLowerCase()) return;
  } catch {
    // Missing or stale cache entries are downloaded below.
  }
  const response = await fetchWithRetry(url, 120_000);
  if (!response.ok) throw new Error(`Could not download ${label} asset (${response.status})`);
  await writeAtomic(destination, Buffer.from(await response.arrayBuffer()));
  await assertCanonicalFile(destination);
  const actual = await sha256(destination);
  if (actual !== expectedSha256.toLowerCase()) throw new Error(`${label} archive SHA-256 mismatch`);
}

async function verifyExecutableVersion(executable, expectedVersion, label) {
  const { spawn } = await import('node:child_process');
  const { clearTimeout, setTimeout } = await import('node:timers');
  await new Promise((resolve, reject) => {
    const child = spawn(executable, ['-version'], { env: process.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const append = (chunk) => { if (output.length < 1024) output += chunk.toString('utf8').slice(0, 1024 - output.length); };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${label} --version timed out`)); }, 15_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      const escapedVersion = expectedVersion.replaceAll('.', '\\.');
      if (code !== 0 || !new RegExp(`(?:^|[^0-9])${escapedVersion}(?:$|[^0-9])`).test(output)) {
        reject(new Error(`Bundled ${label} version does not match ${expectedVersion}: ${output.trim()}`));
      } else resolve();
    });
  });
}

async function assertCanonicalDirectory(directory) {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`FFmpeg staging directory is not regular: ${directory}`);
  if (await realpath(directory) !== path.resolve(directory)) throw new Error(`FFmpeg staging directory is not canonical: ${directory}`);
}

async function assertCanonicalFile(filePath) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`FFmpeg staging cache entry is not a regular file: ${filePath}`);
  if (await realpath(filePath) !== path.resolve(filePath)) throw new Error(`FFmpeg staging cache entry is not canonical: ${filePath}`);
}

async function sha256(filePath) {
  await assertCanonicalFile(filePath);
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function writeAtomic(destination, contents) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  let committed = false;
  try {
    await writeFile(temporary, contents, { flag: 'wx' });
    await rename(temporary, destination);
    committed = true;
  } finally {
    if (!committed) await rm(temporary, { force: true }).catch(() => undefined);
  }
}
