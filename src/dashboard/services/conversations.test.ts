// Deterministic tests for the mode-aware conversation SERVICE facade
// (src/dashboard/services/conversations.ts). The facade must delegate: online
// cases assert the EXACT requests the existing api/chat-assistant.ts client
// issues (url, method, headers, body) plus the follow-up canonical GET, and
// offline cases assert the EXACT records api/offline.ts persists (fake timers
// pin every timestamp so each assertion is byte-exact). `fetch` is stubbed with
// the same Response substitute the api tests use, and jsdom's real
// localStorage backs the tracked-id cache (key unchanged).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    DEFAULT_CHAT_ASSISTANT_URL,
    TRACKED_CONVERSATIONS_KEY,
    trackConversationId,
    type ConversationRecord,
    type ConversationSummary
} from '../../api/chat-assistant';
import { LOCAL_CONVERSATIONS_KEY, upsertLocalConversation } from '../../api/offline';
import { createConversationStore } from './conversations';

// JSON-envelope Response substitute (api/chat-assistant.test.ts:19-24 pattern).
const response = (status: number, body: unknown) =>
    ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body
    }) as Response;

const BASE_URL = 'http://test.local/v1/chat-assistant/conversation/';

// Exact persisted record the online GET/PUT envelopes carry.
const record = (conversationId: string): ConversationRecord => ({
    conversationId,
    title: 'Hello assistant',
    model: 'test/model',
    status: 'complete',
    messageCount: 2,
    messages: [
        { role: 'user', content: 'Hello assistant' },
        { role: 'assistant', content: 'Hello user', model: 'test/model' }
    ],
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:01.000Z'
});

// Compact summary derived from `record`, spelled field-by-field so it stays the
// exact 7-key shape the collection GET returns (no message bodies, no usage).
// `updatedAt` is overridable because the local fixtures re-date rows to make
// the newest-first ordering deterministic.
const summary = (conversationId: string, updatedAt?: string): ConversationSummary => {
    const source = record(conversationId);
    return {
        conversationId,
        title: source.title,
        model: source.model,
        status: source.status,
        messageCount: source.messageCount,
        createdAt: source.createdAt,
        updatedAt: updatedAt ?? source.updatedAt
    };
};

// Full record seeded straight into the browser-local store (the offline module's
// deterministic fixture seam, api/offline.ts:214-221).
const seedLocal = (conversationId: string, updatedAt: string): ConversationRecord =>
    upsertLocalConversation({ ...record(conversationId), updatedAt });

const onlineStore = () => createConversationStore('online', { baseUrl: BASE_URL });
const offlineStore = () => createConversationStore('offline', {});

describe('conversation store — online mode', () => {
    beforeEach(() => {
        window.localStorage.clear();
        vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        window.localStorage.clear();
    });

    it('exposes the mode it was built for', () => {
        expect(onlineStore().mode).toBe('online');
        expect(offlineStore().mode).toBe('offline');
    });

    it('creates through the collection POST, tracks the id, then reads the canonical record', async () => {
        (fetch as any)
            .mockResolvedValueOnce(response(200, { conversationId: 'conversation-9' }))
            .mockResolvedValueOnce(response(200, {
                conversationId: 'conversation-9',
                conversation: record('conversation-9')
            }));

        const created = await onlineStore().create({
            messages: [{ role: 'user', content: 'Hello assistant' }],
            model: 'test/model'
        });

        // The follow-up identified GET is the canonical read: the POST answers
        // with only the identifier on the wire.
        expect(created).toEqual(record('conversation-9'));
        expect(fetch).toHaveBeenNthCalledWith(1, 'http://test.local/v1/chat-assistant/conversation', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messages: [{ role: 'user', content: 'Hello assistant' }],
                model: 'test/model'
            })
        });
        expect(fetch).toHaveBeenNthCalledWith(
            2,
            'http://test.local/v1/chat-assistant/conversation/conversation-9',
            { method: 'GET' }
        );
        // The created id lands in the browser-owned cache immediately.
        expect(window.localStorage.getItem(TRACKED_CONVERSATIONS_KEY)).toBe('["conversation-9"]');
    });

    it('appends through the identified POST and re-reads the settled record', async () => {
        (fetch as any)
            .mockResolvedValueOnce(response(200, { conversationId: 'conversation-1' }))
            .mockResolvedValueOnce(response(200, {
                conversationId: 'conversation-1',
                conversation: record('conversation-1')
            }));

        const appended = await onlineStore().append('conversation-1', {
            messages: [{ role: 'user', content: 'Hello assistant' }],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }
        });

        expect(appended).toEqual(record('conversation-1'));
        expect(fetch).toHaveBeenNthCalledWith(1, 'http://test.local/v1/chat-assistant/conversation/conversation-1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messages: [{ role: 'user', content: 'Hello assistant' }],
                usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }
            })
        });
        expect(fetch).toHaveBeenNthCalledWith(2, 'http://test.local/v1/chat-assistant/conversation/conversation-1', {
            method: 'GET'
        });
        // Appending never re-tracks: only creation owns the cache entry, so the
        // cache is still untouched by this flow.
        expect(window.localStorage.getItem(TRACKED_CONVERSATIONS_KEY)).toBeNull();
    });

    it('replaces through one identified PUT without a follow-up read', async () => {
        (fetch as any).mockResolvedValueOnce(response(200, {
            conversationId: 'conversation-1',
            conversation: record('conversation-1')
        }));

        const replaced = await onlineStore().replace('conversation-1', {
            messages: [{ role: 'user', content: 'Edited question' }],
            title: 'Pinned title'
        });

        expect(replaced).toEqual(record('conversation-1'));
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledWith('http://test.local/v1/chat-assistant/conversation/conversation-1', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messages: [{ role: 'user', content: 'Edited question' }],
                title: 'Pinned title'
            })
        });
    });

    it('reads one record through the identified GET', async () => {
        (fetch as any).mockResolvedValueOnce(response(200, {
            conversationId: 'conversation-1',
            conversation: record('conversation-1')
        }));

        expect(await onlineStore().read('conversation 1')).toEqual(record('conversation-1'));
        // The identifier is path-encoded, never sent as a query string.
        expect(fetch).toHaveBeenCalledWith('http://test.local/v1/chat-assistant/conversation/conversation%201', {
            method: 'GET'
        });
    });

    it('lists the tracked ids only, with the encoded filter, and prunes ids the server dropped', async () => {
        trackConversationId('conversation-1');
        trackConversationId('conversation-dead');
        (fetch as any).mockResolvedValueOnce(response(200, { conversations: [summary('conversation-1')] }));

        const chats = await onlineStore().list(['conversation-1', 'conversation-dead']);

        expect(chats).toEqual([summary('conversation-1')]);
        expect(fetch).toHaveBeenCalledWith('http://test.local/v1/chat-assistant/conversation?ids=conversation-1%2Cconversation-dead', {
            method: 'GET'
        });
        // The dead entry is dropped from the cache so it never inflates a later query.
        expect(onlineStore().tracked()).toEqual(['conversation-1']);
    });

    it('never prunes tracked ids a scoped query did not ask about', async () => {
        trackConversationId('conversation-1');
        trackConversationId('conversation-2');
        (fetch as any).mockResolvedValueOnce(response(200, { conversations: [summary('conversation-1')] }));

        expect(await onlineStore().list(['conversation-1'])).toEqual([summary('conversation-1')]);
        expect(onlineStore().tracked()).toEqual(['conversation-1', 'conversation-2']);
    });

    it('deletes through the identified DELETE and untracks only after the server confirms', async () => {
        trackConversationId('conversation-1');
        (fetch as any).mockResolvedValueOnce(response(200, { conversationId: 'conversation-1' }));

        expect(await onlineStore().remove('conversation-1')).toBeUndefined();
        expect(fetch).toHaveBeenCalledWith('http://test.local/v1/chat-assistant/conversation/conversation-1', {
            method: 'DELETE'
        });
        expect(onlineStore().tracked()).toEqual([]);
    });

    it('keeps the conversation tracked when the DELETE fails', async () => {
        trackConversationId('conversation-1');
        (fetch as any).mockResolvedValueOnce(response(500, { error: 'store unwritable' }));

        await expect(onlineStore().remove('conversation-1')).rejects.toThrow('store unwritable');
        expect(onlineStore().tracked()).toEqual(['conversation-1']);
    });

    it('falls back to the default storage origin when no base url is configured', async () => {
        (fetch as any).mockResolvedValueOnce(response(200, { conversations: [] }));

        expect(await createConversationStore('online').list([])).toEqual([]);
        expect(fetch).toHaveBeenCalledWith(`${DEFAULT_CHAT_ASSISTANT_URL}?ids=`, { method: 'GET' });
    });

    it('surfaces the server error message for a failed canonical read', async () => {
        (fetch as any).mockResolvedValueOnce(response(404, { error: "Conversation 'gone' not found" }));

        await expect(onlineStore().read('gone')).rejects.toThrow("Conversation 'gone' not found");
    });
});

describe('conversation store — offline mode', () => {
    beforeEach(() => {
        window.localStorage.clear();
        vi.stubGlobal('fetch', vi.fn());
        // Pin every timestamp the local store writes (createdAt/updatedAt), so
        // the created record can be asserted exactly like the server would.
        vi.useFakeTimers({ now: new Date('2026-08-06T00:00:00.000Z') });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        window.localStorage.clear();
    });

    it('lists the browser-local summaries newest first and never touches the network', async () => {
        seedLocal('conversation-old', '2026-08-06T00:00:00.000Z');
        seedLocal('conversation-new', '2026-08-06T12:00:00.000Z');

        // The id filter is ignored offline: every local record already belongs
        // to this browser.
        expect(offlineStore().list(['conversation-old'])).resolves.toEqual([
            summary('conversation-new', '2026-08-06T12:00:00.000Z'),
            summary('conversation-old', '2026-08-06T00:00:00.000Z')
        ]);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('creates locally, persists the derived record, and tracks the new id', async () => {
        const store = offlineStore();
        const { conversationId, ...created } = await store.create({
            messages: [{ role: 'user', content: 'Hello assistant' }],
            model: 'test/model'
        });

        expect(created).toEqual({
            title: 'Hello assistant',
            model: 'test/model',
            status: 'complete',
            messageCount: 1,
            messages: [{ role: 'user', content: 'Hello assistant' }],
            createdAt: '2026-08-06T00:00:00.000Z',
            updatedAt: '2026-08-06T00:00:00.000Z'
        });
        // The id is provider-generated, so it is the only non-deterministic field.
        expect(typeof conversationId).toBe('string');
        expect(store.tracked()).toEqual([conversationId]);
        // The same canonical record comes back through read().
        expect(await store.read(conversationId)).toEqual({ ...created, conversationId });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('apends and replaces locally against the same store semantics', async () => {
        const store = offlineStore();
        // A prompt-only start: the appended user turn is what gives the
        // conversation its derived title (the mirrored server rule).
        const created = await store.create({ systemPrompt: 'Be brief', model: 'test/model' });
        expect(created.messages).toEqual([{ role: 'system', content: 'Be brief' }]);

        const appended = await store.append(created.conversationId, {
            message: 'Hello assistant',
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }
        });
        expect(appended).toEqual({
            conversationId: created.conversationId,
            title: 'Hello assistant',
            model: 'test/model',
            status: 'complete',
            messageCount: 2,
            messages: [
                { role: 'system', content: 'Be brief' },
                { role: 'user', content: 'Hello assistant' }
            ],
            createdAt: '2026-08-06T00:00:00.000Z',
            updatedAt: '2026-08-06T00:00:00.000Z',
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }
        });

        // A history rewrite keeps the stored model and the lifetime usage
        // aggregate when neither is resupplied.
        const replaced = await store.replace(created.conversationId, {
            messages: [{ role: 'user', content: 'Edited question' }]
        });
        expect(replaced).toEqual({
            conversationId: created.conversationId,
            title: 'Edited question',
            model: 'test/model',
            status: 'complete',
            messageCount: 1,
            messages: [{ role: 'user', content: 'Edited question' }],
            createdAt: '2026-08-06T00:00:00.000Z',
            updatedAt: '2026-08-06T00:00:00.000Z',
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }
        });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('deletes locally, untracks, and reports the server 404 message for a missing id', async () => {
        const store = offlineStore();
        seedLocal('conversation-1', '2026-08-06T00:00:00.000Z');
        trackConversationId('conversation-1');

        await store.remove('conversation-1');
        expect(store.tracked()).toEqual([]);
        expect(JSON.parse(window.localStorage.getItem(LOCAL_CONVERSATIONS_KEY) as string)).toEqual({});

        await expect(store.remove('conversation-1')).rejects.toThrow("Conversation 'conversation-1' not found");
        await expect(store.read('conversation-1')).rejects.toThrow("Conversation 'conversation-1' not found");
    });

    it('switching mode switches the namespace without mixing records', async () => {
        seedLocal('conversation-local', '2026-08-06T00:00:00.000Z');
        trackConversationId('conversation-server');
        (fetch as any).mockResolvedValueOnce(response(200, { conversations: [summary('conversation-server')] }));

        // Offline reads the local map only; online reads the server only.
        expect(await offlineStore().list([])).toEqual([summary('conversation-local', '2026-08-06T00:00:00.000Z')]);
        expect(await onlineStore().list(trackConversationId('conversation-server'))).toEqual([summary('conversation-server')]);

        expect(fetch).toHaveBeenCalledTimes(1);
    });
});

describe('conversation store — tracked id cache', () => {
    beforeEach(() => window.localStorage.clear());
    afterEach(() => window.localStorage.clear());

    it('round-trips tracked ids and never duplicates a re-tracked id', () => {
        const store = onlineStore();
        expect(store.tracked()).toEqual([]);

        store.track('conversation-1');
        store.track('conversation-1');
        store.track('conversation-2');
        expect(store.tracked()).toEqual(['conversation-1', 'conversation-2']);
        expect(window.localStorage.getItem(TRACKED_CONVERSATIONS_KEY)).toBe('["conversation-1","conversation-2"]');

        store.untrack('conversation-1');
        expect(store.tracked()).toEqual(['conversation-2']);
        store.untrack('missing');
        expect(store.tracked()).toEqual(['conversation-2']);
    });

    it('shares one cache between both stores and degrades a hand-edited cache to clean ids', () => {
        window.localStorage.setItem(TRACKED_CONVERSATIONS_KEY, JSON.stringify(['a', '', 3, null, 'a', 'b']));

        const online = onlineStore();
        const offline = offlineStore();
        expect(online.tracked()).toEqual(['a', 'b']);
        expect(offline.tracked()).toEqual(['a', 'b']);

        offline.untrack('a');
        expect(online.tracked()).toEqual(['b']);
    });
});
