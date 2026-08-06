// Deterministic integration tests for the conversation-resource dashboard.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatAssistantApp } from './ChatAssistantApp';

// Response helper models the exact collection POST, identified POST, and identified GET shapes.
const response = (status: number, body: unknown) =>
    ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body
    }) as Response;

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

describe('ChatAssistantApp', () => {
    // The focused API has no collection GET; initial render therefore starts empty.
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
            if (init?.method === 'POST' && url.endsWith('/conversation')) {
                return Promise.resolve(response(201, { conversationId: conversation.conversationId }));
            }
            if (init?.method === 'POST') {
                return Promise.resolve(response(200, { conversationId: conversation.conversationId }));
            }
            if (init?.method === 'GET') {
                return Promise.resolve(response(200, {
                    conversationId: conversation.conversationId,
                    conversation
                }));
            }
            return Promise.resolve(response(404, { error: 'unexpected request' }));
        }));
    });
    afterEach(() => vi.unstubAllGlobals());

    it('renders the empty conversation and composer without a collection GET', async () => {
        render(<ChatAssistantApp baseUrl="http://test.local/v1/chat-assistant/conversation" />);

        expect(screen.getByTestId('chat-assistant')).toBeDefined();
        expect(screen.getByTestId('empty-chat-state').textContent).toContain('Start a conversation');
        const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
        expect(input).toBeDefined();
        expect(input.getAttribute('rows')).toBeNull();
        expect(window.getComputedStyle(input).resize).toBe('none');
        expect(screen.getByTestId('send-chat-button')).toBeDefined();
        expect(fetch).not.toHaveBeenCalled();
    });

    it('grows the message input from its content and keeps mouse resizing disabled', async () => {
        render(<ChatAssistantApp baseUrl="http://test.local/v1/chat-assistant/conversation" />);

        const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
        Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 72 });
        fireEvent.change(input, { target: { value: 'Two rows of text' } });

        await waitFor(() => expect(input.style.height).toBe('72px'));
        expect(window.getComputedStyle(input).resize).toBe('none');
    });

    it('caps the auto-growing message input at eight line heights', async () => {
        render(<ChatAssistantApp baseUrl="http://test.local/v1/chat-assistant/conversation" />);

        const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
        Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 1000 });
        fireEvent.change(input, { target: { value: 'A long message' } });

        await waitFor(() => expect(input.style.height).toBe('203.2px'));
        expect(window.getComputedStyle(input).overflowY).toBe('auto');
    });

    it('keeps an empty message input at one row instead of collapsing it', async () => {
        render(<ChatAssistantApp baseUrl="http://test.local/v1/chat-assistant/conversation" />);

        const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
        Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 0 });
        fireEvent.change(input, { target: { value: '' } });

        await waitFor(() => expect(input.style.height).toBe('46.4px'));
    });

    it('creates an identifier, appends the message, and GETs the returned conversation', async () => {
        render(<ChatAssistantApp baseUrl="http://test.local/v1/chat-assistant/conversation" />);

        fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Hello assistant' } });
        fireEvent.click(screen.getByTestId('send-chat-button'));

        await waitFor(() => expect(screen.getByText('Hello from the assistant')).toBeDefined());
        expect(screen.getAllByText('Hello assistant')).toHaveLength(2);
        expect(screen.getByTestId('chat-tab-conversation-1')).toBeDefined();

        const calls = (fetch as any).mock.calls as Array<[string, RequestInit]>;
        expect(calls).toEqual([
            [
                'http://test.local/v1/chat-assistant/conversation',
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: '{}'
                }
            ],
            [
                'http://test.local/v1/chat-assistant/conversation/conversation-1',
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message: 'Hello assistant' })
                }
            ],
            [
                'http://test.local/v1/chat-assistant/conversation/conversation-1',
                { method: 'GET' }
            ]
        ]);
    });

    it('refreshes the selected conversation through identified GET', async () => {
        render(<ChatAssistantApp baseUrl="http://test.local/v1/chat-assistant/conversation" />);

        fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Hello assistant' } });
        fireEvent.click(screen.getByTestId('send-chat-button'));
        await waitFor(() => expect(screen.getByTestId('chat-tab-conversation-1')).toBeDefined());

        fireEvent.click(screen.getByTestId('refresh-chats-button'));

        await waitFor(() => expect((fetch as any).mock.calls).toHaveLength(4));
        expect((fetch as any).mock.calls[3]).toEqual([
            'http://test.local/v1/chat-assistant/conversation/conversation-1',
            { method: 'GET' }
        ]);
    });
});
