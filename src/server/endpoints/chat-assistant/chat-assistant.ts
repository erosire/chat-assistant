// Conversation handlers for the collection and identified conversation resource.
// This service is PURE storage: model calls are performed by the UI against the
// runtime provider endpoints (runtime/endpoint/provider/private), and the results
// arrive here as ordinary chat messages to persist. The collection POST creates an
// empty persisted conversation, while the identified resource owns reading, adding
// messages, and permanent deletion.
import { randomUUID } from 'node:crypto';
import { arrayEnsures, isNumber, isObject, isString } from '@presource/core';
import { asHandlerMethod } from '@underload/service';
import type { ConversationPostRequest, ConversationRecord, ChatMessage } from '../../../api';
import { createChatStore, type ChatStore } from './chat-store';

// The default model is stored on each conversation so later turns do not depend on
// a process-wide mutable setting. It is only a fallback: the UI always supplies the
// concrete provider model it used for the turn.
export const DEFAULT_CHAT_MODEL = 'openai/gpt-5.6-sol';

// Handler variables provide deterministic test seams and permit service-level configuration.
type ChatHandlerVariables = {
    root?: string;
    chatStore?: ChatStore;
    conversationId?: () => string;
};

// Only the three documented roles are forwarded to the assistant provider.
const isChatRole = (value: unknown): value is ChatMessage['role'] =>
    value === 'system' || value === 'user' || value === 'assistant';

// Explicit histories are validated before persistence so malformed turns cannot
// create a conversation that later requests cannot safely send upstream.
const parseMessages = (value: unknown): ChatMessage[] | null => {
    if (!Array.isArray(value)) return null;

    const messages: ChatMessage[] = [];
    for (const candidate of arrayEnsures(value)) {
        if (!isObject(candidate)) return null;
        const role = candidate.role;
        const content = candidate.content;
        if (!isChatRole(role) || !isString(content) || content.trim().length === 0) return null;
        messages.push({ role, content: content.trim() });
    }
    return messages;
};

// Titles are derived from the first user turn and remain bounded for clients that
// display the record as a conversation label.
const titleFromMessages = (messages: ChatMessage[]): string => {
    const firstUser = messages.find((message) => message.role === 'user');
    const title = firstUser?.content.trim() || 'New conversation';
    return title.length > 80 ? `${title.slice(0, 77)}...` : title;
};

// Resolve the injected store or create the persistent store at the service root.
const resolveStore = (variables: ChatHandlerVariables): ChatStore => {
    if (variables.chatStore) return variables.chatStore;
    return createChatStore(variables.root ?? process.cwd());
};

// Usage is optional metadata reported by the provider through the UI; only the
// three numeric token counters are persisted so a malformed field cannot corrupt
// the stored record shape.
const parseUsage = (value: unknown): ConversationRecord['usage'] | null | undefined => {
    if (value === undefined) return undefined;
    if (!isObject(value)) return null;
    const usage: NonNullable<ConversationRecord['usage']> = {};
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens'] as const) {
        const candidate = value[key];
        if (candidate !== undefined) {
            if (!isNumber(candidate)) return null;
            usage[key] = candidate;
        }
    }
    return usage;
};

// Read and validate the request body shared by identified POST requests.
const buildIncomingMessages = (
    body: ConversationPostRequest
): { messages: ChatMessage[]; error?: string } => {
    const explicitMessages = body.messages === undefined ? [] : parseMessages(body.messages);
    if (explicitMessages === null) return { messages: [], error: 'messages must be an array of valid chat messages' };

    const hasMessage = isString(body.message) && body.message.trim().length > 0;
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

// Validate optional model and system prompt fields before any store or provider work.
const validateOptions = (body: ConversationPostRequest): string | undefined => {
    if (body.model !== undefined && (!isString(body.model) || body.model.trim().length === 0)) {
        return 'model must be a non-empty string';
    }
    if (body.systemPrompt !== undefined && (!isString(body.systemPrompt) || body.systemPrompt.trim().length === 0)) {
        return 'systemPrompt must be a non-empty string';
    }
    if (parseUsage(body.usage) === null) {
        return 'usage must contain only numeric token counters';
    }
    return undefined;
};

// POST /v1/chat-assistant/conversation creates a blank conversation and returns
// only its identifier, allowing the caller to retrieve it through the identified GET.
export const conversationCreate = asHandlerMethod(async (_, parameters, rawVariables) => {
    const variables = rawVariables as ChatHandlerVariables;
    const body = (parameters.body ?? {}) as ConversationPostRequest;
    const optionError = validateOptions(body);
    if (optionError) return { status: 400, response: { error: optionError } };

    // Tests and embedding services may provide a deterministic identifier factory;
    // normal service requests continue to use cryptographically random identifiers.
    const conversationId = variables.conversationId?.() ?? randomUUID();
    const now = new Date().toISOString();
    const messages: ChatMessage[] = body.systemPrompt
        ? [{ role: 'system', content: body.systemPrompt.trim() }]
        : [];
    const conversation: ConversationRecord = {
        conversationId,
        title: titleFromMessages(messages),
        model: body.model?.trim() || DEFAULT_CHAT_MODEL,
        status: 'complete',
        messageCount: messages.length,
        messages,
        createdAt: now,
        updatedAt: now
    };

    resolveStore(variables).upsert(conversation);
    return { status: 201, response: { conversationId } };
});

// GET /v1/chat-assistant/conversation/:conversation_id returns one persisted record.
export const conversationGet = asHandlerMethod(async (_, parameters, rawVariables) => {
    const variables = rawVariables as ChatHandlerVariables;
    const conversationId = parameters.path.conversation_id;
    if (!isString(conversationId) || conversationId.length === 0) {
        return { status: 400, response: { error: 'conversation_id is required' } };
    }

    const conversation = resolveStore(variables).get(conversationId);
    if (!conversation) {
        return { status: 404, response: { error: `Conversation '${conversationId}' not found` } };
    }
    return { status: 200, response: { conversationId, conversation } };
});

// POST /v1/chat-assistant/conversation/:conversation_id appends the supplied turns
// (the UI sends the completed user+assistant pair after the provider responds) and
// persists the updated record. No provider traffic happens here: the body already
// contains the model's reply, so this handler never returns 502.
export const conversationPost = asHandlerMethod(async (_, parameters, rawVariables) => {
    const variables = rawVariables as ChatHandlerVariables;
    const conversationId = parameters.path.conversation_id;
    const body = (parameters.body ?? {}) as ConversationPostRequest;
    if (!isString(conversationId) || conversationId.length === 0) {
        return { status: 400, response: { error: 'conversation_id is required' } };
    }

    const store = resolveStore(variables);
    const existing = store.get(conversationId);
    if (!existing) {
        return { status: 404, response: { error: `Conversation '${conversationId}' not found` } };
    }

    const optionError = validateOptions(body);
    if (optionError) return { status: 400, response: { error: optionError } };
    const messageResult = buildIncomingMessages(body);
    if (messageResult.error) return { status: 400, response: { error: messageResult.error } };

    // The recorded model follows the turn the UI just completed; the UI re-selects
    // that model on reload unless the user picks another one.
    const model = body.model?.trim() || existing.model;
    const usage = parseUsage(body.usage) ?? undefined;
    const messages = [
        ...existing.messages,
        ...(body.systemPrompt ? [{ role: 'system' as const, content: body.systemPrompt.trim() }] : []),
        ...messageResult.messages
    ];
    const conversation = store.upsert({
        ...existing,
        title: existing.messages.length === 0 ? titleFromMessages(messageResult.messages) : existing.title,
        model,
        status: 'complete',
        messages,
        messageCount: messages.length,
        updatedAt: new Date().toISOString(),
        error: undefined,
        ...(usage ? { usage } : {})
    });
    return { status: 200, response: { conversationId, conversation } };
});

// DELETE /v1/chat-assistant/conversation/:conversation_id permanently removes the
// complete conversation and returns 404 when the identifier was already absent.
export const conversationDelete = asHandlerMethod(async (_, parameters, rawVariables) => {
    const variables = rawVariables as ChatHandlerVariables;
    const conversationId = parameters.path.conversation_id;
    if (!isString(conversationId) || conversationId.length === 0) {
        return { status: 400, response: { error: 'conversation_id is required' } };
    }

    const store = resolveStore(variables);
    if (!store.delete(conversationId)) {
        return { status: 404, response: { error: `Conversation '${conversationId}' not found` } };
    }
    return { status: 200, response: { conversationId } };
});

// Named aliases keep the endpoint barrel readable while making the resource
// operation names explicit for callers that import these handlers directly.
export const chatAssistantCreate = conversationCreate;
export const chatAssistantGet = conversationGet;
export const chatAssistantPost = conversationPost;
export const chatAssistantDelete = conversationDelete;
