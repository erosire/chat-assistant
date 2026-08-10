// Client for the two conversation resources exposed by the service.
// The collection accepts GET (history list) and POST (creation, including a
// complete history when the UI forks a conversation), while the
// identified resource accepts GET, POST (append), PUT (history replacement for
// the edit-history flow), and DELETE; no query-string identifier is used. This
// API is pure chat storage: model traffic goes through ./provider.ts against
// the runtime provider endpoints, and only completed turns are persisted here.

// Absolute deployment-independent backend origin: relative defaults resolved
// against the STATIC host (github.io) and 404ed — see ./server-url.ts.
import { DEFAULT_SERVER_URL } from './server-url';

// Default storage endpoint pinned to the real backend origin (not the static
// hosting origin) so GitHub Pages deployments reach the LAN server; embedders
// can still override via the ChatAssistantApp baseUrl prop.
export const DEFAULT_CHAT_ASSISTANT_URL = `${DEFAULT_SERVER_URL}/v1/chat-assistant/conversation`;

// The only message roles accepted by the server and rendered by the UI.
// `model` is optional per-message attribution: the UI records the provider model
// that produced an assistant turn so each response can mark its origin (see the
// AssistantTurn caption in components/ChatAssistantApp.tsx). The provider client
// strips the field before sending history upstream.
export type ChatMessage = {
    role: 'system' | 'user' | 'assistant';
    content: string;
    model?: string;
};

// Complete conversation returned by GET and persisted by both POST operations.
export type ConversationRecord = {
    conversationId: string;
    title: string;
    model: string;
    status: 'complete' | 'error';
    messageCount: number;
    messages: ChatMessage[];
    createdAt: string;
    updatedAt: string;
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
    };
    error?: string;
};

// Both POST operations accept one user message or an explicit initial/message history.
// `usage` mirrors the token counters reported by the provider for the stored turn.
export type ConversationPostRequest = {
    message?: string;
    messages?: ChatMessage[];
    model?: string;
    systemPrompt?: string;
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
    };
};

// Creation and append requests return only the identifier; callers then use GET
// to read the canonical persisted conversation representation.
export type ConversationPostResponse = {
    conversationId: string;
};

// History-replacement request used by the edit-history flow: the UI sends the
// complete (edited) message list and the server persists it verbatim, deriving
// messageCount/updatedAt/title from it. Supports the same optional model field
// so the record-level model stays accurate after edits, and an optional explicit
// title so the header rename flow can pin a custom label (it wins over the
// derived first-line title).
export type ConversationPutRequest = {
    messages: ChatMessage[];
    model?: string;
    title?: string;
};

// GET wraps the persisted record so the response remains extensible without
// changing the identifier returned by POST.
export type ConversationGetResponse = {
    conversationId: string;
    conversation: ConversationRecord;
};

// Compact history-list entry returned by the collection GET. Message bodies are
// deliberately excluded so restoring the chat history stays cheap; the full
// record for one entry is read through the identified GET.
export type ConversationSummary = Pick<
    ConversationRecord,
    'conversationId' | 'title' | 'model' | 'status' | 'messageCount' | 'createdAt' | 'updatedAt'
>;

// Collection GET wraps the summary list so the response remains extensible.
export type ConversationListResponse = {
    conversations: ConversationSummary[];
};

// DELETE reports the removed identifier after the record has been deleted.
export type ConversationDeleteResponse = {
    conversationId: string;
};

// Convert a base URL into one stable form without changing an absolute or relative origin.
const normalizeBaseUrl = (baseUrl: string): string => baseUrl.replace(/\/+$/, '');

// Read a server error body when available, while retaining a deterministic status fallback.
const errorMessage = async (response: Response, fallback: string): Promise<string> => {
    try {
        const data = await response.json();
        if (typeof data?.error === 'string' && data.error.length > 0) return data.error;
    } catch {
        // A non-JSON error response still receives the status-based fallback below.
    }
    return `${fallback} (HTTP ${response.status})`;
};

// Fetch one complete conversation by using the required path identifier.
export async function fetchConversation(
    baseUrl: string,
    conversationId: string
): Promise<ConversationGetResponse> {
    const response = await fetch(
        `${normalizeBaseUrl(baseUrl)}/${encodeURIComponent(conversationId)}`,
        { method: 'GET' }
    );
    if (!response.ok) {
        throw new Error(await errorMessage(response, 'Failed to fetch conversation'));
    }

    const data = (await response.json()) as Partial<ConversationGetResponse>;
    if (!data.conversation || typeof data.conversationId !== 'string') {
        throw new Error('Conversation response did not include a conversation record');
    }
    return data as ConversationGetResponse;
}

// Read every persisted conversation as a compact summary from the collection
// resource; the server orders the list by most recent activity (updatedAt
// descending). The UI calls this on mount so the chat history survives a reload.
export async function listConversations(baseUrl: string): Promise<ConversationListResponse> {
    const response = await fetch(normalizeBaseUrl(baseUrl), { method: 'GET' });
    if (!response.ok) {
        throw new Error(await errorMessage(response, 'Failed to list conversations'));
    }

    const data = (await response.json()) as Partial<ConversationListResponse>;
    if (!Array.isArray(data.conversations)) {
        throw new Error('Conversation list response did not include a conversations list');
    }
    return data as ConversationListResponse;
}

// Create a conversation and return its identifier for the follow-up GET request.
export async function createConversation(
    baseUrl: string,
    request: ConversationPostRequest
): Promise<ConversationPostResponse> {
    const response = await fetch(normalizeBaseUrl(baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request)
    });
    if (!response.ok) {
        throw new Error(await errorMessage(response, 'Failed to create conversation'));
    }

    return (await response.json()) as ConversationPostResponse;
}

// Append a user turn to an existing conversation and return the same identifier
// so the caller can retrieve the updated record with GET.
export async function addToConversation(
    baseUrl: string,
    conversationId: string,
    request: ConversationPostRequest
): Promise<ConversationPostResponse> {
    const response = await fetch(
        `${normalizeBaseUrl(baseUrl)}/${encodeURIComponent(conversationId)}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request)
        }
    );
    if (!response.ok) {
        throw new Error(await errorMessage(response, 'Failed to add to conversation'));
    }

    return (await response.json()) as ConversationPostResponse;
}

// Replace the complete message history of an existing conversation (edit flow).
// Unlike POST (append) this returns the full updated record so the caller can
// re-sync its local selection without a follow-up GET.
export async function replaceConversationMessages(
    baseUrl: string,
    conversationId: string,
    request: ConversationPutRequest
): Promise<ConversationGetResponse> {
    const response = await fetch(
        `${normalizeBaseUrl(baseUrl)}/${encodeURIComponent(conversationId)}`,
        {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request)
        }
    );
    if (!response.ok) {
        throw new Error(await errorMessage(response, 'Failed to replace conversation messages'));
    }

    const data = (await response.json()) as Partial<ConversationGetResponse>;
    if (!data.conversation || typeof data.conversationId !== 'string') {
        throw new Error('Conversation response did not include a conversation record');
    }
    return data as ConversationGetResponse;
}

// Permanently remove a conversation through the identified resource.
export async function deleteConversation(
    baseUrl: string,
    conversationId: string
): Promise<ConversationDeleteResponse> {
    const response = await fetch(
        `${normalizeBaseUrl(baseUrl)}/${encodeURIComponent(conversationId)}`,
        { method: 'DELETE' }
    );
    if (!response.ok) {
        throw new Error(await errorMessage(response, 'Failed to delete conversation'));
    }

    return (await response.json()) as ConversationDeleteResponse;
}
