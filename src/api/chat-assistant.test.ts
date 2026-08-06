// Deterministic tests for the browser API client.
// The mocked responses mirror the documented GET list, GET record, and POST wire shapes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChat, fetchChat, fetchChatList } from './chat-assistant';

// A small Response substitute keeps these tests independent from network implementations.
const response = (status: number, body: unknown) =>
    ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body
    }) as Response;

// Shared exact record used by GET and POST assertions.
const record = {
    chatId: 'chat-1',
    title: 'Hello assistant',
    model: 'test-model',
    status: 'complete' as const,
    messageCount: 2,
    messages: [
        { role: 'user' as const, content: 'Hello assistant' },
        { role: 'assistant' as const, content: 'Hello user' }
    ],
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:01.000Z'
};

describe('chat assistant API client', () => {
    // Each test receives a fresh fetch mock so URL and payload assertions cannot leak between cases.
    beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
    afterEach(() => vi.unstubAllGlobals());

    it('fetches the compact chat list from the trailing-slash collection URL', async () => {
        const chats = [{
            chatId: record.chatId,
            title: record.title,
            model: record.model,
            status: record.status,
            messageCount: record.messageCount,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt
        }];
        (fetch as any).mockResolvedValueOnce(response(200, { chats }));

        const result = await fetchChatList('http://test.local/v1/chat-assistant/');

        expect(result).toEqual({ chats });
        expect(fetch).toHaveBeenCalledWith('http://test.local/v1/chat-assistant/', { method: 'GET' });
    });

    it('fetches one complete chat with an encoded chatId query parameter', async () => {
        (fetch as any).mockResolvedValueOnce(response(200, { chat: record }));

        const result = await fetchChat('http://test.local/v1/chat-assistant/', 'chat/a b');

        expect(result).toEqual(record);
        expect(fetch).toHaveBeenCalledWith(
            'http://test.local/v1/chat-assistant/?chatId=chat%2Fa+b',
            { method: 'GET' }
        );
    });

    it('posts a message and returns the completed conversation', async () => {
        (fetch as any).mockResolvedValueOnce(response(200, { chatId: record.chatId, chat: record }));

        const result = await createChat('http://test.local/v1/chat-assistant', {
            chatId: record.chatId,
            message: 'Hello assistant'
        });

        expect(result).toEqual({ chatId: record.chatId, chat: record });
        expect(fetch).toHaveBeenCalledWith('http://test.local/v1/chat-assistant/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatId: record.chatId, message: 'Hello assistant' })
        });
    });

    it('surfaces the server error message for a failed request', async () => {
        (fetch as any).mockResolvedValueOnce(response(400, { error: 'message or messages is required' }));

        await expect(createChat('/v1/chat-assistant/', {})).rejects.toThrow('message or messages is required');
    });
});
