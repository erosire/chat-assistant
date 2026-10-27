// Client-side agent + tool registry for the chat assistant sidebar.
//
// Agents are named conversation presets: each carries the system prompt AND the
// example conversation that seed chats, plus the list of tool ids the agent is
// allowed to use. There is NO server resource for agents yet (the chat-assistant
// API is pure conversation storage — see ../api/chat-assistant.ts), so
// definitions persist best-effort in window.localStorage under
// AGENT_STORAGE_KEY, exactly like the remembered model selection
// (MODEL_STORAGE_KEY in components/ChatAssistantApp.tsx).
// Tools have no runtime execution yet: AVAILABLE_TOOLS seeds the NATIVE
// registry entries the Tool tab and the Agent editor render from, and the
// coded-tool shape (language + source) is ready for custom tools.

// One example turn of an agent's conversation preset. Only the two
// conversational roles exist: the agent's SYSTEM prompt is its own field
// (`systemPrompt`), so an agent's block is always
// [systemPrompt, ...messages] — see agentPrefixMessages.
export type AgentMessageRole = 'user' | 'assistant';

export type AgentMessage = {
    role: AgentMessageRole;
    content: string;
};

// One agent definition. `tools` holds tool IDS (not names) so renames of the
// tool registry never orphan an agent's configuration. `messages` is the
// agent's CHAT LAYOUT: the example back-and-forth attached after its system
// prompt at the START of every chat that uses the agent (see
// agentPrefixMessages), which is why an agent can carry a full preset
// conversation rather than a lone prompt.
export type AgentDefinition = {
    id: string;
    name: string;
    systemPrompt: string;
    messages: AgentMessage[];
    tools: string[];
};

// One turn of the block an agent attaches to the start of a chat: its system
// prompt followed by its example conversation. Structurally a ChatMessage
// (role + content), declared locally so this registry stays independent from
// the storage API types.
export type AgentBlockMessage = { role: 'system' | AgentMessageRole; content: string };

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

// Guard for one persisted example turn: a conversational role plus content.
// The system role is deliberately rejected — an agent's system prompt is its
// own field, so a stored `messages` entry can never smuggle a second one in.
// Content may be EMPTY: the editor persists each keystroke, so a just-added
// turn is a blank row until the user types; blank turns are dropped at send
// time by agentPrefixMessages, never stored as empty provider messages.
const isValidAgentMessage = (value: unknown): value is AgentMessage =>
    typeof value === 'object' && value !== null
    && ((value as AgentMessage).role === 'user' || (value as AgentMessage).role === 'assistant')
    && typeof (value as AgentMessage).content === 'string';

// Guard for one persisted agent entry: only well-shaped objects survive a
// localStorage round-trip (older/partial writes must not crash the dashboard).
// `messages` is optional in storage: definitions written before agents carried
// a conversation preset have no such field and load with an empty list.
const isValidAgent = (value: unknown): value is AgentDefinition =>
    typeof value === 'object' && value !== null
    && typeof (value as AgentDefinition).id === 'string'
    && typeof (value as AgentDefinition).name === 'string'
    && typeof (value as AgentDefinition).systemPrompt === 'string'
    && ((value as AgentDefinition).messages === undefined
        || (Array.isArray((value as AgentDefinition).messages)
            && (value as AgentDefinition).messages.every(isValidAgentMessage)))
    && Array.isArray((value as AgentDefinition).tools)
    && (value as AgentDefinition).tools.every((tool) => typeof tool === 'string');

// Read the persisted agents. Corrupt JSON or a locked-down localStorage
// degrades to an empty registry (session-only), never a thrown error. Every
// returned definition is NORMALIZED to carry `messages` (older entries load
// with an empty preset) so callers never branch on its presence.
export const readStoredAgents = (): AgentDefinition[] => {
    try {
        const raw = window.localStorage.getItem(AGENT_STORAGE_KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(isValidAgent).map((agent) => ({
            ...agent,
            messages: (agent.messages ?? []).map((message) => ({ role: message.role, content: message.content }))
        }));
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
    return { id: `agent-${counter}`, name, systemPrompt: '', messages: [], tools: [] };
};

// Toggle one tool id in an agent's allowed set (pure — returns a new agent).
// Used by the Agent editor's tool checkboxes; unavailable while the registry
// is empty, but the logic is exercised by unit tests ahead of the first tool.
export const toggleAgentTool = (agent: AgentDefinition, toolId: string): AgentDefinition =>
    agent.tools.includes(toolId)
        ? { ...agent, tools: agent.tools.filter((tool) => tool !== toolId) }
        : { ...agent, tools: [...agent.tools, toolId] };

// The message block an agent attaches to the START of a chat: its system prompt
// (when non-blank) followed by its example conversation, in order. This is the
// block that REPLACES the chat's own system prompt turn: a chat using an agent
// opens with [agent system prompt, agent example turns..., user, assistant],
// so the preset back-and-forth is model context exactly like a real history.
// Blank prompts and blank example turns are dropped so a half-configured agent
// never injects empty messages (the storage/provider layers reject those).
export const agentPrefixMessages = (agent: AgentDefinition | null): AgentBlockMessage[] => {
    if (!agent) return [];
    const prefix: AgentBlockMessage[] = [];
    const prompt = agent.systemPrompt.trim();
    if (prompt.length > 0) prefix.push({ role: 'system', content: prompt });
    for (const message of agent.messages) {
        const content = message.content.trim();
        if (content.length === 0) continue;
        prefix.push({ role: message.role, content });
    }
    return prefix;
};

// Append one example turn to an agent's chat layout (pure). Turns ALTERNATE
// user → assistant → user … so a preset reads as a real back-and-forth: the
// new turn takes the role that does not follow the current last turn, and an
// empty layout starts with the USER (the agent's opening prompt is its system
// prompt, not a fabricated assistant line).
export const appendAgentMessage = (agent: AgentDefinition): AgentDefinition => {
    const last = agent.messages[agent.messages.length - 1];
    const role: AgentMessageRole = last?.role === 'user' ? 'assistant' : 'user';
    return { ...agent, messages: [...agent.messages, { role, content: '' }] };
};

// Replace one example turn's text (pure). Only `content` is written: roles are
// positional and flipped through updateAgentMessageRole.
export const updateAgentMessage = (agent: AgentDefinition, index: number, content: string): AgentDefinition => ({
    ...agent,
    messages: agent.messages.map((message, candidate) => (candidate === index ? { ...message, content } : message))
});

// Flip one example turn between user and assistant (pure) — the same
// role-switch affordance persisted chat turns carry.
export const updateAgentMessageRole = (agent: AgentDefinition, index: number): AgentDefinition => ({
    ...agent,
    messages: agent.messages.map((message, candidate) => (
        candidate === index
            ? { ...message, role: message.role === 'user' ? 'assistant' : 'user' }
            : message
    ))
});

// Remove one example turn from an agent's chat layout (pure).
export const removeAgentMessage = (agent: AgentDefinition, index: number): AgentDefinition => ({
    ...agent,
    messages: agent.messages.filter((_, candidate) => candidate !== index)
});
