// Small disk-backed store for the assistant's agent and tool registries.
//
// Storage layout mirrors the conversation store (chat-store.ts): ONE FOLDER PER
// RECORD, named by the record's identifier, holding a single JSON document.
// Per-id folders are grouped under a dedicated collection subfolder of the
// database directory so the database root stays free for other collections:
//   <root>/chat-assistant/agents/<agentId>/agent.json
//   <root>/chat-assistant/tools/<toolId>/tool.json
// The folder-per-record layout keeps every agent/tool independently inspectable
// and deletable, and each read parses its own file, so returned records are
// always fresh detached copies with shared-no-mutation guarantees.
import fs from 'node:fs';
import path from 'node:path';
import { isObject, isString } from '@presource/core';
import { CHAT_ASSISTANT_DATABASE_DIR } from './chat-store';

// Store contract used by handlers and deterministic tests; identical in shape
// to ChatStore so both resource families stay symmetric at the handler layer.
export type RegistryStore<RecordType> = {
    list: () => RecordType[];
    get: (id: string) => RecordType | null;
    upsert: (record: RecordType) => RecordType;
    delete: (id: string) => boolean;
};

// Minimal structural guard so crashed writes or foreign folders are skipped
// instead of poisoning handlers: the identifier field plus a name string must
// exist (every persisted agent and tool carries at least those two fields).
const isRegistryRecord = (value: unknown, idKey: string): boolean =>
    isObject(value) && isString(value[idKey]) && isString(value.name);

// Read one record folder's document; missing files, malformed JSON, and
// structural mismatches all degrade to "no such record".
const readRecord = <RecordType>(folderPath: string, fileName: string, idKey: string): RecordType | null => {
    const filePath = path.join(folderPath, fileName);
    if (!fs.existsSync(filePath)) return null;
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
        return isRegistryRecord(parsed, idKey) ? (parsed as RecordType) : null;
    } catch {
        return null;
    }
};

// Create a store for one collection ("agents" or "tools") under one storage
// root. `idKey` names the record's identifier field ('agentId' / 'toolId') —
// the handlers' resource types deliberately mirror their client-side
// counterparts instead of a generic `id`. Every operation touches only the
// target record's own folder, so request-scoped stores always observe each
// other's writes. The singular file name keeps the document self-describing
// inside its folder (agent.json / tool.json, mirroring conversation.json in
// the chat store).
export const createRegistryStore = <RecordType>(
    root: string,
    collection: string,
    fileName: string,
    idKey: string
): RegistryStore<RecordType> => {
    // All per-record folders live under <root>/chat-assistant/<collection>.
    const directory = path.join(root, CHAT_ASSISTANT_DATABASE_DIR, collection);
    const folderFor = (id: string) => path.join(directory, id);

    return {
        // List scans the collection folder's record FOLDERS (not a table
        // file): entries that are not directories, or whose document is
        // missing/malformed, are skipped.
        list: () => {
            if (!fs.existsSync(directory)) return [];
            const records: RecordType[] = [];
            for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue;
                const record = readRecord<RecordType>(path.join(directory, entry.name), fileName, idKey);
                if (record) records.push(record);
            }
            return records;
        },
        get: (id) => readRecord<RecordType>(folderFor(id), fileName, idKey),
        upsert: (record) => {
            const folder = folderFor((record as Record<string, unknown>)[idKey] as string);
            fs.mkdirSync(folder, { recursive: true });
            fs.writeFileSync(path.join(folder, fileName), JSON.stringify(record, null, 2), 'utf8');
            // Detached shallow copy so callers cannot alias the just-persisted
            // object (the conversation store spreads its list field the same
            // way at the handler layer; here the handlers own that copy).
            return { ...record };
        },
        // Removing the folder removes everything the record owns. Only an
        // existing document counts as removable, keeping a missing DELETE
        // distinguishable from a successful removal (404 vs 200 at the handler).
        delete: (id) => {
            const folder = folderFor(id);
            if (!fs.existsSync(path.join(folder, fileName))) return false;
            fs.rmSync(folder, { recursive: true, force: true });
            return true;
        }
    };
};
