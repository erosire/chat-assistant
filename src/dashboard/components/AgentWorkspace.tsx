// AgentWorkspace — the agent editing surface: registry list, name, system prompt,
// chat layout (the example back-and-forth) and the allowed-tools grid.
//
// BEHAVIOR ORACLE (read-only): src/components/ChatAssistantApp.tsx
//   `AgentWorkspace` (the content-area editor)   :485-509  + render site 4667-4769
//   `AgentNameInput`                             :557-573
//   `AgentPromptEditor` feed (value/rows/etc)    :4676-4683
//   the "Chat layout" block + its note           :4684-4744
//   the "Allowed tools" block                    :4745-4768 (see ./AgentToolGrid)
//   the tab's empty state                        :4771-4778
//
// WHAT THIS SURFACE ADDS, AND WHY. The oracle splits the agent feature across two
// columns: the rail holds the registry rows (select + "x" delete + the header's
// "New agent"), and the content area holds only the EDITOR of the selected agent.
// In this skin the rail is owned by ChatSidebar, whose Agent-tab rows publish
// `chat.agent` (the agent that prefixes NEW chats) rather than `chat.activeAgentId`
// (ChatSidebar.tsx:263-276), and the contract publishes no select/create command for
// the editing selection. So the editor column carries its own compact registry
// strip: one row per definition, which agent is open (`data-selected`), a delete
// control per row, and "New agent". The EDITOR itself is the oracle's `AgentWorkspace`
// verbatim — same fields, same copy, same testids (`agent-workspace`,
// `agent-name-input`, `agent-prompt-input`, `agent-layout-*`, `add-agent-message`,
// `remove-agent-message-*`, `agent-message-role-*`).
//
// EVERY EDIT PERSISTS IMMEDIATELY. The oracle has no draft/commit split here
// (:488-492 "Every change writes into the definition and re-persists immediately"),
// so each keystroke dispatches `chat.agent.save` with the WHOLE patched definition
// and the input's value is read straight back out of `chat.agents`. The patching
// itself is done by the pure editors in src/agents (appendAgentMessage /
// updateAgentMessage / updateAgentMessageRole / removeAgentMessage), never
// re-implemented here, so the send-time prefix builder (`agentPrefixMessages`) and
// the editor can never disagree about what a turn is.
//
// WRITING `chat.activeAgentId` DIRECTLY. contract.ts registers the cell but publishes
// no `chat.agent.select` id, and the core throws `unknown-command` for anything
// unregistered; ChatSidebar does the same for `chat.sidebarTab`/`chat.drawerOpen`
// (ChatSidebar.tsx:15-22 records the rule). `chat.agent.set` DOES exist and stays
// reserved for the composer's "which agent prefixes new chats" choice — the two
// selections are independent in the oracle (`selectedAgentId` vs `agentChoice`,
// :2516/:2648) and must not be collapsed here.
import type { ChangeEvent } from 'react';
import {
    appendAgentMessage,
    removeAgentMessage,
    updateAgentMessage,
    updateAgentMessageRole,
    type AgentDefinition,
    type AgentMessageRole
} from '../../agents';
import {
    CHAT_ACTIVE_AGENT_STATE,
    CHAT_AGENT_CREATE_COMMAND,
    CHAT_AGENT_DELETE_COMMAND,
    CHAT_AGENT_SAVE_COMMAND,
    CHAT_AGENTS_STATE
} from '../contract';
import { useDashboardValue } from '../state-hooks';
import { useWorkbench } from '../workbench';
import { AgentPromptEditor } from './AgentPromptEditor';
import { AgentToolGrid } from './AgentToolGrid';
import { CloseIcon, PlusIcon } from '../../icons';

/** Field copy, verbatim from the oracle's render site (4669-4751). */
const COPY = {
    heading: 'Agents',
    newName: 'New agent',
    namePlaceholder: 'Agent name',
    nameLabel: 'Agent name',
    promptPlaceholder: 'System prompt the agent uses in chat...',
    promptLabel: 'Agent system prompt',
    layoutTitle: 'Chat layout',
    layoutNote:
        "Attached to the start of every chat that uses this agent, replacing the chat's system prompt block.",
    userPlaceholder: 'Example user message...',
    assistantPlaceholder: 'Example assistant reply...',
    addTurn: 'Add turn',
    emptyRegistry: 'No agents yet.',
    emptyTitle: 'No agent selected',
    emptyBody: 'Pick an agent from the sidebar or create one with "New agent".'
} as const;

/**
 * Row metadata: "3 turns · 2 tools" (oracle :4602). The middle dot is U+00B7, the
 * same separator the conversation rows use (ChatSidebar.tsx:93-94).
 */
const agentMeta = (agent: AgentDefinition): string =>
    `${agent.messages.length} turns \u00B7 ${agent.tools.length} tools`;

/** Layout-row count line: "{n} turns" (oracle :4695-4697). */
const layoutCount = (turns: number): string => `${turns} turns`;

/**
 * The role chip's accessible name — flipping a row reads as the target role
 * (oracle :4709-4710: "Switch user turn to assistant").
 */
const roleSwitchLabel = (role: AgentMessageRole): string =>
    `Switch ${role} turn to ${role === 'user' ? 'assistant' : 'user'}`;

/** Placeholder per role: a preset must read as a real back-and-forth (:4718). */
const layoutPlaceholder = (role: AgentMessageRole): string =>
    role === 'user' ? COPY.userPlaceholder : COPY.assistantPlaceholder;

export function AgentWorkspace() {
    const instance = useWorkbench();
    const agents = useDashboardValue<readonly AgentDefinition[]>(CHAT_AGENTS_STATE);
    const activeAgentId = useDashboardValue<string | null>(CHAT_ACTIVE_AGENT_STATE);

    // The definition being edited. A row that was deleted from under this surface
    // reads as null, and the editor falls back to its empty state rather than
    // rendering a form bound to nothing (the oracle's `!selectedAgent` branch, :4773).
    const agent = agents.find((candidate) => candidate.id === activeAgentId) ?? null;

    /**
     * Patch and persist the open definition (the oracle's `updateAgent`, :3452-3457).
     * `patch` never carries `id`: identities are immutable, and the store addresses
     * the row by it.
     */
    const update = (patch: Partial<Omit<AgentDefinition, 'id'>>) => {
        if (agent === null) return;
        instance.execute<AgentDefinition, void>(CHAT_AGENT_SAVE_COMMAND, { ...agent, ...patch });
    };

    /** Pick which definition the editor shows: the one cell with no command id. */
    const selectAgent = (id: string) => {
        instance.state<string | null>(CHAT_ACTIVE_AGENT_STATE).set(id);
    };

    const createAgent = () => {
        // The plugin opens the new row and switches the rail to the Agent tab
        // (plugins/agents.ts, the port of `startNewAgent` :3441-3450).
        instance.execute<void, string>(CHAT_AGENT_CREATE_COMMAND);
    };

    const deleteAgent = (id: string) => {
        instance.execute<string, void>(CHAT_AGENT_DELETE_COMMAND, id);
    };

    return (
        <div className="agents" data-testid="agent-surface">
            <div className="agents__head">
                <span className="agents__heading">{COPY.heading}</span>
                <span className="agents__count" data-testid="agent-count">
                    {agents.length}
                </span>
                <button
                    type="button"
                    className="btn btn--accent agents__new"
                    aria-label={COPY.newName}
                    title={COPY.newName}
                    data-testid="new-agent-button"
                    onClick={createAgent}
                >
                    {COPY.newName}
                </button>
            </div>

            {/* The compact registry strip: picking an agent opens it in the editor
                below, and the "x" deletes it (the oracle's rail affordances, :4583-4615). */}
            {agents.length === 0 ? (
                <p className="agents__empty" data-testid="agents-empty">
                    {COPY.emptyRegistry}
                </p>
            ) : (
                <ul className="agents__list" data-testid="agent-registry">
                    {agents.map((entry) => (
                        <li
                            key={entry.id}
                            className="agent"
                            data-selected={entry.id === activeAgentId ? 'true' : 'false'}
                            data-testid={`agent-row-${entry.id}`}
                        >
                            <button
                                type="button"
                                className="agent__pick"
                                aria-label={`Edit ${entry.name}`}
                                aria-current={entry.id === activeAgentId ? 'true' : undefined}
                                data-selected={entry.id === activeAgentId ? 'true' : 'false'}
                                data-testid={`agent-pick-${entry.id}`}
                                onClick={() => selectAgent(entry.id)}
                            >
                                <span className="agent__name">{entry.name}</span>
                                <span className="agent__meta">{agentMeta(entry)}</span>
                            </button>
                            {/* Sibling of the pick button, never nested inside it:
                                a delete that also selected would be the oracle's bug
                                (:4589-4591). */}
                            <button
                                type="button"
                                className="agent__remove"
                                aria-label="Delete agent"
                                title="Delete agent"
                                data-testid={`delete-agent-${entry.id}`}
                                onClick={() => deleteAgent(entry.id)}
                            >
                                <CloseIcon size={14} />
                            </button>
                        </li>
                    ))}
                </ul>
            )}

            {agent === null ? (
                <div className="agents__none" data-testid="empty-agent-state">
                    <strong>{COPY.emptyTitle}</strong>
                    <span>{COPY.emptyBody}</span>
                </div>
            ) : (
                <section className="agents__editor" data-testid="agent-workspace">
                    <input
                        className="field agent__field"
                        type="text"
                        value={agent.name}
                        placeholder={COPY.namePlaceholder}
                        aria-label={COPY.nameLabel}
                        data-testid="agent-name-input"
                        onChange={(event: ChangeEvent<HTMLInputElement>) => update({ name: event.target.value })}
                    />

                    {/* rows={10}: the oracle's default field height, before the first
                        drag or arrow press takes over (AgentPromptEditor.tsx). */}
                    <AgentPromptEditor
                        className="agent__prompt-input"
                        value={agent.systemPrompt}
                        placeholder={COPY.promptPlaceholder}
                        aria-label={COPY.promptLabel}
                        rows={10}
                        data-testid="agent-prompt-input"
                        onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                            update({ systemPrompt: event.target.value })
                        }
                    />

                    <div className="agent__group-head">
                        <span className="agent__group-title">{COPY.layoutTitle}</span>
                        <span className="agent__group-count" data-testid="agent-layout-count">
                            {layoutCount(agent.messages.length)}
                        </span>
                    </div>
                    <p className="agents__note" data-testid="agent-layout-note">
                        {COPY.layoutNote}
                    </p>

                    {agent.messages.length > 0 ? (
                        <div className="agent__layout" data-testid="agent-layout-list">
                            {agent.messages.map((message, index) => (
                                // Index keys are correct here and are what the oracle
                                // used (:4705): the rows are positional, and removing
                                // one renumbers the rest — the testids below follow the
                                // live position, not a stored identity.
                                <div key={index} className="agent__row" data-testid={`agent-message-${index}`}>
                                    <button
                                        type="button"
                                        className="agent__role"
                                        // The pure editor flips the role of row `index`
                                        // and returns the next definition (:196-203).
                                        onClick={() =>
                                            instance.execute<AgentDefinition, void>(
                                                CHAT_AGENT_SAVE_COMMAND,
                                                updateAgentMessageRole(agent, index)
                                            )
                                        }
                                        aria-label={roleSwitchLabel(message.role)}
                                        title={roleSwitchLabel(message.role)}
                                        data-testid={`agent-message-role-${index}`}
                                    >
                                        {message.role}
                                    </button>
                                    <textarea
                                        className="field agent__layout-input"
                                        value={message.content}
                                        placeholder={layoutPlaceholder(message.role)}
                                        aria-label={`${message.role} turn ${index + 1}`}
                                        rows={2}
                                        data-testid={`agent-message-input-${index}`}
                                        onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                                            instance.execute<AgentDefinition, void>(
                                                CHAT_AGENT_SAVE_COMMAND,
                                                updateAgentMessage(agent, index, event.target.value)
                                            )
                                        }
                                    />
                                    <button
                                        type="button"
                                        className="agent__remove-row"
                                        onClick={() =>
                                            instance.execute<AgentDefinition, void>(
                                                CHAT_AGENT_SAVE_COMMAND,
                                                removeAgentMessage(agent, index)
                                            )
                                        }
                                        aria-label={`Remove ${message.role} turn`}
                                        title={`Remove ${message.role} turn`}
                                        data-testid={`remove-agent-message-${index}`}
                                    >
                                        <CloseIcon size={14} />
                                    </button>
                                </div>
                            ))}
                        </div>
                    ) : null}

                    {/* Append alternates user -> assistant -> user..., which is what
                        keeps a preset readable as a conversation
                        (src/agents/index.ts:176-185). */}
                    <button
                        type="button"
                        className="agent__add"
                        onClick={() =>
                            instance.execute<AgentDefinition, void>(CHAT_AGENT_SAVE_COMMAND, appendAgentMessage(agent))
                        }
                        aria-label={COPY.addTurn}
                        title={COPY.addTurn}
                        data-testid="add-agent-message"
                    >
                        <PlusIcon size={14} />
                    </button>

                    <AgentToolGrid />
                </section>
            )}
        </div>
    );
}
