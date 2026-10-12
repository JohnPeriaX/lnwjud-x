import { realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import { comparableHostPath, hostPathApi, resolveHostPath } from './filesystem-root.js';
import { filesystemRootForPath } from './machine-root.js';

/**
 * Nearest existing directory that contains a caller-supplied absolute path, used when a host wants
 * to attach the project a path actually points at instead of rejecting it for living outside the
 * Active Project set. File targets resolve to their containing directory, so a not-yet-created file
 * still names its project.
 *
 * Machine roots (drive/UNC/POSIX mount roots) and the user home directory are refused: an attached
 * project must be a concrete folder the user named, never a whole-disk grant.
 */
export function resolveAttachableProjectRoot(
  inputPath: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const absolute = resolveHostPath(inputPath, platform);
  if (absolute === null) return null;
  const api = hostPathApi(platform);
  const home = resolveHostPath(os.homedir(), platform);
  const comparableHome = home === null ? null : comparableHostPath(home, platform);
  let current = absolute;
  for (let depth = 0; depth < 64; depth += 1) {
    let isDirectory = false;
    try {
      isDirectory = statSync(current).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (isDirectory) {
      let canonical: string;
      try {
        canonical = realpathSync(current);
      } catch {
        return null;
      }
      if (filesystemRootForPath(canonical, platform) !== null) return null;
      if (comparableHome !== null && comparableHostPath(canonical, platform) === comparableHome) return null;
      return canonical;
    }
    const parent = api.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}
