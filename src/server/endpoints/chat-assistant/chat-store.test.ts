// Deterministic persistence tests for the conversation store.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createChatStore } from './chat-store';

// Temporary roots isolate each test from the repository and from other test workers.
const temporaryRoots: string[] = [];

// Remove temporary files after each test, including the durable JSON file created by upsert.
afterEach(() => {
    for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('chat assistant store', () => {
    it('upserts, reads, lists, deletes, and reloads complete conversation records', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-assistant-test-'));
        temporaryRoots.push(root);
        const record = {
            conversationId: 'conversation-1',
            title: 'Stored chat',
            model: 'test-model',
            status: 'complete' as const,
            messageCount: 2,
            messages: [
                { role: 'user' as const, content: 'Question' },
                { role: 'assistant' as const, content: 'Answer' }
            ],
            createdAt: '2026-08-06T00:00:00.000Z',
            updatedAt: '2026-08-06T00:00:01.000Z'
        };

        const firstStore = createChatStore(root);
        expect(firstStore.upsert(record)).toEqual(record);
        expect(firstStore.get('conversation-1')).toEqual(record);
        expect(firstStore.list()).toEqual([record]);

        // A second store instance reads the same file, proving request-scoped stores see persisted data.
        const reloadedStore = createChatStore(root);
        expect(reloadedStore.get('conversation-1')).toEqual(record);
        expect(fs.existsSync(path.join(root, 'chat-assistant', 'chats.json'))).toBe(true);

        // Deletion is persisted as well, so a fresh request scope cannot read the removed record.
        expect(firstStore.delete('conversation-1')).toBe(true);
        expect(firstStore.get('conversation-1')).toBeNull();
        expect(firstStore.delete('conversation-1')).toBe(false);
        expect(createChatStore(root).get('conversation-1')).toBeNull();
    });
});
