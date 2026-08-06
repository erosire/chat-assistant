// GET and POST handlers for /v1/chat-assistant/.
//
// The POST handler intentionally completes one assistant response before
// returning. This keeps the first API version simple and deterministic; a
// future streaming endpoint can reuse the persisted ChatRecord shape without
// changing the GET contract.
import { randomUUID } from 'node:crypto';
import { arrayEnsures, isObject, isString } from '@presource/core';
import { asHandlerMethod } from '@underload/service';
import type { ChatAssistantPostRequest, ChatMessage, ChatRecord, ChatSummary } from '../../../api';
import { createChatStore, type ChatStore } from './chat-store';

// Default model and upstream endpoint can be overridden without changing the route contract.
export const DEFAULT_CHAT_MODEL = 'openai/gpt-5.6-sol';
export const DEFAULT_CHAT_UPSTREAM_URL = 'http://localhost:5000/providers/cloud/v1';

// The provider response is deliberately small because only text and usage are persisted.
export type AssistantReply = {
    content: string;
    usage?: ChatRecord['usage'];
};

// Handler variables provide a test seam and permit service-level configuration.
type ChatHandlerVariables = {
    root?: string;
    chatStore?: ChatStore;
    assistantReply?: (messages: ChatMessage[], model: string) => Promise<AssistantReply>;
    assistantUpstreamUrl?: string;
};

// Normalise a role so malformed client payloads are rejected instead of reaching the model.
const isChatRole = (value: unknown): value is ChatMessage['role'] =>
    value === 'system' || value === 'user' || value === 'assistant';

// Convert an explicit message array into the narrow wire type used by the service.
const parseMessages = (value: unknown): ChatMessage[] | null => {
    if (!Array.isArray(value)) return null;

    const messages: ChatMessage[] = [];
    for (const candidate of arrayEnsures(value)) {
        if (!isObject(candidate)) return null;
        const role = candidate.role;
        const content = candidate.content;
        if (!isChatRole(role) || !isString(content) || content.trim().length === 0) return null;
        messages.push({ role, content });
    }
    return messages;
};

// Select the user's first message as a stable sidebar title and avoid unbounded labels.
const titleFromMessages = (messages: ChatMessage[]): string => {
    const firstUser = messages.find((message) => message.role === 'user');
    const title = firstUser?.content.trim() || 'New chat';
    return title.length > 80 ? `${title.slice(0, 77)}...` : title;
};

// Build a summary without exposing the full conversation in the collection response.
const summarize = (record: ChatRecord): ChatSummary => ({
    chatId: record.chatId,
    title: record.title,
    model: record.model,
    status: record.status,
    messageCount: record.messages.length,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
});

// Resolve the test-injected store or create the persistent store at the service root.
const resolveStore = (variables: ChatHandlerVariables): ChatStore => {
    if (variables.chatStore) return variables.chatStore;
    return createChatStore(variables.root ?? process.cwd());
};

// Call the OpenAI-compatible upstream chat-completions endpoint without exposing
// provider credentials to the browser. The local cloud provider needs no key;
// CHAT_ASSISTANT_API_KEY is added when an external compatible endpoint is used.
export const requestAssistantReply = async (
    messages: ChatMessage[],
    model: string,
    upstreamUrl = process.env.CHAT_ASSISTANT_UPSTREAM_URL ?? DEFAULT_CHAT_UPSTREAM_URL
): Promise<AssistantReply> => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const apiKey = process.env.CHAT_ASSISTANT_API_KEY;
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const response = await fetch(`${upstreamUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, stream: false, messages })
    });

    if (!response.ok) {
        const detail = await response.text();
        throw new Error(detail || `Assistant upstream failed with HTTP ${response.status}`);
    }

    const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
        usage?: ChatRecord['usage'];
    };
    const content = data.choices?.[0]?.message?.content;
    if (!isString(content) || content.length === 0) {
        throw new Error('Assistant upstream returned no text content');
    }

    return { content, ...(data.usage ? { usage: data.usage } : {}) };
};

// GET /v1/chat-assistant/ lists all conversations or reads one with ?chatId=.
export const chatAssistantGet = asHandlerMethod(async (_, parameters, rawVariables) => {
    const variables = rawVariables as ChatHandlerVariables;
    const store = resolveStore(variables);
    const chatId = parameters.query.chatId;

    if (isString(chatId) && chatId.length > 0) {
        const chat = store.get(chatId);
        if (!chat) return { status: 404, response: { error: `Chat '${chatId}' not found` } };
        return { status: 200, response: { chat } };
    }

    const chats = store
        .list()
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map(summarize);
    return { status: 200, response: { chats } };
});

// Validate and combine a POST payload with an existing record when chatId is supplied.
const buildMessages = (
    body: ChatAssistantPostRequest,
    existing: ChatRecord | null
): { messages: ChatMessage[]; error?: string } => {
    const explicitMessages = body.messages === undefined ? [] : parseMessages(body.messages);
    if (explicitMessages === null) return { messages: [], error: 'messages must be an array of valid chat messages' };

    const hasMessage = isString(body.message) && body.message.trim().length > 0;
    if (!hasMessage && explicitMessages.length === 0) {
        return { messages: [], error: 'message or messages is required' };
    }

    const incoming = hasMessage
        ? [...explicitMessages, { role: 'user' as const, content: body.message!.trim() }]
        : explicitMessages;
    const messages = existing ? [...existing.messages, ...incoming] : incoming;

    if (!messages.some((message) => message.role === 'user')) {
        return { messages: [], error: 'at least one user message is required' };
    }

    return { messages };
};

// POST /v1/chat-assistant/ creates a record, asks the configured assistant, and saves the result.
export const chatAssistantPost = asHandlerMethod(async (_, parameters, rawVariables) => {
    const variables = rawVariables as ChatHandlerVariables;
    const body = (parameters.body ?? {}) as ChatAssistantPostRequest;
    const store = resolveStore(variables);

    const requestedChatId = isString(body.chatId) && body.chatId.length > 0 ? body.chatId : undefined;
    // A caller may provide a client-generated id for a brand-new chat; an id is
    // treated as an update only when the corresponding record already exists.
    const existing = requestedChatId ? store.get(requestedChatId) : null;

    if (body.model !== undefined && (!isString(body.model) || body.model.trim().length === 0)) {
        return { status: 400, response: { error: 'model must be a non-empty string' } };
    }
    if (body.systemPrompt !== undefined && (!isString(body.systemPrompt) || body.systemPrompt.trim().length === 0)) {
        return { status: 400, response: { error: 'systemPrompt must be a non-empty string' } };
    }

    const messageResult = buildMessages(body, existing);
    if (messageResult.error) return { status: 400, response: { error: messageResult.error } };

    const chatId = existing?.chatId ?? requestedChatId ?? randomUUID();
    const model = body.model?.trim() || existing?.model || DEFAULT_CHAT_MODEL;
    const now = new Date().toISOString();
    const messages = existing
        ? messageResult.messages
        : body.systemPrompt
          ? [{ role: 'system' as const, content: body.systemPrompt.trim() }, ...messageResult.messages]
          : messageResult.messages;
    const pending: ChatRecord = {
        chatId,
        title: existing?.title ?? titleFromMessages(messages),
        model,
        status: 'complete',
        messageCount: messages.length,
        messages,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
    };

    // Save the user request before contacting the provider so a provider failure leaves an inspectable record.
    store.upsert(pending);

    try {
        const reply = await (variables.assistantReply ?? ((requestMessages, requestModel) =>
            requestAssistantReply(requestMessages, requestModel, variables.assistantUpstreamUrl)))(messages, model);
        const completed: ChatRecord = {
            ...pending,
            status: 'complete',
            messages: [...messages, { role: 'assistant', content: reply.content }],
            messageCount: messages.length + 1,
            updatedAt: new Date().toISOString(),
            ...(reply.usage ? { usage: reply.usage } : {})
        };
        const chat = store.upsert(completed);
        return { status: 200, response: { chatId, chat } };
    } catch (error) {
        const failed: ChatRecord = {
            ...pending,
            status: 'error',
            updatedAt: new Date().toISOString(),
            error: error instanceof Error ? error.message : String(error)
        };
        const chat = store.upsert(failed);
        return { status: 502, response: { chatId, chat, error: failed.error } };
    }
});
