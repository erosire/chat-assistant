// Targeted review tests for the offline (no-application-server) mode:
// the failure/race checks the primary test file (ChatAssistantApp.test.tsx)
// does not pin — mode switches DURING an in-flight stream, local
// persistence write failures, offline catalog failures (no manual fallback
// — the remembered model is the only unblock), and the remembered model's
// blank-base adoption. Every test asserts exact observable state (no
// fuzzy ranges).
//
// Namespace-isolation contract under test (ChatAssistantApp.tsx submit flow,
// epoch fix): the sending EPOCH (monotonic counter, `modeEpoch`) is
// snapshotted BEFORE the first await, and switchMode pushes it forward — so
// a mid-stream mode switch (including away-and-back, which returns the same
// mode string but a new epoch) permanently detaches the in-flight
// operation: persistence still runs through the captured storage closure of
// the send's mode (no history loss, reload restores the record), while all
// surface effects (stream tokens, record apply, sidebar summary, banner,
// draft restore, buffer/release flags) apply ONLY while the epoch still
// matches. The new mode is immediately usable: a NEW send on it proceeds
// while the stale stream is still open, and its completion can never be
// clobbered by the stale one (per-send id gating on activeSend).
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ASSISTANT_SETTINGS_KEY,
    LOCAL_CONVERSATIONS_KEY,
    readLocalConversations
} from '../api';
import { ChatAssistantApp } from './ChatAssistantApp';

const BASE_URL = 'http://test.local/v1/chat-assistant/conversation';
const PROVIDER_URL = 'http://test.local/providers/private/v1';
// ONE offline provider base (distinct host/port proves the configured base
// is used, never a default application-server fallback): the standard
// routes are DERIVED beneath it — ${base}/models catalog,
// ${base}/chat/completions stream.
const OFFLINE_PROVIDER_BASE = 'http://offline-race.test:8080/v1';
const OFFLINE_MODELS_URL = `${OFFLINE_PROVIDER_BASE}/models`;
const OFFLINE_STREAM_URL = `${OFFLINE_PROVIDER_BASE}/chat/completions`;
// Must match MODEL_STORAGE_KEY in ChatAssistantApp.tsx (the remembered-model
// memory — the offline auto-selection fallback).
const MODEL_STORAGE_KEY = 'chat-assistant:model';
const DEFAULT_MODEL = 'zeta-org/test-model';

const catalog = {
    object: 'list',
    data: [{ id: DEFAULT_MODEL, object: 'model' }]
};

// The provider's fixed SSE completion (identical frames to the primary suite):
// role chunk, content chunk, final usage chunk, [DONE].
const completionFrames = [
    'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":" from the assistant"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":4,"total_tokens":9}}\n\n',
    'data: [DONE]\n\n'
];

// JSON-envelope Response substitute (the same shape the primary suite uses).
const response = (status: number, body: unknown) =>
    ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body
    }) as Response;

// Eagerly-closed streaming Response (one-shot SSE completion).
const sseResponse = (frames: string[]) => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const frame of frames) controller.enqueue(encoder.encode(frame));
            controller.close();
        }
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};

// Manually driven SSE stream for mid-stream assertions.
const controlledStream = () => {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
        start(c) {
            controller = c;
        }
    });
    return {
        response: () => new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
        push: (frame: string) => controller.enqueue(encoder.encode(frame)),
        close: () => controller.close()
    };
};

const renderApp = () =>
    render(<ChatAssistantApp baseUrl={BASE_URL} providerUrl={PROVIDER_URL} />);

// Seed the persisted settings (a reload with saved configuration) BEFORE
// mount: the canonical single-base shape (api/offline.ts AssistantSettings) —
// the standard routes are derived beneath the base, and the remembered model
// memory (when set separately) is the only auto-selection fallback.
const seedOffline = (over: Partial<{ providerBase: string }> = {}) => {
    window.localStorage.setItem(ASSISTANT_SETTINGS_KEY, JSON.stringify({
        mode: 'offline',
        providerBase: OFFLINE_PROVIDER_BASE,
        ...over
    }));
};

// Focus the composer (the send arrow only renders on focus) and wait for the
// offline model resolution to land.
const focusAndAwaitModel = (expected: string) =>
    (async () => {
        fireEvent.focus(screen.getByTestId('chat-input'));
        await waitFor(() => expect((screen.getByTestId('model-select') as HTMLSelectElement).value).toBe(expected));
    })();

// The mode selector lives in the settings surface (sidebar tab).
const switchToMode = (mode: string) => {
    fireEvent.click(screen.getByTestId('sidebar-tab-settings'));
    fireEvent.change(screen.getByTestId('mode-select'), { target: { value: mode } });
};

// Push the complete completion through a held stream deterministically.
const settleStream = (stream: { push: (frame: string) => void; close: () => void }) => {
    act(() => {
        for (const frame of completionFrames) stream.push(frame);
        stream.close();
    });
};

describe('offline mode: in-flight stream vs. mode switch (namespace isolation)', () => {
    // A send keeps an in-flight provider stream while the user switches modes.
    // The persistence closure captured when the send started is the sending
    // MODE's storage — the surface-level apply is guarded by the live mode.
    const buildFetchMock = (offlineStream: { response: () => Response }) =>
        vi.fn((url: string, init?: RequestInit) => {
            if (url === OFFLINE_MODELS_URL && init?.method === 'GET') {
                return Promise.resolve(response(200, catalog));
            }
            if (url === OFFLINE_STREAM_URL && init?.method === 'POST') {
                return Promise.resolve(offlineStream.response());
            }
            // ONLINE-mode traffic after a switch: the private relay catalog and
            // a DISTINCT server-side conversation so each sidebar is identifiable.
            if (url === `${PROVIDER_URL}/models` && init?.method === 'GET') {
                return Promise.resolve(response(200, catalog));
            }
            if (url === BASE_URL && init?.method === 'GET') {
                return Promise.resolve(response(200, {
                    conversations: [{
                        conversationId: 'conversation-1',
                        title: 'Hello assistant',
                        model: DEFAULT_MODEL,
                        status: 'complete',
                        messageCount: 2,
                        createdAt: '2026-08-06T00:00:00.000Z',
                        updatedAt: '2026-08-06T00:00:01.000Z'
                    }]
                }));
            }
            return Promise.resolve(response(404, { error: `unexpected request: ${String(url)} ${init?.method ?? ''}` }));
        });

    beforeEach(() => {
        window.localStorage.clear();
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('persists the in-flight offline completion locally and leaks nothing into the online surface when switching mid-stream', async () => {
        const stream = controlledStream();
        vi.stubGlobal('fetch', buildFetchMock(stream));
        seedOffline();
        renderApp();
        await focusAndAwaitModel(DEFAULT_MODEL);

        // Start the offline send and verify the in-flight pending bubble.
        fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Race turn' } });
        fireEvent.click(screen.getByTestId('send-chat-button'));
        await waitFor(() => expect(screen.getByTestId('pending-user-message')).toBeDefined());

        // Switch to online WHILE the offline stream is still open.
        switchToMode('online');
        fireEvent.click(screen.getByTestId('sidebar-tab-chat'));

        // The stream completes after the switch: the captured storage closure
        // (offline) persists it in the browser-local store — never the server.
        settleStream(stream);
        await waitFor(() => expect(Object.keys(readLocalConversations())).toHaveLength(1));
        const [offlineId] = Object.keys(readLocalConversations());
        const record = readLocalConversations()[offlineId];

        // Exact local record: the completed pair with model attribution and the
        // streamed usage aggregate (5+4=9 tokens).
        expect(record.title).toBe('Race turn');
        expect(record.model).toBe(DEFAULT_MODEL);
        expect(record.messages).toEqual([
            { role: 'user', content: 'Race turn' },
            { role: 'assistant', content: 'Hello from the assistant', model: DEFAULT_MODEL }
        ]);
        expect(record.usage).toEqual({ prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 });

        // ONLINE surface: the server-side entry is visible (the online list
        // effect resolves asynchronously), the offline id is NOT, the selection
        // was reset by the switch (no yank back to the sending chat), and the
        // cleared draft was not resurrected by the completed stream.
        await waitFor(() => expect(screen.getByTestId('chat-tab-conversation-1')).toBeDefined());
        expect(screen.queryByTestId(`chat-tab-${offlineId}`)).toBeNull();
        expect(screen.getByTestId('empty-chat-state')).toBeDefined();
        expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe('');

        // Request ledger: the ONLY stream POST is the configured offline URL;
        // no storage mutation (POST/PUT/DELETE) ever reached the application server.
        const storageMutations = (fetch as any).mock.calls.filter((call: unknown[]) => {
            const init = (call[1] ?? {}) as { method?: string };
            return String(call[0]).includes('/v1/chat-assistant/conversation')
                && (init.method === 'POST' || init.method === 'PUT' || init.method === 'DELETE');
        });
        expect(storageMutations).toEqual([]);
        expect((fetch as any).mock.calls.filter((call: unknown[]) => call[0] === OFFLINE_STREAM_URL)).toHaveLength(1);
    });

    it('keeps a switch-away-and-back completion out of the new-mode surface while its record persists locally (epoch, not mode string)', async () => {
        const stream = controlledStream();
        vi.stubGlobal('fetch', buildFetchMock(stream));
        seedOffline();
        renderApp();
        await focusAndAwaitModel(DEFAULT_MODEL);

        fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Race turn' } });
        fireEvent.click(screen.getByTestId('send-chat-button'));
        await waitFor(() => expect(screen.getByTestId('pending-user-message')).toBeDefined());

        // Offline -> online -> back to offline, all while the stream is open.
        // The online collection GET resolves asynchronously, so wait for the
        // server-side entry before switching back.
        switchToMode('online');
        fireEvent.click(screen.getByTestId('sidebar-tab-chat'));
        await waitFor(() => expect(screen.getByTestId('chat-tab-conversation-1')).toBeDefined());
        switchToMode('offline');
        fireEvent.click(screen.getByTestId('sidebar-tab-chat'));
        // The local store is still empty (the record is created only AFTER the
        // stream completes), so the offline sidebar starts from the empty list.
        expect(screen.getByTestId('empty-chat-list').textContent).toBe('No chats yet.');

        // Completion after the bounce: the mode STRING matches again (offline
        // === offline) but the EPOCH does not — switchMode pushed it forward,
        // so a stale operation must never re-adopt itself. The captured
        // storage closure persists the record to the ORIGINAL namespace
        // (history intact — a reload with an offline selection restores it),
        // while the surface apply stays detached.
        settleStream(stream);
        const [offlineId] = await waitFor(() => {
            const ids = Object.keys(readLocalConversations());
            expect(ids).toHaveLength(1);
            return ids;
        });

        // The completed record lives in the captured local store...
        expect(readLocalConversations()[offlineId].messages).toHaveLength(2);
        // ...but the switched-back surface never adopted it: no tab, no live
        // turn, the selection was reset by the switch (no yank back to the
        // sending chat), and the cleared draft was not resurrected.
        expect(screen.queryByTestId(`chat-tab-${offlineId}`)).toBeNull();
        expect(screen.queryByText('Hello from the assistant')).toBeNull();
        expect(screen.getByTestId('empty-chat-state')).toBeDefined();
        expect(screen.queryByTestId('chat-tab-conversation-1')).toBeNull();
        expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe('');
    });
});

describe('offline mode: provider and storage failure handling', () => {
    beforeEach(() => {
        window.localStorage.clear();
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('surfaces a local conversation-store write failure in the banner and restores the draft (no phantom success)', async () => {
        // A storage whose conversation-map writes throw (quota/locked-down
        // profile). Settings and model-memory writes keep working; only the
        // durable conversation map fails — the write path must re-throw so
        // the send flow's catch surfaces it (offline.ts writeLocalMap).
        seedOffline();
        const backing = new Map<string, string>([
            [ASSISTANT_SETTINGS_KEY, window.localStorage.getItem(ASSISTANT_SETTINGS_KEY)!]
        ]);
        const failingStorage = {
            getItem: (key: string) => backing.get(key) ?? null,
            setItem: (key: string, value: string) => {
                if (key === LOCAL_CONVERSATIONS_KEY) throw new Error('QuotaExceededError: storage full');
                backing.set(key, value);
            },
            removeItem: (key: string) => {
                backing.delete(key);
            },
            clear: () => backing.clear(),
            key: (index: number) => [...backing.keys()][index] ?? null,
            get length() {
                return backing.size;
            }
        };
        vi.stubGlobal('localStorage', failingStorage);
        vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
            if (url === OFFLINE_MODELS_URL && init?.method === 'GET') {
                return Promise.resolve(response(200, catalog));
            }
            if (url === OFFLINE_STREAM_URL && init?.method === 'POST') {
                return Promise.resolve(sseResponse(completionFrames));
            }
            return Promise.resolve(response(404, { error: `unexpected request: ${String(url)}` }));
        }));

        renderApp();
        await focusAndAwaitModel(DEFAULT_MODEL);
        fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Persist fail' } });
        fireEvent.click(screen.getByTestId('send-chat-button'));

        // The provider stream succeeded, but the local persist threw: the
        // banner carries the storage error (never a silent success) and the
        // draft is restored for retry on the same sending surface.
        await waitFor(() => expect(screen.getByTestId('chat-error').textContent).toContain('QuotaExceededError: storage full'));
        expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe('Persist fail');
        // No phantom conversation: the failed write left the local store empty
        // and the sidebar empty (no phantom entry from the in-memory flow).
        expect(readLocalConversations()).toEqual({});
        expect(screen.getByTestId('empty-chat-list').textContent).toBe('No chats yet.');
    });

    it('surfaces the offline catalog failure in the banner without any manual fallback', async () => {
        seedOffline({ providerBase: OFFLINE_PROVIDER_BASE });
        vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
            if (url === OFFLINE_MODELS_URL && init?.method === 'GET') {
                // The provider reports its failure body; the surface banner reads it verbatim.
                return Promise.resolve(response(500, { error: 'endpoint unreachable' }));
            }
            if (url === OFFLINE_STREAM_URL && init?.method === 'POST') {
                return Promise.resolve(sseResponse(completionFrames));
            }
            return Promise.resolve(response(404, { error: `unexpected request: ${String(url)}` }));
        }));

        renderApp();
        fireEvent.focus(screen.getByTestId('chat-input'));

        // The catalog failure surfaces (provider error text verbatim). There
        // is NO manual model id configuration: the empty picker stays empty
        // and disabled — a remembered model (persisted in a previous session)
        // is the ONLY unblock, and none is seeded here.
        await waitFor(() => expect(screen.getByTestId('chat-error').textContent).toContain('endpoint unreachable'));
        expect((screen.getByTestId('model-select') as HTMLSelectElement).value).toBe('');
        expect((screen.getByTestId('model-select') as HTMLSelectElement).disabled).toBe(true);
        // Exactly ONE request was issued (the failed catalog fetch) — no
        // default application-server fallback call of any kind.
        expect((fetch as any).mock.calls).toEqual([[OFFLINE_MODELS_URL, { method: 'GET' }]]);
    });

    it('adopts the remembered model into a blank selection with a blank provider base — zero network at mount', async () => {
        // Blank base: zero network at mount (the catalog is never fetched
        // from a default server); the REMEMBERED model is the only source of
        // a model id and is adopted into the (initially empty) selection.
        seedOffline({ providerBase: '' });
        window.localStorage.setItem(MODEL_STORAGE_KEY, 'manual/one');
        vi.stubGlobal('fetch', vi.fn());
        renderApp();
        // The blank selection is unblocked by the adoption (the remembered
        // model only fills a BLANK selection — an explicit pick or a catalog
        // entry always wins).
        await focusAndAwaitModel('manual/one');

        // The whole flow is network-free at this point (blank base).
        expect((fetch as any).mock.calls).toEqual([]);
    });
});

describe('offline mode: mid-stream switch race (detached stream, immediate new-mode use)', () => {
    beforeEach(() => {
        window.localStorage.clear();
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    // DESIRED-BEHAVIOR PIN for the mid-stream mode switch (T4 race review,
    // epoch fix):
    // - switchMode detaches the in-flight send: the pending/streaming bubbles
    //   wipe, the transient busy flags reset, and the stale stream KEEPS
    //   running in its captured storage namespace (its completion persists
    //   there — no history loss);
    // - the NEW mode is immediately usable: a new send on it proceeds while
    //   the stale stream is still open (detach, not block), and the stale
    //   completion can never clobber the new send's buffers (per-send id
    //   gating on activeSend);
    // - settling the stale stream applies nothing to the new mode's state
    //   (no tab, no bubble, no draft clobber), and the new send completes
    //   with its own record in its own namespace — no cross-mode data
    //   corruption in either direction.
    it('switching mid-stream releases the new mode for an immediate send while the stale stream settles into its captured namespace', async () => {
        const offlineStream = controlledStream();
        const onlineStream = controlledStream();
        vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
            if (url === OFFLINE_MODELS_URL && init?.method === 'GET') {
                return Promise.resolve(response(200, catalog));
            }
            if (url === OFFLINE_STREAM_URL && init?.method === 'POST') {
                return Promise.resolve(offlineStream.response());
            }
            if (url === `${PROVIDER_URL}/models` && init?.method === 'GET') {
                return Promise.resolve(response(200, catalog));
            }
            if (url === `${PROVIDER_URL}/chat/completions` && init?.method === 'POST') {
                return Promise.resolve(onlineStream.response());
            }
            if (url === BASE_URL && init?.method === 'GET') {
                return Promise.resolve(response(200, { conversations: [] }));
            }
            // Online-mode storage for the new send (create + append + GET).
            if (url === BASE_URL && init?.method === 'POST') {
                return Promise.resolve(response(201, { conversationId: 'online-race' }));
            }
            if (url === `${BASE_URL}/online-race` && init?.method === 'POST') {
                return Promise.resolve(response(200, { conversationId: 'online-race' }));
            }
            if (url === `${BASE_URL}/online-race` && init?.method === 'GET') {
                return Promise.resolve(response(200, {
                    conversationId: 'online-race',
                    conversation: {
                        conversationId: 'online-race',
                        title: 'Online turn',
                        model: DEFAULT_MODEL,
                        status: 'complete',
                        messageCount: 2,
                        messages: [
                            { role: 'user', content: 'Online turn' },
                            { role: 'assistant', content: 'Hello from the assistant', model: DEFAULT_MODEL }
                        ],
                        createdAt: '2026-08-06T00:00:00.000Z',
                        updatedAt: '2026-08-06T00:00:01.000Z'
                    }
                }));
            }
            return Promise.resolve(response(404, { error: `unexpected request: ${String(url)}` }));
        }));
        seedOffline();
        renderApp();
        await focusAndAwaitModel(DEFAULT_MODEL);

        // Offline send (stream held open).
        fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Race turn' } });
        fireEvent.click(screen.getByTestId('send-chat-button'));
        await waitFor(() => expect(screen.getByTestId('pending-user-message')).toBeDefined());
        expect(screen.getByTestId('pending-user-message').textContent).toBe('Race turn');

        // Switch to online while the offline stream is STILL open: the switch
        // detaches the send (bubbles wipe, busy flags reset) and the new mode
        // is immediately usable.
        switchToMode('online');
        fireEvent.click(screen.getByTestId('sidebar-tab-chat'));
        expect(screen.queryByTestId('pending-user-message')).toBeNull();
        expect(screen.queryByTestId('streaming-loading')).toBeNull();
        // The online catalog re-resolves the model after the switch (the
        // switch clears it); a blank selection would silently veto the send.
        await focusAndAwaitModel(DEFAULT_MODEL);

        // IMMEDIATE-USE PIN: the stale stream must NOT block the new mode —
        // the online send starts at once (provider request fired, pending
        // bubble carrying the NEW draft), while the offline stream is still open.
        fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Online turn' } });
        fireEvent.click(screen.getByTestId('send-chat-button'));
        await waitFor(() => expect(screen.getByTestId('pending-user-message')).toBeDefined());
        expect(screen.getByTestId('pending-user-message').textContent).toBe('Online turn');
        expect((fetch as any).mock.calls.filter((call: unknown[]) => call[0] === `${PROVIDER_URL}/chat/completions`)).toHaveLength(1);

        // Let the STALE offline stream settle: it persists to its OWN
        // (captured) namespace via the captured storage closure, and the
        // epoch gate keeps its completion out of the online surface's state
        // (no tab, and the in-flight ONLINE send's pending buffers are not
        // clobbered by the stale completion's buffer release).
        settleStream(offlineStream);
        const [offlineId] = await waitFor(() => {
            const ids = Object.keys(readLocalConversations());
            expect(ids).toHaveLength(1);
            return ids;
        });
        expect(readLocalConversations()[offlineId].title).toBe('Race turn');
        expect(screen.queryByTestId(`chat-tab-${offlineId}`)).toBeNull();
        expect(screen.getByTestId('pending-user-message').textContent).toBe('Online turn');

        // Settle the online send: it completes with its OWN record in its OWN
        // namespace — no cross-mode data corruption in either direction.
        settleStream(onlineStream);
        await waitFor(() => expect(screen.getByTestId('chat-tab-online-race')).toBeDefined());
        expect(screen.getByText('Hello from the assistant')).toBeDefined();
        // Only the offline record lives in the local store; the online record
        // reached the (mocked) application server, and the composer draft is
        // spent (both sends completed on their own surfaces).
        expect(Object.keys(readLocalConversations())).toEqual([offlineId]);
        expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe('');
    });
});

// DEFECT CHARACTERIZATION (T4 final review): the "short-lived" storage flows
// (deleteChat / deleteMessage / switchMessage / saveTitle / commitEdit /
// forkConversation in ChatAssistantApp.tsx) were deliberately left UNGATED —
// assumed short-lived, they carry no modeEpoch snapshot. Their storage
// dispatch is mode-captured, so each one's REMOTE (online-mode) request can be
// delayed across a manual mode switch; the completion then writes the other
// mode's surface state (sidebar entries, banner, selected record, busy
// flags). These tests assert the DESIRED isolation (a stale completion must
// never touch the switched-to mode) and therefore FAIL against the current
// production code — each pins one contamination class. When the flows gain
// epoch gates like submit/selectChat/saveSystemPromptDraft, they flip green.
describe('short-lived storage flows vs mode switch (delayed remote ops, ungated — defect characterization)', () => {
    // One held request at a time: the fetch mock returns the same pending
    // promise for the designated (url, method); the test resolves it at the
    // moment it wants the stale completion to land.
    const heldRequest = () => {
        let resolve!: (response: Response) => void;
        const promise = new Promise<Response>((r) => {
            resolve = r;
        });
        return {
            promise,
            resolve: (status: number, body: unknown) => {
                resolve(response(status, body));
            }
        };
    };

    // The online-mode server record (the primary suite's fixture shape).
    const ONLINE_CONVERSATION = {
        conversationId: 'conversation-1',
        title: 'Hello assistant',
        model: 'alpha-org/zeta-model',
        status: 'complete' as const,
        messageCount: 2,
        messages: [
            { role: 'user' as const, content: 'Hello assistant' },
            { role: 'assistant' as const, content: 'Hello from the assistant', model: 'alpha-org/zeta-model' }
        ],
        createdAt: '2026-08-06T00:00:00.000Z',
        updatedAt: '2026-08-06T00:00:01.000Z'
    };
    // The offline-side record (durable local store), distinct in every label.
    const LOCAL_CONVERSATION = {
        conversationId: 'local-x',
        title: 'Local chat',
        model: '',
        status: 'complete' as const,
        messageCount: 2,
        messages: [
            { role: 'user' as const, content: 'Local question' },
            { role: 'assistant' as const, content: 'Local answer' }
        ],
        createdAt: '2026-08-06T00:00:00.000Z',
        updatedAt: '2026-08-06T00:00:01.000Z'
    };

    const seedLocalRecord = () => {
        window.localStorage.setItem(
            LOCAL_CONVERSATIONS_KEY,
            JSON.stringify({ [LOCAL_CONVERSATION.conversationId]: LOCAL_CONVERSATION })
        );
    };

    beforeEach(() => {
        window.localStorage.clear();
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('a delayed online fork never lands in the offline sidebar (forkConversation is ungated)', async () => {
        const forkCreate = heldRequest();
        vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
            if (url === OFFLINE_MODELS_URL && init?.method === 'GET') {
                return Promise.resolve(response(200, catalog));
            }
            if (url === `${PROVIDER_URL}/models` && init?.method === 'GET') {
                return Promise.resolve(response(200, catalog));
            }
            if (url === BASE_URL && init?.method === 'GET') {
                return Promise.resolve(response(200, {
                    conversations: [{
                        conversationId: ONLINE_CONVERSATION.conversationId,
                        title: ONLINE_CONVERSATION.title,
                        model: ONLINE_CONVERSATION.model,
                        status: ONLINE_CONVERSATION.status,
                        messageCount: ONLINE_CONVERSATION.messageCount,
                        createdAt: ONLINE_CONVERSATION.createdAt,
                        updatedAt: ONLINE_CONVERSATION.updatedAt
                    }]
                }));
            }
            if (url === `${BASE_URL}/conversation-1` && init?.method === 'GET') {
                return Promise.resolve(response(200, {
                    conversationId: ONLINE_CONVERSATION.conversationId,
                    conversation: ONLINE_CONVERSATION
                }));
            }
            // The fork's create POST is the held request; its read-back GET
            // resolves immediately once the create settles.
            if (url === BASE_URL && init?.method === 'POST') {
                return forkCreate.promise;
            }
            if (url === `${BASE_URL}/fork-online` && init?.method === 'GET') {
                return Promise.resolve(response(200, {
                    conversationId: 'fork-online',
                    conversation: {
                        ...ONLINE_CONVERSATION,
                        conversationId: 'fork-online',
                        title: 'Forked branch',
                        messageCount: 1,
                        messages: [ONLINE_CONVERSATION.messages[0]]
                    }
                }));
            }
            return Promise.resolve(response(404, { error: `unexpected request: ${String(url)} ${init?.method ?? ''}` }));
        }));

        // ONLINE mode (the default): mount, select the server conversation,
        // start the fork at turn 0 (its create POST is held in flight).
        renderApp();
        await focusAndAwaitModel(DEFAULT_MODEL);
        fireEvent.click(screen.getByTestId('chat-tab-conversation-1'));
        await waitFor(() => expect(screen.getByText('Hello from the assistant')).toBeDefined());
        fireEvent.click(screen.getByTestId('message-preview-0'));
        fireEvent.click(screen.getByTestId('fork-message-0'));

        // Switch away to OFFLINE while the fork's remote work is still open.
        switchToMode('offline');
        fireEvent.click(screen.getByTestId('sidebar-tab-chat'));
        expect(screen.getByTestId('empty-chat-list').textContent).toBe('No chats yet.');

        // The delayed fork settles AFTER the switch. Desired: its summary and
        // record belong to the ONLINE namespace — the offline sidebar and
        // surface must stay untouched. (Defect: the ungated fork completion
        // inserts the online summary into the offline list and yanks the
        // offline surface to the online record.)
        await act(async () => {
            forkCreate.resolve(201, { conversationId: 'fork-online' });
        });
        expect(screen.queryByTestId('chat-tab-fork-online')).toBeNull();
        expect(screen.getByTestId('empty-chat-list').textContent).toBe('No chats yet.');
        expect(screen.queryByText('Forked branch')).toBeNull();
        expect(screen.queryByText('Hello from the assistant')).toBeNull();
    });

    it('a delayed online delete failure never lands in the offline banner (deleteChat is ungated)', async () => {
        const onlineDelete = heldRequest();
        vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
            if (url === OFFLINE_MODELS_URL && init?.method === 'GET') {
                return Promise.resolve(response(200, catalog));
            }
            if (url === `${PROVIDER_URL}/models` && init?.method === 'GET') {
                return Promise.resolve(response(200, catalog));
            }
            if (url === BASE_URL && init?.method === 'GET') {
                return Promise.resolve(response(200, {
                    conversations: [{
                        conversationId: ONLINE_CONVERSATION.conversationId,
                        title: ONLINE_CONVERSATION.title,
                        model: ONLINE_CONVERSATION.model,
                        status: ONLINE_CONVERSATION.status,
                        messageCount: ONLINE_CONVERSATION.messageCount,
                        createdAt: ONLINE_CONVERSATION.createdAt,
                        updatedAt: ONLINE_CONVERSATION.updatedAt
                    }]
                }));
            }
            if (url === `${BASE_URL}/conversation-1` && init?.method === 'GET') {
                return Promise.resolve(response(200, {
                    conversationId: ONLINE_CONVERSATION.conversationId,
                    conversation: ONLINE_CONVERSATION
                }));
            }
            // The identified DELETE is the held request; it settles as a
            // 404 (the server's missing-identifier message) after the switch.
            if (url === `${BASE_URL}/conversation-1` && init?.method === 'DELETE') {
                return onlineDelete.promise;
            }
            return Promise.resolve(response(404, { error: `unexpected request: ${String(url)} ${init?.method ?? ''}` }));
        }));

        // ONLINE mode: select the conversation, start the delete (held).
        renderApp();
        await focusAndAwaitModel(DEFAULT_MODEL);
        fireEvent.click(screen.getByTestId('chat-tab-conversation-1'));
        await waitFor(() => expect(screen.getByText('Hello from the assistant')).toBeDefined());
        fireEvent.click(screen.getByTestId('delete-chat-conversation-1'));

        // Switch to OFFLINE (the switch clears the banner and resets flags).
        switchToMode('offline');
        fireEvent.click(screen.getByTestId('sidebar-tab-chat'));
        expect(screen.getByTestId('empty-chat-list').textContent).toBe('No chats yet.');
        expect(screen.queryByTestId('chat-error')).toBeNull();

        // The delayed DELETE settles with its 404 AFTER the switch. Desired:
        // the stale failure belongs to the online namespace — the offline
        // banner must not surface it. (Defect: the ungated catch writes the
        // online-mode error into the offline banner.)
        await act(async () => {
            onlineDelete.resolve(404, { error: "Conversation 'conversation-1' not found" });
        });
        expect(screen.queryByTestId('chat-error')).toBeNull();
        expect(screen.getByTestId('empty-chat-list').textContent).toBe('No chats yet.');
    });

    it('a delayed online message-delete PUT never yanks the offline surface to the online record (deleteMessage is ungated)', async () => {
        const onlinePut = heldRequest();
        vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
            if (url === OFFLINE_MODELS_URL && init?.method === 'GET') {
                return Promise.resolve(response(200, catalog));
            }
            if (url === `${PROVIDER_URL}/models` && init?.method === 'GET') {
                return Promise.resolve(response(200, catalog));
            }
            if (url === BASE_URL && init?.method === 'GET') {
                return Promise.resolve(response(200, {
                    conversations: [{
                        conversationId: ONLINE_CONVERSATION.conversationId,
                        title: ONLINE_CONVERSATION.title,
                        model: ONLINE_CONVERSATION.model,
                        status: ONLINE_CONVERSATION.status,
                        messageCount: ONLINE_CONVERSATION.messageCount,
                        createdAt: ONLINE_CONVERSATION.createdAt,
                        updatedAt: ONLINE_CONVERSATION.updatedAt
                    }]
                }));
            }
            if (url === `${BASE_URL}/conversation-1` && init?.method === 'GET') {
                return Promise.resolve(response(200, {
                    conversationId: ONLINE_CONVERSATION.conversationId,
                    conversation: ONLINE_CONVERSATION
                }));
            }
            // The identified PUT (message delete) is the held request; it
            // settles with the canonical shortened record after the switch.
            if (url === `${BASE_URL}/conversation-1` && init?.method === 'PUT') {
                return onlinePut.promise;
            }
            return Promise.resolve(response(404, { error: `unexpected request: ${String(url)} ${init?.method ?? ''}` }));
        }));

        // OFFLINE mode with a durable local record; the online-mode surface is
        // reached through the mode switch (both namespaces must stay distinct).
        seedOffline();
        seedLocalRecord();
        renderApp();
        await focusAndAwaitModel(DEFAULT_MODEL);
        fireEvent.click(screen.getByTestId('chat-tab-local-x'));
        await waitFor(() => expect(screen.getByText('Local answer')).toBeDefined());

        // Switch ONLINE, open the server conversation, and start the
        // message-delete PUT (held in flight). The online collection GET
        // resolves asynchronously, so wait for the entry before clicking it.
        switchToMode('online');
        fireEvent.click(screen.getByTestId('sidebar-tab-chat'));
        await waitFor(() => expect(screen.getByTestId('chat-tab-conversation-1')).toBeDefined());
        fireEvent.click(screen.getByTestId('chat-tab-conversation-1'));
        await waitFor(() => expect(screen.getByText('Hello from the assistant')).toBeDefined());
        fireEvent.click(screen.getByTestId('message-preview-0'));
        fireEvent.click(screen.getByTestId('delete-message-0'));

        // Switch back OFFLINE and re-open the local conversation (the local
        // list resolves asynchronously too, so wait for the entry).
        switchToMode('offline');
        fireEvent.click(screen.getByTestId('sidebar-tab-chat'));
        await waitFor(() => expect(screen.getByTestId('chat-tab-local-x')).toBeDefined());
        fireEvent.click(screen.getByTestId('chat-tab-local-x'));
        await waitFor(() => expect(screen.getByText('Local answer')).toBeDefined());

        // The delayed PUT settles AFTER the switch. Desired: the rewritten
        // ONLINE record must not replace the OFFLINE surface's selection —
        // the local conversation stays open with its own messages. (Defect:
        // the ungated completion applies the online record to the offline
        // surface.)
        await act(async () => {
            onlinePut.resolve(200, {
                conversationId: ONLINE_CONVERSATION.conversationId,
                conversation: {
                    ...ONLINE_CONVERSATION,
                    messageCount: 1,
                    messages: [ONLINE_CONVERSATION.messages[0]]
                }
            });
        });
        expect(screen.getByText('Local answer')).toBeDefined();
        expect(screen.getByTestId('chat-tab-local-x')).toBeDefined();
        expect(screen.queryByText('Hello assistant')).toBeNull();
    });
});

describe('short-lived storage flows vs mode switch (remaining gated handlers: saveTitle / commitEdit)', () => {
    // Completes the defect-class coverage for the handler set the epoch fix
    // gates (submit, selectChat, saveSystemPromptDraft, deleteChat,
    // deleteMessage, switchMessage, forkConversation, saveTitle, commitEdit):
    // the two remaining PUT paths are exercised the same way the delete-PUT
    // is — a held remote write that settles AFTER a mode switch must keep
    // the new mode's surface intact while persisting into the captured
    // namespace. (switchMessage shares deleteMessage/commitEdit's PUT +
    // savingEdit gate structure verbatim, so it is covered by the same rule.)
    const heldRequest = () => {
        let resolve!: (response: Response) => void;
        const promise = new Promise<Response>((r) => {
            resolve = r;
        });
        return {
            promise,
            resolve: (status: number, body: unknown) => {
                resolve(response(status, body));
            }
        };
    };

    const ONLINE_CONVERSATION = {
        conversationId: 'conversation-1',
        title: 'Hello assistant',
        model: 'alpha-org/zeta-model',
        status: 'complete' as const,
        messageCount: 2,
        messages: [
            { role: 'user' as const, content: 'Hello assistant' },
            { role: 'assistant' as const, content: 'Hello from the assistant', model: 'alpha-org/zeta-model' }
        ],
        createdAt: '2026-08-06T00:00:00.000Z',
        updatedAt: '2026-08-06T00:00:01.000Z'
    };
    const LOCAL_CONVERSATION = {
        conversationId: 'local-x',
        title: 'Local chat',
        model: '',
        status: 'complete' as const,
        messageCount: 2,
        messages: [
            { role: 'user' as const, content: 'Local question' },
            { role: 'assistant' as const, content: 'Local answer' }
        ],
        createdAt: '2026-08-06T00:00:00.000Z',
        updatedAt: '2026-08-06T00:00:01.000Z'
    };

    const seedLocalRecord = () => {
        window.localStorage.setItem(
            LOCAL_CONVERSATIONS_KEY,
            JSON.stringify({ [LOCAL_CONVERSATION.conversationId]: LOCAL_CONVERSATION })
        );
    };

    // The shared mock shape: catalog + collection + record GETs resolve, the
    // designated PUT (rename / inline edit) is the held request.
    const buildFetchMock = (heldPut: { promise: Promise<Response> }) =>
        vi.fn((url: string, init?: RequestInit) => {
            if (url === OFFLINE_MODELS_URL && init?.method === 'GET') {
                return Promise.resolve(response(200, catalog));
            }
            if (url === `${PROVIDER_URL}/models` && init?.method === 'GET') {
                return Promise.resolve(response(200, catalog));
            }
            if (url === BASE_URL && init?.method === 'GET') {
                return Promise.resolve(response(200, {
                    conversations: [{
                        conversationId: ONLINE_CONVERSATION.conversationId,
                        title: ONLINE_CONVERSATION.title,
                        model: ONLINE_CONVERSATION.model,
                        status: ONLINE_CONVERSATION.status,
                        messageCount: ONLINE_CONVERSATION.messageCount,
                        createdAt: ONLINE_CONVERSATION.createdAt,
                        updatedAt: ONLINE_CONVERSATION.updatedAt
                    }]
                }));
            }
            if (url === `${BASE_URL}/conversation-1` && init?.method === 'GET') {
                return Promise.resolve(response(200, {
                    conversationId: ONLINE_CONVERSATION.conversationId,
                    conversation: ONLINE_CONVERSATION
                }));
            }
            if (url === `${BASE_URL}/conversation-1` && init?.method === 'PUT') {
                return heldPut.promise;
            }
            return Promise.resolve(response(404, { error: `unexpected request: ${String(url)} ${init?.method ?? ''}` }));
        });

    beforeEach(() => {
        window.localStorage.clear();
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('a delayed online rename never lands on the offline sidebar entry (saveTitle is gated)', async () => {
        const onlinePut = heldRequest();
        vi.stubGlobal('fetch', buildFetchMock(onlinePut));
        seedOffline();
        seedLocalRecord();
        renderApp();
        await focusAndAwaitModel(DEFAULT_MODEL);
        fireEvent.click(screen.getByTestId('chat-tab-local-x'));
        await waitFor(() => expect(screen.getByText('Local answer')).toBeDefined());

        // Switch ONLINE, open the server conversation, start the rename —
        // the whole-history PUT (rename body) is held in flight.
        switchToMode('online');
        fireEvent.click(screen.getByTestId('sidebar-tab-chat'));
        await waitFor(() => expect(screen.getByTestId('chat-tab-conversation-1')).toBeDefined());
        fireEvent.click(screen.getByTestId('chat-tab-conversation-1'));
        await waitFor(() => expect(screen.getByText('Hello from the assistant')).toBeDefined());
        fireEvent.click(screen.getByTestId('chat-title'));
        const titleEdit = screen.getByTestId('chat-title');
        titleEdit.textContent = 'Renamed branch';
        fireEvent.blur(titleEdit, { relatedTarget: null });

        // Switch back OFFLINE and re-open the local conversation.
        switchToMode('offline');
        fireEvent.click(screen.getByTestId('sidebar-tab-chat'));
        await waitFor(() => expect(screen.getByTestId('chat-tab-local-x')).toBeDefined());
        fireEvent.click(screen.getByTestId('chat-tab-local-x'));
        await waitFor(() => expect(screen.getByText('Local answer')).toBeDefined());

        // The delayed rename settles AFTER the switch with the renamed ONLINE
        // record. Desired: the offline sidebar entry and surface keep their
        // OWN title and messages (the rename persists to the captured online
        // namespace only — a reload in online mode shows it there).
        await act(async () => {
            onlinePut.resolve(200, {
                conversationId: ONLINE_CONVERSATION.conversationId,
                conversation: {
                    ...ONLINE_CONVERSATION,
                    title: 'Renamed branch'
                }
            });
        });
        expect(screen.getByTestId('chat-tab-local-x').textContent).toBe('Local chat2 messages · complete');
        expect(screen.getByText('Local answer')).toBeDefined();
        expect(screen.queryByText('Renamed branch')).toBeNull();
        expect(screen.queryByText('Hello from the assistant')).toBeNull();
    });

    it('a delayed online inline-edit PUT never yanks the offline surface to the online record (commitEdit is gated)', async () => {
        const onlinePut = heldRequest();
        vi.stubGlobal('fetch', buildFetchMock(onlinePut));
        seedOffline();
        seedLocalRecord();
        renderApp();
        await focusAndAwaitModel(DEFAULT_MODEL);
        fireEvent.click(screen.getByTestId('chat-tab-local-x'));
        await waitFor(() => expect(screen.getByText('Local answer')).toBeDefined());

        // Switch ONLINE, open the server conversation, commit an inline edit
        // of the (collapsed) user turn — expand it, edit the bubble, blur;
        // the whole-history PUT is held in flight.
        switchToMode('online');
        fireEvent.click(screen.getByTestId('sidebar-tab-chat'));
        await waitFor(() => expect(screen.getByTestId('chat-tab-conversation-1')).toBeDefined());
        fireEvent.click(screen.getByTestId('chat-tab-conversation-1'));
        await waitFor(() => expect(screen.getByText('Hello from the assistant')).toBeDefined());
        fireEvent.click(screen.getByTestId('message-preview-0'));
        const bubble = screen.getByTestId('message-content-0');
        fireEvent.click(bubble);
        bubble.textContent = 'Edited online';
        fireEvent.blur(bubble, { relatedTarget: null });

        // Switch back OFFLINE and re-open the local conversation.
        switchToMode('offline');
        fireEvent.click(screen.getByTestId('sidebar-tab-chat'));
        await waitFor(() => expect(screen.getByTestId('chat-tab-local-x')).toBeDefined());
        fireEvent.click(screen.getByTestId('chat-tab-local-x'));
        await waitFor(() => expect(screen.getByText('Local answer')).toBeDefined());

        // The delayed edit settle AFTER the switch: the rewritten ONLINE
        // record must not replace the OFFLINE surface's selection — the local
        // conversation stays open with its own messages and sidebar entry
        // (the edit persists to the captured online namespace only).
        await act(async () => {
            onlinePut.resolve(200, {
                conversationId: ONLINE_CONVERSATION.conversationId,
                conversation: {
                    ...ONLINE_CONVERSATION,
                    messages: [
                        { role: 'user' as const, content: 'Edited online' },
                        ONLINE_CONVERSATION.messages[1]
                    ]
                }
            });
        });
        expect(screen.getByTestId('chat-tab-local-x').textContent).toBe('Local chat2 messages · complete');
        expect(screen.getByText('Local answer')).toBeDefined();
        expect(screen.queryByText('Edited online')).toBeNull();
        expect(screen.queryByText('Hello from the assistant')).toBeNull();
    });
});
