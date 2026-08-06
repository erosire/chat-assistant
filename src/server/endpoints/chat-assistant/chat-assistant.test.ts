// Deterministic direct-handler tests for the GET and POST service contract.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatRecord } from '../../../api';
import { chatAssistantGet, chatAssistantPost, requestAssistantReply } from './chat-assistant';
import type { ChatStore } from './chat-store';

// In-memory store gives handlers the same CRUD seam as the disk store without filesystem side effects.
const memoryStore = (initial: ChatRecord[] = []): ChatStore => {
    const records = [...initial];
    return {
        list: () => records.map((record) => ({ ...record, messages: [...record.messages] })),
        get: (chatId) => {
            const record = records.find((candidate) => candidate.chatId === chatId);
            return record ? { ...record, messages: [...record.messages] } : null;
        },
        upsert: (record) => {
            const index = records.findIndex((candidate) => candidate.chatId === record.chatId);
            if (index < 0) records.push({ ...record, messages: [...record.messages] });
            else records[index] = { ...record, messages: [...record.messages] };
            return { ...record, messages: [...record.messages] };
        }
    };
};

// Stable context and clock values make every response field exactly assertable.
const context = { req: { method: 'GET' } } as any;
const variables = (chatStore: ChatStore, assistantReply = async () => ({ content: 'Exact assistant reply' })) => ({
    chatStore,
    assistantReply
});

describe('chat assistant service handlers', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('returns an empty list when no chats are stored', async () => {
        const result = await chatAssistantGet(context, { path: {}, query: {}, body: {} }, variables(memoryStore()));

        expect(result).toEqual({ status: 200, response: { chats: [] } });
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

    it('lists summaries newest first and hides message bodies', async () => {
        const oldest: ChatRecord = {
            chatId: 'old',
            title: 'Old chat',
            model: 'test-model',
            status: 'complete',
            messageCount: 2,
            messages: [
                { role: 'user', content: 'old question' },
                { role: 'assistant', content: 'old answer' }
            ],
            createdAt: '2026-08-06T00:00:00.000Z',
            updatedAt: '2026-08-06T00:00:01.000Z'
        };
        const newest: ChatRecord = {
            ...oldest,
            chatId: 'new',
            title: 'New chat',
            messages: [{ role: 'user', content: 'new question' }],
            messageCount: 1,
            createdAt: '2026-08-06T00:00:02.000Z',
            updatedAt: '2026-08-06T00:00:03.000Z'
        };

        const result = await chatAssistantGet(
            context,
            { path: {}, query: {}, body: {} },
            variables(memoryStore([oldest, newest]))
        );

        expect(result).toEqual({
            status: 200,
            response: {
                chats: [
                    {
                        chatId: 'new',
                        title: 'New chat',
                        model: 'test-model',
                        status: 'complete',
                        messageCount: 1,
                        createdAt: '2026-08-06T00:00:02.000Z',
                        updatedAt: '2026-08-06T00:00:03.000Z'
                    },
                    {
                        chatId: 'old',
                        title: 'Old chat',
                        model: 'test-model',
                        status: 'complete',
                        messageCount: 2,
                        createdAt: '2026-08-06T00:00:00.000Z',
                        updatedAt: '2026-08-06T00:00:01.000Z'
                    }
                ]
            }
        });
    });

    it('reads a complete chat by query chatId', async () => {
        const chat: ChatRecord = {
            chatId: 'chat-1',
            title: 'Stored chat',
            model: 'test-model',
            status: 'complete',
            messageCount: 2,
            messages: [
                { role: 'user', content: 'Question' },
                { role: 'assistant', content: 'Answer' }
            ],
            createdAt: '2026-08-06T00:00:00.000Z',
            updatedAt: '2026-08-06T00:00:01.000Z'
        };

        const result = await chatAssistantGet(
            context,
            { path: {}, query: { chatId: 'chat-1' }, body: {} },
            variables(memoryStore([chat]))
        );

        expect(result).toEqual({ status: 200, response: { chat } });
    });

    it('creates a new chat from one message and persists the exact assistant turn', async () => {
        vi.setSystemTime(new Date('2026-08-06T00:00:00.000Z'));
        const store = memoryStore();
        const messages: ChatMessage[][] = [];
        const assistantReply = async (input: ChatMessage[], model: string) => {
            messages.push(input);
            expect(model).toBe('test-model');
            return { content: 'Exact assistant reply', usage: { total_tokens: 12 } };
        };

        const result = await chatAssistantPost(
            context,
            { path: {}, query: {}, body: { chatId: 'chat-1', message: 'Exact question', model: 'test-model' } },
            variables(store, assistantReply)
        );

        expect(result).toEqual({
            status: 200,
            response: {
                chatId: 'chat-1',
                chat: {
                    chatId: 'chat-1',
                    title: 'Exact question',
                    model: 'test-model',
                    status: 'complete',
                    messageCount: 2,
                    messages: [
                        { role: 'user', content: 'Exact question' },
                        { role: 'assistant', content: 'Exact assistant reply' }
                    ],
                    createdAt: '2026-08-06T00:00:00.000Z',
                    updatedAt: '2026-08-06T00:00:00.000Z',
                    usage: { total_tokens: 12 }
                }
            }
        });
        expect(messages).toEqual([[{ role: 'user', content: 'Exact question' }]]);
    });

    it('appends a follow-up message to an existing chat', async () => {
        vi.setSystemTime(new Date('2026-08-06T00:00:10.000Z'));
        const existing: ChatRecord = {
            chatId: 'chat-1',
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
        const store = memoryStore([existing]);

        const result = await chatAssistantPost(
            context,
            { path: {}, query: {}, body: { chatId: 'chat-1', message: 'Follow up' } },
            variables(store)
        );

        expect(result).toEqual({
            status: 200,
            response: {
                chatId: 'chat-1',
                chat: {
                    ...existing,
                    messageCount: 4,
                    messages: [
                        { role: 'user', content: 'First question' },
                        { role: 'assistant', content: 'First answer' },
                        { role: 'user', content: 'Follow up' },
                        { role: 'assistant', content: 'Exact assistant reply' }
                    ],
                    updatedAt: '2026-08-06T00:00:10.000Z'
                }
            }
        });
    });

    it('rejects invalid requests before contacting the assistant', async () => {
        const assistantReply = vi.fn(async () => ({ content: 'should not run' }));

        const result = await chatAssistantPost(
            context,
            { path: {}, query: {}, body: { messages: [{ role: 'user', content: '' }] } },
            variables(memoryStore(), assistantReply)
        );

        expect(result).toEqual({ status: 400, response: { error: 'messages must be an array of valid chat messages' } });
        expect(assistantReply).not.toHaveBeenCalled();
    });

    it('returns a provider failure with the persisted error record', async () => {
        vi.setSystemTime(new Date('2026-08-06T00:00:00.000Z'));
        const result = await chatAssistantPost(
            context,
            { path: {}, query: {}, body: { chatId: 'chat-1', message: 'Question' } },
            variables(memoryStore(), async () => {
                throw new Error('provider unavailable');
            })
        );

        expect(result).toEqual({
            status: 502,
            response: {
                chatId: 'chat-1',
                error: 'provider unavailable',
                chat: {
                    chatId: 'chat-1',
                    title: 'Question',
                    model: 'openai/gpt-5.6-sol',
                    status: 'error',
                    messageCount: 1,
                    messages: [{ role: 'user', content: 'Question' }],
                    createdAt: '2026-08-06T00:00:00.000Z',
                    updatedAt: '2026-08-06T00:00:00.000Z',
                    error: 'provider unavailable'
                }
            }
        });
    });
});
