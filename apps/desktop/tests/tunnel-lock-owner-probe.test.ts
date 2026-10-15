import { describe, expect, it, vi } from 'vitest';
import { OWN_PROCESS_PROBE_TIMEOUT_MS, type ProcessProbeResult } from '@lnwjud/mcp-server';
import { currentProcessOwner } from '../src/main/tunnel-lock.js';

const probeCalls: { pid: number; options: { timeoutMs?: number } }[] = [];

async function fakeProbe(pid: number, options: { timeoutMs?: number } = {}): Promise<ProcessProbeResult> {
  probeCalls.push({ pid, options });
  return { state: 'live', processStartedAt: '2026-08-20T00:00:00.000Z' };
}

vi.mock('@lnwjud/mcp-server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@lnwjud/mcp-server')>()),
  probeProcessStart: fakeProbe,
}));

describe('tunnel lock owner identity probe budget', () => {
  it('probes its own process with the owner-identity budget, not the shared cross-process one', async () => {
    probeCalls.length = 0;

    const started = await currentProcessOwner();

    expect(probeCalls).toHaveLength(1);
    expect(probeCalls[0]?.pid).toBe(process.pid);
    // The value has to come from the shared owner-identity constant. The 1750ms default exists to
    // judge another process quickly and fail closed; a PowerShell cold start measures 1.8-2.1s on
    // Windows, so inheriting it made every tunnel start depend on machine load instead of identity.
    expect(probeCalls[0]?.options.timeoutMs).toBe(OWN_PROCESS_PROBE_TIMEOUT_MS);
    expect(OWN_PROCESS_PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(4_000);
    expect(started.pid).toBe(process.pid);
    expect(started.processStartedAt).toBe('2026-08-20T00:00:00.000Z');
  });
});
