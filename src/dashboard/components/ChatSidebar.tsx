// ChatSidebar — the whole sidebar column of the workstation skin.
//
// It is the sidebar region's single owner (one component per region, see
// `pickRegionOwner` in src/dashboard/WorkstationShell.tsx), and it is the place
// the four registries live: Chat (conversations) / Agent / Tool / Settings, with
// the active tab read from `chat.sidebarTab`.
//
// BEHAVIOR ORACLE (read-only): src/components/ChatAssistantApp.tsx
//   - sidebar entries + overlaid delete sibling      4282-4317
//   - tab strip + tab content                        4508-4620
//   - scrim BEFORE the rail so the drawer paints above it  4510-4512
//   - the drawer is static on md+ and fixed below md (the
//     `Sidebar` styledComponent, 406-427, and its z-index trap)
//
// STATE / COMMAND USAGE — the two cells below are written DIRECTLY, and that is
// deliberate: contract.ts registers `chat.sidebarTab` and `chat.drawerOpen` as
// state but publishes NO `chat.tab.set` / `chat.drawer.set` command id, and the
// core throws `unknown-command` for anything unregistered (see
// packages/underload/dashboard/src/extensions/registries.ts:77). Every other
// mutation in this file goes through `instance.execute(...)` with a contract id.
// The `writeCell` helper below is the single place to change when the core
// worker adds those command ids.
//
// The three lists share one presentational board (./SessionsBoard), so all
// three registries get the same select + overlained-controls row structure.
import type { DashboardState } from '@underload/dashboard';
// The agent/tool registry shapes come from src/agents (contract.ts imports them
// type-only for its own cells and does not re-export them).
import type { AgentDefinition, ToolDefinition } from '../../agents';
import {
    CHAT_ACTIVE_AGENT_STATE,
    CHAT_ACTIVE_SESSION_STATE,
    CHAT_AGENT_SET_COMMAND,
    CHAT_AGENTS_STATE,
    CHAT_AUTOSCROLL_STATE,
    CHAT_AUTOSCROLL_TOGGLE_COMMAND,
    CHAT_DRAWER_OPEN_STATE,
    CHAT_MODEL_STATE,
    CHAT_MODELS_STATE,
    CHAT_SESSION_CREATE_COMMAND,
    CHAT_SESSION_DELETE_COMMAND,
    CHAT_SESSION_RENAME_COMMAND,
    CHAT_SESSION_SELECT_COMMAND,
    CHAT_SESSIONS_STATE,
    CHAT_SIDEBAR_TAB_STATE,
    CHAT_STATUS_STATE,
    CHAT_TOOLS_STATE,
    CHAT_TURNS_STATE,
    CHAT_USAGE_STATE,
    type ChatSession,
    type ChatStatus,
    type ChatTurn,
    type ChatUsage,
    type SidebarTab
} from '../contract';
import { useDashboardValue } from '../state-hooks';
import { useWorkbench } from '../workbench';
import { SessionsBoard, type BoardEntry } from './SessionsBoard';
// The viewport seam is owned by the chat core (src/dashboard/viewport.ts): it
// reports 'mobile' below the 900px md gate AND retracts `chat.drawerOpen` on the
// crossing back to desktop, which is exactly what the rail needs.
import { useViewport } from '../viewport';
import { MenuIcon } from '../../icons';

/** The tab strip, in strip order. `chat.sidebarTab` holds one of these. */
const TABS: readonly { id: SidebarTab; label: string }[] = [
    { id: 'chat', label: 'Chat' },
    { id: 'agent', label: 'Agent' },
    { id: 'tool', label: 'Tool' },
    { id: 'settings', label: 'Settings' }
];

/** Sidebar chrome labels — kept together so the copy stays consistent. */
const COPY = {
    conversations: 'Conversations',
    agents: 'Agents',
    tools: 'Tools',
    settings: 'Settings',
    emptyChats: 'No chats yet.',
    emptyAgents: 'No agents yet.',
    emptyTools: 'No tools registered.',
    newChat: 'New chat',
    deleteConversation: 'Delete conversation'
} as const;

/**
 * One-line summary for a conversation row: "12 messages · complete" — exactly
 * the metadata the oracle puts under each sidebar title
 * (ChatAssistantApp.tsx:4300).
 */
const sessionMeta = (session: ChatSession): string => `${session.messageCount} messages · ${session.status}`;

/** Agent row summary: "3 turns · 2 tools" (oracle ChatAssistantApp.tsx:4602). */
const agentMeta = (agent: AgentDefinition): string => `${agent.messages.length} turns · ${agent.tools.length} tools`;

/**
 * Tool row summary: "native" for the built-ins, otherwise the source language.
 * The oracle's Tool tab shows name + kind (ChatAssistantApp.tsx:4621-4645) and
 * there is no `chat.tool.select` command id, so the rows stay informational.
 */
const toolMeta = (tool: ToolDefinition): string => (tool.native ? 'native' : tool.language ?? 'custom');

/**
 * Write a view-owned state cell directly. See the header note: only the two
 * cells with no command id use this.
 */
function writeCell<T>(setter: DashboardState<T>, value: T): void {
    setter.set(value);
}

export function ChatSidebar() {
    const instance = useWorkbench();

    // ——— state ————————————————————————————————————————————————————————————
    const sessions = useDashboardValue<readonly ChatSession[]>(CHAT_SESSIONS_STATE);
    const activeSessionId = useDashboardValue<string | null>(CHAT_ACTIVE_SESSION_STATE);
    const agents = useDashboardValue<readonly AgentDefinition[]>(CHAT_AGENTS_STATE);
    const activeAgentId = useDashboardValue<string | null>(CHAT_ACTIVE_AGENT_STATE);
    const tools = useDashboardValue<readonly ToolDefinition[]>(CHAT_TOOLS_STATE);
    const tab = useDashboardValue<SidebarTab>(CHAT_SIDEBAR_TAB_STATE);
    const drawerOpen = useDashboardValue<boolean>(CHAT_DRAWER_OPEN_STATE);
    const status = useDashboardValue<ChatStatus>(CHAT_STATUS_STATE);
    const autoscroll = useDashboardValue<boolean>(CHAT_AUTOSCROLL_STATE);
    const model = useDashboardValue<string>(CHAT_MODEL_STATE);
    const models = useDashboardValue<readonly string[]>(CHAT_MODELS_STATE);
    const usage = useDashboardValue<ChatUsage | null>(CHAT_USAGE_STATE);
    const turns = useDashboardValue<readonly ChatTurn[]>(CHAT_TURNS_STATE);

    // ——— derived ——————————————————————————————————————————————————————————
    const viewport = useViewport();
    const mobile = viewport === 'mobile';
    // Deletion owns its own guard so a second delete cannot race the active one,
    // but provider waiting/streaming must NOT grey the rail
    // (oracle 4305-4308: only `deleting()` disables the "x").
    const busy = status === 'saving';

    const sessionEntries: BoardEntry[] = sessions.map((session) => ({
        id: session.conversationId,
        title: session.title,
        meta: sessionMeta(session),
        selected: session.conversationId === activeSessionId,
        disabled: busy
    }));

    const agentEntries: BoardEntry[] = agents.map((agent) => ({
        id: agent.id,
        title: agent.name,
        meta: agentMeta(agent),
        selected: agent.id === activeAgentId
    }));

    const toolEntries: BoardEntry[] = tools.map((tool) => ({
        id: tool.id,
        title: tool.name,
        meta: toolMeta(tool)
    }));

    // ——— mutations ————————————————————————————————————————————————————————
    const selectTab = (next: SidebarTab) => {
        if (next === tab) return;
        writeCell(instance.state<SidebarTab>(CHAT_SIDEBAR_TAB_STATE), next);
    };

    const closeDrawer = () => {
        if (!drawerOpen) return;
        writeCell(instance.state<boolean>(CHAT_DRAWER_OPEN_STATE), false);
    };

    const selectSession = (sessionId: string) => {
        instance.execute<string>(CHAT_SESSION_SELECT_COMMAND, sessionId);
        // Selecting a conversation on a phone dismisses the drawer (oracle
        // 3325: selectChat closes `sidebarOpen`), so the transcript is what the
        // tap lands on.
        closeDrawer();
    };

    return (
        <div className="rail" data-open={drawerOpen} data-mobile={mobile} data-testid="sidebar">
            {/* Scrim BEFORE the rail in DOM order, exactly like the oracle
                (4510-4512): the drawer paints above its own scrim, and the
                scrim only exists to dismiss it. */}
            {mobile && drawerOpen ? (
                <button
                    type="button"
                    className="rail__scrim"
                    aria-label="Close conversations"
                    data-testid="sidebar-scrim"
                    onClick={closeDrawer}
                />
            ) : null}

            <header className="rail__bar">
                {/* The drawer toggle only appears below the md breakpoint
                    (sessions.css hides it on desktop, where the rail is a
                    static column and `data-open` is ignored). */}
                <button
                    type="button"
                    className="rail__menu btn btn--ghost btn--icon"
                    aria-expanded={drawerOpen}
                    aria-controls="sidebar"
                    aria-label="Toggle conversations"
                    data-testid="sidebar-toggle"
                    onClick={() => writeCell(instance.state<boolean>(CHAT_DRAWER_OPEN_STATE), !drawerOpen)}
                >
                    <MenuIcon size={16} />
                </button>
                <h2 className="rail__label">Rail</h2>
            </header>

            <div className="rail__tabs" role="tablist" aria-label="Sidebar sections">
                {TABS.map((entry) => (
                    <button
                        key={entry.id}
                        type="button"
                        role="tab"
                        className={tab === entry.id ? 'rail__tab is-active' : 'rail__tab'}
                        aria-selected={tab === entry.id}
                        data-testid={`sidebar-tab-${entry.id}`}
                        onClick={() => selectTab(entry.id)}
                    >
                        {entry.label}
                    </button>
                ))}
            </div>

            <div className="rail__body" role="tabpanel" aria-label={`${tab} registry`}>
                {tab === 'chat' ? (
                    <>
                        <SessionsBoard
                            heading={COPY.conversations}
                            entries={sessionEntries}
                            emptyLabel={COPY.emptyChats}
                            emptyTestId="empty-chat-list"
                            listTestId="sidebar-list-chat"
                            deleteLabel={COPY.deleteConversation}
                            entryTestId={(entry) => `session-entry-${entry.id}`}
                            deleteTestId={(entry) => `session-delete-${entry.id}`}
                            renameTestId={(entry) => `session-rename-${entry.id}`}
                            selectLabel={(entry) => `Open ${entry.title}`}
                            onSelect={selectSession}
                            onDelete={(sessionId) => instance.execute<string>(CHAT_SESSION_DELETE_COMMAND, sessionId)}
                            onRename={(sessionId, title) =>
                                instance.execute(CHAT_SESSION_RENAME_COMMAND, { sessionId, title })
                            }
                        />
                        <div className="rail__footer">
                            <button
                                type="button"
                                className="btn btn--accent"
                                aria-label={COPY.newChat}
                                data-testid="new-chat-button"
                                onClick={() => {
                                    instance.execute<void, string>(CHAT_SESSION_CREATE_COMMAND);
                                    closeDrawer();
                                }}
                            >
                                {COPY.newChat}
                            </button>
                        </div>
                    </>
                ) : null}

                {tab === 'agent' ? (
                    <SessionsBoard
                        heading={COPY.agents}
                        entries={agentEntries}
                        emptyLabel={COPY.emptyAgents}
                        emptyTestId="empty-agent-list"
                        listTestId="sidebar-list-agent"
                        entryTestId={(entry) => `agent-entry-${entry.id}`}
                        selectLabel={(entry) => `Use ${entry.title}`}
                        // Picking an agent applies its block to the chat; the
                        // composer's agent picker reads the same cell.
                        onSelect={(agentId) => instance.execute<string>(CHAT_AGENT_SET_COMMAND, agentId)}
                    />
                ) : null}

                {tab === 'tool' ? (
                    <SessionsBoard
                        heading={COPY.tools}
                        entries={toolEntries}
                        emptyLabel={COPY.emptyTools}
                        emptyTestId="empty-tool-list"
                        listTestId="sidebar-list-tool"
                        entryTestId={(entry) => `tool-entry-${entry.id}`}
                        selectLabel={(entry) => entry.title}
                    />
                ) : null}

                {tab === 'settings' ? (
                    <dl className="rail__settings" data-testid="sidebar-settings">
                        <div className="rail__row">
                            <dt>Activity</dt>
                            <dd data-testid="sidebar-status">{status}</dd>
                        </div>
                        <div className="rail__row">
                            <dt>Turns</dt>
                            <dd data-testid="sidebar-turn-count">{turns.length}</dd>
                        </div>
                        <div className="rail__row">
                            <dt>Model</dt>
                            <dd data-testid="sidebar-model">{model || 'none'}</dd>
                            <dd className="rail__hint">{models.length} catalog entries</dd>
                        </div>
                        <div className="rail__row">
                            <dt>Total tokens</dt>
                            <dd data-testid="sidebar-tokens">{usage?.total_tokens ?? 0}</dd>
                        </div>
                        <div className="rail__row">
                            <dt>Follow output</dt>
                            <dd>
                                {/* The one rail control that mutates through a real
                                    command id (chat.autoscroll.toggle returns the new
                                    value, so the pressed state stays authoritative). */}
                                <button
                                    type="button"
                                    className="btn btn--ghost"
                                    aria-pressed={autoscroll}
                                    data-testid="autoscroll-toggle"
                                    onClick={() => instance.execute<void, boolean>(CHAT_AUTOSCROLL_TOGGLE_COMMAND)}
                                >
                                    {autoscroll ? 'Following' : 'Pinned'}
                                </button>
                            </dd>
                        </div>
                    </dl>
                ) : null}
            </div>
        </div>
    );
}
