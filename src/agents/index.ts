// Client-side agent + tool registry for the chat assistant sidebar.
//
// Agents are named conversation presets: each carries the system prompt that
// seeds new chats and the list of tool ids the agent is allowed to use. There
// is NO server resource for agents yet (the chat-assistant API is pure
// conversation storage — see ../api/chat-assistant.ts), so definitions persist
// best-effort in window.localStorage under AGENT_STORAGE_KEY, exactly like the
// remembered model selection (MODEL_STORAGE_KEY in components/ChatAssistantApp.tsx).
// Tools have no runtime implementation yet either: AVAILABLE_TOOLS is the
// (currently empty) registry the Agent editor's "allowed tools" checkboxes and
// the sidebar's Tool tab render from, so both surfaces light up automatically
// once the first tool lands.

// One agent definition. `tools` holds tool IDS (not names) so renames of the
// tool registry never orphan an agent's configuration.
export type AgentDefinition = {
    id: string;
    name: string;
    systemPrompt: string;
    tools: string[];
};

// One tool exposed to agents. The chat provider pipeline does not execute
// tools yet — the type exists so the UI (Agent tab list, editor checkboxes)
// and future wiring share one shape.
export type ToolDefinition = {
    id: string;
    name: string;
    description: string;
};

// localStorage key for the persisted agent list (JSON array of AgentDefinition).
export const AGENT_STORAGE_KEY = 'chat-assistant:agents';

// The tool registry. Intentionally EMPTY for now ("there are no tools yet"):
// the Tool tab shows its empty state and the agent editor reports "no tools"
// while this array stays empty; adding entries here lights up both surfaces.
export const AVAILABLE_TOOLS: ToolDefinition[] = [];

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
