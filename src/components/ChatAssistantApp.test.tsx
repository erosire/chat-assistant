// Deterministic integration tests for the chat dashboard.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatAssistantApp } from './ChatAssistantApp';

// Response helper models the exact list and POST shapes consumed by the API client.
const response = (status: number, body: unknown) =>
    ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body
    }) as Response;

// The completed record returned from POST is reused by the GET read branch.
const chat = {
    chatId: 'chat-1',
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

describe('ChatAssistantApp', () => {
    // The initial list request is always deterministic; individual tests add POST behavior.
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
            if (init?.method === 'POST') return Promise.resolve(response(200, { chatId: chat.chatId, chat }));
            if (url.includes('chatId=')) return Promise.resolve(response(200, { chat }));
            return Promise.resolve(response(200, { chats: [] }));
        }));
    });
    afterEach(() => vi.unstubAllGlobals());

    it('renders the empty conversation and composer', async () => {
        render(<ChatAssistantApp baseUrl="http://test.local/v1/chat-assistant/" />);

        expect(screen.getByTestId('chat-assistant')).toBeDefined();
        expect(screen.getByTestId('empty-chat-state').textContent).toContain('Start a conversation');
        const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
        expect(input).toBeDefined();
        expect(input.getAttribute('rows')).toBeNull();
        expect(window.getComputedStyle(input).resize).toBe('none');
        expect(screen.getByTestId('send-chat-button')).toBeDefined();
        await waitFor(() => expect(screen.getByTestId('empty-chat-list').textContent).toBe('No chats yet.'));
    });

    it('grows the message input from its content and keeps mouse resizing disabled', async () => {
        render(<ChatAssistantApp baseUrl="http://test.local/v1/chat-assistant/" />);

        const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
        Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 72 });
        fireEvent.change(input, { target: { value: 'Two rows of text' } });

        await waitFor(() => expect(input.style.height).toBe('72px'));
        expect(window.getComputedStyle(input).resize).toBe('none');
    });

    it('caps the auto-growing message input at eight line heights', async () => {
        render(<ChatAssistantApp baseUrl="http://test.local/v1/chat-assistant/" />);

        const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
        Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 1000 });
        fireEvent.change(input, { target: { value: 'A long message' } });

        // jsdom reports the component's 22.4px fallback line height and 24px vertical padding.
        await waitFor(() => expect(input.style.height).toBe('203.2px'));
        expect(window.getComputedStyle(input).overflowY).toBe('auto');
    });

    it('keeps an empty message input at one row instead of collapsing it', async () => {
        render(<ChatAssistantApp baseUrl="http://test.local/v1/chat-assistant/" />);

        const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
        Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 0 });

        fireEvent.change(input, { target: { value: '' } });

        await waitFor(() => expect(input.style.height).toBe('46.4px'));
    });

    it('POSTs the message and renders the returned user and assistant turns', async () => {
        render(<ChatAssistantApp baseUrl="http://test.local/v1/chat-assistant/" />);

        fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Hello assistant' } });
        fireEvent.click(screen.getByTestId('send-chat-button'));

        await waitFor(() => expect(screen.getByText('Hello from the assistant')).toBeDefined());
        expect(screen.getAllByText('Hello assistant')).toHaveLength(2);
        expect(screen.getByTestId('chat-tab-chat-1')).toBeDefined();

        const post = (fetch as any).mock.calls.find((call: [string, RequestInit]) => call[1]?.method === 'POST');
        expect(post).toBeDefined();
        expect(JSON.parse(post[1].body as string)).toEqual({ message: 'Hello assistant' });
    });

    it('loads a server-provided chat list and selects its first conversation', async () => {
        (fetch as any).mockImplementation((url: string, init?: RequestInit) => {
            if (url.includes('chatId=')) return Promise.resolve(response(200, { chat }));
            return Promise.resolve(response(200, {
                chats: [{
                    chatId: chat.chatId,
                    title: chat.title,
                    model: chat.model,
                    status: chat.status,
                    messageCount: chat.messageCount,
                    createdAt: chat.createdAt,
                    updatedAt: chat.updatedAt
                }]
            }));
        });

        render(<ChatAssistantApp baseUrl="http://test.local/v1/chat-assistant/" />);

        await waitFor(() => expect(screen.getByText('Hello from the assistant')).toBeDefined());
        expect(screen.getByTestId('chat-tab-chat-1').getAttribute('aria-pressed')).toBe('true');
    });
});
