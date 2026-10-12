import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PATH_SCOPE_ARRAY_KEYS, PATH_SCOPE_KEYS, ToolRegistry } from './tool-registry.js';

const actor = { clientId: 'path-scope-coverage-test', clientName: 'path scope coverage test' };

/** Any field name that could plausibly carry a filesystem target must be reviewed by this guard. */
const PATHISH_FIELD = /(path|dir|cwd|database|worktree|file)/i;

/**
 * Path-ish names that are deliberately not a filesystem target, so routing them would be wrong.
 * Adding an entry here is an explicit decision with a reason, not a way to silence the guard.
 */
const NOT_A_FILESYSTEM_TARGET = new Set([
  'file_name', // display name for a save dialog, joined onto a resolved directory
  'media_type', // MIME type
  'sheet', // workbook sheet name
  'hookProfile', // ECC profile id; matched only because the name ends in "file"
  'relativePath', // skill-relative entry name, never a host path
  'scopedPath', // Engineering scope; an absolute value is rejected rather than routed
  'trackerPath', // legacy tracker read through the workspace-scoped file service
  'changedFiles', // recovery-note text describing work already done
]);

function unwrap(schema: unknown): unknown {
  let current = schema;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable || current instanceof z.ZodDefault) {
      const inner = (current as z.ZodOptional<z.ZodType>).unwrap?.() ?? (current as { _def?: { innerType?: unknown } })._def?.innerType;
      if (inner === undefined) return current;
      current = inner;
      continue;
    }
    return current;
  }
  return current;
}

function objectSchemas(schema: unknown, sink: Map<string, unknown>): void {
  const current = unwrap(schema);
  if (current instanceof z.ZodObject) {
    for (const [key, field] of Object.entries(current.shape as z.ZodRawShape)) sink.set(key, field);
    return;
  }
  if (current instanceof z.ZodUnion) {
    for (const option of current.options) objectSchemas(option, sink);
  }
}

describe('path scope field coverage', () => {
  it('routes every path-shaped field that any tool definition accepts', () => {
    const registry = new ToolRegistry({}, actor);
    const unrouted: string[] = [];
    for (const tool of registry.listAll()) {
      const fields = new Map<string, unknown>();
      objectSchemas(tool.inputSchema, fields);
      for (const [key, field] of fields) {
        if (NOT_A_FILESYSTEM_TARGET.has(key)) continue;
        if (!PATHISH_FIELD.test(key)) continue;
        const inner = unwrap(field);
        const isString = inner instanceof z.ZodString;
        const isStringArray = inner instanceof z.ZodArray && unwrap(inner.element) instanceof z.ZodString;
        if (!isString && !isStringArray) continue;
        if (isStringArray) {
          if (!PATH_SCOPE_ARRAY_KEYS.includes(key as typeof PATH_SCOPE_ARRAY_KEYS[number])) unrouted.push(`${tool.name}.${key}[]`);
          continue;
        }
        if (!PATH_SCOPE_KEYS.includes(key as typeof PATH_SCOPE_KEYS[number])) unrouted.push(`${tool.name}.${key}`);
      }
    }
    // An enforced-but-unroutable field makes lnwjud deny a valid absolute path instead of
    // attaching its folder, which is the exact failure this registry had twice already.
    expect([...new Set(unrouted)].sort()).toEqual([]);
  });

  it('never routes a field that cannot name a filesystem target', () => {
    for (const key of NOT_A_FILESYSTEM_TARGET) {
      expect(PATH_SCOPE_KEYS, key).not.toContain(key);
    }
  });
});
