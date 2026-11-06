// Conversation-storage SERVICE facade for the dashboard plugins.
//
// WHAT THIS IS: one mode-agnostic `ConversationStore` over the two existing,
// working storage implementations, so a chat plugin never branches on the
// assistant mode:
//   - 'online'  → the conversation REST client in ../../api/chat-assistant.ts
//     (server-side storage at {baseUrl}).
//   - 'offline' → the durable browser-local store in ../../api/offline.ts,
//     which already mirrors the server handler semantics (title derivation,
//     model inheritance, usage aggregation, the append/replace/fork rules and
//     the 404-equivalent messages) with the IDENTICAL Promise shapes.
// This module ADAPTS; it duplicates no HTTP, no localStorage and no server
// semantics. The mode dispatch is the same one the shipped UI uses
// (components/ChatAssistantApp.tsx:2477-2503).
//
// THE ONE DELTA versus the component's private `storage` object: the interface
// here returns the full `ConversationRecord` from create/append (the component
// version returns only `{conversationId}` and issues its own follow-up GET).
// The follow-up read is the documented wire protocol — both POST operations
// return only the identifier (api/chat-assistant.ts:70-74), so `read()` is the
// canonical record read. Nothing else changes.
//
// TRACKED IDS: the browser-owned cache in api/chat-assistant.ts
// (localStorage key `chat-assistant:tracked-conversations`, unchanged). Online
// it is the sidebar's authority: `create` tracks the new id BEFORE the
// follow-up read, `remove` untracks only AFTER the store confirms, and `list`
// prunes requested ids the server no longer returns — exactly the three rules
// of components/ChatAssistantApp.tsx:2485-2502 and :2810-2817. The same cache
// helpers back offline mode (the interface stays total across a mode switch,
// and a later online `list` prunes any local-only id the server has never
// seen), while offline `list` keeps ignoring the id filter because the local
// store is already browser-scoped (components/ChatAssistantApp.tsx:2478).
import {
    addToConversation,
    createConversation,
    DEFAULT_CHAT_ASSISTANT_URL,
    deleteConversation,
    fetchConversation,
    listConversations,
    readTrackedConversationIds,
    replaceConversationMessages,
    trackConversationId,
    untrackConversationId
} from '../../api/chat-assistant';
import type {
    ConversationPostRequest,
    ConversationPutRequest,
    ConversationRecord,
    ConversationSummary
} from '../../api/chat-assistant';
import {
    appendToLocalConversation,
    createLocalConversation,
    deleteLocalConversation,
    getLocalConversation,
    listLocalConversations,
    replaceLocalConversationMessages
} from '../../api/offline';

// The two assistant modes, narrowed to the storage concern. Same discriminator
// as `AssistantMode` in ../../api/offline.ts:34-48.
export type ConversationStoreMode = 'online' | 'offline';

// The unified storage contract every chat plugin consumes. Both modes resolve
// the same shapes, so a mode switch is a re-created store, never new call sites.
export interface ConversationStore {
    // The mode this instance was built for (mirrors `ConversationStoreMode`).
    readonly mode: ConversationStoreMode;
    // Compact summaries, most recent activity first (both implementations
    // already order by `updatedAt` descending — the UI re-sorts nothing).
    list(ids: string[]): Promise<ConversationSummary[]>;
    create(input: ConversationPostRequest): Promise<ConversationRecord>;
    read(id: string): Promise<ConversationRecord>;
    append(id: string, input: ConversationPostRequest): Promise<ConversationRecord>;
    replace(id: string, input: ConversationPutRequest): Promise<ConversationRecord>;
    remove(id: string): Promise<void>;
    // The browser's own tracked-id cache (see the header comment).
    tracked(): string[];
    track(id: string): void;
    untrack(id: string): void;
}

// Factory options. `baseUrl` is the conversation-storage origin (online mode
// only). `providerBase` is the user-configured OpenAI-compatible provider used
// by the STREAMING service, accepted here so a plugin can pass one options
// object to both factories; conversation storage is pure persistence
// (api/chat-assistant.ts carries no model traffic), so this facade never sends
// it anywhere.
export interface ConversationStoreOptions {
    baseUrl?: string;
    providerBase?: string;
}

// Build the store for one mode. Plain object + closures (no class, no React):
// every method is a stable reference and can be passed to a plugin `services`
// registry directly.
export function createConversationStore(
    mode: ConversationStoreMode,
    options: ConversationStoreOptions = {}
): ConversationStore {
    // Anything that is not explicitly 'offline' is online: the shipped settings
    // loader degrades corrupt/absent settings to 'online' (api/offline.ts:133
    // -146), so the storage layer must not invent a third behavior.
    const offline = mode === 'offline';

    // Online base URL: an omitted/blank option resolves to the client's own
    // default (the LAN storage origin), i.e. the same value the shipped UI's
    // `baseUrl` prop defaults to. Trailing slashes are normalized inside the
    // api client, so nothing is duplicated here.
    const baseUrl = (options.baseUrl ?? '').trim() || DEFAULT_CHAT_ASSISTANT_URL;

    // Canonical record read, shared by `read()` and the post-write follow-up
    // GETs of create/append. Both branches return the same
    // `ConversationGetResponse` envelope, so only the record is unwrapped.
    const readRecord = async (id: string): Promise<ConversationRecord> => {
        const response = offline ? await getLocalConversation(id) : await fetchConversation(baseUrl, id);
        return response.conversation;
    };

    // Identifier-only write (create and append share the wire contract: a POST
    // answers with just the id — api/chat-assistant.ts:70-74 and api/offline.ts
    // mirror it exactly), returning the id the caller then reads back.
    const writeRequest = async (
        id: string | undefined,
        input: ConversationPostRequest
    ): Promise<string> => {
        const response = id === undefined
            ? await (offline ? createLocalConversation(input) : createConversation(baseUrl, input))
            : await (offline ? appendToLocalConversation(id, input) : addToConversation(baseUrl, id, input));
        return response.conversationId;
    };

    return {
        mode,

        list: async (ids: string[]): Promise<ConversationSummary[]> => {
            if (offline) {
                // No id filter locally: every persisted record belongs to THIS
                // browser, so the tracked cache would only hide its own chats.
                const response = await listLocalConversations();
                return response.conversations;
            }

            const response = await listConversations(baseUrl, ids);
            const returned = new Set(response.conversations.map((entry) => entry.conversationId));
            // Prune the requested ids the server no longer holds (deleted in
            // another tab/device) so the cache never accumulates dead entries
            // (components/ChatAssistantApp.tsx:2810-2817). Pruning `ids` rather
            // than the whole cache keeps an explicitly scoped query from
            // dropping the conversations this call never asked about.
            for (const id of ids) {
                if (!returned.has(id)) untrackConversationId(id);
            }
            return response.conversations;
        },

        create: async (input: ConversationPostRequest): Promise<ConversationRecord> => {
            const conversationId = await writeRequest(undefined, input);
            // Track BEFORE the follow-up read so a reload mid-flow still
            // restores the conversation that was just created
            // (components/ChatAssistantApp.tsx:2489-2491).
            trackConversationId(conversationId);
            return readRecord(conversationId);
        },

        read: readRecord,

        append: async (id: string, input: ConversationPostRequest): Promise<ConversationRecord> => {
            await writeRequest(id, input);
            // The append settles the record server-side (or locally); re-read
            // the canonical persisted state instead of guessing it here.
            return readRecord(id);
        },

        replace: async (id: string, input: ConversationPutRequest): Promise<ConversationRecord> => {
            // Both replace operations already answer with the full updated
            // record (api/chat-assistant.ts:218-243, api/offline.ts:481-528),
            // so no follow-up read is needed.
            const response = offline
                ? await replaceLocalConversationMessages(id, input)
                : await replaceConversationMessages(baseUrl, id, input);
            return response.conversation;
        },

        remove: async (id: string): Promise<void> => {
            if (offline) await deleteLocalConversation(id);
            else await deleteConversation(baseUrl, id);
            // Untrack only AFTER the store confirmed the removal, so a failed
            // delete keeps the conversation tracked and restorable
            // (components/ChatAssistantApp.tsx:2498-2500).
            untrackConversationId(id);
        },

        tracked: readTrackedConversationIds,
        track: trackConversationId,
        untrack: untrackConversationId
    };
}
