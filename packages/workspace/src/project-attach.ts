import { realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import { comparableHostPath, hostPathApi, isHostPathWithin, resolveHostPath } from './filesystem-root.js';
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

/**
 * Whether one auto-attached folder is a project the user is working in, or a machine location the
 * call merely passed through. A 'project' folder keeps today's behaviour: it is registered so the
 * whole surface agrees on its id, and it can join the Active Project set. An 'ephemeral' folder is
 * usable for the calls that named it but must never be written into the workspace registry, because
 * a read of `C:\Program Files` or a tool cache is not the user opening a new project, and silently
 * activating it widens the mutation fence to a system directory.
 */
export type ExternalAttachPersistence = 'ephemeral' | 'project';

export interface ExternalAttachPersistenceContext {
  /** Test/fixture override; production composition uses the real host. */
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly tempDirectory?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

/** Windows locations that hold installed software or application state, never the user's own project. */
const WINDOWS_SYSTEM_ROOT_VARIABLES = [
  'SystemRoot', 'windir', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData',
  'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432', 'APPDATA', 'LOCALAPPDATA',
] as const;

/** POSIX system trees with the same meaning as the Windows variables above. */
const POSIX_SYSTEM_ROOTS = [
  '/System', '/Library', '/Applications', '/usr', '/etc', '/var', '/opt', '/private', '/bin', '/sbin', '/lib',
] as const;

/**
 * Known per-user library roots. Only the library root itself is ephemeral: a folder inside Desktop
 * or Downloads is exactly the kind of location a chat is pointed at when it opens a real project.
 */
const KNOWN_HOME_LIBRARY_FOLDERS = [
  'Videos', 'Pictures', 'Music', 'Contacts', 'Saved Games', 'Searches', 'Links', 'Favorites',
  '3D Objects', 'Downloads', 'Desktop', 'Documents', 'OneDrive', 'AppData',
] as const;

function withinAny(candidate: string, roots: readonly string[], platform: NodeJS.Platform): boolean {
  return roots.some((root) => {
    const comparableRoot = comparableHostPath(root, platform);
    if (comparableRoot === null) return false;
    const comparableCandidate = comparableHostPath(candidate, platform);
    if (comparableCandidate === null) return false;
    return comparableRoot === comparableCandidate || isHostPathWithin(comparableRoot, comparableCandidate, platform);
  });
}

export function classifyExternalAttachPersistence(
  projectRoot: string,
  context: ExternalAttachPersistenceContext = {},
): ExternalAttachPersistence {
  const platform = context.platform ?? process.platform;
  const environment = context.environment ?? process.env;
  const api = hostPathApi(platform);
  const resolved = resolveHostPath(projectRoot, platform);
  if (resolved === null) return 'project';
  const comparableTarget = comparableHostPath(resolved, platform);
  if (comparableTarget === null) return 'project';

  // The host scratch directory is where a call's real working files are opened, and tools hand each
  // other paths there; it is not an application configuration store even when it sits under AppData.
  const tempDirectory = context.tempDirectory ?? os.tmpdir();
  if (withinAny(comparableTarget, [tempDirectory], platform)) return 'project';

  const systemRoots = platform === 'win32'
    ? WINDOWS_SYSTEM_ROOT_VARIABLES.map((name) => environment[name]).filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [...POSIX_SYSTEM_ROOTS];
  if (systemRoots.length > 0 && withinAny(comparableTarget, systemRoots, platform)) return 'ephemeral';

  const home = context.home ?? os.homedir();
  const comparableHome = comparableHostPath(home, platform);
  if (comparableHome === null) return 'project';
  if (comparableHome === comparableTarget) return 'project';
  const relativeToHome = api.relative(comparableHome, comparableTarget);
  if (relativeToHome.startsWith('..') || api.isAbsolute(relativeToHome)) return 'project';
  const firstSegment = relativeToHome.split(api.sep)[0] ?? '';
  // A dot-directory directly under home is a tool or credential store, and everything below it
  // belongs to that tool. Home itself is already refused as an attach target.
  if (firstSegment.startsWith('.')) return 'ephemeral';
  const isKnownLibraryRoot = KNOWN_HOME_LIBRARY_FOLDERS.some((folder) => {
    const comparableLibrary = comparableHostPath(api.join(home, folder), platform);
    return comparableLibrary !== null && comparableLibrary === comparableTarget;
  });
  if (isKnownLibraryRoot) return 'ephemeral';
  return 'project';
}
