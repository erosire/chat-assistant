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
// WORDS turns the bubble ITSELF into a contentEditable inline HTML editor,
// which SAVES AUTOMATICALLY
// ON BLUR (blank/unchanged text closes without a request) and cancels on
// ESCAPE (a keyed bubble remount reverts the mutated DOM); the x
// delete control in the row above the bubble (right-aligned) — edits and
// deletes both rewrite the
// history through the identified PUT, so the next turn sends the
// edited/shortened history upstream.
// Every turn also carries a copy action that writes the raw
// message text to the system clipboard (a pure client-side action: no storage).
// Every chat is led by a system prompt row: while the record has no system
// message the DRAFT form shows (even empty) as a regular LEFT-aligned turn —
// top-left "system" label (plain span: nothing to fold), the literal
// placeholder "no prompt" in the bubble, and clicking its words opens the
// same inline editor every turn uses (no copy without text); a saved
// non-empty draft replaces the placeholder and is persisted immediately as the
// leading system message (creating a prompt-only conversation when needed); system
// turns then render like any turn (same bubble styling as user/assistant,
// click-to-edit + copy) EXCEPT they cannot be deleted.
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
// button is a circular ">" arrow EMBEDDED in the input at its right edge,
// vertically centered in the box — rendered ONLY while the composer has focus
// (focus-within, including the arrow and the model select). The input's Scroll JUMPS are SECTION-LOCAL: every user/assistant/system
// turn's own controls panel (the strip under its bubble — transient
// pending/streaming turns have none) carries an up/down chevron pair at its
// left edge: "^" fast-animates the list (fixed 200ms ease-out) until THAT
// section's top edge docks on the list's top padding line, "v" until THAT
// section's bottom edge lands on the bottom padding line — re-measured live
// at arrival so mid-flight reflows can't strand the landing. The
// bottom-follow DETACHES while the user reads away from the bottom: stream
// chunks and same-surface record refreshes (stream completion swap
// included) never re-pin off-bottom — while typing, sends, explicit chat
// picks, and surface resets still pin unconditionally, and the token follow
// resumes once the user returns to the bottom.
// All control icons render as stroke SVGs from src/icons — the old unicode
// text glyphs are retired. The rename dialog's actions
// stack full-width on mobile and sit in a right-aligned row on desktop.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ConversationRecord } from '../api';
import { ChatAssistantApp, controlsShouldFloat } from './ChatAssistantApp';

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
    updatedAt: '2026-08-06T00:00:01.000Z',
    // The composer displays the latest persisted provider total for the open
    // record, so the fixture includes a deterministic usage value for selection.
    usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 }
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
    {
        // Keep the mocked identified record in sync with prompt saves so a
        // blur-created prompt is represented by the same leading system message
        // that the real storage endpoint returns on its follow-up GET.
        // Null means the fixture's ordinary completed-send response is still
        // authoritative; a non-null value is reserved for prompt persistence
        // flows whose returned history must include the new system turn.
        let storedMessages: ChatMessage[] | null = null;
        // The real identified POST accumulates usage across completed turns;
        // keeping the mock's canonical record stateful verifies the composer shows
        // a growing conversation total instead of only the latest response.
        let storedUsage: ConversationRecord['usage'] | undefined;
        return vi.fn((url: string, init?: RequestInit) => {
        if (url.endsWith('/models')) return Promise.resolve(response(200, catalog));
        if (url.endsWith('/chat/completions')) return Promise.resolve(sseResponse(completionFrames));
        // The collection GET check must precede the generic identified GET branch.
        if (init?.method === 'GET' && url.endsWith('/conversation')) {
            return Promise.resolve(response(200, { conversations: [] }));
        }
        if (init?.method === 'POST' && url.endsWith('/conversation')) {
            const body = JSON.parse(String(init.body)) as { messages?: ChatMessage[]; systemPrompt?: string };
            storedMessages = body.systemPrompt
                ? [{ role: 'system' as const, content: body.systemPrompt }, ...(body.messages ?? [])]
                : null;
            return Promise.resolve(response(201, { conversationId: conversation.conversationId }));
        }
        if (init?.method === 'POST') {
            const body = JSON.parse(String(init.body)) as {
                messages?: ChatMessage[];
                usage?: ConversationRecord['usage'];
            };
            if (storedMessages !== null) storedMessages = [...storedMessages, ...(body.messages ?? [])];
            if (body.usage) {
                storedUsage = {
                    prompt_tokens: (storedUsage?.prompt_tokens ?? 0) + (body.usage.prompt_tokens ?? 0),
                    completion_tokens: (storedUsage?.completion_tokens ?? 0) + (body.usage.completion_tokens ?? 0),
                    total_tokens: (storedUsage?.total_tokens ?? 0) + (body.usage.total_tokens ?? 0)
                };
            }
            return Promise.resolve(response(200, { conversationId: conversation.conversationId }));
        }
        if (init?.method === 'PUT') {
            const body = JSON.parse(String(init.body)) as { messages: ChatMessage[]; title?: string };
            if (body.messages.some((message) => message.role === 'system')) storedMessages = [...body.messages];
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
            const persisted = storedMessages !== null
                ? { ...conversation, messages: storedMessages, messageCount: storedMessages.length }
                : conversation;
            return Promise.resolve(response(200, {
                conversationId: conversation.conversationId,
                conversation: storedUsage === undefined ? persisted : { ...persisted, usage: storedUsage }
            }));
        }
        return Promise.resolve(response(404, { error: 'unexpected request' }));
        });
    };

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
    // restoreAllMocks additionally covers the geometry-spying sticky-gate
    // test (a leaked getBoundingClientRect mock would poison every later test).
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

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
        // A fresh conversation has not received provider usage yet, so the
        // top-right composer indicator is explicit rather than blank.
        expect(screen.getByTestId('token-usage').textContent).toBe('Total tokens: 0');

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

    it('uses compact horizontal gutters on mobile and preserves desktop spacing', async () => {
        renderApp();
        await waitForModelSelection();

        // Responsive values are emitted in the Emotion sheet because jsdom does
        // not lay out viewport media queries reliably. The xs declarations keep
        // the message list, empty state, composer, and drawer aligned at 12px
        // while md restores the desktop spacing. ErrorBanner uses the same
        // values when an error is rendered, but is absent on this mount.
        const css = Array.from(document.querySelectorAll('style[data-emotion]'))
            .map((tag) => tag.textContent)
            .join('\n');
        expect(css).toMatch(/@media \(min-width: 0px\)\{\.css-[^{]+\{[^}]*padding-left:12px;[^}]*padding-right:12px;[^}]*\}\}/);
        expect(css).toMatch(/\.css-[^{]+\{[^}]*padding:24px;[^}]*\}/);
        expect(css).toMatch(/\.css-[^{]+\{[^}]*padding:16px;[^}]*\}/);
        expect(css).toMatch(/@media \(min-width: 900px\)\{\.css-[^{]+\{[^}]*padding-left:24px;[^}]*padding-right:24px;[^}]*\}\}/);
        expect(css).toContain('scrollbar-width:none');
        // Desktop receives the same hidden scrollbar chrome, so it cannot
        // reintroduce the right-side gutter at the md breakpoint.
        expect(css.match(/scrollbar-width:none/g)?.length).toBe(2);
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
        // The open sidebar item exposes both the semantic pressed state and the
        // visible active class styling; the token total comes from the selected
        // record rather than its compact summary.
        expect(tab.getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByTestId('token-usage').textContent).toBe('Total tokens: 9');
        const css = Array.from(document.querySelectorAll('style[data-emotion]'))
            .map((tag) => tag.textContent)
            .join('\n');
        expect(css).toMatch(/@media \(min-width: 0px\)\{\.css-[^{]+\{[^}]*background-color:#273d72;[^}]*border-color:#5f82f0;[^}]*box-shadow:0 0 0 1px #5f82f0;[^}]*\}\}/);
        expect((fetch as any).mock.calls[2]).toEqual([`${BASE_URL}/conversation-1`, { method: 'GET' }]);
    });

    it('forks at an expanded user interval, copies the complete prefix, and selects the new conversation', async () => {
        const forkMessages = [conversation.messages[0]];
        const forkConversation = {
            ...conversation,
            conversationId: 'conversation-fork',
            title: 'Hello assistant',
            messageCount: 1,
            messages: forkMessages,
            createdAt: '2026-08-06T00:00:02.000Z',
            updatedAt: '2026-08-06T00:00:02.000Z'
        };
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
            if (init?.method === 'POST' && url.endsWith('/conversation')) {
                expect(JSON.parse(String(init.body))).toEqual({
                    messages: forkMessages,
                    model: ALT_MODEL
                });
                return Promise.resolve(response(201, { conversationId: forkConversation.conversationId }));
            }
            if (init?.method === 'GET' && url.endsWith('/conversation/conversation-1')) {
                return Promise.resolve(response(200, { conversationId: conversation.conversationId, conversation }));
            }
            if (init?.method === 'GET' && url.endsWith('/conversation/conversation-fork')) {
                return Promise.resolve(response(200, { conversationId: forkConversation.conversationId, conversation: forkConversation }));
            }
            return Promise.resolve(response(404, { error: 'unexpected request' }));
        }));
        renderApp();
        await waitForModelSelection();
        fireEvent.click(await screen.findByTestId('chat-tab-conversation-1'));
        await waitFor(() => expect(screen.getByTestId('collapse-message-0')).toBeDefined());

        // Fork belongs beside copy in the trailing controls, so a collapsed
        // interval intentionally has no fork action until its content expands.
        expect(screen.getByTestId('collapse-message-0').getAttribute('aria-expanded')).toBe('false');
        expect(screen.queryByTestId('fork-message-0')).toBeNull();
        fireEvent.click(screen.getByTestId('collapse-message-0'));
        expect(screen.getByTestId('fork-message-0').querySelector('svg[data-icon="fork"]')).not.toBeNull();
        expect(screen.getByTestId('copy-message-0').parentElement).toBe(screen.getByTestId('fork-message-0').parentElement);
        fireEvent.click(screen.getByTestId('fork-message-0'));

        await waitFor(() => expect(screen.getByTestId('chat-tab-conversation-fork')).toBeDefined());
        expect(screen.getByTestId('chat-title').textContent).toBe('Hello assistant');
        expect(screen.getByTestId('message-preview-0').textContent).toBe('Hello assistant');
        expect(screen.queryByTestId('message-model-1')).toBeNull();
        expect((screen.getByTestId('model-select') as HTMLSelectElement).value).toBe(ALT_MODEL);
        expect((fetch as any).mock.calls).toEqual([
            [`${PROVIDER_URL}/models`, { method: 'GET' }],
            [BASE_URL, { method: 'GET' }],
            [`${BASE_URL}/conversation-1`, { method: 'GET' }],
            [BASE_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: forkMessages, model: ALT_MODEL })
            }],
            [`${BASE_URL}/conversation-fork`, { method: 'GET' }]
        ]);
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

        // The send button carries no model name anymore: it is the right
        // chevron (the authored ">" identity drawn as an SVG icon).
        expect(screen.getByTestId('send-chat-button').querySelector('svg[data-icon="chevron-right"]')).not.toBeNull();
        expect(screen.getByTestId('send-chat-button').textContent).toBe('');
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

        // The arrow: a 32px circle pinned absolute to the field's right edge,
        // vertically CENTERED in the box (top:50% + translateY(-50%) — it must
        // stay centered as the input grows from one row to its eight-row cap,
        // the retired bottom:8px pin read as stuck to the box's rim);
        // border-radius:50% identifies the rule uniquely.
        const arrowRule = /\.css-[^{]+\{[^}]*border-radius:50%;[^}]*\}/.exec(css)?.[0];
        expect(arrowRule).toBeDefined();
        expect(arrowRule).toContain('position:absolute');
        expect(arrowRule).toContain('right:8px');
        expect(arrowRule).toContain('top:50%');
        expect(arrowRule).toContain('transform:translateY(-50%)');
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

    it('keeps the send arrow hidden until the composer has focus, then shows it inside the input at the right edge, vertically centered', async () => {
        renderApp();
        // Catalog + history resolve regardless of focus (the mount effects).
        await waitFor(() => expect((fetch as any).mock.calls).toHaveLength(2));

        // The model selection text above the input is ALWAYS there (with its
        // overlay select); the send arrow is NOT.
        expect(screen.getByTestId('model-picker')).toBeDefined();
        expect(screen.getByTestId('model-select')).toBeDefined();
        expect(screen.queryByTestId('send-chat-button')).toBeNull();

        // Focus: the arrow appears INSIDE the field, docked at the field's
        // right edge and vertically centered: the field is the positioning
        // context, the arrow absolute at right + top:50% with the centering
        // transform.
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
        expect(arrowStyle.top).toBe('50%');
        // jsdom (cssstyle) returns the specified transform verbatim, the same
        // way the viewport-lock test above asserts the page's '100%' height.
        expect(arrowStyle.transform).toBe('translateY(-50%)');

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
                        stream_options: { include_usage: true },
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

    it('keeps existing turn icons mounted and interactive while a reply is generating', async () => {
        // A controlled stream leaves the persisted user and assistant turns in
        // place while the transient pending/streaming pair is rendered, which
        // reproduces the generation phase where icon controls used to vanish.
        const stream = controlledStream();
        let completionCount = 0;
        vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
            if (url.endsWith('/models')) return Promise.resolve(response(200, catalog));
            if (url.endsWith('/chat/completions')) {
                // Finish the setup turn immediately, then hold the second turn
                // open so the test can inspect controls during generation.
                return Promise.resolve(completionCount++ === 0 ? sseResponse(completionFrames) : stream.response());
            }
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
        await sendFirstTurn();

        // Expand the collapsed user turn so both persisted turns expose their
        // complete control rows before generation begins.
        fireEvent.click(screen.getByTestId('collapse-message-0'));
        expect(screen.getByTestId('copy-message-0').querySelector('svg[data-icon="copy"]')).not.toBeNull();
        expect(screen.getByTestId('copy-message-1').querySelector('svg[data-icon="copy"]')).not.toBeNull();
        expect(screen.getByTestId('delete-message-0').querySelector('svg[data-icon="close"]')).not.toBeNull();
        expect(screen.getByTestId('delete-message-1').querySelector('svg[data-icon="close"]')).not.toBeNull();

        // Starting a second turn must retain every existing SVG and keep every
        // existing control interactive; the transient rows still intentionally
        // carry no controls until persistence creates their canonical turns.
        fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Follow up question' } });
        fireEvent.click(screen.getByTestId('send-chat-button'));
        await waitFor(() => expect(screen.getByTestId('pending-user-message')).toBeDefined());
        // The composer and sidebar remain ordinary interactive controls while
        // the provider request is pending; loading is an async status signal,
        // never a blanket disabled/greyed presentation state.
        expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).disabled).toBe(false);
        expect((screen.getByTestId('model-select') as HTMLSelectElement).disabled).toBe(false);
        // The send icon remains a normal button even after submit clears the
        // draft; submit() validates the empty draft and active request instead
        // of presenting a disabled/greyed control during provider streaming.
        expect((screen.getByTestId('send-chat-button') as HTMLButtonElement).disabled).toBe(false);
        expect((screen.getByTestId('delete-chat-conversation-1') as HTMLButtonElement).disabled).toBe(false);
        for (const testid of ['copy-message-0', 'copy-message-1', 'delete-message-0', 'delete-message-1', 'switch-message-0', 'switch-message-1', 'turn-jump-top-0', 'turn-jump-bottom-0', 'turn-jump-top-1', 'turn-jump-bottom-1']) {
            const control = screen.getByTestId(testid) as HTMLButtonElement;
            expect(control.disabled).toBe(false);
            expect(control.querySelector('svg')).not.toBeNull();
        }

        // No storage mutation occurs until the stream is complete; this proves
        // the request remains asynchronous while the existing controls remain
        // usable during every waiting/streaming phase.
        expect((fetch as any).mock.calls).toHaveLength(7);
        await act(async () => {
            stream.push(completionFrames[0]);
            stream.push(completionFrames[1]);
            stream.push(completionFrames[2]);
            stream.push(completionFrames[3]);
            stream.close();
        });
        await waitFor(() => expect((fetch as any).mock.calls).toHaveLength(9));
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
        // Each fixture completion reports nine tokens; the conversation indicator
        // accumulates both completed turns rather than replacing the first total.
        expect(screen.getByTestId('token-usage').textContent).toBe('Total tokens: 18');
        // The second streamed provider request carries the full 3-message history under the new model.
        expect((fetch as any).mock.calls[6]).toEqual([
            `${PROVIDER_URL}/chat/completions`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: ALT_MODEL,
                        stream: true,
                        stream_options: { include_usage: true },
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
                        stream_options: { include_usage: true },
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
        // The control renders the shared CloseIcon SVG (the old plain-text
        // multiplication cross was retired with the src/icons family).
        expect(remove.querySelector('svg[data-icon="close"]')).not.toBeNull();

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
        // bubble (hidden while collapsed) can be clicked into the editor.
        fireEvent.click(screen.getByTestId('collapse-message-0'));
        expect(screen.getByTestId('collapse-message-0').getAttribute('aria-expanded')).toBe('true');

        // Clicking the WORDS turns the BUBBLE ITSELF into the inline HTML
        // editor — no textarea, no input field: the same testid now marks a
        // contentEditable article seeded with the current message text. NO
        // chrome disappears: the copy actions STAY RENDERED but natively
        // disabled while the edit runs (one edit at a time).
        fireEvent.click(screen.getByTestId('message-content-0'));
        const bubble = screen.getByTestId('message-content-0');
        expect(bubble.tagName).toBe('ARTICLE');
        expect(bubble.getAttribute('contenteditable')).toBe('true');
        expect(bubble.getAttribute('role')).toBe('textbox');
        expect(bubble.textContent).toBe('Hello assistant');
        expect((screen.getByTestId('copy-message-0') as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByTestId('copy-message-1') as HTMLButtonElement).disabled).toBe(true);

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
                    stream_options: { include_usage: true },
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
        // editor by clicking its words, type, then press ESCAPE: the keyed
        // bubble remount reverts the DOM text and no request runs.
        fireEvent.click(screen.getByTestId('message-content-1'));
        const bubble = screen.getByTestId('message-content-1');
        expect(bubble.getAttribute('contenteditable')).toBe('true');
        bubble.textContent = 'Discarded rewrite';
        fireEvent.keyDown(bubble, { key: 'Escape' });
        expect(screen.getByTestId('message-content-1').getAttribute('contenteditable')).toBeNull();
        expect(screen.getByTestId('message-content-1').textContent).toBe('Hello from the assistant');
        expect((fetch as any).mock.calls).toHaveLength(6);

        // A rewritten bubble committed on blur replaces the history while
        // keeping the attribution.
        fireEvent.click(screen.getByTestId('message-content-1'));
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

    it('keeps the producing-model label and every icon rendered — greyed out + disabled — while a turn is edited', async () => {
        renderApp();
        await waitForModelSelection();
        await sendFirstTurn();

        // Expand the collapsed USER turn first so BOTH turns expose their full
        // chrome (copy action, delete cross, label toggle) before the edit
        // opens.
        fireEvent.click(screen.getByTestId('collapse-message-0'));

        // Reader for an element's DYNAMIC declarations, which styledComponent
        // serializes under @media (min-width: 0px) — the greyed styling
        // (opacity + cursor) is dynamic, so it lives in each button's own
        // Emotion class there (same sheet-reading technique the collapse
        // stacking test uses).
        const cssText = () => Array.from(document.querySelectorAll('style[data-emotion]'))
            .map((tag) => tag.textContent)
            .join('\n');
        const mediaStyle = (testid: string, property: string): string | null => {
            const cls = screen.getByTestId(testid).className;
            return new RegExp(`@media \\(min-width: 0px\\)\\{\\.${cls}\\{[^}]*${property}:([^;]+);[^}]*\\}\\}`).exec(cssText())?.[1] ?? null;
        };

        // Idle baseline: all controls enabled, full opacity, pointer cursor.
        expect((screen.getByTestId('copy-message-1') as HTMLButtonElement).disabled).toBe(false);
        expect((screen.getByTestId('collapse-message-1') as HTMLButtonElement).disabled).toBe(false);
        expect(mediaStyle('copy-message-1', 'opacity')).toBe('1');
        expect(mediaStyle('copy-message-1', 'cursor')).toBe('pointer');

        // Open the assistant turn's inline editor by clicking its words.
        fireEvent.click(screen.getByTestId('message-content-1'));
        expect(screen.getByTestId('message-content-1').getAttribute('contenteditable')).toBe('true');

        // THE MODEL NAME STAYS: the producing model's attribution label is
        // still rendered in the edited turn's top-left corner.
        expect(screen.getByTestId('message-model-1').textContent).toBe('zeta-model');
        // The user turn's speaker label stays too.
        expect(screen.getByTestId('message-label-0').textContent).toBe('user');

        // The EDITED turn's collapse toggle stays rendered but greyed out +
        // disabled (folding must not unmount the live editor)...
        const editedToggle = screen.getByTestId('collapse-message-1') as HTMLButtonElement;
        expect(editedToggle.disabled).toBe(true);
        expect(mediaStyle('collapse-message-1', 'opacity')).toBe('0.4');
        expect(mediaStyle('collapse-message-1', 'cursor')).toBe('default');
        // ...while the OTHER turn's toggle keeps working (it cannot disturb
        // the edit): enabled, full opacity, pointer cursor.
        const otherToggle = screen.getByTestId('collapse-message-0') as HTMLButtonElement;
        expect(otherToggle.disabled).toBe(false);
        expect(mediaStyle('collapse-message-0', 'opacity')).toBe('1');
        expect(mediaStyle('collapse-message-0', 'cursor')).toBe('pointer');

        // THE OTHER ICONS STAY, GREYED OUT + DISABLED: the edited turn's own
        // copy action and delete cross... disabled... greyed out
        const editedControls = ['copy-message-1', 'delete-message-1'];
        editedControls.forEach((testid) => {
            expect((screen.getByTestId(testid) as HTMLButtonElement).disabled).toBe(true);
            expect(mediaStyle(testid, 'opacity')).toBe('0.4');
            expect(mediaStyle(testid, 'cursor')).toBe('default');
        });
        // ...and equally the OTHER turn's (one edit at a time).
        const otherControls = ['copy-message-0', 'delete-message-0'];
        otherControls.forEach((testid) => {
            expect((screen.getByTestId(testid) as HTMLButtonElement).disabled).toBe(true);
            expect(mediaStyle(testid, 'opacity')).toBe('0.4');
            expect(mediaStyle(testid, 'cursor')).toBe('default');
        });

        // Escape abandons the edit: every control returns to its enabled,
        // full-opacity, pointer state and the label/toggles stay in place.
        fireEvent.keyDown(screen.getByTestId('message-content-1'), { key: 'Escape' });
        expect(screen.getByTestId('message-model-1').textContent).toBe('zeta-model');
        ['collapse-message-0', 'collapse-message-1', ...editedControls, ...otherControls].forEach((testid) => {
            expect((screen.getByTestId(testid) as HTMLButtonElement).disabled).toBe(false);
            expect(mediaStyle(testid, 'opacity')).toBe('1');
            expect(mediaStyle(testid, 'cursor')).toBe('pointer');
        });
        // Pure view state throughout: still only the 6 send-flow requests ran.
        expect((fetch as any).mock.calls).toHaveLength(6);
    });

    it('performs no request when the bubble is blurred without any change', async () => {
        renderApp();
        await waitForModelSelection();
        await sendFirstTurn();

        // The user turn starts collapsed; expand it and click its bubble's
        // words into the editor.
        fireEvent.click(screen.getByTestId('collapse-message-0'));
        fireEvent.click(screen.getByTestId('message-content-0'));
        const bubble = screen.getByTestId('message-content-0');
        expect(bubble.getAttribute('contenteditable')).toBe('true');

        // Blur with the text UNTOUCHED: the editor closes but an identical
        // history never hits the wire.
        fireEvent.blur(bubble, { relatedTarget: null });
        expect(screen.getByTestId('message-content-0').getAttribute('contenteditable')).toBeNull();
        expect(screen.getByTestId('message-content-0').textContent).toBe('Hello assistant');
        expect((fetch as any).mock.calls).toHaveLength(6);

        // Whitespace-only text is equally not a save.
        fireEvent.click(screen.getByTestId('message-content-0'));
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
        // editor (contentEditable + focused).
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

    it('places the caret at the text END when the click point cannot be resolved', async () => {
        renderApp();
        await waitForModelSelection();
        await sendFirstTurn();

        // jsdom implements no caretRangeFromPoint, so the word click carries
        // no usable coordinates: the caret lands at the end of the message
        // ("Hello from the assistant" is 24 characters), ready to append —
        // never stranded at the text start.
        fireEvent.click(screen.getByTestId('message-content-1'));
        const bubble = screen.getByTestId('message-content-1');
        expect(bubble.getAttribute('contenteditable')).toBe('true');
        const selection = window.getSelection();
        expect(selection?.focusNode?.textContent).toBe('Hello from the assistant');
        expect(selection?.focusOffset).toBe(24);
        fireEvent.keyDown(bubble, { key: 'Escape' });
    });

    it('focuses the inline editor with preventScroll so starting an edit never jumps the list', async () => {
        renderApp();
        await waitForModelSelection();
        await sendFirstTurn();

        // Spy BEFORE the click so the editable REMOUNT's programmatic focus is
        // captured (callThrough keeps jsdom's own focus semantics — activeElement
        // still advances). The editing auto-focus effect is the component's ONLY
        // focus() caller, and the auto-pin effect never runs on edit-flag
        // changes, so the list's scroll offset must survive the edit start.
        // 87 stands in for a long chat's deep scroll position (jsdom never
        // scrolls by itself; the pin effect wrote scrollTop = scrollHeight = 0
        // while the first turn persisted).
        const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');
        const list = screen.getByTestId('message-list');
        list.scrollTop = 87;

        // Word-click edit start on the expanded assistant turn: exactly ONE
        // focus runs (the remounted bubble's) and it MUST carry
        // preventScroll:true — the option that stops the browser from
        // scrolling the provisional offset-0 caret (the bubble's top edge)
        // into view. Without it a long chat snapped the list UP to the message
        // top while the real caret sat at the clicked word — the regression
        // this test locks out.
        fireEvent.click(screen.getByTestId('message-content-1'));
        expect(focusSpy.mock.calls).toEqual([[{ preventScroll: true }]]);
        expect(document.activeElement).toBe(screen.getByTestId('message-content-1'));
        // Caret behavior is unchanged: jsdom has no caretRangeFromPoint, so the
        // null-offset fallback lands at the END of the 24-character text.
        expect(window.getSelection()?.focusOffset).toBe(24);
        expect(list.scrollTop).toBe(87);

        // Re-clicking routes through the SAME effect after Escape closes the
        // first edit (Escape itself focuses nothing): same single preventScroll
        // focus, caret at the end, scroll untouched.
        fireEvent.keyDown(screen.getByTestId('message-content-1'), { key: 'Escape' });
        expect(focusSpy.mock.calls).toEqual([[{ preventScroll: true }]]);
        fireEvent.click(screen.getByTestId('message-content-1'));
        expect(focusSpy.mock.calls).toEqual([[{ preventScroll: true }], [{ preventScroll: true }]]);
        expect(window.getSelection()?.focusOffset).toBe(24);
        expect(list.scrollTop).toBe(87);
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

    it('opens the system prompt editor and persists a new prompt immediately on blur', async () => {
        renderApp();
        await waitForModelSelection();

        // The "no prompt" placeholder bubble itself is the click target.
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

        // No copy action yet: there is still no saved draft text.
        expect(screen.queryByTestId('copy-system-prompt')).toBeNull();

        // Blurring a non-empty prompt persists a prompt-only conversation before
        // the first user turn, so leaving the page cannot lose the edit.
        bubble.textContent = 'You are terse.';
        fireEvent.blur(bubble, { relatedTarget: null });
        await waitFor(() => expect((fetch as any).mock.calls).toHaveLength(4));
        expect((fetch as any).mock.calls[2]).toEqual([
            BASE_URL,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: DEFAULT_MODEL, systemPrompt: 'You are terse.' })
            }
        ]);
        expect((fetch as any).mock.calls[3]).toEqual([`${BASE_URL}/conversation-1`, { method: 'GET' }]);
        // The canonical record replaces the draft row with a persisted system
        // turn, whose collapsed preview proves the saved content is still present.
        expect(screen.queryByTestId('system-prompt-value')).toBeNull();
        expect(screen.getByTestId('message-preview-0').textContent).toBe('You are terse.');
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

    it('copies any message to the clipboard through the turn copy action', async () => {
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

        // EVERY expanded turn carries its copy control on the row under the
        // bubble.
        const copyUser = screen.getByTestId('copy-message-0');
        const copyAssistant = screen.getByTestId('copy-message-1');

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

    it('bottom-sticks the copy controls row so it follows the scroll until its turn end is in view', async () => {
        renderApp();
        await waitForModelSelection();
        await sendFirstTurn();

        // The layout contract lives in Emotion's injected stylesheet: jsdom
        // cannot evaluate sticky positioning, so the sheet is read directly
        // (same technique as the send-arrow and sidebar z-index tests).
        const css = Array.from(document.querySelectorAll('style[data-emotion]'))
            .map((tag) => tag.textContent)
            .join('\n');
        // The SHARED strip rule (identified by the pair's right packing):
        // bottom:0 anchors the float to the list's visible bottom edge; the
        // 8px top padding cushions the buttons from the strip's top rim
        // without moving them (the bottom-anchored strip grows upward); the
        // strip stays TRANSPARENT — a painted surface appears as a dark
        // horizontal line slicing across the bubble while riding over the
        // scrolling message text, so no background-color is allowed.
        const stripRule = /\.css-[^{]+\{[^}]*justify-content:flex-end;[^}]*\}/.exec(css)?.[0];
        expect(stripRule).toBeDefined();
        expect(stripRule).toContain('bottom:0');
        expect(stripRule).toContain('padding-top:8px');
        expect(stripRule).not.toContain('background-color');
        // `position` is the GATED dynamic prop: each rendered variant
        // serializes as its own Emotion class hoisted under
        // @media (min-width: 0px) (shape verified in real Chrome:
        // `.css-x{position:static;}` and
        // `.css-y{position:-webkit-sticky;position:sticky;}` — the sticky one
        // carries Emotion's vendor prefix). Emotion creates variant classes
        // LAZILY per rendered value, so in jsdom — every rect is 0, the
        // gate's first clause (turnBottom - pinBottom > epsilon) never holds,
        // no strip ever floats — the sticky variant rule does not exist yet.
        const staticVariant = /@media \(min-width: 0px\)\{\.(css-[a-z0-9]+)\{position:static;\}\}/.exec(css)?.[1];
        expect(staticVariant).toBeDefined();
        expect(/position:(?:-webkit-sticky;position:)?sticky;/.test(css)).toBe(false);
        // The rendered assistant strip (turn 1 = latest reply, expanded)
        // carries the anchored variant class, Emotion-composed into a single
        // class name.
        const controls = screen.getByTestId('turn-controls-1');
        expect(controls.className).toContain(staticVariant!);

        // DOM side: the strip is the direct wrapper of the copy+edit action
        // pair and the turn's LAST child (natural position directly under
        // the bubble — the gate's natural-slot reference).
        const copyButton = screen.getByTestId('copy-message-1');
        const pairRow = copyButton.parentElement?.parentElement;
        expect(pairRow).toBe(controls);
        const turn = screen.getByTestId('message-turn-1');
        expect(turn.lastElementChild).toBe(pairRow);
        // The gate's measurement hooks: per-turn strip testids, and the
        // header row is the turn's first child (its bottom edge bounds the
        // float from above so the strip can never cover the delete "x").
        expect(turn.firstElementChild?.contains(screen.getByTestId('delete-message-1'))).toBe(true);
    });

    it('controlsShouldFloat: floats only while the turn end is below the fold AND the pinned strip clears the header/x', () => {
        // Exact boundary table (turnBottom, headerBottom, pinBottom,
        // stripHeight). FLOAT while: end strictly >0.5px below the pin line
        // AND pinTop >= headerBottom - 0.5.
        // Deep in a tall turn: end far below, pin top far below header.
        expect(controlsShouldFloat(1000, 50, 400, 30)).toBe(true);
        // End exactly at the pin line: 400 - 400 = 0 is NOT > 0.5 epsilon.
        expect(controlsShouldFloat(400, 50, 400, 30)).toBe(false);
        // End 6px below the pin line: floats (30px strip is inside the 6px
        // overlap; still floatable — the pinned position moves the strip
        // up by only 6px).
        expect(controlsShouldFloat(406, 50, 400, 30)).toBe(true);
        // THE REPORTED BUG GEOMETRY (real-Chrome measurement): turn bottom
        // 1324 with pin line 508.6 and strip height 30 — but the header/x
        // ends at y=542: pinTop 478.6 < 542, so the raw sticky clamp would
        // sit the strip over the turn's own "x". The gate says NO FLOAT.
        expect(controlsShouldFloat(1324, 542, 508.6, 30)).toBe(false);
        // The same tall turn once scrolled further down: header now ends at
        // 342, pin top 478.6 clears it by >130px — floating engages.
        expect(controlsShouldFloat(1124, 342, 508.6, 30)).toBe(true);
        // Epsilon edge on the header clause: pinTop exactly headerBottom-0.5.
        expect(controlsShouldFloat(1000, 370.5, 400, 30)).toBe(true);
        // Epsilon edge on the end clause: 0.5px below the line is not enough.
        expect(controlsShouldFloat(400.5, 50, 400, 30)).toBe(false);
    });

    it('flips only the eligible turn\'s strip to sticky on scroll, leaving the visible-end turn anchored', async () => {
        renderApp();
        await waitForModelSelection();
        await sendFirstTurn();
        // Turn 0's "user" starts collapsed; expand it so BOTH turns render
        // controls with delete "x" buttons and strip testids.
        fireEvent.click(screen.getByTestId('collapse-message-0'));

        // Real-browser geometry is impossible in jsdom (all rects 0 — which
        // is why the base test asserts the anchored baseline), so the rects
        // the gate reads are spied per testid. Numbers copy the real-Chrome
        // probe shapes: pin line 508.6 (list bottom 532.6 - 24px padding);
        // turn 1 (assistant) extends to 1400 with its header/x ending at
        // 342 (float: pinTop 478.6 clears 342 and 1400-508.6 >> 0.5); turn 0
        // ends at 300, entirely above the pin line (no float — its end is
        // in view); the system draft turn ends at 200 (also anchored).
        const rectOf = (bottom: number, height: number) => ({ x: 0, y: bottom - height, top: bottom - height, left: 0, right: 100, width: 100, bottom, height, toJSON: () => ({}) }) as DOMRect;
        const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            const id = this.getAttribute?.('data-testid') ?? '';
            const parentId = this.parentElement?.getAttribute?.('data-testid') ?? '';
            // The pin line: the gate subtracts the list's computed bottom
            // padding from THIS rect's bottom (532.6 - 24 = 508.6 — jsdom
            // resolves Emotion's padding on the message list fine, and both
            // outcomes leave the verdicts below unchanged).
            if (id === 'message-list') return rectOf(532.6, 100);
            // The header row has NO testid: identify it via its parent turn.
            if (id === '' && parentId === 'message-turn-1') return rectOf(342, 22);
            if (id === '' && parentId === 'message-turn-0') return rectOf(120, 22);
            if (id === '' && parentId === 'system-prompt-turn') return rectOf(120, 22);
            if (id === 'message-turn-1') return rectOf(1400, 1000);
            if (id === 'turn-controls-1') return rectOf(1400, 30);
            if (id === 'message-turn-0') return rectOf(300, 200);
            if (id === 'turn-controls-0') return rectOf(300, 30);
            if (id === 'system-prompt-turn') return rectOf(200, 180);
            if (id === 'system-prompt-controls') return rectOf(200, 30);
            return rectOf(0, 0);
        });
        try {
            // The gate re-measures on list scroll events.
            fireEvent.scroll(screen.getByTestId('message-list'));

            // Emotion creates variant classes lazily: the sticky variant
            // (vendor-prefixed) only exists in the sheet once the gate lets
            // one strip float.
            await waitFor(() => {
                const sheet = Array.from(document.querySelectorAll('style[data-emotion]'))
                    .map((tag) => tag.textContent)
                    .join('\n');
                const stickyVariant = /@media \(min-width: 0px\)\{\.(css-[a-z0-9]+)\{position:(?:-webkit-sticky;position:)?sticky;\}\}/.exec(sheet)?.[1];
                expect(stickyVariant).toBeDefined();
                expect(screen.getByTestId('turn-controls-1').className).toContain(stickyVariant!);
            });
            // Exactly one turn floats; the visible-end turn and the draft
            // turn stay anchored on the static variant.
            const sheet = Array.from(document.querySelectorAll('style[data-emotion]'))
                .map((tag) => tag.textContent)
                .join('\n');
            const staticVariant = /@media \(min-width: 0px\)\{\.(css-[a-z0-9]+)\{position:static;\}\}/.exec(sheet)?.[1];
            const stickyVariant = /@media \(min-width: 0px\)\{\.(css-[a-z0-9]+)\{position:(?:-webkit-sticky;position:)?sticky;\}\}/.exec(sheet)?.[1];
            expect(screen.getByTestId('turn-controls-0').className).toContain(staticVariant!);
            expect(screen.getByTestId('turn-controls-0').className).not.toContain(stickyVariant!);
            expect(screen.getByTestId('system-prompt-controls').className).toContain(staticVariant!);
            expect(screen.getByTestId('system-prompt-controls').className).not.toContain(stickyVariant!);
        } finally {
            spy.mockRestore();
        }
    });

    it('leads every chat with the system prompt turn ("no prompt" by default) and an empty draft never persists', async () => {
        renderApp();
        await waitForModelSelection();

        // New chat surface: the system prompt row is the message list's FIRST
        // turn, its bubble showing the literal placeholder — the bubble is NOT
        // editable until a click on it turns it into the editor.
        const draftTurn = screen.getByTestId('system-prompt-turn');
        expect(screen.getByTestId('message-list').firstElementChild).toBe(draftTurn);
        expect(screen.getByTestId('system-prompt-value').textContent).toBe('no prompt');
        expect(screen.getByTestId('system-prompt-value').getAttribute('contenteditable')).toBeNull();

        // Opening the editor and CANCELLING (Escape) leaves the placeholder
        // untouched: the keyed bubble remount reverts the discarded DOM text.
        fireEvent.click(screen.getByTestId('system-prompt-value'));
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
            stream_options: { include_usage: true },
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

    it('renders the system prompt row like an assistant/user turn: "no prompt" placeholder without a copy action', async () => {
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
        // and NO action button renders (no copy without text, no delete cross
        // EVER; the retired edit pen is gone — the words themselves are the
        // only edit trigger).
        const bubble = screen.getByTestId('system-prompt-value');
        expect(turn.children[1]).toBe(bubble);
        expect(bubble.textContent).toBe('no prompt');
        expect(bubble.getAttribute('data-empty')).toBe('true');
        expect(bubble.tagName).toBe('ARTICLE');
        expect(bubble.getAttribute('contenteditable')).toBeNull();
        expect(screen.queryByTestId('edit-system-prompt')).toBeNull();
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

    it('edits the system prompt inline, persists it on blur, and copies the saved turn', async () => {
        // Clipboard stub (jsdom has no Clipboard API).
        const writeText = vi.fn((_text: string) => Promise.resolve());
        Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText } });
        renderApp();
        await waitForModelSelection();

        // Clicking the words turns the bubble itself into the inline editor,
        // seeded empty.
        fireEvent.click(screen.getByTestId('system-prompt-value'));
        const editingBubble = screen.getByTestId('system-prompt-value');
        expect(editingBubble.getAttribute('contenteditable')).toBe('true');
        expect(editingBubble.textContent).toBe('');
        editingBubble.textContent = 'You are terse.';
        fireEvent.blur(editingBubble, { relatedTarget: null });

        // The blur save creates the prompt-only record, and the canonical system
        // turn replaces the draft row after the POST + GET complete.
        await waitFor(() => expect((fetch as any).mock.calls).toHaveLength(4));
        expect(screen.getByTestId('message-preview-0').textContent).toBe('You are terse.');
        fireEvent.click(screen.getByTestId('collapse-message-0'));
        const copy = screen.getByTestId('copy-message-0');

        fireEvent.click(copy);
        await waitFor(() => expect(writeText).toHaveBeenCalledWith('You are terse.'));
    });

    it('persists a typed system prompt as the leading system message on send and gives it click-to-edit/copy but no delete', async () => {
        // The mock tracks the identified record so the prompt-only create GET
        // returns just the system turn and the later append GET returns the full
        // conversation, matching the storage service's two-step flow.
        const conversationWithSystem = {
            ...conversation,
            messageCount: 3,
            messages: [
                { role: 'system' as const, content: 'You are terse.' },
                ...conversation.messages
            ]
        };
        let persistedMessages: typeof conversationWithSystem.messages = [];
        vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
            if (url.endsWith('/models')) return Promise.resolve(response(200, catalog));
            if (url.endsWith('/chat/completions')) return Promise.resolve(sseResponse(completionFrames));
            if (init?.method === 'GET' && url.endsWith('/conversation')) {
                return Promise.resolve(response(200, { conversations: [] }));
            }
            if (init?.method === 'POST' && url.endsWith('/conversation')) {
                const body = JSON.parse(String(init.body)) as { systemPrompt?: string };
                persistedMessages = body.systemPrompt
                    ? [{ role: 'system' as const, content: body.systemPrompt }]
                    : [];
                return Promise.resolve(response(201, { conversationId: conversation.conversationId }));
            }
            if (init?.method === 'POST') {
                const body = JSON.parse(String(init.body)) as { messages: typeof conversationWithSystem.messages };
                persistedMessages = [...persistedMessages, ...body.messages];
                return Promise.resolve(response(200, { conversationId: conversation.conversationId }));
            }
            if (init?.method === 'PUT') {
                const body = JSON.parse(String(init.body)) as { messages: typeof conversationWithSystem.messages };
                persistedMessages = [...body.messages];
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
                const persisted = persistedMessages.length > 0
                    ? { ...conversationWithSystem, messages: persistedMessages, messageCount: persistedMessages.length }
                    : conversationWithSystem;
                return Promise.resolve(response(200, { conversationId: conversation.conversationId, conversation: persisted }));
            }
            return Promise.resolve(response(404, { error: 'unexpected request' }));
        }));
        // Clipboard stub for the copy assertion (jsdom has no Clipboard API).
        const writeText = vi.fn((_text: string) => Promise.resolve());
        Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText } });
        renderApp();
        await waitForModelSelection();

        // Draft a prompt by clicking the turn's bubble (the bubble becomes the
        // contentEditable editor; a blur commits the draft), then send the
        // first turn.
        fireEvent.click(screen.getByTestId('system-prompt-value'));
        screen.getByTestId('system-prompt-value').textContent = 'You are terse.';
        fireEvent.blur(screen.getByTestId('system-prompt-value'), { relatedTarget: null });
        // Sending is intentionally gated until the immediate prompt save returns,
        // so the provider cannot observe a history without the edited prompt.
        await waitFor(() => expect((fetch as any).mock.calls).toHaveLength(4));
        fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Hello assistant' } });
        fireEvent.click(screen.getByTestId('send-chat-button'));
        await waitFor(() => expect(screen.getByTestId('chat-tab-conversation-1')).toBeDefined());
        // The provider history LEADS with the system message...
        expect((fetch as any).mock.calls[4]).toEqual([
            `${PROVIDER_URL}/chat/completions`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: DEFAULT_MODEL,
                    stream: true,
                    stream_options: { include_usage: true },
                    messages: [
                        { role: 'system', content: 'You are terse.' },
                        { role: 'user', content: 'Hello assistant' }
                    ]
                })
            }
        ]);
        // ...and the existing prompt-only conversation's append adds only the
        // completed pair because the system turn was already saved on blur.
        expect((fetch as any).mock.calls[5][1].body).toEqual(JSON.stringify({
            messages: [
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

        // Expanding the system turn reveals it like any other turn: click-to-
        // edit bubble + copy action, but NO delete cross — the prompt cannot
        // be removed.
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
        const copySystem = screen.getByTestId('copy-message-0');
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
        // intact: clicking its bubble's words turns it into the seeded inline
        // editor and the blur commits.
        fireEvent.click(screen.getByTestId('message-content-0'));
        const systemEdit = screen.getByTestId('message-content-0');
        expect(systemEdit.getAttribute('contenteditable')).toBe('true');
        expect(systemEdit.textContent).toBe('You are terse.');
        systemEdit.textContent = 'You are verbose.';
        fireEvent.blur(systemEdit, { relatedTarget: null });
        await waitFor(() => expect((fetch as any).mock.calls).toHaveLength(8));
        expect((fetch as any).mock.calls[7]).toEqual([
            `${BASE_URL}/conversation-1`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: [
                        { role: 'system', content: 'You are verbose.' },
                        { role: 'user', content: 'Hello assistant' },
                        { role: 'assistant', content: 'Hello from the assistant', model: DEFAULT_MODEL }
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

        // NOW draft a prompt by clicking the bubble (bubble-as-editor +
        // blur-commit) and send a second turn.
        fireEvent.click(screen.getByTestId('system-prompt-value'));
        screen.getByTestId('system-prompt-value').textContent = 'You are terse.';
        fireEvent.blur(screen.getByTestId('system-prompt-value'), { relatedTarget: null });
        // The prompt PUT completes before the next send can use this chat.
        await waitFor(() => expect((fetch as any).mock.calls).toHaveLength(7));
        expect((fetch as any).mock.calls[6]).toEqual([
            `${BASE_URL}/conversation-1`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: [
                        { role: 'system', content: 'You are terse.' },
                        { role: 'user', content: 'Hello assistant' },
                        { role: 'assistant', content: 'Hello from the assistant', model: ALT_MODEL }
                    ]
                })
            }
        ]);
        fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Turn two' } });
        fireEvent.click(screen.getByTestId('send-chat-button'));

        // The provider history is system-prepended (attribution stripped upstream).
        await waitFor(() => expect((fetch as any).mock.calls).toHaveLength(10));
        expect((fetch as any).mock.calls[7]).toEqual([
            `${PROVIDER_URL}/chat/completions`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: DEFAULT_MODEL,
                    stream: true,
                    stream_options: { include_usage: true },
                    messages: [
                        { role: 'system', content: 'You are terse.' },
                        { role: 'user', content: 'Hello assistant' },
                        { role: 'assistant', content: 'Hello from the assistant' },
                        { role: 'user', content: 'Turn two' }
                    ]
                })
            }
        ]);
        // The prompt was already saved on blur, so this send appends only the
        // newly completed user/assistant pair after the existing system turn.
        expect((fetch as any).mock.calls[8]).toEqual([
            `${BASE_URL}/conversation-1`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: [
                        { role: 'user', content: 'Turn two' },
                        { role: 'assistant', content: 'Hello from the assistant', model: DEFAULT_MODEL }
                    ],
                    model: DEFAULT_MODEL,
                    usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 }
                })
            }
        ]);

        // The record leads with the system turn; the draft form is gone because
        // the prompt was persisted before the send. The fresh record re-seeds
        // the collapse set: the system turn shows only its preview...
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

        // The collapsed view STACKS: the label row (label toggle + reversible
        // role switch) sits on its OWN line with the preview BELOW it (never
        // inline). The lead is a COLUMN whose children are [label row, preview],
        // and the whole stack keeps the turn's side: the USER stack is RIGHT-aligned. Alignment + the
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
        const userLabelLine = screen.getByTestId('collapse-message-0').parentElement as HTMLElement;
        const userLead = userLabelLine.parentElement as HTMLElement;
        expect(window.getComputedStyle(userLead).flexDirection).toBe('column');
        expect(window.getComputedStyle(userLabelLine).flexDirection).toBe('row');
        // Right-aligned user labels read from right to left: the switch is the
        // first inline control, immediately to the LEFT of the user name.
        expect(userLabelLine.firstElementChild).toBe(screen.getByTestId('switch-message-0'));
        expect(userLabelLine.lastElementChild).toBe(screen.getByTestId('collapse-message-0'));
        expect(userLead.firstElementChild).toBe(userLabelLine);
        expect(userLead.lastElementChild).toBe(screen.getByTestId('message-preview-0'));
        // The LEAD (the toggle's parent column) keeps the user stack right-aligned.
        expect(new RegExp(`@media \\(min-width: 0px\\)\\{\\.${userLead.className}\\{[^}]*align-items:flex-end;[^}]*\\}\\}`).test(css)).toBe(true);
        // The user preview's text hugs the right edge as well.
        expect(mediaStyle('message-preview-0', 'text-align')).toBe('right');
        // The ASSISTANT stack mirrors left: same column, left alignment.
        const assistantLabelLine = screen.getByTestId('collapse-message-1').parentElement as HTMLElement;
        const assistantLead = assistantLabelLine.parentElement as HTMLElement;
        expect(window.getComputedStyle(assistantLead).flexDirection).toBe('column');
        expect(window.getComputedStyle(assistantLabelLine).flexDirection).toBe('row');
        expect(assistantLabelLine.lastElementChild).toBe(screen.getByTestId('switch-message-1'));
        expect(new RegExp(`@media \\(min-width: 0px\\)\\{\\.${assistantLead.className}\\{[^}]*align-items:flex-start;[^}]*\\}\\}`).test(css)).toBe(true);
        // Width floor: ONLY the expanded turn carries min-width:50%; the
        // collapsed one stays compact (min-width:auto).
        expect(mediaStyle('message-turn-0', 'min-width')).toBe('auto');
        expect(mediaStyle('message-turn-1', 'min-width')).toBe('50%');

        // Collapse the ASSISTANT turn: bubble + copy/delete hide behind a
        // one-line preview of the reply's first line STACKED under its label...
        fireEvent.click(screen.getByTestId('collapse-message-1'));
        expect(screen.getByTestId('collapse-message-1').getAttribute('aria-expanded')).toBe('false');
        expect(screen.getByTestId('message-preview-1').textContent).toBe('Hello from the assistant');
        expect(assistantLead.lastElementChild).toBe(screen.getByTestId('message-preview-1'));
        expect(screen.getByTestId('message-turn-1').querySelector('article')).toBeNull();
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

    it('switches user and assistant roles in either direction through the complete-history PUT', async () => {
        renderApp();
        await waitForModelSelection();
        await sendFirstTurn();

        // The role control sits beside the visible user label even though the
        // user bubble is collapsed by default, and it uses the shared SVG icon.
        const userSwitch = screen.getByTestId('switch-message-0');
        expect(userSwitch.getAttribute('aria-label')).toBe('Switch user message to assistant');
        expect(userSwitch.querySelector('svg[data-icon="switch"]')).not.toBeNull();
        expect(screen.getByTestId('switch-message-1').getAttribute('aria-label')).toBe('Switch assistant message to user');

        // User → assistant adopts the currently selected model (the model that
        // produced the first send), making the forged turn visibly attributable.
        fireEvent.click(userSwitch);
        await waitFor(() => expect((fetch as any).mock.calls).toHaveLength(7));
        expect((fetch as any).mock.calls[6]).toEqual([
            `${BASE_URL}/conversation-1`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: [
                        { role: 'assistant', content: 'Hello assistant', model: DEFAULT_MODEL },
                        { role: 'assistant', content: 'Hello from the assistant', model: ALT_MODEL }
                    ]
                })
            }
        ]);
        expect(screen.getByTestId('message-model-0').textContent).toBe('test-model');
        expect(screen.queryByTestId('message-label-0')).toBeNull();

        // Assistant → user removes assistant-only model attribution and returns
        // the same message to the user-labelled state with another PUT.
        fireEvent.click(screen.getByTestId('switch-message-0'));
        await waitFor(() => expect((fetch as any).mock.calls).toHaveLength(8));
        expect((fetch as any).mock.calls[7]).toEqual([
            `${BASE_URL}/conversation-1`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: [
                        { role: 'user', content: 'Hello assistant' },
                        { role: 'assistant', content: 'Hello from the assistant', model: ALT_MODEL }
                    ]
                })
            }
        ]);
        expect(screen.getByTestId('message-label-0').textContent).toBe('user');
        expect(screen.queryByTestId('message-model-0')).toBeNull();
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
            stream_options: { include_usage: true },
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
        expect(screen.getByTestId('copy-message-3')).toBeDefined();
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

    it('flies the message list to a section\'s own edges from the up/down chevrons in that section\'s controls panel', async () => {
        renderApp();
        await waitForModelSelection();

        const list = screen.getByTestId('message-list');
        // Real-browser geometry for the jump targets: jsdom rects are all 0,
        // so getBoundingClientRect is spied per testid with rects that track
        // the LIVE scrollTop exactly like a browser (viewport-y =
        // list-rect-top + content-y − scrollTop). The list rect is
        // viewport-FIXED (top 100, height 400 = the clientHeight stub). In
        // 1200px of content with 24px padding: the system prompt DRAFT turn
        // occupies content [24,124), the user turn (message-turn-0) sits at
        // [140,600), the assistant turn (message-turn-1) at [616,1176), and
        // the 24px bottom padding pads out to 1200.
        const rectOf = (bottom: number, height: number) => ({ x: 0, y: bottom - height, top: bottom - height, left: 0, right: 100, width: 100, bottom, height, toJSON: () => ({}) }) as DOMRect;
        const CONTENT: Record<string, { top: number; height: number }> = {
            'system-prompt-turn': { top: 24, height: 100 },
            'message-turn-0': { top: 140, height: 460 },
            'message-turn-1': { top: 616, height: 560 }
        };
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            const id = this.getAttribute?.('data-testid') ?? '';
            if (id === 'message-list') return rectOf(500, 400);
            const block = CONTENT[id];
            if (block) return rectOf(100 + block.top + block.height - list.scrollTop, block.height);
            return rectOf(0, 0);
        });
        await sendFirstTurn();

        // Long-chat geometry: 1200px of content behind a 400px scrollport.
        // The stubs land AFTER the first turn persisted, so the auto-pin
        // effect already wrote scrollTop = scrollHeight = 0: the list sits
        // at the TOP of this long chat.
        Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1200 });
        Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
        fireEvent.scroll(list);

        // The retired GLOBAL overlay control (one chevron for the whole
        // panel) must not exist anymore: each SECTION owns its chevrons.
        expect(screen.queryByTestId('scroll-jump-button')).toBeNull();

        // Every section WITH a controls panel owns an up/down chevron pair
        // — the expanded assistant turn (1) and the system draft turn render
        // theirs immediately; the user turn (0) starts COLLAPSED (no panel)
        // until expanded.
        const strip1 = screen.getByTestId('turn-controls-1');
        const top1 = screen.getByTestId('turn-jump-top-1');
        const bottom1 = screen.getByTestId('turn-jump-bottom-1');
        // The pair is the panel's FIRST child (left edge), each button
        // hosting the matching stroke chevron with its own accessible label.
        expect(strip1.firstElementChild).toBe(top1.parentElement);
        expect(top1.querySelector('svg[data-icon="chevron-up"]')).not.toBeNull();
        expect(bottom1.querySelector('svg[data-icon="chevron-down"]')).not.toBeNull();
        expect(top1.getAttribute('aria-label')).toBe('Scroll to section top');
        expect(bottom1.getAttribute('aria-label')).toBe('Scroll to section bottom');
        expect(screen.getByTestId('system-prompt-jump-top').querySelector('svg[data-icon="chevron-up"]')).not.toBeNull();
        expect(screen.getByTestId('system-prompt-jump-bottom').parentElement?.parentElement).toBe(screen.getByTestId('system-prompt-controls'));
        expect(screen.queryByTestId('turn-jump-top-0')).toBeNull();
        fireEvent.click(screen.getByTestId('collapse-message-0'));
        const top0 = screen.getByTestId('turn-jump-top-0');
        const bottom0 = screen.getByTestId('turn-jump-bottom-0');

        // From the list's TOP (scrollTop 0), turn-1's "^" flies the list so
        // THAT SECTION's top edge docks on the top padding line: content-y
        // 616 − 24 = EXACTLY 592 (rAF runs under vitest's pretendToBeVisual
        // jsdom; the wait covers the fixed 200ms ease-out window).
        expect(list.scrollTop).toBe(0);
        fireEvent.click(top1);
        await waitFor(() => expect(list.scrollTop).toBe(592));

        // turn-0's "v" then flies so THAT SECTION's bottom edge lands on the
        // bottom padding line: 600 + 24 − 400 = EXACTLY 224 (measured live
        // at arrival from the spied rects).
        fireEvent.click(bottom0);
        await waitFor(() => expect(list.scrollTop).toBe(224));

        // The system draft turn participates too: its "v" would want 124 +
        // 24 − 400 < 0, so the travel range clamps the flight to 0...
        fireEvent.click(screen.getByTestId('system-prompt-jump-bottom'));
        await waitFor(() => expect(list.scrollTop).toBe(0));

        // ...and its "^" is a zero-travel click (its top already docks the
        // padding line): pinned INSTANTLY (still 0).
        fireEvent.click(screen.getByTestId('system-prompt-jump-top'));
        expect(list.scrollTop).toBe(0);

        // Pure view state: the six send-flow calls only — section jumps
        // never touch the network.
        expect((fetch as any).mock.calls).toHaveLength(6);
    });

    it('completes an up-jump from the bottom edge through the mid-flight at-bottom state flip (the partial-landing regression)', async () => {
        // REGRESSION for the reported glitch "down chevron reaches the
        // bottom, then up chevron goes only PARTIALLY and needs a second
        // click": starting from the list's bottom edge, the up flight's first
        // frame detaches the bottom edge, the browser's scroll event runs
        // syncStickyControls, and its listAtBottom flip (state update →
        // RE-RENDER) used to re-fire the unmount-cleanup effect — whose dep
        // [listJump] held a PER-RENDER identity — and cancelAnimationFrame'd
        // the flight at ~25% of the distance. The @presource/react state-hook
        // handles are now identity-stable (reference.ts/state.ts create the
        // accessor once per component lifetime), so the cleanup only runs at
        // unmount and one click lands EXACTLY.
        renderApp();
        await waitForModelSelection();

        const list = screen.getByTestId('message-list');
        // Same live-rect spy as the section-chevron test above: viewport-y =
        // list-rect-top + content-y − LIVE scrollTop, list rect fixed at
        // top 100/height 400 (the clientHeight stub). Only turn-1 needs a
        // real rect — it is both the flight target and, after the send, the
        // chat's last content (its bottom dock IS the scroll range end).
        const rectOf = (bottom: number, height: number) => ({ x: 0, y: bottom - height, top: bottom - height, left: 0, right: 100, width: 100, bottom, height, toJSON: () => ({}) }) as DOMRect;
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            const id = this.getAttribute?.('data-testid') ?? '';
            if (id === 'message-list') return rectOf(500, 400);
            if (id === 'message-turn-1') return rectOf(100 + 616 + 560 - list.scrollTop, 560);
            return rectOf(0, 0);
        });
        await sendFirstTurn();

        // Long-chat geometry AFTER the send (same order as the chevron test):
        // 1200px of content behind a 400px scrollport.
        Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1200 });
        Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });

        // The user's exact sequence: turn-1's "v" lands the list on its REAL
        // bottom edge (1176 + 24 − 400 = 800 = the scroll range end), so the
        // list is at-bottom by measurement, not by assumption.
        fireEvent.click(screen.getByTestId('turn-jump-bottom-1'));
        await waitFor(() => expect(list.scrollTop).toBe(800));

        // Then "^" on the same turn: the true dock target is EXACTLY
        // 616 − 24 = 592.
        fireEvent.click(screen.getByTestId('turn-jump-top-1'));
        // Sequence the mid-flight scroll pass: once the first frame moved the
        // list off the bottom edge, a real browser has already dispatched a
        // scroll event — fire it by hand (jsdom never dispatches scroll for
        // programmatic scrollTop writes). syncStickyControls flips
        // listAtBottom(false) → state update → re-render at THIS instant: the
        // exact moment the stale-identity cleanup used to kill the flight.
        await waitFor(() => expect(list.scrollTop).not.toBe(800));
        fireEvent.scroll(list);
        // ONE click, EXACT landing — a cancelled flight would freeze at its
        // mid position and time this wait out.
        await waitFor(() => expect(list.scrollTop).toBe(592));

        // Still pure view state: the same six send-flow calls.
        expect((fetch as any).mock.calls).toHaveLength(6);
    });

    it('keeps a manual scroll-up position through stream chunks and the completion swap (follow re-engages at the bottom)', async () => {
        // Controlled-stream variant of the default routes (identical to the
        // auto-scroll test's) so the send record flow still makes its six
        // calls end-to-end, while each chunk's arrival is driven by hand.
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
        // jsdom rects are all 0, so getBoundingClientRect is spied exactly
        // like the section-chevron test's spy: viewport-y = 100 + content-y
        // − scrollTop, list rect FIXED at top 100/height 400 (its
        // clientHeight stub). The transient pending/streaming turns have NO
        // controls panel (no chevrons), so only the anatomy the post-
        // completion flight needs is modelled: message-turn-0 at content
        // [140,340) and message-turn-1 growing with the list to
        // [356, scrollHeight − 24) — its bottom edge is the DOWN anchor.
        const rectOf = (bottom: number, height: number) => ({ x: 0, y: bottom - height, top: bottom - height, left: 0, right: 100, width: 100, bottom, height, toJSON: () => ({}) }) as DOMRect;
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            const id = this.getAttribute?.('data-testid') ?? '';
            if (id === 'message-list') return rectOf(500, 400);
            if (id === 'message-turn-0') return rectOf(100 + 340 - list.scrollTop, 200);
            if (id === 'message-turn-1') return rectOf(100 + list.scrollHeight - 24 - list.scrollTop, list.scrollHeight - 24 - 356);
            return rectOf(0, 0);
        });

        // Long-chat geometry BEFORE typing: 2000px of content behind a 400px
        // scrollport. The composer-typing pin is unconditional (documented),
        // so typing lands the list exactly at the bottom edge.
        Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 2000 });
        Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
        fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Hello assistant' } });
        await waitFor(() => expect(list.scrollTop).toBe(2000));
        fireEvent.click(screen.getByTestId('send-chat-button'));
        await waitFor(() => expect(screen.getByTestId('pending-user-message')).toBeDefined());

        // The first chunk still follows: the list WAS at its bottom edge
        // when it arrived (ambient ticks pin only at the bottom edge).
        Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 2400 });
        await act(async () => stream.push(completionFrames[0]));
        await waitFor(() => expect(screen.getByTestId('streaming-message').textContent).toBe('Hello'));
        expect(list.scrollTop).toBe(2400);

        // THE GLITCH FIX: a plain wheel-scroll away from the bottom
        // mid-stream (scrollTop 500 ≙ the user reading an earlier section;
        // the IN-FLIGHT turns render no panels, hence no chevrons yet)
        // detaches the follow — the next chunk must NOT drag the list down.
        list.scrollTop = 500;
        fireEvent.scroll(list);
        Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 3000 });
        await act(async () => stream.push(completionFrames[1]));
        await waitFor(() => expect(screen.getByTestId('streaming-message').textContent).toBe('Hello from the assistant'));
        expect(list.scrollTop).toBe(500);

        // Stream COMPLETION swaps pending/streaming for the canonical record
        // — an AMBIENT refresh, not navigation: it must NOT yank the list
        // down either. The reading position still holds at 500.
        await act(async () => {
            stream.push(completionFrames[2]);
            stream.push(completionFrames[3]);
            stream.close();
        });
        await waitFor(() => expect(screen.getByTestId('chat-tab-conversation-1')).toBeDefined());
        expect(screen.queryByTestId('streaming-message')).toBeNull();
        expect(list.scrollTop).toBe(500);

        // Returning to the conversation tail goes through the freshly
        // persisted section's OWN panel: turn-1's "v" (its strip renders
        // once the record lands) flies to THAT section's live-measured
        // bottom edge on the bottom padding line — (3000 − 24) + 24 − 400 =
        // EXACTLY 2600, the list's real scroll range end, so the
        // bottom-follow gate re-engages for whatever streams next.
        fireEvent.click(await screen.findByTestId('turn-jump-bottom-1'));
        await waitFor(() => expect(list.scrollTop).toBe(2600));

        // Pure view state: the same six send-flow calls as any controlled
        // send — section jumps and follow-detaching never touch the network.
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
        // The scrollbar is hidden through platform-specific chrome rules, while
        // the underlying scroll container retains its normal overflow behavior.
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
