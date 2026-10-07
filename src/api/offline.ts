// Offline (no-app-server) mode for the chat-assistant distribution.
//
// What this module owns:
//   1. The assistant SETTINGS (mode + offline endpoint configuration),
//      persisted in localStorage so a reload restores the mode and the
//      configured endpoints (components/ChatAssistantApp.tsx reads it once
//      on mount; every settings edit re-persists it immediately).
//   2. A DURABLE BROWSER-LOCAL conversation store with the exact data
//      semantics of the server handlers in
//      ../server/endpoints/chat-assistant/chat-assistant.ts (title
//      derivation, model inheritance, usage aggregation, the append/
//      replace/fork rules, and the 404-equivalent errors) — mirrored here
//      so offline mode works WITHOUT any request to the storage server or
//      the private provider relay. The node store itself is deliberately
//      NOT imported: it uses node:fs/node:path and cannot run in the
//      browser; this module is the semantic reference-based re-implementation.
//
// What offline mode is (and is NOT):
//   - It removes the Chat Assistant APPLICATION server (conversation
//     storage) — the conversations live in this browser's localStorage.
//   - It does NOT make model inference network-free: a user-configured
//     OpenAI-compatible endpoint (full model-list URL / full stream URL)
//     still needs connectivity and CORS from the browser. It also does not
//     bundle a browser model, install a service worker, or execute local
//     tools — only the app's existing server functions are re-implemented.
//
// Persistence keys (all under the same "chat-assistant:" prefix as the
// model memory and agent registry):
//   ASSISTANT_SETTINGS_KEY       — the settings object below
//   LOCAL_CONVERSATIONS_KEY      — the complete record map (id → record)

import type {
    ChatMessage,
    ConversationGetResponse,
    ConversationListResponse,
    ConversationPostRequest,
    ConversationPostResponse,
    ConversationPutRequest,
    ConversationRecord,
    ConversationSummary
} from './chat-assistant';

// The two assistant modes: 'online' (default — the existing application
// server + private provider relay behavior, unchanged) and 'offline' (no
// app server: durable browser-local conversations + configured endpoints).
export type AssistantMode = 'online' | 'offline';

// Offline settings surface, kept deliberately minimal (one mode selector,
// two independent FULL endpoint URLs, and a manual model-id fallback).
// The endpoint URLs are INDEPENDENT full URLs (e.g.
// "http://localhost:8080/v1/models" and "http://localhost:8080/v1/
// chat/completions") — not a shared base URL — because OpenAI-compatible
// deployments expose the two routes on arbitrary paths. Blank strings mean
// "not configured": a blank model endpoint means NO catalog fetch is ever
// issued (never a silent call to the default relay), and a blank stream
// endpoint means streaming explains the configuration need instead of
// falling back to the default app server.
export type AssistantSettings = {
    mode: AssistantMode;
    // Full URL of the OpenAI-compatible model list route (GET {url}).
    modelEndpoint: string;
    // Full URL of the OpenAI-compatible streaming chat completion route (POST {url}).
    streamEndpoint: string;
    // Manual model id used when the model list endpoint is unavailable or left
    // blank, so an empty catalog cannot deadlock the composer.
    manualModel: string;
};

export const ASSISTANT_SETTINGS_KEY = 'chat-assistant:settings';
export const LOCAL_CONVERSATIONS_KEY = 'chat-assistant:offline-conversations';

// Online is the DEFAULT: an embedded app or a first browser launch keeps the
// existing server-backed behavior exactly (R5 — no behavior change without an
// explicit settings switch).
export const defaultAssistantSettings = (): AssistantSettings => ({
    mode: 'online',
    modelEndpoint: '',
    streamEndpoint: '',
    manualModel: ''
});

// Structural guard for one persisted settings object: corrupt or legacy JSON
// must degrade to the defaults instead of crashing the dashboard (the same
// best-effort read style the agent registry uses in ../agents).
const isAssistantSettings = (value: unknown): value is AssistantSettings => {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as Partial<AssistantSettings>;
    return (candidate.mode === 'online' || candidate.mode === 'offline')
        && typeof candidate.modelEndpoint === 'string'
        && typeof candidate.streamEndpoint === 'string'
        && typeof candidate.manualModel === 'string';
};

// Read the persisted settings; anything unreadable/corrupt resolves to the
// online default (the existing behavior is the safe fallback).
export const loadAssistantSettings = (): AssistantSettings => {
    try {
        const raw = window.localStorage.getItem(ASSISTANT_SETTINGS_KEY);
        if (!raw) return defaultAssistantSettings();
        const parsed: unknown = JSON.parse(raw);
        if (!isAssistantSettings(parsed)) return defaultAssistantSettings();
        // Persist trimmed strings so the stored form is canonical and
        // round-trips byte-identically.
        return {
            mode: parsed.mode,
            modelEndpoint: parsed.modelEndpoint.trim(),
            streamEndpoint: parsed.streamEndpoint.trim(),
            manualModel: parsed.manualModel.trim()
        };
    } catch {
        return defaultAssistantSettings();
    }
};

// Persist the settings immediately (every settings edit in the UI funnels
// through here so a reload always restores the same configuration). A
// locked-down storage that throws surfaces the write failure to the caller
// instead of silently dropping the configuration.
export const saveAssistantSettings = (settings: AssistantSettings): AssistantSettings => {
    const canonical: AssistantSettings = {
        mode: settings.mode,
        modelEndpoint: settings.modelEndpoint.trim(),
        streamEndpoint: settings.streamEndpoint.trim(),
        manualModel: settings.manualModel.trim()
    };
    window.localStorage.setItem(ASSISTANT_SETTINGS_KEY, JSON.stringify(canonical));
    return canonical;
};

// ---------------------------------------------------------------------------
// Local conversation store (the offline mirror of the server handlers)
// ---------------------------------------------------------------------------

// The complete record map as persisted under LOCAL_CONVERSATIONS_KEY.
type LocalConversationMap = Record<string, ConversationRecord>;

// Structural guard so a crashed/corrupt persisted map degrades to a SINGLE
// skipped record (like the server store's isConversationRecord) rather than
// poisoning every operation.
const isLocalConversationRecord = (value: unknown): value is ConversationRecord => {
    // Cast through Record first: the bare object narrowing does not expose
    // property access to TypeScript (the server store's equivalent guard has
    // the same shape, typed against a JSON-parsed unknown).
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as Record<string, unknown>;
    return typeof candidate.conversationId === 'string' && Array.isArray(candidate.messages);
};

// Read the persisted map; corrupt JSON degrades to an empty store (a
// partially corrupt map can never recover its lost records, and a hard
// failure here would deadlock EVERY offline flow — the read path therefore
// degrades while the WRITE path below re-throws, so failures still surface).
const readLocalMap = (): LocalConversationMap => {
    try {
        const raw = window.localStorage.getItem(LOCAL_CONVERSATIONS_KEY);
        if (!raw) return {};
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null) return {};
        const map: LocalConversationMap = {};
        for (const [id, candidate] of Object.entries(parsed)) {
            if (isLocalConversationRecord(candidate)) map[id] = candidate;
        }
        return map;
    } catch {
        return {};
    }
};

// Persist the whole map; storage failures (quota, locked-down profile) are
// RE-THROWN so the owning flow's catch can surface them in the error banner —
// offline mode must never report a successful write it did not perform.
const writeLocalMap = (map: LocalConversationMap): void => {
    window.localStorage.setItem(LOCAL_CONVERSATIONS_KEY, JSON.stringify(map));
};

// Exposed raw accessors (deterministic test seams + the "restore on reload"
// contract): tests seed records and assert on the persisted state directly.
export const readLocalConversations = (): LocalConversationMap => readLocalMap();

// Seed/replace one full record in the local store (the offline analogue of
// the server store's upsert — used to seed deterministic fixtures).
export const upsertLocalConversation = (record: ConversationRecord): ConversationRecord => {
    const map = readLocalMap();
    map[record.conversationId] = record;
    writeLocalMap(map);
    // Detached copy so callers cannot alias the just-persisted record
    // (mirrors createChatStore's upsert in ../server/endpoints/chat-assistant/chat-store.ts).
    return { ...record, messages: [...record.messages] };
};

// The server's default model only exists to fill server-side records created
// without one; offline records are browser-local, so an unmodeled record
// keeps an EMPTY string instead of pretending a model (the UI always
// supplies the concrete provider model it used for a turn).
const LOCAL_DEFAULT_MODEL = '';

// Title rule mirrored from the server handler (chat-assistant.ts):
// first LINE (trimmed) of the first user turn, capped at 80 chars
// (77 + "..."), "New conversation" when no user turn contributes a title.
const localTitleFromMessages = (messages: ChatMessage[]): string => {
    const firstUser = messages.find((message) => message.role === 'user');
    const firstLine = (firstUser?.content.trim().split('\n', 1)[0] ?? '').trim();
    const title = firstLine || 'New conversation';
    return title.length > 80 ? `${title.slice(0, 77)}...` : title;
};

// Message role whitelist (the server accepts exactly these three roles).
const isLocalChatRole = (value: unknown): value is ChatMessage['role'] =>
    value === 'system' || value === 'user' || value === 'assistant';

// Message validation mirrored from the server's parseMessages: role +
// non-blank string content are required; an optional model attribution must
// be a non-blank string. Content and model are trimmed on persistence.
const localParseMessages = (value: unknown): ChatMessage[] | null => {
    if (!Array.isArray(value)) return null;
    const messages: ChatMessage[] = [];
    for (const candidate of value) {
        if (typeof candidate !== 'object' || candidate === null) return null;
        const role = (candidate as ChatMessage).role;
        const content = (candidate as ChatMessage).content;
        if (!isLocalChatRole(role) || typeof content !== 'string' || content.trim().length === 0) return null;
        const model = (candidate as ChatMessage).model;
        if (model !== undefined && (typeof model !== 'string' || model.trim().length === 0)) return null;
        messages.push({
            role,
            content: content.trim(),
            ...(model !== undefined ? { model: model.trim() } : {})
        });
    }
    return messages;
};

// Usage validation + the counter set the server persists (chat-assistant.ts
// parseUsage): only the three numeric token counters survive; anything else
// invalidates the payload (the 400-equivalent rejection below).
const USAGE_KEYS = ['prompt_tokens', 'completion_tokens', 'total_tokens'] as const;
const localParseUsage = (value: unknown): ConversationRecord['usage'] | null | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'object' || value === null) return null;
    const usage: NonNullable<ConversationRecord['usage']> = {};
    for (const key of USAGE_KEYS) {
        const candidate = (value as Record<string, unknown>)[key];
        if (candidate !== undefined) {
            if (typeof candidate !== 'number') return null;
            usage[key] = candidate;
        }
    }
    return usage;
};

// Turn-level usage folded into the conversation aggregate, mirrored from
// the server's accumulateUsage: omitted counters keep their previous value
// (providers may report only one side of the accounting data).
const localAccumulateUsage = (
    previous: ConversationRecord['usage'] | undefined,
    current: NonNullable<ConversationRecord['usage']>
): NonNullable<ConversationRecord['usage']> => {
    const aggregate: NonNullable<ConversationRecord['usage']> = { ...(previous ?? {}) };
    for (const key of USAGE_KEYS) {
        const value = current[key];
        if (value !== undefined) aggregate[key] = (aggregate[key] ?? 0) + value;
    }
    return aggregate;
};

// Deterministic conversation ids: cryptographically random when the modern
// API exists (every current browser + Node's webcrypto), with a Math.random
// fallback for locked-down environments. The format stays the uuid-ish
// "conversation-N" style the local store is addressable by.
let localIdCounter = 0;
const localConversationId = (): string => {
    const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
    localIdCounter += 1;
    return `local-${Date.now().toString(36)}-${localIdCounter}-${Math.random().toString(16).slice(2)}`;
};

// Option-field validation mirrored from the server's validateOptions
// (create/append): model/systemPrompt must be non-blank strings when
// present; usage must be numeric-only when present.
const localValidateOptions = (body: ConversationPostRequest): string | undefined => {
    if (body.model !== undefined && (typeof body.model !== 'string' || body.model.trim().length === 0)) {
        return 'model must be a non-empty string';
    }
    if (body.systemPrompt !== undefined && (typeof body.systemPrompt !== 'string' || body.systemPrompt.trim().length === 0)) {
        return 'systemPrompt must be a non-empty string';
    }
    if (localParseUsage(body.usage) === null) {
        return 'usage must contain only numeric token counters';
    }
    return undefined;
};

// The local store's 404-equivalent: the exact message text the server
// handler returns for a missing identifier, so the UI's error banner reads
// the same in both modes.
const notFound = (conversationId: string): Error => new Error(`Conversation '${conversationId}' not found`);

// List every locally persisted conversation as a compact summary, ordered by
// most recent activity (updatedAt descending) — the server collection GET's
// ordering rule. (The UI re-sorts nothing; the sidebar renders list order.)
export const listLocalConversations = async (): Promise<ConversationListResponse> => {
    const conversations: ConversationSummary[] = Object.values(readLocalMap())
        .map(({ conversationId, title, model, status, messageCount, createdAt, updatedAt }) => ({
            conversationId,
            title,
            model,
            status,
            messageCount,
            createdAt,
            updatedAt
        }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { conversations };
};

// Read one complete locally persisted conversation (identified GET);
// missing identifiers reject with the server 404 message.
export const getLocalConversation = async (conversationId: string): Promise<ConversationGetResponse> => {
    const conversation = readLocalMap()[conversationId];
    if (!conversation) throw notFound(conversationId);
    // Detached copy (the server handler's records are fresh file-parsed copies).
    return {
        conversationId,
        conversation: { ...conversation, messages: [...conversation.messages] }
    };
};

// Create a local conversation, mirroring the server POST:
// - an explicit `messages` history is the FORK payload and must contain at
//   least one user turn (a system-prompt-only history cannot be continued);
// - an optional systemPrompt seeds a prompt-only conversation;
// - a blank creation starts EMPTY (the UI's new-chat surface).
export const createLocalConversation = async (request: ConversationPostRequest): Promise<ConversationPostResponse> => {
    const optionError = localValidateOptions(request);
    if (optionError) throw new Error(optionError);

    const now = new Date().toISOString();
    let messages: ChatMessage[];
    if (request.messages !== undefined) {
        const parsed = localParseMessages(request.messages);
        if (parsed === null || !parsed.some((message) => message.role === 'user')) {
            throw new Error('messages must include at least one valid user message');
        }
        messages = parsed;
    } else {
        messages = request.systemPrompt
            ? [{ role: 'system', content: request.systemPrompt.trim() }]
            : [];
    }
    const conversation: ConversationRecord = {
        conversationId: localConversationId(),
        title: localTitleFromMessages(messages),
        model: request.model?.trim() || LOCAL_DEFAULT_MODEL,
        status: 'complete',
        messageCount: messages.length,
        messages,
        createdAt: now,
        updatedAt: now
    };
    const map = readLocalMap();
    map[conversation.conversationId] = conversation;
    writeLocalMap(map);
    return { conversationId: conversation.conversationId };
};

// The append payload rules mirrored from the server's POST handler:
// explicit `messages` plus an optional single `message` (appended last as a
// user turn); at least one user message in the incoming set is required.
const localBuildIncomingMessages = (body: ConversationPostRequest): { messages: ChatMessage[]; error?: string } => {
    const explicitMessages = body.messages === undefined ? [] : localParseMessages(body.messages);
    if (explicitMessages === null) return { messages: [], error: 'messages must be an array of valid chat messages' };

    const hasMessage = typeof body.message === 'string' && body.message.trim().length > 0;
    if (!hasMessage && explicitMessages.length === 0) {
        return { messages: [], error: 'message or messages is required' };
    }

    const messages = hasMessage
        ? [...explicitMessages, { role: 'user' as const, content: body.message!.trim() }]
        : explicitMessages;

    if (!messages.some((message) => message.role === 'user')) {
        return { messages: [], error: 'at least one user message is required' };
    }

    return { messages };
};

// Append completed turns to a local conversation (identified POST),
// mirroring the server append semantics: model inheritance, usage
// aggregation, system-prompt prepend, and the title rule (a conversation
// that already has a user turn keeps its title; the system-prompt-only
// variant gains its title from the first appended user turn).
export const appendToLocalConversation = async (
    conversationId: string,
    request: ConversationPostRequest
): Promise<ConversationPostResponse> => {
    const map = readLocalMap();
    const existing = map[conversationId];
    if (!existing) throw notFound(conversationId);

    const optionError = localValidateOptions(request);
    if (optionError) throw new Error(optionError);
    const messageResult = localBuildIncomingMessages(request);
    if (messageResult.error) throw new Error(messageResult.error);

    const model = request.model?.trim() || existing.model;
    const turnUsage = localParseUsage(request.usage) ?? undefined;
    const usage = turnUsage ? localAccumulateUsage(existing.usage, turnUsage) : existing.usage;
    const messages = [
        ...existing.messages,
        ...(request.systemPrompt ? [{ role: 'system' as const, content: request.systemPrompt.trim() }] : []),
        ...messageResult.messages
    ];
    const updated: ConversationRecord = {
        ...existing,
        title: existing.messages.some((message) => message.role === 'user')
            ? existing.title
            : localTitleFromMessages(messageResult.messages),
        model,
        status: 'complete',
        messages,
        messageCount: messages.length,
        updatedAt: new Date().toISOString(),
        // A completed append clears any stored failure marker (the server
        // handler sets error: undefined on every successful append).
        error: undefined,
        ...(usage ? { usage } : {})
    };
    map[conversationId] = updated;
    writeLocalMap(map);
    return { conversationId };
};

// Replace the COMPLETE message history of a local conversation (identified
// PUT), mirroring the server's replace semantics: an explicit title wins
// over the first-line derivation; an explicit model overrides the recorded
// one; usage is a lifetime aggregate (omitted usage keeps the stored total,
// supplied usage accumulates onto it).
export const replaceLocalConversationMessages = async (
    conversationId: string,
    request: ConversationPutRequest
): Promise<ConversationGetResponse> => {
    const map = readLocalMap();
    const existing = map[conversationId];
    if (!existing) throw notFound(conversationId);

    if (request.model !== undefined && (typeof request.model !== 'string' || request.model.trim().length === 0)) {
        throw new Error('model must be a non-empty string');
    }
    if (request.title !== undefined && (typeof request.title !== 'string' || request.title.trim().length === 0)) {
        throw new Error('title must be a non-empty string');
    }
    if (localParseUsage(request.usage) === null) {
        throw new Error('usage must contain only numeric token counters');
    }
    if (request.messages === undefined) {
        throw new Error('messages must be an array of valid chat messages');
    }
    const messages = localParseMessages(request.messages);
    if (messages === null) {
        throw new Error('messages must be an array of valid chat messages');
    }

    const updated: ConversationRecord = {
        ...existing,
        title: request.title?.trim()
            || (messages.some((message) => message.role === 'user') ? localTitleFromMessages(messages) : existing.title),
        model: request.model?.trim() || existing.model,
        status: 'complete',
        messages,
        messageCount: messages.length,
        updatedAt: new Date().toISOString(),
        error: undefined,
        usage: request.usage === undefined
            ? existing.usage
            : localAccumulateUsage(existing.usage, localParseUsage(request.usage)!)
    };
    map[conversationId] = updated;
    writeLocalMap(map);
    return { conversationId, conversation: { ...updated, messages: [...updated.messages] } };
};

// Permanently remove a local conversation; a missing identifier rejects with
// the server 404 message (deleting an already-deleted chat cannot silently
// pretend success — the UI's delete guard surfaces it).
export const deleteLocalConversation = async (conversationId: string): Promise<{ conversationId: string }> => {
    const map = readLocalMap();
    if (!map[conversationId]) throw notFound(conversationId);
    delete map[conversationId];
    writeLocalMap(map);
    return { conversationId };
};
