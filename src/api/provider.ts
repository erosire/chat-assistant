// Client for the runtime provider endpoints (runtime/endpoint/provider/private).
// The provider owns every credential server-side: clients are routed by their pinned
// `model` (runtime/endpoint/provider/private/models/index.ts), so the browser sends
// no API key and none is ever stored in the UI.
import { isString } from '@presource/core';
import type { ChatMessage, ConversationRecord } from './chat-assistant';

// Default provider base matches BASE_URL in runtime/endpoint/provider/private/constant.ts.
export const DEFAULT_PROVIDER_URL = '/providers/private/v1';

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

// Minimal assistant reply extracted from the non-streaming chat completion.
export type ProviderChatCompletion = {
    content: string;
    usage?: ConversationRecord['usage'];
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

// POST {provider}/chat/completions with the complete conversation history. The
// provider injects credentials itself (key rotation lives in the private model
// clients), so no Authorization header is ever set from the browser.
export async function createProviderChatCompletion(
    baseUrl: string,
    model: string,
    messages: ChatMessage[]
): Promise<ProviderChatCompletion> {
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, stream: false, messages })
    });
    if (!response.ok) {
        throw new Error(await errorMessage(response, 'Provider chat completion failed'));
    }

    const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
        usage?: ConversationRecord['usage'];
    };
    const content = data.choices?.[0]?.message?.content;
    if (!isString(content) || content.length === 0) {
        throw new Error('Provider chat completion returned no text content');
    }

    return { content, ...(data.usage ? { usage: data.usage } : {}) };
}
