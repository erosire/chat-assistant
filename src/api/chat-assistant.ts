// Client for GET and POST /v1/chat-assistant/.
//
// GET without a chatId returns a compact list for the conversation sidebar.
// GET with ?chatId=... returns the complete persisted conversation.
// POST creates a conversation when chatId is omitted, or appends a user message
// to an existing conversation when chatId is supplied.

// The trailing slash matches the public route registered by the service module.
export const DEFAULT_CHAT_ASSISTANT_URL = '/v1/chat-assistant/';

// The only message roles accepted by the server and rendered by the UI.
export type ChatMessage = {
    role: 'system' | 'user' | 'assistant';
    content: string;
};

// Compact list item returned by GET without a chatId.
export type ChatSummary = {
    chatId: string;
    title: string;
    model: string;
    status: 'complete' | 'error';
    messageCount: number;
    createdAt: string;
    updatedAt: string;
};

// Complete conversation returned by GET with a chatId and by a successful POST.
export type ChatRecord = ChatSummary & {
    messages: ChatMessage[];
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
    };
    error?: string;
};

// POST accepts either one user message or an explicit conversation history.
export type ChatAssistantPostRequest = {
    chatId?: string;
    message?: string;
    messages?: ChatMessage[];
    model?: string;
    systemPrompt?: string;
};

// POST returns the identifier and the synchronously completed record.
export type ChatAssistantPostResponse = {
    chatId: string;
    chat: ChatRecord;
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

// Fetch the compact sidebar list.
export async function fetchChatList(baseUrl = DEFAULT_CHAT_ASSISTANT_URL): Promise<{ chats: ChatSummary[] }> {
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}/`, { method: 'GET' });
    if (!response.ok) {
        throw new Error(await errorMessage(response, 'Failed to list chats'));
    }

    const data = (await response.json()) as { chats?: ChatSummary[] };
    return { chats: Array.isArray(data.chats) ? data.chats : [] };
}

// Fetch one complete conversation for display or refresh.
export async function fetchChat(
    baseUrl: string,
    chatId: string
): Promise<ChatRecord> {
    const query = new URLSearchParams({ chatId });
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}/?${query.toString()}`, { method: 'GET' });
    if (!response.ok) {
        throw new Error(await errorMessage(response, 'Failed to fetch chat'));
    }

    const data = (await response.json()) as { chat?: ChatRecord };
    if (!data.chat) throw new Error('Chat response did not include a chat record');
    return data.chat;
}

// Create a chat or send a follow-up message, surfacing server validation errors verbatim.
export async function createChat(
    baseUrl: string,
    request: ChatAssistantPostRequest
): Promise<ChatAssistantPostResponse> {
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request)
    });
    if (!response.ok) {
        throw new Error(await errorMessage(response, 'Failed to send chat message'));
    }

    return (await response.json()) as ChatAssistantPostResponse;
}
