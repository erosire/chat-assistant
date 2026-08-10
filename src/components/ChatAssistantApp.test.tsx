// Deterministic integration tests for the provider-driven conversation dashboard.
// The UI flow is: GET {provider}/models and the collection GET on mount (the latter
// restores the persisted chat history in the sidebar); on send, POST {provider}/chat/completions
// with stream: true and the entire history; the SSE reply renders live; only after the
// stream completes is the user+assistant pair persisted through the storage API and the
// canonical record GET. Model selection rules: remembered last-used model wins (localStorage),
// else the selected chat's recorded model, else the first catalog entry sorted by stripped
// model name (organisation prefixes are stripped from labels only).
// Conversation management covered here: "New chat" lives at the sidebar's top-left,
// the header's top-right Delete issues the identified DELETE, the sidebar drawer is
// toggleable on mobile, and the header title mirrors the selected chat's title
// (click it to open the rename dialog). Every assistant response is marked on the
// left of its caption row with the producing model (per-message ChatMessage.model);
// the edit pen sits on the right of that row and the x delete control in a row
// above the bubble (right-aligned) — both rewrite the history through the
// identified PUT, so the next turn sends the edited/shortened history upstream.
// Every turn also carries a copy action next to the pen that writes the raw
// message text to the system clipboard (a pure client-side action: no storage).
// Every chat is led by a system prompt: while the record has no system message
// an editable draft box shows (even empty); a non-empty draft is persisted as
// the leading system message on the next send (prepended to the provider
// history) and then renders like any turn (edit pen + copy) EXCEPT it cannot
// be deleted. Every turn carries a collapse caret in the row above its bubble:
// collapsed turns hide the bubble (and its controls) behind a one-line preview.
// System turns start COLLAPSED by default (prompts can be long); all other
// roles default to expanded.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatAssistantApp } from './ChatAssistantApp';

const BASE_URL = 'http://test.local/v1/chat-assistant/conversation';
const PROVIDER_URL = 'http://test.local/providers/private/v1';
// Must match MODEL_STORAGE_KEY in ChatAssistantApp.tsx.
const MODEL_STORAGE_KEY = 'chat-assistant:model';

// Two-entry catalog whose raw order follows ORGANISATION names (alpha-org first).
// Sorting by stripped model name must therefore pick 'zeta-org/test-model' first,
// proving the organisation prefix never drives ordering.
const DEFAULT_MODEL = 'zeta-org/test-model';
const ALT_MODEL = 'alpha-org/zeta-model';
const catalog = {
    object: 'list',
    data: [
        { id: ALT_MODEL, object: 'model', created: 1677610602, owned_by: 'localhost', context_length: 262144 },
        { id: DEFAULT_MODEL, object: 'model', created: 1677610602, owned_by: 'localhost', context_length: 262144 }
    ]
};

// The completed record deliberately stores the NON-default model so the "inherit the
// chat's recorded model" fallback cannot pass by coincidence. The assistant message
// carries its producing-model attribution (per-message ChatMessage.model), which
// also proves the provider client strips that field from upstream history requests.
const conversation = {
    conversationId: 'conversation-1',
    title: 'Hello assistant',
    model: ALT_MODEL,
    status: 'complete' as const,
    messageCount: 2,
    messages: [
        { role: 'user' as const, content: 'Hello assistant' },
        { role: 'assistant' as const, content: 'Hello from the assistant', model: ALT_MODEL }
    ],
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:01.000Z'
};

// JSON-envelope Response substitute for catalog, storage, and pre-stream error cases.
const response = (status: number, body: unknown) =>
    ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body
    }) as Response;

// The provider's fixed SSE completion: role chunk, content chunk, final usage chunk
// (empty delta + finish_reason, as the GPT clients emit), then the [DONE] terminator.
const completionFrames = [
    'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":" from the assistant"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":4,"total_tokens":9}}\n\n',
    'data: [DONE]\n\n'
];

// Eagerly-closed streaming Response used by flows that send in one shot.
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

// Manually driven SSE stream for tests that assert intermediate UI states between frames.
const controlledStream = () => {
    const encoder = new TextEncoder();
    // Assigned synchronously by the ReadableStream constructor.
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

// Mirrors the server's title rule for the mocked PUT response: first line
// (trimmed) of the first user turn; the existing title survives when no user
// turn remains in the replacement.
const titleFromMessages = (messages: ReadonlyArray<{ role: string; content: string }>): string => {
    const firstUser = messages.find((message) => message.role === 'user');
    const firstLine = (firstUser?.content.trim().split('\n', 1)[0] ?? '').trim();
    return firstLine || conversation.title;
};

// Default fetch mock routes storage, catalog, and streamed completion calls by URL/method.
// The collection GET (identified by the exact /conversation suffix) returns the
// persisted history list — empty by default so each test starts from a clean sidebar.
// PUT echoes the replacement history back in the canonical record: messageCount,
// updatedAt, and the derived title are recomputed like the real handler does.
const mockFetch = () =>
    vi.fn((url: string, init?: RequestInit) => {
        if (url.endsWith('/models')) return Promise.resolve(response(200, catalog));
        if (url.endsWith('/chat/completions')) return Promise.resolve(sseResponse(completionFrames));
        // The collection GET check must precede the generic identified GET branch.
        if (init?.method === 'GET' && url.endsWith('/conversation')) {
            return Promise.resolve(response(200, { conversations: [] }));
        }
        if (init?.method === 'POST' && url.endsWith('/conversation')) {
            return Promise.resolve(response(201, { conversationId: conversation.conversationId }));
        }
        if (init?.method === 'POST') return Promise.resolve(response(200, { conversationId: conversation.conversationId }));
        if (init?.method === 'PUT') {
            const body = JSON.parse(String(init.body)) as { messages: typeof conversation.messages; title?: string };
            return Promise.resolve(response(200, {
                conversationId: conversation.conversationId,
                conversation: {
                    ...conversation,
                    // Priority mirrors the handler: explicit rename > derivation.
                    title: body.title?.trim() || titleFromMessages(body.messages),
                    messages: body.messages,
                    messageCount: body.messages.length,
                    updatedAt: '2026-08-06T00:00:02.000Z'
                }
            }));
        }
        if (init?.method === 'DELETE') {
            return Promise.resolve(response(200, { conversationId: conversation.conversationId }));
        }
        if (init?.method === 'GET') {
            return Promise.resolve(response(200, { conversationId: conversation.conversationId, conversation }));
        }
        return Promise.resolve(response(404, { error: 'unexpected request' }));
    });

const renderApp = () =>
    render(<ChatAssistantApp baseUrl={BASE_URL} providerUrl={PROVIDER_URL} />);

// Sending requires the catalog's sorted default model, which arrives asynchronously.
const waitForModelSelection = async () => {
    await waitFor(() => expect((screen.getByTestId('model-select') as HTMLSelectElement).value).toBe(DEFAULT_MODEL));
};

// Send the standard first turn ("Hello assistant") and wait until the pair is persisted.
const sendFirstTurn = async () => {
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Hello assistant' } });
    fireEvent.click(screen.getByTestId('send-chat-button'));
    await waitFor(() => expect(screen.getByTestId('chat-tab-conversation-1')).toBeDefined());
};

describe('ChatAssistantApp', () => {
    // Mount fetches the provider catalog and the collection GET (empty history by
    // default). localStorage is cleared so the remembered-model rules start from a
    // deterministic blank state.
    beforeEach(() => {
        window.localStorage.clear();
        vi.stubGlobal('fetch', mockFetch());
    });
    afterEach(() => vi.unstubAllGlobals());

    it('renders the empty conversation and composer after fetching the model catalog', async () => {
        renderApp();

        expect(screen.getByTestId('chat-assistant')).toBeDefined();
        expect(screen.getByTestId('empty-chat-state').textContent).toContain('Start a conversation');
        // The header shows the product name until a chat with a title is selected;
        // with nothing selected the title is plain text (click-to-rename is a
        // button, so the tag proves interactivity) and no dialog is open.
        expect(screen.getByTestId('chat-title').textContent).toBe('Chat Assistant');
        expect(screen.getByTestId('chat-title').tagName).toBe('H1');
        expect(screen.queryByTestId('title-dialog')).toBeNull();
        // The mobile sidebar drawer starts closed; the toggle lives in the header.
        expect(screen.getByTestId('sidebar-toggle').getAttribute('aria-expanded')).toBe('false');
        expect(screen.getByTestId('chat-sidebar').getAttribute('data-open')).toBe('false');
        const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
        expect(input).toBeDefined();
        expect(input.getAttribute('rows')).toBeNull();
        expect(window.getComputedStyle(input).resize).toBe('none');
        expect(screen.getByTestId('send-chat-button')).toBeDefined();

        // The composer keeps the send control aligned to the top while the input grows.
        expect(window.getComputedStyle(screen.getByTestId('chat-composer')).alignItems).toBe('flex-start');

        // Mount requests are the credential-free provider model catalog followed by
        // the collection GET that restores the persisted chat history (empty here).
        await waitForModelSelection();
        expect((fetch as any).mock.calls).toEqual([
            [`${PROVIDER_URL}/models`, { method: 'GET' }],
            [BASE_URL, { method: 'GET' }]
        ]);
        // The sorted-catalog default is not a "use" and must not be remembered.
        expect(window.localStorage.getItem(MODEL_STORAGE_KEY)).toBeNull();
    });

    it('restores the persisted chat history on mount and loads messages on selection', async () => {
        // The server holds one completed conversation from a previous session; the
        // collection GET hands its summary to the fresh mount before any send.
        vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
            if (url.endsWith('/models')) return Promise.resolve(response(200, catalog));
            if (init?.method === 'GET' && url.endsWith('/conversation')) {
                return Promise.resolve(response(200, {
                    conversations: [{
                        conversationId: conversation.conversationId,
                        title: conversation.title,
                        model: conversation.model,
                        status: conversation.status,
                        messageCount: conversation.messageCount,
                        createdAt: conversation.createdAt,
                        updatedAt: conversation.updatedAt
                    }]
                }));
            }
            if (init?.method === 'GET') {
                return Promise.resolve(response(200, { conversationId: conversation.conversationId, conversation }));
            }
            return Promise.resolve(response(404, { error: 'unexpected request' }));
        }));
        renderApp();
        await waitForModelSelection();

        // The history tab appears without storing its messages client-side first.
        const tab = await screen.findByTestId('chat-tab-conversation-1');
        expect(tab.textContent).toBe('Hello assistant2 messages · complete');
        expect(screen.getByTestId('empty-chat-state')).toBeDefined();
        expect((fetch as any).mock.calls).toEqual([
            [`${PROVIDER_URL}/models`, { method: 'GET' }],
            [BASE_URL, { method: 'GET' }]
        ]);

        // Selecting the restored chat reads its full record through the identified GET.
        fireEvent.click(tab);
        await waitFor(() => expect(screen.getByText('Hello from the assistant')).toBeDefined());
        expect((fetch as any).mock.calls[2]).toEqual([`${BASE_URL}/conversation-1`, { method: 'GET' }]);
    });

    it('labels the send button with the stripped model name and sorts options by model name', async () => {
        renderApp();
        await waitForModelSelection();

        // Split control: [model|^] — the submit half is labeled with the stripped model name,
        // the caret half carries the hidden dropdown select.
        const sendButton = screen.getByTestId('send-chat-button') as HTMLButtonElement;
        const caret = screen.getByTestId('model-caret');
        expect(sendButton.textContent).toBe('test-model');
        // The caret glyph is the only visible label; the select inside stays invisible.
        expect(caret.querySelector('span[aria-hidden="true"]')?.textContent).toBe('^');
        expect(caret.querySelector('[data-testid="model-select"]')).not.toBeNull();

        // Options are sorted by stripped model name, NOT by organisation prefix:
        // raw catalog order is alpha-org first, yet 'test-model' sorts before 'zeta-model'.
        const select = screen.getByTestId('model-select') as HTMLSelectElement;
        expect(Array.from(select.options).map((option) => ({ value: option.value, label: option.textContent }))).toEqual([
            { value: DEFAULT_MODEL, label: 'test-model' },
            { value: ALT_MODEL, label: 'zeta-model' }
        ]);

        // Changing the model through the caret dropdown updates the stripped button label.
        fireEvent.change(select, { target: { value: ALT_MODEL } });
        expect(sendButton.textContent).toBe('zeta-model');
    });

    it('remembers the explicitly chosen model across remounts', async () => {
        const first = renderApp();
        await waitForModelSelection();

        fireEvent.change(screen.getByTestId('model-select'), { target: { value: ALT_MODEL } });
        expect(window.localStorage.getItem(MODEL_STORAGE_KEY)).toBe(ALT_MODEL);
        first.unmount();

        renderApp();
        // The remembered id wins over the sorted catalog default on the fresh mount.
        await waitFor(() => expect((screen.getByTestId('model-select') as HTMLSelectElement).value).toBe(ALT_MODEL));
        expect(screen.getByTestId('send-chat-button').textContent).toBe('zeta-model');
    });

    it('grows the message input from its content and keeps mouse resizing disabled', async () => {
        renderApp();

        const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
        Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 72 });
        fireEvent.change(input, { target: { value: 'Two rows of text' } });

        await waitFor(() => expect(input.style.height).toBe('72px'));
        expect(window.getComputedStyle(input).resize).toBe('none');
    });

    it('caps the auto-growing message input at eight line heights', async () => {
        renderApp();

        const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
        Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 1000 });
        fireEvent.change(input, { target: { value: 'A long message' } });

        await waitFor(() => expect(input.style.height).toBe('203.2px'));
        expect(window.getComputedStyle(input).overflowY).toBe('auto');
    });

    it('keeps an empty message input at one row instead of collapsing it', async () => {
        renderApp();

        const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
        Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 0 });
        fireEvent.change(input, { target: { value: '' } });

        await waitFor(() => expect(input.style.height).toBe('46.4px'));
    });

    it('streams from the provider first, then persists the completed pair, then GETs the record', async () => {
        renderApp();
        await waitForModelSelection();

        fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Hello assistant' } });
        fireEvent.click(screen.getByTestId('send-chat-button'));

        await waitFor(() => expect(screen.getByText('Hello from the assistant')).toBeDefined());
        // The title appears in three places after selection: the header's
        // top-left chat title, the sidebar label, and the user message bubble.
        expect(screen.getAllByText('Hello assistant')).toHaveLength(3);
        expect(screen.getByTestId('chat-tab-conversation-1')).toBeDefined();
        expect(screen.getByTestId('chat-model').textContent).toBe('Model: alpha-org/zeta-model');
        // The response is marked with its producing model (fixture attribution,
        // stripped-label form) under the assistant bubble.
        expect(screen.getByTestId('message-model-1').textContent).toBe('zeta-model');
        // The completed send is what the browser remembers as the last used model.
        expect(window.localStorage.getItem(MODEL_STORAGE_KEY)).toBe(DEFAULT_MODEL);

        // Order matters: catalog, history list, streamed provider completion, storage create, storage append, storage GET.
        expect((fetch as any).mock.calls).toEqual([
            [`${PROVIDER_URL}/models`, { method: 'GET' }],
            [BASE_URL, { method: 'GET' }],
            [
                `${PROVIDER_URL}/chat/completions`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: DEFAULT_MODEL,
                        stream: true,
                        messages: [{ role: 'user', content: 'Hello assistant' }]
                    })
                }
            ],
            [
                BASE_URL,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model: DEFAULT_MODEL })
                }
            ],
            [
                `${BASE_URL}/conversation-1`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    // The persisted assistant message is marked with the model that
                    // produced it (per-message attribution for the response caption).
                    body: JSON.stringify({
                        messages: [
                            { role: 'user', content: 'Hello assistant' },
                            { role: 'assistant', content: 'Hello from the assistant', model: DEFAULT_MODEL }
                        ],
                        model: DEFAULT_MODEL,
                        usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 }
                    })
                }
            ],
            [`${BASE_URL}/conversation-1`, { method: 'GET' }]
        ]);
    });

    it('renders the reply as it streams and persists nothing before the stream completes', async () => {
        const stream = controlledStream();
        vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
            if (url.endsWith('/models')) return Promise.resolve(response(200, catalog));
            if (url.endsWith('/chat/completions')) return Promise.resolve(stream.response());
            // The mount-time collection GET restores an empty history list.
            if (init?.method === 'GET' && url.endsWith('/conversation')) {
                return Promise.resolve(response(200, { conversations: [] }));
            }
            if (init?.method === 'POST' && url.endsWith('/conversation')) {
                return Promise.resolve(response(201, { conversationId: conversation.conversationId }));
            }
            if (init?.method === 'POST') return Promise.resolve(response(200, { conversationId: conversation.conversationId }));
            if (init?.method === 'GET') {
                return Promise.resolve(response(200, { conversationId: conversation.conversationId, conversation }));
            }
            return Promise.resolve(response(404, { error: 'unexpected request' }));
        }));
        renderApp();
        await waitForModelSelection();

        fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Hello assistant' } });
        fireEvent.click(screen.getByTestId('send-chat-button'));

        // The composer hands its text to the pending turn immediately.
        await waitFor(() => expect(screen.getByTestId('pending-user-message').textContent).toBe('Hello assistant'));
        expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe('');
        // The in-flight response is already marked with the model producing it
        // (stripped label of the currently selected model, as a sibling caption
        // so the streaming bubble's textContent stays exact).
        expect(screen.getByTestId('streaming-message-model').textContent).toBe('test-model');

        // First token renders live; storage stays untouched mid-stream.
        await act(async () => stream.push(completionFrames[0]));
        await waitFor(() => expect(screen.getByTestId('streaming-message').textContent).toBe('Hello'));
        expect((fetch as any).mock.calls).toHaveLength(3);

        await act(async () => stream.push(completionFrames[1]));
        await waitFor(() => expect(screen.getByTestId('streaming-message').textContent).toBe('Hello from the assistant'));

        // Stream completes: the pair is persisted and the live bubbles are replaced
        // by the canonical record messages.
        await act(async () => {
            stream.push(completionFrames[2]);
            stream.push(completionFrames[3]);
            stream.close();
        });
        await waitFor(() => expect(screen.getByTestId('chat-tab-conversation-1')).toBeDefined());
        expect((fetch as any).mock.calls).toHaveLength(6);
        expect(screen.queryByTestId('streaming-message')).toBeNull();
        expect(screen.queryByTestId('streaming-message-model')).toBeNull();
        expect(screen.queryByTestId('pending-user-message')).toBeNull();
        expect(window.localStorage.getItem(MODEL_STORAGE_KEY)).toBe(DEFAULT_MODEL);
    });

    it('refreshes the history list and the selected conversation', async () => {
        renderApp();
        await waitForModelSelection();
        await sendFirstTurn();

        fireEvent.click(screen.getByTestId('refresh-chats-button'));

        // Refresh first reloads the collection list, then re-reads the selected record.
        await waitFor(() => expect((fetch as any).mock.calls).toHaveLength(8));
        expect((fetch as any).mock.calls[6]).toEqual([BASE_URL, { method: 'GET' }]);
        expect((fetch as any).mock.calls[7]).toEqual([`${BASE_URL}/conversation-1`, { method: 'GET' }]);
    });

    it('sends the entire history to the newly selected model regardless of prior turns', async () => {
        renderApp();
        await waitForModelSelection();
        await sendFirstTurn();

        // The user overrides the model through the caret dropdown.
        fireEvent.change(screen.getByTestId('model-select'), { target: { value: ALT_MODEL } });
        fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Follow up question' } });
        fireEvent.click(screen.getByTestId('send-chat-button'));

        await waitFor(() => expect((fetch as any).mock.calls).toHaveLength(9));
        // The second streamed provider request carries the full 3-message history under the new model.
        expect((fetch as any).mock.calls[6]).toEqual([
            `${PROVIDER_URL}/chat/completions`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: ALT_MODEL,
                    stream: true,
                    messages: [
                        { role: 'user', content: 'Hello assistant' },
                        { role: 'assistant', content: 'Hello from the assistant' },
                        { role: 'user', content: 'Follow up question' }
                    ]
                })
            }
        ]);
        // The append records the model that actually produced this turn, both at
        // record level and as per-message attribution on the assistant reply.
        expect((fetch as any).mock.calls[7]).toEqual([
            `${BASE_URL}/conversation-1`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: [
                        { role: 'user', content: 'Follow up question' },
                        { role: 'assistant', content: 'Hello from the assistant', model: ALT_MODEL }
                    ],
                    model: ALT_MODEL,
                    usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 }
                })
            }
        ]);
    });

    it('keeps the remembered model when an existing chat is selected', async () => {
        renderApp();
        await waitForModelSelection();
        // The send remembers DEFAULT_MODEL even though the record stores ALT_MODEL.
        await sendFirstTurn();

        fireEvent.click(screen.getByTestId('chat-tab-conversation-1'));

        await waitFor(() => expect((fetch as any).mock.calls).toHaveLength(7));
        expect((fetch as any).mock.calls[6]).toEqual([`${BASE_URL}/conversation-1`, { method: 'GET' }]);
        // The recorded model must NOT override the remembered selection.
        expect((screen.getByTestId('model-select') as HTMLSelectElement).value).toBe(DEFAULT_MODEL);
    });

    it('inherits the recorded model of a selected chat when nothing is remembered', async () => {
        renderApp();
        await waitForModelSelection();
        await sendFirstTurn();

        // Forget the just-used model, then select the chat: its recorded model applies.
        window.localStorage.removeItem(MODEL_STORAGE_KEY);
        fireEvent.click(screen.getByTestId('chat-tab-conversation-1'));

        await waitFor(() => expect((screen.getByTestId('model-select') as HTMLSelectElement).value).toBe(ALT_MODEL));
        // The inherited model becomes the remembered one from then on.
        expect(window.localStorage.getItem(MODEL_STORAGE_KEY)).toBe(ALT_MODEL);
        expect(screen.getByTestId('send-chat-button').textContent).toBe('zeta-model');
    });

    it('restores the composer text and saves nothing when the provider fails before streaming', async () => {
        vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
            if (url.endsWith('/models')) return Promise.resolve(response(200, catalog));
            if (url.endsWith('/chat/completions')) return Promise.resolve(response(500, { error: 'provider exploded' }));
            if (init?.method === 'GET' && url.endsWith('/conversation')) {
                return Promise.resolve(response(200, { conversations: [] }));
            }
            return Promise.resolve(response(404, { error: 'unexpected request' }));
        }));
        renderApp();
        await waitForModelSelection();

        fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Hello assistant' } });
        fireEvent.click(screen.getByTestId('send-chat-button'));

        await waitFor(() => expect(screen.getByTestId('chat-error').textContent).toBe('provider exploded'));
        // Nothing was persisted: only the catalog, the history list, and the failed completion ran.
        expect((fetch as any).mock.calls).toEqual([
            [`${PROVIDER_URL}/models`, { method: 'GET' }],
            [BASE_URL, { method: 'GET' }],
            [
                `${PROVIDER_URL}/chat/completions`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: DEFAULT_MODEL,
                        stream: true,
                        messages: [{ role: 'user', content: 'Hello assistant' }]
                    })
                }
            ]
        ]);
        // The pending user turn is restored in the composer for a retry.
        expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe('Hello assistant');
        expect(screen.queryByTestId('pending-user-message')).toBeNull();
    });

    it('reports a mid-stream failure, restores the composer, and persists nothing', async () => {
        const stream = controlledStream();
        vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
            if (url.endsWith('/models')) return Promise.resolve(response(200, catalog));
            if (url.endsWith('/chat/completions')) return Promise.resolve(stream.response());
            if (init?.method === 'GET' && url.endsWith('/conversation')) {
                return Promise.resolve(response(200, { conversations: [] }));
            }
            return Promise.resolve(response(404, { error: 'unexpected request' }));
        }));
        renderApp();
        await waitForModelSelection();

        fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Hello assistant' } });
        fireEvent.click(screen.getByTestId('send-chat-button'));
        await waitFor(() => expect(screen.getByTestId('pending-user-message')).toBeDefined());

        await act(async () => {
            stream.push(completionFrames[0]);
            stream.push('data: {"error":{"message":"Upstream stream terminated","type":"stream_error"}}\n\n');
            stream.close();
        });

        await waitFor(() => expect(screen.getByTestId('chat-error').textContent).toBe('Upstream stream terminated'));
        expect((fetch as any).mock.calls).toHaveLength(3);
        expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe('Hello assistant');
        expect(screen.queryByTestId('pending-user-message')).toBeNull();
        expect(screen.queryByTestId('streaming-message')).toBeNull();
        // A failed turn is never recorded as the last used model.
        expect(window.localStorage.getItem(MODEL_STORAGE_KEY)).toBeNull();
    });

    it('deletes the selected conversation from the header action', async () => {
        renderApp();
        await waitForModelSelection();
        // Nothing selected yet: the destructive action stays disabled.
        expect((screen.getByTestId('delete-chat-button') as HTMLButtonElement).disabled).toBe(true);
        await sendFirstTurn();
        expect((screen.getByTestId('delete-chat-button') as HTMLButtonElement).disabled).toBe(false);

        fireEvent.click(screen.getByTestId('delete-chat-button'));

        // The identified DELETE runs; the sidebar entry and the selection vanish.
        await waitFor(() => expect(screen.queryByTestId('chat-tab-conversation-1')).toBeNull());
        expect((fetch as any).mock.calls).toHaveLength(7);
        expect((fetch as any).mock.calls[6]).toEqual([`${BASE_URL}/conversation-1`, { method: 'DELETE' }]);
        expect(screen.getByTestId('empty-chat-state')).toBeDefined();
        expect(screen.getByTestId('empty-chat-list').textContent).toBe('No chats yet.');
        // The header title falls back to the product name with nothing selected.
        expect(screen.getByTestId('chat-title').textContent).toBe('Chat Assistant');
        expect(screen.getByTestId('chat-title').tagName).toBe('H1');
        // With nothing selected the action disables itself again.
        expect((screen.getByTestId('delete-chat-button') as HTMLButtonElement).disabled).toBe(true);
    });

    it('places the new chat action at the sidebar top-left and resets the surface', async () => {
        renderApp();
        await waitForModelSelection();
        const sidebar = screen.getByTestId('chat-sidebar');
        const newChat = screen.getByTestId('new-chat-button');
        // The button must live IN the sidebar now (moved out of the header),
        // leading the column so it stays pinned to the sidebar's top-left.
        expect(sidebar.contains(newChat)).toBe(true);
        expect(sidebar.firstElementChild).toBe(newChat);
        expect(screen.getByTestId('chat-assistant').querySelector('header')!.contains(newChat)).toBe(false);
        await sendFirstTurn();

        fireEvent.click(newChat);

        // New chat clears the selection without touching the model selection,
        // and the header title falls back to the product name.
        expect(screen.getByTestId('empty-chat-state')).toBeDefined();
        expect(screen.queryByTestId('chat-model')).toBeNull();
        expect(screen.getByTestId('chat-title').textContent).toBe('Chat Assistant');
        expect((screen.getByTestId('model-select') as HTMLSelectElement).value).toBe(DEFAULT_MODEL);
    });

    it('toggles the sidebar drawer through the header button and the scrim', async () => {
        renderApp();
        await waitForModelSelection();
        const toggle = screen.getByTestId('sidebar-toggle');
        const sidebar = screen.getByTestId('chat-sidebar');
        // aria-expanded / data-open mirror the drawer state deterministically
        // (the sliding transform itself is a media-query concern, untestable in jsdom).
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expect(sidebar.getAttribute('data-open')).toBe('false');

        fireEvent.click(toggle);
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        expect(sidebar.getAttribute('data-open')).toBe('true');

        // Clicking the dimmed scrim closes the drawer again.
        fireEvent.click(screen.getByTestId('sidebar-scrim'));
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expect(sidebar.getAttribute('data-open')).toBe('false');
    });

    it('closes the mobile sidebar drawer when a chat is selected', async () => {
        renderApp();
        await waitForModelSelection();
        await sendFirstTurn();

        fireEvent.click(screen.getByTestId('sidebar-toggle'));
        expect(screen.getByTestId('sidebar-toggle').getAttribute('aria-expanded')).toBe('true');
        fireEvent.click(screen.getByTestId('chat-tab-conversation-1'));

        // Selecting a chat re-reads the record and closes the drawer (on md+
        // screens the sidebar is a static column, so this only affects mobile).
        // The drawer state flips in the async selectChat continuation, right
        // after the fetch resolves, so both assertions go through waitFor.
        await waitFor(() => expect((fetch as any).mock.calls).toHaveLength(7));
        expect((fetch as any).mock.calls[6]).toEqual([`${BASE_URL}/conversation-1`, { method: 'GET' }]);
        await waitFor(() => expect(screen.getByTestId('sidebar-toggle').getAttribute('aria-expanded')).toBe('false'));
    });

    it('edits a user message, replaces the whole history via PUT, and sends the edited history on the next turn', async () => {
        renderApp();
        await waitForModelSelection();
        await sendFirstTurn();

        // Open the inline editor on the first (user) message; it seeds the
        // current content. Only one edit runs at a time — the other affordance hides.
        fireEvent.click(screen.getByTestId('edit-message-0'));
        const editor = screen.getByTestId('edit-message-input') as HTMLTextAreaElement;
        expect(editor.value).toBe('Hello assistant');
        expect(screen.queryByTestId('edit-message-1')).toBeNull();

        fireEvent.change(editor, { target: { value: 'Edited question' } });
        fireEvent.click(screen.getByTestId('edit-message-save'));

        // The ENTIRE edited history goes to the identified PUT; the per-message
        // model attribution of the assistant turn survives the rewrite.
        await waitFor(() => expect((fetch as any).mock.calls).toHaveLength(7));
        expect((fetch as any).mock.calls[6]).toEqual([
            `${BASE_URL}/conversation-1`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: [
                        { role: 'user', content: 'Edited question' },
                        { role: 'assistant', content: 'Hello from the assistant', model: ALT_MODEL }
                    ]
                })
            }
        ]);
        // The editor closes and the edited first line became the chat title:
        // header (top-left), sidebar label, and message bubble all show it.
        await waitFor(() => expect(screen.queryByTestId('edit-message-input')).toBeNull());
        expect(screen.getAllByText('Edited question')).toHaveLength(3);

        // The next turn sends the EDITED history to the provider (the assistant
        // attribution stays stripped from the upstream payload).
        fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Next question' } });
        fireEvent.click(screen.getByTestId('send-chat-button'));
        await waitFor(() => expect((fetch as any).mock.calls).toHaveLength(10));
        expect((fetch as any).mock.calls[7]).toEqual([
            `${PROVIDER_URL}/chat/completions`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: DEFAULT_MODEL,
                    stream: true,
                    messages: [
                        { role: 'user', content: 'Edited question' },
                        { role: 'assistant', content: 'Hello from the assistant' },
                        { role: 'user', content: 'Next question' }
                    ]
                })
            }
        ]);
    });

    it('edits an assistant message through the same PUT and abandons drafts on cancel', async () => {
        renderApp();
        await waitForModelSelection();
        await sendFirstTurn();

        // Open the editor on the assistant response and cancel: no request runs.
        fireEvent.click(screen.getByTestId('edit-message-1'));
        const editor = screen.getByTestId('edit-message-input') as HTMLTextAreaElement;
        expect(editor.value).toBe('Hello from the assistant');
        fireEvent.change(editor, { target: { value: 'Discarded rewrite' } });
        fireEvent.click(screen.getByTestId('edit-message-cancel'));
        expect(screen.queryByTestId('edit-message-input')).toBeNull();
        expect((fetch as any).mock.calls).toHaveLength(6);
        expect(screen.getByText('Hello from the assistant')).toBeDefined();

        // Saving a rewrite replaces the history while keeping the attribution.
        fireEvent.click(screen.getByTestId('edit-message-1'));
        fireEvent.change(screen.getByTestId('edit-message-input'), { target: { value: 'Rewritten answer' } });
        fireEvent.click(screen.getByTestId('edit-message-save'));
        await waitFor(() => expect((fetch as any).mock.calls).toHaveLength(7));
        expect((fetch as any).mock.calls[6]).toEqual([
            `${BASE_URL}/conversation-1`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: [
                        { role: 'user', content: 'Hello assistant' },
                        { role: 'assistant', content: 'Rewritten answer', model: ALT_MODEL }
                    ]
                })
            }
        ]);
        await waitFor(() => expect(screen.queryByTestId('edit-message-input')).toBeNull());
        expect(screen.getByText('Rewritten answer')).toBeDefined();
        // The model caption still marks the rewritten response.
        expect(screen.getByTestId('message-model-1').textContent).toBe('zeta-model');
    });

    it('keeps the save action disabled until the edited text is non-empty', async () => {
        renderApp();
        await waitForModelSelection();
        await sendFirstTurn();

        fireEvent.click(screen.getByTestId('edit-message-0'));
        fireEvent.change(screen.getByTestId('edit-message-input'), { target: { value: '   ' } });

        // Blank content would corrupt the history; the server would reject it,
        // and the client refuses to send it in the first place.
        expect((screen.getByTestId('edit-message-save') as HTMLButtonElement).disabled).toBe(true);
        fireEvent.change(screen.getByTestId('edit-message-input'), { target: { value: 'A real edit' } });
        expect((screen.getByTestId('edit-message-save') as HTMLButtonElement).disabled).toBe(false);
    });

    it('deletes an individual user message through the identified PUT', async () => {
        renderApp();
        await waitForModelSelection();
        await sendFirstTurn();

        // The x control on the user turn removes exactly that message and
        // persists the shortened history as a whole history replacement.
        fireEvent.click(screen.getByTestId('delete-message-0'));

        await waitFor(() => expect((fetch as any).mock.calls).toHaveLength(7));
        expect((fetch as any).mock.calls[6]).toEqual([
            `${BASE_URL}/conversation-1`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: [{ role: 'assistant', content: 'Hello from the assistant', model: ALT_MODEL }]
                })
            }
        ]);
        // One turn remains; indices shift so the former second turn is gone.
        await waitFor(() => expect(screen.queryByTestId('message-turn-1')).toBeNull());
        expect(screen.getByText('Hello from the assistant')).toBeDefined();
        expect(screen.getByTestId('message-model-0').textContent).toBe('zeta-model');
    });

    it('deletes an individual assistant message together with its model caption', async () => {
        renderApp();
        await waitForModelSelection();
        await sendFirstTurn();

        fireEvent.click(screen.getByTestId('delete-message-1'));

        await waitFor(() => expect((fetch as any).mock.calls).toHaveLength(7));
        expect((fetch as any).mock.calls[6]).toEqual([
            `${BASE_URL}/conversation-1`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello assistant' }] })
            }
        ]);
        await waitFor(() => expect(screen.queryByText('Hello from the assistant')).toBeNull());
        // The attribution caption disappears with its message.
        expect(screen.queryByTestId('message-model-1')).toBeNull();
    });

    it('copies any message to the clipboard through the button next to the edit pen', async () => {
        // jsdom implements no Clipboard API, so navigator.clipboard is stubbed
        // for this test (configurable so it stays removable between tests).
        const writeText = vi.fn((_text: string) => Promise.resolve());
        Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText } });
        renderApp();
        await waitForModelSelection();
        await sendFirstTurn();

        // On EVERY turn the copy control sits immediately LEFT of the edit pen
        // inside the shared action pair on the caption row.
        const copyUser = screen.getByTestId('copy-message-0');
        expect(copyUser.nextElementSibling?.getAttribute('data-testid')).toBe('edit-message-0');
        const copyAssistant = screen.getByTestId('copy-message-1');
        expect(copyAssistant.nextElementSibling?.getAttribute('data-testid')).toBe('edit-message-1');

        // The user query goes to the clipboard...
        fireEvent.click(copyUser);
        await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
        expect(writeText).toHaveBeenLastCalledWith('Hello assistant');

        // ...and the assistant reply as well.
        fireEvent.click(copyAssistant);
        await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
        expect(writeText).toHaveBeenLastCalledWith('Hello from the assistant');

        // Copying never touches storage: still the 6 calls of the send flow.
        expect((fetch as any).mock.calls).toHaveLength(6);
    });

    it('leads every chat with an empty system prompt draft box that an empty draft never persists', async () => {
        renderApp();
        await waitForModelSelection();

        // New chat surface: the draft box is the message list's FIRST child,
        // empty — it renders even though nothing has been typed or sent.
        const box = screen.getByTestId('system-prompt-input') as HTMLTextAreaElement;
        expect(screen.getByTestId('message-list').firstElementChild).toBe(box);
        expect(box.value).toBe('');

        // Send a turn WITHOUT typing a prompt: neither payload nor storage gain
        // a system message, and the (still empty) box keeps leading the chat.
        fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Hello assistant' } });
        fireEvent.click(screen.getByTestId('send-chat-button'));
        await waitFor(() => expect(screen.getByTestId('chat-tab-conversation-1')).toBeDefined());
        expect((fetch as any).mock.calls[2][1].body).toBe(JSON.stringify({
            model: DEFAULT_MODEL,
            stream: true,
            messages: [{ role: 'user', content: 'Hello assistant' }]
        }));
        expect(JSON.parse((fetch as any).mock.calls[4][1].body as string)).toEqual({
            messages: [
                { role: 'user', content: 'Hello assistant' },
                { role: 'assistant', content: 'Hello from the assistant', model: DEFAULT_MODEL }
            ],
            model: DEFAULT_MODEL,
            usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 }
        });
        expect(screen.getByTestId('message-list').firstElementChild).toBe(screen.getByTestId('system-prompt-input'));
        expect((screen.getByTestId('system-prompt-input') as HTMLTextAreaElement).value).toBe('');

        // A fresh chat keeps the draft box empty.
        fireEvent.click(screen.getByTestId('new-chat-button'));
        expect((screen.getByTestId('system-prompt-input') as HTMLTextAreaElement).value).toBe('');
    });

    it('persists a typed system prompt as the leading system message on send and gives it edit/copy but no delete', async () => {
        // The identified GET returns the fixture WITH the persisted system
        // message — it only runs after the append, so no state tracking needed.
        const conversationWithSystem = {
            ...conversation,
            messageCount: 3,
            messages: [
                { role: 'system' as const, content: 'You are terse.' },
                ...conversation.messages
            ]
        };
        vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
            if (url.endsWith('/models')) return Promise.resolve(response(200, catalog));
            if (url.endsWith('/chat/completions')) return Promise.resolve(sseResponse(completionFrames));
            if (init?.method === 'GET' && url.endsWith('/conversation')) {
                return Promise.resolve(response(200, { conversations: [] }));
            }
            if (init?.method === 'POST' && url.endsWith('/conversation')) {
                return Promise.resolve(response(201, { conversationId: conversation.conversationId }));
            }
            if (init?.method === 'POST') return Promise.resolve(response(200, { conversationId: conversation.conversationId }));
            if (init?.method === 'PUT') {
                const body = JSON.parse(String(init.body)) as { messages: typeof conversationWithSystem.messages };
                return Promise.resolve(response(200, {
                    conversationId: conversation.conversationId,
                    conversation: {
                        ...conversationWithSystem,
                        title: titleFromMessages(body.messages),
                        messages: body.messages,
                        messageCount: body.messages.length,
                        updatedAt: '2026-08-06T00:00:02.000Z'
                    }
                }));
            }
            if (init?.method === 'GET') {
                return Promise.resolve(response(200, { conversationId: conversation.conversationId, conversation: conversationWithSystem }));
            }
            return Promise.resolve(response(404, { error: 'unexpected request' }));
        }));
        // Clipboard stub for the copy assertion (jsdom has no Clipboard API).
        const writeText = vi.fn((_text: string) => Promise.resolve());
        Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText } });
        renderApp();
        await waitForModelSelection();

        // Type a prompt, then send the first turn.
        fireEvent.change(screen.getByTestId('system-prompt-input'), { target: { value: 'You are terse.' } });
        fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Hello assistant' } });
        fireEvent.click(screen.getByTestId('send-chat-button'));
        await waitFor(() => expect(screen.getByTestId('chat-tab-conversation-1')).toBeDefined());
        // The provider history LEADS with the system message...
        expect((fetch as any).mock.calls[2]).toEqual([
            `${PROVIDER_URL}/chat/completions`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: DEFAULT_MODEL,
                    stream: true,
                    messages: [
                        { role: 'system', content: 'You are terse.' },
                        { role: 'user', content: 'Hello assistant' }
                    ]
                })
            }
        ]);
        // ...and the fresh conversation's append persists it at index 0.
        expect((fetch as any).mock.calls[4][1].body).toEqual(JSON.stringify({
            messages: [
                { role: 'system', content: 'You are terse.' },
                { role: 'user', content: 'Hello assistant' },
                { role: 'assistant', content: 'Hello from the assistant', model: DEFAULT_MODEL }
            ],
            model: DEFAULT_MODEL,
            usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 }
        }));

        // The record now leads with a system turn: the draft box is replaced.
        expect(screen.queryByTestId('system-prompt-input')).toBeNull();
        // The SYSTEM turn starts COLLAPSED by default (prompts can be long):
        // only its caret + first-line preview show, bubble/controls hidden.
        expect(screen.getByTestId('collapse-message-0').getAttribute('aria-expanded')).toBe('false');
        expect(screen.getByTestId('message-preview-0').textContent).toBe('You are terse.');
        expect(screen.getByTestId('message-turn-0').querySelector('article')).toBeNull();
        // User + assistant turns default to EXPANDED with bubbles and controls.
        expect(screen.getByTestId('collapse-message-1').getAttribute('aria-expanded')).toBe('true');
        expect(screen.getByTestId('collapse-message-2').getAttribute('aria-expanded')).toBe('true');
        expect(screen.getByTestId('message-turn-1').querySelector('article')?.textContent).toBe('Hello assistant');
        expect(screen.getByTestId('message-turn-2').querySelector('article')?.textContent).toBe('Hello from the assistant');

        // Expanding the system turn reveals it like any other turn: edit pen +
        // copy exist (immediately adjacent), but NO delete cross — the prompt
        // cannot be removed.
        fireEvent.click(screen.getByTestId('collapse-message-0'));
        expect(screen.getByTestId('collapse-message-0').getAttribute('aria-expanded')).toBe('true');
        expect(screen.getByTestId('message-turn-0').querySelector('article')?.textContent).toBe('You are terse.');
        expect(screen.queryByTestId('message-preview-0')).toBeNull();
        expect(screen.getByTestId('edit-message-0')).toBeDefined();
        const copySystem = screen.getByTestId('copy-message-0');
        expect(copySystem.nextElementSibling?.getAttribute('data-testid')).toBe('edit-message-0');
        expect(screen.queryByTestId('delete-message-0')).toBeNull();
        expect(screen.getByTestId('delete-message-1')).toBeDefined();
        expect(screen.getByTestId('delete-message-2')).toBeDefined();

        // Copying the system prompt writes its raw text to the clipboard.
        fireEvent.click(copySystem);
        await waitFor(() => expect(writeText).toHaveBeenCalledWith('You are terse.'));

        // Editing the system prompt rewrites the full history through the PUT,
        // keeping the user/assistant turns and their model attribution intact.
        fireEvent.click(screen.getByTestId('edit-message-0'));
        expect((screen.getByTestId('edit-message-input') as HTMLTextAreaElement).value).toBe('You are terse.');
        fireEvent.change(screen.getByTestId('edit-message-input'), { target: { value: 'You are verbose.' } });
        fireEvent.click(screen.getByTestId('edit-message-save'));
        await waitFor(() => expect((fetch as any).mock.calls).toHaveLength(7));
        expect((fetch as any).mock.calls[6]).toEqual([
            `${BASE_URL}/conversation-1`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: [
                        { role: 'system', content: 'You are verbose.' },
                        { role: 'user', content: 'Hello assistant' },
                        { role: 'assistant', content: 'Hello from the assistant', model: ALT_MODEL }
                    ]
                })
            }
        ]);
        await waitFor(() => expect(screen.getByText('You are verbose.')).toBeDefined());
        // The draft box stays hidden: the record still leads with a system turn.
        expect(screen.queryByTestId('system-prompt-input')).toBeNull();
    });

    it('adds a typed draft prompt to an existing chat via the identified PUT, prepended at index 0', async () => {
        renderApp();
        await waitForModelSelection();
        // First turn WITHOUT a prompt: the record has no system message...
        await sendFirstTurn();
        expect((fetch as any).mock.calls).toHaveLength(6);
        // ...so the empty draft box is still showing.
        const box = screen.getByTestId('system-prompt-input') as HTMLTextAreaElement;
        expect(box.value).toBe('');

        // NOW type a prompt and send a second turn.
        fireEvent.change(box, { target: { value: 'You are terse.' } });
        fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Turn two' } });
        fireEvent.click(screen.getByTestId('send-chat-button'));

        // The provider history is system-prepended (attribution stripped upstream).
        await waitFor(() => expect((fetch as any).mock.calls).toHaveLength(8));
        expect((fetch as any).mock.calls[6]).toEqual([
            `${PROVIDER_URL}/chat/completions`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: DEFAULT_MODEL,
                    stream: true,
                    messages: [
                        { role: 'system', content: 'You are terse.' },
                        { role: 'user', content: 'Hello assistant' },
                        { role: 'assistant', content: 'Hello from the assistant' },
                        { role: 'user', content: 'Turn two' }
                    ]
                })
            }
        ]);
        // An append POST could only attach to the END, so the prompt joins an
        // existing chat through a WHOLE-HISTORY PUT with the prompt at index 0.
        expect((fetch as any).mock.calls[7]).toEqual([
            `${BASE_URL}/conversation-1`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: [
                        { role: 'system', content: 'You are terse.' },
                        { role: 'user', content: 'Hello assistant' },
                        { role: 'assistant', content: 'Hello from the assistant', model: ALT_MODEL },
                        { role: 'user', content: 'Turn two' },
                        { role: 'assistant', content: 'Hello from the assistant', model: DEFAULT_MODEL }
                    ]
                })
            }
        ]);

        // The record leads with the system turn; the draft box is gone and the
        // draft itself was cleared by the send. The fresh record re-seeds the
        // collapse set: the prepended system turn shows only its preview...
        await waitFor(() => expect(screen.queryByTestId('system-prompt-input')).toBeNull());
        expect(screen.getByTestId('collapse-message-0').getAttribute('aria-expanded')).toBe('false');
        expect(screen.getByTestId('message-preview-0').textContent).toBe('You are terse.');
        // ...while the trailing assistant turn (index 4) renders expanded.
        expect(screen.getByTestId('message-model-4').textContent).toBe('test-model');
    });

    it('collapses any turn to a one-line preview and expands it back', async () => {
        renderApp();
        await waitForModelSelection();
        await sendFirstTurn();

        // Defaults: user + assistant turns expanded (caret down), no previews.
        expect(screen.getByTestId('collapse-message-0').getAttribute('aria-expanded')).toBe('true');
        expect(screen.getByTestId('collapse-message-1').getAttribute('aria-expanded')).toBe('true');
        expect(screen.queryByTestId('message-preview-0')).toBeNull();
        expect(screen.queryByTestId('message-preview-1')).toBeNull();

        // Collapse the ASSISTANT turn: bubble + edit/copy/delete hide behind a
        // one-line preview of the reply's first line.
        fireEvent.click(screen.getByTestId('collapse-message-1'));
        expect(screen.getByTestId('collapse-message-1').getAttribute('aria-expanded')).toBe('false');
        expect(screen.getByTestId('message-preview-1').textContent).toBe('Hello from the assistant');
        expect(screen.getByTestId('message-turn-1').querySelector('article')).toBeNull();
        expect(screen.queryByTestId('edit-message-1')).toBeNull();
        expect(screen.queryByTestId('copy-message-1')).toBeNull();
        expect(screen.queryByTestId('delete-message-1')).toBeNull();
        // Collapsing is pure view state — no fetch ran.
        expect((fetch as any).mock.calls).toHaveLength(6);

        // Expand again restores the bubble and its controls.
        fireEvent.click(screen.getByTestId('collapse-message-1'));
        expect(screen.getByTestId('message-turn-1').querySelector('article')?.textContent).toBe('Hello from the assistant');
        expect(screen.queryByTestId('message-preview-1')).toBeNull();
        expect(screen.getByTestId('edit-message-1')).toBeDefined();
        expect(screen.getByTestId('copy-message-1')).toBeDefined();
        expect(screen.getByTestId('delete-message-1')).toBeDefined();

        // The USER turn collapses the same way: preview is the query's first line.
        fireEvent.click(screen.getByTestId('collapse-message-0'));
        expect(screen.getByTestId('message-preview-0').textContent).toBe('Hello assistant');
        expect(screen.getByTestId('message-turn-0').querySelector('article')).toBeNull();
        expect((fetch as any).mock.calls).toHaveLength(6);
    });

    it('renames the selected chat by clicking its title and using the dialog', async () => {
        renderApp();
        await waitForModelSelection();
        // With nothing selected the title is plain text and there is no dialog.
        expect(screen.getByTestId('chat-title').tagName).toBe('H1');
        expect(screen.queryByTestId('title-dialog')).toBeNull();
        await sendFirstTurn();

        // The selected chat's title sits in the header's top-left corner and IS
        // the click target — no separate pen exists.
        const titleButton = screen.getByTestId('chat-title');
        expect(titleButton.textContent).toBe('Hello assistant');
        expect(titleButton.tagName).toBe('BUTTON');
        fireEvent.click(titleButton);
        expect(screen.getByTestId('title-dialog')).toBeDefined();
        const input = screen.getByTestId('chat-title-input') as HTMLInputElement;
        expect(input.value).toBe('Hello assistant');

        fireEvent.change(input, { target: { value: 'My renamed chat' } });
        fireEvent.click(screen.getByTestId('chat-title-save'));

        // The history round-trips unchanged; only the explicit title is new.
        await waitFor(() => expect((fetch as any).mock.calls).toHaveLength(7));
        expect((fetch as any).mock.calls[6]).toEqual([
            `${BASE_URL}/conversation-1`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: [
                        { role: 'user', content: 'Hello assistant' },
                        { role: 'assistant', content: 'Hello from the assistant', model: ALT_MODEL }
                    ],
                    title: 'My renamed chat'
                })
            }
        ]);
        // The dialog closes and both header and sidebar follow the rename.
        await waitFor(() => expect(screen.queryByTestId('title-dialog')).toBeNull());
        expect(screen.getByTestId('chat-title').textContent).toBe('My renamed chat');
        expect(screen.getByTestId('chat-tab-conversation-1').textContent).toBe('My renamed chat2 messages · complete');
    });

    it('abandons a rename on cancel, Escape, or scrim click, and refuses a blank title', async () => {
        renderApp();
        await waitForModelSelection();
        await sendFirstTurn();

        fireEvent.click(screen.getByTestId('chat-title'));
        fireEvent.change(screen.getByTestId('chat-title-input'), { target: { value: '   ' } });
        // Blank titles are rejected client-side before any request.
        expect((screen.getByTestId('chat-title-save') as HTMLButtonElement).disabled).toBe(true);

        fireEvent.change(screen.getByTestId('chat-title-input'), { target: { value: 'Discarded rename' } });
        fireEvent.click(screen.getByTestId('chat-title-cancel'));

        // No request ran and the recorded title is still displayed.
        expect(screen.queryByTestId('title-dialog')).toBeNull();
        expect((fetch as any).mock.calls).toHaveLength(6);
        expect(screen.getByTestId('chat-title').textContent).toBe('Hello assistant');

        // Escape inside the dialog input closes it the same way.
        fireEvent.click(screen.getByTestId('chat-title'));
        fireEvent.keyDown(screen.getByTestId('chat-title-input'), { key: 'Escape' });
        expect(screen.queryByTestId('title-dialog')).toBeNull();
        expect((fetch as any).mock.calls).toHaveLength(6);

        // Clicking the dimmed scrim also dismisses without persisting.
        fireEvent.click(screen.getByTestId('chat-title'));
        fireEvent.click(screen.getByTestId('title-dialog-scrim'));
        expect(screen.queryByTestId('title-dialog')).toBeNull();
        expect((fetch as any).mock.calls).toHaveLength(6);
        expect(screen.getByTestId('chat-title').textContent).toBe('Hello assistant');
    });
});
