// Agent and tool registry handlers for the collection and identified resources.
// This service is PURE storage (exactly like the conversation handlers in
// chat-assistant.ts): the UI owns definitions and persists them here so agents
// and tools survive a reload on any device, replacing the localStorage-only
// registry. Each collection exposes GET (list) and POST (create); the
// identified resource owns GET, PUT (definition replacement), and DELETE.
import { randomUUID } from 'node:crypto';
import { arrayEnsures, isBoolean, isObject, isString } from '@presource/core';
import { asHandlerMethod } from '@underload/service';
import { createRegistryStore, type RegistryStore } from './registry-store';

// One persisted agent. Mirrors the client-side AgentDefinition (src/agents):
// `tools` holds TOOL IDS (not names) so tool renames never orphan a
// configuration; the server validates the array shape but not the referenced
// ids (the tool registry is a sibling collection, not a foreign key).
export type AgentRecord = {
    agentId: string;
    name: string;
    systemPrompt: string;
    tools: string[];
    createdAt: string;
    updatedAt: string;
};

// One persisted tool. Mirrors the client-side ToolDefinition: a tool is its
// NAME plus — only for non-native tools — its JavaScript/TypeScript source.
// Native tools are provided by the runtime and never expose an implementation,
// so `language`/`code` are absent for them.
export type ToolRecord = {
    toolId: string;
    name: string;
    native: boolean;
    language?: 'javascript' | 'typescript';
    code?: string;
    createdAt: string;
    updatedAt: string;
};

// Handler variables provide deterministic test seams and permit service-level
// configuration (the same injection pattern as ChatHandlerVariables).
export type RegistryHandlerVariables = {
    root?: string;
    agentStore?: RegistryStore<AgentRecord>;
    toolStore?: RegistryStore<ToolRecord>;
    agentId?: () => string;
    toolId?: () => string;
};

// Only these two source languages are accepted for coded tools; native tools
// carry neither field.
const isToolLanguage = (value: unknown): value is ToolRecord['language'] =>
    value === 'javascript' || value === 'typescript';

// Validate one agent's definition fields shared by POST (optional with
// defaults) and PUT (optional with retention). Returns the normalized fields
// or an error message; timestamps and identifiers are owned by the handlers.
// POST without a name defaults to "New agent" — the same default the client
// registry's createAgentDefinition uses.
export const parseAgentDefinition = (
    body: unknown,
    fallback: Pick<AgentRecord, 'name' | 'systemPrompt' | 'tools'> | null
): { definition?: Pick<AgentRecord, 'name' | 'systemPrompt' | 'tools'>; error?: string } => {
    if (!isObject(body)) return { error: 'body must be a JSON object' };
    const name = body.name ?? fallback?.name ?? 'New agent';
    const systemPrompt = body.systemPrompt ?? fallback?.systemPrompt;
    const tools = body.tools ?? fallback?.tools;
    if (!isString(name) || name.trim().length === 0) return { error: 'name must be a non-empty string' };
    if (systemPrompt !== undefined && !isString(systemPrompt)) return { error: 'systemPrompt must be a string' };
    if (tools !== undefined) {
        if (!Array.isArray(tools)) return { error: 'tools must be an array of tool ids' };
        for (const tool of arrayEnsures(tools)) {
            if (!isString(tool)) return { error: 'tools must be an array of tool ids' };
        }
    }
    return {
        definition: {
            name: name.trim(),
            systemPrompt: systemPrompt ?? '',
            tools: tools === undefined ? [] : (tools as string[]).slice()
        }
    };
};

// Validate one tool's definition fields. The name is the tool's identity and
// always required; `native` defaults to false on POST and is retained on PUT.
// The coded shape is validated as a pair: a language only accepts the two
// documented values, code must be a non-empty string, and a native tool never
// carries source (the runtime provides its implementation).
export const parseToolDefinition = (
    body: unknown,
    fallback: Pick<ToolRecord, 'name' | 'native' | 'language' | 'code'> | null
): { definition?: Pick<ToolRecord, 'name' | 'native' | 'language' | 'code'>; error?: string } => {
    if (!isObject(body)) return { error: 'body must be a JSON object' };
    const name = body.name ?? fallback?.name;
    const native = body.native ?? fallback?.native ?? false;
    const language = body.language ?? (body.native === undefined ? fallback?.language : undefined);
    const code = body.code ?? (body.native === undefined ? fallback?.code : undefined);
    if (!isString(name) || name.trim().length === 0) return { error: 'name must be a non-empty string' };
    if (!isBoolean(native)) return { error: 'native must be a boolean' };
    if (language !== undefined && !isToolLanguage(language)) {
        return { error: 'language must be either "javascript" or "typescript"' };
    }
    if (code !== undefined && (!isString(code) || code.trim().length === 0)) {
        return { error: 'code must be a non-empty string' };
    }
    if (native && (language !== undefined || code !== undefined)) {
        return { error: 'native tools cannot carry language or code (the runtime provides the implementation)' };
    }
    if (!native && code !== undefined && language === undefined) {
        return { error: 'coded tools must declare language ("javascript" or "typescript")' };
    }
    return {
        definition: {
            name: name.trim(),
            native,
            ...(language !== undefined ? { language } : {}),
            ...(code !== undefined ? { code } : {})
        }
    };
};

// Resolve the injected store or create the persistent store at the service
// root. Collection folders live beside the conversations group so every
// registry family shares one database directory; each store names its own
// identifier field ('agentId' / 'toolId', mirroring the client types).
export const resolveAgentStore = (variables: RegistryHandlerVariables): RegistryStore<AgentRecord> =>
    variables.agentStore ??
    createRegistryStore<AgentRecord>(variables.root ?? process.cwd(), 'agents', 'agent.json', 'agentId');

export const resolveToolStore = (variables: RegistryHandlerVariables): RegistryStore<ToolRecord> =>
    variables.toolStore ??
    createRegistryStore<ToolRecord>(variables.root ?? process.cwd(), 'tools', 'tool.json', 'toolId');

// GET /v1/chat-assistant/agent returns every persisted agent ordered by most
// recent activity (updatedAt descending, ISO-8601 strings sort as plain
// strings) so a reloaded UI restores its registry in a stable order.
export const agentList = asHandlerMethod(async (_, _parameters, rawVariables) => {
    const variables = rawVariables as RegistryHandlerVariables;
    const agents = resolveAgentStore(variables)
        .list()
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { status: 200, response: { agents } };
});

// POST /v1/chat-assistant/agent creates a blank agent (or clones the supplied
// definition) and returns only its identifier, exactly like conversation POST.
export const agentCreate = asHandlerMethod(async (_, parameters, rawVariables) => {
    const variables = rawVariables as RegistryHandlerVariables;
    const parsed = parseAgentDefinition(parameters.body ?? {}, null);
    if (parsed.error) return { status: 400, response: { error: parsed.error } };

    // Tests and embedding services may provide a deterministic identifier
    // factory; normal service requests use cryptographically random ids.
    const agentId = variables.agentId?.() ?? randomUUID();
    const now = new Date().toISOString();
    const record: AgentRecord = {
        agentId,
        name: parsed.definition!.name,
        systemPrompt: parsed.definition!.systemPrompt,
        tools: parsed.definition!.tools,
        createdAt: now,
        updatedAt: now
    };
    resolveAgentStore(variables).upsert(record);
    return { status: 201, response: { agentId } };
});

// GET /v1/chat-assistant/agent/:agent_id returns one persisted record.
export const agentGet = asHandlerMethod(async (_, parameters, rawVariables) => {
    const variables = rawVariables as RegistryHandlerVariables;
    const agentId = parameters.path.agent_id;
    if (!isString(agentId) || agentId.length === 0) {
        return { status: 400, response: { error: 'agent_id is required' } };
    }
    const agent = resolveAgentStore(variables).get(agentId);
    if (!agent) return { status: 404, response: { error: `Agent '${agentId}' not found` } };
    return { status: 200, response: { agentId, agent } };
});

// PUT /v1/chat-assistant/agent/:agent_id replaces the agent's definition
// (name, system prompt, allowed tool ids) and returns the full updated record
// so the caller can re-sync without a follow-up GET.
export const agentPut = asHandlerMethod(async (_, parameters, rawVariables) => {
    const variables = rawVariables as RegistryHandlerVariables;
    const agentId = parameters.path.agent_id;
    if (!isString(agentId) || agentId.length === 0) {
        return { status: 400, response: { error: 'agent_id is required' } };
    }
    const store = resolveAgentStore(variables);
    const existing = store.get(agentId);
    if (!existing) return { status: 404, response: { error: `Agent '${agentId}' not found` } };

    const parsed = parseAgentDefinition(parameters.body ?? {}, existing);
    if (parsed.error) return { status: 400, response: { error: parsed.error } };
    const agent = store.upsert({
        ...existing,
        ...parsed.definition!,
        updatedAt: new Date().toISOString()
    });
    return { status: 200, response: { agentId, agent } };
});

// DELETE /v1/chat-assistant/agent/:agent_id permanently removes the agent and
// returns 404 when the identifier was already absent.
export const agentDelete = asHandlerMethod(async (_, parameters, rawVariables) => {
    const variables = rawVariables as RegistryHandlerVariables;
    const agentId = parameters.path.agent_id;
    if (!isString(agentId) || agentId.length === 0) {
        return { status: 400, response: { error: 'agent_id is required' } };
    }
    if (!resolveAgentStore(variables).delete(agentId)) {
        return { status: 404, response: { error: `Agent '${agentId}' not found` } };
    }
    return { status: 200, response: { agentId } };
});

// GET /v1/chat-assistant/tool returns every persisted tool ordered by most
// recent activity (updatedAt descending).
export const toolList = asHandlerMethod(async (_, _parameters, rawVariables) => {
    const variables = rawVariables as RegistryHandlerVariables;
    const tools = resolveToolStore(variables)
        .list()
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { status: 200, response: { tools } };
});

// POST /v1/chat-assistant/tool creates a tool from the supplied definition and
// returns only its identifier. The name is required; native defaults to false
// so an omitted flag creates a coded (custom) tool shell.
export const toolCreate = asHandlerMethod(async (_, parameters, rawVariables) => {
    const variables = rawVariables as RegistryHandlerVariables;
    const parsed = parseToolDefinition(parameters.body ?? {}, null);
    if (parsed.error) return { status: 400, response: { error: parsed.error } };

    const toolId = variables.toolId?.() ?? randomUUID();
    const now = new Date().toISOString();
    const record: ToolRecord = {
        toolId,
        ...parsed.definition!,
        createdAt: now,
        updatedAt: now
    };
    resolveToolStore(variables).upsert(record);
    return { status: 201, response: { toolId } };
});

// GET /v1/chat-assistant/tool/:tool_id returns one persisted record.
export const toolGet = asHandlerMethod(async (_, parameters, rawVariables) => {
    const variables = rawVariables as RegistryHandlerVariables;
    const toolId = parameters.path.tool_id;
    if (!isString(toolId) || toolId.length === 0) {
        return { status: 400, response: { error: 'tool_id is required' } };
    }
    const tool = resolveToolStore(variables).get(toolId);
    if (!tool) return { status: 404, response: { error: `Tool '${toolId}' not found` } };
    return { status: 200, response: { toolId, tool } };
});

// PUT /v1/chat-assistant/tool/:tool_id replaces the tool's definition and
// returns the full updated record so the caller can re-sync without a GET.
export const toolPut = asHandlerMethod(async (_, parameters, rawVariables) => {
    const variables = rawVariables as RegistryHandlerVariables;
    const toolId = parameters.path.tool_id;
    if (!isString(toolId) || toolId.length === 0) {
        return { status: 400, response: { error: 'tool_id is required' } };
    }
    const store = resolveToolStore(variables);
    const existing = store.get(toolId);
    if (!existing) return { status: 404, response: { error: `Tool '${toolId}' not found` } };

    const parsed = parseToolDefinition(parameters.body ?? {}, existing);
    if (parsed.error) return { status: 400, response: { error: parsed.error } };
    // The record is REBUILT (not spread over the existing record) so switching
    // a tool to native actually DROPS its stored language/code instead of
    // retaining the stale implementation through the spread.
    const definition = parsed.definition!;
    const tool = store.upsert({
        toolId,
        name: definition.name,
        native: definition.native,
        ...(definition.language !== undefined ? { language: definition.language } : {}),
        ...(definition.code !== undefined ? { code: definition.code } : {}),
        createdAt: existing.createdAt,
        updatedAt: new Date().toISOString()
    });
    return { status: 200, response: { toolId, tool } };
});

// DELETE /v1/chat-assistant/tool/:tool_id permanently removes the tool and
// returns 404 when the identifier was already absent.
export const toolDelete = asHandlerMethod(async (_, parameters, rawVariables) => {
    const variables = rawVariables as RegistryHandlerVariables;
    const toolId = parameters.path.tool_id;
    if (!isString(toolId) || toolId.length === 0) {
        return { status: 400, response: { error: 'tool_id is required' } };
    }
    if (!resolveToolStore(variables).delete(toolId)) {
        return { status: 404, response: { error: `Tool '${toolId}' not found` } };
    }
    return { status: 200, response: { toolId } };
});
