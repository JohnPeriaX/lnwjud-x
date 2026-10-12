import console from 'node:console';
import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isVersionSurfacePath } from './set-version.mjs';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registryPath = path.join(rootDir, 'scripts', 'upstream-divergence.json');
const argv = process.argv.slice(2);

function readFlag(name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
}

// A dry run must never mutate. The upstream:merge package script bakes in --apply, so --simulate
// has to win over it; otherwise a documented "safe rehearsal" starts a real conflicted merge.
const simulate = argv.includes('--simulate');
const options = {
  from: readFlag('--from') ?? 'upstream/main',
  apply: argv.includes('--apply') && !simulate,
  simulate,
};

async function git(args, { env, allowFailure = false } = {}) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: rootDir,
      maxBuffer: 64 * 1024 * 1024,
      ...(env === undefined ? {} : { env }),
    });
    return stdout.trim();
  } catch (error) {
    // merge-tree exits 1 on conflict and still prints the result; that is data, not a crash.
    if (allowFailure && typeof error?.stdout === 'string') return error.stdout.trim();
    const detail = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
    throw new Error(`git ${args.join(' ')} failed${detail === '' ? '' : `: ${detail}`}`);
  }
}

function lines(output) {
  return output.length === 0 ? [] : output.split(/\r?\n/).filter((line) => line.length > 0);
}

async function loadRegistry() {
  return JSON.parse(await readFile(registryPath, 'utf8'));
}

/**
 * Which kind of work a merged file represents. Fork-critical wins over version noise: a file that
 * carries lnwjud-x behavior must be reviewed by a human even when it also holds a derived version.
 */
function classify(file, criticalFiles) {
  if (criticalFiles.has(file)) return 'forkCritical';
  if (isVersionSurfacePath(file)) return 'versionNoise';
  return 'review';
}

function printGroup(title, items, limit = 20) {
  if (items.length === 0) {
    console.log(`${title}: none`);
    return;
  }
  console.log(`${title} (${items.length}):`);
  for (const item of items.slice(0, limit)) console.log(`  - ${item}`);
  if (items.length > limit) console.log(`  ... and ${items.length - limit} more`);
}

function testCommandFor(file) {
  if (file.startsWith('apps/desktop/')) {
    return { cwd: 'apps/desktop', command: `corepack pnpm@10.15.0 exec vitest run --config vitest.config.ts ${file.slice('apps/desktop/'.length)}` };
  }
  const packagePrefix = /^packages\/[^/]+\//.exec(file);
  if (packagePrefix !== null) {
    return { cwd: packagePrefix[0].slice(0, -1), command: `corepack pnpm@10.15.0 exec vitest run ${file.slice(packagePrefix[0].length)}` };
  }
  return { cwd: '.', command: `corepack pnpm@10.15.0 exec vitest run ${file}` };
}

/**
 * Merge the WORKING TREE against upstream without touching HEAD, the index or any file: a scratch
 * index plus a dangling commit captures uncommitted fork work, `merge-tree` performs the real
 * three-way merge, and then every registered fork marker is re-checked against the merged result.
 * The point is the case a conflict list cannot show you: a merge that completes cleanly and still
 * deletes fork behavior, because upstream never had those lines.
 */
async function simulateMerge(registry, fromRef) {
  const scratchIndex = path.join(rootDir, '.local-artifacts', 'sync-upstream-index.idx');
  const env = { ...process.env, GIT_INDEX_FILE: scratchIndex };
  try {
    await git(['read-tree', 'HEAD'], { env });
    await git(['add', '-A'], { env });
    const worktreeTree = await git(['write-tree'], { env });
    const simCommit = await git(['commit-tree', worktreeTree, '-p', 'HEAD', '-m', 'sync-upstream simulation'], { env });

    const mergeLines = lines(await git(['merge-tree', '--write-tree', '--name-only', simCommit, fromRef], { allowFailure: true }));
    const mergedTree = mergeLines[0];
    if (mergedTree === undefined || !/^[0-9a-f]{7,40}$/.test(mergedTree)) {
      throw new Error(`merge-tree returned no tree: ${mergeLines.join(' | ')}`);
    }
    const conflicted = mergeLines.slice(1).filter((line) => !/^(Auto-merging|CONFLICT|Recursive|warning)/.test(line));

    const lost = [];
    const criticalButConflicted = [];
    const markerFiles = new Set(registry.customizations.flatMap((c) => c.markers.map((m) => m.file)));
    for (const customization of registry.customizations) {
      for (const marker of customization.markers) {
        const content = await git(['show', `${mergedTree}:${marker.file}`], { allowFailure: true });
        if (!content.includes(marker.contains)) lost.push(`${customization.id}: ${marker.contains} in ${marker.file}`);
      }
    }
    for (const file of conflicted) {
      if (markerFiles.has(file)) criticalButConflicted.push(file);
    }

    console.log('');
    console.log(`SIMULATED MERGE (nothing was merged; scratch objects only, commit ${simCommit.slice(0, 8)} is dangling)`);
    console.log(`  conflicted files: ${conflicted.length}`);
    for (const file of conflicted) {
      const note = markerFiles.has(file)
        ? '  [carries fork behavior - resolve by hand]'
        : isVersionSurfacePath(file)
          ? '  [mechanical: take upstream, then re-run set-version]'
          : '';
      console.log(`    - ${file}${note}`);
    }
    if (lost.length === 0) {
      console.log(`  fork markers in merged result: all ${registry.customizations.reduce((total, c) => total + c.markers.length, 0)} present`);
      console.log(`  ${criticalButConflicted.length === 0 ? 'SAFE: no conflicted file carries fork behavior.' : `REVIEW FIRST: ${criticalButConflicted.length} conflicted file(s) carry fork behavior.`}`);
    } else {
      console.log(`  FORK BEHAVIOR LOST IN THE MERGED RESULT (${lost.length}):`);
      for (const item of lost) console.log(`    x ${item}`);
      console.log('  Do not merge as-is: re-apply the lost behavior first, or resolve these files by hand during the merge.');
    }
  } finally {
    await rm(scratchIndex, { force: true });
  }
}

async function main() {
  const [remoteName, ...rest] = options.from.split('/');
  const remoteBranch = rest.join('/');
  if (remoteBranch.length === 0) throw new Error(`--from must look like <remote>/<branch>, got ${options.from}`);

  console.log(`Fetching ${remoteName} ...`);
  await git(['fetch', '--prune', remoteName]);

  const registry = await loadRegistry();
  const criticalFiles = new Set(registry.customizations.flatMap((customization) => customization.markers.map((marker) => marker.file)));

  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const base = await git(['merge-base', 'HEAD', options.from]);
  const incomingCount = (await git(['rev-list', '--count', `${base}..${options.from}`])) || '0';
  const upstreamTouched = lines(await git(['diff', '--name-only', base, options.from]));
  const oursTouched = new Set(lines(await git(['diff', '--name-only', base, 'HEAD'])));
  const bothTouched = upstreamTouched.filter((file) => oursTouched.has(file));

  const buckets = { forkCritical: [], review: [], versionNoise: [] };
  for (const file of bothTouched) buckets[classify(file, criticalFiles)].push(file);

  console.log('');
  console.log(`Branch: ${branch}`);
  console.log(`Upstream: ${options.from} is ${incomingCount} commit(s) ahead of the common ancestor ${base.slice(0, 8)}`);
  console.log(`Upstream touched ${upstreamTouched.length} file(s), this fork touched ${oursTouched.size}, ${bothTouched.length} overlap.`);
  console.log('');
  printGroup('FORK-CRITICAL - resolve by hand, then run its proof tests', buckets.forkCritical);
  printGroup('NEEDS REVIEW - semantic change not registered in the divergence registry', buckets.review);
  printGroup('VERSION NOISE - may still conflict textually; take either side, then re-run set-version', buckets.versionNoise);

  const proofTests = [...new Set(registry.customizations
    .filter((customization) => customization.markers.some((marker) => bothTouched.includes(marker.file)))
    .flatMap((customization) => customization.proofTests))];

  console.log('');
  if (bothTouched.length === 0) {
    console.log('No file overlap: this merge cannot overwrite fork behavior, it can only add upstream changes.');
  }

  if (options.simulate) await simulateMerge(registry, options.from);

  if (!options.apply) {
    console.log('PLAN ONLY. Add --apply to create a backup branch and start the merge.');
    if (proofTests.length > 0) {
      console.log('After a real sync, prove these fork behaviors survived:');
      for (const proofTest of proofTests) {
        const { cwd, command } = testCommandFor(proofTest);
        console.log(`  (cd ${cwd} && ${command})`);
      }
    }
    return;
  }

  if ((await git(['status', '--porcelain'])).length > 0) {
    throw new Error('the worktree has uncommitted changes; commit or stash them first, otherwise the merge mixes fork work with upstream work');
  }

  const version = (await git(['show', 'HEAD:package.json'])).match(/"version":\s*"([^"]+)"/)?.[1] ?? null;
  if (version === null) throw new Error('could not read the package version from HEAD');

  const backupBranch = `backup/pre-upstream-sync-${new Date().toISOString().slice(0, 10)}`;
  if (lines(await git(['branch', '--list', backupBranch])).length === 0) {
    await git(['branch', backupBranch, 'HEAD']);
    console.log(`\nSafety backup created: ${backupBranch}`);
  } else {
    console.log(`\nSafety backup already exists: ${backupBranch}`);
  }

  console.log(`Merging ${options.from} without committing ...`);
  try {
    await git(['merge', '--no-commit', '--no-ff', options.from]);
  } catch (mergeError) {
    const conflicted = lines(await git(['diff', '--name-only', '--diff-filter=U']));
    console.log(`\nMerge stopped with ${conflicted.length} conflict(s). The merge is left in place for you to resolve:`);
    for (const file of conflicted) console.log(`  ! ${file} [${classify(file, criticalFiles)}]`);
    console.log('');
    console.log(`  abort: git merge --abort`);
    console.log(`  restore: git reset --hard ${backupBranch}`);
    console.log(`  re-derive version noise afterwards: corepack pnpm@10.15.0 run set-version ${version}`);
    console.log(String(mergeError).split('\n')[0]);
    return;
  }

  console.log(`\nClean merge. Re-deriving the version surface for ${version} and regenerating the tool catalog ...`);
  await execFileAsync(process.execPath, [path.join(rootDir, 'scripts', 'set-version.mjs'), version], { cwd: rootDir });
  await execFileAsync(process.execPath, [path.join(rootDir, 'scripts', 'generate-tool-catalog.mjs')], { cwd: rootDir });

  console.log('\nThe merge is staged but NOT committed. Prove fork behavior survived before committing:');
  console.log('  corepack pnpm@10.15.0 exec vitest run tests/release/upstream-divergence.test.ts');
  for (const proofTest of proofTests) {
    const { cwd, command } = testCommandFor(proofTest);
    console.log(`  (cd ${cwd} && ${command})`);
  }
  console.log('\nThen: corepack pnpm@10.15.0 run test:version && git commit');
}

try {
  await main();
} catch (error) {
  console.error(`\nsync-upstream: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
