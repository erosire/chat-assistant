/**
 * INTEGRATION suite: the assembled chat graph, end to end.
 *
 * WHAT THIS FILE IS FOR (T6): every other test in src/dashboard pins ONE plugin or
 * ONE component against its own local graph. This file composes the real thing —
 * `createChatDashboard` with the full add-on set (plugins/extras.ts) — and asserts
 * the behaviour the rebuild was specified to reproduce, so a plugin that is
 * individually correct but wrong in combination fails HERE.
 *
 * THE SUBSTITUTES (and why each is honest):
 *   fetch        - plugins/harness.ts's route-matching double; an unrouted request
 *                  THROWS, so a flow that suddenly starts calling something else is
 *                  a failure rather than a silent pass.
 *   storage      - jsdom's real localStorage (cleared per test by resetStorage).
 *   the wire API - `makeServer` below: an in-memory conversation table that follows
 *                  the documented semantics of src/server/endpoints/chat-assistant
 *                  (POST collection = create + id only, POST identified = append,
 *                  PUT identified = replace whole history, GET = canonical record,
 *                  title derived from the first user turn). Writing it as a table
 *                  rather than mocking each response is what makes the persistence
 *                  assertions mean something: the values asserted below are what the
 *                  NEXT read of the fake server returns, not what the plugin echoed.
 *   timing       - real timers, and `pollIntervalMs: 60_000` everywhere except the
 *                  R14 test. The send pipeline arms the R14 poller for the whole
 *                  duration of a request (plugins/source.ts:506-512), so a 5ms cadence
 *                  would interleave extra GETs into every other scenario's fetch log;
 *                  the poller is pinned on its own clock in its own test instead.
 *
 * NO REACT: the surfaces are covered by WorkstationShell.test.tsx, the components by
 * their own files, and src/App.test.tsx. What is under test here is the graph.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dashboard } from '@underload/dashboard';
import {
    CHAT_AGENT_CREATE_COMMAND,
    CHAT_AGENT_SET_COMMAND,
    CHAT_DRAFT_SET_COMMAND,
    CHAT_MESSAGE_CANCEL_COMMAND,
    CHAT_MESSAGE_DELETE_COMMAND,
    CHAT_MESSAGE_FORK_COMMAND,
    CHAT_MESSAGE_ROLE_COMMAND,
    CHAT_MESSAGE_SEND_COMMAND,
    CHAT_MESSAGE_UPDATE_COMMAND,
    CHAT_MODE_SET_COMMAND,
    CHAT_MODEL_SET_COMMAND,
    CHAT_SESSION_CREATE_COMMAND,
    CHAT_SESSION_SELECT_COMMAND,
    CHAT_SYSTEM_BEGIN_COMMAND,
    CHAT_SYSTEM_SAVE_COMMAND,
    CHAT_TOOL_CREATE_COMMAND,
    CHAT_AGENT_STATE,
    CHAT_DRAFT_STATE,
    CHAT_ERROR_STATE,
    CHAT_MODEL_STATE,
    CHAT_MODE_STATE,
    CHAT_MODELS_STATE,
    CHAT_PENDING_STATE,
    CHAT_SESSIONS_STATE,
    CHAT_ACTIVE_SESSION_STATE,
    CHAT_STATUS_STATE,
    CHAT_STREAMING_STATE,
    CHAT_SYSTEM_DRAFT_STATE,
    CHAT_TOOL_STORE_SERVICE,
    CHAT_TRANSCRIPT_STATE,
    CHAT_TURNS_STATE,
    CHAT_USAGE_STATE,
    CHAT_STREAM_COMPLETED_EVENT,
    CHAT_STREAM_CANCELLED_EVENT,
    CHAT_STREAM_DELTA_EVENT,
    CHAT_STREAM_STARTED_EVENT,
    CHAT_TRANSCRIPT_UPDATED_EVENT,
    type ChatMode,
    type ChatPendingTurn,
    type ChatSession,
    type ChatStatus,
    type ChatTranscript,
    type ChatTurn,
    type ChatUsage
} from './contract';
import {
    AGENTS_STORAGE_KEY,
    MODEL_STORAGE_KEY,
    OFFLINE_STORAGE_KEY,
    SETTINGS_STORAGE_KEY,
    TEST_BASE_URL,
    TEST_OFFLINE_BASE,
    TEST_PROVIDER_URL,
    TOOLS_STORAGE_KEY,
    TRACKED_STORAGE_KEY,
    createTestChat,
    installFetch,
    jsonResponse,
    payloadsOf,
    readTrackedIds,
    recordEvents,
    recordFixture,
    resetStorage,
    seedAgents,
    seedModel,
    seedSettings,
    seedTrackedIds,
    sseDelta,
    sseResponse,
    sseUsage,
    SSE_DONE,
    type FetchDouble,
    type RecordedEvent
} from './plugins/harness';

// ——— the wire double —————————————————————————————————————————————————————————————

const MODELS_URL = `${TEST_PROVIDER_URL}/models`;
const COMPLETIONS_URL = `${TEST_PROVIDER_URL}/chat/completions`;
/** One conversation resource, exactly as api/chat-assistant.ts addresses it. */
const conversationUrl = (id: string): string => `${TEST_BASE_URL}/${encodeURIComponent(id)}`;
/** The scoped collection read every mode runs on mount (empty tracked cache = `?ids=`). */
const LIST_URL = `${TEST_BASE_URL}?ids=`;

type Role = 'system' | 'user' | 'assistant';
type StoredMessage = { role: Role; content: string; model?: string };
type StoredRecord = ReturnType<typeof recordFixture>;

/**
 * The server's title rule, verbatim (endpoints/chat-assistant/chat-assistant.ts:88-95):
 * the trimmed FIRST LINE of the first user turn, 'New conversation' when none
 * contributes one, capped at 80 characters.
 */
const deriveTitle = (messages: readonly StoredMessage[]): string => {
    const firstUser = messages.find((message) => message.role === 'user');
    const firstLine = (firstUser?.content.trim().split('\n', 1)[0] ?? '').trim();
    const title = firstLine || 'New conversation';
    return title.length > 80 ? `${title.slice(0, 77)}...` : title;
};

/** The compact row the list endpoint answers with. */
const toSummary = (record: StoredRecord) => ({
    conversationId: record.conversationId,
    title: record.title,
    model: record.model,
    status: record.status,
    messageCount: record.messageCount,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
});

/**
 * One scripted completion answer. A Response is returned straight away; a function
 * lets a test hold the request open (the cancel and mid-flight-switch scenarios) and
 * decide when the stream actually starts.
 */
type CompletionAnswer = Response | (() => Response | Promise<Response>);

type ServerScript = {
    /** The GET {provider}/models catalog. */
    models?: readonly string[];
    /** Records the table starts with (the "already on the server" state). */
    records?: readonly StoredRecord[];
    /** Ids handed to successive create POSTs, in order. */
    createdIds?: readonly string[];
    /** One entry per POST {provider}/chat/completions, in order. */
    completions?: readonly CompletionAnswer[];
};

type Server = {
    fetch: FetchDouble;
    /** Live table: mutate it to change what the next read answers (the R14 settle). */
    table: Map<string, StoredRecord>;
    /** Parsed bodies of the completion POSTs, in order. */
    completionBodies: () => Record<string, unknown>[];
    /** Every storage call (method + url + parsed body), in call order. */
    storageCalls: () => Array<{ method: string; url: string; body: unknown }>;
};

/**
 * Build the fake backend. One route answers every storage URL and dispatches on the
 * method, because the plugin under test chooses the method and this table has to
 * react to all four verbs the same way the server handler does.
 */
function makeServer(script: ServerScript = {}): Server {
    const table = new Map<string, StoredRecord>();
    for (const record of script.records ?? []) table.set(record.conversationId, record);

    const createdIds = [...(script.createdIds ?? [])];
    const completions = [...(script.completions ?? [])];
    const completionBodies: Record<string, unknown>[] = [];
    const storageLog: Array<{ method: string; url: string; body: unknown }> = [];

    const answers = (index: number): CompletionAnswer | undefined =>
        index < completions.length ? completions[index] : completions[completions.length - 1];

    const fetchDouble = installFetch([
        {
            match: (url) => url === MODELS_URL,
            reply: () =>
                jsonResponse(
                    200,
                    // The relay's envelope: entries are objects with an `id`.
                    { object: 'list', data: (script.models ?? []).map((id) => ({ id })) }
                )
        },
        {
            match: (url) => url === COMPLETIONS_URL,
            reply: async (_url, init) => {
                const index = completionBodies.length;
                completionBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
                const answer = answers(index);
                return typeof answer === 'function' ? await answer() : answer ?? jsonResponse(500, { error: 'No scripted completion' });
            }
        },
        {
            match: (url) => url === TEST_BASE_URL || url.startsWith(`${TEST_BASE_URL}/`) || url.startsWith(`${TEST_BASE_URL}?`),
            reply: (url, init) => {
                const method = (init?.method ?? 'GET').toUpperCase();
                // The double logs a parsed body; the table needs the same parse.
                const body: unknown =
                    typeof init?.body === 'string' ? JSON.parse(init.body) : (init?.body ?? null);
                storageLog.push({ method, url, body });
                const path = url.startsWith(`${TEST_BASE_URL}/`) ? url.slice(TEST_BASE_URL.length + 1) : '';
                const record = path === '' ? undefined : table.get(decodeURIComponent(path));

                // GET the collection: the tracked-id filter is the sidebar's authority.
                if (method === 'GET' && path === '') {
                    const query = url.slice(TEST_BASE_URL.length);
                    if (!query.startsWith('?ids=')) {
                        return jsonResponse(200, { conversations: [...table.values()].map(toSummary) });
                    }
                    const ids = decodeURIComponent(query.slice('?ids='.length));
                    const wanted = ids === '' ? [] : ids.split(',');
                    return jsonResponse(200, {
                        conversations: wanted
                            .map((id) => table.get(id))
                            .filter((entry): entry is StoredRecord => entry !== undefined)
                            .map(toSummary)
                    });
                }

                if (method === 'GET') {
                    return record === undefined
                        ? jsonResponse(404, { error: `Conversation ${path} not found` })
                        : jsonResponse(200, { conversationId: path, conversation: record });
                }

                if (method === 'POST' && path === '') {
                    // Create: an id-only answer; the record is what the follow-up GET
                    // returns, so the table is written here.
                    const input = (body ?? {}) as {
                        model?: string;
                        status?: 'pending' | 'complete';
                        title?: string;
                        systemPrompt?: string;
                        messages?: StoredMessage[];
                    };
                    const conversationId = createdIds.shift() ?? `conv-${table.size + 1}`;
                    const messages = input.messages ?? (input.systemPrompt ? [{ role: 'system' as Role, content: input.systemPrompt }] : []);
                    const created = recordFixture(conversationId, {
                        model: input.model ?? 'unknown/model',
                        status: input.status ?? 'complete',
                        title: input.title ?? deriveTitle(messages),
                        messages
                    });
                    table.set(conversationId, created);
                    return jsonResponse(201, { conversationId });
                }

                if (method === 'POST' && record !== undefined) {
                    // Append: id-only answer, and the pair becomes readable. The
                    // title rule is the server's (endpoints/chat-assistant/
                    // chat-assistant.ts:314-316): a record that already has a user
                    // turn keeps its title, a prompt-only or empty one takes the
                    // first appended user turn.
                    const input = (body ?? {}) as {
                        messages?: StoredMessage[];
                        systemPrompt?: string;
                        model?: string;
                        usage?: Record<string, number>;
                    };
                    const incoming: StoredMessage[] = [
                        ...(input.systemPrompt ? [{ role: 'system' as Role, content: input.systemPrompt }] : []),
                        ...(input.messages ?? [])
                    ];
                    const messages = [...record.messages, ...incoming];
                    table.set(record.conversationId, {
                        ...record,
                        messages,
                        messageCount: messages.length,
                        status: 'complete',
                        title: record.messages.some((message) => message.role === 'user')
                            ? record.title
                            : deriveTitle(incoming),
                        ...(input.model ? { model: input.model } : {}),
                        ...(input.usage ? { usage: input.usage } : {})
                    });
                    return jsonResponse(200, { conversationId: record.conversationId });
                }

                if (method === 'PUT' && record !== undefined) {
                    // Replace: the full updated record, straight back (no re-read).
                    const input = (body ?? {}) as { messages?: StoredMessage[]; title?: string; usage?: Record<string, number> };
                    const messages = input.messages ?? record.messages;
                    const replaced = {
                        ...record,
                        messages,
                        messageCount: messages.length,
                        title: input.title ?? deriveTitle(messages),
                        status: 'complete' as const,
                        ...(input.usage ? { usage: input.usage } : {})
                    };
                    table.set(record.conversationId, replaced);
                    return jsonResponse(200, { conversationId: record.conversationId, conversation: replaced });
                }

                if (method === 'DELETE' && record !== undefined) {
                    table.delete(record.conversationId);
                    return jsonResponse(200, { conversationId: record.conversationId });
                }

                return jsonResponse(400, { error: `Unrouted storage call: ${method} ${url}` });
            }
        }
    ]);

    return {
        fetch: fetchDouble,
        table,
        completionBodies: () => completionBodies,
        storageCalls: () => storageLog
    };
}

// ——— scenario helpers —————————————————————————————————————————————————————————————

/** A composed instance with the poller parked (see the timing note in the header). */
const owned: Dashboard[] = [];
const composed = (): Dashboard => {
    const instance = createTestChat({ pollIntervalMs: 60_000 });
    owned.push(instance);
    return instance;
};
/** Registers an instance built with non-default options so afterEach still reaps it. */
const track = (instance: Dashboard): Dashboard => {
    owned.push(instance);
    return instance;
};

const readTranscript = (instance: Dashboard): ChatTranscript =>
    instance.state<ChatTranscript>(CHAT_TRANSCRIPT_STATE).get();
const readTurns = (instance: Dashboard): readonly ChatTurn[] =>
    instance.state<readonly ChatTurn[]>(CHAT_TURNS_STATE).get();
const readSessions = (instance: Dashboard): readonly ChatSession[] =>
    instance.state<readonly ChatSession[]>(CHAT_SESSIONS_STATE).get();
const readCell = <T,>(instance: Dashboard, id: string): T => instance.state<T>(id).get();

const send = async (instance: Dashboard): Promise<void> =>
    instance.execute<void, Promise<void>>(CHAT_MESSAGE_SEND_COMMAND);

/**
 * Every storage request a scenario produced, as `METHOD url`, SORTED. The mount-time
 * history read is queued one microtask after setup while the flow's first write is
 * issued synchronously by `execute`, so the two can land in either order; the sorted
 * set is still an EXACT assertion, and the causal order (create before rollback) is
 * pinned where it is the actual contract.
 */
const storageRequests = (backend: Server): string[] =>
    backend
        .storageCalls()
        .map((call) => `${call.method} ${call.url}`)
        .sort();

/** Position of one call in the wire order; -1 when it never happened. */
const callIndex = (backend: Server, method: string, url: string): number =>
    backend.storageCalls().findIndex((call) => call.method === method && call.url === url);

// ——— lifecycle ————————————————————————————————————————————————————————————————————

beforeEach(() => {
    resetStorage();
    // The returning-browser defaults: online, no custom base, one remembered model.
    // Seeding the model keeps every payload assertion below independent of the
    // catalog's adoption order (plugins/source.ts:777-783 prefers the remembered one).
    seedSettings('online', '');
    seedModel('alpha/flash');
});

afterEach(() => {
    // Every instance this file built is reaped, so no dashboard's subscriptions or
    // R14 interval outlive the scenario that created it.
    for (const chat of owned.splice(0)) chat.dispose();
    vi.unstubAllGlobals();
});

describe('integration: the send pipeline end to end', () => {
    it('creates a session, streams a reply, persists the pair and the usage', async () => {
        const server = makeServer({
            models: ['alpha/flash', 'zeta/turbo'],
            createdIds: ['conv-1'],
            completions: [
                () =>
                    sseResponse([
                        sseDelta('Hel'),
                        sseDelta('lo'),
                        sseUsage({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }),
                        SSE_DONE
                    ])
            ]
        });
        const instance = composed();
        const events: RecordedEvent[] = recordEvents(instance, [
            CHAT_STREAM_STARTED_EVENT,
            CHAT_STREAM_DELTA_EVENT,
            CHAT_STREAM_COMPLETED_EVENT,
            CHAT_TRANSCRIPT_UPDATED_EVENT
        ]);

        // 1. New chat: POST the collection, then read the empty record back.
        const created = await instance.execute<void, string | null>(CHAT_SESSION_CREATE_COMMAND);
        expect(created).toBe('conv-1');
        expect(readCell<string | null>(instance, CHAT_ACTIVE_SESSION_STATE)).toBe('conv-1');
        // The row lands immediately, before any turn exists.
        expect(readSessions(instance)).toEqual([
            {
                conversationId: 'conv-1',
                title: 'New conversation',
                model: 'alpha/flash',
                status: 'complete',
                messageCount: 0,
                createdAt: '2026-11-07T00:00:00.000Z',
                updatedAt: '2026-11-07T00:00:01.000Z'
            }
        ]);

        // 2. The composer writes the draft through the command (T6: chat.draft.set).
        instance.execute<string, void>(CHAT_DRAFT_SET_COMMAND, 'Hello assistant');
        expect(readCell<string>(instance, CHAT_DRAFT_STATE)).toBe('Hello assistant');

        // 3. Send.
        await send(instance);

        // The provider payload is the OpenAI-compatible pair, with the remembered
        // model and the composer text as the only history (an empty chat).
        expect(server.completionBodies()).toEqual([
            {
                model: 'alpha/flash',
                stream: true,
                stream_options: { include_usage: true },
                messages: [{ role: 'user', content: 'Hello assistant' }]
            }
        ]);

        // The completed pair is the transcript, with the producing model attributed.
        expect([...readTranscript(instance)]).toEqual([
            { role: 'user', content: 'Hello assistant' },
            { role: 'assistant', content: 'Hello', model: 'alpha/flash' }
        ]);
        // `chat.turns` is the derived list the log paints: every row unfolded except
        // the newest assistant turn (the default-collapse rule, plugins/core.ts:181).
        expect(readTurns(instance).map((turn) => [turn.index, turn.role, turn.collapsed, turn.model])).toEqual([
            [0, 'user', true, ''],
            [1, 'assistant', false, 'alpha/flash']
        ]);

        // The usage frame reached the cell the composer's token line reads.
        expect(readCell<ChatUsage | null>(instance, CHAT_USAGE_STATE)).toEqual({
            prompt_tokens: 11,
            completion_tokens: 7,
            total_tokens: 18
        });

        // Every in-flight buffer is released, and the label is back to idle.
        expect(readCell<ChatPendingTurn | null>(instance, CHAT_PENDING_STATE)).toBeNull();
        expect(readCell<string>(instance, CHAT_STREAMING_STATE)).toBe('');
        expect(readCell<string>(instance, CHAT_DRAFT_STATE)).toBe('');
        expect(readCell<ChatStatus>(instance, CHAT_STATUS_STATE)).toBe('idle');
        expect(readCell<string>(instance, CHAT_ERROR_STATE)).toBe('');

        // The sidebar row settled to the canonical record (server-derived title).
        expect(readSessions(instance)[0]).toEqual({
            conversationId: 'conv-1',
            title: 'Hello assistant',
            model: 'alpha/flash',
            status: 'complete',
            messageCount: 2,
            createdAt: '2026-11-07T00:00:00.000Z',
            updatedAt: '2026-11-07T00:00:01.000Z'
        });

        // The stream's event trail, in order, with the ACCUMULATED snapshot per delta.
        expect(payloadsOf(events, CHAT_STREAM_STARTED_EVENT)).toEqual([
            { sessionId: 'conv-1', requestId: 'request-1' }
        ]);
        expect(payloadsOf(events, CHAT_STREAM_DELTA_EVENT)).toEqual([
            { sessionId: 'conv-1', requestId: 'request-1', text: 'Hel' },
            { sessionId: 'conv-1', requestId: 'request-1', text: 'Hello' }
        ]);
        expect(payloadsOf(events, CHAT_STREAM_COMPLETED_EVENT)).toEqual([
            { sessionId: 'conv-1', requestId: 'request-1', text: 'Hello' }
        ]);
        expect(payloadsOf(events, CHAT_TRANSCRIPT_UPDATED_EVENT)).toEqual([
            // The create's empty record (turnCount 0), then the completed turn.
            { sessionId: 'conv-1', turnCount: 0 },
            { sessionId: 'conv-1', turnCount: 2 }
        ]);

        // Persistence: the append carried the pair AND the usage, and the browser
        // remembers both the model and the conversation.
        expect(server.fetch.callsFor(conversationUrl('conv-1')).find((call) => call.method === 'POST')?.body).toEqual({
            messages: [
                { role: 'user', content: 'Hello assistant' },
                { role: 'assistant', content: 'Hello', model: 'alpha/flash' }
            ],
            model: 'alpha/flash',
            usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
        });
        expect(window.localStorage.getItem(MODEL_STORAGE_KEY)).toBe('alpha/flash');
        expect(readTrackedIds()).toEqual(['conv-1']);
        // What the fake server actually holds is the real check that it persisted.
        expect(server.table.get('conv-1')?.messages).toEqual([
            { role: 'user', content: 'Hello assistant' },
            { role: 'assistant', content: 'Hello', model: 'alpha/flash' }
        ]);
    });

    it('rolls the pending record back and restores the draft when the provider fails', async () => {
        const server = makeServer({
            models: ['alpha/flash'],
            createdIds: ['conv-2'],
            // A non-2xx BEFORE streaming starts: api/provider.ts reads `error` from
            // the body and re-throws it verbatim (api/provider.ts:69-77).
            completions: [jsonResponse(500, { error: 'Provider exploded' })]
        });
        const instance = composed();

        instance.execute<string, void>(CHAT_DRAFT_SET_COMMAND, 'Hello assistant');
        await send(instance);

        // The failure is the stage's banner, verbatim.
        expect(readCell<string>(instance, CHAT_ERROR_STATE)).toBe('Provider exploded');
        // The text is back in the composer for a retry, and nothing is in flight.
        expect(readCell<string>(instance, CHAT_DRAFT_STATE)).toBe('Hello assistant');
        expect(readCell<ChatPendingTurn | null>(instance, CHAT_PENDING_STATE)).toBeNull();
        expect(readCell<string>(instance, CHAT_STREAMING_STATE)).toBe('');
        expect(readCell<ChatStatus>(instance, CHAT_STATUS_STATE)).toBe('idle');
        // The up-front 'pending' record is gone from BOTH the surface and the store:
        // a generation that never answered leaves no phantom chat behind.
        expect(readSessions(instance)).toEqual([]);
        expect(readCell<string | null>(instance, CHAT_ACTIVE_SESSION_STATE)).toBeNull();
        expect([...server.table.keys()]).toEqual([]);
        // Exactly the create / read-back / rollback trio, plus the mount-time history
        // read — and NO append and NO PUT, because nothing was generated.
        expect(storageRequests(server)).toEqual(
            [
                `POST ${TEST_BASE_URL}`,
                `GET ${conversationUrl('conv-2')}`,
                `DELETE ${conversationUrl('conv-2')}`,
                `GET ${LIST_URL}`
            ].sort()
        );
        // The rollback is causally after the create it undoes.
        expect(callIndex(server, 'DELETE', conversationUrl('conv-2'))).toBeGreaterThan(
            callIndex(server, 'POST', TEST_BASE_URL)
        );
        expect(callIndex(server, 'PUT', conversationUrl('conv-2'))).toBe(-1);
        // The tracked cache is un-dirtied by the rollback, and nothing was appended.
        expect(readTrackedIds()).toEqual([]);
        expect(server.completionBodies()).toHaveLength(1);
    });

    it('cancels mid-stream: the partial is kept, the draft returns, nothing persists', async () => {
        // The completion is gated so the cancel genuinely lands WHILE the request is
        // open, and only then does the first (and only) token arrive.
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const server = makeServer({
            models: ['alpha/flash'],
            createdIds: ['conv-3'],
            completions: [
                async () => {
                    await gate;
                    return sseResponse([sseDelta('Half'), sseDelta(' a reply'), SSE_DONE]);
                }
            ]
        });
        const instance = composed();
        const events: RecordedEvent[] = recordEvents(instance, [
            CHAT_STREAM_CANCELLED_EVENT,
            CHAT_STREAM_COMPLETED_EVENT
        ]);

        instance.execute<string, void>(CHAT_DRAFT_SET_COMMAND, 'Hello assistant');
        const sending = send(instance);
        await vi.waitFor(() => {
            expect(readCell<ChatPendingTurn | null>(instance, CHAT_PENDING_STATE)).not.toBeNull();
        });

        // The stop control while 'sending': it reports that something was in flight.
        expect(instance.execute<void, boolean>(CHAT_MESSAGE_CANCEL_COMMAND)).toBe(true);
        // A second stop is not a second cancellation.
        expect(instance.execute<void, boolean>(CHAT_MESSAGE_CANCEL_COMMAND)).toBe(false);
        release();
        await sending;

        expect(payloadsOf(events, CHAT_STREAM_CANCELLED_EVENT)).toEqual([
            { sessionId: 'conv-3', requestId: 'request-1', text: '' }
        ]);
        expect(payloadsOf(events, CHAT_STREAM_COMPLETED_EVENT)).toEqual([]);
        // The retry text is back, and the stopped turn was never persisted.
        expect(readCell<string>(instance, CHAT_DRAFT_STATE)).toBe('Hello assistant');
        expect(readCell<ChatPendingTurn | null>(instance, CHAT_PENDING_STATE)).toBeNull();
        expect(readTranscript(instance)).toEqual([]);
        expect([...server.table.keys()]).toEqual([]);
        // Create, read back, roll back — nothing was appended and nothing was PUT.
        expect(storageRequests(server)).toEqual(
            [
                `POST ${TEST_BASE_URL}`,
                `GET ${conversationUrl('conv-3')}`,
                `DELETE ${conversationUrl('conv-3')}`,
                `GET ${LIST_URL}`
            ].sort()
        );
        expect(callIndex(server, 'DELETE', conversationUrl('conv-3'))).toBeGreaterThan(
            callIndex(server, 'POST', TEST_BASE_URL)
        );
    });

    it('R7: an online->offline switch mid-flight keeps its writes in the sending namespace', async () => {
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const server = makeServer({
            models: ['alpha/flash'],
            createdIds: ['conv-4'],
            completions: [
                async () => {
                    await gate;
                    return sseResponse([sseDelta('Late reply'), SSE_DONE]);
                }
            ]
        });
        // One conversation already exists OFFLINE, so the new namespace has a surface
        // of its own to keep (and the stale settle has something it must NOT touch).
        const instance = composed();

        instance.execute<string, void>(CHAT_DRAFT_SET_COMMAND, 'Hello assistant');
        const sending = send(instance);
        await vi.waitFor(() => {
            expect(readCell<ChatPendingTurn | null>(instance, CHAT_PENDING_STATE)).not.toBeNull();
        });

        // The switch is the whole scenario: chat.mode.set bumps the namespace epoch
        // and resets the surface (plugins/settings.ts:138-177 -> plugins/core.ts:533).
        instance.execute<ChatMode, void>(CHAT_MODE_SET_COMMAND, 'offline');
        expect(readCell<ChatMode>(instance, CHAT_MODE_STATE)).toBe('offline');
        // The composer in the NEW namespace is the one the send left behind (it
        // cleared the draft before generating, and a switch never rewrites it), and
        // the old namespace's completion is not allowed to fill it back in.
        expect(readCell<string>(instance, CHAT_DRAFT_STATE)).toBe('');
        release();
        await sending;

        // The NEW namespace owns every surface cell: the late reply painted nothing.
        expect(readTranscript(instance)).toEqual([]);
        expect(readCell<ChatPendingTurn | null>(instance, CHAT_PENDING_STATE)).toBeNull();
        expect(readCell<string>(instance, CHAT_STREAMING_STATE)).toBe('');
        expect(readCell<string | null>(instance, CHAT_ACTIVE_SESSION_STATE)).toBeNull();
        expect(readCell<ChatUsage | null>(instance, CHAT_USAGE_STATE)).toBeNull();
        expect(readCell<ChatStatus>(instance, CHAT_STATUS_STATE)).toBe('idle');
        // The offline sidebar lists the local store, not the online row.
        expect(readSessions(instance)).toEqual([]);
        // The write still landed where it started: the ONLINE table has the turn.
        expect(server.table.get('conv-4')?.messages).toEqual([
            { role: 'user', content: 'Hello assistant' },
            { role: 'assistant', content: 'Late reply', model: 'alpha/flash' }
        ]);
        expect(readTrackedIds()).toEqual(['conv-4']);
        expect(window.localStorage.getItem(OFFLINE_STORAGE_KEY)).toBeNull();
        expect(server.completionBodies()).toEqual([
            {
                model: 'alpha/flash',
                stream: true,
                stream_options: { include_usage: true },
                messages: [{ role: 'user', content: 'Hello assistant' }]
            }
        ]);
    });

    it('R14: polls a pending conversation, merges the settle, then stops watching', async () => {
        const pending = recordFixture('conv-p', { status: 'pending', messages: [{ role: 'user', content: 'Hello assistant' }] });
        const settled = recordFixture('conv-p', {
            status: 'complete',
            messages: [
                { role: 'user', content: 'Hello assistant' },
                { role: 'assistant', content: 'Hello user', model: 'alpha/flash' }
            ],
            usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 }
        });
        const server = makeServer({ models: ['alpha/flash'], records: [pending] });
        seedTrackedIds(['conv-p']);
        // The only scenario that wants the real cadence.
        const instance = track(createTestChat());

        await vi.waitFor(() => {
            expect(readSessions(instance)).toHaveLength(1);
        });
        await instance.execute<string, void>(CHAT_SESSION_SELECT_COMMAND, 'conv-p');
        expect([...readTranscript(instance)]).toEqual([{ role: 'user', content: 'Hello assistant' }]);

        // A row that is still 'pending' while this browser is looking at it is the
        // watch target (plugins/source.ts:315-337): the poller follows the server.
        // The select's own read is one GET; the watch adds the next ones on its 5ms
        // cadence, so the wait is what distinguishes "watched" from "read once".
        await vi.waitFor(() => {
            expect(server.fetch.callsFor(conversationUrl('conv-p')).length).toBeGreaterThan(1);
        });

        // The server finishes the turn out-of-band (another tab / a retried send).
        server.table.set('conv-p', settled);
        await vi.waitFor(() => {
            expect([...readTranscript(instance)]).toEqual(settled.messages);
        });
        expect(readCell<ChatUsage | null>(instance, CHAT_USAGE_STATE)).toEqual({
            prompt_tokens: 5,
            completion_tokens: 4,
            total_tokens: 9
        });
        expect(readSessions(instance)[0].status).toBe('complete');

        // Settled = watched no more: the timer is cleared, so the request count stops.
        const pollsAtSettle = server.fetch.callsFor(conversationUrl('conv-p')).length;
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(server.fetch.callsFor(conversationUrl('conv-p')).length).toBe(pollsAtSettle);
    });
});

describe('integration: the agent prefix reaches the outgoing payload', () => {
    it('opens a new chat with the agent system prompt plus its example turns', async () => {
        seedAgents([
            {
                id: 'agent-1',
                name: 'Scout',
                systemPrompt: 'Answer briefly',
                messages: [
                    { role: 'user', content: 'Hi' },
                    { role: 'assistant', content: 'Hey' }
                ],
                tools: []
            }
        ]);
        const server = makeServer({
            models: ['alpha/flash'],
            createdIds: ['conv-5'],
            completions: [() => sseResponse([sseDelta('Brief.'), SSE_DONE])]
        });
        const instance = composed();

        // chat.agent.set is owned by chat.agents (plugins/agents.ts:140).
        instance.execute<string, void>(CHAT_AGENT_SET_COMMAND, 'agent-1');
        expect(readCell<string>(instance, CHAT_AGENT_STATE)).toBe('agent-1');
        instance.execute<string, void>(CHAT_DRAFT_SET_COMMAND, 'Go');
        await send(instance);

        expect(server.completionBodies()).toEqual([
            {
                model: 'alpha/flash',
                stream: true,
                stream_options: { include_usage: true },
                messages: [
                    { role: 'system', content: 'Answer briefly' },
                    { role: 'user', content: 'Hi' },
                    { role: 'assistant', content: 'Hey' },
                    { role: 'user', content: 'Go' }
                ]
            }
        ]);
        // The persisted record keeps the WHOLE block, not just its system line —
        // exactly the oracle's append payload (monolith :4027
        // `[...systemPrefix, user, assistant]`, where systemPrefix is the agent block).
        expect(server.fetch.callsFor(conversationUrl('conv-5')).find((call) => call.method === 'POST')?.body).toEqual({
            messages: [
                { role: 'system', content: 'Answer briefly' },
                { role: 'user', content: 'Hi' },
                { role: 'assistant', content: 'Hey' },
                { role: 'user', content: 'Go' },
                { role: 'assistant', content: 'Brief.', model: 'alpha/flash' }
            ],
            model: 'alpha/flash'
        });
        // ...and the surface shows exactly that history.
        expect([...readTranscript(instance)]).toEqual([
            { role: 'system', content: 'Answer briefly' },
            { role: 'user', content: 'Hi' },
            { role: 'assistant', content: 'Hey' },
            { role: 'user', content: 'Go' },
            { role: 'assistant', content: 'Brief.', model: 'alpha/flash' }
        ]);
    });
});

describe('integration: history rewrites persist through the identified PUT', () => {
    /** The shared starting state: one 3-turn record, already tracked and open. */
    const seeded = (): { server: Server; instance: Dashboard } => {
        const server = makeServer({
            models: ['alpha/flash'],
            createdIds: ['conv-fork'],
            records: [
                recordFixture('conv-1', {
                    // The row's recorded model is what a fork inherits
                    // (plugins/transcript.ts:322-325), so it is part of the scenario.
                    model: 'zeta/turbo',
                    messages: [
                        { role: 'system', content: 'Answer briefly' },
                        { role: 'user', content: 'One' },
                        { role: 'assistant', content: 'Two', model: 'zeta/turbo' }
                    ]
                })
            ]
        });
        seedTrackedIds(['conv-1']);
        return { server, instance: composed() };
    };

    it('switches a turn role, deletes a turn, commits an inline edit and forks a prefix', async () => {
        const { server, instance } = seeded();
        await vi.waitFor(() => expect(readSessions(instance)).toHaveLength(1));
        await instance.execute<string, void>(CHAT_SESSION_SELECT_COMMAND, 'conv-1');
        expect(readTranscript(instance)).toHaveLength(3);

        // ——— role switch: user -> assistant, with the producing model attributed ——
        await instance.execute<{ index: number; role: 'assistant' }, Promise<void>>(CHAT_MESSAGE_ROLE_COMMAND, {
            index: 1,
            role: 'assistant'
        });
        const rolePut = server.fetch.callsFor(conversationUrl('conv-1')).find((call) => call.method === 'PUT');
        expect(rolePut?.body).toEqual({
            messages: [
                { role: 'system', content: 'Answer briefly' },
                { role: 'assistant', content: 'One', model: 'alpha/flash' },
                { role: 'assistant', content: 'Two', model: 'zeta/turbo' }
            ]
        });
        expect([...readTranscript(instance)][1]).toEqual({ role: 'assistant', content: 'One', model: 'alpha/flash' });

        // ——— delete the middle turn ————————————————————————————————————————————
        await instance.execute<number, Promise<void>>(CHAT_MESSAGE_DELETE_COMMAND, 1);
        const deletePut = server.fetch
            .callsFor(conversationUrl('conv-1'))
            .filter((call) => call.method === 'PUT')[1];
        expect(deletePut?.body).toEqual({
            messages: [
                { role: 'system', content: 'Answer briefly' },
                { role: 'assistant', content: 'Two', model: 'zeta/turbo' }
            ]
        });
        expect([...readTranscript(instance)]).toEqual([
            { role: 'system', content: 'Answer briefly' },
            { role: 'assistant', content: 'Two', model: 'zeta/turbo' }
        ]);

        // ——— inline edit commit (the contentEditable blur) ——————————————————————
        await instance.execute<{ index: number; content: string }, Promise<void>>(CHAT_MESSAGE_UPDATE_COMMAND, {
            index: 1,
            content: '  Rewritten reply  '
        });
        const editPut = server.fetch
            .callsFor(conversationUrl('conv-1'))
            .filter((call) => call.method === 'PUT')[2];
        expect(editPut?.body).toEqual({
            messages: [
                { role: 'system', content: 'Answer briefly' },
                { role: 'assistant', content: 'Rewritten reply', model: 'zeta/turbo' }
            ]
        });
        // The commit trims and keeps the turn's own attribution (plugins/transcript.ts:271-285).
        expect([...readTranscript(instance)][1].content).toBe('Rewritten reply');

        // ——— fork: a new conversation carrying the prefix, and the surface follows —
        const forked = await instance.execute<number, Promise<string | null>>(CHAT_MESSAGE_FORK_COMMAND, 1);
        expect(forked).toBe('conv-fork');
        expect(server.storageCalls().find((call) => call.method === 'POST' && call.url === TEST_BASE_URL)).toBeDefined();
        expect(server.table.get('conv-fork')?.messages).toEqual([
            { role: 'system', content: 'Answer briefly' },
            { role: 'assistant', content: 'Rewritten reply', model: 'zeta/turbo' }
        ]);
        expect(readCell<string | null>(instance, CHAT_ACTIVE_SESSION_STATE)).toBe('conv-fork');
        expect([...readTranscript(instance)]).toEqual([
            { role: 'system', content: 'Answer briefly' },
            { role: 'assistant', content: 'Rewritten reply', model: 'zeta/turbo' }
        ]);
        // A fork inherits the source row's model and the browser remembers it.
        expect(readCell<string>(instance, CHAT_MODEL_STATE)).toBe('zeta/turbo');
        expect(window.localStorage.getItem(MODEL_STORAGE_KEY)).toBe('zeta/turbo');
        expect(readTrackedIds()).toEqual(['conv-1', 'conv-fork']);
    });

    it('saves a system-prompt draft onto an existing chat as a leading system message', async () => {
        const { server, instance } = seeded();
        await vi.waitFor(() => expect(readSessions(instance)).toHaveLength(1));
        await instance.execute<string, void>(CHAT_SESSION_SELECT_COMMAND, 'conv-1');

        instance.execute<void, void>(CHAT_SYSTEM_BEGIN_COMMAND);
        instance.state<string>(CHAT_SYSTEM_DRAFT_STATE).set('Think first');
        await instance.execute<void, Promise<void>>(CHAT_SYSTEM_SAVE_COMMAND);

        const promptPut = server.fetch.callsFor(conversationUrl('conv-1')).find((call) => call.method === 'PUT');
        expect(promptPut?.body).toEqual({
            messages: [
                { role: 'system', content: 'Think first' },
                { role: 'system', content: 'Answer briefly' },
                { role: 'user', content: 'One' },
                { role: 'assistant', content: 'Two', model: 'zeta/turbo' }
            ]
        });
        expect([...readTranscript(instance)][0]).toEqual({ role: 'system', content: 'Think first' });
        // The draft is consumed once persisted (plugins/system-prompt.ts:153).
        expect(readCell<string>(instance, CHAT_SYSTEM_DRAFT_STATE)).toBe('');
    });

    it('creates its own record when the prompt is saved on a new chat', async () => {
        const server = makeServer({ models: ['alpha/flash'], createdIds: ['conv-prompt'] });
        const instance = composed();

        instance.execute<void, void>(CHAT_SYSTEM_BEGIN_COMMAND);
        instance.state<string>(CHAT_SYSTEM_DRAFT_STATE).set('Answer briefly');
        await instance.execute<void, Promise<void>>(CHAT_SYSTEM_SAVE_COMMAND);

        expect(storageRequests(server!)).toEqual(
            [
                `POST ${TEST_BASE_URL}`,
                `GET ${conversationUrl('conv-prompt')}`,
                `GET ${LIST_URL}`
            ].sort()
        );
        // The create carries the selected model + the prompt (no provider round trip).
        expect(server.fetch.calls().find((call) => call.method === 'POST')?.body).toEqual({
            model: 'alpha/flash',
            systemPrompt: 'Answer briefly'
        });
        expect(readCell<string | null>(instance, CHAT_ACTIVE_SESSION_STATE)).toBe('conv-prompt');
        expect([...readTranscript(instance)]).toEqual([{ role: 'system', content: 'Answer briefly' }]);
    });
});

describe('integration: the model catalog, the picker command and persistence', () => {
    it('loads the catalog on mount and persists an explicit pick', async () => {
        const server = makeServer({ models: ['alpha/flash', 'zeta/turbo'] });
        const instance = composed();

        await vi.waitFor(() => {
            expect(readCell<readonly string[]>(instance, CHAT_MODELS_STATE)).toEqual(['alpha/flash', 'zeta/turbo']);
        });
        expect(server.fetch.callsFor(MODELS_URL)).toHaveLength(1);
        // The remembered model wins over the catalog's first entry.
        expect(readCell<string>(instance, CHAT_MODEL_STATE)).toBe('alpha/flash');

        instance.execute<string, void>(CHAT_MODEL_SET_COMMAND, 'zeta/turbo');
        expect(readCell<string>(instance, CHAT_MODEL_STATE)).toBe('zeta/turbo');
        expect(window.localStorage.getItem(MODEL_STORAGE_KEY)).toBe('zeta/turbo');
    });

    it('does not persist the catalog default it adopts itself', async () => {
        // A first-run browser (no remembered model) keeps following the catalog's
        // order until the operator actually chooses (monolith :2776-2782).
        resetStorage();
        seedSettings('online', '');
        const server = makeServer({ models: ['alpha/flash'] });
        const instance = composed();

        await vi.waitFor(() => {
            expect(readCell<string>(instance, CHAT_MODEL_STATE)).toBe('alpha/flash');
        });
        expect(window.localStorage.getItem(MODEL_STORAGE_KEY)).toBeNull();
    });
});

describe('integration: every persisted key the UI owns', () => {
    it('writes the documented keys and nothing else', async () => {
        const server = makeServer({
            models: ['alpha/flash'],
            createdIds: ['conv-6'],
            completions: [() => sseResponse([sseDelta('Answer'), SSE_DONE])]
        });
        const instance = composed();

        // model + tracked ids + the completed turn's record.
        instance.execute<string, void>(CHAT_DRAFT_SET_COMMAND, 'Hello assistant');
        await send(instance);
        const conversationId = readCell<string | null>(instance, CHAT_ACTIVE_SESSION_STATE);
        expect(conversationId).toBe('conv-6');

        // The two registries: create persists each entry under its own key.
        const agentId = instance.execute<void, string>(CHAT_AGENT_CREATE_COMMAND);
        expect(agentId).toBe('agent-1');
        const toolId = instance.execute<void, string>(CHAT_TOOL_CREATE_COMMAND);
        expect(toolId).toBe('tool-1');
        expect(instance.service<{ list: () => unknown[] }>(CHAT_TOOL_STORE_SERVICE).list()).toContainEqual({
            id: 'tool-1',
            name: 'New tool',
            native: false,
            language: 'javascript',
            code: '// New tool implementation\n'
        });

        // settings + the offline namespace, exercised through a local (provider-free)
        // write so no extra route is needed for the offline relay.
        instance.execute<ChatMode, void>(CHAT_MODE_SET_COMMAND, 'offline');
        instance.state<string>(CHAT_SYSTEM_DRAFT_STATE).set('Be terse');
        await instance.execute<void, Promise<void>>(CHAT_SYSTEM_SAVE_COMMAND);

        expect(window.localStorage.getItem(MODEL_STORAGE_KEY)).toBe('alpha/flash');

        // R13's accepted new key: the OFFLINE namespace holds the prompt record. Its
        // id comes from the local allocator (crypto.randomUUID when the environment
        // has one), so the entry is addressed by its own key rather than a literal.
        const local = JSON.parse(String(window.localStorage.getItem(OFFLINE_STORAGE_KEY))) as Record<
            string,
            { conversationId: string; model: string; messages: StoredMessage[]; status: string }
        >;
        const localIds = Object.keys(local);
        expect(localIds).toHaveLength(1);
        expect(local[localIds[0]]).toMatchObject({
            conversationId: localIds[0],
            model: 'alpha/flash',
            status: 'complete',
            messages: [{ role: 'system', content: 'Be terse' }]
        });

        // The tracked cache holds the ONLINE id and, by documented design, the local
        // one too: services/conversations.ts:23-32 keeps the same cache helpers across
        // a mode switch ("a later online `list` prunes any local-only id the server has
        // never seen"), which is what makes the interface total. The pre-rebuild
        // component tracked online creates only (monolith :2485-2502); the difference
        // self-heals on the next online read and is pinned by the facade's own suite
        // (services/conversations.test.ts:270-288).
        expect(readTrackedIds()).toEqual(['conv-6', localIds[0]]);
        expect(window.localStorage.getItem(TRACKED_STORAGE_KEY)).toBe(
            JSON.stringify(['conv-6', localIds[0]])
        );
        expect(JSON.parse(String(window.localStorage.getItem(SETTINGS_STORAGE_KEY)))).toEqual({
            mode: 'offline',
            providerBase: ''
        });
        expect(JSON.parse(String(window.localStorage.getItem(AGENTS_STORAGE_KEY)))).toEqual([
            { id: 'agent-1', name: 'New agent', systemPrompt: '', messages: [], tools: [] }
        ]);
        expect(JSON.parse(String(window.localStorage.getItem(TOOLS_STORAGE_KEY)))).toEqual([
            {
                id: 'tool-1',
                name: 'New tool',
                native: false,
                language: 'javascript',
                code: '// New tool implementation\n'
            }
        ]);
        // Nothing else lives under the app's prefix.
        expect(
            Object.keys(window.localStorage)
                .filter((key) => key.startsWith('chat-assistant:'))
                .sort()
        ).toEqual([
            AGENTS_STORAGE_KEY,
            MODEL_STORAGE_KEY,
            OFFLINE_STORAGE_KEY,
            SETTINGS_STORAGE_KEY,
            TOOLS_STORAGE_KEY,
            TRACKED_STORAGE_KEY
        ].sort());
        expect(readCell<ChatMode>(instance, CHAT_MODE_STATE)).toBe('offline');
    });
});
