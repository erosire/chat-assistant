// Client for the two conversation resources exposed by the service.
// The collection accepts POST for creation, while the identified resource accepts
// GET, POST, and DELETE; no collection GET or query-string identifier is used.
// This API is pure chat storage: model traffic goes through ./provider.ts against
// the runtime provider endpoints, and only completed turns are persisted here.
export const DEFAULT_CHAT_ASSISTANT_URL = '/v1/chat-assistant/conversation';

// The only message roles accepted by the server and rendered by the UI.
export type ChatMessage = {
    role: 'system' | 'user' | 'assistant';
    content: string;
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

// GET wraps the persisted record so the response remains extensible without
// changing the identifier returned by POST.
export type ConversationGetResponse = {
    conversationId: string;
    conversation: ConversationRecord;
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
