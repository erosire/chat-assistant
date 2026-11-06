// Chat SYSTEM-PROMPT plugin tests: the leading system turn and its draft.
//
// Headless, no render. The draft bubble commits through `chat.system.save`, and the
// persist BRANCHES on whether a record is already open (components/ChatAssistantApp.tsx
// :3240-3262): an open conversation prepends the prompt with a whole-history PUT, while
// the new-chat surface creates a record of its own through POST `systemPrompt`. The
// request bodies below are the assertion targets, because state alone cannot show that
// the prompt landed at index 0 rather than at the end of the history.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dashboard } from '@underload/dashboard';
import {
    CHAT_ACTIVE_SESSION_STATE,
    CHAT_CELLS_SERVICE,
    CHAT_COLLAPSED_TURNS_STATE,
    CHAT_EDITING_SYSTEM_STATE,
    CHAT_ERROR_EVENT,
    CHAT_ERROR_STATE,
    CHAT_MODEL_STATE,
    CHAT_MODE_STATE,
    CHAT_NOTICE_EVENT,
    CHAT_SESSIONS_STATE,
    CHAT_SESSION_CREATED_EVENT,
    CHAT_SESSION_SELECT_COMMAND,
    CHAT_STATUS_STATE,
    CHAT_SYSTEM_BEGIN_COMMAND,
    CHAT_SYSTEM_CANCEL_COMMAND,
    CHAT_SYSTEM_DRAFT_STATE,
    CHAT_SYSTEM_SAVE_COMMAND,
    CHAT_TRANSCRIPT_STATE,
    CHAT_TRANSCRIPT_UPDATED_EVENT,
    CHAT_USAGE_STATE,
    type ChatCells,
    type ChatMode,
    type ChatSession,
    type ChatTranscript,
    type NoticeEvent,
    type SessionCreatedEvent,
    type TranscriptUpdatedEvent
} from '../contract';
import {
    jsonResponse,
    installFetch,
    payloadsOf,
    recordEvents,
    recordFixture,
    readTrackedIds,
    resetStorage,
    createTestChat,
    seedTrackedIds,
    summaryFixture,
    TEST_BASE_URL,
    TEST_PROVIDER_URL,
    type FetchDouble
} from './harness';

const PROVIDER_MODELS = `${TEST_PROVIDER_URL}/models`;

const catalogRoute = {
    match: (url: string) => url === PROVIDER_MODELS,
    reply: () =>
        jsonResponse(200, { object: 'list', data: [{ id: 'alpha/flash' }, { id: 'zeta/turbo' }] })
};

/** Open conversation with NO leading system message, so the draft turn is the live one. */
const RECORD_WITHOUT_PROMPT = recordFixture('conv-1', {
    title: 'Hello assistant',
    model: 'alpha/flash',
    messages: [
        { role: 'user', content: 'Hello assistant' },
        { role: 'assistant', content: 'Hello user', model: 'test/model' }
    ]
});

/** The canonical record a prompt-created conversation reads back as. */
const PROMPT_RECORD = recordFixture('conv-prompt', {
    title: 'Answer briefly',
    model: 'zeta/turbo',
    messages: [{ role: 'system', content: 'Answer briefly' }]
});

/** The history the store answers with after a prompt PUT: the prepend, at index 0. */
const PROMPTED_HISTORY = [
    { role: 'system', content: 'Answer briefly' },
    { role: 'user', content: 'Hello assistant' },
    { role: 'assistant', content: 'Hello user', model: 'test/model' }
];

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

/**
 * Boot with `record` available and open it. The PUT behaves like the server — the sent
 * history becomes the canonical record — so the adopted transcript proves the write
 * rather than a reconstruction. `onPut` lets a case reject or gate the write.
 */
async function openConversation(
    record = RECORD_WITHOUT_PROMPT,
    options: {
        select?: boolean;
        onPut?: (body: { messages?: unknown[] }) => Response | Promise<Response>;
    } = {}
): Promise<{ instance: Dashboard; double: FetchDouble; cells: ChatCells }> {
    seedTrackedIds([record.conversationId]);
    let current: unknown = record;
    const fetchDouble = installFetch([
        catalogRoute,
        {
            match: (url) => url === `${TEST_BASE_URL}/${record.conversationId}`,
            reply: (url, init) => {
                if ((init?.method ?? 'GET') === 'PUT') {
                    const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: unknown[] };
                    if (options.onPut) return options.onPut(body);
                    current = {
                        ...current,
                        messages: body.messages ?? [],
                        messageCount: (body.messages ?? []).length
                    };
                }
                return jsonResponse(200, {
                    conversationId: record.conversationId,
                    conversation: current
                });
            }
        },
        {
            match: (url) => url.startsWith(TEST_BASE_URL),
            reply: () =>
                jsonResponse(200, {
                    conversations: [summaryFixture(current as ReturnType<typeof recordFixture>)]
                })
        }
    ]);
    const chat = createTestChat();
    if (options.select !== false) {
        await chat.execute<string, Promise<void>>(
            CHAT_SESSION_SELECT_COMMAND,
            record.conversationId
        );
    }
    double = fetchDouble;
    return { instance: chat, double: fetchDouble, cells: chat.service<ChatCells>(CHAT_CELLS_SERVICE) };
}

/**
 * Wait for the two boot reads (the scoped listing and the model catalog) to have hit the
 * double. Cases that never open a conversation must do this before clearing the log: the
 * reads fire one microtask after setup, so an early reset would leave them behind and
 * they would look like requests the save itself made.
 */
async function waitForBoot(fetchDouble: FetchDouble): Promise<void> {
    await vi.waitFor(() => {
        const calls = fetchDouble.calls();
        const listed = calls.some((call) => call.url.startsWith(`${TEST_BASE_URL}?`));
        const cataloged = calls.some((call) => call.url === PROVIDER_MODELS);
        if (!listed || !cataloged) {
            throw new Error(`boot reads incomplete: ${calls.map((call) => call.url).join(', ')}`);
        }
    });
}

// ——— the draft editor flags —————————————————————————————————————————————————————————————

describe('chat.system — begin and cancel', () => {
    it('opens the draft editor and abandons it without touching the saved draft', async () => {
        const { instance: chat, cells } = await openConversation();
        expect(chat.state<boolean>(CHAT_EDITING_SYSTEM_STATE).get()).toBe(false);
        expect(chat.state<string>(CHAT_SYSTEM_DRAFT_STATE).get()).toBe('');

        chat.execute<void, void>(CHAT_SYSTEM_BEGIN_COMMAND);
        expect(chat.state<boolean>(CHAT_EDITING_SYSTEM_STATE).get()).toBe(true);

        // Escape closes the bubble; the last committed draft stays visible, because the
        // keyed remount reverts any half-typed DOM text on its own (:3202-3207)
        cells.systemDraft.set('Typed but unsaved');
        chat.execute<void, void>(CHAT_SYSTEM_CANCEL_COMMAND);

        expect(chat.state<boolean>(CHAT_EDITING_SYSTEM_STATE).get()).toBe(false);
        expect(chat.state<string>(CHAT_SYSTEM_DRAFT_STATE).get()).toBe('Typed but unsaved');
        expect(double!.calls().filter((call) => call.method !== 'GET')).toEqual([]);
        expect(chat.state<ChatTranscript>(CHAT_TRANSCRIPT_STATE).get()).toEqual(
            RECORD_WITHOUT_PROMPT.messages
        );
    });
});

// ——— commit against an open conversation ————————————————————————————————————————————————

describe('chat.system — save on an open conversation', () => {
    it('prepends the prompt with a whole-history PUT and adopts the record', async () => {
        const { instance: chat, cells } = await openConversation();
        cells.systemDraft.set('  Answer briefly  ');
        chat.execute<void, void>(CHAT_SYSTEM_BEGIN_COMMAND);
        double!.reset();
        const events = recordEvents(chat, [
            CHAT_SESSION_CREATED_EVENT,
            CHAT_TRANSCRIPT_UPDATED_EVENT,
            CHAT_NOTICE_EVENT,
            CHAT_ERROR_EVENT
        ]);

        await chat.execute<void, Promise<void>>(CHAT_SYSTEM_SAVE_COMMAND);

        // the leading block must land at index 0: an append would attach it at the END
        expect(double!.calls()).toEqual([
            {
                url: `${TEST_BASE_URL}/conv-1`,
                method: 'PUT',
                body: { messages: PROMPTED_HISTORY }
            }
        ]);
        expect(chat.state<ChatTranscript>(CHAT_TRANSCRIPT_STATE).get()).toEqual(PROMPTED_HISTORY);
        // the prompt is persisted, so the draft and its editor both clear
        expect(chat.state<string>(CHAT_SYSTEM_DRAFT_STATE).get()).toBe('');
        expect(chat.state<boolean>(CHAT_EDITING_SYSTEM_STATE).get()).toBe(false);
        expect(chat.state<readonly number[]>(CHAT_COLLAPSED_TURNS_STATE).get()).toEqual([0, 1]);
        expect(chat.state<unknown>(CHAT_USAGE_STATE).get()).toBe(null);
        expect(chat.state<string>(CHAT_ERROR_STATE).get()).toBe('');
        expect(chat.state<string>(CHAT_STATUS_STATE).get()).toBe('idle');
        expect(payloadsOf(events, CHAT_SESSION_CREATED_EVENT)).toEqual([
            { sessionId: 'conv-1', title: 'Hello assistant' } satisfies SessionCreatedEvent
        ]);
        expect(payloadsOf(events, CHAT_TRANSCRIPT_UPDATED_EVENT)).toEqual([
            { sessionId: 'conv-1', turnCount: 3 } satisfies TranscriptUpdatedEvent
        ]);
        expect(payloadsOf(events, CHAT_NOTICE_EVENT)).toEqual([
            { message: 'System prompt saved.' } satisfies NoticeEvent
        ]);
        expect(payloadsOf(events, CHAT_ERROR_EVENT)).toEqual([]);
        // the sidebar row follows the write, and its count is the server's, not a guess
        expect(chat.state<readonly ChatSession[]>(CHAT_SESSIONS_STATE).get()).toEqual([
            { ...summaryFixture(RECORD_WITHOUT_PROMPT), messageCount: 3 }
        ]);
    });

    it('keeps the typed prompt and reports the banner when the store rejects', async () => {
        const { instance: chat, cells } = await openConversation(RECORD_WITHOUT_PROMPT, {
            onPut: () => jsonResponse(500, { error: 'Storage is down' })
        });
        cells.systemDraft.set('Answer briefly');
        chat.execute<void, void>(CHAT_SYSTEM_BEGIN_COMMAND);
        double!.reset();
        const events = recordEvents(chat, [CHAT_ERROR_EVENT, CHAT_NOTICE_EVENT]);

        await chat.execute<void, Promise<void>>(CHAT_SYSTEM_SAVE_COMMAND);

        // the persist failed, so the operator keeps their text for a retry (:3283-3292)
        expect(chat.state<string>(CHAT_SYSTEM_DRAFT_STATE).get()).toBe('Answer briefly');
        expect(chat.state<boolean>(CHAT_EDITING_SYSTEM_STATE).get()).toBe(false);
        expect(chat.state<ChatTranscript>(CHAT_TRANSCRIPT_STATE).get()).toEqual(
            RECORD_WITHOUT_PROMPT.messages
        );
        expect(chat.state<string>(CHAT_ERROR_STATE).get()).toBe('Storage is down');
        expect(payloadsOf(events, CHAT_ERROR_EVENT)).toEqual([{ message: 'Storage is down' }]);
        expect(payloadsOf(events, CHAT_NOTICE_EVENT)).toEqual([]);
        expect(chat.state<readonly ChatSession[]>(CHAT_SESSIONS_STATE).get()).toEqual([
            summaryFixture(RECORD_WITHOUT_PROMPT)
        ]);
        expect(chat.state<string>(CHAT_STATUS_STATE).get()).toBe('idle');
    });

    it('drops a blank commit without any request', async () => {
        const { instance: chat, cells } = await openConversation();
        // the operator cleared the bubble: the committed text is blank
        cells.systemDraft.set('   ');
        cells.editingSystem.set(true);
        double!.reset();

        // an empty system message is rejected server-side, so a blank commit only clears
        await chat.execute<void, Promise<void>>(CHAT_SYSTEM_SAVE_COMMAND);
        await chat.execute<void, Promise<void>>(CHAT_SYSTEM_SAVE_COMMAND);

        expect(double!.calls()).toEqual([]);
        expect(chat.state<string>(CHAT_SYSTEM_DRAFT_STATE).get()).toBe('');
        expect(chat.state<boolean>(CHAT_EDITING_SYSTEM_STATE).get()).toBe(false);
        expect(chat.state<ChatTranscript>(CHAT_TRANSCRIPT_STATE).get()).toEqual(
            RECORD_WITHOUT_PROMPT.messages
        );
    });

    it('lets a second save overlap the prompt persist', async () => {
        // the PUT owns the conversation until it settles (:3230)
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const { instance: chat, cells } = await openConversation(RECORD_WITHOUT_PROMPT, {
            onPut: () =>
                gate.then(() =>
                    jsonResponse(200, {
                        conversationId: 'conv-1',
                        conversation: {
                            ...RECORD_WITHOUT_PROMPT,
                            messages: PROMPTED_HISTORY,
                            messageCount: PROMPTED_HISTORY.length
                        }
                    })
                )
        });
        cells.systemDraft.set('Answer briefly');
        double!.reset();

        const first = chat.execute<void, Promise<void>>(CHAT_SYSTEM_SAVE_COMMAND);
        expect(chat.state<string>(CHAT_STATUS_STATE).get()).toBe('saving');
        await chat.execute<void, Promise<void>>(CHAT_SYSTEM_SAVE_COMMAND);

        release();
        await first;

        expect(double!.calls().filter((call) => call.method === 'PUT')).toHaveLength(1);
        expect(chat.state<string>(CHAT_STATUS_STATE).get()).toBe('idle');
        expect(chat.state<string>(CHAT_SYSTEM_DRAFT_STATE).get()).toBe('');
    });

    it('applies nothing to the surface when the session switches mid-save', async () => {
        // EPOCH GUARD (R7): the write still lands in the namespace that asked for it, but
        // its response touches neither the new conversation's transcript nor its draft
        // (:3232-3239, :3269-3276).
        const second = recordFixture('conv-2', {
            title: 'Second chat',
            model: 'alpha/flash',
            messages: [{ role: 'user', content: 'Second chat' }]
        });
        seedTrackedIds(['conv-1', 'conv-2']);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let current: unknown = RECORD_WITHOUT_PROMPT;
        const fetchDouble = installFetch([
            catalogRoute,
            {
                match: (url) => url === `${TEST_BASE_URL}/conv-1`,
                reply: (url, init) =>
                    (init?.method ?? 'GET') === 'PUT'
                        ? gate.then(() => {
                              const body = JSON.parse(String(init?.body ?? '{}')) as {
                                  messages?: unknown[];
                              };
                              current = {
                                  ...RECORD_WITHOUT_PROMPT,
                                  messages: body.messages,
                                  messageCount: (body.messages ?? []).length
                              };
                              return jsonResponse(200, {
                                  conversationId: 'conv-1',
                                  conversation: current
                              });
                          })
                        : jsonResponse(200, {
                              conversationId: 'conv-1',
                              conversation: current
                          })
            },
            {
                match: (url) => url === `${TEST_BASE_URL}/conv-2`,
                reply: () => jsonResponse(200, { conversationId: 'conv-2', conversation: second })
            },
            {
                match: (url) => url.startsWith(TEST_BASE_URL),
                reply: () =>
                    jsonResponse(200, {
                        conversations: [
                            summaryFixture(current as ReturnType<typeof recordFixture>),
                            summaryFixture(second)
                        ]
                    })
            }
        ]);
        const chat = createTestChat();
        await chat.execute<string, Promise<void>>(CHAT_SESSION_SELECT_COMMAND, 'conv-1');
        const cells = chat.service<ChatCells>(CHAT_CELLS_SERVICE);
        cells.systemDraft.set('Answer briefly');

        const first = chat.execute<void, Promise<void>>(CHAT_SYSTEM_SAVE_COMMAND);
        expect(chat.state<string>(CHAT_STATUS_STATE).get()).toBe('saving');
        await chat.execute<string, Promise<void>>(CHAT_SESSION_SELECT_COMMAND, 'conv-2');
        release();
        await first;

        expect(chat.state<string | null>(CHAT_ACTIVE_SESSION_STATE).get()).toBe('conv-2');
        expect(chat.state<ChatTranscript>(CHAT_TRANSCRIPT_STATE).get()).toEqual(second.messages);
        // the switch owns the draft reset; the stale settle must not re-fill it
        expect(chat.state<string>(CHAT_SYSTEM_DRAFT_STATE).get()).toBe('');
        expect(chat.state<string>(CHAT_ERROR_STATE).get()).toBe('');
        expect(chat.state<string>(CHAT_STATUS_STATE).get()).toBe('idle');
        // the row of the conversation that WAS edited still follows the write
        expect(
            chat
                .state<readonly ChatSession[]>(CHAT_SESSIONS_STATE)
                .get()
                .map((row) => [row.conversationId, row.messageCount])
        ).toEqual([
            ['conv-1', 3],
            ['conv-2', 1]
        ]);
    });
});

// ——— commit on the new-chat surface ——————————————————————————————————————————————————————

describe('chat.system — save on the new-chat surface', () => {
    it('creates a conversation of its own and makes it the open surface', async () => {
        seedTrackedIds([]);
        const fetchDouble = installFetch([
            catalogRoute,
            {
                match: (url) => url === `${TEST_BASE_URL}/conv-prompt`,
                reply: () =>
                    jsonResponse(200, { conversationId: 'conv-prompt', conversation: PROMPT_RECORD })
            },
            {
                match: (url) => url.startsWith(TEST_BASE_URL),
                reply: (url, init) =>
                    (init?.method ?? 'GET') === 'POST'
                        ? jsonResponse(201, { conversationId: 'conv-prompt' })
                        : jsonResponse(200, { conversations: [summaryFixture(PROMPT_RECORD)] })
            }
        ]);
        const chat = createTestChat();
        const cells = chat.service<ChatCells>(CHAT_CELLS_SERVICE);
        await waitForBoot(fetchDouble);
        // an explicit selection is what the create carries, so the request is reproducible
        cells.model.set('zeta/turbo');
        cells.systemDraft.set('  Answer briefly  ');
        chat.execute<void, void>(CHAT_SYSTEM_BEGIN_COMMAND);
        expect(chat.state<string | null>(CHAT_ACTIVE_SESSION_STATE).get()).toBeNull();
        fetchDouble.reset();
        const events = recordEvents(chat, [
            CHAT_SESSION_CREATED_EVENT,
            CHAT_TRANSCRIPT_UPDATED_EVENT,
            CHAT_NOTICE_EVENT
        ]);

        await chat.execute<void, Promise<void>>(CHAT_SYSTEM_SAVE_COMMAND);

        // leaving the page before the first user send must not lose the edit (:3243-3258)
        expect(fetchDouble.calls()).toEqual([
            {
                url: TEST_BASE_URL,
                method: 'POST',
                body: { model: 'zeta/turbo', systemPrompt: 'Answer briefly' }
            },
            { url: `${TEST_BASE_URL}/conv-prompt`, method: 'GET', body: null }
        ]);
        expect(chat.state<string | null>(CHAT_ACTIVE_SESSION_STATE).get()).toBe('conv-prompt');
        expect(chat.state<ChatTranscript>(CHAT_TRANSCRIPT_STATE).get()).toEqual(
            PROMPT_RECORD.messages
        );
        expect(chat.state<readonly number[]>(CHAT_COLLAPSED_TURNS_STATE).get()).toEqual([0]);
        expect(chat.state<string>(CHAT_SYSTEM_DRAFT_STATE).get()).toBe('');
        expect(chat.state<readonly ChatSession[]>(CHAT_SESSIONS_STATE).get()).toEqual([
            summaryFixture(PROMPT_RECORD)
        ]);
        // the prompt-only conversation is tracked, so a reload restores it
        expect(readTrackedIds()).toEqual(['conv-prompt']);
        expect(payloadsOf(events, CHAT_SESSION_CREATED_EVENT)).toEqual([
            { sessionId: 'conv-prompt', title: 'Answer briefly' }
        ]);
        expect(payloadsOf(events, CHAT_TRANSCRIPT_UPDATED_EVENT)).toEqual([
            { sessionId: 'conv-prompt', turnCount: 1 }
        ]);
        expect(payloadsOf(events, CHAT_NOTICE_EVENT)).toEqual([
            { message: 'System prompt saved.' }
        ]);
        expect(chat.state<string>(CHAT_MODEL_STATE).get()).toBe('zeta/turbo');
        expect(chat.state<string>(CHAT_STATUS_STATE).get()).toBe('idle');
    });

    it('omits the model field when none is selected', async () => {
        seedTrackedIds([]);
        const fetchDouble = installFetch([
            // no catalog route: an empty selection must not send `model`, or the store's
            // own validation rejects the create (api/chat-assistant.ts, api/offline.ts)
            {
                match: (url) => url === `${TEST_BASE_URL}/conv-prompt`,
                reply: () =>
                    jsonResponse(200, {
                        conversationId: 'conv-prompt',
                        conversation: { ...PROMPT_RECORD, model: '' }
                    })
            },
            {
                match: (url) => url.startsWith(TEST_BASE_URL),
                reply: (url, init) =>
                    (init?.method ?? 'GET') === 'POST'
                        ? jsonResponse(201, { conversationId: 'conv-prompt' })
                        : jsonResponse(200, {
                              conversations: [summaryFixture({ ...PROMPT_RECORD, model: '' })]
                          })
            }
        ]);
        const chat = createTestChat();
        await vi.waitFor(() =>
            expect(fetchDouble.callsFor(`${TEST_BASE_URL}?ids=`)).toHaveLength(1)
        );
        expect(chat.state<string>(CHAT_MODEL_STATE).get()).toBe('');
        const cells = chat.service<ChatCells>(CHAT_CELLS_SERVICE);
        cells.systemDraft.set('Answer briefly');
        fetchDouble.reset();

        await chat.execute<void, Promise<void>>(CHAT_SYSTEM_SAVE_COMMAND);

        expect(fetchDouble.calls()[0]).toEqual({
            url: TEST_BASE_URL,
            method: 'POST',
            body: { systemPrompt: 'Answer briefly' }
        });
        expect(chat.state<string>(CHAT_MODEL_STATE).get()).toBe('');
        expect(chat.state<string>(CHAT_ERROR_STATE).get()).toBe('');
    });
});

// ——— the namespace the prompt belongs to —————————————————————————————————————————————————

describe('chat.system — offline persistence', () => {
    it('rewrites the browser-local record and never touches the endpoint', async () => {
        const { upsertLocalConversation, getLocalConversation } = await import('../../api/offline');
        const local = recordFixture('local-1', {
            title: 'Local chat',
            model: 'alpha/flash',
            messages: [{ role: 'user', content: 'Hello assistant' }]
        });
        upsertLocalConversation(local as never);
        // no storage-endpoint route at all: an online write would surface as unrouted
        const fetchDouble = installFetch([catalogRoute]);
        const chat = createTestChat();
        chat.state<ChatMode>(CHAT_MODE_STATE).set('offline');
        await vi.waitFor(() =>
            expect(chat.state<readonly ChatSession[]>(CHAT_SESSIONS_STATE).get()).toEqual([
                summaryFixture(local)
            ])
        );

        await chat.execute<string, Promise<void>>(CHAT_SESSION_SELECT_COMMAND, 'local-1');
        const cells = chat.service<ChatCells>(CHAT_CELLS_SERVICE);
        cells.systemDraft.set('Answer briefly');
        fetchDouble.reset();
        const events = recordEvents(chat, [CHAT_TRANSCRIPT_UPDATED_EVENT, CHAT_ERROR_EVENT]);

        await chat.execute<void, Promise<void>>(CHAT_SYSTEM_SAVE_COMMAND);

        const persisted = await getLocalConversation('local-1');
        expect(persisted.conversation.messages).toEqual([
            { role: 'system', content: 'Answer briefly' },
            { role: 'user', content: 'Hello assistant' }
        ]);
        expect(chat.state<ChatTranscript>(CHAT_TRANSCRIPT_STATE).get()).toEqual(
            persisted.conversation.messages
        );
        expect(payloadsOf(events, CHAT_TRANSCRIPT_UPDATED_EVENT)).toEqual([
            { sessionId: 'local-1', turnCount: 2 }
        ]);
        expect(payloadsOf(events, CHAT_ERROR_EVENT)).toEqual([]);
        expect(fetchDouble.calls()).toEqual([]);
        expect(chat.state<string>(CHAT_SYSTEM_DRAFT_STATE).get()).toBe('');
    });
});
