// Deterministic integration tests for the provider-driven conversation dashboard.
// The UI flow is: GET {provider}/models on mount; on send, POST {provider}/chat/completions
// with the entire history; only after the model's turn completes, persist the
// user+assistant pair through the storage API and GET the canonical record.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatAssistantApp } from './ChatAssistantApp';

const BASE_URL = 'http://test.local/v1/chat-assistant/conversation';
const PROVIDER_URL = 'http://test.local/providers/private/v1';

// Response helper models the exact storage/provider response envelopes.
const response = (status: number, body: unknown) =>
    ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body
    }) as Response;

// Two-entry model catalog: the first entry is the default selection.
const catalog = {
    object: 'list',
    data: [
        { id: 'test-model', object: 'model', created: 1677610602, owned_by: 'localhost', context_length: 262144 },
        { id: 'other-model', object: 'model', created: 1677610602, owned_by: 'localhost', context_length: 262144 }
    ]
};

// The completed record returned by identified GET is reused after both POST operations.
const conversation = {
    conversationId: 'conversation-1',
    title: 'Hello assistant',
    model: 'test-model',
    status: 'complete' as const,
    messageCount: 2,
    messages: [
        { role: 'user' as const, content: 'Hello assistant' },
        { role: 'assistant' as const, content: 'Hello from the assistant' }
    ],
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:01.000Z'
};

// The provider's fixed non-streaming completion for every chat request.
const completion = {
    choices: [{ message: { content: 'Hello from the assistant' } }],
    usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 }
};

// Default fetch mock routes storage, catalog, and completion calls by URL/method.
const mockFetch = () =>
    vi.fn((url: string, init?: RequestInit) => {
        if (url.endsWith('/models')) return Promise.resolve(response(200, catalog));
        if (url.endsWith('/chat/completions')) return Promise.resolve(response(200, completion));
        if (init?.method === 'POST' && url.endsWith('/conversation')) {
            return Promise.resolve(response(201, { conversationId: conversation.conversationId }));
        }
        if (init?.method === 'POST') return Promise.resolve(response(200, { conversationId: conversation.conversationId }));
        if (init?.method === 'GET') {
            return Promise.resolve(response(200, { conversationId: conversation.conversationId, conversation }));
        }
        return Promise.resolve(response(404, { error: 'unexpected request' }));
    });

const renderApp = () =>
    render(<ChatAssistantApp baseUrl={BASE_URL} providerUrl={PROVIDER_URL} />);

// Sending requires the catalog's default model, which arrives asynchronously.
const waitForModelSelection = async () => {
    await waitFor(() => expect((screen.getByTestId('model-select') as HTMLSelectElement).value).toBe('test-model'));
};

describe('ChatAssistantApp', () => {
    // The storage API has no collection GET; only the provider catalog is fetched on mount.
    beforeEach(() => vi.stubGlobal('fetch', mockFetch()));
    afterEach(() => vi.unstubAllGlobals());

    it('renders the empty conversation and composer after fetching the model catalog', async () => {
        renderApp();

        expect(screen.getByTestId('chat-assistant')).toBeDefined();
        expect(screen.getByTestId('empty-chat-state').textContent).toContain('Start a conversation');
        const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
        expect(input).toBeDefined();
        expect(input.getAttribute('rows')).toBeNull();
        expect(window.getComputedStyle(input).resize).toBe('none');
        expect(screen.getByTestId('send-chat-button')).toBeDefined();

        // The only mount request is the credential-free provider model catalog.
        await waitForModelSelection();
        expect((fetch as any).mock.calls).toEqual([[`${PROVIDER_URL}/models`, { method: 'GET' }]]);
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

    it('asks the provider first, then persists the completed pair, then GETs the record', async () => {
        renderApp();
        await waitForModelSelection();

        fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Hello assistant' } });
        fireEvent.click(screen.getByTestId('send-chat-button'));

        await waitFor(() => expect(screen.getByText('Hello from the assistant')).toBeDefined());
        expect(screen.getAllByText('Hello assistant')).toHaveLength(2);
        expect(screen.getByTestId('chat-tab-conversation-1')).toBeDefined();
        expect(screen.getByTestId('chat-model').textContent).toBe('Model: test-model');

        // Order matters: catalog, provider completion, storage create, storage append, storage GET.
        expect((fetch as any).mock.calls).toEqual([
            [`${PROVIDER_URL}/models`, { method: 'GET' }],
            [
                `${PROVIDER_URL}/chat/completions`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: 'test-model',
                        stream: false,
                        messages: [{ role: 'user', content: 'Hello assistant' }]
                    })
                }
            ],
            [
                BASE_URL,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model: 'test-model' })
                }
            ],
            [
                `${BASE_URL}/conversation-1`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        messages: [
                            { role: 'user', content: 'Hello assistant' },
                            { role: 'assistant', content: 'Hello from the assistant' }
                        ],
                        model: 'test-model',
                        usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 }
                    })
                }
            ],
            [`${BASE_URL}/conversation-1`, { method: 'GET' }]
        ]);
    });

    it('refreshes the selected conversation through identified GET', async () => {
        renderApp();
        await waitForModelSelection();

        fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Hello assistant' } });
        fireEvent.click(screen.getByTestId('send-chat-button'));
        await waitFor(() => expect(screen.getByTestId('chat-tab-conversation-1')).toBeDefined());

        fireEvent.click(screen.getByTestId('refresh-chats-button'));

        await waitFor(() => expect((fetch as any).mock.calls).toHaveLength(6));
        expect((fetch as any).mock.calls[5]).toEqual([`${BASE_URL}/conversation-1`, { method: 'GET' }]);
    });

    it('sends the entire history to the newly selected model regardless of prior turns', async () => {
        renderApp();
        await waitForModelSelection();

        // First turn completes against the default model.
        fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Hello assistant' } });
        fireEvent.click(screen.getByTestId('send-chat-button'));
        await waitFor(() => expect(screen.getByTestId('chat-tab-conversation-1')).toBeDefined());

        // The user overrides the conversation's recorded model through the dropdown.
        fireEvent.change(screen.getByTestId('model-select'), { target: { value: 'other-model' } });
        fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Follow up question' } });
        fireEvent.click(screen.getByTestId('send-chat-button'));

        await waitFor(() => expect((fetch as any).mock.calls).toHaveLength(8));
        // The second provider request carries the full 3-message history under the new model.
        expect((fetch as any).mock.calls[5]).toEqual([
            `${PROVIDER_URL}/chat/completions`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'other-model',
                    stream: false,
                    messages: [
                        { role: 'user', content: 'Hello assistant' },
                        { role: 'assistant', content: 'Hello from the assistant' },
                        { role: 'user', content: 'Follow up question' }
                    ]
                })
            }
        ]);
        // The append records the model that actually produced this turn.
        expect((fetch as any).mock.calls[6]).toEqual([
            `${BASE_URL}/conversation-1`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: [
                        { role: 'user', content: 'Follow up question' },
                        { role: 'assistant', content: 'Hello from the assistant' }
                    ],
                    model: 'other-model',
                    usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 }
                })
            }
        ]);
    });

    it('restores the conversation model when a chat is selected', async () => {
        renderApp();
        await waitForModelSelection();

        fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Hello assistant' } });
        fireEvent.click(screen.getByTestId('send-chat-button'));
        await waitFor(() => expect(screen.getByTestId('chat-tab-conversation-1')).toBeDefined());

        // Switch the dropdown away, then reselect the conversation: its recorded
        // model becomes the selected model again.
        fireEvent.change(screen.getByTestId('model-select'), { target: { value: 'other-model' } });
        expect((screen.getByTestId('model-select') as HTMLSelectElement).value).toBe('other-model');
        fireEvent.click(screen.getByTestId('chat-tab-conversation-1'));

        await waitFor(() =>
            expect((screen.getByTestId('model-select') as HTMLSelectElement).value).toBe('test-model')
        );
    });

    it('keeps the composer text and saves nothing when the provider fails', async () => {
        vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
            if (url.endsWith('/models')) return Promise.resolve(response(200, catalog));
            if (url.endsWith('/chat/completions')) return Promise.resolve(response(500, { error: 'provider exploded' }));
            return Promise.resolve(response(404, { error: 'unexpected request' }));
        }));
        renderApp();
        await waitForModelSelection();

        fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Hello assistant' } });
        fireEvent.click(screen.getByTestId('send-chat-button'));

        await waitFor(() => expect(screen.getByTestId('chat-error').textContent).toBe('provider exploded'));
        // Nothing was persisted: only the catalog and the failed completion ran.
        expect((fetch as any).mock.calls).toEqual([
            [`${PROVIDER_URL}/models`, { method: 'GET' }],
            [
                `${PROVIDER_URL}/chat/completions`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: 'test-model',
                        stream: false,
                        messages: [{ role: 'user', content: 'Hello assistant' }]
                    })
                }
            ]
        ]);
        // The pending user turn remains in the composer for a retry.
        expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe('Hello assistant');
    });
});
