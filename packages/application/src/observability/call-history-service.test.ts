import { describe, expect, it } from 'vitest';
import type { AuditCallHistoryPage, AuditCallHistoryQuery, AuditCallHistoryRow, AuditEventRepository } from '@lnwjud/audit';
import type { WorkspaceRepository } from '@lnwjud/workspace';
import type { FileActor } from '../file-service.js';
import { CallHistoryService } from './call-history-service.js';

const ACTOR: FileActor = { clientId: 'client-1', clientName: 'tester' };

const WORKSPACES = {
  get: async (workspaceId: string) => (workspaceId === 'ws-a' ? { id: 'ws-a' } : null),
} as unknown as WorkspaceRepository;

function row(overrides: Partial<AuditCallHistoryRow> = {}): AuditCallHistoryRow {
  return {
    eventId: 'event-1', callId: 'call-1', toolName: 'read_file', workspaceId: 'ws-a',
    goalId: null, resultCode: 'SUCCESS', durationMs: 11, observedTransport: 'loopback_http',
    phase: 'completed', startedAt: '2026-10-16T00:00:00.000Z', sampledAt: '2026-10-16T00:00:01.000Z',
    ...overrides,
  };
}

/** Records the queries it receives so a test can prove filtering is delegated, not post-filtered. */
function auditRepository(items: readonly AuditCallHistoryRow[]): { repository: Pick<AuditEventRepository, 'listCallHistory'>; queries: AuditCallHistoryQuery[] } {
  const queries: AuditCallHistoryQuery[] = [];
  return {
    queries,
    repository: {
      listCallHistory: async (query: AuditCallHistoryQuery): Promise<AuditCallHistoryPage> => {
        queries.push(query);
        return { items, nextCursor: null };
      },
    },
  };
}

describe('CallHistoryService transport attribution', () => {
  it('surfaces the transport the server observed and keeps legacy rows unknown', async () => {
    const audit = auditRepository([
      row({ eventId: 'event-stdio', observedTransport: 'local_stdio' }),
      row({ eventId: 'event-http', observedTransport: 'loopback_http' }),
      row({ eventId: 'event-legacy', observedTransport: null }),
    ]);
    const service = new CallHistoryService(WORKSPACES, audit.repository, () => new Date('2026-10-16T00:00:02.000Z'));
    const result = await service.history(ACTOR, { workspaceId: 'ws-a' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.map((item) => item.transport)).toEqual(['local_stdio', 'loopback_http', 'unknown']);
    expect(result.value.coverage).toBe('partial');
  });

  it('delegates an observable transport filter to the audit repository', async () => {
    const audit = auditRepository([row({ observedTransport: 'local_stdio' })]);
    const service = new CallHistoryService(WORKSPACES, audit.repository);
    const result = await service.history(ACTOR, { workspaceId: 'ws-a', transport: 'local_stdio' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(audit.queries).toHaveLength(1);
    expect(audit.queries[0]?.observedTransport).toBe('local_stdio');
    expect(result.value.items.map((item) => item.transport)).toEqual(['local_stdio']);
  });

  it('returns an empty unknown-coverage page for a transport this process never observes', async () => {
    // The ChatGPT secure tunnel terminates in the local tunnel-client, so lnwjud
    // sees loopback HTTP. Relabelling loopback rows as secure_tunnel would invent
    // evidence, and an empty page must not be read as a connector outage.
    const audit = auditRepository([row({ observedTransport: 'loopback_http' })]);
    const service = new CallHistoryService(WORKSPACES, audit.repository);
    const result = await service.history(ACTOR, { workspaceId: 'ws-a', transport: 'secure_tunnel' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items).toEqual([]);
    expect(result.value.coverage).toBe('unknown');
    expect(audit.queries).toEqual([]);
  });
});
