// Deterministic tests for the collection and identified conversation API clients.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    addToConversation,
    createConversation,
    deleteConversation,
    fetchConversation
} from './chat-assistant';

// A small Response substitute keeps these tests independent from browser network implementations.
const response = (status: number, body: unknown) =>
    ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body
    }) as Response;

// Shared exact record verifies the GET response without relying on partial assertions.
const conversation = {
    conversationId: 'conversation-1',
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

describe('conversation API client', () => {
    // Each case receives an isolated fetch mock so URL and payload assertions cannot leak.
    beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
    afterEach(() => vi.unstubAllGlobals());

    it('creates a conversation at the collection URL and returns its identifier', async () => {
        (fetch as any).mockResolvedValueOnce(response(201, { conversationId: conversation.conversationId }));

        const result = await createConversation('http://test.local/v1/chat-assistant/conversation/', {});

        expect(result).toEqual({ conversationId: 'conversation-1' });
        expect(fetch).toHaveBeenCalledWith('http://test.local/v1/chat-assistant/conversation', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
        });
    });

    it('gets a conversation through the encoded conversation_id path parameter', async () => {
        (fetch as any).mockResolvedValueOnce(response(200, {
            conversationId: conversation.conversationId,
            conversation
        }));

        const result = await fetchConversation(
            'http://test.local/v1/chat-assistant/conversation/',
            'conversation/a b'
        );

        expect(result).toEqual({ conversationId: conversation.conversationId, conversation });
        expect(fetch).toHaveBeenCalledWith(
            'http://test.local/v1/chat-assistant/conversation/conversation%2Fa%20b',
            { method: 'GET' }
        );
    });

    it('posts an additional message to the identified conversation resource', async () => {
        (fetch as any).mockResolvedValueOnce(response(200, { conversationId: 'conversation-1' }));

        const result = await addToConversation(
            'http://test.local/v1/chat-assistant/conversation',
            'conversation-1',
            { message: 'Follow up' }
        );

        expect(result).toEqual({ conversationId: 'conversation-1' });
        expect(fetch).toHaveBeenCalledWith(
            'http://test.local/v1/chat-assistant/conversation/conversation-1',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: 'Follow up' })
            }
        );
    });

    it('deletes the complete identified conversation', async () => {
        (fetch as any).mockResolvedValueOnce(response(200, { conversationId: 'conversation-1' }));

        const result = await deleteConversation(
            'http://test.local/v1/chat-assistant/conversation/',
            'conversation-1'
        );

        expect(result).toEqual({ conversationId: 'conversation-1' });
        expect(fetch).toHaveBeenCalledWith(
            'http://test.local/v1/chat-assistant/conversation/conversation-1',
            { method: 'DELETE' }
        );
    });

    it('surfaces the server error message for a failed identified-resource request', async () => {
        (fetch as any).mockResolvedValueOnce(response(404, { error: "Conversation 'missing' not found" }));

        await expect(fetchConversation('/v1/chat-assistant/conversation', 'missing'))
            .rejects.toThrow("Conversation 'missing' not found");
    });
});
