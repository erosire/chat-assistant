// Deterministic integration tests for the provider-driven conversation dashboard.
// The UI flow is: GET {provider}/models and the collection GET on mount (the latter
// restores the persisted chat history in the sidebar); on send, POST {provider}/chat/completions
// with stream: true and the entire history; the SSE reply renders live; only after the
// stream completes is the user+assistant pair persisted through the storage API and the
// canonical record GET. Model selection rules: remembered last-used model wins (localStorage),
// else the selected chat's recorded model, else the first catalog entry sorted by stripped
// model name (organisation prefixes are stripped from labels only).
// Conversation management covered here: "New chat" lives at the sidebar's
// top-left, EVERY sidebar entry carries an "x" delete control at its top-right
// corner (identified DELETE on that conversation; deleting the OPEN chat also
// resets the surface), the sidebar drawer is
// toggleable on mobile, and the header title mirrors the selected chat's title
// (click it: the h1 itself becomes CONTENTEDITABLE — inline rename, blur/Enter
// commits through the identified PUT, Escape reverts; no dialog exists).
// Every assistant response is marked in
// its top-left corner with the producing model (per-message ChatMessage.model);
// SMART INLINE EDITING: there is no input field — clicking an expanded turn's
// WORDS (or the edit pen on the right of its controls row) turns the bubble
// ITSELF into a contentEditable inline HTML editor, which SAVES AUTOMATICALLY
// ON BLUR (blank/unchanged text closes without a request) and cancels on
// ESCAPE (a keyed bubble remount reverts the mutated DOM); the x
// delete control in the row above the bubble (right-aligned) — edits and
// deletes both rewrite the
// history through the identified PUT, so the next turn sends the
// edited/shortened history upstream.
// Every turn also carries a copy action next to the pen that writes the raw
// message text to the system clipboard (a pure client-side action: no storage).
// Every chat is led by a system prompt row: while the record has no system
// message the DRAFT form shows (even empty) as a regular LEFT-aligned turn —
// top-left "system" label (plain span: nothing to fold), the literal
// placeholder "no prompt" in the bubble, and ONLY an edit pen (no copy
// without text) that opens the same inline editor every turn uses; a saved
// non-empty draft replaces the placeholder and is persisted as the leading
// system message on the next send (prepended to the provider history); system
// turns then render like any turn (same bubble styling as user/assistant,
// edit pen + copy) EXCEPT they cannot be deleted.
// Every turn carries an attribution label in the top-left corner
// of the row above its bubble (the producing model for assistant turns, the
// literal "user"/"system" speaker otherwise); that label IS the collapse
// toggle — no chevron glyph anywhere — and collapsed turns hide the bubble
// (and its controls) behind a STACK of the label line over a one-line preview
// (user side right-aligned) whose click expands the turn. Expanded turns
// floor at 50% of the list width; collapsed ones stay compact.
// By default EVERY turn starts COLLAPSED except the LATEST assistant reply —
// user turns fold, system turns fold, and older replies fold once a newer
// reply lands. Composer keyboard rules: Enter submits on desktop (md+),
// Shift+Enter inserts a newline; on mobile (below md) Enter only inserts a
// newline. The composer input starts at EXACTLY one row (rows=1, border-box
// height math incl. the 2px borders); the composer is a COLUMN: the model
// selection is a clickable TEXT line ABOVE the full-width input (always
// visible, the native dropdown select overlaying it invisibly), and the send
// button is a circular ">" arrow EMBEDDED in the input at its bottom-right —
// rendered ONLY while the composer has focus (focus-within, including the
// arrow and the model select). The input's right padding keeps text clear of
// the arrow. The rename dialog's actions
// stack full-width on mobile and sit in a right-aligned row on desktop.
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
// The split send control only exists while the composer has focus, so every
// helper focuses the input before touching the control (jsdom focus events
// reach React's root capture listener: no blur follows in these flows, so the
// control stays mounted for the rest of each test).
const waitForModelSelection = async () => {
    fireEvent.focus(screen.getByTestId('chat-input'));
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
        // The header shows the product name until a chat with a title is
        // selected; with nothing selected the title is plain NON-interactive
        // text (no contentEditable — renaming is inline, no dialog exists).
        expect(screen.getByTestId('chat-title').textContent).toBe('Chat Assistant');
        expect(screen.getByTestId('chat-title').tagName).toBe('H1');
        expect(screen.getByTestId('chat-title').getAttribute('contenteditable')).toBeNull();
        expect(screen.getByTestId('chat-title').getAttribute('title')).toBeNull();
        // The mobile sidebar drawer starts closed; the toggle lives in the header.
        expect(screen.getByTestId('sidebar-toggle').getAttribute('aria-expanded')).toBe('false');
        expect(screen.getByTestId('chat-sidebar').getAttribute('data-open')).toBe('false');
        // The send arrow stays HIDDEN until the composer has focus; the model
        // selection (plain text above the input) is always visible.
        expect(screen.queryByTestId('send-chat-button')).toBeNull();
        expect(screen.getByTestId('model-picker')).toBeDefined();
        expect(screen.getByTestId('model-select')).toBeDefined();

        const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
        expect(input).toBeDefined();
        // rows=1: the browser's two-row textarea default must not survive the
        // resize effect's 'auto' measurement (see resizeMessageInput).
        expect(input.getAttribute('rows')).toBe('1');
        expect(window.getComputedStyle(input).resize).toBe('none');

        // Composer geometry: model text ABOVE, then the field carrying the
        // input; focusing reveals the arrow INSIDE the field, after the input.
        const composer = screen.getByTestId('chat-composer');
        expect(window.getComputedStyle(composer).flexDirection).toBe('column');
        expect(composer.firstElementChild).toBe(screen.getByTestId('model-picker'));
        const field = screen.getByTestId('chat-input-field');
        expect(composer.lastElementChild).toBe(field);
        expect(field.firstElementChild).toBe(input);
        fireEvent.focus(input);
        expect(field.lastElementChild).toBe(screen.getByTestId('send-chat-button'));

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

    it('shows the selected model as a text line above the input and sorts options by model name', async () => {
        renderApp();
        await waitForModelSelection();

        // The model selection is a plain TEXT line above the input labeled
        // with the stripped model name; the invisible dropdown select overlays it.
        const picker = screen.getByTestId('model-picker');
        expect(screen.getByTestId('model-label').textContent).toBe('test-model');
        expect(picker.contains(screen.getByTestId('model-label'))).toBe(true);
        expect(picker.querySelector('[data-testid="model-select"]')).not.toBeNull();
        // The picker's position context is what the overlay select fills.
        expect(window.getComputedStyle(picker).position).toBe('relative');

        // Options are sorted by stripped model name, NOT by organisation prefix:
        // raw catalog order is alpha-org first, yet 'test-model' sorts before 'zeta-model'.
        const select = screen.getByTestId('model-select') as HTMLSelectElement;
        expect(Array.from(select.options).map((option) => ({ value: option.value, label: option.textContent }))).toEqual([
            { value: DEFAULT_MODEL, label: 'test-model' },
            { value: ALT_MODEL, label: 'zeta-model' }
        ]);

        // Changing the model through the text's dropdown updates the label.
        fireEvent.change(select, { target: { value: ALT_MODEL } });
        expect(screen.getByTestId('model-label').textContent).toBe('zeta-model');

        // The send button carries no model name anymore: it is the ">" arrow.
        expect(screen.getByTestId('send-chat-button').textContent).toBe('>');
    });

    it('remembers the explicitly chosen model across remounts', async () => {
        const first = renderApp();
        await waitForModelSelection();

        fireEvent.change(screen.getByTestId('model-select'), { target: { value: ALT_MODEL } });
        expect(window.localStorage.getItem(MODEL_STORAGE_KEY)).toBe(ALT_MODEL);
        first.unmount();

        renderApp();
        // The remembered id wins over the sorted catalog default on the fresh
        // mount (this test cannot reuse waitForModelSelection: it asserts the
        // DEFAULT model; the model text is always rendered, no focus needed).
        await waitFor(() => expect((screen.getByTestId('model-select') as HTMLSelectElement).value).toBe(ALT_MODEL));
        expect(screen.getByTestId('model-label').textContent).toBe('zeta-model');
    });

    it('grows the message input from its content and keeps mouse resizing disabled', async () => {
        renderApp();

        const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
        Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 72 });
        fireEvent.change(input, { target: { value: 'Two rows of text' } });

        // scrollHeight excludes borders; the border-box height adds the 2px
        // of vertical borders back: 72 + 2 = 74.
        await waitFor(() => expect(input.style.height).toBe('74px'));
        expect(window.getComputedStyle(input).resize).toBe('none');
    });

    it('caps the auto-growing message input at eight line heights', async () => {
        renderApp();

        const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
        Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 1000 });
        fireEvent.change(input, { target: { value: 'A long message' } });

        // Eight 22.4px lines + 24px padding + 2px borders = 205.2px outer.
        await waitFor(() => expect(input.style.height).toBe('205.2px'));
        expect(window.getComputedStyle(input).overflowY).toBe('auto');
    });

    it('keeps an empty message input at one row instead of collapsing it', async () => {
        renderApp();

        const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
        Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 0 });
        fireEvent.change(input, { target: { value: '' } });

        // Exactly one outer row: 22.4px line + 24px padding + 2px borders.
        await waitFor(() => expect(input.style.height).toBe('48.4px'));
    });

    it('embeds the focused send arrow inside the input on the shared one-row geometry, with the model as text above', async () => {
        renderApp();
        // waitForModelSelection focuses the composer: the arrow's rules only
        // EXIST in the sheet once it renders.
        await waitForModelSelection();

        // The value-bearing one-row behavior is covered by the resize tests
        // above; the STATIC layout contract lives in Emotion's injected
        // stylesheet, which this test reads directly (jsdom cannot evaluate
        // calc() or absolute positioning — see the z-index and dialog tests
        // for the same technique).
        const css = Array.from(document.querySelectorAll('style[data-emotion]'))
            .map((tag) => tag.textContent)
            .join('\n');

        // MessageInput is the only resize:none element; its rule must carry
        // the border-box one-row height AND the deepened RIGHT padding that
        // keeps text clear of the embedded arrow (32px circle at right:8px).
        const inputRule = /\.css-[^{]+\{[^}]*resize:none;[^}]*\}/.exec(css)?.[0];
        expect(inputRule).toBeDefined();
        expect(inputRule).toContain('box-sizing:border-box');
        expect(inputRule).toContain('height:calc(1.4em + 26px)');
        expect(inputRule).toContain('max-height:calc(1.4em * 8 + 26px)');
        expect(inputRule).toContain('padding:12px 52px 12px 14px');

        // The arrow: a 32px circle pinned absolute to the field's bottom-right
        // (border-radius:50% identifies the rule uniquely).
        const arrowRule = /\.css-[^{]+\{[^}]*border-radius:50%;[^}]*\}/.exec(css)?.[0];
        expect(arrowRule).toBeDefined();
        expect(arrowRule).toContain('position:absolute');
        expect(arrowRule).toContain('right:8px');
        expect(arrowRule).toContain('bottom:8px');
        expect(arrowRule).toContain('width:32px');
        expect(arrowRule).toContain('height:32px');
        expect(arrowRule).toContain('background-color:#5f82f0');

        // The model selection is plain muted TEXT (no button chrome): the
        // exact declaration sequence identifies its rule.
        expect(css).toMatch(/\.css-[^{]+\{color:#9ca8b8;font-size:12px;font-weight:700;cursor:pointer;\}/);
        // ...and the invisible overlay select fills the picker exactly.
        const selectRule = /\.css-[^{]+\{[^}]*opacity:0;[^}]*\}/.exec(css)?.[0];
        expect(selectRule).toBeDefined();
        expect(selectRule).toContain('position:absolute');
        expect(selectRule).toContain('inset:0');
    });

    it('keeps the send arrow hidden until the composer has focus, then shows it inside the input at the bottom-right', async () => {
        renderApp();
        // Catalog + history resolve regardless of focus (the mount effects).
        await waitFor(() => expect((fetch as any).mock.calls).toHaveLength(2));

        // The model selection text above the input is ALWAYS there (with its
        // overlay select); the send arrow is NOT.
        expect(screen.getByTestId('model-picker')).toBeDefined();
        expect(screen.getByTestId('model-select')).toBeDefined();
        expect(screen.queryByTestId('send-chat-button')).toBeNull();

        // Focus: the arrow appears INSIDE the field, docked bottom-right: the
        // field is the positioning context, the arrow absolute at right/bottom.
        fireEvent.focus(screen.getByTestId('chat-input'));
        const composer = screen.getByTestId('chat-composer');
        expect(composer.firstElementChild).toBe(screen.getByTestId('model-picker'));
        const field = screen.getByTestId('chat-input-field');
        expect(composer.lastElementChild).toBe(field);
        const arrow = screen.getByTestId('send-chat-button');
        expect(field.contains(arrow)).toBe(true);
        expect(window.getComputedStyle(field).position).toBe('relative');
        const arrowStyle = window.getComputedStyle(arrow);
        expect(arrowStyle.position).toBe('absolute');
        expect(arrowStyle.right).toBe('8px');
        expect(arrowStyle.bottom).toBe('8px');

        // Moving focus WITHIN the composer (input → arrow) keeps it visible —
        // the arrow must survive its own click focus move.
        fireEvent.blur(screen.getByTestId('chat-input'), { relatedTarget: arrow });
        expect(screen.getByTestId('send-chat-button')).toBeDefined();

        // Leaving the composer entirely (relatedTarget null) hides it again.
        fireEvent.blur(arrow, { relatedTarget: null });
        expect(screen.queryByTestId('send-chat-button')).toBeNull();

        // Re-focusing brings it back; only the two mount fetches ever ran.
        fireEvent.focus(screen.getByTestId('chat-input'));
        expect(screen.getByTestId('send-chat-button')).toBeDefined();
        expect((fetch as any).mock.calls).toHaveLength(2);
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
        // No "Model: ..." metadata strip exists; the producing model shows as
        // the composer text line (selected model) and on the turn's own label.
        expect(screen.queryByTestId('chat-model')).toBeNull();
        expect(screen.getByTestId('model-label').textContent).toBe('test-model');
        // The response is marked with its producing model (fixture attribution,
        // stripped-label form) in the assistant turn's top-left corner.
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
                    // produced it (per-message attribution for the top-left label).
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
        // (stripped label of the currently selected model, in the top-left row
        // above the streaming bubble so the bubble's textContent stays exact).
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
        expect(screen.getByTestId('model-label').textContent).toBe('zeta-model');
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

    it('deletes a conversation through the "x" at the top-right corner of its sidebar entry', async () => {
        renderApp();
        await waitForModelSelection();
        // No header delete anywhere — the control moved onto the entries.
        expect(screen.queryByTestId('delete-chat-button')).toBeNull();
        await sendFirstTurn();

        // The "x" lives INSIDE the sidebar entry as the select button's
        // SIBLING (the button immediately precedes it) — nested inside the
        // button it would be invalid HTML, and its clicks would select the chat.
        const tab = screen.getByTestId('chat-tab-conversation-1');
        const remove = screen.getByTestId('delete-chat-conversation-1');
        const entry = screen.getByTestId('chat-entry-conversation-1');
        expect(entry).toBe(tab.parentElement);
        expect(entry.contains(remove)).toBe(true);
        expect(tab.nextElementSibling).toBe(remove);
        expect(remove.tagName).toBe('BUTTON');
        // The glyph is the plain-text multiplication cross.
        expect(remove.querySelector('span[aria-hidden="true"]')?.textContent).toBe('×');

        // Placement: the entry is exactly the positioning context (the CSS rule
        // is the single bare declaration) and the x pins absolute top-right;
        // the select button's deep right padding keeps long titles clear of it.
        const css = Array.from(document.querySelectorAll('style[data-emotion]'))
            .map((tag) => tag.textContent)
            .join('\n');
        expect(css).toMatch(/\.css-[^{]+\{position:relative;\}/);
        const removeRule = /\.css-[^{]+\{[^}]*top:6px;right:6px;[^}]*\}/.exec(css)?.[0];
        expect(removeRule).toBeDefined();
        expect(removeRule).toContain('position:absolute');
        const tabRule = /\.css-[^{]+\{[^}]*padding:12px 32px 12px 12px;[^}]*\}/.exec(css)?.[0];
        expect(tabRule).toBeDefined();

        fireEvent.click(remove);

        // The identified DELETE runs; the sidebar entry and the selection vanish.
        await waitFor(() => expect(screen.queryByTestId('chat-tab-conversation-1')).toBeNull());
        expect((fetch as any).mock.calls).toHaveLength(7);
        expect((fetch as any).mock.calls[6]).toEqual([`${BASE_URL}/conversation-1`, { method: 'DELETE' }]);
        expect(screen.getByTestId('empty-chat-state')).toBeDefined();
        expect(screen.getByTestId('empty-chat-list').textContent).toBe('No chats yet.');
        // The header title falls back to the product name with nothing selected.
        expect(screen.getByTestId('chat-title').textContent).toBe('Chat Assistant');
        expect(screen.getByTestId('chat-title').tagName).toBe('H1');
    });

    it('deleting a sidebar entry that is NOT the open chat keeps the open chat intact', async () => {
        // Two conversations: create#1 → conversation-1, create#2 → conversation-2;
        // a chat is selected right after its own send completes.
        let created = 0;
        vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
            if (url.endsWith('/models')) return Promise.resolve(response(200, catalog));
            if (url.endsWith('/chat/completions')) return Promise.resolve(sseResponse(completionFrames));
            if (init?.method === 'GET' && url.endsWith('/conversation')) {
                return Promise.resolve(response(200, { conversations: [] }));
            }
            if (init?.method === 'POST' && url.endsWith('/conversation')) {
                created += 1;
                return Promise.resolve(response(201, { conversationId: `conversation-${created}` }));
            }
            if (init?.method === 'POST' || init?.method === 'DELETE') {
                return Promise.resolve(response(200, { conversationId: url }));
            }
            if (init?.method === 'GET') {
                // The record must carry the bare id (summaries derive tab ids
                // from it), not the full request URL.
                const id = url.slice(url.lastIndexOf('/') + 1);
                return Promise.resolve(response(200, {
                    conversationId: id,
                    conversation: { ...conversation, conversationId: id }
                }));
            }
            return Promise.resolve(response(404, { error: 'unexpected request' }));
        }));
        renderApp();
        await waitForModelSelection();

        // First chat: sent and selected; then a second chat sent and selected.
        await sendFirstTurn();
        fireEvent.click(screen.getByTestId('new-chat-button'));
        fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Hello assistant' } });
        fireEvent.click(screen.getByTestId('send-chat-button'));
        await waitFor(() => expect(screen.getByTestId('chat-tab-conversation-2')).toBeDefined());
        expect((fetch as any).mock.calls).toHaveLength(10);

        // Deleting conversation-1 (NOT the open chat) removes ONLY that entry:
        // the open chat, its title, and its messages all stay put.
        fireEvent.click(screen.getByTestId('delete-chat-conversation-1'));
        await waitFor(() => expect(screen.queryByTestId('chat-tab-conversation-1')).toBeNull());
        expect((fetch as any).mock.calls).toHaveLength(11);
        expect((fetch as any).mock.calls[10]).toEqual([`${BASE_URL}/conversation-1`, { method: 'DELETE' }]);
        expect(screen.getByTestId('chat-tab-conversation-2')).toBeDefined();
        expect(screen.getByTestId('chat-title').textContent).toBe('Hello assistant');
        expect(screen.getByText('Hello from the assistant')).toBeDefined();
        expect(screen.queryByTestId('empty-chat-state')).toBeNull();
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
        expect(screen.getByTestId('chat-title').textContent).toBe('Chat Assistant');
        expect((screen.getByTestId('model-select') as HTMLSelectElement).value).toBe(DEFAULT_MODEL);
        expect(screen.getByTestId('model-label').textContent).toBe('test-model');
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

    it('layers the open drawer ABOVE its scrim with valid z-index values (mobile taps keep landing on menu items)', async () => {
        renderApp();
        await waitForModelSelection();
        fireEvent.click(screen.getByTestId('sidebar-toggle'));
        expect(screen.getByTestId('sidebar-toggle').getAttribute('aria-expanded')).toBe('true');

        // Read Emotion's injected stylesheet directly (jsdom cannot compute
        // stacking contexts). REGRESSION: the sidebar's z-index once came from
        // a FUNCTION breakpoint map ({xs: 20}); styleStructure converts every
        // number inside such maps to rem — browsers dropped the invalid
        // "z-index:10rem", the scrim (z-index:10) painted ABOVE the drawer,
        // and every mobile tap closed the menu without selecting anything.
        const css = Array.from(document.querySelectorAll('style[data-emotion]'))
            .map((tag) => tag.textContent)
            .join('\n');
        // The drawer must carry a VALID z-index 20 (Emotion serializes
        // declarations without a space after the colon: "z-index:20").
        const sidebarRule = new RegExp(`\\.css-[^{]+\\{[^}]*z-index:\\s*20[^}]*\\}`, 'm').exec(css);
        expect(sidebarRule?.[0]).toContain('z-index:20');
        // ...and no z-index anywhere may be expressed in rem (the corruption).
        expect(css).not.toMatch(/z-index:\s*[\d.]+rem/);
        // The scrim stays strictly BELOW the drawer: z-index 10 < 20.
        expect(css).toMatch(/z-index:\s*10\b/);
        // Both layers exist in the DOM with the drawer rendered after the scrim.
        expect(screen.getByTestId('chat-sidebar').compareDocumentPosition(screen.getByTestId('sidebar-scrim')) & 2).toBe(2);
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

    it('edits a user message inline, replaces the whole history via PUT, and sends the edited history on the next turn', async () => {
        renderApp();
        await waitForModelSelection();
        await sendFirstTurn();

        // User turns start COLLAPSED by default: expand the first turn so its
        // edit pen (hidden while collapsed) can turn its bubble into the editor.
        fireEvent.click(screen.getByTestId('collapse-message-0'));
        expect(screen.getByTestId('collapse-message-0').getAttribute('aria-expanded')).toBe('true');

        // The pen turns the BUBBLE ITSELF into the inline HTML editor — no
        // textarea, no input field: the same testid now marks a contentEditable
        // article seeded with the current message text, and EVERY turn's
        // affordances hide while the edit runs.
        fireEvent.click(screen.getByTestId('edit-message-0'));
        const bubble = screen.getByTestId('message-content-0');
        expect(bubble.tagName).toBe('ARTICLE');
        expect(bubble.getAttribute('contenteditable')).toBe('true');
        expect(bubble.getAttribute('role')).toBe('textbox');
        expect(bubble.textContent).toBe('Hello assistant');
        expect(screen.queryByTestId('edit-message-0')).toBeNull();
        expect(screen.queryByTestId('edit-message-1')).toBeNull();

        // Edit the words IN PLACE (jsdom cannot type into contentEditable, so
        // the DOM text is set directly — exactly what the browser produces).
        bubble.textContent = 'Edited question';
        fireEvent.blur(bubble, { relatedTarget: null });

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
        // The bubble left edit mode and the edited first line became the chat
        // title: header (top-left), sidebar label, and the bubble itself.
        await waitFor(() => expect(screen.getByTestId('message-content-0').getAttribute('contenteditable')).toBeNull());
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

    it('edits an assistant message through the same PUT and abandons drafts on Escape', async () => {
        renderApp();
        await waitForModelSelection();
        await sendFirstTurn();

        // The assistant turn starts EXPANDED (latest reply): open the inline
        // editor via its pen, type, then press ESCAPE: the keyed bubble remount
        // reverts the DOM text and no request runs.
        fireEvent.click(screen.getByTestId('edit-message-1'));
        const bubble = screen.getByTestId('message-content-1');
        expect(bubble.getAttribute('contenteditable')).toBe('true');
        bubble.textContent = 'Discarded rewrite';
        fireEvent.keyDown(bubble, { key: 'Escape' });
        expect(screen.getByTestId('message-content-1').getAttribute('contenteditable')).toBeNull();
        expect(screen.getByTestId('message-content-1').textContent).toBe('Hello from the assistant');
        expect((fetch as any).mock.calls).toHaveLength(6);

        // A rewritten bubble committed on blur replaces the history while
        // keeping the attribution.
        fireEvent.click(screen.getByTestId('edit-message-1'));
        const editingBubbble = screen.getByTestId('message-content-1');
        editingBubbble.textContent = 'Rewritten answer';
        fireEvent.blur(editingBubbble, { relatedTarget: null });
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
        await waitFor(() => expect(screen.getByTestId('message-content-1').getAttribute('contenteditable')).toBeNull());
        expect(screen.getByText('Rewritten answer')).toBeDefined();
        // The top-left model label still marks the rewritten response.
        expect(screen.getByTestId('message-model-1').textContent).toBe('zeta-model');
    });

    it('performs no request when the bubble is blurred without any change', async () => {
        renderApp();
        await waitForModelSelection();
        await sendFirstTurn();

        // The user turn starts collapsed; expand it and turn its bubble into
        // the editor via the pen.
        fireEvent.click(screen.getByTestId('collapse-message-0'));
        fireEvent.click(screen.getByTestId('edit-message-0'));
        const bubble = screen.getByTestId('message-content-0');
        expect(bubble.getAttribute('contenteditable')).toBe('true');

        // Blur with the text UNTOUCHED: the editor closes but an identical
        // history never hits the wire.
        fireEvent.blur(bubble, { relatedTarget: null });
        expect(screen.getByTestId('message-content-0').getAttribute('contenteditable')).toBeNull();
        expect(screen.getByTestId('message-content-0').textContent).toBe('Hello assistant');
        expect((fetch as any).mock.calls).toHaveLength(6);

        // Whitespace-only text is equally not a save.
        fireEvent.click(screen.getByTestId('edit-message-0'));
        screen.getByTestId('message-content-0').textContent = '   ';
        fireEvent.blur(screen.getByTestId('message-content-0'), { relatedTarget: null });
        expect(screen.getByTestId('message-content-0').textContent).toBe('Hello assistant');
        expect((fetch as any).mock.calls).toHaveLength(6);
    });

    it('turns a message bubble itself into the editor by clicking its words and saves automatically on blur', async () => {
        renderApp();
        await waitForModelSelection();
        await sendFirstTurn();

        // The user turn starts COLLAPSED: expand it so its bubble renders (the
        // collapsed preview stays a one-click expander, not an editor opener).
        fireEvent.click(screen.getByTestId('collapse-message-0'));
        const viewBubble = screen.getByTestId('message-content-0');
        expect(viewBubble.textContent).toBe('Hello assistant');
        expect(viewBubble.getAttribute('contenteditable')).toBeNull();
        // The click-to-edit affordance: I-beam hint via the title tooltip.
        expect(viewBubble.getAttribute('title')).toBe('Click to edit');

        // Clicking the WORDS turns the bubble ITSELF into the inline HTML
        // editor (contentEditable + focused) — the edit pen (edit-message-0)
        // is never touched in this flow.
        fireEvent.click(viewBubble);
        const bubble = screen.getByTestId('message-content-0');
        expect(bubble.getAttribute('contenteditable')).toBe('true');
        expect(bubble.getAttribute('data-editing')).toBe('true');
        expect(document.activeElement).toBe(bubble);
        // Caret placement: jsdom implements no caretRangeFromPoint, so the
        // null-offset fallback lands the caret at the END of the text (never
        // the start — that was the pre-fix bug).
        expect(document.activeElement && window.getSelection()?.focusNode?.textContent).toBe('Hello assistant');
        expect(window.getSelection()?.focusOffset).toBe(15);
        bubble.textContent = 'Blurred edit';

        // Blur (a click somewhere outside the editor) commits automatically:
        // the ENTIRE history goes through the identified PUT — no Save exists.
        fireEvent.blur(bubble, { relatedTarget: null });
        await waitFor(() => expect((fetch as any).mock.calls).toHaveLength(7));
        expect((fetch as any).mock.calls[6]).toEqual([
            `${BASE_URL}/conversation-1`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: [
                        { role: 'user', content: 'Blurred edit' },
                        { role: 'assistant', content: 'Hello from the assistant', model: ALT_MODEL }
                    ]
                })
            }
        ]);
        // The bubble left edit mode and the committed text is everywhere it
        // belongs: header title, sidebar label, and the bubble itself.
        await waitFor(() => expect(screen.getByTestId('message-content-0').getAttribute('contenteditable')).toBeNull());
        expect(screen.getAllByText('Blurred edit')).toHaveLength(3);
        expect(screen.getByTestId('message-content-0').textContent).toBe('Blurred edit');
    });

    it('restores the caret onto the CLICKED WORD instead of the text start (click-point offset)', async () => {
        renderApp();
        await waitForModelSelection();
        await sendFirstTurn();

        // The assistant turn starts expanded. jsdom has no layout and no
        // caretRangeFromPoint, so STUB it: the click at (42, 16) resolves to
        // character offset 7 inside "Hello from the assistant" (between
        // "Hello f" and "rom..."). The stubbed node must live inside the
        // clicked (view) bubble — exactly what a real browser reports.
        const viewBubble = screen.getByTestId('message-content-1');
        const stubbedRange = document.createRange();
        stubbedRange.setStart(viewBubble.firstChild!, 7);
        stubbedRange.collapse(true);
        Object.defineProperty(document, 'caretRangeFromPoint', {
            configurable: true,
            value: vi.fn((_x: number, _y: number) => stubbedRange)
        });

        fireEvent.click(viewBubble, { clientX: 42, clientY: 16 });

        // The editable remount (fresh text node!) receives the caret AT the
        // captured offset — not at 0 (the raw-focus start-placement bug).
        const bubble = screen.getByTestId('message-content-1');
        expect(bubble.getAttribute('contenteditable')).toBe('true');
        expect(document.activeElement).toBe(bubble);
        const selection = window.getSelection();
        expect(selection?.focusNode?.textContent).toBe('Hello from the assistant');
        expect(selection?.focusOffset).toBe(7);

        // Escape exits; cleanup the stub.
        fireEvent.keyDown(bubble, { key: 'Escape' });
        expect((fetch as any).mock.calls).toHaveLength(6);
        delete (document as Partial<Document> & { caretRangeFromPoint?: unknown }).caretRangeFromPoint;
    });

    it('places the caret at the text END when the edit pen opens a bubble (no click point)', async () => {
        renderApp();
        await waitForModelSelection();
        await sendFirstTurn();

        // The pen carries no coordinates: the caret lands at the end of the
        // message ("Hello from the assistant" is 24 characters), ready to
        // append — never stranded at the text start.
        fireEvent.click(screen.getByTestId('edit-message-1'));
        const bubble = screen.getByTestId('message-content-1');
        expect(bubble.getAttribute('contenteditable')).toBe('true');
        const selection = window.getSelection();
        expect(selection?.focusNode?.textContent).toBe('Hello from the assistant');
        expect(selection?.focusOffset).toBe(24);
        fireEvent.keyDown(bubble, { key: 'Escape' });
    });

    it('commits on blur without resurrecting the chat when the surface moved on mid-save', async () => {
        renderApp();
        await waitForModelSelection();
        await sendFirstTurn();

        // Open the user bubble's inline editor and type an edit.
        fireEvent.click(screen.getByTestId('collapse-message-0'));
        fireEvent.click(screen.getByTestId('message-content-0'));
        const bubble = screen.getByTestId('message-content-0');
        bubble.textContent = 'Switched-away edit';

        // The SAME gesture starts "New chat": mousedown blurs the bubble (which
        // COMMITS through the PUT) and the click then resets the surface. When
        // the in-flight PUT returns, applying its record would resurrect the
        // old chat over the fresh surface — the commitEdit conversation guard
        // prevents exactly that.
        fireEvent.blur(bubble, { relatedTarget: screen.getByTestId('new-chat-button') });
        fireEvent.click(screen.getByTestId('new-chat-button'));

        // The blur still COMMITTED the edit server-side: the identified PUT ran
        // and the sidebar summary followed the re-derived title.
        await waitFor(() => expect((fetch as any).mock.calls).toHaveLength(7));
        expect((fetch as any).mock.calls[6]).toEqual([
            `${BASE_URL}/conversation-1`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: [
                        { role: 'user', content: 'Switched-away edit' },
                        { role: 'assistant', content: 'Hello from the assistant', model: ALT_MODEL }
                    ]
                })
            }
        ]);
        await waitFor(() => expect(screen.getByTestId('chat-tab-conversation-1').textContent).toBe('Switched-away edit2 messages · complete'));

        // ...but the surface stays the EMPTY NEW CHAT — the returning record
        // was never applied to `selected`.
        expect(screen.getByTestId('empty-chat-state')).toBeDefined();
        expect(screen.queryByTestId('message-content-0')).toBeNull();
        expect(screen.getByTestId('chat-title').textContent).toBe('Chat Assistant');
    });

    it('opens the system prompt editor by clicking its bubble and saves the draft on blur without touching storage', async () => {
        renderApp();
        await waitForModelSelection();

        // The "no prompt" placeholder bubble itself is the click target — the
        // pen (edit-system-prompt) is never touched in this flow.
        const viewBubble = screen.getByTestId('system-prompt-value');
        expect(viewBubble.textContent).toBe('no prompt');
        expect(viewBubble.getAttribute('title')).toBe('Click to edit');
        fireEvent.click(viewBubble);
        // The bubble became the inline editor: contentEditable + focused, and
        // EMPTY inside (the placeholder is display text, not draft content).
        const bubble = screen.getByTestId('system-prompt-value');
        expect(bubble.getAttribute('contenteditable')).toBe('true');
        expect(document.activeElement).toBe(bubble);
        expect(bubble.textContent).toBe('');

        // Blurring away saves the draft LOCALLY (blank would return the turn
        // to "no prompt") — the record stays untouched until the next send.
        bubble.textContent = 'You are terse.';
        fireEvent.blur(bubble, { relatedTarget: null });
        expect(screen.getByTestId('system-prompt-value').getAttribute('contenteditable')).toBeNull();
        expect(screen.getByTestId('system-prompt-value').textContent).toBe('You are terse.');
        expect(screen.getByTestId('system-prompt-value').getAttribute('data-empty')).toBe('false');
        expect((fetch as any).mock.calls).toHaveLength(2);

        // Reopening reseeds the saved draft; a blank blur restores "no prompt".
        fireEvent.click(screen.getByTestId('system-prompt-value'));
        expect(screen.getByTestId('system-prompt-value').textContent).toBe('You are terse.');
        screen.getByTestId('system-prompt-value').textContent = '   ';
        fireEvent.blur(screen.getByTestId('system-prompt-value'), { relatedTarget: null });
        expect(screen.getByTestId('system-prompt-value').textContent).toBe('no prompt');
        expect(screen.getByTestId('system-prompt-value').getAttribute('data-empty')).toBe('true');
        expect((fetch as any).mock.calls).toHaveLength(2);
    });

    it('deletes an individual user message through the identified PUT', async () => {
        renderApp();
        await waitForModelSelection();
        await sendFirstTurn();

        // The user turn starts collapsed; expand it to reach its delete cross.
        fireEvent.click(screen.getByTestId('collapse-message-0'));

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

    it('deletes an individual assistant message together with its model label', async () => {
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
        // The attribution label disappears with its message.
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

        // The user turn starts collapsed; expand it to reach its copy control
        // (the assistant turn is the latest reply, so it is already expanded).
        fireEvent.click(screen.getByTestId('collapse-message-0'));

        // On EVERY turn the copy control sits immediately LEFT of the edit pen
        // inside the shared action pair on the row under the bubble.
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

    it('leads every chat with the system prompt turn ("no prompt" by default) and an empty draft never persists', async () => {
        renderApp();
        await waitForModelSelection();

        // New chat surface: the system prompt row is the message list's FIRST
        // turn, its bubble showing the literal placeholder — the bubble is NOT
        // editable until the pen (or a click on it) turns it into the editor.
        const draftTurn = screen.getByTestId('system-prompt-turn');
        expect(screen.getByTestId('message-list').firstElementChild).toBe(draftTurn);
        expect(screen.getByTestId('system-prompt-value').textContent).toBe('no prompt');
        expect(screen.getByTestId('system-prompt-value').getAttribute('contenteditable')).toBeNull();

        // Opening the editor and CANCELLING (Escape) leaves the placeholder
        // untouched: the keyed bubble remount reverts the discarded DOM text.
        fireEvent.click(screen.getByTestId('edit-system-prompt'));
        const editingBubble = screen.getByTestId('system-prompt-value');
        expect(editingBubble.getAttribute('contenteditable')).toBe('true');
        expect(editingBubble.textContent).toBe('');
        editingBubble.textContent = 'Discarded prompt';
        fireEvent.keyDown(editingBubble, { key: 'Escape' });
        expect(screen.getByTestId('system-prompt-value').textContent).toBe('no prompt');
        expect(screen.getByTestId('system-prompt-value').getAttribute('contenteditable')).toBeNull();

        // Send a turn WITHOUT a prompt: neither payload nor storage gain
        // a system message, and the leading turn still shows the placeholder.
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
        expect(screen.getByTestId('message-list').firstElementChild).toBe(screen.getByTestId('system-prompt-turn'));
        expect(screen.getByTestId('system-prompt-value').textContent).toBe('no prompt');

        // A fresh chat keeps the placeholder too.
        fireEvent.click(screen.getByTestId('new-chat-button'));
        expect(screen.getByTestId('system-prompt-value').textContent).toBe('no prompt');
    });

    it('renders the system prompt row like an assistant/user turn: "no prompt" placeholder with only the edit pen', async () => {
        renderApp();
        await waitForModelSelection();

        // Regular turn chrome: header label row above, bubble, controls below.
        const turn = screen.getByTestId('system-prompt-turn');
        expect(screen.getByTestId('message-list').firstElementChild).toBe(turn);
        expect(turn.children).toHaveLength(3);

        // The top-left label is literally "system" (the same placeholder
        // speaker the persisted system turn gets) and it is a PLAIN SPAN, not
        // a collapse-toggle button — a local draft has nothing to fold.
        const label = screen.getByTestId('system-prompt-label');
        expect(label.textContent).toBe('system');
        expect(label.tagName).toBe('SPAN');
        expect(turn.children[0].contains(label)).toBe(true);

        // EMPTY state: the bubble is the literal placeholder, marked
        // data-empty, NOT yet editable (no contentEditable until clicked) —
        // and ONLY the edit pen renders (no copy without text, no delete
        // cross EVER).
        const bubble = screen.getByTestId('system-prompt-value');
        expect(turn.children[1]).toBe(bubble);
        expect(bubble.textContent).toBe('no prompt');
        expect(bubble.getAttribute('data-empty')).toBe('true');
        expect(bubble.tagName).toBe('ARTICLE');
        expect(bubble.getAttribute('contenteditable')).toBeNull();
        expect(screen.getByTestId('edit-system-prompt')).toBeDefined();
        expect(screen.queryByTestId('copy-system-prompt')).toBeNull();
        expect(screen.queryByTestId('delete-message-0')).toBeNull();

        // The system turn shares the assistant's LEFT-side full-width layout:
        // both wrappers cap at 100% of the list's content width — user turns
        // alone keep the min(760px, 86%) right-aligned cap.
        const css = Array.from(document.querySelectorAll('style[data-emotion]'))
            .map((tag) => tag.textContent)
            .join('\n');
        const fullTurn = /\.css-[^{]+\{[^}]*align-self:flex-start;[^}]*max-width:100%;[^}]*\}/.exec(css)?.[0];
        expect(fullTurn).toBeDefined();
        const userTurn = /\.css-[^{]+\{[^}]*align-self:flex-end;[^}]*max-width:min\(760px, 86%\);[^}]*\}/.exec(css)?.[0];
        expect(userTurn).toBeDefined();
        // EXPANDED turns floor at about half the list's content width. The
        // floor is the wrapper's DYNAMIC declaration (collapse-conditional),
        // so it lives in the turn's own Emotion class under the
        // @media (min-width: 0px) layer — read it off this rendered turn.
        const draftClass = screen.getByTestId('system-prompt-turn').className;
        expect(css).toContain(`@media (min-width: 0px){.${draftClass}{min-width:50%;}}`);
        // The empty placeholder bubble: the panel surface + bubble padding are
        // static, while the color is the dynamic (media-wrapped) MUTED variant
        // — styledComponent serializes function-valued props under
        // @media (min-width: 0px) and merges all of an element's dynamic
        // declarations into ONE block, so the click-to-edit I-beam cursor
        // (cursor:text — the draft bubble is editable at rest) sits beside it.
        const systemBase = /\.css-[^{]+\{[^}]*border-radius:16px;[^}]*\}/.exec(css)?.[0];
        expect(systemBase).toBeDefined();
        expect(systemBase).toContain('background-color:#1d2430');
        expect(systemBase).toContain('padding:12px 16px');
        expect(css).toMatch(/@media \(min-width: 0px\)\{\.css-[^{]+\{color:#9ca8b8;cursor:text;\}\}/);
        // The assistant bubble's border-box guard: with the full-width turn, a
        // content-box bubble would spill its 32px padding past the wrapper.
        const assistantBubble = /\.css-[^{]+\{[^}]*background-color:#202936;[^}]*\}/.exec(css)?.[0];
        expect(assistantBubble).toBeDefined();
        expect(assistantBubble).toContain('box-sizing:border-box');
    });

    it('edits the system prompt draft inline through its pen, copies the saved draft, and still persists nothing until the next send', async () => {
        // Clipboard stub (jsdom has no Clipboard API).
        const writeText = vi.fn((_text: string) => Promise.resolve());
        Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText } });
        renderApp();
        await waitForModelSelection();

        // The pen turns the bubble itself into the inline editor, seeded empty.
        fireEvent.click(screen.getByTestId('edit-system-prompt'));
        const editingBubble = screen.getByTestId('system-prompt-value');
        expect(editingBubble.getAttribute('contenteditable')).toBe('true');
        expect(editingBubble.textContent).toBe('');
        editingBubble.textContent = 'You are terse.';
        fireEvent.blur(editingBubble, { relatedTarget: null });

        // The saved draft replaces the placeholder; the copy action appears
        // immediately LEFT of the pen; the editor closed. NOTHING hit storage.
        const bubble = screen.getByTestId('system-prompt-value');
        expect(bubble.textContent).toBe('You are terse.');
        expect(bubble.getAttribute('data-empty')).toBe('false');
        expect(bubble.getAttribute('contenteditable')).toBeNull();
        const copy = screen.getByTestId('copy-system-prompt');
        expect(copy.nextElementSibling?.getAttribute('data-testid')).toBe('edit-system-prompt');
        expect((fetch as any).mock.calls).toHaveLength(2);

        fireEvent.click(copy);
        await waitFor(() => expect(writeText).toHaveBeenCalledWith('You are terse.'));

        // Reopening reseeds the saved draft; a blank blur-commit restores the
        // placeholder (and the copy action disappears again).
        fireEvent.click(screen.getByTestId('edit-system-prompt'));
        expect(screen.getByTestId('system-prompt-value').textContent).toBe('You are terse.');
        screen.getByTestId('system-prompt-value').textContent = '   ';
        fireEvent.blur(screen.getByTestId('system-prompt-value'), { relatedTarget: null });
        expect(screen.getByTestId('system-prompt-value').textContent).toBe('no prompt');
        expect(screen.queryByTestId('copy-system-prompt')).toBeNull();
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

        // Draft a prompt through the turn's pen (the bubble becomes the
        // contentEditable editor; a blur commits the draft), then send the
        // first turn.
        fireEvent.click(screen.getByTestId('edit-system-prompt'));
        screen.getByTestId('system-prompt-value').textContent = 'You are terse.';
        fireEvent.blur(screen.getByTestId('system-prompt-value'), { relatedTarget: null });
        expect(screen.getByTestId('system-prompt-value').textContent).toBe('You are terse.');
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

        // The record now leads with a system turn: the draft form is replaced.
        expect(screen.queryByTestId('system-prompt-value')).toBeNull();
        // Defaults: EVERY turn except the latest assistant reply starts
        // COLLAPSED — the system turn (prompts can be long) AND the user turn
        // show only their top-left label + first-line preview, bubbles/controls
        // hidden. The system turn's label is the literal "system" for now.
        expect(screen.getByTestId('message-label-0').textContent).toBe('system');
        expect(screen.getByTestId('collapse-message-0').getAttribute('aria-expanded')).toBe('false');
        expect(screen.getByTestId('message-preview-0').textContent).toBe('You are terse.');
        expect(screen.getByTestId('message-turn-0').querySelector('article')).toBeNull();
        expect(screen.getByTestId('collapse-message-1').getAttribute('aria-expanded')).toBe('false');
        expect(screen.getByTestId('message-preview-1').textContent).toBe('Hello assistant');
        expect(screen.getByTestId('message-turn-1').querySelector('article')).toBeNull();
        // The LATEST assistant reply stays expanded with bubble and controls.
        expect(screen.getByTestId('collapse-message-2').getAttribute('aria-expanded')).toBe('true');
        expect(screen.getByTestId('message-turn-2').querySelector('article')?.textContent).toBe('Hello from the assistant');

        // Expanding the system turn reveals it like any other turn: edit pen +
        // copy exist (immediately adjacent), but NO delete cross — the prompt
        // cannot be removed.
        fireEvent.click(screen.getByTestId('collapse-message-0'));
        expect(screen.getByTestId('collapse-message-0').getAttribute('aria-expanded')).toBe('true');
        expect(screen.getByTestId('message-turn-0').querySelector('article')?.textContent).toBe('You are terse.');
        expect(screen.queryByTestId('message-preview-0')).toBeNull();

        // The system bubble carries the SAME styling as the user/assistant
        // bubbles: shared padding, body text color, 16px bubble radius, and
        // inherited font size (no 13px/muted caption). Only the surface color
        // is its own — like the user (#273d72) and assistant (#202936)
        // surfaces differ. Read from Emotion's sheet (jsdom cannot compare
        // cascade inheritance): 'border-radius:16px;' exact matches only the
        // system bubble (user/assistant radii keep tail corners).
        const css = Array.from(document.querySelectorAll('style[data-emotion]'))
            .map((tag) => tag.textContent)
            .join('\n');
        const systemBubble = /\.css-[^{]+\{[^}]*border-radius:16px;[^}]*\}/.exec(css)?.[0];
        expect(systemBubble).toBeDefined();
        expect(systemBubble).toContain('background-color:#1d2430');
        expect(systemBubble).toContain('padding:12px 16px');
        expect(systemBubble).toContain('line-height:1.5');
        expect(systemBubble).not.toContain('font-size');
        // The bubble color is dynamic (empty placeholder = muted, content =
        // body text): styledComponent serializes function values under
        // @media (min-width: 0px), so the CONTENT variant proves itself there —
        // merged with the click-to-edit I-beam cursor of the EXPANDED (editable)
        // system turn (cursor:text; a cursor:default sibling block also exists
        // from the streaming phase, when editing was disabled).
        expect(css).toMatch(/@media \(min-width: 0px\)\{\.css-[^{]+\{color:#e8ecf2;cursor:text;\}\}/);
        // Parity with the assistant bubble, rendered expanded at index 2.
        const assistantBubble = /\.css-[^{]+\{[^}]*background-color:#202936;[^}]*\}/.exec(css)?.[0];
        expect(assistantBubble).toBeDefined();
        expect(assistantBubble).toContain('padding:12px 16px');
        expect(assistantBubble).toContain('color:#e8ecf2');
        expect(assistantBubble).toContain('line-height:1.5');
        expect(assistantBubble).not.toContain('font-size');
        expect(screen.getByTestId('edit-message-0')).toBeDefined();
        const copySystem = screen.getByTestId('copy-message-0');
        expect(copySystem.nextElementSibling?.getAttribute('data-testid')).toBe('edit-message-0');
        expect(screen.queryByTestId('delete-message-0')).toBeNull();
        // The collapsed user turn hides its delete cross until expanded; the
        // expanded (latest) assistant turn's delete cross is already visible.
        expect(screen.queryByTestId('delete-message-1')).toBeNull();
        expect(screen.getByTestId('delete-message-2')).toBeDefined();
        fireEvent.click(screen.getByTestId('collapse-message-1'));
        expect(screen.getByTestId('delete-message-1')).toBeDefined();
        // Re-collapse the user turn to restore the default collapse state.
        fireEvent.click(screen.getByTestId('collapse-message-1'));

        // Copying the system prompt writes its raw text to the clipboard.
        fireEvent.click(copySystem);
        await waitFor(() => expect(writeText).toHaveBeenCalledWith('You are terse.'));

        // Editing the PERSISTED system prompt rewrites the full history through
        // the PUT, keeping the user/assistant turns and their model attribution
        // intact: the pen turns its bubble into the seeded inline editor and
        // the blur commits.
        fireEvent.click(screen.getByTestId('edit-message-0'));
        const systemEdit = screen.getByTestId('message-content-0');
        expect(systemEdit.getAttribute('contenteditable')).toBe('true');
        expect(systemEdit.textContent).toBe('You are terse.');
        systemEdit.textContent = 'You are verbose.';
        fireEvent.blur(systemEdit, { relatedTarget: null });
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
        // The draft form stays hidden: the record still leads with a system turn.
        expect(screen.queryByTestId('system-prompt-value')).toBeNull();
    });

    it('adds a typed draft prompt to an existing chat via the identified PUT, prepended at index 0', async () => {
        renderApp();
        await waitForModelSelection();
        // First turn WITHOUT a prompt: the record has no system message...
        await sendFirstTurn();
        expect((fetch as any).mock.calls).toHaveLength(6);
        // ...so the leading system turn still shows the "no prompt" placeholder.
        expect(screen.getByTestId('system-prompt-value').textContent).toBe('no prompt');

        // NOW draft a prompt through the pen (bubble-as-editor + blur-commit)
        // and send a second turn.
        fireEvent.click(screen.getByTestId('edit-system-prompt'));
        screen.getByTestId('system-prompt-value').textContent = 'You are terse.';
        fireEvent.blur(screen.getByTestId('system-prompt-value'), { relatedTarget: null });
        expect(screen.getByTestId('system-prompt-value').textContent).toBe('You are terse.');
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

        // The record leads with the system turn; the draft form is gone and the
        // draft itself was cleared by the send. The fresh record re-seeds the
        // collapse set: the prepended system turn shows only its preview...
        await waitFor(() => expect(screen.queryByTestId('system-prompt-value')).toBeNull());
        expect(screen.getByTestId('collapse-message-0').getAttribute('aria-expanded')).toBe('false');
        expect(screen.getByTestId('message-preview-0').textContent).toBe('You are terse.');
        // ...while the trailing assistant turn (index 4) renders expanded.
        expect(screen.getByTestId('message-model-4').textContent).toBe('test-model');
    });

    it('collapses any turn to a one-line preview and expands it back', async () => {
        renderApp();
        await waitForModelSelection();
        await sendFirstTurn();

        // Defaults: the USER turn starts collapsed (top-left "user" label,
        // first-line preview, bubble hidden); only the LATEST ASSISTANT reply
        // starts expanded (model label, no preview).
        expect(screen.getByTestId('collapse-message-0').getAttribute('aria-expanded')).toBe('false');
        expect(screen.getByTestId('message-preview-0').textContent).toBe('Hello assistant');
        expect(screen.getByTestId('message-turn-0').querySelector('article')).toBeNull();
        expect(screen.getByTestId('collapse-message-1').getAttribute('aria-expanded')).toBe('true');
        expect(screen.queryByTestId('message-preview-1')).toBeNull();
        expect(screen.getByTestId('message-turn-1').querySelector('article')?.textContent).toBe('Hello from the assistant');

        // The collapsed view STACKS: the label sits on its OWN line with the
        // preview BELOW it (never inline). The lead is a COLUMN whose two
        // children are [label toggle, preview], and the whole stack keeps the
        // turn's side: the USER stack is RIGHT-aligned. Alignment + the
        // 50%-only-when-expanded width floor are DYNAMIC declarations (they
        // live in each element's own Emotion class under @media (min-width:
        // 0px)), so they are read from the sheet by class, not getComputedStyle.
        const css = Array.from(document.querySelectorAll('style[data-emotion]'))
            .map((tag) => tag.textContent)
            .join('\n');
        const mediaStyle = (testid: string, property: string): string | null => {
            const cls = screen.getByTestId(testid).className;
            return new RegExp(`@media \\(min-width: 0px\\)\\{\\.${cls}\\{[^}]*${property}:([^;]+);[^}]*\\}\\}`).exec(css)?.[1] ?? null;
        };
        const userLead = screen.getByTestId('collapse-message-0').parentElement as HTMLElement;
        expect(window.getComputedStyle(userLead).flexDirection).toBe('column');
        expect(userLead.firstElementChild).toBe(screen.getByTestId('collapse-message-0'));
        expect(userLead.lastElementChild).toBe(screen.getByTestId('message-preview-0'));
        // The LEAD (the toggle's parent column) keeps the user stack right-aligned.
        expect(new RegExp(`@media \\(min-width: 0px\\)\\{\\.${userLead.className}\\{[^}]*align-items:flex-end;[^}]*\\}\\}`).test(css)).toBe(true);
        // The user preview's text hugs the right edge as well.
        expect(mediaStyle('message-preview-0', 'text-align')).toBe('right');
        // The ASSISTANT stack mirrors left: same column, left alignment.
        const assistantLead = screen.getByTestId('collapse-message-1').parentElement as HTMLElement;
        expect(window.getComputedStyle(assistantLead).flexDirection).toBe('column');
        expect(new RegExp(`@media \\(min-width: 0px\\)\\{\\.${assistantLead.className}\\{[^}]*align-items:flex-start;[^}]*\\}\\}`).test(css)).toBe(true);
        // Width floor: ONLY the expanded turn carries min-width:50%; the
        // collapsed one stays compact (min-width:auto).
        expect(mediaStyle('message-turn-0', 'min-width')).toBe('auto');
        expect(mediaStyle('message-turn-1', 'min-width')).toBe('50%');

        // Collapse the ASSISTANT turn: bubble + edit/copy/delete hide behind a
        // one-line preview of the reply's first line STACKED under its label...
        fireEvent.click(screen.getByTestId('collapse-message-1'));
        expect(screen.getByTestId('collapse-message-1').getAttribute('aria-expanded')).toBe('false');
        expect(screen.getByTestId('message-preview-1').textContent).toBe('Hello from the assistant');
        expect(assistantLead.lastElementChild).toBe(screen.getByTestId('message-preview-1'));
        expect(screen.getByTestId('message-turn-1').querySelector('article')).toBeNull();
        expect(screen.queryByTestId('edit-message-1')).toBeNull();
        expect(screen.queryByTestId('copy-message-1')).toBeNull();
        expect(screen.queryByTestId('delete-message-1')).toBeNull();
        // ...and its width floor drops off: collapsed rows stay compact.
        expect(mediaStyle('message-turn-1', 'min-width')).toBe('auto');
        // Collapsing is pure view state — no fetch ran.
        expect((fetch as any).mock.calls).toHaveLength(6);

        // Expand again restores the bubble, its controls, and the 50% floor.
        fireEvent.click(screen.getByTestId('collapse-message-1'));
        expect(screen.getByTestId('message-turn-1').querySelector('article')?.textContent).toBe('Hello from the assistant');
        expect(screen.queryByTestId('message-preview-1')).toBeNull();
        expect(screen.getByTestId('edit-message-1')).toBeDefined();
        expect(screen.getByTestId('copy-message-1')).toBeDefined();
        expect(screen.getByTestId('delete-message-1')).toBeDefined();
        expect(mediaStyle('message-turn-1', 'min-width')).toBe('50%');

        // Expanding the collapsed USER turn restores its bubble and floor.
        fireEvent.click(screen.getByTestId('collapse-message-0'));
        expect(screen.queryByTestId('message-preview-0')).toBeNull();
        expect(screen.getByTestId('message-turn-0').querySelector('article')?.textContent).toBe('Hello assistant');
        expect(mediaStyle('message-turn-0', 'min-width')).toBe('50%');
        expect((fetch as any).mock.calls).toHaveLength(6);
    });

    it('labels every turn in its top-left corner (model for assistant, speaker otherwise) without any chevron', async () => {
        renderApp();
        await waitForModelSelection();
        await sendFirstTurn();

        // The USER turn's top-left label is the literal "user" (a placeholder
        // until a real speaker identity exists). The label text lives INSIDE
        // the collapse toggle button — the label IS the toggle.
        const userToggle = screen.getByTestId('collapse-message-0');
        expect(userToggle.tagName).toBe('BUTTON');
        expect(screen.getByTestId('message-label-0').textContent).toBe('user');
        expect(userToggle.contains(screen.getByTestId('message-label-0'))).toBe(true);

        // The ASSISTANT turn's top-left label is its producing model's
        // stripped name, again inside the toggle button.
        const assistantToggle = screen.getByTestId('collapse-message-1');
        expect(screen.getByTestId('message-model-1').textContent).toBe('zeta-model');
        expect(assistantToggle.contains(screen.getByTestId('message-model-1'))).toBe(true);

        // No chevron glyph renders on either toggle, in EITHER state.
        expect(userToggle.querySelector('span[aria-hidden="true"]')).toBeNull();
        expect(assistantToggle.querySelector('span[aria-hidden="true"]')).toBeNull();
        fireEvent.click(assistantToggle);
        expect(assistantToggle.getAttribute('aria-expanded')).toBe('false');
        expect(assistantToggle.querySelector('span[aria-hidden="true"]')).toBeNull();
    });

    it('expands a collapsed turn by clicking its preview line (the visible collapsed message)', async () => {
        renderApp();
        await waitForModelSelection();
        await sendFirstTurn();

        // The user turn starts collapsed: clicking the one-line preview — the
        // visible collapsed "message" — expands it, no chevron involved.
        const preview = screen.getByTestId('message-preview-0');
        expect(preview.textContent).toBe('Hello assistant');
        fireEvent.click(preview);
        expect(screen.getByTestId('collapse-message-0').getAttribute('aria-expanded')).toBe('true');
        expect(screen.queryByTestId('message-preview-0')).toBeNull();
        expect(screen.getByTestId('message-turn-0').querySelector('article')?.textContent).toBe('Hello assistant');
        // Preview clicks are pure view state — still only the send flow ran.
        expect((fetch as any).mock.calls).toHaveLength(6);

        // Collapse through the top-left "user" label, then expand through the
        // preview again: both affordances drive the same toggle.
        fireEvent.click(screen.getByTestId('collapse-message-0'));
        expect(screen.getByTestId('collapse-message-0').getAttribute('aria-expanded')).toBe('false');
        fireEvent.click(screen.getByTestId('message-preview-0'));
        expect(screen.getByTestId('collapse-message-0').getAttribute('aria-expanded')).toBe('true');
        expect(screen.getByTestId('message-turn-0').querySelector('article')?.textContent).toBe('Hello assistant');
    });

    it('renames the selected chat inline: clicking the title makes it contentEditable and blur commits', async () => {
        renderApp();
        await waitForModelSelection();
        // With nothing selected the title is plain non-editable text.
        expect(screen.getByTestId('chat-title').getAttribute('contenteditable')).toBeNull();
        await sendFirstTurn();

        // The selected chat's title sits in the header's top-left corner and IS
        // the click target — no pen, and NO DIALOG: the h1 itself becomes the
        // contentEditable inline editor (focused), seeded with the title.
        const titleView = screen.getByTestId('chat-title');
        expect(titleView.textContent).toBe('Hello assistant');
        expect(titleView.tagName).toBe('H1');
        expect(titleView.getAttribute('title')).toBe('Rename conversation');
        fireEvent.click(titleView);
        const titleEdit = screen.getByTestId('chat-title');
        expect(titleEdit.getAttribute('contenteditable')).toBe('true');
        expect(titleEdit.getAttribute('data-editing')).toBe('true');
        expect(document.activeElement).toBe(titleEdit);
        expect(titleEdit.textContent).toBe('Hello assistant');

        // Editing happens in place; blur (a click elsewhere) commits the
        // trimmed text. The history round-trips unchanged; only the explicit
        // title is new.
        titleEdit.textContent = 'My renamed chat';
        fireEvent.blur(titleEdit, { relatedTarget: null });
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
        // The title left edit mode and both header and sidebar follow the rename.
        await waitFor(() => expect(screen.getByTestId('chat-title').getAttribute('contenteditable')).toBeNull());
        expect(screen.getByTestId('chat-title').textContent).toBe('My renamed chat');
        expect(screen.getByTestId('chat-tab-conversation-1').textContent).toBe('My renamed chat2 messages · complete');
    });

    it('commits a rename on Enter (titles are single-line) and reverts on Escape or blank blur', async () => {
        renderApp();
        await waitForModelSelection();
        await sendFirstTurn();

        // Enter commits instead of inserting a line break: the keydown blurs
        // the editable h1 (default prevented), which commits through the PUT.
        fireEvent.click(screen.getByTestId('chat-title'));
        const titleEdit = screen.getByTestId('chat-title');
        titleEdit.textContent = 'Enter rename';
        expect(fireEvent.keyDown(titleEdit, { key: 'Enter' })).toBe(false);
        await waitFor(() => expect((fetch as any).mock.calls).toHaveLength(7));
        expect(JSON.parse((fetch as any).mock.calls[6][1].body as string)).toEqual({
            messages: [
                { role: 'user', content: 'Hello assistant' },
                { role: 'assistant', content: 'Hello from the assistant', model: ALT_MODEL }
            ],
            title: 'Enter rename'
        });
        await waitFor(() => expect(screen.getByTestId('chat-title').textContent).toBe('Enter rename'));

        // Escape discards: the keyed remount reverts the h1 to the persisted
        // title without any request.
        fireEvent.click(screen.getByTestId('chat-title'));
        screen.getByTestId('chat-title').textContent = 'Discarded rename';
        fireEvent.keyDown(screen.getByTestId('chat-title'), { key: 'Escape' });
        expect(screen.getByTestId('chat-title').getAttribute('contenteditable')).toBeNull();
        expect(screen.getByTestId('chat-title').textContent).toBe('Enter rename');
        expect((fetch as any).mock.calls).toHaveLength(7);

        // A BLANK blur refuses to persist (titles are required): the original
        // returns and no request runs.
        fireEvent.click(screen.getByTestId('chat-title'));
        screen.getByTestId('chat-title').textContent = '   ';
        fireEvent.blur(screen.getByTestId('chat-title'), { relatedTarget: null });
        expect(screen.getByTestId('chat-title').getAttribute('contenteditable')).toBeNull();
        expect(screen.getByTestId('chat-title').textContent).toBe('Enter rename');
        expect((fetch as any).mock.calls).toHaveLength(7);

        // An UNCHANGED blur needs no request either.
        fireEvent.click(screen.getByTestId('chat-title'));
        fireEvent.blur(screen.getByTestId('chat-title'), { relatedTarget: null });
        expect(screen.getByTestId('chat-title').getAttribute('contenteditable')).toBeNull();
        expect((fetch as any).mock.calls).toHaveLength(7);
    });

    it('submits the composer with Enter on desktop while Shift+Enter stays a newline', async () => {
        // jsdom implements no matchMedia, and the viewport gate treats a
        // missing API as the DESKTOP default — no stub needed here.
        renderApp();
        await waitForModelSelection();

        const input = screen.getByTestId('chat-input');
        fireEvent.change(input, { target: { value: 'Hello assistant' } });
        // Enter on desktop submits exactly like the send button: the default
        // newline is prevented (fireEvent returns false only when the event
        // was defaultPrevented) and the full six-call send flow runs.
        expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false);
        await waitFor(() => expect(screen.getByTestId('chat-tab-conversation-1')).toBeDefined());
        expect((fetch as any).mock.calls).toHaveLength(6);
        expect(JSON.parse((fetch as any).mock.calls[2][1].body as string)).toEqual({
            model: DEFAULT_MODEL,
            stream: true,
            messages: [{ role: 'user', content: 'Hello assistant' }]
        });

        // Shift+Enter is the desktop newline escape hatch: the keydown is NOT
        // prevented and no request fires.
        expect(fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })).toBe(true);
        expect((fetch as any).mock.calls).toHaveLength(6);
    });

    it('keeps Enter as a newline-only key on mobile viewports', async () => {
        // jsdom has no matchMedia: stub a below-md (mobile) result so the
        // viewport gate takes its mobile branch.
        vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query }));
        renderApp();
        await waitForModelSelection();

        const input = screen.getByTestId('chat-input');
        fireEvent.change(input, { target: { value: 'Hello assistant' } });
        // Enter keeps the textarea's default (a newline): the keydown is NOT
        // prevented and no completion request fires — mobile submission stays
        // on the split send button.
        expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(true);
        expect((fetch as any).mock.calls).toHaveLength(2);

        // The send button remains the mobile submission path.
        fireEvent.click(screen.getByTestId('send-chat-button'));
        await waitFor(() => expect(screen.getByTestId('chat-tab-conversation-1')).toBeDefined());
        expect((fetch as any).mock.calls).toHaveLength(6);
    });

    it('collapses every turn except the latest assistant reply by default on chat selection', async () => {
        // A four-turn record from a previous session: two user queries and
        // two replies, so BOTH folding rules are exercised at once.
        const restored = {
            ...conversation,
            messageCount: 4,
            createdAt: '2026-08-06T00:00:03.000Z',
            updatedAt: '2026-08-06T00:00:04.000Z',
            messages: [
                { role: 'user' as const, content: 'First question' },
                { role: 'assistant' as const, content: 'First answer', model: ALT_MODEL },
                { role: 'user' as const, content: 'Second question' },
                { role: 'assistant' as const, content: 'Second answer', model: ALT_MODEL }
            ]
        };
        vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
            if (url.endsWith('/models')) return Promise.resolve(response(200, catalog));
            if (init?.method === 'GET' && url.endsWith('/conversation')) {
                return Promise.resolve(response(200, {
                    conversations: [{
                        conversationId: restored.conversationId,
                        title: restored.title,
                        model: restored.model,
                        status: restored.status,
                        messageCount: restored.messageCount,
                        createdAt: restored.createdAt,
                        updatedAt: restored.updatedAt
                    }]
                }));
            }
            if (init?.method === 'GET') {
                return Promise.resolve(response(200, { conversationId: restored.conversationId, conversation: restored }));
            }
            return Promise.resolve(response(404, { error: 'unexpected request' }));
        }));
        renderApp();
        await waitForModelSelection();
        fireEvent.click(await screen.findByTestId('chat-tab-conversation-1'));
        await waitFor(() => expect(screen.getByTestId('collapse-message-3')).toBeDefined());

        // Exact default state: turns 0-2 fold (BOTH user turns AND the older
        // assistant reply), each down to its first-line preview with bubbles
        // and controls hidden.
        expect(screen.getByTestId('collapse-message-0').getAttribute('aria-expanded')).toBe('false');
        expect(screen.getByTestId('collapse-message-1').getAttribute('aria-expanded')).toBe('false');
        expect(screen.getByTestId('collapse-message-2').getAttribute('aria-expanded')).toBe('false');
        expect(screen.getByTestId('message-preview-0').textContent).toBe('First question');
        expect(screen.getByTestId('message-preview-1').textContent).toBe('First answer');
        expect(screen.getByTestId('message-preview-2').textContent).toBe('Second question');
        expect(screen.getByTestId('message-turn-0').querySelector('article')).toBeNull();
        expect(screen.getByTestId('message-turn-1').querySelector('article')).toBeNull();
        expect(screen.getByTestId('message-turn-2').querySelector('article')).toBeNull();
        // Only the LATEST assistant reply renders expanded, with its controls.
        expect(screen.getByTestId('collapse-message-3').getAttribute('aria-expanded')).toBe('true');
        expect(screen.queryByTestId('message-preview-3')).toBeNull();
        expect(screen.getByTestId('message-turn-3').querySelector('article')?.textContent).toBe('Second answer');
        expect(screen.getByTestId('edit-message-3')).toBeDefined();
        expect(screen.getByTestId('message-model-3').textContent).toBe('zeta-model');
    });

    it('auto-scrolls the message list to the bottom on typing, on send, and while the reply streams', async () => {
        // Controlled-stream variant of the default routes so intermediate
        // scroll positions between frames can be asserted.
        const stream = controlledStream();
        vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
            if (url.endsWith('/models')) return Promise.resolve(response(200, catalog));
            if (url.endsWith('/chat/completions')) return Promise.resolve(stream.response());
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

        const list = screen.getByTestId('message-list');
        // jsdom's scrollHeight is 0: stub it per phase so each auto-scroll
        // effect pins scrollTop to an exact, distinguishable bottom.
        // Typing in the composer (which grows the field and squeezes the list)
        // already follows the list's bottom.
        Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1200 });
        fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Hello assistant' } });
        await waitFor(() => expect(list.scrollTop).toBe(1200));

        // Sending raises the pending user bubble + streaming surface; every
        // streamed token re-scrolls to the (growing) bottom.
        fireEvent.click(screen.getByTestId('send-chat-button'));
        await waitFor(() => expect(screen.getByTestId('pending-user-message')).toBeDefined());
        Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 2400 });
        await act(async () => stream.push(completionFrames[0]));
        await waitFor(() => expect(list.scrollTop).toBe(2400));
        Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 3600 });
        await act(async () => stream.push(completionFrames[1]));
        await waitFor(() => expect(list.scrollTop).toBe(3600));

        // Completion loads the canonical record: the follow still pins the bottom.
        await act(async () => {
            stream.push(completionFrames[2]);
            stream.push(completionFrames[3]);
            stream.close();
        });
        await waitFor(() => expect(screen.getByTestId('chat-tab-conversation-1')).toBeDefined());
        expect(list.scrollTop).toBe(3600);

        // Auto-scrolling is pure view state: only the six send-flow calls ran.
        expect((fetch as any).mock.calls).toHaveLength(6);
    });

    it('locks the app frame to the viewport: pinned header, scrolling message list, pinned composer', async () => {
        renderApp();
        await waitForModelSelection();

        // The app frame is a viewport-locked flex column: it fills the root
        // height exactly and never produces a window scrollbar itself.
        const page = screen.getByTestId('chat-assistant');
        const pageStyle = window.getComputedStyle(page);
        expect(pageStyle.height).toBe('100%');
        expect(pageStyle.display).toBe('flex');
        expect(pageStyle.flexDirection).toBe('column');
        expect(pageStyle.overflow).toBe('hidden');

        // The header is pinned to the frame's top edge: it cannot shrink away
        // (and the page itself never scrolls, so it stays stuck on top).
        expect(window.getComputedStyle(page.querySelector('header')!).flexShrink).toBe('0');

        // The ONLY scrolling surface in the middle is the message list — the
        // composer sits OUTSIDE it as a sibling and cannot shrink, so the
        // message area stays pinned to the bottom edge.
        const list = screen.getByTestId('message-list');
        expect(window.getComputedStyle(list).overflowY).toBe('auto');
        expect(list.contains(screen.getByTestId('chat-composer'))).toBe(false);
        expect(window.getComputedStyle(screen.getByTestId('chat-composer')).flexShrink).toBe('0');

        // Sending fills the list far beyond the viewport: the composer remains
        // outside the scroll region and the frame still refuses to scroll.
        await sendFirstTurn();
        expect(list.contains(screen.getByTestId('chat-composer'))).toBe(false);
        expect(window.getComputedStyle(page).overflow).toBe('hidden');
    });

    it('commits a blur rename without resurrecting the old title when the surface moved on mid-save', async () => {
        renderApp();
        await waitForModelSelection();
        await sendFirstTurn();

        // Same race shape as message editing: the click that blurs the editable
        // title into "New chat" still COMMITS the rename (identified PUT runs,
        // sidebar follows), but the returning record must not push the old
        // chat back onto the fresh empty surface.
        fireEvent.click(screen.getByTestId('chat-title'));
        const titleEdit = screen.getByTestId('chat-title');
        expect(titleEdit.getAttribute('contenteditable')).toBe('true');
        titleEdit.textContent = 'Switched-away rename';
        fireEvent.blur(titleEdit, { relatedTarget: screen.getByTestId('new-chat-button') });
        fireEvent.click(screen.getByTestId('new-chat-button'));

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
                    title: 'Switched-away rename'
                })
            }
        ]);
        await waitFor(() => expect(screen.getByTestId('chat-tab-conversation-1').textContent).toBe('Switched-away rename2 messages · complete'));
        // The surface itself moved on: the header title falls back to the
        // product name and is NOT editable with nothing selected.
        expect(screen.getByTestId('chat-title').textContent).toBe('Chat Assistant');
        expect(screen.getByTestId('chat-title').getAttribute('contenteditable')).toBeNull();
        expect(screen.getByTestId('empty-chat-state')).toBeDefined();
    });
});
