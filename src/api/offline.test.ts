// Deterministic unit tests for the no-app-server mode (api/offline.ts):
// the persisted assistant settings (mode + offline endpoints) and the
// durable browser-local conversation store. The store assertions pin the
// EXACT data semantics of the server handlers (src/server/endpoints/
// chat-assistant/chat-assistant.ts): title derivation, model inheritance,
// usage aggregation, the append/replace/fork rules, and the 404-equivalent
// error messages — so offline conversations round-trip identically to what
// the online handlers would have persisted.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    appendToLocalConversation,
    ASSISTANT_SETTINGS_KEY,
    createLocalConversation,
    defaultAssistantSettings,
    deleteLocalConversation,
    getLocalConversation,
    listLocalConversations,
    loadAssistantSettings,
    LOCAL_CONVERSATIONS_KEY,
    readLocalConversations,
    replaceLocalConversationMessages,
    saveAssistantSettings,
    upsertLocalConversation,
    type AssistantSettings,
    type ConversationRecord
} from './offline';

// Seed a full record directly (the store's upsert seam): deterministic ids,
// timestamps, and usage so every downstream assertion can be exact.
const seed = (record: ConversationRecord): ConversationRecord => upsertLocalConversation(record);
const seededRecord = (conversationId: string, overrides: Partial<ConversationRecord> = {}): ConversationRecord => ({
    conversationId,
    title: 'Seeded conversation',
    model: 'seed/model',
    status: 'complete',
    messageCount: 0,
    messages: [],
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:00.000Z',
    ...overrides
});

describe('assistant settings (api/offline)', () => {
    beforeEach(() => {
        window.localStorage.clear();
    });

    it('defaults to the online mode with a blank provider base when nothing is stored', () => {
        expect(loadAssistantSettings()).toEqual({
            mode: 'online',
            providerBase: ''
        });
        // The exported default helper is the same canonical shape the UI
        // reads on its first launch.
        expect(defaultAssistantSettings()).toEqual(loadAssistantSettings());
        expect(window.localStorage.getItem(ASSISTANT_SETTINGS_KEY)).toBeNull();
    });

    it('round-trips a stored offline configuration and normalizes the base (trim + trailing slashes)', () => {
        // The exact configured example from the requirement: the canonical
        // persisted form strips whitespace and every trailing slash so the
        // derived routes (${base}/models, ${base}/chat/completions) are
        // exact.
        const settings: AssistantSettings = {
            mode: 'offline',
            providerBase: '  http://192.168.50.109:5500/providers/private/v1//  '
        };
        const saved = saveAssistantSettings(settings);

        // The persisted form is the trimmed canonical object.
        expect(saved).toEqual({
            mode: 'offline',
            providerBase: 'http://192.168.50.109:5500/providers/private/v1'
        });
        expect(JSON.parse(window.localStorage.getItem(ASSISTANT_SETTINGS_KEY)!)).toEqual(saved);
        // A fresh read (a simulated reload) restores the exact configuration.
        expect(loadAssistantSettings()).toEqual(saved);
    });

    it('restores the online default when the stored JSON is corrupt', () => {
        window.localStorage.setItem(ASSISTANT_SETTINGS_KEY, '{not json');
        expect(loadAssistantSettings()).toEqual(defaultAssistantSettings());
        // A partial object (a valid mode with no endpoint fields) degrades to
        // that mode with a blank base — the settings UI asks for the single
        // URL instead of crashing.
        window.localStorage.setItem(ASSISTANT_SETTINGS_KEY, JSON.stringify({ mode: 'offline' }));
        expect(loadAssistantSettings()).toEqual({ mode: 'offline', providerBase: '' });
    });

    it('migrates a persisted two-endpoint legacy configuration to the provider base', () => {
        // The PRIOR persisted shape ({ modelEndpoint, streamEndpoint,
        // manualModel }): a standard-suffixed pair on a shared base derives
        // that base (suffixes only ever STRIPPED), and the dropped manual
        // model field disappears from the migrated + saved canonical form.
        window.localStorage.setItem(ASSISTANT_SETTINGS_KEY, JSON.stringify({
            mode: 'offline',
            modelEndpoint: 'http://192.168.50.109:5500/providers/private/v1/models',
            streamEndpoint: 'http://192.168.50.109:5500/providers/private/v1/chat/completions/',
            manualModel: 'openai/gpt-4o-mini'
        }));
        expect(loadAssistantSettings()).toEqual({
            mode: 'offline',
            providerBase: 'http://192.168.50.109:5500/providers/private/v1'
        });
        // Persisting the migrated settings rewrites storage in the NEW single
        // shape (no legacy fields, no double-suffixed base).
        const migrated = saveAssistantSettings(loadAssistantSettings());
        expect(migrated).toEqual({
            mode: 'offline',
            providerBase: 'http://192.168.50.109:5500/providers/private/v1'
        });
        expect(JSON.parse(window.localStorage.getItem(ASSISTANT_SETTINGS_KEY)!)).toEqual(migrated);
    });

    it('derives the base from a single standard-suffixed legacy endpoint', () => {
        // Only the model-list URL is a standard `/models` route: it derives
        // the base alone.
        window.localStorage.setItem(ASSISTANT_SETTINGS_KEY, JSON.stringify({
            mode: 'offline',
            modelEndpoint: 'http://models.test:8080/v1/models',
            streamEndpoint: ''
        }));
        expect(loadAssistantSettings()).toEqual({ mode: 'offline', providerBase: 'http://models.test:8080/v1' });

        // Only the stream URL is a standard `/chat/completions` route: it
        // derives the base alone too.
        window.localStorage.setItem(ASSISTANT_SETTINGS_KEY, JSON.stringify({
            mode: 'offline',
            modelEndpoint: '',
            streamEndpoint: 'http://stream.test:9090/v1/chat/completions'
        }));
        expect(loadAssistantSettings()).toEqual({ mode: 'offline', providerBase: 'http://stream.test:9090/v1' });
    });

    it('never concatenates a suffix twice and asks for a new base when the legacy shape is unsafe', () => {
        // Mismatched bases (two hosts) share no provider — NO safe
        // derivation; the settings UI asks for the single base URL.
        window.localStorage.setItem(ASSISTANT_SETTINGS_KEY, JSON.stringify({
            mode: 'offline',
            modelEndpoint: 'http://a.test:8080/v1/models',
            streamEndpoint: 'http://b.test:9090/v1/chat/completions'
        }));
        expect(loadAssistantSettings()).toEqual({ mode: 'offline', providerBase: '' });

        // Non-standard paths carry no recognizable route suffix: no
        // derivation (a base derived from these would concatenate routes
        // onto the wrong origin).
        window.localStorage.setItem(ASSISTANT_SETTINGS_KEY, JSON.stringify({
            mode: 'offline',
            modelEndpoint: 'http://a.test:8080/custom/models/list',
            streamEndpoint: 'http://a.test:8080/custom/completions/run'
        }));
        expect(loadAssistantSettings()).toEqual({ mode: 'offline', providerBase: '' });

        // A SAFE derivation never keeps a route suffix: re-saving the
        // migrated base can never double-concatenate /models or
        // /chat/completions (the canonical form strips them all).
        window.localStorage.setItem(ASSISTANT_SETTINGS_KEY, JSON.stringify({
            mode: 'offline',
            modelEndpoint: 'http://a.test:8080/v1/models/',
            streamEndpoint: 'http://a.test:8080/v1/chat/completions'
        }));
        const migrated = loadAssistantSettings();
        expect(migrated).toEqual({ mode: 'offline', providerBase: 'http://a.test:8080/v1' });
        expect(migrated.providerBase.endsWith('/models')).toBe(false);
        expect(migrated.providerBase.endsWith('/chat/completions')).toBe(false);
        expect(saveAssistantSettings(migrated)).toEqual({ mode: 'offline', providerBase: 'http://a.test:8080/v1' });
    });
});

describe('local conversation store (api/offline)', () => {
    beforeEach(() => {
        window.localStorage.clear();
    });

    it('creates a blank conversation with the server title/default model rules', async () => {
        const created = await createLocalConversation({});
        const fetched = (await getLocalConversation(created.conversationId)).conversation;

        expect(fetched.title).toBe('New conversation');
        expect(fetched.model).toBe('');
        expect(fetched.status).toBe('complete');
        expect(fetched.messages).toEqual([]);
        expect(fetched.messageCount).toBe(0);
        // Timestamps are ISO-8601 (the list sort relies on string comparison).
        expect(created.conversationId.length).toBeGreaterThan(0);
        expect(new Date(fetched.createdAt).toISOString()).toBe(fetched.createdAt);
        expect(fetched.createdAt).toBe(fetched.updatedAt);
    });

    it('creates a system-prompt-only conversation from the systemPrompt field', async () => {
        const created = await createLocalConversation({ systemPrompt: '  be kind  ' });
        const fetched = (await getLocalConversation(created.conversationId)).conversation;

        expect(fetched.messages).toEqual([{ role: 'system', content: 'be kind' }]);
        expect(fetched.title).toBe('New conversation');
        expect(fetched.messageCount).toBe(1);
    });

    it('accepts an explicit model and records it on the new conversation', async () => {
        const created = await createLocalConversation({ model: 'openai/gpt-4o-mini' });
        expect((await getLocalConversation(created.conversationId)).conversation.model).toBe('openai/gpt-4o-mini');
    });

    it('rejects a blank model with the server validation message', async () => {
        await expect(createLocalConversation({ model: '   ' })).rejects.toThrow('model must be a non-empty string');
        // Nothing was persisted by the rejected create.
        expect(readLocalConversations()).toEqual({});
    });

    it('forks through the messages payload and derives the title from the first user line', async () => {
        const forked = await createLocalConversation({
            messages: [
                { role: 'user', content: '  First line\nsecond line  ' },
                { role: 'assistant', content: 'Answer', model: 'seed/model' }
            ],
            model: 'seed/model'
        });
        const fetched = (await getLocalConversation(forked.conversationId)).conversation;

        // Content is trimmed on persistence (server rule) and the title is the
        // trimmed FIRST LINE of the first user turn.
        expect(fetched.messages).toEqual([
            { role: 'user', content: 'First line\nsecond line' },
            { role: 'assistant', content: 'Answer', model: 'seed/model' }
        ]);
        expect(fetched.title).toBe('First line');
        expect(fetched.model).toBe('seed/model');
        expect(fetched.messageCount).toBe(2);
    });

    it('rejects a fork without any user turn (a system-only history cannot be continued)', async () => {
        await expect(
            createLocalConversation({ messages: [{ role: 'system', content: 'be kind' }] })
        ).rejects.toThrow('messages must include at least one valid user message');
    });

    it('rejects malformed message payloads with the server validation message', async () => {
        // Blank content fails the message parse (server: malformed turns).
        await expect(
            createLocalConversation({ messages: [{ role: 'user', content: '   ' }] })
        ).rejects.toThrow('messages must include at least one valid user message');
        // A model attribution must be a non-blank string when present.
        await expect(
            createLocalConversation({ messages: [{ role: 'user', content: 'hi', model: ' ' }] })
        ).rejects.toThrow('messages must include at least one valid user message');
    });

    it('lists summaries ordered by most recent activity (updatedAt descending)', async () => {
        seed(seededRecord('a', { updatedAt: '2026-08-06T00:00:01.000Z' }));
        seed(seededRecord('c', { updatedAt: '2026-08-06T00:00:03.000Z' }));
        seed(seededRecord('b', { updatedAt: '2026-08-06T00:00:02.000Z' }));

        const result = await listLocalConversations();
        // Exact summary shape (message bodies excluded) in strict order.
        expect(result.conversations).toEqual([
            {
                conversationId: 'c',
                title: 'Seeded conversation',
                model: 'seed/model',
                status: 'complete',
                messageCount: 0,
                createdAt: '2026-08-06T00:00:00.000Z',
                updatedAt: '2026-08-06T00:00:03.000Z'
            },
            {
                conversationId: 'b',
                title: 'Seeded conversation',
                model: 'seed/model',
                status: 'complete',
                messageCount: 0,
                createdAt: '2026-08-06T00:00:00.000Z',
                updatedAt: '2026-08-06T00:00:02.000Z'
            },
            {
                conversationId: 'a',
                title: 'Seeded conversation',
                model: 'seed/model',
                status: 'complete',
                messageCount: 0,
                createdAt: '2026-08-06T00:00:00.000Z',
                updatedAt: '2026-08-06T00:00:01.000Z'
            }
        ]);
    });

    it('reads one conversation as a detached copy and rejects missing ids with the 404 message', async () => {
        seed(seededRecord('one', { messages: [{ role: 'user', content: 'Hello' }] }));
        const first = (await getLocalConversation('one')).conversation;

        // The returned record is detached: mutating it (and its messages
        // array) must not poison the persisted record.
        first.messages.push({ role: 'assistant', content: 'Alien' });
        first.title = 'Mutated';
        const second = (await getLocalConversation('one')).conversation;
        expect(second.title).toBe('Seeded conversation');
        expect(second.messages).toEqual([{ role: 'user', content: 'Hello' }]);

        await expect(getLocalConversation('missing')).rejects.toThrow("Conversation 'missing' not found");
    });

    it('appends completed turns with model inheritance, usage accumulation, and the title rule', async () => {
        // A prompt-only conversation (no user turn yet) gains its title from
        // the FIRST appended user turn — the server's title rule.
        seed(seededRecord('prompt-only', {
            title: 'New conversation',
            status: 'complete',
            messages: [{ role: 'system', content: 'be kind' }],
            messageCount: 1
        }));
        const appended = await appendToLocalConversation('prompt-only', {
            message: 'Hello assistant',
            model: 'openai/gpt-4o-mini',
            usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 }
        });
        const afterAppend = (await getLocalConversation(appended.conversationId)).conversation;
        expect(afterAppend.title).toBe('Hello assistant');
        expect(afterAppend.model).toBe('openai/gpt-4o-mini');
        expect(afterAppend.messages).toEqual([
            { role: 'system', content: 'be kind' },
            { role: 'user', content: 'Hello assistant' }
        ]);
        expect(afterAppend.usage).toEqual({ prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 });

        // A second turn: the title is PRESERVED (a user turn already exists),
        // the model is inherited when the turn omits one, and the usage
        // COUNTERS ACCUMULATE onto the stored aggregate.
        const second = await appendToLocalConversation('prompt-only', {
            messages: [{ role: 'user', content: 'Second question' }]
        });
        const afterSecond = (await getLocalConversation(second.conversationId)).conversation;
        expect(afterSecond.title).toBe('Hello assistant');
        expect(afterSecond.model).toBe('openai/gpt-4o-mini');
        expect(afterSecond.messages).toEqual([
            { role: 'system', content: 'be kind' },
            { role: 'user', content: 'Hello assistant' },
            { role: 'user', content: 'Second question' }
        ]);
        // Omitted usage keeps the stored aggregate (no silent zeroing).
        expect(afterSecond.usage).toEqual({ prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 });

        // A turn WITH usage accumulates onto the aggregate.
        const third = await appendToLocalConversation('prompt-only', {
            messages: [{ role: 'assistant', content: 'Second answer' }, { role: 'user', content: 'Third' }],
            usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
        });
        const afterThird = (await getLocalConversation(third.conversationId)).conversation;
        expect(afterThird.usage).toEqual({ prompt_tokens: 7, completion_tokens: 7, total_tokens: 14 });
    });

    it('inserts an append systemPrompt before the incoming turns (server order)', async () => {
        seed(seededRecord('with-user', {
            messages: [{ role: 'user', content: 'Existing' }, { role: 'assistant', content: 'Replied' }],
            messageCount: 2
        }));
        await appendToLocalConversation('with-user', {
            message: 'New question',
            systemPrompt: 'late prompt'
        });
        const fetched = (await getLocalConversation('with-user')).conversation;
        expect(fetched.messages).toEqual([
            { role: 'user', content: 'Existing' },
            { role: 'assistant', content: 'Replied' },
            { role: 'system', content: 'late prompt' },
            { role: 'user', content: 'New question' }
        ]);
    });

    it('rejects appends that carry no user message (message-only rule)', async () => {
        seed(seededRecord('no-user', { messages: [{ role: 'system', content: 's' }], messageCount: 1 }));
        await expect(appendToLocalConversation('no-user', {})).rejects.toThrow('message or messages is required');
        await expect(
            appendToLocalConversation('no-user', { messages: [{ role: 'system', content: 'more system' }] })
        ).rejects.toThrow('at least one user message is required');
        // A non-existent conversation rejects with the 404 message.
        await expect(appendToLocalConversation('ghost', { message: 'hi' })).rejects.toThrow("Conversation 'ghost' not found");
    });

    it('replaces the whole history with title priority: explicit > derived > existing', async () => {
        // 1) Explicit title wins over the derivation from the new history.
        seed(seededRecord('rename', {
            messages: [{ role: 'user', content: 'Old first line' }],
            messageCount: 1
        }));
        const renamed = await replaceLocalConversationMessages('rename', {
            messages: [{ role: 'user', content: 'Fresh first line' }],
            title: 'Custom title'
        });
        expect(renamed.conversation.title).toBe('Custom title');

        // 2) Without an explicit title, the new history's first user line derives.
        const derived = await replaceLocalConversationMessages('rename', {
            messages: [{ role: 'user', content: 'Derived line' }]
        });
        expect(derived.conversation.title).toBe('Derived line');

        // 3) Without any user turn in the replacement, the recorded title survives.
        const kept = await replaceLocalConversationMessages('rename', {
            messages: [{ role: 'system', content: 'system only' }]
        });
        expect(kept.conversation.title).toBe('Derived line');

        // 4) An explicit model overrides the recorded one; messageCount
        //    recomputes from the replacement.
        const modelled = await replaceLocalConversationMessages('rename', {
            messages: [{ role: 'user', content: 'With model' }],
            model: 'override/model'
        });
        expect(modelled.conversation.model).toBe('override/model');
        expect(modelled.conversation.messageCount).toBe(1);
    });

    it('treats usage as a lifetime aggregate on replacement (omitted keeps, supplied accumulates)', async () => {
        seed(seededRecord('usage', {
            messages: [{ role: 'user', content: 'a' }],
            messageCount: 1,
            usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 }
        }));
        // Omitted usage: the stored total survives the rewrite.
        const kept = await replaceLocalConversationMessages('usage', {
            messages: [{ role: 'user', content: 'edited' }]
        });
        expect(kept.conversation.usage).toEqual({ prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 });
        // Supplied usage accumulates onto the stored aggregate (the send
        // flow's system-prepend PUT path).
        const added = await replaceLocalConversationMessages('usage', {
            messages: [{ role: 'system', content: 'prompt' }, { role: 'user', content: 'edited' }],
            usage: { prompt_tokens: 1, total_tokens: 1 }
        });
        expect(added.conversation.usage).toEqual({ prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 });
    });

    it('rejects a replacement without a message list or with a blank title/model', async () => {
        seed(seededRecord('strict', { messages: [{ role: 'user', content: 'a' }], messageCount: 1 }));
        await expect(
            replaceLocalConversationMessages('strict', {} as never)
        ).rejects.toThrow('messages must be an array of valid chat messages');
        await expect(
            replaceLocalConversationMessages('strict', { messages: [{ role: 'user', content: 'a' }], title: '  ' })
        ).rejects.toThrow('title must be a non-empty string');
        await expect(
            replaceLocalConversationMessages('strict', { messages: [{ role: 'user', content: 'a' }], model: '' })
        ).rejects.toThrow('model must be a non-empty string');
        await expect(
            replaceLocalConversationMessages('strict', {
                messages: [{ role: 'user', content: 'a' }],
                usage: { prompt_tokens: 'many' as never }
            })
        ).rejects.toThrow('usage must contain only numeric token counters');
    });

    it('deletes a conversation and rejects an already-missing identifier', async () => {
        seed(seededRecord('doomed', { messages: [{ role: 'user', content: 'a' }], messageCount: 1 }));
        expect(await deleteLocalConversation('doomed')).toEqual({ conversationId: 'doomed' });
        expect(Object.keys(readLocalConversations())).toEqual([]);
        await expect(deleteLocalConversation('doomed')).rejects.toThrow("Conversation 'doomed' not found");
        // The 404-equivalent is idempotent-safe: the second delete cannot
        // silently pretend success.
        await expect(deleteLocalConversation('never-existed')).rejects.toThrow("Conversation 'never-existed' not found");
    });

    it('keeps every record durable in localStorage across simulated reloads', async () => {
        const created = await createLocalConversation({ model: 'openai/gpt-4o-mini', systemPrompt: 'be kind' });
        await appendToLocalConversation(created.conversationId, { message: 'Hello', model: 'openai/gpt-4o-mini' });

        // The persisted map (a fresh process/reload would JSON.parse exactly
        // this) carries the full record under the conversation id.
        const map = readLocalConversations();
        expect(Object.keys(map)).toEqual([created.conversationId]);
        expect(map[created.conversationId].messages).toEqual([
            { role: 'system', content: 'be kind' },
            { role: 'user', content: 'Hello' }
        ]);
        expect(map[created.conversationId].title).toBe('Hello');
        expect(window.localStorage.getItem(LOCAL_CONVERSATIONS_KEY)).toBe(JSON.stringify(map));
        // After the "reload" the list restores the conversation.
        expect((await listLocalConversations()).conversations).toHaveLength(1);
    });

    it('surfaces a storage write failure instead of reporting a silent success', async () => {
        // A storage whose WRITE path throws (quota/locked-down profile): the
        // store must re-throw so the owning flow's catch surfaces it, while
        // reads still degrade (a failed read cannot deadlock every flow).
        // jsdom's Storage binding ignores spies on its setItem, so the whole
        // global is stubbed: getItem degrades to null, setItem throws.
        let writes = 0;
        const failingStorage = {
            getItem: () => null,
            setItem: (_key: string, _value: string) => {
                writes += 1;
                throw new Error('QuotaExceededError: storage full');
            },
            removeItem: () => undefined,
            clear: () => undefined,
            key: () => null,
            get length() {
                return 0;
            }
        };
        vi.stubGlobal('localStorage', failingStorage);
        try {
            await expect(createLocalConversation({ message: 'Hello' })).rejects.toThrow('QuotaExceededError: storage full');
            // The raw upsert seam re-throws the write failure synchronously.
            expect(() => upsertLocalConversation(seededRecord('x'))).toThrow('QuotaExceededError: storage full');
            expect(writes).toBe(2);
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
