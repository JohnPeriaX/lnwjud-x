import { err, type Result } from '@lnwjud/domain';
import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import { gitDiffSchema, gitLogSchema, gitRunSchema, gitStatusSchema } from './schemas.js';

/**
 * Routing resolves an absolute `cwd` into the project that owns it, registering and attaching the
 * folder when needed, so a chat is never locked to a remembered Active Project. This only runs when
 * neither a workspaceId nor a usable repository path was supplied.
 */
function unresolvedGitProject(): Result<never> {
  return err({
    code: 'INVALID_INPUT',
    message: 'No Git project could be resolved. Pass cwd with the absolute path of the repository, or a workspaceId of an Active Project.',
    recoverable: true,
  });
}

export function gitTools(context: McpToolContext): McpToolDefinition[] {
  return [
    defineTool({
      name: 'git_status',
      description: 'Inspect parsed read-only Git status. Pass cwd with an absolute repository path to target any folder, including one that is not an Active Project yet. For writes (init, add, commit, remote, push, rm, clean, reset) use the git tool.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: gitStatusSchema,
      handler: async (input, signal) => context.services.git === undefined
        ? missingService()
        : input.workspaceId === undefined
          ? unresolvedGitProject()
          : context.services.git.status(context.actor, input.workspaceId, signal),
    }),
    defineTool({
      name: 'git_diff',
      description: 'Return a bounded read-only Git diff. Pass cwd with an absolute repository path to target any folder. For writes use the git tool.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: gitDiffSchema,
      handler: async (input, signal) => context.services.git === undefined
        ? missingService()
        : input.workspaceId === undefined
          ? unresolvedGitProject()
          : context.services.git.diff(context.actor, input.workspaceId, {
          ...(input.path === undefined ? {} : { path: input.path }),
          ...(input.staged === undefined ? {} : { staged: input.staged }),
          ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
        }, signal),
    }),
    defineTool({
      name: 'git_log',
      description: 'Return bounded structured Git history. Pass cwd with an absolute repository path to target any folder. For writes use the git tool.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: gitLogSchema,
      handler: async (input, signal) => context.services.git === undefined
        ? missingService()
        : input.workspaceId === undefined
          ? unresolvedGitProject()
          : context.services.git.log(context.actor, input.workspaceId, {
          ...(input.maxCommits === undefined ? {} : { maxCommits: input.maxCommits }),
          ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
        }, signal),
    }),
    defineTool({
      name: 'git',
      description: 'Run a Git subcommand with a separate args array. An absolute cwd outside every Active Project needs no prior registration: reads and Full Access mutations attach it immediately, stricter profiles confirm once. With Full Bypass OFF, Full Access runs ordinary read and non-destructive Git mutations without confirmation while destructive/data-loss forms, scope overrides, aliases, unsafe pathspecs, unknown commands, and destructive remote/history rewrites remain guarded or denied. Trusted Full Bypass skips lnwjud approval, command-policy, and Active Project scope checks, including explicitly absolute outside paths, without bypassing Git or OS errors. Do not wrap Git in PowerShell/cmd.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: gitRunSchema,
      handler: async (input, signal, authorization) => context.services.git === undefined
        ? missingService()
        : context.services.git.run(context.actor, {
          args: input.args,
          ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          ...(input.timeoutSeconds === undefined ? {} : { timeoutMs: Math.floor(input.timeoutSeconds * 1000) }),
          ...(input.userConfirmed === undefined ? {} : { userConfirmed: input.userConfirmed }),
        }, signal, authorization),
    }),
  ];
}
