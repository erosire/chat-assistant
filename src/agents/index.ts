// Client-side agent + tool registry for the chat assistant sidebar.
//
// Agents are named conversation presets: each carries the system prompt that
// seeds new chats and the list of tool ids the agent is allowed to use. There
// is NO server resource for agents yet (the chat-assistant API is pure
// conversation storage — see ../api/chat-assistant.ts), so definitions persist
// best-effort in window.localStorage under AGENT_STORAGE_KEY, exactly like the
// remembered model selection (MODEL_STORAGE_KEY in components/ChatAssistantApp.tsx).
// Tools have no runtime execution yet: AVAILABLE_TOOLS seeds the NATIVE
// registry entries the Tool tab and the Agent editor render from, and the
// coded-tool shape (language + source) is ready for custom tools.

// One agent definition. `tools` holds tool IDS (not names) so renames of the
// tool registry never orphan an agent's configuration.
export type AgentDefinition = {
    id: string;
    name: string;
    systemPrompt: string;
    tools: string[];
};

// One tool exposed to agents. A tool is simply its NAME plus its source:
// `code` holds the JavaScript/TypeScript implementation. Tools that are
// ALREADY AVAILABLE NATIVELY (provided by the runtime/chat provider) carry
// `native: true` and never expose code — `language`/`code` are absent, and
// the Tool tab shows them without an implementation panel. Non-native tools
// MUST carry both `language` and `code` (exactly one of the two shapes
// exists — see isNativeTool/isCodedTool).
export type ToolLanguage = 'javascript' | 'typescript';

export type ToolDefinition = {
    id: string;
    name: string;
    native: boolean;
    language?: ToolLanguage;
    code?: string;
};

// Type guards discriminating the two tool shapes the UI renders:
// native tools (metadata only, no implementation shown) and coded tools
// (name + JavaScript/TypeScript source).
export const isNativeTool = (tool: ToolDefinition): boolean => tool.native;
export const isCodedTool = (tool: ToolDefinition): boolean =>
    !tool.native && typeof tool.code === 'string' && tool.code.length > 0
    && (tool.language === 'javascript' || tool.language === 'typescript');

// localStorage key for the persisted agent list (JSON array of AgentDefinition).
export const AGENT_STORAGE_KEY = 'chat-assistant:agents';

// The tool registry. Native tools are ALREADY provided by the runtime (web
// search and code interpretation ship with the chat provider), so they are
// listed without an implementation: the Tool tab renders their name and a
// "native" badge, never their source. Custom coded tools (name + JavaScript/
// TypeScript source) append here and light up their code panel in the Tool
// tab and their checkbox in the Agent editor automatically.
export const AVAILABLE_TOOLS: ToolDefinition[] = [
    { id: 'web-search', name: 'Web search', native: true },
    { id: 'code-interpreter', name: 'Code interpreter', native: true }
];

// Guard for one persisted agent entry: only well-shaped objects survive a
// localStorage round-trip (older/partial writes must not crash the dashboard).
const isValidAgent = (value: unknown): value is AgentDefinition =>
    typeof value === 'object' && value !== null
    && typeof (value as AgentDefinition).id === 'string'
    && typeof (value as AgentDefinition).name === 'string'
    && typeof (value as AgentDefinition).systemPrompt === 'string'
    && Array.isArray((value as AgentDefinition).tools)
    && (value as AgentDefinition).tools.every((tool) => typeof tool === 'string');

// Read the persisted agents. Corrupt JSON or a locked-down localStorage
// degrades to an empty registry (session-only), never a thrown error.
export const readStoredAgents = (): AgentDefinition[] => {
    try {
        const raw = window.localStorage.getItem(AGENT_STORAGE_KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(isValidAgent);
    } catch {
        return [];
    }
};

// Persist the agent list best-effort; storage failures keep the session state.
export const storeAgents = (agents: AgentDefinition[]): void => {
    try {
        window.localStorage.setItem(AGENT_STORAGE_KEY, JSON.stringify(agents));
    } catch {
        // Persistence is best-effort; the UI keeps working for the session.
    }
};

// Deterministic id allocation: the LOWEST free `agent-N` number. Sequential
// ids keep testids stable (`agent-entry-agent-1` ...) and survive deletions
// without colliding (agent-1, agent-3 existing → next is agent-2).
export const createAgentDefinition = (existing: AgentDefinition[], name = 'New agent'): AgentDefinition => {
    const used = new Set(existing.map((agent) => agent.id));
    let counter = 1;
    while (used.has(`agent-${counter}`)) counter += 1;
    return { id: `agent-${counter}`, name, systemPrompt: '', tools: [] };
};

// Toggle one tool id in an agent's allowed set (pure — returns a new agent).
// Used by the Agent editor's tool checkboxes; unavailable while the registry
// is empty, but the logic is exercised by unit tests ahead of the first tool.
export const toggleAgentTool = (agent: AgentDefinition, toolId: string): AgentDefinition =>
    agent.tools.includes(toolId)
        ? { ...agent, tools: agent.tools.filter((tool) => tool !== toolId) }
        : { ...agent, tools: [...agent.tools, toolId] };
