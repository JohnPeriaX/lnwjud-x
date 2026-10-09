import { describe, expect, it } from 'vitest';
import { ChatGptSessionStore } from './chatgpt-session-store.js';

describe('ChatGptSessionStore', () => {
  it('keeps one authenticated conversation on the same internal session across reconnects', () => {
    let now = 1_000;
    const store = new ChatGptSessionStore({ ttlMs: 100, maxSessions: 4, now: () => now });
    const first = store.resolve('client-a', 'conversation-a');
    now += 25;
    const reconnect = store.resolve('client-a', 'conversation-a');
    expect(reconnect).toBe(first);
    expect(store.stats().activeSessions).toBe(1);
  });

  it('expires a conversation into a new internal generation so stale workspace/process ownership cannot be reused', () => {
    let now = 1_000;
    const store = new ChatGptSessionStore({ ttlMs: 100, maxSessions: 4, now: () => now });
    const first = store.resolve('client-a', 'conversation-a');
    const firstBinding = store.bindingFor({ clientId: 'client-a', clientName: 'test', sessionId: first });
    expect(firstBinding?.bind('workspace-a')).toBe(true);
    now += 101;
    const second = store.resolve('client-a', 'conversation-a');
    expect(second).not.toBe(first);
    const secondBinding = store.bindingFor({ clientId: 'client-a', clientName: 'test', sessionId: second });
    expect(secondBinding?.get()).toBeUndefined();
    expect(secondBinding?.bind('workspace-b')).toBe(true);
    expect(firstBinding?.get()).toBeUndefined();
    expect(store.stats()).toMatchObject({ activeSessions: 1, expirations: 1 });
  });

  it('bounds retained conversations and evicts the oldest active session', () => {
    let now = 1_000;
    const store = new ChatGptSessionStore({ ttlMs: 10_000, maxSessions: 2, now: () => now });
    const first = store.resolve('client-a', 'conversation-a');
    now += 1;
    const second = store.resolve('client-a', 'conversation-b');
    now += 1;
    const third = store.resolve('client-a', 'conversation-c');
    expect(third).not.toBe(first);
    expect(store.stats()).toMatchObject({ activeSessions: 2, evictions: 1 });
    expect(store.bindingFor({ clientId: 'client-a', clientName: 'test', sessionId: first })).toBeUndefined();
    expect(store.bindingFor({ clientId: 'client-a', clientName: 'test', sessionId: second })).toBeDefined();
  });

  it('isolates clients even when they present the same conversation identifier', () => {
    const store = new ChatGptSessionStore({ ttlMs: 10_000, maxSessions: 4, now: () => 1_000 });
    const first = store.resolve('client-a', 'conversation-a');
    const second = store.resolve('client-b', 'conversation-a');
    expect(second).not.toBe(first);
    const firstBinding = store.bindingFor({ clientId: 'client-a', clientName: 'a', sessionId: first });
    const secondBinding = store.bindingFor({ clientId: 'client-b', clientName: 'b', sessionId: second });
    expect(firstBinding?.bind('workspace-a')).toBe(true);
    expect(secondBinding?.get()).toBeUndefined();
  });
});
