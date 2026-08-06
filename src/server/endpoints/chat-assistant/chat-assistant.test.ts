// Deterministic direct-handler tests for the conversation resource contract.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ConversationRecord } from '../../../api';
import {
    conversationCreate,
    conversationDelete,
    conversationGet,
    conversationPost,
    requestAssistantReply
} from './chat-assistant';
import type { ChatStore } from './chat-store';

// In-memory store gives handlers the same CRUD seam as the disk store without filesystem side effects.
const memoryStore = (initial: ConversationRecord[] = []): ChatStore => {
    const records = [...initial];
    return {
        list: () => records.map((record) => ({ ...record, messages: [...record.messages] })),
        get: (conversationId) => {
            const record = records.find((candidate) => candidate.conversationId === conversationId);
            return record ? { ...record, messages: [...record.messages] } : null;
        },
        upsert: (record) => {
            const index = records.findIndex((candidate) => candidate.conversationId === record.conversationId);
            if (index < 0) records.push({ ...record, messages: [...record.messages] });
            else records[index] = { ...record, messages: [...record.messages] };
            return { ...record, messages: [...record.messages] };
        },
        delete: (conversationId) => {
            const index = records.findIndex((candidate) => candidate.conversationId === conversationId);
            if (index < 0) return false;
            records.splice(index, 1);
            return true;
        }
    };
};

// Stable request context and dependency injection make each response exactly assertable.
const context = { req: { method: 'GET' } } as any;
const variables = (
    chatStore: ChatStore,
    assistantReply = async () => ({ content: 'Exact assistant reply' }),
    conversationId?: () => string
) => ({ chatStore, assistantReply, conversationId });

// A complete stored record is reused by GET, append, and DELETE tests.
const existingConversation: ConversationRecord = {
    conversationId: 'conversation-1',
    title: 'First question',
    model: 'test-model',
    status: 'complete',
    messageCount: 2,
    messages: [
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: 'First answer' }
    ],
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:01.000Z'
};

describe('conversation service handlers', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('creates an empty conversation and returns only its conversationId', async () => {
        vi.setSystemTime(new Date('2026-08-06T00:00:00.000Z'));
        const store = memoryStore();

        const result = await conversationCreate(
            context,
            { path: {}, query: {}, body: {} },
            variables(store, undefined, () => 'conversation-created')
        );

        expect(result).toEqual({ status: 201, response: { conversationId: 'conversation-created' } });
        expect(store.get('conversation-created')).toEqual({
            conversationId: 'conversation-created',
            title: 'New conversation',
            model: 'openai/gpt-5.6-sol',
            status: 'complete',
            messageCount: 0,
            messages: [],
            createdAt: '2026-08-06T00:00:00.000Z',
            updatedAt: '2026-08-06T00:00:00.000Z'
        });
    });

    it('gets an identified conversation from the path parameter', async () => {
        const result = await conversationGet(
            context,
            { path: { conversation_id: 'conversation-1' }, query: {}, body: {} },
            variables(memoryStore([existingConversation]))
        );

        expect(result).toEqual({
            status: 200,
            response: { conversationId: 'conversation-1', conversation: existingConversation }
        });
    });

    it('adds a message and persists the assistant turn on the identified resource', async () => {
        vi.setSystemTime(new Date('2026-08-06T00:00:10.000Z'));
        const store = memoryStore([existingConversation]);
        const received: ChatMessage[][] = [];
        const assistantReply = async (messages: ChatMessage[], model: string) => {
            received.push(messages);
            expect(model).toBe('test-model');
            return { content: 'Exact assistant reply', usage: { total_tokens: 12 } };
        };

        const result = await conversationPost(
            context,
            {
                path: { conversation_id: 'conversation-1' },
                query: {},
                body: { message: 'Follow up' }
            },
            variables(store, assistantReply)
        );

        expect(result).toEqual({
            status: 200,
            response: {
                conversationId: 'conversation-1',
                conversation: {
                    ...existingConversation,
                    messageCount: 4,
                    messages: [
                        { role: 'user', content: 'First question' },
                        { role: 'assistant', content: 'First answer' },
                        { role: 'user', content: 'Follow up' },
                        { role: 'assistant', content: 'Exact assistant reply' }
                    ],
                    updatedAt: '2026-08-06T00:00:10.000Z',
                    usage: { total_tokens: 12 }
                }
            }
        });
        expect(received).toEqual([[
            { role: 'user', content: 'First question' },
            { role: 'assistant', content: 'First answer' },
            { role: 'user', content: 'Follow up' }
        ]]);
    });

    it('deletes an identified conversation completely', async () => {
        const store = memoryStore([existingConversation]);

        const result = await conversationDelete(
            context,
            { path: { conversation_id: 'conversation-1' }, query: {}, body: {} },
            variables(store)
        );

        expect(result).toEqual({ status: 200, response: { conversationId: 'conversation-1' } });
        expect(store.get('conversation-1')).toBeNull();
    });

    it('returns not found for a missing conversation on GET, POST, and DELETE', async () => {
        const store = memoryStore();
        const parameters = { path: { conversation_id: 'missing' }, query: {}, body: { message: 'Question' } };

        expect(await conversationGet(context, parameters, variables(store))).toEqual({
            status: 404,
            response: { error: "Conversation 'missing' not found" }
        });
        expect(await conversationPost(context, parameters, variables(store))).toEqual({
            status: 404,
            response: { error: "Conversation 'missing' not found" }
        });
        expect(await conversationDelete(context, parameters, variables(store))).toEqual({
            status: 404,
            response: { error: "Conversation 'missing' not found" }
        });
    });

    it('rejects invalid additions before contacting the assistant', async () => {
        const assistantReply = vi.fn(async () => ({ content: 'should not run' }));

        const result = await conversationPost(
            context,
            {
                path: { conversation_id: 'conversation-1' },
                query: {},
                body: { messages: [{ role: 'user', content: '' }] }
            },
            variables(memoryStore([existingConversation]), assistantReply)
        );

        expect(result).toEqual({ status: 400, response: { error: 'messages must be an array of valid chat messages' } });
        expect(assistantReply).not.toHaveBeenCalled();
    });

    it('requests text from the OpenAI-compatible assistant upstream', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                choices: [{ message: { content: 'Upstream answer' } }],
                usage: { total_tokens: 9 }
            })
        })));

        const result = await requestAssistantReply(
            [{ role: 'user', content: 'Upstream question' }],
            'test-model',
            'http://provider.local/v1/'
        );

        expect(result).toEqual({ content: 'Upstream answer', usage: { total_tokens: 9 } });
        expect(fetch).toHaveBeenCalledWith('http://provider.local/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'test-model',
                stream: false,
                messages: [{ role: 'user', content: 'Upstream question' }]
            })
        });
    });
});
