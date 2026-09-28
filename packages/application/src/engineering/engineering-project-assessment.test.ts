import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EngineeringProjectAssessmentService } from './engineering-project-assessment.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('EngineeringProjectAssessmentService', () => {
  it('reads only applicable AGENTS scopes and the bounded project profile without writing the repository', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-engineering-assessment-'));
    temporaryRoots.push(root);
    await mkdir(path.join(root, 'src', 'feature'), { recursive: true });
    await mkdir(path.join(root, '.lnwjud'), { recursive: true });
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }), 'utf8');
    await writeFile(path.join(root, 'AGENTS.md'), 'root rules', 'utf8');
    await writeFile(path.join(root, 'src', 'AGENTS.md'), 'src rules', 'utf8');
    await writeFile(path.join(root, 'src', 'feature', 'AGENTS.md'), 'feature rules', 'utf8');
    await writeFile(path.join(root, '.lnwjud', 'project-profile.json'), JSON.stringify({
      ponytail: { mode: 'lite' },
      engineering: { mode: 'inherit', profile: 'strict', commands: { test: 'pnpm test' } },
    }), 'utf8');

    const result = await new EngineeringProjectAssessmentService().assess(root, 'src/feature/component.ts');

    expect(result.project).toMatchObject({ kind: 'node', confidence: 'strong', detectedFiles: ['package.json'] });
    expect(result.instructions.map((entry) => [entry.path, entry.status, entry.content])).toEqual([
      ['AGENTS.md', 'loaded', 'root rules'],
      ['src/AGENTS.md', 'loaded', 'src rules'],
      ['src/feature/AGENTS.md', 'loaded', 'feature rules'],
    ]);
    expect(result.projectProfileStatus).toBe('loaded');
    expect(result.projectProfile).toMatchObject({ engineering: { profile: 'strict' }, ponytail: { mode: 'lite' } });
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('surfaces truncated instructions and invalid profiles instead of treating them as complete policy', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-engineering-bounds-'));
    temporaryRoots.push(root);
    await mkdir(path.join(root, '.lnwjud'), { recursive: true });
    await writeFile(path.join(root, 'package.json'), '{}', 'utf8');
    await writeFile(path.join(root, 'AGENTS.md'), 'x'.repeat(64 * 1024 + 1), 'utf8');
    await writeFile(path.join(root, '.lnwjud', 'project-profile.json'), JSON.stringify({ engineering: { mode: 'on' } }), 'utf8');

    const result = await new EngineeringProjectAssessmentService().assess(root);

    expect(result.instructions[0]).toMatchObject({ path: 'AGENTS.md', status: 'truncated', bytes: 64 * 1024 + 1 });
    expect(result.projectProfileStatus).toBe('invalid');
    expect(result.projectProfile).toEqual({});
    expect(result.warnings.join('\n')).toMatch(/truncated|inherit or off/i);
  });

  it('rejects a scoped path that escapes the registered project root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-engineering-scope-'));
    temporaryRoots.push(root);
    await writeFile(path.join(root, 'package.json'), '{}', 'utf8');

    await expect(new EngineeringProjectAssessmentService().assess(root, '../outside.ts')).rejects.toThrow(/escapes the project root/i);
  });

  it('rejects an in-root scoped symlink that resolves outside the registered project root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-engineering-symlink-root-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-engineering-symlink-outside-'));
    temporaryRoots.push(root, outside);
    await writeFile(path.join(root, 'package.json'), '{}', 'utf8');
    await writeFile(path.join(outside, 'AGENTS.md'), 'outside rules', 'utf8');
    await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');

    await expect(new EngineeringProjectAssessmentService().assess(root, 'linked/component.ts')).rejects.toThrow(/symlink|escapes the project root/i);
  });
});
