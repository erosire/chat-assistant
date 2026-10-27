// Deterministic tests for the collection and identified conversation API clients.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    addToConversation,
    createConversation,
    deleteConversation,
    fetchConversation,
    isConversationPending,
    listConversations,
    readTrackedConversationIds,
    replaceConversationMessages,
    trackConversationId,
    TRACKED_CONVERSATIONS_KEY,
    untrackConversationId,
    type ConversationSummary
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

    it('lists conversations through the collection GET without a trailing slash change', async () => {
        // Trailing slash on the configured base is normalized away, matching the
        // identified-resource callers below.
        const summary: ConversationSummary = {
            conversationId: 'conversation-1',
            title: 'Hello assistant',
            model: 'test-model',
            status: 'complete',
            messageCount: 2,
            createdAt: '2026-08-06T00:00:00.000Z',
            updatedAt: '2026-08-06T00:00:01.000Z'
        };
        (fetch as any).mockResolvedValueOnce(response(200, { conversations: [summary] }));

        const result = await listConversations('http://test.local/v1/chat-assistant/conversation/');

        expect(result).toEqual({ conversations: [summary] });
        expect(fetch).toHaveBeenCalledWith('http://test.local/v1/chat-assistant/conversation', { method: 'GET' });
    });

    it('rejects a conversation list response without a conversations array', async () => {
        (fetch as any).mockResolvedValueOnce(response(200, {}));

        await expect(listConversations('/v1/chat-assistant/conversation'))
            .rejects.toThrow('Conversation list response did not include a conversations list');
    });

    it('surfaces the server error message for a failed collection list', async () => {
        (fetch as any).mockResolvedValueOnce(response(500, { error: 'store unreadable' }));

        await expect(listConversations('/v1/chat-assistant/conversation'))
            .rejects.toThrow('store unreadable');
    });

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

    it('creates a fork with the supplied complete history and source model', async () => {
        // Forking is a collection POST rather than an identified PUT: the source
        // conversation remains untouched while the server receives the exact
        // prefix through the selected user/assistant interval.
        (fetch as any).mockResolvedValueOnce(response(201, { conversationId: 'conversation-fork' }));
        const messages = [
            { role: 'user' as const, content: 'Hello assistant' },
            { role: 'assistant' as const, content: 'Hello user', model: 'test-model' }
        ];

        const result = await createConversation(
            'http://test.local/v1/chat-assistant/conversation',
            { messages, model: 'test-model' }
        );

        expect(result).toEqual({ conversationId: 'conversation-fork' });
        expect(fetch).toHaveBeenCalledWith('http://test.local/v1/chat-assistant/conversation', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages, model: 'test-model' })
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

    it('replaces the complete history through the identified PUT and returns the record', async () => {
        // The edit-history flow sends every message (including per-message model
        // attribution) and receives the canonical updated record back.
        const messages = [
            { role: 'user' as const, content: 'Edited question' },
            { role: 'assistant' as const, content: 'Edited answer', model: 'zeta-org/test-model' }
        ];
        (fetch as any).mockResolvedValueOnce(response(200, {
            conversationId: conversation.conversationId,
            conversation: { ...conversation, messages, messageCount: 2 }
        }));

        const result = await replaceConversationMessages(
            'http://test.local/v1/chat-assistant/conversation/',
            'conversation-1',
            { messages }
        );

        expect(result).toEqual({
            conversationId: 'conversation-1',
            conversation: { ...conversation, messages, messageCount: 2 }
        });
        expect(fetch).toHaveBeenCalledWith(
            'http://test.local/v1/chat-assistant/conversation/conversation-1',
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages })
            }
        );
    });

    it('surfaces the server error message for a failed history replacement', async () => {
        (fetch as any).mockResolvedValueOnce(response(404, { error: "Conversation 'missing' not found" }));

        await expect(replaceConversationMessages('/v1/chat-assistant/conversation', 'missing', { messages: [] }))
            .rejects.toThrow("Conversation 'missing' not found");
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

describe('tracked conversation ids (the browser-owned cache)', () => {
    // The cache is the online sidebar's authority: only ids this browser created
    // are ever listed, so a server-wide history never leaks into it.
    beforeEach(() => {
        window.localStorage.clear();
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => {
        window.localStorage.clear();
        vi.unstubAllGlobals();
    });

    it('starts empty and round-trips tracked ids through localStorage', () => {
        expect(readTrackedConversationIds()).toEqual([]);

        expect(trackConversationId('conversation-1')).toEqual(['conversation-1']);
        expect(trackConversationId('conversation-2')).toEqual(['conversation-1', 'conversation-2']);
        // Re-tracking an existing id never duplicates it (a restored chat that
        // receives another turn stays one entry).
        expect(trackConversationId('conversation-1')).toEqual(['conversation-1', 'conversation-2']);
        expect(readTrackedConversationIds()).toEqual(['conversation-1', 'conversation-2']);

        expect(untrackConversationId('conversation-1')).toEqual(['conversation-2']);
        expect(readTrackedConversationIds()).toEqual(['conversation-2']);
    });

    it('degrades corrupt or foreign cache contents to a clean id list', () => {
        window.localStorage.setItem(TRACKED_CONVERSATIONS_KEY, 'not json');
        expect(readTrackedConversationIds()).toEqual([]);

        window.localStorage.setItem(TRACKED_CONVERSATIONS_KEY, JSON.stringify(['a', '', 3, null, 'a', 'b']));
        expect(readTrackedConversationIds()).toEqual(['a', 'b']);
    });

    it('asks the server for exactly the tracked ids', async () => {
        const summary: ConversationSummary = {
            conversationId: 'conversation-1',
            title: 'Hello assistant',
            model: 'test-model',
            status: 'complete',
            messageCount: 2,
            createdAt: '2026-08-06T00:00:00.000Z',
            updatedAt: '2026-08-06T00:00:01.000Z'
        };
        (fetch as any).mockResolvedValueOnce(response(200, { conversations: [summary] }));

        const result = await listConversations('http://test.local/v1/chat-assistant/conversation', ['conversation-1', 'conversation-2']);

        expect(result).toEqual({ conversations: [summary] });
        expect(fetch).toHaveBeenCalledWith(
            'http://test.local/v1/chat-assistant/conversation?ids=conversation-1%2Cconversation-2',
            { method: 'GET' }
        );
    });

    it('sends an empty filter (matching nothing) when the browser owns no ids', async () => {
        (fetch as any).mockResolvedValueOnce(response(200, { conversations: [] }));

        const result = await listConversations('http://test.local/v1/chat-assistant/conversation', []);

        expect(result).toEqual({ conversations: [] });
        expect(fetch).toHaveBeenCalledWith(
            'http://test.local/v1/chat-assistant/conversation?ids=',
            { method: 'GET' }
        );
    });

    it('keeps the unfiltered collection URL when no ids are supplied (tooling)', async () => {
        (fetch as any).mockResolvedValueOnce(response(200, { conversations: [] }));

        await listConversations('http://test.local/v1/chat-assistant/conversation');

        expect(fetch).toHaveBeenCalledWith(
            'http://test.local/v1/chat-assistant/conversation',
            { method: 'GET' }
        );
    });

    it('treats only the pending status as needing a poll', () => {
        expect(isConversationPending('pending')).toBe(true);
        expect(isConversationPending('complete')).toBe(false);
        expect(isConversationPending('error')).toBe(false);
    });
});
