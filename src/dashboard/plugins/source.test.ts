// Chat SOURCE plugin tests: services, the streaming send pipeline, the epoch
// guard (R7) and the R14 poller.
//
// The send assertions are the heart of T3: they pin the payload the provider
// receives, the namespace every write lands in, and the exact cell/event sequence
// a user sees. `fetch` is the harness double, so the SSE reader loop, the usage
// frame and the abort path are the PRODUCTION code under test — only the network
// itself is faked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dashboard } from '@underload/dashboard';
import {
    CHAT_ACTIVE_SESSION_STATE,
    CHAT_CELLS_SERVICE,
    CHAT_CONVERSATIONS_SERVICE,
    CHAT_DRAFT_STATE,
    CHAT_ERROR_EVENT,
    CHAT_ERROR_STATE,
    CHAT_MESSAGE_CANCEL_COMMAND,
    CHAT_MESSAGE_SEND_COMMAND,
    CHAT_MODE_STATE,
    CHAT_MODELS_STATE,
    CHAT_MODEL_STATE,
    CHAT_PENDING_STATE,
    CHAT_PROVIDER_BASE_STATE,
    CHAT_PROVIDER_SERVICE,
    CHAT_SESSION_CREATED_EVENT,
    CHAT_SESSION_SELECT_COMMAND,
    CHAT_SESSIONS_STATE,
    CHAT_STATUS_STATE,
    CHAT_STREAMING_STATE,
    CHAT_STREAM_CANCELLED_EVENT,
    CHAT_STREAM_COMPLETED_EVENT,
    CHAT_STREAM_DELTA_EVENT,
    CHAT_STREAM_STARTED_EVENT,
    CHAT_SYSTEM_DRAFT_STATE,
    CHAT_TRANSCRIPT_STATE,
    CHAT_TRANSCRIPT_UPDATED_EVENT,
    CHAT_USAGE_STATE,
    type ChatCells,
    type ChatMode,
    type ChatPendingTurn,
    type ChatSession,
    type NoticeEvent
} from '../contract';
import type { ConversationStore } from '../services/conversations';
import type { ProviderClient } from '../services/provider';
import {
    jsonResponse,
    installFetch,
    payloadsOf,
    recordEvents,
    readTrackedIds,
    readRememberedModel,
    resetStorage,
    createTestChat,
    seedModel,
    seedSettings,
    seedTrackedIds,
    sseDelta,
    sseUsage,
    sseResponse,
    SSE_DONE,
    TEST_BASE_URL,
    TEST_OFFLINE_BASE,
    TEST_PROVIDER_URL,
    recordFixture,
    summaryFixture,
    type FetchCall,
    type FetchDouble
} from './harness';

const PROVIDER_MODELS = `${TEST_PROVIDER_URL}/models`;
const PROVIDER_COMPLETIONS = `${TEST_PROVIDER_URL}/chat/completions`;
const OFFLINE_MODELS = `${TEST_OFFLINE_BASE}/models`;

/** The catalog every case answers: three ids, deliberately unsorted by prefix. */
const catalogRoute = (url = PROVIDER_MODELS) => ({
    match: (candidate: string) => candidate === url,
    reply: () =>
        jsonResponse(200, {
            object: 'list',
            data: [{ id: 'zeta/turbo' }, { id: 'alpha/flash' }, { id: 'prefixless' }]
        })
});

/** A streamed completion answering with the given content deltas. */
const completionRoute = (deltas: readonly string[], usage?: Record<string, number>) => ({
    match: (url: string) => url === PROVIDER_COMPLETIONS,
    reply: () => {
        const frames = deltas.map(sseDelta);
        if (usage) frames.push(sseUsage(usage));
        frames.push(SSE_DONE);
        return sseResponse(frames);
    }
});

/**
 * A streamed completion that waits between frames AND honours the caller's abort
 * signal, the way undici does: the test can therefore observe a delta, cancel (or
 * switch the mode) BETWEEN frames, and the partial text that reached the surface is
 * exactly what the abort path reports.
 */
const pacedCompletionRoute = (
    deltas: readonly string[],
    usage?: Record<string, number>
) => ({
    match: (url: string) => url === PROVIDER_COMPLETIONS,
    reply: (_url: string, init?: RequestInit) => {
        const frames = deltas.map(sseDelta);
        if (usage) frames.push(sseUsage(usage));
        frames.push(SSE_DONE);
        return pacedStream(frames, init?.signal ?? null);
    }
});

const emptyListRoute = {
    match: (url: string) => url.startsWith(TEST_BASE_URL),
    reply: () => jsonResponse(200, { conversations: [] })
};

const callsOf = (double: FetchDouble) =>
    double.calls().map((call: FetchCall) => [call.method, call.url]);

describe('chat source — the published services', () => {
    let instance: Dashboard | null = null;

    beforeEach(() => resetStorage());

    afterEach(() => {
        instance?.dispose();
        instance = null;
        vi.unstubAllGlobals();
    });

    it('registers chat.conversations and chat.provider', () => {
        installFetch([catalogRoute(), emptyListRoute]);
        instance = createTestChat();
        const conversations = instance.service<ConversationStore>(CHAT_CONVERSATIONS_SERVICE);
        const provider = instance.service<ProviderClient>(CHAT_PROVIDER_SERVICE);
        expect(typeof conversations.list).toBe('function');
        expect(typeof provider.stream).toBe('function');
        expect(conversations.mode).toBe('online');
    });

    it('routes the conversations facade by the LIVE cells, not by setup values', async () => {
        // THE reason the facade resolves per call: services are frozen at setup, so
        // a captured store would keep writing into the namespace that happened to be
        // active when the dashboard was built.
        const double = installFetch([catalogRoute(), emptyListRoute]);
        instance = createTestChat();
        const conversations = instance.service<ConversationStore>(CHAT_CONVERSATIONS_SERVICE);
        // Let the mount listing land first, so the call counts below are this
        // test's own requests only.
        await vi.waitFor(() => {
            expect(double.callsFor(TEST_BASE_URL).length).toBeGreaterThan(0);
        });
        double.reset();

        await conversations.list(['anything']);
        expect(double.callsFor(TEST_BASE_URL)).toHaveLength(1);

        instance.state<ChatMode>(CHAT_MODE_STATE).set('offline');
        expect(conversations.mode).toBe('offline');
        // OFFLINE storage is browser-local: the endpoint sees no further request.
        await conversations.list(['anything']);
        expect(double.callsFor(TEST_BASE_URL)).toHaveLength(1);
    });

    it('loads the catalog sorted by STRIPPED model name and adopts the remembered model', async () => {
        seedModel('zeta/turbo');
        installFetch([catalogRoute(), emptyListRoute]);
        instance = createTestChat();
        await vi.waitFor(() => {
            expect(instance?.state<readonly string[]>(CHAT_MODELS_STATE).get()).toEqual([
                'alpha/flash',
                'prefixless',
                'zeta/turbo'
            ]);
        });
        // Priority: remembered last-used model, else the first sorted entry — and
        // the catalog DEFAULT is never persisted, only an explicit pick or a model
        // that produced a turn.
        expect(instance.state<string>(CHAT_MODEL_STATE).get()).toBe('zeta/turbo');
        expect(readRememberedModel()).toBe('zeta/turbo');
    });

    it('adopts the first sorted entry when nothing is remembered, without persisting it', async () => {
        installFetch([catalogRoute(), emptyListRoute]);
        instance = createTestChat();
        await vi.waitFor(() => {
            expect(instance?.state<string>(CHAT_MODEL_STATE).get()).toBe('alpha/flash');
        });
        expect(readRememberedModel()).toBeNull();
    });

    it('persists chat-assistant:model on every model change', async () => {
        installFetch([catalogRoute(), emptyListRoute]);
        instance = createTestChat();
        instance.state<string>(CHAT_MODEL_STATE).set('prefixless');
        await vi.waitFor(() => {
            expect(readRememberedModel()).toBe('prefixless');
        });
    });

    it('issues NO offline catalog request while the base is blank', async () => {
        seedSettings('offline', '');
        seedModel('alpha/flash');
        const double = installFetch([catalogRoute(), emptyListRoute]);
        instance = createTestChat();
        await vi.waitFor(() => {
            expect(instance?.state<string>(CHAT_MODEL_STATE).get()).toBe('alpha/flash');
        });
        expect(double.calls()).toEqual([]);
        expect(instance.state<readonly string[]>(CHAT_MODELS_STATE).get()).toEqual([]);
        // The remembered model still unblocks the composer: no manual-model
        // fallback was ever invented.
        expect(instance.state<string>(CHAT_ERROR_STATE).get()).toBe('');
    });

    it('re-reads the catalog from the configured offline base', async () => {
        seedSettings('offline', TEST_OFFLINE_BASE);
        const double = installFetch([catalogRoute(OFFLINE_MODELS), emptyListRoute]);
        instance = createTestChat();
        await vi.waitFor(() => {
            expect(instance?.state<readonly string[]>(CHAT_MODELS_STATE).get()).toHaveLength(3);
        });
        expect(double.callsFor(OFFLINE_MODELS)).toHaveLength(1);
        expect(double.callsFor(PROVIDER_MODELS)).toEqual([]);

        // A settings edit re-runs the catalog for the new configuration (:2790-2794).
        instance.state<string>(CHAT_PROVIDER_BASE_STATE).set(TEST_PROVIDER_URL);
        await vi.waitFor(() => {
            expect(double.callsFor(PROVIDER_MODELS)).toHaveLength(1);
        });
    });
});

describe('chat source — the send pipeline', () => {
    let instance: Dashboard | null = null;
    let double: FetchDouble | null = null;

    beforeEach(() => {
        resetStorage();
    });

    afterEach(() => {
        instance?.dispose();
        instance = null;
        double = null;
        vi.unstubAllGlobals();
    });

    /** The online new-chat backend: pending create, canonical reads, append. */
    const newChatRoutes = (deltas: readonly string[], usage?: Record<string, number>) => {
        const created = recordFixture('conv-1', {
            title: 'New conversation',
            messages: [],
            model: 'alpha/flash',
            status: 'pending',
            createdAt: '2026-11-07T00:00:00.000Z',
            updatedAt: '2026-11-07T00:00:00.000Z'
        });
        const settled = recordFixture('conv-1', {
            title: 'Hello there',
            model: 'alpha/flash',
            status: 'complete',
            messages: [
                { role: 'user', content: 'Hello there' },
                { role: 'assistant', content: deltas.join(''), model: 'alpha/flash' }
            ],
            createdAt: '2026-11-07T00:00:00.000Z',
            updatedAt: '2026-11-07T00:00:02.000Z',
            ...(usage ? { usage } : {})
        });
        let reads = 0;
        return [
            catalogRoute(),
            completionRoute(deltas, usage),
            {
                match: (url: string) => url === TEST_BASE_URL,
                reply: () => jsonResponse(201, { conversationId: 'conv-1' })
            },
            {
                match: (url: string) => url === `${TEST_BASE_URL}/conv-1`,
                reply: (url: string, init?: RequestInit) =>
                    (init?.method ?? 'GET') === 'POST'
                        ? jsonResponse(201, { conversationId: 'conv-1' })
                        : jsonResponse(200, {
                            conversationId: 'conv-1',
                            conversation: reads++ === 0 ? created : settled
                        })
            },
            {
                match: (url: string) => url.startsWith(TEST_BASE_URL),
                reply: () => jsonResponse(200, { conversations: [] })
            }
        ];
    };

    it('streams a new chat: pending row, deltas, usage, persistence, exact requests', async () => {
        double = installFetch(
            newChatRoutes(['Hello', ' there'], { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 })
        );
        instance = createTestChat({ pollIntervalMs: 5_000 });
        const cells = instance.service<ChatCells>(CHAT_CELLS_SERVICE);
        await vi.waitFor(() => {
            expect(cells.model.get()).toBe('alpha/flash');
        });
        const events = recordEvents(instance, [
            CHAT_STREAM_STARTED_EVENT,
            CHAT_STREAM_DELTA_EVENT,
            CHAT_STREAM_COMPLETED_EVENT,
            CHAT_TRANSCRIPT_UPDATED_EVENT,
            CHAT_SESSION_CREATED_EVENT
        ]);

        cells.draft.set('Hello there');
        const send = instance.execute<void, Promise<void>>(CHAT_MESSAGE_SEND_COMMAND);

        // The pending bubble appears BEFORE the stream produces anything, and the
        // composer clears — the in-flight turn renders live, before persistence.
        await vi.waitFor(() => {
            expect(cells.pending.get()).not.toBeNull();
        });
        const pending = cells.pending.get() as ChatPendingTurn;
        expect(pending.text).toBe('Hello there');
        expect(typeof pending.at).toBe('number');
        expect(cells.draft.get()).toBe('');
        expect(cells.status.get()).toBe('sending');
        expect(cells.streaming.get()).toBe('');

        await send;

        // The whole exchange, exactly as the canonical record answered it.
        expect(cells.transcript.get()).toEqual([
            { role: 'user', content: 'Hello there' },
            { role: 'assistant', content: 'Hello there', model: 'alpha/flash' }
        ]);
        expect(cells.usage.get()).toEqual({
            prompt_tokens: 11,
            completion_tokens: 7,
            total_tokens: 18
        });
        expect(cells.pending.get()).toBeNull();
        expect(cells.streaming.get()).toBe('');
        expect(cells.status.get()).toBe('idle');
        expect(cells.error.get()).toBe('');
        expect(cells.activeSessionId.get()).toBe('conv-1');
        // The row the pending create inserted is settled by the same conversation,
        // in place (the sidebar order never jitters).
        expect(cells.sessions.get()).toEqual([summaryFixture(settledFixture())]);

        // The ONLINE new-chat contract: the record is created and TRACKED before
        // generation, then the completed pair is appended, then the canonical read.
        expect(callsOf(double!)).toEqual([
            ['GET', PROVIDER_MODELS],
            ['GET', `${TEST_BASE_URL}?ids=`],
            ['POST', TEST_BASE_URL],
            ['GET', `${TEST_BASE_URL}/conv-1`],
            ['POST', PROVIDER_COMPLETIONS],
            ['POST', `${TEST_BASE_URL}/conv-1`],
            ['GET', `${TEST_BASE_URL}/conv-1`]
        ]);
        expect(double!.callsFor(TEST_BASE_URL)[1].body).toEqual({
            model: 'alpha/flash',
            status: 'pending'
        });
        // The OpenAI-compatible payload, built by the provider client: stream +
        // usage opt-in + the full history including the leading block.
        expect(double!.callsFor(PROVIDER_COMPLETIONS)[0].body).toEqual({
            model: 'alpha/flash',
            stream: true,
            stream_options: { include_usage: true },
            messages: [{ role: 'user', content: 'Hello there' }]
        });
        expect(double!.callsFor(`${TEST_BASE_URL}/conv-1`)[1].body).toEqual({
            messages: [
                { role: 'user', content: 'Hello there' },
                { role: 'assistant', content: 'Hello there', model: 'alpha/flash' }
            ],
            model: 'alpha/flash',
            usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
        });
        expect(readTrackedIds()).toEqual(['conv-1']);
        // A completed turn makes its model the remembered one.
        expect(readRememberedModel()).toBe('alpha/flash');

        // Events: one started, one per accumulated delta, one completed, one
        // transcript update — each with the exact payload.
        expect(payloadsOf(events, CHAT_STREAM_STARTED_EVENT)).toEqual([
            { sessionId: 'conv-1', requestId: 'request-1' }
        ]);
        expect(payloadsOf(events, CHAT_STREAM_DELTA_EVENT)).toEqual([
            { sessionId: 'conv-1', requestId: 'request-1', text: 'Hello' },
            { sessionId: 'conv-1', requestId: 'request-1', text: 'Hello there' }
        ]);
        expect(payloadsOf(events, CHAT_STREAM_COMPLETED_EVENT)).toEqual([
            { sessionId: 'conv-1', requestId: 'request-1', text: 'Hello there' }
        ]);
        expect(payloadsOf(events, CHAT_TRANSCRIPT_UPDATED_EVENT)).toEqual([
            { sessionId: 'conv-1', turnCount: 2 }
        ]);
    });

    function settledFixture() {
        return recordFixture('conv-1', {
            title: 'Hello there',
            model: 'alpha/flash',
            status: 'complete',
            messages: [
                { role: 'user', content: 'Hello there' },
                { role: 'assistant', content: 'Hello there', model: 'alpha/flash' }
            ],
            createdAt: '2026-11-07T00:00:00.000Z',
            updatedAt: '2026-11-07T00:00:02.000Z',
            usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
        });
    }

    it('refuses a blank draft or a missing model without touching the network', async () => {
        double = installFetch([catalogRoute(), emptyListRoute]);
        instance = createTestChat({ pollIntervalMs: 5_000 });
        const cells = instance.service<ChatCells>(CHAT_CELLS_SERVICE);
        await vi.waitFor(() => {
            expect(cells.model.get()).toBe('alpha/flash');
        });
        double.reset();

        cells.draft.set('   ');
        await instance.execute<void, Promise<void>>(CHAT_MESSAGE_SEND_COMMAND);
        expect(cells.pending.get()).toBeNull();
        expect(cells.status.get()).toBe('idle');
        expect(double.calls()).toEqual([]);

        // A model-less surface is just as blocked, and the draft survives both tries.
        cells.draft.set('Hello');
        cells.model.set('');
        await instance.execute<void, Promise<void>>(CHAT_MESSAGE_SEND_COMMAND);
        expect(double.calls()).toEqual([]);
        expect(cells.draft.get()).toBe('Hello');
    });

    it('rolls the pending record back and restores the draft when the provider fails', async () => {
        installFetch([
            catalogRoute(),
            {
                match: (url: string) => url === PROVIDER_COMPLETIONS,
                reply: () => jsonResponse(500, { error: "Model 'alpha/flash' not found" })
            },
            {
                match: (url: string) => url === TEST_BASE_URL,
                reply: () => jsonResponse(201, { conversationId: 'conv-1' })
            },
            {
                match: (url: string) => url === `${TEST_BASE_URL}/conv-1`,
                reply: (url: string, init?: RequestInit) =>
                    (init?.method ?? 'GET') === 'DELETE'
                        ? jsonResponse(200, { conversationId: 'conv-1' })
                        : jsonResponse(200, {
                            conversationId: 'conv-1',
                            conversation: recordFixture('conv-1', {
                                title: 'New conversation',
                                messages: [],
                                model: 'alpha/flash',
                                status: 'pending'
                            })
                        })
            },
            emptyListRoute
        ]);
        instance = createTestChat({ pollIntervalMs: 5_000 });
        const cells = instance.service<ChatCells>(CHAT_CELLS_SERVICE);
        await vi.waitFor(() => {
            expect(cells.model.get()).toBe('alpha/flash');
        });
        const events = recordEvents(instance, [CHAT_ERROR_EVENT]);

        cells.draft.set('Hello there');
        await instance.execute<void, Promise<void>>(CHAT_MESSAGE_SEND_COMMAND);

        // A generation that never produced a reply saves nothing: the record is
        // deleted, the row disappears, the tracked cache is clean, the draft is back
        // for a retry, and the banner carries the provider's own message.
        expect(cells.error.get()).toBe("Model 'alpha/flash' not found");
        expect(payloadsOf(events, CHAT_ERROR_EVENT)).toEqual([
            { message: "Model 'alpha/flash' not found" } satisfies NoticeEvent
        ]);
        expect(cells.draft.get()).toBe('Hello there');
        expect(cells.pending.get()).toBeNull();
        expect(cells.streaming.get()).toBe('');
        expect(cells.status.get()).toBe('idle');
        expect(cells.sessions.get()).toEqual([]);
        expect(cells.transcript.get()).toEqual([]);
        expect(readTrackedIds()).toEqual([]);
    });

    it('cancels mid-stream: nothing is persisted, the draft comes back', async () => {
        // The stream is paced so a cancel can land between two deltas: the reader
        // loop awaits each chunk, and the abort rejects the in-flight read.
        installFetch([
            catalogRoute(),
            pacedCompletionRoute(['One', 'Two']),
            {
                match: (url: string) => url === TEST_BASE_URL,
                reply: () => jsonResponse(201, { conversationId: 'conv-1' })
            },
            {
                match: (url: string) => url === `${TEST_BASE_URL}/conv-1`,
                reply: (url: string, init?: RequestInit) =>
                    (init?.method ?? 'GET') === 'DELETE'
                        ? jsonResponse(200, { conversationId: 'conv-1' })
                        : jsonResponse(200, {
                            conversationId: 'conv-1',
                            conversation: recordFixture('conv-1', {
                                title: 'New conversation',
                                messages: [],
                                model: 'alpha/flash',
                                status: 'pending'
                            })
                        })
            },
            emptyListRoute
        ]);
        instance = createTestChat({ pollIntervalMs: 5_000 });
        const cells = instance.service<ChatCells>(CHAT_CELLS_SERVICE);
        await vi.waitFor(() => {
            expect(cells.model.get()).toBe('alpha/flash');
        });
        const events = recordEvents(instance, [
            CHAT_STREAM_CANCELLED_EVENT,
            CHAT_STREAM_COMPLETED_EVENT
        ]);

        cells.draft.set('Hello there');
        const send = instance.execute<void, Promise<void>>(CHAT_MESSAGE_SEND_COMMAND);
        await vi.waitFor(() => {
            expect(cells.streaming.get()).toBe('One');
        }, { interval: 1, timeout: 5_000 });

        expect(instance.execute<void, boolean>(CHAT_MESSAGE_CANCEL_COMMAND)).toBe(true);
        // Nothing in flight any more: a second stop is an honest false, not a throw.
        expect(instance.execute<void, boolean>(CHAT_MESSAGE_CANCEL_COMMAND)).toBe(false);

        await send;

        expect(payloadsOf(events, CHAT_STREAM_CANCELLED_EVENT)).toEqual([
            { sessionId: 'conv-1', requestId: 'request-1', text: 'One' }
        ]);
        expect(payloadsOf(events, CHAT_STREAM_COMPLETED_EVENT)).toEqual([]);
        // The partial reply is DISCARDED (nothing is persisted), the draft returns.
        expect(cells.draft.get()).toBe('Hello there');
        expect(cells.transcript.get()).toEqual([]);
        expect(cells.pending.get()).toBeNull();
        expect(cells.streaming.get()).toBe('');
        expect(cells.status.get()).toBe('idle');
        expect(cells.sessions.get()).toEqual([]);
        expect(readTrackedIds()).toEqual([]);
    });

    it('attaches the system-prompt draft as the leading block and rewrites by PUT', async () => {
        const existing = recordFixture('conv-9', {
            title: 'Existing',
            model: 'alpha/flash',
            messages: [{ role: 'user', content: 'Earlier question' }],
            createdAt: '2026-11-07T00:00:00.000Z',
            updatedAt: '2026-11-07T00:00:01.000Z'
        });
        const rewritten = recordFixture('conv-9', {
            title: 'Existing',
            model: 'alpha/flash',
            messages: [
                { role: 'system', content: 'Answer briefly' },
                { role: 'user', content: 'Earlier question' },
                { role: 'user', content: 'Hello there' },
                { role: 'assistant', content: 'Hello there', model: 'alpha/flash' }
            ],
            createdAt: '2026-11-07T00:00:00.000Z',
            updatedAt: '2026-11-07T00:00:03.000Z',
            usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }
        });
        seedTrackedIds(['conv-9']);
        double = installFetch([
            catalogRoute(),
            completionRoute(['Hello', ' there'], {
                prompt_tokens: 3,
                completion_tokens: 4,
                total_tokens: 7
            }),
            {
                match: (url: string) => url === `${TEST_BASE_URL}/conv-9`,
                reply: (url: string, init?: RequestInit) =>
                    (init?.method ?? 'GET') === 'PUT'
                        ? jsonResponse(200, { conversationId: 'conv-9', conversation: rewritten })
                        : jsonResponse(200, { conversationId: 'conv-9', conversation: existing })
            },
            {
                match: (url: string) => url.startsWith(TEST_BASE_URL),
                reply: () => jsonResponse(200, { conversations: [summaryFixture(existing)] })
            }
        ]);
        instance = createTestChat({ pollIntervalMs: 5_000 });
        const cells = instance.service<ChatCells>(CHAT_CELLS_SERVICE);
        await vi.waitFor(() => {
            expect(cells.model.get()).toBe('alpha/flash');
        });
        await instance.execute<string, Promise<void>>('chat.session.select', 'conv-9');
        double.reset();

        cells.systemDraft.set('Answer briefly');
        cells.draft.set('Hello there');
        await instance.execute<void, Promise<void>>(CHAT_MESSAGE_SEND_COMMAND);

        // An existing chat gaining its FIRST leading block cannot append it (a POST
        // attaches at the END), so the whole history is replaced through the
        // identified PUT with the block at index 0 (:4032-4042).
        expect(callsOf(double!)).toEqual([
            ['POST', PROVIDER_COMPLETIONS],
            ['PUT', `${TEST_BASE_URL}/conv-9`]
        ]);
        expect(double!.callsFor(`${TEST_BASE_URL}/conv-9`)[0].body).toEqual({
            messages: [
                { role: 'system', content: 'Answer briefly' },
                { role: 'user', content: 'Earlier question' },
                { role: 'user', content: 'Hello there' },
                { role: 'assistant', content: 'Hello there', model: 'alpha/flash' }
            ],
            usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }
        });
        expect(double!.callsFor(PROVIDER_COMPLETIONS)[0].body).toEqual({
            model: 'alpha/flash',
            stream: true,
            stream_options: { include_usage: true },
            messages: [
                { role: 'system', content: 'Answer briefly' },
                { role: 'user', content: 'Earlier question' },
                { role: 'user', content: 'Hello there' }
            ]
        });
        expect(cells.transcript.get()).toEqual(rewritten.messages);
        expect(cells.usage.get()).toEqual({
            prompt_tokens: 3,
            completion_tokens: 4,
            total_tokens: 7
        });
        // The draft prompt is now persisted, so it and its editor clear.
        expect(cells.systemDraft.get()).toBe('');
        expect(cells.activeSessionId.get()).toBe('conv-9');
    });

    it('rejects an offline send with a blank provider base and sends nothing', async () => {
        seedSettings('offline', '');
        seedModel('alpha/flash');
        const double = installFetch([emptyListRoute]);
        instance = createTestChat({ pollIntervalMs: 5_000 });
        const cells = instance.service<ChatCells>(CHAT_CELLS_SERVICE);
        // The mount listing is a real flow, so the busy tracker legitimately shows
        // 'loading' until it lands; settle it before judging what the SEND left
        // behind.
        await vi.waitFor(() => {
            expect(cells.status.get()).toBe('idle');
        });

        cells.draft.set('Hello there');
        await instance.execute<void, Promise<void>>(CHAT_MESSAGE_SEND_COMMAND);
        // The mount listing is still settling in the background, so the tracker may
        // legitimately show 'loading' for one tick; wait for the quiet state before
        // asserting the label the SEND left behind.
        await vi.waitFor(() => {
            expect(cells.status.get()).toBe('idle');
        });

        // No silent call to the default app server: the banner explains the
        // configuration need instead (:4003-4008).
        expect(cells.error.get()).toContain('Configure the offline provider base URL');
        expect(double.calls()).toEqual([]);
        expect(cells.draft.get()).toBe('Hello there');
        expect(cells.status.get()).toBe('idle');
    });
});

describe('chat source — the epoch guard mid-flight (R7)', () => {
    let instance: Dashboard | null = null;
    let double: FetchDouble | null = null;

    beforeEach(() => resetStorage());

    afterEach(() => {
        instance?.dispose();
        instance = null;
        double = null;
        vi.unstubAllGlobals();
    });

    it('an online->offline switch mid-stream never touches the new namespace', async () => {
        // THE regression: the stream keeps running, the ONLINE record keeps being
        // written, and every surface cell belongs to OFFLINE now.
        const onlinePending = recordFixture('conv-1', {
            title: 'New conversation',
            messages: [],
            model: 'alpha/flash',
            status: 'pending'
        });
        const onlineSettled = recordFixture('conv-1', {
            title: 'Hello there',
            model: 'alpha/flash',
            status: 'complete',
            messages: [
                { role: 'user', content: 'Hello there' },
                { role: 'assistant', content: 'OneTwo', model: 'alpha/flash' }
            ],
            usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 }
        });
        let reads = 0;
        double = installFetch([
            catalogRoute(),
            pacedCompletionRoute(['One', 'Two'], {
                prompt_tokens: 5,
                completion_tokens: 6,
                total_tokens: 11
            }),
            {
                match: (url: string) => url === TEST_BASE_URL,
                reply: () => jsonResponse(201, { conversationId: 'conv-1' })
            },
            {
                match: (url: string) => url === `${TEST_BASE_URL}/conv-1`,
                reply: (url: string, init?: RequestInit) =>
                    (init?.method ?? 'GET') === 'POST'
                        ? jsonResponse(201, { conversationId: 'conv-1' })
                        : jsonResponse(200, {
                            conversationId: 'conv-1',
                            conversation: reads++ === 0 ? onlinePending : onlineSettled
                        })
            },
            emptyListRoute
        ]);
        instance = createTestChat({ pollIntervalMs: 5_000 });
        const cells = instance.service<ChatCells>(CHAT_CELLS_SERVICE);
        await vi.waitFor(() => {
            expect(cells.model.get()).toBe('alpha/flash');
        });

        cells.draft.set('Hello there');
        const send = instance.execute<void, Promise<void>>(CHAT_MESSAGE_SEND_COMMAND);
        await vi.waitFor(() => {
            expect(cells.streaming.get()).toBe('One');
        }, { interval: 1, timeout: 5_000 });

        // Flip the namespace while the stream is between two deltas.
        instance.state<ChatMode>(CHAT_MODE_STATE).set('offline');
        expect(cells.streaming.get()).toBe('');
        expect(cells.pending.get()).toBeNull();
        expect(cells.sessions.get()).toEqual([]);
        expect(cells.activeSessionId.get()).toBeNull();

        await send;

        // The OFFLINE surface never saw the online turn: no transcript, no streaming
        // buffer, no row, no banner from the other namespace.
        expect(cells.transcript.get()).toEqual([]);
        expect(cells.streaming.get()).toBe('');
        expect(cells.pending.get()).toBeNull();
        expect(cells.sessions.get()).toEqual([]);
        expect(cells.usage.get()).toBeNull();
        expect(cells.error.get()).toBe('');
        expect(cells.activeSessionId.get()).toBeNull();
        expect(cells.status.get()).toBe('idle');

        // ...while the ONLINE namespace got the whole turn: create, canonical read,
        // the append with the completed pair, and the read-back. Nothing went to the
        // offline local store.
        expect(callsOf(double!)).toEqual([
            ['GET', PROVIDER_MODELS],
            ['GET', `${TEST_BASE_URL}?ids=`],
            ['POST', TEST_BASE_URL],
            ['GET', `${TEST_BASE_URL}/conv-1`],
            ['POST', PROVIDER_COMPLETIONS],
            ['POST', `${TEST_BASE_URL}/conv-1`],
            ['GET', `${TEST_BASE_URL}/conv-1`]
        ]);
        expect(double!.callsFor(`${TEST_BASE_URL}/conv-1`)[1].body).toEqual({
            messages: [
                { role: 'user', content: 'Hello there' },
                { role: 'assistant', content: 'OneTwo', model: 'alpha/flash' }
            ],
            model: 'alpha/flash',
            usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 }
        });
        const offline = window.localStorage.getItem('chat-assistant:offline-conversations');
        expect(offline).toBeNull();
        // The draft the OFFLINE surface owns was never overwritten by the online send.
        expect(cells.draft.get()).toBe('');
    });

    it('a session switch mid-stream stops the deltas from landing on the new chat', async () => {
        const record = recordFixture('conv-2', {
            title: 'Other chat',
            messages: [{ role: 'user', content: 'Something else' }],
            model: 'alpha/flash'
        });
        const pending = recordFixture('conv-1', {
            title: 'New conversation',
            messages: [],
            model: 'alpha/flash',
            status: 'pending'
        });
        installFetch([
            catalogRoute(),
            pacedCompletionRoute(['One', 'Two']),
            {
                // The send's own new-chat record, so the abort window is real.
                match: (url: string) => url === TEST_BASE_URL,
                reply: () => jsonResponse(201, { conversationId: 'conv-1' })
            },
            {
                match: (url: string) => url === `${TEST_BASE_URL}/conv-1`,
                reply: () => jsonResponse(200, { conversationId: 'conv-1', conversation: pending })
            },
            {
                match: (url: string) => url === `${TEST_BASE_URL}/conv-2`,
                reply: () => jsonResponse(200, { conversationId: 'conv-2', conversation: record })
            },
            {
                match: (url: string) => url.startsWith(TEST_BASE_URL),
                reply: () => jsonResponse(200, { conversations: [] })
            }
        ]);
        instance = createTestChat({ pollIntervalMs: 5_000 });
        const cells = instance.service<ChatCells>(CHAT_CELLS_SERVICE);
        await vi.waitFor(() => {
            expect(cells.model.get()).toBe('alpha/flash');
        });

        cells.draft.set('Hello there');
        void instance.execute<void, Promise<void>>(CHAT_MESSAGE_SEND_COMMAND);
        await vi.waitFor(() => {
            expect(cells.streaming.get()).toBe('One');
        }, { interval: 1, timeout: 5_000 });

        await instance.execute<string, Promise<void>>(CHAT_SESSION_SELECT_COMMAND, 'conv-2');
        await vi.waitFor(() => {
            expect(cells.transcript.get()).toEqual(record.messages);
        });
        // The abandoned stream's tokens no longer write into the surface the operator
        // is reading (the reported bug: the bubbles flooded the newly opened chat).
        expect(cells.streaming.get()).toBe('');
        expect(cells.pending.get()).toBeNull();
        expect(cells.activeSessionId.get()).toBe('conv-2');
    });
});

describe('chat source — R14 pending-conversation polling', () => {
    let instance: Dashboard | null = null;
    let double: FetchDouble | null = null;

    beforeEach(() => resetStorage());

    afterEach(() => {
        instance?.dispose();
        instance = null;
        double = null;
        vi.unstubAllGlobals();
    });

    it('merges a settled record into the open chat and then stops polling', async () => {
        const pending = recordFixture('conv-p', {
            title: 'New conversation',
            messages: [],
            model: 'alpha/flash',
            status: 'pending'
        });
        const settled = recordFixture('conv-p', {
            title: 'Finished elsewhere',
            model: 'alpha/flash',
            status: 'complete',
            messages: [
                { role: 'user', content: 'Finished elsewhere' },
                { role: 'assistant', content: 'Answered in another tab', model: 'alpha/flash' }
            ],
            updatedAt: '2026-11-07T00:00:05.000Z'
        });
        let reads = 0;
        seedTrackedIds(['conv-p']);
        double = installFetch([
            catalogRoute(),
            {
                match: (url: string) => url === `${TEST_BASE_URL}/conv-p`,
                reply: () =>
                    jsonResponse(200, {
                        conversationId: 'conv-p',
                        // The turn is finished by "another tab" after the first poll.
                        conversation: reads++ === 0 ? pending : settled
                    })
            },
            {
                match: (url: string) => url.startsWith(TEST_BASE_URL),
                reply: () => jsonResponse(200, { conversations: [summaryFixture(pending)] })
            }
        ]);
        // The R14 cadence is the subject here, so this pair keeps the harness's
        // 5ms override instead of the 5s one the other cases use to keep their
        // request logs free of poll traffic.
        instance = createTestChat();
        const cells = instance.service<ChatCells>(CHAT_CELLS_SERVICE);
        await vi.waitFor(() => {
            expect(cells.sessions.get()).toHaveLength(1);
        });
        expect(cells.sessions.get()[0].status).toBe('pending');

        await instance.execute<string, Promise<void>>(CHAT_SESSION_SELECT_COMMAND, 'conv-p');
        expect(cells.transcript.get()).toEqual([]);

        // 5ms cadence (createTestChat's override): the row settles in the sidebar and
        // the open surface adopts the finished turn.
        await vi.waitFor(() => {
            expect(cells.transcript.get()).toEqual(settled.messages);
        });
        expect(cells.sessions.get()).toEqual([summaryFixture(settled)]);
        expect(cells.usage.get()).toBeNull();
        const readsAfter = double.callsFor(`${TEST_BASE_URL}/conv-p`).length;
        await new Promise((resolve) => setTimeout(resolve, 40));
        // Polling stopped: the conversation is no longer pending, so nothing is
        // waiting on it (a settled record is never polled forever).
        expect(double.callsFor(`${TEST_BASE_URL}/conv-p`).length).toBe(readsAfter);
    });

    it('untracks and drops a conversation that vanished server-side', async () => {
        const doomed = recordFixture('conv-gone', {
            title: 'Doomed',
            model: 'alpha/flash',
            messages: [{ role: 'user', content: 'Doomed' }],
            status: 'pending'
        });
        seedTrackedIds(['conv-gone']);
        // The row is readable while it is opened, and gone from the very next read on:
        // that is the case the poller's not-found branch exists for (deleted in another
        // tab/device after this browser started watching it).
        let reads = 0;
        double = installFetch([
            catalogRoute(),
            {
                match: (url: string) => url === `${TEST_BASE_URL}/conv-gone`,
                reply: () =>
                    reads++ === 0
                        ? jsonResponse(200, { conversationId: 'conv-gone', conversation: doomed })
                        : jsonResponse(404, { error: "Conversation 'conv-gone' not found" })
            },
            {
                match: (url: string) => url.startsWith(TEST_BASE_URL),
                reply: () => jsonResponse(200, { conversations: [summaryFixture(doomed)] })
            }
        ]);
        // The R14 cadence is the subject here, so this pair keeps the harness's
        // 5ms override instead of the 5s one the other cases use to keep their
        // request logs free of poll traffic.
        instance = createTestChat();
        const cells = instance.service<ChatCells>(CHAT_CELLS_SERVICE);
        await vi.waitFor(() => {
            expect(cells.sessions.get()).toHaveLength(1);
        });
        await instance.execute<string, Promise<void>>(CHAT_SESSION_SELECT_COMMAND, 'conv-gone');
        // The pending row is what arms the watch (the oracle's `pendingConversationId`).
        expect(cells.activeSessionId.get()).toBe('conv-gone');
        expect(cells.transcript.get()).toEqual(doomed.messages);

        await vi.waitFor(() => {
            expect(cells.sessions.get()).toEqual([]);
        });
        // untrack + drop, and NOTHING else: the surface keeps the record it is showing
        // (:2874-2884 never clears `selected`), and the failure is not a banner
        expect(readTrackedIds()).toEqual([]);
        expect(cells.transcript.get()).toEqual(doomed.messages);
        expect(cells.activeSessionId.get()).toBe('conv-gone');
        expect(cells.error.get()).toBe('');
        expect(cells.status.get()).toBe('idle');
        // the read that answered 404 is the open read plus at least one watch tick
        expect(double.callsFor(`${TEST_BASE_URL}/conv-gone`).length).toBeGreaterThanOrEqual(2);
        const readsAfterDrop = double.callsFor(`${TEST_BASE_URL}/conv-gone`).length;
        await new Promise((resolve) => setTimeout(resolve, 40));
        // the watch stopped: a vanished conversation is not polled forever
        expect(double.callsFor(`${TEST_BASE_URL}/conv-gone`).length).toBe(readsAfterDrop);
    });
});

// ——— helpers local to this file —————————————————————————————————————————————————

/**
 * A streamed Response that waits one macrotask per frame, so a test can observe a
 * delta and cancel (or switch the mode) BETWEEN frames — the window the shipped
 * UI has and a synchronous fake stream would hide. An aborted signal makes the
 * next read reject with the platform AbortError, exactly like undici.
 */
function pacedStream(frames: readonly string[], signal: AbortSignal | null): Response {
    const bytes = frames.map((frame) => new TextEncoder().encode(frame));
    let cursor = 0;
    let cancelled = false;
    const aborted = () => cancelled || signal?.aborted === true;
    return {
        ok: true,
        status: 200,
        json: async () => ({}),
        body: {
            getReader: () => ({
                read: async (): Promise<{ done: boolean; value?: Uint8Array }> => {
                    if (aborted()) throw abortError();
                    await new Promise((resolve) => setTimeout(resolve, 25));
                    if (aborted()) throw abortError();
                    if (cursor >= bytes.length) return { done: true };
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
}

/** The platform abort shape undici/jsdom surface: a DOMException named AbortError. */
function abortError(): Error & { name: string } {
    const error = new Error('The operation was aborted.') as Error & { name: string };
    error.name = 'AbortError';
    return error;
}
