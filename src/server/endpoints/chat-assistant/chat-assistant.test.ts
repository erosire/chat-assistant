// Deterministic direct-handler tests for the conversation storage contract.
// The service is pure storage: no assistant/provider seam exists here anymore;
// completed user+assistant turns arrive in the request body and are persisted.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationRecord } from '../../../api';
import {
    conversationCreate,
    conversationDelete,
    conversationGet,
    conversationPost
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
const variables = (chatStore: ChatStore, conversationId?: () => string) => ({ chatStore, conversationId });

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
            variables(store, () => 'conversation-created')
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

    it('appends the completed user+assistant pair, model, and usage to the record', async () => {
        vi.setSystemTime(new Date('2026-08-06T00:00:10.000Z'));
        const store = memoryStore([existingConversation]);

        const result = await conversationPost(
            context,
            {
                path: { conversation_id: 'conversation-1' },
                query: {},
                body: {
                    messages: [
                        { role: 'user', content: 'Follow up' },
                        { role: 'assistant', content: 'Exact assistant reply' }
                    ],
                    model: 'test-model',
                    usage: { total_tokens: 12 }
                }
            },
            variables(store)
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
    });

    it('records the new model when the turn was produced by a different model', async () => {
        vi.setSystemTime(new Date('2026-08-06T00:00:10.000Z'));
        const store = memoryStore([existingConversation]);

        const result = await conversationPost(
            context,
            {
                path: { conversation_id: 'conversation-1' },
                query: {},
                body: {
                    messages: [
                        { role: 'user', content: 'Follow up' },
                        { role: 'assistant', content: 'Other model reply' }
                    ],
                    model: 'qwen/makora-pro'
                }
            },
            variables(store)
        );

        expect(result).toEqual({
            status: 200,
            response: {
                conversationId: 'conversation-1',
                conversation: {
                    ...existingConversation,
                    model: 'qwen/makora-pro',
                    messageCount: 4,
                    messages: [
                        { role: 'user', content: 'First question' },
                        { role: 'assistant', content: 'First answer' },
                        { role: 'user', content: 'Follow up' },
                        { role: 'assistant', content: 'Other model reply' }
                    ],
                    updatedAt: '2026-08-06T00:00:10.000Z'
                }
            }
        });
    });

    it('derives the title from the first stored user turn on an empty conversation', async () => {
        vi.setSystemTime(new Date('2026-08-06T00:00:00.000Z'));
        const store = memoryStore();
        await conversationCreate(
            context,
            { path: {}, query: {}, body: {} },
            variables(store, () => 'conversation-created')
        );

        vi.setSystemTime(new Date('2026-08-06T00:00:05.000Z'));
        const result = await conversationPost(
            context,
            {
                path: { conversation_id: 'conversation-created' },
                query: {},
                body: { message: 'What is the meaning of life?' }
            },
            variables(store)
        );

        expect(result).toEqual({
            status: 200,
            response: {
                conversationId: 'conversation-created',
                conversation: {
                    conversationId: 'conversation-created',
                    title: 'What is the meaning of life?',
                    model: 'openai/gpt-5.6-sol',
                    status: 'complete',
                    messageCount: 1,
                    messages: [{ role: 'user', content: 'What is the meaning of life?' }],
                    createdAt: '2026-08-06T00:00:00.000Z',
                    updatedAt: '2026-08-06T00:00:05.000Z'
                }
            }
        });
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

    it('rejects invalid additions before persisting anything', async () => {
        const store = memoryStore([existingConversation]);

        const result = await conversationPost(
            context,
            {
                path: { conversation_id: 'conversation-1' },
                query: {},
                body: { messages: [{ role: 'user', content: '' }] }
            },
            variables(store)
        );

        expect(result).toEqual({ status: 400, response: { error: 'messages must be an array of valid chat messages' } });
        expect(store.get('conversation-1')).toEqual(existingConversation);
    });

    it('rejects non-numeric usage counters', async () => {
        const store = memoryStore([existingConversation]);

        const result = await conversationPost(
            context,
            {
                path: { conversation_id: 'conversation-1' },
                query: {},
                body: { message: 'Follow up', usage: { total_tokens: 'many' as unknown as number } }
            },
            variables(store)
        );

        expect(result).toEqual({ status: 400, response: { error: 'usage must contain only numeric token counters' } });
        expect(store.get('conversation-1')).toEqual(existingConversation);
    });
});
