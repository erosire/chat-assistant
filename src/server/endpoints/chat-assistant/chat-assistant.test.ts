// Deterministic direct-handler tests for the conversation storage contract.
// The service is pure storage: no assistant/provider seam exists here anymore;
// completed user+assistant turns arrive in the request body and are persisted.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationRecord } from '../../../api';
import {
    conversationCreate,
    conversationDelete,
    conversationGet,
    conversationList,
    conversationPost,
    conversationPut
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

    it('creates a fork from a complete history without mutating the source conversation', async () => {
        // The fork request contains the system prompt and every turn through the
        // selected assistant interval. A deterministic id factory proves the new
        // record is separate from the source while exact timestamps and metadata
        // prove the copied prefix is persisted as submitted.
        vi.setSystemTime(new Date('2026-08-06T00:00:10.000Z'));
        const store = memoryStore([existingConversation]);
        const forkMessages = [
            { role: 'system' as const, content: 'You are concise.' },
            { role: 'user' as const, content: 'First question' },
            { role: 'assistant' as const, content: 'First answer', model: 'test-model' }
        ];

        const result = await conversationCreate(
            context,
            {
                path: {},
                query: {},
                body: { messages: forkMessages, model: 'test-model' }
            },
            variables(store, () => 'conversation-fork')
        );

        expect(result).toEqual({ status: 201, response: { conversationId: 'conversation-fork' } });
        expect(store.get('conversation-fork')).toEqual({
            conversationId: 'conversation-fork',
            title: 'First question',
            model: 'test-model',
            status: 'complete',
            messageCount: 3,
            messages: forkMessages,
            createdAt: '2026-08-06T00:00:10.000Z',
            updatedAt: '2026-08-06T00:00:10.000Z'
        });
        // A fork is additive: the original conversation and its complete history
        // are still present byte-for-byte in the injected store.
        expect(store.get('conversation-1')).toEqual(existingConversation);
    });

    it('lists persisted conversations as summaries ordered by most recent activity', async () => {
        // Older and newer records interleave creation order with activity order so
        // the updatedAt-descending sort is what the assertion actually verifies.
        const olderConversation: ConversationRecord = {
            conversationId: 'conversation-old',
            title: 'Old question',
            model: 'test-model',
            status: 'complete',
            messageCount: 1,
            messages: [{ role: 'user', content: 'Old question' }],
            createdAt: '2026-08-05T00:00:00.000Z',
            updatedAt: '2026-08-05T00:00:01.000Z'
        };
        const store = memoryStore([olderConversation, existingConversation]);

        const result = await conversationList(
            context,
            { path: {}, query: {}, body: {} },
            variables(store)
        );

        // Summaries exclude message bodies; the recently updated record leads.
        expect(result).toEqual({
            status: 200,
            response: {
                conversations: [
                    {
                        conversationId: 'conversation-1',
                        title: 'First question',
                        model: 'test-model',
                        status: 'complete',
                        messageCount: 2,
                        createdAt: '2026-08-06T00:00:00.000Z',
                        updatedAt: '2026-08-06T00:00:01.000Z'
                    },
                    {
                        conversationId: 'conversation-old',
                        title: 'Old question',
                        model: 'test-model',
                        status: 'complete',
                        messageCount: 1,
                        createdAt: '2026-08-05T00:00:00.000Z',
                        updatedAt: '2026-08-05T00:00:01.000Z'
                    }
                ]
            }
        });
    });

    it('returns an empty conversation list when nothing is stored', async () => {
        const result = await conversationList(
            context,
            { path: {}, query: {}, body: {} },
            variables(memoryStore())
        );

        expect(result).toEqual({ status: 200, response: { conversations: [] } });
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

    it('persists the per-message model attribution of an appended assistant turn', async () => {
        // The UI marks which model produced each response by carrying `model` on
        // the assistant message itself; the store must keep it verbatim.
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
                        { role: 'assistant', content: 'Attributed reply', model: 'qwen/makora-pro' }
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
                        { role: 'assistant', content: 'Attributed reply', model: 'qwen/makora-pro' }
                    ],
                    updatedAt: '2026-08-06T00:00:10.000Z'
                }
            }
        });
    });

    it('rejects a blank per-message model attribution', async () => {
        const store = memoryStore([existingConversation]);

        const result = await conversationPost(
            context,
            {
                path: { conversation_id: 'conversation-1' },
                query: {},
                body: {
                    messages: [{ role: 'assistant', content: 'Reply', model: '  ' }, { role: 'user', content: 'Question' }]
                }
            },
            variables(store)
        );

        expect(result).toEqual({ status: 400, response: { error: 'messages must be an array of valid chat messages' } });
        expect(store.get('conversation-1')).toEqual(existingConversation);
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

    it('derives the title when the conversation was created with only a system prompt', async () => {
        vi.setSystemTime(new Date('2026-08-06T00:00:00.000Z'));
        const store = memoryStore();
        await conversationCreate(
            context,
            {
                path: {},
                query: {},
                body: { model: 'test-model', systemPrompt: 'You are concise.' }
            },
            variables(store, () => 'conversation-prompt-only')
        );

        vi.setSystemTime(new Date('2026-08-06T00:00:05.000Z'));
        const result = await conversationPost(
            context,
            {
                path: { conversation_id: 'conversation-prompt-only' },
                query: {},
                body: { messages: [{ role: 'user', content: 'First question' }] }
            },
            variables(store)
        );

        expect(result).toEqual({
            status: 200,
            response: {
                conversationId: 'conversation-prompt-only',
                conversation: {
                    conversationId: 'conversation-prompt-only',
                    title: 'First question',
                    model: 'test-model',
                    status: 'complete',
                    messageCount: 2,
                    messages: [
                        { role: 'system', content: 'You are concise.' },
                        { role: 'user', content: 'First question' }
                    ],
                    createdAt: '2026-08-06T00:00:00.000Z',
                    updatedAt: '2026-08-06T00:00:05.000Z'
                }
            }
        });
    });

    it('replaces the complete history through PUT and recomputes metadata', async () => {
        // The edit-history flow: the whole edited list lands verbatim, messageCount
        // and updatedAt follow, and the title is re-derived from the new first
        // user turn. Per-message attribution survives the replacement.
        vi.setSystemTime(new Date('2026-08-06T00:00:20.000Z'));
        const store = memoryStore([existingConversation]);

        const result = await conversationPut(
            context,
            {
                path: { conversation_id: 'conversation-1' },
                query: {},
                body: {
                    messages: [
                        { role: 'user', content: 'Rewritten question' },
                        { role: 'assistant', content: 'Rewritten answer', model: 'qwen/makora-pro' }
                    ]
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
                    title: 'Rewritten question',
                    messageCount: 2,
                    messages: [
                        { role: 'user', content: 'Rewritten question' },
                        { role: 'assistant', content: 'Rewritten answer', model: 'qwen/makora-pro' }
                    ],
                    updatedAt: '2026-08-06T00:00:20.000Z'
                }
            }
        });
        expect(store.get('conversation-1')?.messages).toEqual([
            { role: 'user', content: 'Rewritten question' },
            { role: 'assistant', content: 'Rewritten answer', model: 'qwen/makora-pro' }
        ]);
    });

    it('drops stale usage counters when the history is replaced', async () => {
        // Usage describes the last appended turn; after a rewrite it no longer
        // matches anything, so the replacement must not carry it forward.
        vi.setSystemTime(new Date('2026-08-06T00:00:20.000Z'));
        const withUsage: ConversationRecord = {
            ...existingConversation,
            usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 }
        };
        const store = memoryStore([withUsage]);

        const result = await conversationPut(
            context,
            {
                path: { conversation_id: 'conversation-1' },
                query: {},
                body: { messages: [{ role: 'user', content: 'Only question now' }] }
            },
            variables(store)
        );

        expect(result).toEqual({
            status: 200,
            response: {
                conversationId: 'conversation-1',
                conversation: {
                    ...existingConversation,
                    title: 'Only question now',
                    messageCount: 1,
                    messages: [{ role: 'user', content: 'Only question now' }],
                    updatedAt: '2026-08-06T00:00:20.000Z'
                    // No usage key: the replacement clears the counters.
                }
            }
        });
    });

    it('keeps the recorded title and model when a replacement has no user turn and no model body', async () => {
        vi.setSystemTime(new Date('2026-08-06T00:00:20.000Z'));
        const store = memoryStore([existingConversation]);

        const result = await conversationPut(
            context,
            {
                path: { conversation_id: 'conversation-1' },
                query: {},
                body: { messages: [{ role: 'assistant', content: 'Only answer' }] }
            },
            variables(store)
        );

        expect(result).toEqual({
            status: 200,
            response: {
                conversationId: 'conversation-1',
                conversation: {
                    ...existingConversation,
                    messageCount: 1,
                    messages: [{ role: 'assistant', content: 'Only answer' }],
                    updatedAt: '2026-08-06T00:00:20.000Z'
                }
            }
        });
    });

    it('wipes the history when the replacement is an empty array', async () => {
        vi.setSystemTime(new Date('2026-08-06T00:00:20.000Z'));
        const store = memoryStore([existingConversation]);

        const result = await conversationPut(
            context,
            { path: { conversation_id: 'conversation-1' }, query: {}, body: { messages: [] } },
            variables(store)
        );

        expect(result).toEqual({
            status: 200,
            response: {
                conversationId: 'conversation-1',
                conversation: {
                    ...existingConversation,
                    messageCount: 0,
                    messages: [],
                    updatedAt: '2026-08-06T00:00:20.000Z'
                }
            }
        });
    });

    it('rejects a replacement request without a valid messages array', async () => {
        const store = memoryStore([existingConversation]);
        const parameters = { path: { conversation_id: 'conversation-1' }, query: {}, body: {} };

        expect(await conversationPut(context, parameters, variables(store))).toEqual({
            status: 400,
            response: { error: 'messages must be an array of valid chat messages' }
        });
        expect(
            await conversationPut(
                context,
                { path: { conversation_id: 'conversation-1' }, query: {}, body: { messages: [{ role: 'user', content: '' }] } },
                variables(store)
            )
        ).toEqual({ status: 400, response: { error: 'messages must be an array of valid chat messages' } });
        expect(store.get('conversation-1')).toEqual(existingConversation);
    });

    it('returns not found for a missing conversation on PUT', async () => {
        const result = await conversationPut(
            context,
            { path: { conversation_id: 'missing' }, query: {}, body: { messages: [] } },
            variables(memoryStore())
        );

        expect(result).toEqual({ status: 404, response: { error: "Conversation 'missing' not found" } });
    });

    it('derives the title from the trimmed first line of a multi-line first user turn', async () => {
        // Titles are conversation labels: only the first line of the first user
        // message applies. The message body itself keeps every line.
        vi.setSystemTime(new Date('2026-08-06T00:00:00.000Z'));
        const store = memoryStore();
        await conversationCreate(
            context,
            { path: {}, query: {}, body: {} },
            variables(store, () => 'conversation-created')
        );

        const result = await conversationPost(
            context,
            {
                path: { conversation_id: 'conversation-created' },
                query: {},
                body: { message: '  First line of the question  \nSecond line with more detail' }
            },
            variables(store)
        );

        // Outer whitespace vanishes via content trimming; the title keeps only
        // the (trimmed) first line.
        expect(result).toEqual({
            status: 200,
            response: {
                conversationId: 'conversation-created',
                conversation: {
                    conversationId: 'conversation-created',
                    title: 'First line of the question',
                    model: 'openai/gpt-5.6-sol',
                    status: 'complete',
                    messageCount: 1,
                    messages: [{ role: 'user', content: 'First line of the question  \nSecond line with more detail' }],
                    createdAt: '2026-08-06T00:00:00.000Z',
                    updatedAt: '2026-08-06T00:00:00.000Z'
                }
            }
        });
    });

    it('applies an explicit title from the PUT body (header rename flow)', async () => {
        // The header rename sends the unchanged history round-trip plus the new
        // label; the explicit title wins over first-line derivation.
        vi.setSystemTime(new Date('2026-08-06T00:00:20.000Z'));
        const store = memoryStore([existingConversation]);

        const result = await conversationPut(
            context,
            {
                path: { conversation_id: 'conversation-1' },
                query: {},
                body: {
                    messages: existingConversation.messages,
                    title: '  My custom title  '
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
                    title: 'My custom title',
                    updatedAt: '2026-08-06T00:00:20.000Z'
                }
            }
        });
    });

    it('rejects a blank title in the PUT body', async () => {
        const store = memoryStore([existingConversation]);

        const result = await conversationPut(
            context,
            {
                path: { conversation_id: 'conversation-1' },
                query: {},
                body: { messages: [{ role: 'user', content: 'Question' }], title: '   ' }
            },
            variables(store)
        );

        expect(result).toEqual({ status: 400, response: { error: 'title must be a non-empty string' } });
        expect(store.get('conversation-1')).toEqual(existingConversation);
    });

    it('re-derives the title from the first line when a PUT rewrites the first user turn', async () => {
        vi.setSystemTime(new Date('2026-08-06T00:00:20.000Z'));
        const store = memoryStore([existingConversation]);

        const result = await conversationPut(
            context,
            {
                path: { conversation_id: 'conversation-1' },
                query: {},
                body: { messages: [{ role: 'user', content: 'Rewritten heading\nand the details on a second line' }] }
            },
            variables(store)
        );

        expect(result).toEqual({
            status: 200,
            response: {
                conversationId: 'conversation-1',
                conversation: {
                    ...existingConversation,
                    title: 'Rewritten heading',
                    messageCount: 1,
                    messages: [{ role: 'user', content: 'Rewritten heading\nand the details on a second line' }],
                    updatedAt: '2026-08-06T00:00:20.000Z'
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
