import { describe, expect, it } from 'vitest';
import { ChatGptSessionStore } from './chatgpt-session-store.js';

describe('ChatGptSessionStore', () => {
  it('keeps one authenticated conversation on the same internal session across reconnects', (): void => {
    let now = 1_000;
    const store = new ChatGptSessionStore({ ttlMs: 100, maxSessions: 4, now: (): number => now });
    const first = store.resolve('client-a', 'conversation-a');
    now += 25;
    const reconnect = store.resolve('client-a', 'conversation-a');
    expect(reconnect).toBe(first);
    expect(store.stats().activeSessions).toBe(1);
  });

  it('expires a conversation into a new internal generation', (): void => {
    let now = 1_000;
    const store = new ChatGptSessionStore({ ttlMs: 100, maxSessions: 4, now: (): number => now });
    const first = store.resolve('client-a', 'conversation-a');
    now += 101;
    const second = store.resolve('client-a', 'conversation-a');
    expect(second).not.toBe(first);
    expect(store.stats()).toMatchObject({ activeSessions: 1, expirations: 1 });
  });

  it('bounds retained conversations and evicts the oldest active session', (): void => {
    let now = 1_000;
    const store = new ChatGptSessionStore({ ttlMs: 10_000, maxSessions: 2, now: (): number => now });
    const first = store.resolve('client-a', 'conversation-a');
    now += 1;
    const second = store.resolve('client-a', 'conversation-b');
    now += 1;
    const third = store.resolve('client-a', 'conversation-c');
    expect(third).not.toBe(first);
    expect(store.stats()).toMatchObject({ activeSessions: 2, evictions: 1 });
    expect(store.resolve('client-a', 'conversation-b')).toBe(second);
  });

  it('isolates clients even when they present the same conversation identifier', (): void => {
    const store = new ChatGptSessionStore({ ttlMs: 10_000, maxSessions: 4, now: (): number => 1_000 });
    const first = store.resolve('client-a', 'conversation-a');
    const second = store.resolve('client-b', 'conversation-a');
    expect(second).not.toBe(first);
  });
});
