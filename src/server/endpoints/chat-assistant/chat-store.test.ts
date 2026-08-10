// Deterministic persistence tests for the conversation store. The layout under
// test: one folder per chat (<root>/chat-assistant/<uuid>/conversation.json).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createChatStore } from './chat-store';

// Temporary roots isolate each test from the repository and from other test workers.
const temporaryRoots: string[] = [];

// Remove temporary files after each test, including the per-chat folders created by upsert.
afterEach(() => {
    for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// One exact record shared across the assertions.
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

describe('chat assistant store', () => {
    it('upserts, reads, lists, deletes, and reloads complete conversation records', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-assistant-test-'));
        temporaryRoots.push(root);
        const folder = path.join(root, 'chat-assistant', 'conversation-1');

        const firstStore = createChatStore(root);
        expect(firstStore.upsert(record)).toEqual(record);
        expect(firstStore.get('conversation-1')).toEqual(record);
        expect(firstStore.list()).toEqual([record]);

        // Each chat lives in its own folder holding exactly one document; the
        // legacy single-table chats.json database file must NOT be recreated.
        expect(fs.existsSync(path.join(folder, 'conversation.json'))).toBe(true);
        expect(fs.existsSync(path.join(root, 'chat-assistant', 'chats.json'))).toBe(false);

        // A second store instance reads the same folder, proving request-scoped stores see persisted data.
        const reloadedStore = createChatStore(root);
        expect(reloadedStore.get('conversation-1')).toEqual(record);

        // Deletion removes the chat's whole folder, so a fresh request scope cannot read the removed record.
        expect(firstStore.delete('conversation-1')).toBe(true);
        expect(fs.existsSync(folder)).toBe(false);
        expect(firstStore.get('conversation-1')).toBeNull();
        expect(firstStore.delete('conversation-1')).toBe(false);
        expect(createChatStore(root).get('conversation-1')).toBeNull();
    });

    it('keeps multiple chats in independent folders and lists them all', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-assistant-test-'));
        temporaryRoots.push(root);
        const second = { ...record, conversationId: 'conversation-2', title: 'Second chat' };
        const store = createChatStore(root);
        store.upsert(record);
        store.upsert(second);

        expect(fs.readdirSync(path.join(root, 'chat-assistant')).sort()).toEqual([
            'conversation-1',
            'conversation-2'
        ]);
        // List order is filesystem order; the API layer owns updatedAt sorting.
        expect(store.list()).toEqual([record, second]);

        // Deleting one chat leaves the other folder untouched.
        expect(store.delete('conversation-1')).toBe(true);
        expect(store.list()).toEqual([second]);
    });

    it('treats missing, non-directory, and malformed entries as absent', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-assistant-test-'));
        temporaryRoots.push(root);
        const directory = path.join(root, 'chat-assistant');
        fs.mkdirSync(path.join(directory, 'broken'), { recursive: true });
        fs.writeFileSync(path.join(directory, 'broken', 'conversation.json'), '{not json', 'utf8');
        fs.writeFileSync(path.join(directory, 'stray-file.json'), '{}', 'utf8');
        fs.mkdirSync(path.join(directory, 'empty-folder'));

        const store = createChatStore(root);
        // Only well-formed per-chat folders contribute to the list.
        expect(store.list()).toEqual([]);
        expect(store.get('broken')).toBeNull();
        expect(store.get('empty-folder')).toBeNull();
        expect(store.get('missing')).toBeNull();
        // Nothing was written yet: upsert creates the root directory lazily.
        fs.rmSync(directory, { recursive: true, force: true });
        expect(store.list()).toEqual([]);
    });
});
