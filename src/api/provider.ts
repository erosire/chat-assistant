// Client for the runtime provider endpoints (runtime/endpoint/provider/private).
// The provider owns every credential server-side: clients are routed by their pinned
// `model` (runtime/endpoint/provider/private/models/index.ts), so the browser sends
// no API key and none is ever stored in the UI.
import { isString } from '@presource/core';
import type { ChatMessage, ConversationRecord } from './chat-assistant';

// Absolute deployment-independent backend origin: relative defaults resolved
// against the STATIC host (github.io) and 404ed — see ./server-url.ts.
import { DEFAULT_SERVER_URL } from './server-url';

// Default provider base matches BASE_URL in runtime/endpoint/provider/private/constant.ts,
// pinned to the real backend origin (not the static hosting origin) so GitHub
// Pages deployments reach the LAN server; embedders can still override via the
// ChatAssistantApp providerUrl prop.
export const DEFAULT_PROVIDER_URL = `${DEFAULT_SERVER_URL}/providers/private/v1`;

// One entry of the OpenAI-compatible /models catalog; only `id` is consumed by the UI.
export type ProviderModel = {
    id: string;
    object?: string;
    created?: number;
    owned_by?: string;
    context_length?: number;
};

// Envelope returned by GET {provider}/models (see private/models/service-route.ts).
export type ProviderModelsResponse = {
    object: 'list';
    data: ProviderModel[];
};

// Minimal assistant reply assembled from the streamed chat completion.
export type ProviderChatCompletion = {
    content: string;
    usage?: ConversationRecord['usage'];
};

// One SSE `data:` frame of an OpenAI-compatible chat.completion.chunk as relayed by
// runtime/endpoint/provider/private/chat-completion/private-chat-completion.ts
// (`data: {json}\n\n` per chunk, `data: [DONE]\n\n` terminator). GPT clients add a
// `reasoning_content` extension delta (ignored here) and a final usage chunk;
// Makora/Modal pass raw SDK chunks through without a usage chunk.
type ProviderStreamChunk = {
    choices?: Array<{
        delta?: { role?: unknown; content?: unknown };
        finish_reason?: string | null;
    }>;
    usage?: ConversationRecord['usage'];
    // Mid-stream failures arrive as a plain data frame from the server's catch-all
    // (`data: {"error":{"message":"...","type":"stream_error"}}`, no trailing [DONE]).
    error?: { message?: unknown; type?: string };
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

// GET {provider}/models returns every model the private provider registry can serve;
// routing keys come straight from each client's pinned model, so `id` is the exact
// value that must be sent back as `model` in the chat completion request.
export async function fetchProviderModels(baseUrl: string): Promise<ProviderModel[]> {
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}/models`, { method: 'GET' });
    if (!response.ok) {
        throw new Error(await errorMessage(response, 'Failed to fetch provider models'));
    }

    const data = (await response.json()) as Partial<ProviderModelsResponse>;
    if (!Array.isArray(data.data)) {
        throw new Error('Provider models response did not include a data list');
    }
    return data.data;
}

// Outgoing history is mapped to plain {role, content} messages: ChatMessage may
// carry storage-only metadata (the per-message `model` attribution used to mark
// which model produced each response — see chat-assistant.ts), and strict
// OpenAI-compatible providers reject unknown fields on messages.
const toProviderMessages = (messages: ChatMessage[]): Array<Pick<ChatMessage, 'role' | 'content'>> =>
    messages.map(({ role, content }) => ({ role, content }));

// POST {provider}/chat/completions with stream: true and the complete conversation
// history. The provider injects credentials itself (key rotation lives in the
// private model clients), so no Authorization header is ever set from the browser.
// `onSnapshot` receives the ACCUMULATED assistant text after every content delta so
// the caller can render live progress. Resolves at [DONE]/connection-close with the
// full content plus usage when the final chunk provided it. Errors: non-2xx rejects
// before streaming ("Model 'x' not found", failover 500); a mid-stream {"error":...}
// frame rejects with its message.
export async function streamProviderChatCompletion(
    baseUrl: string,
    model: string,
    messages: ChatMessage[],
    onSnapshot: (content: string) => void
): Promise<ProviderChatCompletion> {
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, stream: true, messages: toProviderMessages(messages) })
    });
    if (!response.ok) {
        throw new Error(await errorMessage(response, 'Provider chat completion failed'));
    }
    if (!response.body) {
        throw new Error('Provider chat completion returned no stream body');
    }

    // Reader loop mirrors the readSSEResponse pattern in
    // packages/agentic/harness/simple/modules/simple-client.ts: decode incrementally,
    // split on newlines, and keep the partial tail so frames split across network
    // chunks are reassembled before parsing.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let usage: ConversationRecord['usage'] | undefined;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const raw of lines) {
                const line = raw.trim();
                // The producer emits only `data:` frames; blank separators are skipped.
                if (!line.startsWith('data:')) continue;
                const data = line.slice('data:'.length).trim();
                if (data.length === 0 || data === '[DONE]') continue;
                const parsed = JSON.parse(data) as ProviderStreamChunk;
                // Server catch-all: stream aborted after it started (start.ts:234-243).
                if (parsed.error) {
                    const message = parsed.error.message;
                    throw new Error(isString(message) && message.length > 0 ? message : 'Provider stream terminated');
                }
                const delta = parsed.choices?.[0]?.delta;
                if (delta && isString(delta.content) && delta.content.length > 0) {
                    content += delta.content;
                    onSnapshot(content);
                }
                // GPT clients append a final empty-delta chunk carrying the turn's usage.
                if (parsed.usage) usage = parsed.usage;
            }
        }
    } catch (reason) {
        // Abandon the SSE body so the connection is not left dangling on failures.
        await reader.cancel().catch(() => undefined);
        throw reason;
    }

    if (content.length === 0) {
        throw new Error('Provider chat completion returned no text content');
    }
    return { content, ...(usage ? { usage } : {}) };
}
