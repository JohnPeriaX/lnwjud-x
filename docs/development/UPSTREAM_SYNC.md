# Upstream sync

This repository is a fork. `origin` is `JohnPeriaX/lnwjud-x`; `upstream` is the original
[`engasnm111/lnwjud`](https://github.com/engasnm111/lnwjud). Upstream keeps shipping fixes, so the
fork must be able to absorb them without losing its own behavior, and without losing it *silently*.

The danger is not a merge conflict. A conflict is loud and gets fixed. The danger is a merge that
succeeds cleanly because upstream never had those lines, so nothing tells you that a fork-only
behavior disappeared.

## One command

```powershell
corepack pnpm@10.15.0 run upstream:plan                       # read-only: classify the incoming merge
corepack pnpm@10.15.0 run upstream:plan -- --simulate          # also merge in scratch objects and re-check markers
corepack pnpm@10.15.0 run upstream:merge                      # backup branch + merge --no-commit + auto-heal
```

`upstream:plan` fetches `upstream/main`, finds the common ancestor, and splits every file both sides
touched into three buckets. `upstream:merge` additionally creates
`backup/pre-upstream-sync-<date>`, starts the merge without committing, and re-derives the mechanical
parts. It never commits, never pushes, never force-updates, and refuses to start with a dirty worktree.

`--simulate` is the part worth trusting. It builds a scratch index and a dangling commit from the
**current working tree** (so uncommitted fork work is included), runs `git merge-tree` against
upstream, and then re-checks every registered marker in the merged result. It mutates nothing: no
branch, no index, no file. A conflict list cannot tell you whether a clean merge silently deleted
fork behavior, and this does.

Use `--from upstream/dev` to pull the development line instead of the released line.

## The three buckets

| Bucket | Meaning | Resolution |
| --- | --- | --- |
| **FORK-CRITICAL** | carries behavior registered in `scripts/upstream-divergence.json` | resolve by hand, then run its proof tests |
| **NEEDS REVIEW** | upstream changed a file the fork also changed, and it is not registered | resolve by hand, then register it if the fork change is intentional |
| **VERSION NOISE** | the file's version text is derived from the package version | never hand-edit; `set-version` re-derives it |

"Version noise" does not mean "auto-resolved". Those files still conflict textually, because both
sides changed the same version lines. It means the **resolution is mechanical**: take either side,
then re-run `set-version` and the conflict carries no decision. Never hand-edit them to fix a string.

Measured against `upstream/main` (56 commits ahead, with fork work still uncommitted): 39 files
overlapped, so `--simulate` reported 7 conflicts and none of them carried fork behavior; all 19
registered markers survived in the merged result, including inside `tool-registry.ts`, which merged
cleanly. That ratio is the reason to classify instead of resolving by hand - the machine takes the
boring majority so attention goes to the few real choices.

`packages/mcp-server/src/tool-registry.ts` is deliberately excluded from the version-noise list even
though one approval line inside it carries a version number. Classifying a behavior-critical file as
auto-healable noise is exactly the silent regression this process exists to prevent.

## The divergence registry

[`scripts/upstream-divergence.json`](../scripts/upstream-divergence.json) is the contract. Each entry
names a fork-only behavior, a **source marker** that proves it survived, and the **proof tests** that
exercise it.

[`tests/release/upstream-divergence.test.ts`](../../tests/release/upstream-divergence.test.ts) fails
when any marker goes missing, with a message naming the behavior, the file and the tests to re-apply
from. It is wired into `test:release-gate`, which `scripts/verify-release.ps1` runs before any push,
so an unregistered regression cannot ride into a release unnoticed.

**When you add fork-only behavior, add a registry entry in the same change.** If a sync produces a
NEEDS REVIEW file that the fork intentionally diverges on, register it then, not later.

## Resolving the What's New surface

`apps/desktop/src/renderer/features/release-notes/release-notes.ts` and
`apps/desktop/src/renderer/i18n/messages.ts` conflict on nearly every sync because both sides append
version entries. The resolution is a union, not a choice:

1. keep upstream's entries for upstream versions verbatim;
2. keep this fork's own items, added as extra entries in the same version's `categories`;
3. drop no `id`, and keep every referenced `whatsNew.<version>.<id>.title/description` key present in
   both the Thai and English message maps.

`test:release-gate` includes `release-notes.test.ts`, which requires a non-empty exact-version entry
for the current package version in both languages.

## Version numbering caution

Upstream shipped `v5.8.2` and `v5.8.3` as real feature releases. This fork jumped from `5.8.1` straight
to `5.8.3` and its own `5.8.3` contains none of the upstream `5.8.2`/`5.8.3` fixes. Two different trees
now claim the same version number, which makes "we are on 5.8.3" ambiguous and will make the next
`set-version` bump look like a no-op.

Before the next release, give the fork a distinct version so its number cannot be confused with an
upstream tag, then bump through the canonical script as usual:

```powershell
corepack pnpm@10.15.0 run set-version <version>
corepack pnpm@10.15.0 run test:version
```

## After any sync

Run the guard set the plan printed, then the normal gates:

```powershell
corepack pnpm@10.15.0 exec vitest run tests/release/upstream-divergence.test.ts
corepack pnpm@10.15.0 run test:version
corepack pnpm@10.15.0 run docs:tools:check
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/verify-release.ps1 -SkipWindowsPackaging
```

If something is genuinely broken after the merge, restore the safety branch rather than editing
forward: `git reset --hard backup/pre-upstream-sync-<date>`.
