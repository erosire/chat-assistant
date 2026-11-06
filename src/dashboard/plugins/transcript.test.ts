// Chat TRANSCRIPT plugin tests: the per-turn flows.
//
// Headless, no render: `createTestChat()` builds the real composition, `fetch` is the
// harness's route-matched double, and the storage routes behave like the server — a PUT
// persists the sent history verbatim and the following canonical GET answers it. That is
// what makes the assertions exact: the transcript a test sees is the record the STORE
// returned, so the sent body is the only place a rewrite rule can be pinned.
//
// Every expectation comes from the ported oracle (components/ChatAssistantApp.tsx):
//   copy   :3649-3678   fork   :3680-3737   role :1966-1980, :3603-3647
//   delete :3559-3601   update :3818-3853   turn :4272-4280
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dashboard } from '@underload/dashboard';
import {
    CHAT_ACTIVE_SESSION_STATE,
    CHAT_AUTOSCROLL_STATE,
    CHAT_AUTOSCROLL_TOGGLE_COMMAND,
    CHAT_CELLS_SERVICE,
    CHAT_COLLAPSED_TURNS_STATE,
    CHAT_COMPOSER_FOCUS_COMMAND,
    CHAT_EDITING_INDEX_STATE,
    CHAT_ERROR_EVENT,
    CHAT_ERROR_STATE,
    CHAT_MESSAGE_COPY_COMMAND,
    CHAT_MESSAGE_DELETE_COMMAND,
    CHAT_MESSAGE_FORK_COMMAND,
    CHAT_MESSAGE_ROLE_COMMAND,
    CHAT_MESSAGE_UPDATE_COMMAND,
    CHAT_MODEL_STATE,
    CHAT_NOTICE_EVENT,
    CHAT_SESSION_CREATED_EVENT,
    CHAT_SESSION_SELECTED_EVENT,
    CHAT_SESSIONS_STATE,
    CHAT_SESSION_SELECT_COMMAND,
    CHAT_STATUS_STATE,
    CHAT_SYSTEM_DRAFT_STATE,
    CHAT_TRANSCRIPT_STATE,
    CHAT_TRANSCRIPT_UPDATED_EVENT,
    CHAT_TURN_TOGGLE_COMMAND,
    CHAT_TURNS_STATE,
    type ChatCells,
    type ChatSession,
    type ChatTranscript,
    type ChatTurn,
    type NoticeEvent,
    type SessionCreatedEvent,
    type SessionSelectedEvent,
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

/** The catalog every case answers, so the model cell is never empty by accident. */
const catalogRoute = {
    match: (url: string) => url === PROVIDER_MODELS,
    reply: () =>
        jsonResponse(200, { object: 'list', data: [{ id: 'alpha/flash' }, { id: 'zeta/turbo' }] })
};

/**
 * The open conversation, with a leading system block so the "system turns are
 * immutable through these controls" guards are reachable.
 */
const SOURCE_RECORD = recordFixture('conv-1', {
    title: 'Hello assistant',
    model: 'alpha/flash',
    messages: [
        { role: 'system', content: 'Answer briefly' },
        { role: 'user', content: 'Hello assistant' },
        { role: 'assistant', content: 'Hello user', model: 'test/model' }
    ]
});

/** What the server derives from a replaced history: the sent messages, verbatim. */
type PutBody = { messages?: Array<{ role: string; content: string; model?: string }> };

let instance: Dashboard | null = null;
let double: FetchDouble | null = null;

beforeEach(() => {
    resetStorage();
});

afterEach(() => {
    instance?.dispose();
    instance = null;
    double = null;
    // the clipboard seams are stubbed per-case; never leak them into the next one
    delete (document as any).execCommand;
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
});

/**
 * Boot the composition with a live store for SOURCE_RECORD and open it.
 *
 * `onPut` lets a case answer the write with something other than the echo (a rejection,
 * a re-derived record); by default the store behaves exactly like the server: the sent
 * history becomes the canonical record, so the following GET proves what landed.
 */
async function openConversation(
    options: {
        record?: ReturnType<typeof recordFixture>;
        onPut?: (body: PutBody) => Response;
        select?: boolean;
    } = {}
): Promise<{ instance: Dashboard; double: FetchDouble; cells: ChatCells }> {
    const base = options.record ?? SOURCE_RECORD;
    let current: unknown = base;
    seedTrackedIds([base.conversationId]);
    const fetchDouble = installFetch([
        catalogRoute,
        {
            match: (url) => url === `${TEST_BASE_URL}/${base.conversationId}`,
            reply: (url, init) => {
                if ((init?.method ?? 'GET') === 'PUT') {
                    const body = JSON.parse(String(init?.body ?? '{}')) as PutBody;
                    if (options.onPut) return options.onPut(body);
                    const messages = body.messages ?? [];
                    current = { ...current, messages, messageCount: messages.length };
                    return jsonResponse(200, {
                        conversationId: base.conversationId,
                        conversation: current
                    });
                }
                return jsonResponse(200, {
                    conversationId: base.conversationId,
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
    // the module-level handle is what the cases reset/assert on, so keep them in step
    double = fetchDouble;
    if (options.select !== false) {
        await chat.execute<string, Promise<void>>(CHAT_SESSION_SELECT_COMMAND, base.conversationId);
    }
    return { instance: chat, double: fetchDouble, cells: chat.service<ChatCells>(CHAT_CELLS_SERVICE) };
}

// ——— copy ————————————————————————————————————————————————————————————————————————————

describe('chat.transcript — copy', () => {
    /**
     * jsdom has no clipboard, so the textarea + `execCommand('copy')` fallback is what
     * runs. The stub reads the scratch textarea while it is still mounted: the value in
     * it IS the copy payload, so an off-by-one in the turn lookup fails loudly.
     */
    const stubFallbackCopy = (reply = true): string[] => {
        const copied: string[] = [];
        Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
        (document as any).execCommand = (command: string) => {
            if (command !== 'copy') return false;
            const scratch = document.querySelector('textarea');
            if (!reply) throw new Error('Copy blocked');
            copied.push(scratch?.value ?? '');
            return true;
        };
        return copied;
    };

    it('copies the raw text of one turn and removes the scratch node', async () => {
        const copied = stubFallbackCopy();
        const { instance: chat } = await openConversation();

        chat.execute<number, void>(CHAT_MESSAGE_COPY_COMMAND, 2);

        await vi.waitFor(() => expect(copied).toEqual(['Hello user']));
        // the fallback cleans its scratch element up on the same tick it copies
        expect(document.querySelector('textarea')).toBeNull();
        expect(chat.state<string>(CHAT_ERROR_STATE).get()).toBe('');
    });

    it('copies the system-prompt draft at the -1 sentinel', async () => {
        const copied = stubFallbackCopy();
        const { instance: chat, cells } = await openConversation();
        // the draft turn is not part of `chat.turns`; its text lives in chat.systemDraft
        expect(chat.state<readonly unknown[]>(CHAT_TURNS_STATE).get()).toHaveLength(3);

        cells.systemDraft.set('Speak like a pirate');
        chat.execute<number, void>(CHAT_MESSAGE_COPY_COMMAND, -1);

        await vi.waitFor(() => expect(copied).toEqual(['Speak like a pirate']));
    });

    it('reports a rejected copy in chat.error and emits chat.error', async () => {
        const copied = stubFallbackCopy(false);
        const chat = (await openConversation()).instance;
        const events = recordEvents(chat, [CHAT_ERROR_EVENT]);

        chat.execute<number, void>(CHAT_MESSAGE_COPY_COMMAND, 1);

        await vi.waitFor(() =>
            expect(chat.state<string>(CHAT_ERROR_STATE).get()).toBe('Copy blocked')
        );
        expect(payloadsOf(events, CHAT_ERROR_EVENT)).toEqual([
            { message: 'Copy blocked' } satisfies NoticeEvent
        ]);
        expect(copied).toEqual([]);
    });

    it('copies an out-of-range turn as empty text instead of throwing', async () => {
        const copied = stubFallbackCopy();
        const { instance: chat } = await openConversation();

        chat.execute<number, void>(CHAT_MESSAGE_COPY_COMMAND, 9);

        await vi.waitFor(() => expect(copied).toEqual(['']));
        expect(chat.state<string>(CHAT_ERROR_STATE).get()).toBe('');
    });
});

// ——— role switch —————————————————————————————————————————————————————————————————————

describe('chat.transcript — role switch', () => {
    it('assistant -> user drops the storage-only model attribution', async () => {
        const { instance: chat } = await openConversation();
        double!.reset();
        const events = recordEvents(chat, [CHAT_TRANSCRIPT_UPDATED_EVENT]);

        await chat.execute<{ index: number; role: 'user' }, Promise<void>>(
            CHAT_MESSAGE_ROLE_COMMAND,
            { index: 2, role: 'user' }
        );

        // the whole history round-trips through the identified PUT, and the reply's
        // producing-model label is assistant metadata: it is dropped, not carried
        expect(double!.calls()).toEqual([
            {
                url: `${TEST_BASE_URL}/conv-1`,
                method: 'PUT',
                body: {
                    messages: [
                        { role: 'system', content: 'Answer briefly' },
                        { role: 'user', content: 'Hello assistant' },
                        { role: 'user', content: 'Hello user' }
                    ]
                }
            }
        ]);
        // the surface adopts the CANONICAL record, and the collapse defaults re-seed:
        // with no assistant reply left, every turn folds
        expect(chat.state<ChatTranscript>(CHAT_TRANSCRIPT_STATE).get()).toEqual([
            { role: 'system', content: 'Answer briefly' },
            { role: 'user', content: 'Hello assistant' },
            { role: 'user', content: 'Hello user' }
        ]);
        expect(chat.state<readonly number[]>(CHAT_COLLAPSED_TURNS_STATE).get()).toEqual([0, 1, 2]);
        expect(chat.state<string>(CHAT_STATUS_STATE).get()).toBe('idle');
        expect(payloadsOf(events, CHAT_TRANSCRIPT_UPDATED_EVENT)).toEqual([
            { sessionId: 'conv-1', turnCount: 3 } satisfies TranscriptUpdatedEvent
        ]);
    });

    it('user -> assistant stamps the currently selected model', async () => {
        const { instance: chat, cells } = await openConversation();
        // the label a hand-swapped turn carries is the live selection, exactly like the
        // model a streamed reply would record
        cells.model.set('zeta/turbo');
        double!.reset();

        await chat.execute<{ index: number; role: 'assistant' }, Promise<void>>(
            CHAT_MESSAGE_ROLE_COMMAND,
            { index: 1, role: 'assistant' }
        );

        expect(double!.calls()[0].body).toEqual({
            messages: [
                { role: 'system', content: 'Answer briefly' },
                { role: 'assistant', content: 'Hello assistant', model: 'zeta/turbo' },
                { role: 'assistant', content: 'Hello user', model: 'test/model' }
            ]
        });
        expect(chat.state<string>(CHAT_MODEL_STATE).get()).toBe('zeta/turbo');
    });

    it('sends nothing for a system turn, an unknown row or the role it already has', async () => {
        const { instance: chat } = await openConversation();
        double!.reset();

        await chat.execute<{ index: number; role: 'user' }, Promise<void>>(
            CHAT_MESSAGE_ROLE_COMMAND,
            { index: 0, role: 'user' }
        );
        await chat.execute<{ index: number; role: 'user' }, Promise<void>>(
            CHAT_MESSAGE_ROLE_COMMAND,
            { index: 9, role: 'user' }
        );
        await chat.execute<{ index: number; role: 'assistant' }, Promise<void>>(
            CHAT_MESSAGE_ROLE_COMMAND,
            { index: 2, role: 'assistant' }
        );

        expect(double!.calls()).toEqual([]);
        expect(chat.state<ChatTranscript>(CHAT_TRANSCRIPT_STATE).get()).toEqual(
            SOURCE_RECORD.messages
        );
        expect(chat.state<string>(CHAT_ERROR_STATE).get()).toBe('');
    });

    it('leaves the surface untouched when the store rejects the rewrite', async () => {
        const { instance: chat } = await openConversation({
            onPut: () => jsonResponse(500, { error: 'Storage is down' })
        });
        double!.reset();
        const events = recordEvents(chat, [CHAT_ERROR_EVENT]);

        await chat.execute<{ index: number; role: 'user' }, Promise<void>>(
            CHAT_MESSAGE_ROLE_COMMAND,
            { index: 2, role: 'user' }
        );

        expect(payloadsOf(events, CHAT_ERROR_EVENT)).toEqual([
            { message: 'Storage is down' }
        ]);
        expect(chat.state<string>(CHAT_ERROR_STATE).get()).toBe('Storage is down');
        expect(chat.state<ChatTranscript>(CHAT_TRANSCRIPT_STATE).get()).toEqual(
            SOURCE_RECORD.messages
        );
        expect(chat.state<string>(CHAT_STATUS_STATE).get()).toBe('idle');
    });

    it('drops the switch while another save owns the surface', async () => {
        // `savingEdit` in the oracle: a second history write never overlaps the first
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const { instance: chat } = await openConversation({
            onPut: () =>
                gate.then(() =>
                    jsonResponse(200, {
                        conversationId: 'conv-1',
                        conversation: {
                            ...SOURCE_RECORD,
                            messages: [
                                { role: 'system', content: 'Answer briefly' },
                                { role: 'user', content: 'Hello assistant' },
                                { role: 'user', content: 'Hello user' }
                            ]
                        }
                    })
                )
        });
        double!.reset();

        const first = chat.execute<{ index: number; role: 'user' }, Promise<void>>(
            CHAT_MESSAGE_ROLE_COMMAND,
            { index: 2, role: 'user' }
        );
        expect(chat.state<string>(CHAT_STATUS_STATE).get()).toBe('saving');
        const second = chat.execute<number, Promise<void>>(CHAT_MESSAGE_DELETE_COMMAND, 1);

        await second;
        release();
        await first;

        expect(double!.calls().filter((call) => call.method === 'PUT')).toHaveLength(1);
        expect(chat.state<string>(CHAT_STATUS_STATE).get()).toBe('idle');
        expect(chat.state<ChatTranscript>(CHAT_TRANSCRIPT_STATE).get()).toEqual([
            { role: 'system', content: 'Answer briefly' },
            { role: 'user', content: 'Hello assistant' },
            { role: 'user', content: 'Hello user' }
        ]);
    });
});

// ——— delete ————————————————————————————————————————————————————————————————————————————

describe('chat.transcript — delete', () => {
    it('removes one turn and re-derives the collapse defaults', async () => {
        const { instance: chat } = await openConversation();
        double!.reset();
        const events = recordEvents(chat, [CHAT_TRANSCRIPT_UPDATED_EVENT]);

        await chat.execute<number, Promise<void>>(CHAT_MESSAGE_DELETE_COMMAND, 1);

        expect(double!.calls()).toEqual([
            {
                url: `${TEST_BASE_URL}/conv-1`,
                method: 'PUT',
                body: {
                    messages: [
                        { role: 'system', content: 'Answer briefly' },
                        { role: 'assistant', content: 'Hello user', model: 'test/model' }
                    ]
                }
            }
        ]);
        const turns = chat.state<readonly ChatTurn[]>(CHAT_TURNS_STATE).get();
        expect(turns.map((turn) => [turn.index, turn.role, turn.collapsed, turn.model])).toEqual([
            [0, 'system', true, ''],
            [1, 'assistant', false, 'test/model']
        ]);
        expect(payloadsOf(events, CHAT_TRANSCRIPT_UPDATED_EVENT)).toEqual([
            { sessionId: 'conv-1', turnCount: 2 }
        ]);
    });

    it('never issues a request for a system turn', async () => {
        const { instance: chat } = await openConversation();
        double!.reset();

        await chat.execute<number, Promise<void>>(CHAT_MESSAGE_DELETE_COMMAND, 0);

        expect(double!.calls()).toEqual([]);
        expect(chat.state<ChatTranscript>(CHAT_TRANSCRIPT_STATE).get()).toEqual(
            SOURCE_RECORD.messages
        );
    });
});

// ——— inline edit commit —————————————————————————————————————————————————————————————————

describe('chat.transcript — update', () => {
    it('commits edited content through the whole-history PUT and closes the editor', async () => {
        const { instance: chat, cells } = await openConversation();
        cells.editingIndex.set(2);
        double!.reset();
        const events = recordEvents(chat, [CHAT_TRANSCRIPT_UPDATED_EVENT]);

        await chat.execute<{ index: number; content: string }, Promise<void>>(
            CHAT_MESSAGE_UPDATE_COMMAND,
            { index: 2, content: '  Goodbye user  ' }
        );

        // only `content` changes: the role and the producing-model attribution survive
        expect(double!.calls()).toEqual([
            {
                url: `${TEST_BASE_URL}/conv-1`,
                method: 'PUT',
                body: {
                    messages: [
                        { role: 'system', content: 'Answer briefly' },
                        { role: 'user', content: 'Hello assistant' },
                        { role: 'assistant', content: 'Goodbye user', model: 'test/model' }
                    ]
                }
            }
        ]);
        expect(chat.state<number | null>(CHAT_EDITING_INDEX_STATE).get()).toBeNull();
        expect(payloadsOf(events, CHAT_TRANSCRIPT_UPDATED_EVENT)).toEqual([
            { sessionId: 'conv-1', turnCount: 3 }
        ]);
    });

    it('closes the editor without a request for unchanged or blank text', async () => {
        const { instance: chat, cells } = await openConversation();

        cells.editingIndex.set(2);
        await chat.execute<{ index: number; content: string }, Promise<void>>(
            CHAT_MESSAGE_UPDATE_COMMAND,
            { index: 2, content: 'Hello user' }
        );
        cells.editingIndex.set(2);
        await chat.execute<{ index: number; content: string }, Promise<void>>(
            CHAT_MESSAGE_UPDATE_COMMAND,
            { index: 2, content: '   ' }
        );

        // empty messages are forbidden server-side, so a blank close is client-only
        expect(double!.callsFor('/conv-1').filter((call) => call.method === 'PUT')).toEqual([]);
        expect(chat.state<number | null>(CHAT_EDITING_INDEX_STATE).get()).toBeNull();
        expect(chat.state<ChatTranscript>(CHAT_TRANSCRIPT_STATE).get()).toEqual(
            SOURCE_RECORD.messages
        );
    });

    it('ignores an update addressed to a row that is not there', async () => {
        const { instance: chat } = await openConversation();
        double!.reset();

        await chat.execute<{ index: number; content: string }, Promise<void>>(
            CHAT_MESSAGE_UPDATE_COMMAND,
            { index: 9, content: 'Changed' }
        );

        expect(double!.calls()).toEqual([]);
    });

    it('closes the editor even when the commit fails', async () => {
        const { instance: chat, cells } = await openConversation({
            onPut: () => jsonResponse(409, { error: 'Read-only transcript' })
        });
        cells.editingIndex.set(2);

        await chat.execute<{ index: number; content: string }, Promise<void>>(
            CHAT_MESSAGE_UPDATE_COMMAND,
            { index: 2, content: 'Goodbye user' }
        );

        // the commit belongs to the surface that made it, so the editor closes first
        expect(chat.state<number | null>(CHAT_EDITING_INDEX_STATE).get()).toBeNull();
        expect(chat.state<string>(CHAT_ERROR_STATE).get()).toBe('Read-only transcript');
        expect(chat.state<ChatTranscript>(CHAT_TRANSCRIPT_STATE).get()).toEqual(
            SOURCE_RECORD.messages
        );
    });

    it('needs no conversation on the new-chat surface', async () => {
        const { instance: chat } = await openConversation({ select: false });
        expect(chat.state<string | null>(CHAT_ACTIVE_SESSION_STATE).get()).toBeNull();
        double!.reset();

        await chat.execute<{ index: number; content: string }, Promise<void>>(
            CHAT_MESSAGE_UPDATE_COMMAND,
            { index: 0, content: 'Changed' }
        );

        expect(double!.calls()).toEqual([]);
    });
});

// ——— fork ————————————————————————————————————————————————————————————————————————————————

describe('chat.transcript — fork', () => {
    const FORK_RECORD = recordFixture('conv-fork', {
        title: 'Hello assistant',
        model: 'alpha/flash',
        messages: [
            { role: 'system', content: 'Answer briefly' },
            { role: 'user', content: 'Hello assistant' }
        ]
    });

    /** Boot a store that also owns the fork branch, and open the source conversation. */
    async function openForkable(options: { create?: Response } = {}) {
        const created = options.create ?? jsonResponse(201, { conversationId: 'conv-fork' });
        // the branch exists in the store only after a POST has actually succeeded
        let forkExists = false;
        seedTrackedIds(['conv-1']);
        const fetchDouble = installFetch([
            catalogRoute,
            {
                match: (url) => url === `${TEST_BASE_URL}/conv-fork`,
                reply: () =>
                    jsonResponse(200, { conversationId: 'conv-fork', conversation: FORK_RECORD })
            },
            {
                match: (url) => url === `${TEST_BASE_URL}/conv-1`,
                reply: () =>
                    jsonResponse(200, { conversationId: 'conv-1', conversation: SOURCE_RECORD })
            },
            {
                // the collection list ({base}?ids=...) and the branch POST share this
                // route; only a successful POST makes the branch part of the listing
                match: (url) => url.startsWith(TEST_BASE_URL),
                reply: (url, init) => {
                    if ((init?.method ?? 'GET') !== 'POST') {
                        return jsonResponse(200, {
                            conversations: forkExists
                                ? [summaryFixture(FORK_RECORD), summaryFixture(SOURCE_RECORD)]
                                : [summaryFixture(SOURCE_RECORD)]
                        });
                    }
                    if (created.ok) forkExists = true;
                    return created;
                }
            }
        ]);
        const chat = createTestChat();
        await chat.execute<string, Promise<void>>(CHAT_SESSION_SELECT_COMMAND, 'conv-1');
        return { instance: chat, double: fetchDouble };
    }

    it('copies an inclusive branch, tracks it and selects the new conversation', async () => {
        const { instance: chat, double: fetchDouble } = await openForkable();
        fetchDouble.reset();
        const events = recordEvents(chat, [
            CHAT_SESSION_CREATED_EVENT,
            CHAT_SESSION_SELECTED_EVENT,
            CHAT_TRANSCRIPT_UPDATED_EVENT,
            CHAT_NOTICE_EVENT
        ]);

        const forkedId = await chat.execute<number, Promise<string | null>>(
            CHAT_MESSAGE_FORK_COMMAND,
            1
        );

        expect(forkedId).toBe('conv-fork');
        // the selected index is INCLUSIVE: the fork carries the prompt and the question,
        // and the source record is never rewritten (no PUT anywhere)
        expect(fetchDouble.calls()).toEqual([
            {
                url: TEST_BASE_URL,
                method: 'POST',
                body: {
                    messages: [
                        { role: 'system', content: 'Answer briefly' },
                        { role: 'user', content: 'Hello assistant' }
                    ],
                    model: 'alpha/flash'
                }
            },
            { url: `${TEST_BASE_URL}/conv-fork`, method: 'GET', body: null }
        ]);
        // the branch is tracked before the canonical read, so a reload mid-flow keeps it
        expect(readTrackedIds()).toEqual(['conv-1', 'conv-fork']);
        expect(chat.state<string | null>(CHAT_ACTIVE_SESSION_STATE).get()).toBe('conv-fork');
        expect(chat.state<ChatTranscript>(CHAT_TRANSCRIPT_STATE).get()).toEqual(
            FORK_RECORD.messages
        );
        expect(chat.state<readonly ChatSession[]>(CHAT_SESSIONS_STATE).get().map((row) => row.conversationId)).toEqual([
            'conv-fork',
            'conv-1'
        ]);
        expect(chat.state<readonly number[]>(CHAT_COLLAPSED_TURNS_STATE).get()).toEqual([0, 1]);
        expect(chat.state<string>(CHAT_MODEL_STATE).get()).toBe('alpha/flash');
        expect(chat.state<string>(CHAT_STATUS_STATE).get()).toBe('idle');
        expect(payloadsOf(events, CHAT_SESSION_CREATED_EVENT)).toEqual([
            { sessionId: 'conv-fork', title: 'Hello assistant' } satisfies SessionCreatedEvent
        ]);
        expect(payloadsOf(events, CHAT_SESSION_SELECTED_EVENT)).toEqual([
            { sessionId: 'conv-fork' } satisfies SessionSelectedEvent
        ]);
        expect(payloadsOf(events, CHAT_TRANSCRIPT_UPDATED_EVENT)).toEqual([
            { sessionId: 'conv-fork', turnCount: 2 }
        ]);
        expect(payloadsOf(events, CHAT_NOTICE_EVENT)).toEqual([
            { message: 'Forked 2 messages into a new conversation.' }
        ]);
    });

    it('refuses to fork a system turn', async () => {
        const { instance: chat, double: fetchDouble } = await openForkable();
        fetchDouble.reset();

        const refused = await chat.execute<number, Promise<string | null>>(
            CHAT_MESSAGE_FORK_COMMAND,
            0
        );

        // the leading prompt block comes with the prefix anyway (:3695)
        expect(refused).toBeNull();
        expect(fetchDouble.calls()).toEqual([]);
        expect(chat.state<string | null>(CHAT_ACTIVE_SESSION_STATE).get()).toBe('conv-1');
        expect(chat.state<readonly unknown[]>(CHAT_TRANSCRIPT_STATE).get()).toHaveLength(3);
    });

    it('forks nothing on the new-chat surface', async () => {
        // no open conversation means no branch to copy, and no request is wasted
        seedTrackedIds([]);
        const fetchDouble = installFetch([
            catalogRoute,
            {
                match: (url) => url.startsWith(TEST_BASE_URL),
                reply: () => jsonResponse(200, { conversations: [] })
            }
        ]);
        const chat = createTestChat();
        // the boot reads (catalog + the scoped list) fire one microtask after setup, so
        // wait for them before clearing the log: a reset too early would leave them
        // behind and look like an unexpected fork request
        await vi.waitFor(() => expect(fetchDouble.calls()).toHaveLength(2));
        expect(chat.state<string | null>(CHAT_ACTIVE_SESSION_STATE).get()).toBeNull();
        fetchDouble.reset();

        const forked = await chat.execute<number, Promise<string | null>>(
            CHAT_MESSAGE_FORK_COMMAND,
            1
        );

        expect(forked).toBeNull();
        expect(fetchDouble.calls()).toEqual([]);
        expect(chat.state<string>(CHAT_STATUS_STATE).get()).toBe('idle');
    });

    it('reports a rejected fork and keeps the source conversation open', async () => {
        const { instance: chat, double: fetchDouble } = await openForkable({
            create: jsonResponse(500, { error: 'Storage is down' })
        });
        fetchDouble.reset();
        const events = recordEvents(chat, [CHAT_ERROR_EVENT]);

        const forked = await chat.execute<number, Promise<string | null>>(
            CHAT_MESSAGE_FORK_COMMAND,
            1
        );

        expect(forked).toBeNull();
        expect(payloadsOf(events, CHAT_ERROR_EVENT)).toEqual([
            { message: 'Storage is down' }
        ]);
        expect(chat.state<string>(CHAT_ERROR_STATE).get()).toBe('Storage is down');
        expect(chat.state<string | null>(CHAT_ACTIVE_SESSION_STATE).get()).toBe('conv-1');
        expect(chat.state<readonly ChatSession[]>(CHAT_SESSIONS_STATE).get().map((row) => row.conversationId)).toEqual([
            'conv-1'
        ]);
        expect(chat.state<string>(CHAT_STATUS_STATE).get()).toBe('idle');
        // the failed branch was never tracked, so a reload does not resurrect it
        expect(readTrackedIds()).toEqual(['conv-1']);
    });
});

// ——— pure view-state commands ——————————————————————————————————————————————————————————

describe('chat.transcript — collapse, autoscroll and focus', () => {
    it('folds and unfolds one turn without mutating the previous set', async () => {
        const { instance: chat } = await openConversation();
        const before = chat.state<readonly number[]>(CHAT_COLLAPSED_TURNS_STATE).get();
        expect(before).toEqual([0, 1]);

        chat.execute<number, void>(CHAT_TURN_TOGGLE_COMMAND, 1);
        expect(chat.state<readonly number[]>(CHAT_COLLAPSED_TURNS_STATE).get()).toEqual([0]);
        // the old snapshot is untouched: `chat.turns` is reference-compared, so an
        // in-place mutation would silently skip a re-render
        expect(before).toEqual([0, 1]);

        chat.execute<number, void>(CHAT_TURN_TOGGLE_COMMAND, 2);
        expect(chat.state<readonly number[]>(CHAT_COLLAPSED_TURNS_STATE).get()).toEqual([0, 2]);

        chat.execute<number, void>(CHAT_TURN_TOGGLE_COMMAND, 0);
        expect(chat.state<readonly number[]>(CHAT_COLLAPSED_TURNS_STATE).get()).toEqual([2]);

        // -1 is the system-prompt DRAFT row's sentinel and sorts first
        chat.execute<number, void>(CHAT_TURN_TOGGLE_COMMAND, -1);
        expect(chat.state<readonly number[]>(CHAT_COLLAPSED_TURNS_STATE).get()).toEqual([-1, 2]);

        chat.execute<number, void>(CHAT_TURN_TOGGLE_COMMAND, Number.NaN);
        expect(chat.state<readonly number[]>(CHAT_COLLAPSED_TURNS_STATE).get()).toEqual([-1, 2]);

        expect(double!.calls().filter((call) => call.method === 'PUT')).toEqual([]);
    });

    it('toggles autoscroll and hands the new value back', async () => {
        const chat = createTestChat();
        const initial = chat.state<boolean>(CHAT_AUTOSCROLL_STATE).get();

        const first = chat.execute<void, boolean>(CHAT_AUTOSCROLL_TOGGLE_COMMAND);
        expect(first).toBe(!initial);
        expect(chat.state<boolean>(CHAT_AUTOSCROLL_STATE).get()).toBe(!initial);

        const second = chat.execute<void, boolean>(CHAT_AUTOSCROLL_TOGGLE_COMMAND);
        expect(second).toBe(initial);
    });

    it('focuses the composer input when its owner has rendered it', () => {
        const chat = createTestChat();
        const input = document.createElement('textarea');
        input.setAttribute('data-testid', 'composer-input');
        document.body.appendChild(input);

        chat.execute<void, void>(CHAT_COMPOSER_FOCUS_COMMAND);
        expect(document.activeElement).toBe(input);
    });

    it('does nothing when no composer input exists', () => {
        const chat = createTestChat();
        const before = document.activeElement;

        chat.execute<void, void>(CHAT_COMPOSER_FOCUS_COMMAND);
        expect(document.activeElement).toBe(before);
    });
});
