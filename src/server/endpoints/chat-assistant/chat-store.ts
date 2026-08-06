// Small disk-backed store for the assistant's conversations.
//
// The store follows the same injected-root convention as story-generator:
// service.start({ root }) supplies a storage boundary, while tests can provide
// an in-memory store through handler variables. jsonTable supplies keyed CRUD;
// this module only adds the durable JSON file around it.
import fs from 'node:fs';
import path from 'node:path';
import { jsonTable } from '@presource/core';
import type { ChatRecord } from '../../../api';

// Storage is kept beside other distribution-owned data and never exposed by a route.
export const CHAT_ASSISTANT_DATABASE_DIR = 'chat-assistant';
const CHAT_FILE_NAME = 'chats.json';

// Store contract used by handlers and deterministic tests.
export type ChatStore = {
    list: () => ChatRecord[];
    get: (chatId: string) => ChatRecord | null;
    upsert: (record: ChatRecord) => ChatRecord;
};

// Empty disk shape is explicit so corrupted or first-run files have the same schema.
type ChatMemory = {
    schema: { name: string; id: 'chatId' };
    database: ChatRecord[];
};

// Read only valid persisted records; malformed files are treated as an empty database.
const readMemory = (filePath: string): ChatMemory => {
    if (!fs.existsSync(filePath)) {
        return { schema: { name: 'chat-assistant', id: 'chatId' }, database: [] };
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<ChatMemory>;
        if (parsed.schema?.id === 'chatId' && Array.isArray(parsed.database)) {
            return {
                schema: { name: 'chat-assistant', id: 'chatId' },
                database: parsed.database as ChatRecord[]
            };
        }
    } catch {
        // Corrupt local state should not prevent the assistant service from starting.
    }

    return { schema: { name: 'chat-assistant', id: 'chatId' }, database: [] };
};

// Create a store for one storage root. The file is loaded once per request so a
// separately running service process observes writes made by another request.
export const createChatStore = (root: string): ChatStore => {
    const directory = path.join(root, CHAT_ASSISTANT_DATABASE_DIR);
    const filePath = path.join(directory, CHAT_FILE_NAME);
    const table = jsonTable<ChatRecord>({
        name: 'chat-assistant',
        key: 'chatId',
        memory: readMemory(filePath)
    });

    // Persist the complete table after each upsert, creating the parent directory on first use.
    const persist = () => {
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(table.memory(), null, 2), 'utf8');
    };

    return {
        // Return copies so callers cannot mutate table entries without going through upsert.
        list: () => table.memory().database.map((record) => ({ ...record, messages: [...record.messages] })),
        get: (chatId) => {
            const record = table.get(chatId);
            return record ? { ...record, messages: [...record.messages] } : null;
        },
        upsert: (record) => {
            const saved = table.add({ ...record, messages: [...record.messages] });
            persist();
            return { ...saved, messages: [...saved.messages] };
        }
    };
};
