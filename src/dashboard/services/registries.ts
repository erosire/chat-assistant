// Agent + tool registry SERVICE facades for the dashboard plugins.
//
// WHAT THIS IS: object-shaped CRUD over the client-side registry in
// ../../agents/index.ts. Agents keep using that module's own persistence
// verbatim (`readStoredAgents`/`storeAgents`, localStorage key
// `chat-assistant:agents`, corrupt-storage degradation and best-effort writes
// included) — nothing here re-implements the storage or the validation.
//
// THE ONE GAP THIS FACADE CLOSES: ../../agents/index.ts ships NO tool
// persistence. `AVAILABLE_TOOLS` is a hard-coded NATIVE seed list
// (agents/index.ts:73-82) and the coded-tool shape is documented as "ready for
// custom tools", while the backend already persists tools as a first-class
// registry (src/server/endpoints/chat-assistant/registry.ts:33-45, 116-147).
// A dashboard `ToolStore.save` therefore needs a browser-local durable layer,
// and it lives HERE (never in the agents module): localStorage key
// `chat-assistant:tools`, same prefix and same best-effort degradation style as
// the agent registry. `list()` answers `AVAILABLE_TOOLS` merged with those
// user-saved tools, deduplicated by id with the NATIVE SEED winning — a
// hand-written entry can never shadow a runtime-provided tool.
import { dataClone, isBoolean, isObject, isString } from '@presource/core';
import {
    AVAILABLE_TOOLS,
    readStoredAgents,
    storeAgents,
    type AgentDefinition,
    type ToolDefinition,
    type ToolLanguage
} from '../../agents';

// Browser-local tool registry (see the header note about the missing layer in
// ../../agents/index.ts). Chosen to match the existing key convention
// (`chat-assistant:agents`, `chat-assistant:model`, `chat-assistant:settings`).
export const TOOL_STORAGE_KEY = 'chat-assistant:tools';

// Agents are already durable in the agents module; this facade only adds the
// upsert/remove flows the sidebar performs today inline.
export interface AgentStore {
    list(): AgentDefinition[];
    save(agent: AgentDefinition): void;
    remove(id: string): void;
}

// Tools combine the immutable native seed registry with the persisted custom
// (coded) tools. `remove` only deletes persisted entries: a native tool is
// provided by the runtime, so it is always listed.
export interface ToolStore {
    list(): ToolDefinition[];
    save(tool: ToolDefinition): void;
    remove(id: string): void;
}

// The two accepted source languages (agents/index.ts:52 `ToolLanguage`),
// mirroring the server registry's `isToolLanguage` guard
// (src/server/endpoints/chat-assistant/registry.ts:59-60).
const isToolLanguage = (value: unknown): value is ToolLanguage =>
    value === 'javascript' || value === 'typescript';

// Structural guard for one PERSISTED tool entry: only a well-shaped object
// survives a localStorage round-trip, so an older/partial write is skipped
// instead of crashing the registry (the same rule `isValidAgent` applies to
// agents in ../../agents/index.ts:99-108).
const isStoredTool = (value: unknown): value is ToolDefinition => {
    if (!isObject(value)) return false;
    const candidate = value as Partial<ToolDefinition>;
    if (!isString(candidate.id) || candidate.id.length === 0) return false;
    if (!isString(candidate.name) || candidate.name.length === 0) return false;
    if (!isBoolean(candidate.native)) return false;
    if (candidate.language !== undefined && !isToolLanguage(candidate.language)) return false;
    if (candidate.code !== undefined && (!isString(candidate.code) || candidate.code.length === 0)) return false;
    return true;
};

// Enforces the single-shape invariant the registry documents
// (../../agents/index.ts:44-60): a NATIVE tool carries no implementation, so
// `language`/`code` are dropped for it, while a coded tool keeps both. Writing
// the canonical form is what makes a save/reload round-trip lossless for the
// read guard above.
const normalizeTool = (tool: ToolDefinition): ToolDefinition => ({
    id: tool.id,
    name: tool.name,
    native: tool.native,
    ...(tool.native ? {} : tool.language !== undefined ? { language: tool.language } : {}),
    ...(tool.native ? {} : tool.code !== undefined ? { code: tool.code } : {})
});

// Read the persisted tool list. Absent/corrupt storage degrades to an empty
// custom registry (the native seed alone), never a thrown error; duplicate ids
// keep their first occurrence.
const readStoredTools = (): ToolDefinition[] => {
    try {
        const raw = window.localStorage.getItem(TOOL_STORAGE_KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        const tools: ToolDefinition[] = [];
        for (const candidate of parsed) {
            if (!isStoredTool(candidate)) continue;
            if (tools.some((entry) => entry.id === candidate.id)) continue;
            tools.push(normalizeTool(candidate));
        }
        return tools;
    } catch {
        return [];
    }
};

// Best-effort write, exactly like `storeAgents`: a locked-down storage keeps
// the session working and only loses the restore.
const storeTools = (tools: ToolDefinition[]): void => {
    try {
        window.localStorage.setItem(TOOL_STORAGE_KEY, JSON.stringify(tools));
    } catch {
        // Persistence is best-effort; the in-memory registry still drives the
        // current session.
    }
};

// Insert-or-replace by id (pure). An update keeps the entry's existing
// position, so re-saving a tool never reorders the registry; a new id is
// appended.
const upsertById = <T extends { id: string }>(list: T[], entry: T): T[] => {
    const index = list.findIndex((candidate) => candidate.id === entry.id);
    if (index < 0) return [...list, entry];
    const next = list.slice();
    next[index] = entry;
    return next;
};

// Remove by id (pure).
const removeById = <T extends { id: string }>(list: T[], id: string): T[] =>
    list.filter((candidate) => candidate.id !== id);

// Agent registry over ../../agents/index.ts.
export function createAgentStore(): AgentStore {
    return {
        // Normalized copies (every entry carries `messages`), freshest first is
        // NOT imposed here: the agents module returns storage order, and the
        // sidebar sorts nothing.
        list: (): AgentDefinition[] => readStoredAgents(),

        save: (agent: AgentDefinition): void => {
            storeAgents(upsertById(readStoredAgents(), agent));
        },

        remove: (id: string): void => {
            storeAgents(removeById(readStoredAgents(), id));
        }
    };
}

// Tool registry: the native seed plus the persisted custom tools.
export function createToolStore(): ToolStore {
    return {
        list: (): ToolDefinition[] => {
            // `dataClone` detaches the seed objects: `AVAILABLE_TOOLS` is a
            // module-level shared array and a plugin mutating a row would
            // otherwise corrupt every later reader.
            const merged: ToolDefinition[] = dataClone(AVAILABLE_TOOLS);
            for (const tool of readStoredTools()) {
                // Native-seed ids win, so the merge stays duplicate-free.
                if (merged.some((entry) => entry.id === tool.id)) continue;
                merged.push(tool);
            }
            return merged;
        },

        save: (tool: ToolDefinition): void => {
            storeTools(upsertById(readStoredTools(), normalizeTool(tool)));
        },

        remove: (id: string): void => {
            storeTools(removeById(readStoredTools(), id));
        }
    };
}
