// AgentToolGrid — the agent editor's "Allowed tools" tile grid.
//
// BEHAVIOR ORACLE (read-only): src/components/ChatAssistantApp.tsx
//   `AgentToolGrid` (auto-fill tile grid)     :800-810
//   `AgentToolOption` (checked tile)          :812-834
//   the render site + empty-registry note     :4745-4768
//
// WHAT IT IS: one tile per entry of the tool registry, each wrapping a real
// `<input type="checkbox">` inside a `<label>` so the WHOLE tile is the click
// target (oracle :812-816). Checking a tile writes the tool id into the agent's
// `tools` set through `toggleAgentTool` (src/agents/index.ts:148-154) and persists
// it immediately with `chat.agent.save` — the agent editor has no draft/commit
// split (:488-492), so a half-finished configuration is already durable.
//
// WHY IT READS THE CELLS ITSELF (prop-less, like the rest of this surface): the
// agent's allowed set lives in `chat.agents`, and the tile list lives in
// `chat.tools`, both owned by the chat core; the ids are the only coupling
// (components/index.ts:9-11 — a view never imports a plugin). Resolving the active
// agent here rather than taking it as a prop means the grid can be mounted next to
// any host that owns `chat.activeAgentId`, and it keeps the checkbox `checked`
// state derived from the store instead of from DOM state.
//
// The grid renders NOTHING while no agent is open: the group is a section of the
// agent editor, and an empty editor would offer checkboxes that cannot address a
// definition.
import { toggleAgentTool, type AgentDefinition, type ToolDefinition } from '../../agents';
import {
    CHAT_ACTIVE_AGENT_STATE,
    CHAT_AGENT_SAVE_COMMAND,
    CHAT_AGENTS_STATE,
    CHAT_TOOLS_STATE
} from '../contract';
import { useDashboardValue } from '../state-hooks';
import { useWorkbench } from '../workbench';

/** Sidebar copy for the group heading (oracle :4749-4751). */
const GROUP_TITLE = 'Allowed tools';

/** Empty-registry fallback, word for word from the oracle (:4753). */
const EMPTY_TOOLS = 'No tools available yet.';

export function AgentToolGrid() {
    const instance = useWorkbench();
    const agents = useDashboardValue<readonly AgentDefinition[]>(CHAT_AGENTS_STATE);
    const activeAgentId = useDashboardValue<string | null>(CHAT_ACTIVE_AGENT_STATE);
    const tools = useDashboardValue<readonly ToolDefinition[]>(CHAT_TOOLS_STATE);

    // The definition this grid edits. A stale id (deleted in another surface) reads
    // as null, which is why the whole group disappears instead of throwing.
    const agent = agents.find((candidate) => candidate.id === activeAgentId) ?? null;
    if (agent === null) return null;

    const toggle = (toolId: string) => {
        // The store takes the WHOLE definition (identities are immutable);
        // `toggleAgentTool` returns a new object, so the cell sees a new reference.
        instance.execute<AgentDefinition, void>(CHAT_AGENT_SAVE_COMMAND, toggleAgentTool(agent, toolId));
    };

    return (
        <div className="agent__tools" data-testid="agent-tools">
            <div className="agent__group-head">
                <span className="agent__group-title">{GROUP_TITLE}</span>
                <span className="agent__group-count" data-testid="agent-tools-count">
                    {agent.tools.length}
                </span>
            </div>

            {tools.length === 0 ? (
                <p className="agent__tools-empty" data-testid="agent-tools-empty">
                    {EMPTY_TOOLS}
                </p>
            ) : (
                <div className="agent__tool-grid" data-testid="agent-tool-grid">
                    {tools.map((tool) => {
                        const enabled = agent.tools.includes(tool.id);
                        return (
                            // `data-selected` (not a native attribute) carries the
                            // checked look the oracle gave the tile, and it survives a
                            // colour-blind display because the checkbox itself stays
                            // in the DOM as the accessible truth.
                            <label key={tool.id} className="agent__tool" data-selected={enabled ? 'true' : 'false'}>
                                <input
                                    type="checkbox"
                                    checked={enabled}
                                    onChange={() => toggle(tool.id)}
                                    data-testid={`agent-tool-${tool.id}`}
                                />
                                <span className="agent__tool-name">{tool.name}</span>
                            </label>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
