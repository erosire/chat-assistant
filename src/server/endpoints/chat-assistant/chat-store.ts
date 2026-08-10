// Small disk-backed store for the assistant's conversations.
//
// Storage layout: ONE FOLDER PER CHAT, named by the chat's uuid conversationId,
// holding a single conversation.json document with the complete record. Per-chat
// uuid folders are grouped under a dedicated `conversations` subfolder of the
// database directory so the database root stays free for other collections:
//   <root>/chat-assistant/conversations/<conversationId>/conversation.json
// The former single chats.json table file was dropped with the old database (the
// API moved to this logic): the per-folder layout keeps every chat independently
// inspectable and deletable, and each read parses its own file, so returned
// records are always fresh detached copies with shared-no-mutation guarantees.
import fs from 'node:fs';
import path from 'node:path';
import { isObject, isString } from '@presource/core';
import type { ConversationRecord } from '../../../api';

// Storage root is kept beside other distribution-owned data and never exposed by a route.
export const CHAT_ASSISTANT_DATABASE_DIR = 'chat-assistant';
// Subfolder grouping the per-chat uuid folders inside the database directory;
// keeps the uuids off the database root so other collections can live beside them.
const CONVERSATIONS_DIR = 'conversations';
// Document inside each per-chat folder carrying that chat's complete record.
const CONVERSATION_FILE_NAME = 'conversation.json';

// Store contract used by handlers and deterministic tests; unchanged by the layout move.
export type ChatStore = {
    list: () => ConversationRecord[];
    get: (conversationId: string) => ConversationRecord | null;
    upsert: (record: ConversationRecord) => ConversationRecord;
    delete: (conversationId: string) => boolean;
};

// Minimal structural guard so crashed writes or foreign folders are skipped
// instead of poisoning handlers: an id string plus a messages array must exist.
const isConversationRecord = (value: unknown): value is ConversationRecord =>
    isObject(value) && isString(value.conversationId) && Array.isArray(value.messages);

// Read one chat folder's document; missing files, malformed JSON, and structural
// mismatches all degrade to "no such conversation".
const readRecord = (folderPath: string): ConversationRecord | null => {
    const filePath = path.join(folderPath, CONVERSATION_FILE_NAME);
    if (!fs.existsSync(filePath)) return null;
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
        return isConversationRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
};

// Create a store for one storage root. Every operation touches only the target
// chat's own folder, so request-scoped stores always observe each other's writes.
export const createChatStore = (root: string): ChatStore => {
    // All per-chat uuid folders live under <root>/chat-assistant/conversations.
    const directory = path.join(root, CHAT_ASSISTANT_DATABASE_DIR, CONVERSATIONS_DIR);
    const folderFor = (conversationId: string) => path.join(directory, conversationId);

    return {
        // List scans the conversations folder's chat FOLDERS (not a table file):
        // entries that are not directories, or whose document is
        // missing/malformed, are skipped.
        list: () => {
            if (!fs.existsSync(directory)) return [];
            const records: ConversationRecord[] = [];
            for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue;
                const record = readRecord(path.join(directory, entry.name));
                if (record) records.push(record);
            }
            return records;
        },
        get: (conversationId) => readRecord(folderFor(conversationId)),
        upsert: (record) => {
            const folder = folderFor(record.conversationId);
            fs.mkdirSync(folder, { recursive: true });
            fs.writeFileSync(path.join(folder, CONVERSATION_FILE_NAME), JSON.stringify(record, null, 2), 'utf8');
            // Detached copy so callers cannot alias the just-persisted object.
            return { ...record, messages: [...record.messages] };
        },
        // Removing the folder removes everything the chat owns. Only an existing
        // conversation document counts as removable, keeping a missing DELETE
        // distinguishable from a successful removal (404 vs 200 at the handler).
        delete: (conversationId) => {
            const folder = folderFor(conversationId);
            if (!fs.existsSync(path.join(folder, CONVERSATION_FILE_NAME))) return false;
            fs.rmSync(folder, { recursive: true, force: true });
            return true;
        }
    };
};
