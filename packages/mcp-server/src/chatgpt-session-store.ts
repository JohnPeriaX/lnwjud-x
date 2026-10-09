import { createHash, randomUUID } from 'node:crypto';
import type { FileActor } from '@lnwjud/application';
import type { ConversationWorkspaceBinding } from './tool-registry.js';

export interface ChatGptSessionStoreOptions {
  readonly maxSessions?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export interface ChatGptSessionStoreStats {
  readonly activeSessions: number;
  readonly maxSessions: number;
  readonly ttlMs: number;
  readonly evictions: number;
  readonly expirations: number;
}

interface SessionEntry {
  readonly key: string;
  readonly clientId: string;
  readonly openAiSessionId: string;
  readonly internalSessionId: string;
  workspaceId?: string;
  lastSeenMs: number;
}

const DEFAULT_MAX_SESSIONS = 256;
const DEFAULT_TTL_MS = 30 * 60 * 1_000;

/**
 * Bounded process-local identity state for ChatGPT conversations.
 *
 * The OpenAI conversation id is never used directly as an authorization token.
 * A live entry maps (authenticated client, conversation) to an internal session
 * generation. Expiration or eviction creates a new generation, so old process
 * and workspace ownership cannot be resurrected by reusing a stale conversation id.
 */
export class ChatGptSessionStore {
  private readonly entries = new Map<string, SessionEntry>();
  private readonly maxSessions: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private evictions = 0;
  private expirations = 0;
  private generation = 0;

  public constructor(options: ChatGptSessionStoreOptions = {}) {
    this.maxSessions = boundedPositiveInt(options.maxSessions ?? DEFAULT_MAX_SESSIONS, 1, 10_000);
    this.ttlMs = boundedPositiveInt(options.ttlMs ?? DEFAULT_TTL_MS, 1, 24 * 60 * 60 * 1_000);
    this.now = options.now ?? Date.now;
  }

  public resolve(clientId: string, openAiSessionId: string): string {
    const key = sessionKey(clientId, openAiSessionId);
    const now = this.now();
    this.cleanup(now);
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      existing.lastSeenMs = now;
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing.internalSessionId;
    }

    while (this.entries.size >= this.maxSessions) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
      this.evictions += 1;
    }

    this.generation += 1;
    const internalSessionId = `chatgpt-${fingerprint(openAiSessionId)}-${this.generation}-${randomUUID().slice(0, 8)}`;
    this.entries.set(key, {
      key,
      clientId,
      openAiSessionId,
      internalSessionId,
      lastSeenMs: now,
    });
    return internalSessionId;
  }

  public bindingFor(actor: FileActor): ConversationWorkspaceBinding | undefined {
    const internalSessionId = actor.sessionId;
    if (internalSessionId === undefined || !internalSessionId.startsWith('chatgpt-')) return undefined;
    const entry = this.findByInternalSessionId(internalSessionId);
    if (entry === undefined || entry.clientId !== actor.clientId) return undefined;
    return {
      get: (): string | undefined => {
        this.cleanup();
        const current = this.findByInternalSessionId(internalSessionId);
        if (current === undefined) return undefined;
        current.lastSeenMs = this.now();
        return current.workspaceId;
      },
      bind: (workspaceId: string): boolean => {
        this.cleanup();
        const current = this.findByInternalSessionId(internalSessionId);
        if (current === undefined) return false;
        current.lastSeenMs = this.now();
        if (current.workspaceId !== undefined) return current.workspaceId === workspaceId;
        current.workspaceId = workspaceId;
        return true;
      },
    };
  }

  public cleanup(now = this.now()): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (now - entry.lastSeenMs < this.ttlMs) continue;
      this.entries.delete(key);
      this.expirations += 1;
      removed += 1;
    }
    return removed;
  }

  public stats(): ChatGptSessionStoreStats {
    this.cleanup();
    return {
      activeSessions: this.entries.size,
      maxSessions: this.maxSessions,
      ttlMs: this.ttlMs,
      evictions: this.evictions,
      expirations: this.expirations,
    };
  }

  private findByInternalSessionId(internalSessionId: string): SessionEntry | undefined {
    for (const entry of this.entries.values()) {
      if (entry.internalSessionId === internalSessionId) return entry;
    }
    return undefined;
  }
}

function sessionKey(clientId: string, openAiSessionId: string): string {
  return `${clientId}\u0000${openAiSessionId}`;
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function boundedPositiveInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
