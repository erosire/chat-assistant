// Headless test harness for the chat plugins (T3).
//
// Everything a chat plugin test needs, with NO React and NO rendering:
//
//   installFetch   - a route-matching `fetch` double plus an exact call log
//                    (url / method / parsed body), so a test can assert which
//                    namespace a write landed in, not just that state changed.
//   sseResponse    - a streamed Response whose body emits the frames a caller
//                    asks for; api/provider.ts's reader loop consumes it
//                    verbatim, so the stream deltas under test are the real
//                    SSE parser, not a stub of it.
//   storage        - the browser seam: reset + seed + read for the four keys the
//                    distribution persists (settings / model / tracked ids /
//                    offline records).
//   createTestChat - a dashboard pointed at deterministic test origins with a
//                    5ms poll interval, created AFTER the fakes are installed
//                    (both plugins kick one async load on setup, and it must hit
//                    the double rather than the deployment defaults).
//   recordEvents   - subscribes to the event ids a test cares about and returns
//                    the live log (events are live-only by contract, so the log
//                    is the assertion target and the cells stay the truth).
//
// Faked timers are deliberately NOT used: `vi.waitFor` against real 5ms polls
// keeps the tests deterministic without the fake-clock/promise-interleaving traps
// that plague streamed flows.
import { vi } from 'vitest';
import { createChatDashboard, type ChatDashboardOptions } from '../composition';
import type { Dashboard } from '@underload/dashboard';

// ——— origins every test points the composition at ———————————————————————————————

/** Conversation-storage ENDPOINT (the full path, per composition.ts's contract). */
export const TEST_BASE_URL = 'http://storage.test/v1/chat-assistant/conversation';
/** Provider BASE for the streamed catalog + completions. */
export const TEST_PROVIDER_URL = 'http://provider.test/providers/private/v1';
/** The OFFLINE-mode provider base the settings surface would persist. */
export const TEST_OFFLINE_BASE = 'http://offline.test/providers/private/v1';

// ——— fetch double ————————————————————————————————————————————————————————————————

export type FetchCall = { url: string; method: string; body: unknown };

export type FetchRoute = (url: string, init?: RequestInit) => Response | Promise<Response>;

export type FetchDouble = {
    routes: () => void;
    calls: () => FetchCall[];
    callsFor: (fragment: string) => FetchCall[];
    reset: () => void;
};

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** A JSON envelope Response, the substitute every api test in this repo uses. */
export const jsonResponse = (status: number, body: unknown): Response =>
    ({
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(JSON_HEADERS),
        json: async () => body
    }) as Response;

/**
 * A streamed Response: `body.getReader()` hands back one Uint8Array per frame, in
 * order, then `done`. `TextEncoder` produces the bytes so the production decoder
 * path is what runs.
 */
export const sseResponse = (frames: readonly string[]): Response => {
    const bytes = frames.map((frame) => new TextEncoder().encode(frame));
    let cursor = 0;
    let cancelled = false;
    return {
        ok: true,
        status: 200,
        headers: new Headers(JSON_HEADERS),
        body: {
            getReader: () => ({
                read: async (): Promise<{ done: boolean; value?: Uint8Array }> => {
                    if (cancelled || cursor >= bytes.length) return { done: true };
                    const value = bytes[cursor];
                    cursor += 1;
                    return { done: false, value };
                },
                cancel: async (): Promise<void> => {
                    cancelled = true;
                }
            })
        }
    } as unknown as Response;
};

/** One OpenAI-compatible `data:` frame (the relay's exact wire shape). */
export const sseDelta = (content: string): string =>
    `data: ${JSON.stringify({
        choices: [{ delta: { content }, finish_reason: null }]
    })}\n\n`;

/** The final usage frame a GPT-style client appends (stream_options opt-in). */
export const sseUsage = (usage: Record<string, number>): string =>
    `data: ${JSON.stringify({ usage })}\n\n`;

/** The terminator the reader loop stops on. */
export const SSE_DONE = 'data: [DONE]\n\n';

/**
 * Install the `fetch` double. Routes are matched in order by `match`; the first
 * hit answers, and an unmatched request THROWS (a silent pass-through would let a
 * typo in a route assertion look like a passing test).
 */
export function installFetch(routes: Array<{ match: (url: string) => boolean; reply: FetchRoute }>): FetchDouble {
    const log: FetchCall[] = [];
    const mock = vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        const raw = init?.body;
        const body = typeof raw === 'string' ? JSON.parse(raw) : raw ?? null;
        log.push({ url, method, body });
        for (const route of routes) {
            if (route.match(url)) return route.reply(url, init);
        }
        throw new Error(`Unrouted test request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', mock);
    return {
        routes: () => undefined,
        calls: () => log,
        callsFor: (fragment: string) => log.filter((call) => call.url.includes(fragment)),
        reset: () => {
            log.length = 0;
            mock.mockClear();
        }
    };
}

// ——— localStorage seams ———————————————————————————————————————————————————————————

export const MODEL_STORAGE_KEY = 'chat-assistant:model';
export const SETTINGS_STORAGE_KEY = 'chat-assistant:settings';
export const TRACKED_STORAGE_KEY = 'chat-assistant:tracked-conversations';
export const AGENTS_STORAGE_KEY = 'chat-assistant:agents';
export const TOOLS_STORAGE_KEY = 'chat-assistant:tools';
export const OFFLINE_STORAGE_KEY = 'chat-assistant:offline-conversations';

const ALL_KEYS = [
    MODEL_STORAGE_KEY,
    SETTINGS_STORAGE_KEY,
    TRACKED_STORAGE_KEY,
    AGENTS_STORAGE_KEY,
    TOOLS_STORAGE_KEY,
    OFFLINE_STORAGE_KEY
];

/** Clear every persisted key, so a test never inherits another's settings. */
export const resetStorage = (): void => {
    for (const key of ALL_KEYS) window.localStorage.removeItem(key);
};

/** Seed the assistant settings exactly as api/offline.ts persists them. */
export const seedSettings = (mode: 'online' | 'offline', providerBase = ''): void => {
    window.localStorage.setItem(
        SETTINGS_STORAGE_KEY,
        JSON.stringify({ mode, providerBase })
    );
};

/** Seed the online tracked-id cache (the sidebar's authority). */
export const seedTrackedIds = (ids: readonly string[]): void => {
    window.localStorage.setItem(TRACKED_STORAGE_KEY, JSON.stringify([...ids]));
};

export const readTrackedIds = (): string[] => {
    const raw = window.localStorage.getItem(TRACKED_STORAGE_KEY);
    return raw === null ? [] : (JSON.parse(raw) as string[]);
};

/** Seed the remembered model (the last one actually used). */
export const seedModel = (id: string): void => {
    window.localStorage.setItem(MODEL_STORAGE_KEY, id);
};

export const readRememberedModel = (): string | null =>
    window.localStorage.getItem(MODEL_STORAGE_KEY);

/** Seed the client-side agent registry (src/agents persistence shape). */
export const seedAgents = (agents: readonly unknown[]): void => {
    window.localStorage.setItem(AGENTS_STORAGE_KEY, JSON.stringify([...agents]));
};

// ——— dashboard construction ———————————————————————————————————————————————————————

/**
 * Build a chat dashboard for a test: the two origins above plus a 5ms poll
 * interval. Call it AFTER `installFetch`/`seed*` — the sessions and source plugins
 * both start their first async load one microtask after setup, and that load must
 * hit the double.
 */
export function createTestChat(options: Partial<ChatDashboardOptions> = {}): Dashboard {
    return createChatDashboard({
        baseUrl: TEST_BASE_URL,
        providerUrl: TEST_PROVIDER_URL,
        pollIntervalMs: 5,
        ...options
    });
}

// ——— event capture ————————————————————————————————————————————————————————————————

export type RecordedEvent = { event: string; payload: unknown };

/** Subscribe to `events` on a live instance and return the append-only log. */
export function recordEvents(instance: Dashboard, events: readonly string[]): RecordedEvent[] {
    const log: RecordedEvent[] = [];
    for (const event of events) {
        instance.on(event, (payload: unknown) => {
            log.push({ event, payload });
        });
    }
    return log;
}

/** The payloads of one event id, in emission order. */
export const payloadsOf = (log: readonly RecordedEvent[], event: string): unknown[] =>
    log.filter((entry) => entry.event === event).map((entry) => entry.payload);

// ——— conversation fixtures ————————————————————————————————————————————————————————

/** One complete record, exactly as the storage server would answer it. */
export const recordFixture = (
    conversationId: string,
    overrides: Partial<{
        title: string;
        model: string;
        status: 'pending' | 'complete' | 'error';
        messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string; model?: string }>;
        createdAt: string;
        updatedAt: string;
        usage: Record<string, number>;
    }> = {}
) => {
    const messages = overrides.messages ?? [
        { role: 'user' as const, content: 'Hello assistant' },
        { role: 'assistant' as const, content: 'Hello user', model: 'test/model' }
    ];
    return {
        conversationId,
        title: overrides.title ?? 'Hello assistant',
        model: overrides.model ?? 'test/model',
        status: overrides.status ?? 'complete',
        messageCount: messages.length,
        messages,
        createdAt: overrides.createdAt ?? '2026-11-07T00:00:00.000Z',
        updatedAt: overrides.updatedAt ?? '2026-11-07T00:00:01.000Z',
        ...(overrides.usage ? { usage: overrides.usage } : {})
    };
};

/** The compact sidebar row the same record projects to. */
export const summaryFixture = (record: ReturnType<typeof recordFixture>) => ({
    conversationId: record.conversationId,
    title: record.title,
    model: record.model,
    status: record.status,
    messageCount: record.messageCount,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
});
