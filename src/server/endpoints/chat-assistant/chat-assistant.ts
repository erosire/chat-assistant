// Conversation handlers for the collection and identified conversation resource.
// This service is PURE storage: model calls are performed by the UI against the
// runtime provider endpoints (runtime/endpoint/provider/private), and the results
// arrive here as ordinary chat messages to persist. The collection GET lists every
// persisted conversation as a compact summary (so a reloaded UI restores its chat
// history), the collection POST creates an empty persisted conversation, and the
// identified resource owns reading, adding messages, and permanent deletion.
import { randomUUID } from 'node:crypto';
import { arrayEnsures, isNumber, isObject, isString } from '@presource/core';
import { asHandlerMethod } from '@underload/service';
import type { ConversationPostRequest, ConversationPutRequest, ConversationRecord, ConversationSummary, ChatMessage } from '../../../api';
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
// create a conversation that later requests cannot safely send upstream. Each
// message may also carry the model that produced it (assistant turns): the UI
// persists this attribution so every response can mark its origin. When present
// the field must be a non-empty string and survives storage verbatim (trimmed).
const parseMessages = (value: unknown): ChatMessage[] | null => {
    if (!Array.isArray(value)) return null;

    const messages: ChatMessage[] = [];
    for (const candidate of arrayEnsures(value)) {
        if (!isObject(candidate)) return null;
        const role = candidate.role;
        const content = candidate.content;
        if (!isChatRole(role) || !isString(content) || content.trim().length === 0) return null;
        const model = candidate.model;
        if (model !== undefined && (!isString(model) || model.trim().length === 0)) return null;
        messages.push({
            role,
            content: content.trim(),
            ...(model !== undefined ? { model: model.trim() } : {})
        });
    }
    return messages;
};

// Titles are derived from the FIRST LINE (trimmed) of the first user turn, so a
// multi-line opening message still yields a clean single-line conversation label.
// Titles remain bounded for clients that display the record as a label.
const titleFromMessages = (messages: ChatMessage[]): string => {
    const firstUser = messages.find((message) => message.role === 'user');
    const firstLine = (firstUser?.content.trim().split('\n', 1)[0] ?? '').trim();
    const title = firstLine || 'New conversation';
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

// GET /v1/chat-assistant/conversation returns every persisted conversation as a
// compact summary ordered by most recent activity (updatedAt descending). Message
// bodies stay behind the identified GET so the history list never ships full chat
// transcripts; ISO-8601 timestamps sort correctly as plain strings.
export const conversationList = asHandlerMethod(async (_, _parameters, rawVariables) => {
    const variables = rawVariables as ChatHandlerVariables;
    const conversations: ConversationSummary[] = resolveStore(variables)
        .list()
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
    return { status: 200, response: { conversations } };
});

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

// PUT /v1/chat-assistant/conversation/:conversation_id replaces the COMPLETE
// message history with the supplied list. This backs the UI's edit-history and
// per-message delete flows: editing or removing any earlier user/assistant
// message re-sends the whole (edited) history, which is also exactly what the
// next provider turn receives. Unlike append, the full updated record is
// returned so the caller can re-sync without a second GET. messageCount and
// updatedAt are recomputed; title priority is explicit body title (header
// rename flow) > first-line derivation from the new history > previously
// recorded title; an explicit body model overrides the recorded one so
// attribution survives history rewrites.
export const conversationPut = asHandlerMethod(async (_, parameters, rawVariables) => {
    const variables = rawVariables as ChatHandlerVariables;
    const conversationId = parameters.path.conversation_id;
    const body = (parameters.body ?? {}) as ConversationPutRequest;
    if (!isString(conversationId) || conversationId.length === 0) {
        return { status: 400, response: { error: 'conversation_id is required' } };
    }

    const store = resolveStore(variables);
    const existing = store.get(conversationId);
    if (!existing) {
        return { status: 404, response: { error: `Conversation '${conversationId}' not found` } };
    }

    if (body.model !== undefined && (!isString(body.model) || body.model.trim().length === 0)) {
        return { status: 400, response: { error: 'model must be a non-empty string' } };
    }
    if (body.title !== undefined && (!isString(body.title) || body.title.trim().length === 0)) {
        return { status: 400, response: { error: 'title must be a non-empty string' } };
    }
    // `messages` is mandatory here: a replacement without a list is never
    // meaningful (use DELETE to remove a conversation entirely). Empty arrays
    // remain valid so a conversation can be wiped without deleting it.
    if (body.messages === undefined) {
        return { status: 400, response: { error: 'messages must be an array of valid chat messages' } };
    }
    const messages = parseMessages(body.messages);
    if (messages === null) {
        return { status: 400, response: { error: 'messages must be an array of valid chat messages' } };
    }

    const conversation = store.upsert({
        ...existing,
        // Title priority: explicit rename (header pen flow) > first-line
        // derivation from the new history > previously recorded title.
        title: body.title?.trim() ||
            (messages.some((message) => message.role === 'user') ? titleFromMessages(messages) : existing.title),
        model: body.model?.trim() || existing.model,
        status: 'complete',
        messages,
        messageCount: messages.length,
        updatedAt: new Date().toISOString(),
        error: undefined,
        // Per-turn usage counters describe the appended turn and no longer match
        // a rewritten history, so a replacement drops stale counters.
        usage: undefined
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
export const chatAssistantList = conversationList;
export const chatAssistantCreate = conversationCreate;
export const chatAssistantGet = conversationGet;
export const chatAssistantPost = conversationPost;
export const chatAssistantPut = conversationPut;
export const chatAssistantDelete = conversationDelete;
