// Chat SESSIONS plugin tests: the conversation lifecycle.
//
// Headless, no render: `createTestChat()` builds the real composition, `fetch` is
// the harness's route-matched double, and jsdom's own localStorage backs the
// persisted keys (settings / remembered model / tracked-id cache) — cleared before
// every case, so each test starts from a known browser.
//
// Every assertion is an EXACT value: the sidebar rows, the adopted transcript, the
// collapse defaults, the request log (method + url + parsed body) and the event
// payloads. The request log is what proves the namespace rules, which no amount of
// state-asserting can show on its own.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dashboard } from '@underload/dashboard';
import {
    CHAT_ACTIVE_SESSION_STATE,
    CHAT_AUTOSCROLL_STATE,
    CHAT_CELLS_SERVICE,
    CHAT_COLLAPSED_TURNS_STATE,
    CHAT_DRAWER_OPEN_STATE,
    CHAT_EDITING_SYSTEM_STATE,
    CHAT_ERROR_EVENT,
    CHAT_ERROR_STATE,
    CHAT_MODE_STATE,
    CHAT_MODELS_STATE,
    CHAT_MODEL_STATE,
    CHAT_SESSION_CREATE_COMMAND,
    CHAT_SESSION_DELETE_COMMAND,
    CHAT_SESSION_RENAME_COMMAND,
    CHAT_SESSION_SELECT_COMMAND,
    CHAT_SESSION_CREATED_EVENT,
    CHAT_SESSION_SELECTED_EVENT,
    CHAT_SESSIONS_STATE,
    CHAT_STATUS_STATE,
    CHAT_TRANSCRIPT_STATE,
    CHAT_TRANSCRIPT_UPDATED_EVENT,
    CHAT_TURNS_STATE,
    CHAT_USAGE_STATE,
    type ChatCells,
    type ChatMode,
    type ChatSession,
    type ChatTurn,
    type NoticeEvent,
    type TranscriptUpdatedEvent
} from '../contract';
import {
    jsonResponse,
    installFetch,
    payloadsOf,
    recordEvents,
    readRememberedModel,
    readTrackedIds,
    resetStorage,
    createTestChat,
    seedModel,
    seedTrackedIds,
    TEST_BASE_URL,
    TEST_PROVIDER_URL,
    recordFixture,
    summaryFixture,
    type FetchDouble
} from './harness';

const PROVIDER_MODELS = `${TEST_PROVIDER_URL}/models`;

/** The catalog every case answers, so the model cell is never empty by accident. */
const catalogRoute = {
    match: (url: string) => url === PROVIDER_MODELS,
    reply: () =>
        jsonResponse(200, {
            object: 'list',
            data: [{ id: 'alpha/flash' }, { id: 'zeta/turbo' }]
        })
};

describe('chat sessions — tracked-id listing on mount', () => {
    let instance: Dashboard | null = null;
    let fetchDouble: FetchDouble | null = null;

    beforeEach(() => {
        resetStorage();
    });

    afterEach(() => {
        instance?.dispose();
        instance = null;
        fetchDouble = null;
        vi.unstubAllGlobals();
    });

    it('asks for exactly the tracked ids and adopts the rows it gets back', async () => {
        seedTrackedIds(['conv-1']);
        const record = recordFixture('conv-1');
        fetchDouble = installFetch([
            catalogRoute,
            {
                match: (url) => url.startsWith(TEST_BASE_URL),
                reply: () => jsonResponse(200, { conversations: [summaryFixture(record)] })
            }
        ]);
        instance = createTestChat();
        const events = recordEvents(instance, [CHAT_TRANSCRIPT_UPDATED_EVENT]);

        await vi.waitFor(() => {
            expect(instance?.state<readonly ChatSession[]>(CHAT_SESSIONS_STATE).get()).toEqual([
                summaryFixture(record)
            ]);
        });
        // The list query is scoped to the browser's own ids — the sidebar never
        // downloads another browser's history.
        const list = fetchDouble.callsFor(TEST_BASE_URL)[0];
        expect(list).toEqual({
            url: `${TEST_BASE_URL}?ids=conv-1`,
            method: 'GET',
            body: null
        });
        expect(payloadsOf(events, CHAT_TRANSCRIPT_UPDATED_EVENT)).toEqual([]);
        // A successful listing leaves no banner behind.
        expect(instance.state<string>(CHAT_ERROR_STATE).get()).toBe('');
        expect(instance.state<string>(CHAT_STATUS_STATE).get()).toBe('idle');
    });

    it('prunes a tracked id the server no longer returns', async () => {
        // Deleted in another tab/device: the cache must not accumulate dead rows
        // (components/ChatAssistantApp.tsx:2810-2817).
        seedTrackedIds(['conv-1', 'conv-gone']);
        const live = recordFixture('conv-1');
        installFetch([
            catalogRoute,
            {
                match: (url) => url.startsWith(TEST_BASE_URL),
                reply: () => jsonResponse(200, { conversations: [summaryFixture(live)] })
            }
        ]);
        instance = createTestChat();

        await vi.waitFor(() => {
            expect(readTrackedIds()).toEqual(['conv-1']);
        });
        expect(instance.state<readonly ChatSession[]>(CHAT_SESSIONS_STATE).get()).toEqual([
            summaryFixture(live)
        ]);
    });

    it('surfaces a failed listing in chat.error and emits chat.error', async () => {
        seedTrackedIds(['conv-1']);
        installFetch([
            catalogRoute,
            {
                match: (url) => url.startsWith(TEST_BASE_URL),
                reply: () => jsonResponse(500, { error: 'Storage is down' })
            }
        ]);
        instance = createTestChat();
        const events = recordEvents(instance, [CHAT_ERROR_EVENT]);

        await vi.waitFor(() => {
            expect(instance?.state<string>(CHAT_ERROR_STATE).get()).toBe(
                'Storage is down'
            );
        });
        expect(payloadsOf(events, CHAT_ERROR_EVENT)).toEqual([
            { message: 'Storage is down' } satisfies NoticeEvent
        ]);
        expect(instance.state<readonly ChatSession[]>(CHAT_SESSIONS_STATE).get()).toEqual([]);
    });

    it('re-lists for the new namespace when the mode flips', async () => {
        // Each mode's sidebar owns its own namespace, so the two histories never
        // mix (:2827-2831: the effect deps include `offline`).
        seedTrackedIds(['conv-online']);
        const online = recordFixture('conv-online');
        const double = installFetch([
            catalogRoute,
            {
                match: (url) => url.startsWith(TEST_BASE_URL),
                reply: () => jsonResponse(200, { conversations: [summaryFixture(online)] })
            }
        ]);
        instance = createTestChat();
        await vi.waitFor(() => {
            expect(instance?.state<readonly ChatSession[]>(CHAT_SESSIONS_STATE).get()).toHaveLength(1);
        });

        // Offline listing reads the browser-local store, so the storage endpoint
        // must not be called again after the switch.
        const before = double.callsFor(TEST_BASE_URL).length;
        instance.state<ChatMode>(CHAT_MODE_STATE).set('offline');
        await vi.waitFor(() => {
            expect(instance?.state<readonly ChatSession[]>(CHAT_SESSIONS_STATE).get()).toEqual([]);
        });
        expect(double.callsFor(TEST_BASE_URL)).toHaveLength(before);
    });
});

describe('chat sessions — select', () => {
    let instance: Dashboard | null = null;
    let double: FetchDouble | null = null;
    const record = recordFixture('conv-1');

    beforeEach(() => {
        resetStorage();
        seedTrackedIds(['conv-1']);
        double = installFetch([
            catalogRoute,
            {
                match: (url) => url === `${TEST_BASE_URL}/conv-missing`,
                reply: () =>
                    jsonResponse(404, { error: "Conversation 'conv-missing' not found" })
            },
            {
                match: (url) => url === `${TEST_BASE_URL}/conv-1` ,
                reply: () => jsonResponse(200, { conversationId: 'conv-1', conversation: record })
            },
            {
                match: (url) => url.startsWith(TEST_BASE_URL),
                reply: () => jsonResponse(200, { conversations: [summaryFixture(record)] })
            }
        ]);
        instance = createTestChat();
    });

    afterEach(() => {
        instance?.dispose();
        instance = null;
        double = null;
        vi.unstubAllGlobals();
    });

    it('loads the record into the surface with the documented defaults', async () => {
        const events = recordEvents(instance!, [
            CHAT_SESSION_SELECTED_EVENT,
            CHAT_TRANSCRIPT_UPDATED_EVENT
        ]);
        await instance!.execute<string, Promise<void>>(CHAT_SESSION_SELECT_COMMAND, 'conv-1');

        expect(instance!.state<string | null>(CHAT_ACTIVE_SESSION_STATE).get()).toBe('conv-1');
        expect(instance!.state<readonly unknown[]>(CHAT_TRANSCRIPT_STATE).get()).toEqual(
            record.messages
        );
        // Every turn folds except the LATEST assistant reply (:2355-2366).
        expect(instance!.state<readonly number[]>(CHAT_COLLAPSED_TURNS_STATE).get()).toEqual([0]);
        expect(instance!.state<unknown>(CHAT_USAGE_STATE).get()).toBe(null);
        // An opened chat pins to its latest turn and closes the mobile drawer.
        expect(instance!.state<boolean>(CHAT_AUTOSCROLL_STATE).get()).toBe(true);
        expect(instance!.state<boolean>(CHAT_DRAWER_OPEN_STATE).get()).toBe(false);
        expect(instance!.state<boolean>(CHAT_EDITING_SYSTEM_STATE).get()).toBe(false);
        expect(instance!.state<string>(CHAT_STATUS_STATE).get()).toBe('idle');
        expect(payloadsOf(events, CHAT_SESSION_SELECTED_EVENT)).toEqual([
            { sessionId: 'conv-1' }
        ]);
        expect(payloadsOf(events, CHAT_TRANSCRIPT_UPDATED_EVENT)).toEqual([
            { sessionId: 'conv-1', turnCount: 2 } satisfies TranscriptUpdatedEvent
        ]);
        // The derived view model followed the transcript with no component work.
        expect(
            instance!
                .state<readonly ChatTurn[]>(CHAT_TURNS_STATE)
                .get()
                .map((turn) => [turn.index, turn.role, turn.collapsed, turn.model])
        ).toEqual([
            [0, 'user', true, ''],
            [1, 'assistant', false, 'test/model']
        ]);
        expect(double!.callsFor('/conv-1')).toEqual([
            { url: `${TEST_BASE_URL}/conv-1`, method: 'GET', body: null }
        ]);
    });

    it('surfaces a missing conversation as the 404-equivalent banner', async () => {
        const events = recordEvents(instance!, [CHAT_ERROR_EVENT]);
        await instance!.execute<string, Promise<void>>(CHAT_SESSION_SELECT_COMMAND, 'conv-missing');
        expect(instance!.state<string>(CHAT_ERROR_STATE).get()).toContain('not found');
        expect(payloadsOf(events, CHAT_ERROR_EVENT)).toEqual([
            // The api client answers a JSON error body VERBATIM, and only adds the
            // status suffix when the body carries no message at all
            // (api/chat-assistant.ts:127-135) — the exact 404 text the local store
            // and the server both produce.
            { message: "Conversation 'conv-missing' not found" }
        ]);
        // The failed read left the surface exactly where it was.
        expect(instance!.state<string | null>(CHAT_ACTIVE_SESSION_STATE).get()).toBe(null);
        expect(instance!.state<readonly unknown[]>(CHAT_TRANSCRIPT_STATE).get()).toEqual([]);
    });
});

describe('chat sessions — create, rename, delete', () => {
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

    it('create posts, tracks and selects the new conversation', async () => {
        const created = recordFixture('conv-new', {
            title: 'New conversation',
            messages: [],
            model: 'alpha/flash',
            status: 'pending'
        });
        double = installFetch([
            catalogRoute,
            {
                match: (url) => url === TEST_BASE_URL,
                reply: () => jsonResponse(201, { conversationId: 'conv-new' })
            },
            {
                match: (url) => url === `${TEST_BASE_URL}/conv-new`,
                reply: () => jsonResponse(200, { conversationId: 'conv-new', conversation: created })
            },
            {
                match: (url) => url.startsWith(TEST_BASE_URL),
                reply: () => jsonResponse(200, { conversations: [summaryFixture(created)] })
            }
        ]);
        instance = createTestChat();
        // The catalog effect adopts the first sorted entry when nothing is
        // remembered, so the create request carries a real model.
        await vi.waitFor(() => {
            expect(instance?.state<string>(CHAT_MODEL_STATE).get()).toBe('alpha/flash');
        });
        const events = recordEvents(instance, [CHAT_SESSION_CREATED_EVENT, CHAT_SESSION_SELECTED_EVENT]);

        const sessionId = await instance.execute<void, Promise<string | null>>(
            CHAT_SESSION_CREATE_COMMAND
        );
        expect(sessionId).toBe('conv-new');
        // create -> TRACK -> select: the id is cached BEFORE the canonical read, so
        // a reload mid-flow still restores the conversation (services/conversations.ts:157-164).
        expect(double.callsFor(TEST_BASE_URL).map((call) => [call.method, call.url])).toEqual([
            ['GET', `${TEST_BASE_URL}?ids=`],
            ['POST', TEST_BASE_URL],
            ['GET', `${TEST_BASE_URL}/conv-new`]
        ]);
        expect(double.callsFor(TEST_BASE_URL)[1].body).toEqual({ model: 'alpha/flash' });
        expect(readTrackedIds()).toEqual(['conv-new']);
        expect(instance.state<string | null>(CHAT_ACTIVE_SESSION_STATE).get()).toBe('conv-new');
        expect(instance.state<readonly ChatSession[]>(CHAT_SESSIONS_STATE).get()).toEqual([
            summaryFixture(created)
        ]);
        expect(payloadsOf(events, CHAT_SESSION_CREATED_EVENT)).toEqual([
            { sessionId: 'conv-new', title: 'New conversation' }
        ]);
        expect(payloadsOf(events, CHAT_SESSION_SELECTED_EVENT)).toEqual([
            { sessionId: 'conv-new' }
        ]);
    });

    it('rename PUTs the whole history with the explicit title', async () => {
        const record = recordFixture('conv-1');
        const renamed = { ...record, title: 'Renamed by hand' };
        seedTrackedIds(['conv-1']);
        double = installFetch([
            catalogRoute,
            {
                match: (url) => url === `${TEST_BASE_URL}/conv-1` && true,
                reply: (url, init) =>
                    (init?.method ?? 'GET') === 'PUT'
                        ? jsonResponse(200, { conversationId: 'conv-1', conversation: renamed })
                        : jsonResponse(200, { conversationId: 'conv-1', conversation: record }),
            },
            // The sidebar row starts at the RECORD's title: the row is what the inline
            // editor is seeded from (SessionsBoard.tsx:138), and the rename guard
            // compares the submitted title against it (oracle `saveTitle` :3761,
            // `title === record.title`). Seeding the row with the NEW title would make
            // this rename an unchanged-title no-op instead.
            {
                match: (url) => url.startsWith(TEST_BASE_URL),
                reply: () => jsonResponse(200, { conversations: [summaryFixture(record)] })
            }
        ]);
        instance = createTestChat();
        await instance.execute<string, Promise<void>>(CHAT_SESSION_SELECT_COMMAND, 'conv-1');
        double.reset();

        await instance.execute<
            { sessionId: string; title: string },
            Promise<void>
        >(CHAT_SESSION_RENAME_COMMAND, { sessionId: 'conv-1', title: '  Renamed by hand  ' });

        // The rename rides the identified whole-history PUT: the history round-trips
        // unchanged and the explicit title wins over the derived one (:3769-3772).
        expect(double.calls()).toEqual([
            {
                url: `${TEST_BASE_URL}/conv-1`,
                method: 'PUT',
                body: { messages: record.messages, title: 'Renamed by hand' }
            }
        ]);
        expect(instance.state<readonly ChatSession[]>(CHAT_SESSIONS_STATE).get()).toEqual([
            summaryFixture(renamed)
        ]);
        expect(instance.state<string>(CHAT_STATUS_STATE).get()).toBe('idle');
        expect(instance.state<string>(CHAT_ERROR_STATE).get()).toBe('');
    });

    it('rename never issues a request for a blank or unchanged title', async () => {
        const record = recordFixture('conv-1');
        seedTrackedIds(['conv-1']);
        double = installFetch([
            catalogRoute,
            {
                match: (url) => url.startsWith(TEST_BASE_URL),
                reply: (url, init) =>
                    (init?.method ?? 'GET') === 'GET' && url.endsWith('/conv-1')
                        ? jsonResponse(200, { conversationId: 'conv-1', conversation: record })
                        : jsonResponse(200, { conversations: [summaryFixture(record)] })
            }
        ]);
        instance = createTestChat();
        await instance.execute<string, Promise<void>>(CHAT_SESSION_SELECT_COMMAND, 'conv-1');
        double.reset();

        await instance.execute<{ sessionId: string; title: string }, Promise<void>>(
            CHAT_SESSION_RENAME_COMMAND,
            { sessionId: 'conv-1', title: '   ' }
        );
        expect(double.calls()).toEqual([]);
        expect(instance.state<string>(CHAT_STATUS_STATE).get()).toBe('idle');
    });

    it('delete untracks the row and clears the selection only for the open chat', async () => {
        const first = recordFixture('conv-1');
        const second = recordFixture('conv-2', {
            title: 'Second chat',
            messages: [{ role: 'user', content: 'Second chat' }],
            updatedAt: '2026-11-07T00:00:02.000Z'
        });
        seedTrackedIds(['conv-1', 'conv-2']);
        double = installFetch([
            catalogRoute,
            {
                match: (url) => url === `${TEST_BASE_URL}/conv-1`,
                reply: (url, init) =>
                    (init?.method ?? 'GET') === 'DELETE'
                        ? jsonResponse(200, { conversationId: 'conv-1' })
                        : jsonResponse(200, { conversationId: 'conv-1', conversation: first })
            },
            {
                match: (url) => url === `${TEST_BASE_URL}/conv-2`,
                reply: () => jsonResponse(200, { conversationId: 'conv-2', conversation: second })
            },
            {
                match: (url) => url.startsWith(TEST_BASE_URL),
                reply: () =>
                    jsonResponse(200, { conversations: [summaryFixture(second), summaryFixture(first)] })
            }
        ]);
        instance = createTestChat();
        await instance.execute<string, Promise<void>>(CHAT_SESSION_SELECT_COMMAND, 'conv-1');
        expect(instance.state<string | null>(CHAT_ACTIVE_SESSION_STATE).get()).toBe('conv-1');

        await instance.execute<string, Promise<void>>(CHAT_SESSION_DELETE_COMMAND, 'conv-1');

        // untrack happens only AFTER the store confirms (:2496-2501), and the open
        // surface resets to a fresh new chat while the model survives (:3525-3535).
        expect(readTrackedIds()).toEqual(['conv-2']);
        expect(instance.state<readonly ChatSession[]>(CHAT_SESSIONS_STATE).get()).toEqual([
            summaryFixture(second)
        ]);
        expect(instance.state<string | null>(CHAT_ACTIVE_SESSION_STATE).get()).toBe(null);
        expect(instance.state<readonly unknown[]>(CHAT_TRANSCRIPT_STATE).get()).toEqual([]);
        expect(instance.state<unknown>(CHAT_USAGE_STATE).get()).toBe(null);
        expect(instance.state<string>(CHAT_STATUS_STATE).get()).toBe('idle');
        expect(double.callsFor('/conv-1')).toContainEqual({
            url: `${TEST_BASE_URL}/conv-1`,
            method: 'DELETE',
            body: null
        });
    });

    it('delete keeps a different chat open and its own surface untouched', async () => {
        const first = recordFixture('conv-1');
        const second = recordFixture('conv-2', {
            title: 'Second chat',
            messages: [{ role: 'user', content: 'Second chat' }]
        });
        seedTrackedIds(['conv-1', 'conv-2']);
        installFetch([
            catalogRoute,
            {
                match: (url) => url === `${TEST_BASE_URL}/conv-2`,
                reply: (url, init) =>
                    (init?.method ?? 'GET') === 'DELETE'
                        ? jsonResponse(200, { conversationId: 'conv-2' })
                        : jsonResponse(200, { conversationId: 'conv-2', conversation: second })
            },
            {
                match: (url) => url === `${TEST_BASE_URL}/conv-1`,
                reply: () => jsonResponse(200, { conversationId: 'conv-1', conversation: first })
            },
            {
                match: (url) => url.startsWith(TEST_BASE_URL),
                reply: () =>
                    jsonResponse(200, { conversations: [summaryFixture(first), summaryFixture(second)] })
            }
        ]);
        instance = createTestChat();
        await instance.execute<string, Promise<void>>(CHAT_SESSION_SELECT_COMMAND, 'conv-1');
        await instance.execute<string, Promise<void>>(CHAT_SESSION_DELETE_COMMAND, 'conv-2');

        expect(instance.state<string | null>(CHAT_ACTIVE_SESSION_STATE).get()).toBe('conv-1');
        expect(instance.state<readonly unknown[]>(CHAT_TRANSCRIPT_STATE).get()).toEqual(
            first.messages
        );
    });

    it('a failed delete leaves the row tracked and reports the banner', async () => {
        const record = recordFixture('conv-1');
        seedTrackedIds(['conv-1']);
        double = installFetch([
            catalogRoute,
            {
                match: (url) => url === `${TEST_BASE_URL}/conv-1`,
                reply: (url, init) =>
                    (init?.method ?? 'GET') === 'DELETE'
                        ? jsonResponse(500, { error: 'Delete refused' })
                        : jsonResponse(200, { conversationId: 'conv-1', conversation: record })
            },
            {
                match: (url) => url.startsWith(TEST_BASE_URL),
                reply: () => jsonResponse(200, { conversations: [summaryFixture(record)] })
            }
        ]);
        instance = createTestChat();
        const events = recordEvents(instance, [CHAT_ERROR_EVENT]);
        await instance.execute<string, Promise<void>>(CHAT_SESSION_SELECT_COMMAND, 'conv-1');

        await instance.execute<string, Promise<void>>(CHAT_SESSION_DELETE_COMMAND, 'conv-1');

        expect(instance.state<readonly ChatSession[]>(CHAT_SESSIONS_STATE).get()).toEqual([
            summaryFixture(record)
        ]);
        expect(readTrackedIds()).toEqual(['conv-1']);
        expect(instance.state<string>(CHAT_STATUS_STATE).get()).toBe('idle');
        expect(payloadsOf(events, CHAT_ERROR_EVENT)).toEqual([
            { message: 'Delete refused' }
        ]);
    });
});

describe('chat sessions — the namespace an operation belongs to', () => {
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

    it('reads offline through the browser-local store, never the endpoint', async () => {
        // The mode-routing facade resolves `chat.mode` at CALL time, so a session
        // selected while offline must not touch the storage endpoint at all.
        const { upsertLocalConversation } = await import('../../api/offline');
        const record = recordFixture('local-1', { model: 'alpha/flash' });
        upsertLocalConversation(record as never);
        double = installFetch([catalogRoute]);
        instance = createTestChat();
        instance.state<ChatMode>(CHAT_MODE_STATE).set('offline');
        // The offline sidebar reads the browser-local store, so the local row is
        // what proves the namespace switch landed (a blank `chat.providerBase` means
        // the offline catalog issues no request at all — the documented degradation).
        await vi.waitFor(() => {
            expect(instance?.state<readonly ChatSession[]>(CHAT_SESSIONS_STATE).get()).toEqual([
                summaryFixture(record)
            ]);
        });
        double.reset();

        await instance.execute<string, Promise<void>>(CHAT_SESSION_SELECT_COMMAND, 'local-1');

        expect(instance.state<string | null>(CHAT_ACTIVE_SESSION_STATE).get()).toBe('local-1');
        expect(instance.state<readonly unknown[]>(CHAT_TRANSCRIPT_STATE).get()).toEqual(
            record.messages
        );
        expect(double.calls()).toEqual([]);
        const cells = instance.service<ChatCells>(CHAT_CELLS_SERVICE);
        expect(cells.sessions.get()).toEqual([summaryFixture(record)]);
    });
});

// ——— the rules T8 pinned down after the rebuild ————————————————————————————————
// Three behaviors the pre-rebuild monolith had and the rebuilt graph had drifted
// from. Each case names the oracle line it restores.
describe('chat sessions — the remembered model vs the catalog default', () => {
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
     * A catalog whose two ids sort by STRIPPED name ('alpha' < 'beta') into the
     * opposite order of their routing prefixes, so the auto-adopted default is
     * `zz/alpha` while the conversation below carries `aa/beta`.
     */
    const routesFor = (record: ReturnType<typeof recordFixture>) => [
        {
            match: (url: string) => url === PROVIDER_MODELS,
            reply: () =>
                jsonResponse(200, { object: 'list', data: [{ id: 'zz/alpha' }, { id: 'aa/beta' }] })
        },
        {
            match: (url: string) => url === `${TEST_BASE_URL}/conv-model`,
            reply: () => jsonResponse(200, { conversationId: 'conv-model', conversation: record })
        },
        {
            match: (url: string) => url.startsWith(TEST_BASE_URL),
            reply: () => jsonResponse(200, { conversations: [summaryFixture(record)] })
        }
    ];

    it('a conversation model outranks an unpersisted catalog default and becomes the remembered one', async () => {
        // S3 — oracle `applyModelMemory` (:3169-3176) gates on NOTHING REMEMBERED.
        // The catalog effect adopts its default into the cell WITHOUT persisting it
        // (plugins/source.ts `adoptSilently` + `persistSuppressed`), so a fresh
        // browser's cell already holds a model nobody chose; gating the inheritance
        // on the CELL would let that silent default beat the conversation's own
        // recorded model.
        seedTrackedIds(['conv-model']);
        const record = recordFixture('conv-model', { model: 'aa/beta' });
        double = installFetch(routesFor(record));
        instance = createTestChat({ pollIntervalMs: 5_000 });

        // The state the reviewer reproduced: cell = the catalog default, storage =
        // nothing at all.
        await vi.waitFor(() => {
            expect(instance?.state<string>(CHAT_MODEL_STATE).get()).toBe('zz/alpha');
        });
        expect(readRememberedModel()).toBe(null);

        await instance.execute<string, Promise<void>>(CHAT_SESSION_SELECT_COMMAND, 'conv-model');

        // Opening the record moves BOTH halves: the picker shows the conversation's
        // model, and the browser now remembers it.
        expect(instance.state<string>(CHAT_MODEL_STATE).get()).toBe('aa/beta');
        expect(readRememberedModel()).toBe('aa/beta');
    });

    it('leaves a remembered model alone when the conversation records a different one', async () => {
        // The other half of the same gate — the fix must not overcorrect into
        // "the record always wins": a model the operator actually picked (or that
        // produced a turn) keeps its priority (:3172 `!readRememberedModel()`).
        seedTrackedIds(['conv-model']);
        seedModel('zz/alpha');
        const record = recordFixture('conv-model', { model: 'aa/beta' });
        double = installFetch(routesFor(record));
        instance = createTestChat({ pollIntervalMs: 5_000 });
        await vi.waitFor(() => {
            expect(instance?.state<readonly ChatSession[]>(CHAT_SESSIONS_STATE).get()).toHaveLength(1);
        });
        expect(instance.state<string>(CHAT_MODEL_STATE).get()).toBe('zz/alpha');

        await instance.execute<string, Promise<void>>(CHAT_SESSION_SELECT_COMMAND, 'conv-model');

        expect(instance.state<string>(CHAT_MODEL_STATE).get()).toBe('zz/alpha');
        expect(readRememberedModel()).toBe('zz/alpha');
        // The chat itself still opened — only the model inheritance was declined.
        expect(instance.state<string | null>(CHAT_ACTIVE_SESSION_STATE).get()).toBe('conv-model');
    });
});

describe('chat sessions — the busy label belongs to its own namespace', () => {
    let instance: Dashboard | null = null;

    beforeEach(() => {
        resetStorage();
    });

    afterEach(() => {
        instance?.dispose();
        instance = null;
        vi.unstubAllGlobals();
    });

    /** One in-flight request a test settles by hand. */
    type Gate = { settle: (response: Response) => void };

    /**
     * Real timers, not fake ones: the settle has to travel through the fetch double
     * and the plugin's awaits, and the harness forbids fake clocks (they deadlock a
     * streamed flow). 30ms is orders of magnitude more than the microtask chain a
     * settled response takes, and adds no flake because nothing else is scheduled.
     */
    const settleMicrotasks = (): Promise<void> =>
        new Promise<void>((resolve) => setTimeout(resolve, 30));

    it('a stale settle cannot clear the busy label of the namespace that replaced it', async () => {
        // S4 — every `finally` is epoch-gated, exactly like the oracle's
        // `if (modeEpoch() === epochAtStart) flag(false)` at :3296 / :3599 / :3787 /
        // :4143. A mode switch calls `activity.reset()` for the NEW namespace
        // (plugins/core.ts:542), so the count the stale flow took is already gone;
        // calling `end()` anyway decrements the count the NEW namespace just took.
        const gates: Gate[] = [];
        installFetch([
            catalogRoute,
            {
                match: (url: string) => url.startsWith(TEST_BASE_URL),
                reply: () => {
                    let settle: (response: Response) => void = () => {};
                    const promise = new Promise<Response>((resolve) => {
                        settle = resolve;
                    });
                    gates.push({ settle });
                    return promise;
                }
            }
        ]);
        instance = createTestChat({ pollIntervalMs: 5_000 });

        // Namespace A: the mount listing is parked mid-flight with 'loading' taken.
        await vi.waitFor(() => {
            expect(gates).toHaveLength(1);
        });
        expect(instance.state<string>(CHAT_STATUS_STATE).get()).toBe('loading');

        // Away and back: two namespace bumps (each resets the tracker), and the
        // second one arms a NEW listing that is still running when we settle A.
        instance.state<ChatMode>(CHAT_MODE_STATE).set('offline');
        await vi.waitFor(() => {
            expect(instance?.state<string>(CHAT_STATUS_STATE).get()).toBe('idle');
        });
        instance.state<ChatMode>(CHAT_MODE_STATE).set('online');
        await vi.waitFor(() => {
            expect(gates).toHaveLength(2);
        });
        expect(instance.state<string>(CHAT_STATUS_STATE).get()).toBe('loading');

        // Settle the STALE attempt from namespace A.
        gates[0].settle(jsonResponse(200, { conversations: [] }));
        await settleMicrotasks();

        // THE REGRESSION: with an unguarded `activity.end('loading')` in that finally,
        // the new namespace's count is zeroed here and `chat.status` reads 'idle'
        // while namespace B's listing is genuinely still in flight.
        expect(instance.state<string>(CHAT_STATUS_STATE).get()).toBe('loading');

        // And the tracker is still balanced: the current attempt releases it alone.
        gates[1].settle(jsonResponse(200, { conversations: [] }));
        await vi.waitFor(() => {
            expect(instance?.state<string>(CHAT_STATUS_STATE).get()).toBe('idle');
        });
    });
});

describe('chat sessions — an unchanged title is not a write', () => {
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

    it('rename issues no request at all when the trimmed title matches the stored one', async () => {
        // N1 — the comment on the rename guard has always claimed a
        // `title === record.title` check; the oracle really has it (:3761), and the
        // rebuild only ever had the blank check. The rename rides the WHOLE-HISTORY
        // PUT, so every no-op blur used to re-send the entire conversation and bump
        // `updatedAt` for nothing.
        const record = recordFixture('conv-1');
        seedTrackedIds(['conv-1']);
        double = installFetch([
            catalogRoute,
            {
                match: (url: string) => url.startsWith(TEST_BASE_URL),
                reply: (url, init) =>
                    (init?.method ?? 'GET') === 'GET' && url.endsWith('/conv-1')
                        ? jsonResponse(200, { conversationId: 'conv-1', conversation: record })
                        : jsonResponse(200, { conversations: [summaryFixture(record)] })
            }
        ]);
        instance = createTestChat({ pollIntervalMs: 5_000 });
        await instance.execute<string, Promise<void>>(CHAT_SESSION_SELECT_COMMAND, 'conv-1');
        expect(instance.state<readonly ChatSession[]>(CHAT_SESSIONS_STATE).get()).toEqual([
            summaryFixture(record)
        ]);
        double.reset();

        // The editor's raw value, whitespace and all: the trim runs BEFORE the
        // comparison, which is why "the same title with padding" is still a no-op.
        await instance.execute<{ sessionId: string; title: string }, Promise<void>>(
            CHAT_SESSION_RENAME_COMMAND,
            { sessionId: 'conv-1', title: '  Hello assistant  ' }
        );

        expect(double.calls()).toEqual([]);
        expect(instance.state<string>(CHAT_STATUS_STATE).get()).toBe('idle');
        expect(instance.state<string>(CHAT_ERROR_STATE).get()).toBe('');
        expect(instance.state<readonly ChatSession[]>(CHAT_SESSIONS_STATE).get()).toEqual([
            summaryFixture(record)
        ]);
    });

    it('rename still writes when the title genuinely changed', async () => {
        // The guard must not swallow real renames (the check compares against the
        // row's stored title, not against any value the caller might pass).
        const record = recordFixture('conv-1');
        const renamed = { ...record, title: 'A different name' };
        seedTrackedIds(['conv-1']);
        double = installFetch([
            catalogRoute,
            {
                match: (url: string) => url === `${TEST_BASE_URL}/conv-1`,
                reply: (url, init) =>
                    (init?.method ?? 'GET') === 'PUT'
                        ? jsonResponse(200, { conversationId: 'conv-1', conversation: renamed })
                        : jsonResponse(200, { conversationId: 'conv-1', conversation: record })
            },
            {
                match: (url: string) => url.startsWith(TEST_BASE_URL),
                reply: () => jsonResponse(200, { conversations: [summaryFixture(record)] })
            }
        ]);
        instance = createTestChat({ pollIntervalMs: 5_000 });
        await instance.execute<string, Promise<void>>(CHAT_SESSION_SELECT_COMMAND, 'conv-1');
        double.reset();

        await instance.execute<{ sessionId: string; title: string }, Promise<void>>(
            CHAT_SESSION_RENAME_COMMAND,
            { sessionId: 'conv-1', title: 'A different name' }
        );

        expect(double.calls()).toEqual([
            {
                url: `${TEST_BASE_URL}/conv-1`,
                method: 'PUT',
                body: { messages: record.messages, title: 'A different name' }
            }
        ]);
        expect(instance.state<readonly ChatSession[]>(CHAT_SESSIONS_STATE).get()).toEqual([
            summaryFixture(renamed)
        ]);
    });
});
