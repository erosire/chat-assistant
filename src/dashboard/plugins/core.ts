// Chat CORE plugin: the whole `chat.*` state graph, in one registration site.
//
// WHY ONE PLUGIN OWNS EVERY CELL (and why the sibling chat plugins never call
// `api.state()` for a `chat.*` id): registration is setup-scoped AND the id space
// is global — `duplicate-state` is thrown at the second claim, and a plugin that
// throws during setup discards the whole dashboard (packages/underload/dashboard/
// src/dashboard.ts:234-244, 'setup-failed'). So exactly one plugin may register
// the 27 cells, and every other chat plugin reaches them through the
// `chat.cells` service this file publishes (see CHAT_CELLS_SERVICE in
// ../contract.ts for why a service is the only available seam: the plugin API has
// no state READER).
//
// WHAT ELSE LIVES HERE:
//   1. the epoch guard (R7). The mode cell and the active-session cell each carry
//      a monotonic counter; every long-running flow in sessions/source/
//      transcript/system-prompt snapshots the pair before its first await and
//      drops its whole settle when the pair no longer matches. Ported from
//      components/ChatAssistantApp.tsx:2612-2624 (`modeEpoch`) plus the surface
//      identity the same component tracked with `activeSend.conversationId`
//      (:3903, :4066-4067) and `pendingConversationId` (:2611).
//      Bumped from a SUBSCRIPTION on the cells, not from a command: several
//      workers may write `chat.mode`/`chat.activeSessionId` (settings, session
//      list, add-on plugins) and the guard must not depend on which of them won
//      the command id. `chat.mode.set`/`chat.providerBase.set` themselves stay
//      with the settings surface — this plugin only reacts to the value landing.
//   2. the derived `chat.turns` writer. `chat.transcript` is the wire truth;
//      `chat.turns` is what the list paints (transcript + collapse set + the open
//      inline editor). It is recomputed here and written ONCE, so a component
//      never joins those cells itself — a fresh array per render breaks
//      useSyncExternalStore's snapshot-identity rule (see ../state-hooks.ts:17-24).
//   3. the pure domain helpers the other chat plugins share (summary projection,
//      default-collapse rule, agent prefix resolution, remembered-model storage).
//      They are exported as plain functions, not services: they are deterministic,
//      stateless and typechecked at import.
//
// NO REACT, NO JSX, NO fetch IN THIS FILE. Side effects at setup are limited to
// reading persisted browser state (settings / remembered model / registries) —
// the same reads the pre-rebuild component performed in its mount effects
// (components/ChatAssistantApp.tsx:2454, :2742, :2900).
import { arrayEach } from '@presource/core';
import type { DashboardPlugin, DashboardState } from '@underload/dashboard';
import { readStoredAgents, type AgentDefinition, type ToolDefinition } from '../../agents';
import { loadAssistantSettings, saveAssistantSettings } from '../../api/offline';
import type { ConversationRecord, ConversationSummary } from '../../api/chat-assistant';
import { createToolStore } from '../services/registries';
import {
    CHAT_ACTIVITY_SERVICE,
    CHAT_AGENT_STATE,
    CHAT_AGENTS_STATE,
    CHAT_ACTIVE_AGENT_STATE,
    CHAT_ACTIVE_SESSION_STATE,
    CHAT_ACTIVE_TOOL_STATE,
    CHAT_AUTOSCROLL_STATE,
    CHAT_CELLS_SERVICE,
    CHAT_COLLAPSED_TURNS_STATE,
    CHAT_DRAFT_STATE,
    CHAT_DRAWER_OPEN_STATE,
    CHAT_EDITING_INDEX_STATE,
    CHAT_EPOCH_SERVICE,
    CHAT_EDITING_SYSTEM_STATE,
    CHAT_ERROR_STATE,
    CHAT_LISTENING_STATE,
    CHAT_MODEL_STATE,
    CHAT_MODELS_STATE,
    CHAT_MODE_STATE,
    CHAT_PENDING_STATE,
    CHAT_PROVIDER_BASE_STATE,
    CHAT_SESSIONS_STATE,
    CHAT_SIDEBAR_TAB_STATE,
    CHAT_STATUS_STATE,
    CHAT_STREAMING_STATE,
    CHAT_SYSTEM_DRAFT_STATE,
    CHAT_TOOLS_STATE,
    CHAT_TRANSCRIPT_STATE,
    CHAT_TURNS_STATE,
    CHAT_USAGE_STATE,
    PLUGIN_IDS,
    type ChatCells,
    type ChatMode,
    type ChatPendingTurn,
    type ChatRole,
    type ChatSession,
    type ChatStatus,
    type ChatTranscript,
    type ChatTurn,
    type ChatUsage,
    type SidebarTab
} from '../contract';
// The core registers NO components: the region contributions live in
// ./surfaces.ts, which keeps this file React-free (see the header note).

// The option shape and its resolver live in ./options (the URLs are deployment
// configuration, never literals); they are re-exported here so `composition.ts`
// and the sibling chat plugins have one import path.
import { describeChatOptions, type ChatConfig, type ChatPluginOptions } from './options';

export type { ChatConfig, ChatPluginOptions };

// ——— Remembered model (browser chrome state, NOT a dashboard cell) ——————————————
// The pre-rebuild UI persisted the last model actually used under this exact key
// (components/ChatAssistantApp.tsx:1742, :1787-1802) and the rebuilt UI keeps the
// key, so an upgrade restores the same selection with no migration.
export const MODEL_STORAGE_KEY = 'chat-assistant:model';

// Storage is best-effort everywhere in this distribution: a locked-down or
// embedded browser degrades to session-only selection instead of failing the
// dashboard (components/ChatAssistantApp.tsx:1785-1801).
export const readStoredModel = (): string => {
    try {
        return window.localStorage.getItem(MODEL_STORAGE_KEY) ?? '';
    } catch {
        return '';
    }
};

export const storeStoredModel = (id: string): void => {
    try {
        // A blank selection is never written: it would erase the remembered
        // model of a session that simply has not picked one yet.
        if (id) window.localStorage.setItem(MODEL_STORAGE_KEY, id);
    } catch {
        // Persistence is best-effort; the in-session selection still stands.
    }
};

// ——— Shared pure helpers ———————————————————————————————————————————————————————

/**
 * Compact sidebar projection of a full record (`chat.sessions` row).
 * `messageCount` is read from the MESSAGES, not the record field, exactly as the
 * oracle did (components/ChatAssistantApp.tsx:2340-2348), so a server that
 * reports a stale count still renders the true length.
 * Frozen copy: the cell holds readonly rows, and the same object is handed to the
 * sessions cell AND to the emitted events, so nobody may mutate it afterwards.
 */
export const summaryFromRecord = (record: ConversationRecord): ChatSession => {
    const summary: ConversationSummary = {
        conversationId: record.conversationId,
        title: record.title,
        model: record.model,
        status: record.status,
        messageCount: record.messages.length,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt
    };
    return Object.freeze(summary);
};

/**
 * Insert-or-replace one summary in the session list (pure).
 * The oracle's rule: an existing row is replaced IN PLACE (the sidebar order is
 * the server's most-recent-first order and must not jitter), a new row is
 * PREPENDED because it is the newest activity
 * (components/ChatAssistantApp.tsx:3277-3281, :4097-4102).
 */
export const mergeSummary = (
    list: readonly ChatSession[],
    summary: ChatSession
): readonly ChatSession[] => {
    const exists = list.some((chat) => chat.conversationId === summary.conversationId);
    if (!exists) return Object.freeze([summary, ...list]);
    return Object.freeze(
        list.map((chat) => (chat.conversationId === summary.conversationId ? summary : chat))
    );
};

/** Drop one summary from the session list (pure; used by delete and by rollback). */
export const removeSummary = (
    list: readonly ChatSession[],
    sessionId: string
): readonly ChatSession[] => Object.freeze(
    list.filter((chat) => chat.conversationId !== sessionId)
);

/**
 * Indices that start COLLAPSED when a record loads or replaces the history: every
 * turn except the LATEST assistant reply (questions and prompts fold to one-line
 * previews; the newest answer is the one turn worth reading). A record with no
 * assistant reply collapses everything (components/ChatAssistantApp.tsx:2355-2366).
 */
export const defaultCollapsedIndices = (transcript: ChatTranscript): readonly number[] => {
    let latestAssistantIndex = -1;
    arrayEach([...transcript], ({ index, value }) => {
        if (value.role === 'assistant') latestAssistantIndex = index;
    });
    const indices: number[] = [];
    arrayEach([...transcript], ({ index, value }) => {
        if (index !== latestAssistantIndex) indices.push(index);
    });
    return Object.freeze(indices);
};

/**
 * The view model the transcript list paints: one row per TRANSCRIPT message,
 * joined with the collapse set and the open inline editor.
 * `index` stays the transcript position (the `message-turn-{index}` testid
 * suffix), so the -1 system-prompt DRAFT row is deliberately NOT part of this
 * list: it is its own surface (testid `system-prompt-turn`) driven by
 * `chat.systemDraft` / `chat.editingSystem`, with -1 as its sentinel inside
 * `chat.collapsedTurns` only.
 * Every row is frozen with a fresh (but reference-stable per input) message
 * handle: change detection on `chat.turns` is reference-based, so the writer
 * below compares rows and skips equal writes.
 */
export const buildTurns = (
    transcript: ChatTranscript,
    collapsedTurns: readonly number[],
    editingIndex: number | null
): readonly ChatTurn[] => {
    const turns: ChatTurn[] = [];
    arrayEach([...transcript], ({ index, value }) => {
        const role: ChatRole = value.role;
        turns.push(
            Object.freeze({
                index,
                message: value,
                role,
                collapsed: collapsedTurns.includes(index),
                editing: editingIndex === index,
                // Storage-only per-message attribution; '' when the record (or an
                // older row) never carried a producing model.
                model: value.model ?? ''
            })
        );
    });
    return Object.freeze(turns);
};

/** Two derived turn lists are equal when every row agrees field-by-field. */
const sameTurns = (previous: readonly ChatTurn[], next: readonly ChatTurn[]): boolean => {
    if (previous === next) return true;
    if (previous.length !== next.length) return false;
    for (let index = 0; index < next.length; index += 1) {
        const left = previous[index];
        const right = next[index];
        if (left === right) continue;
        if (
            left.index !== right.index ||
            left.message !== right.message ||
            left.role !== right.role ||
            left.collapsed !== right.collapsed ||
            left.editing !== right.editing ||
            left.model !== right.model
        ) {
            return false;
        }
    }
    return true;
};

/**
 * The refcounted busy tracker behind `chat.status` (CHAT_ACTIVITY_SERVICE).
 *
 * WHY A REFCOUNT AND NOT A PLAIN WRITE: `chat.status` is ONE cell with the four
 * documented labels, while the pre-rebuild UI tracked six booleans
 * (`loading`, `deleting`, `savingEdit`, `savingTitle`, `savingSystemPrompt`,
 * `activeSend` — components/ChatAssistantApp.tsx:2577-2605). With one label and no
 * count, a session listing and a send race each other's write: the surface either
 * shows a spinner after the last flow finished or drops it while one still runs.
 * The tracker publishes the STRONGEST active phase ('sending' > 'saving' >
 * 'loading', because a stream is what the composer's stop control keys off) and
 * returns to 'idle' only when the last flow in every phase has left. Writes are
 * idempotent, so a re-publish of the same label is a SameValueZero no-op and never
 * notifies subscribers.
 */
export const createChatActivity = (status: DashboardState<ChatStatus>): ChatActivity => {
    // Strongest first: the publish below takes the first phase with a live count.
    const phases: readonly ChatPhase[] = Object.freeze(['sending', 'saving', 'loading']);
    const counts: Record<ChatPhase, number> = { sending: 0, saving: 0, loading: 0 };

    const publish = (): void => {
        for (const phase of phases) {
            if (counts[phase] > 0) {
                status.set(phase);
                return;
            }
        }
        status.set('idle');
    };

    return {
        begin: (phase: ChatPhase): void => {
            counts[phase] += 1;
            publish();
        },
        end: (phase: ChatPhase): void => {
            // Clamped: an unbalanced end() can never make a count negative and
            // strand the label at a phase nothing is in.
            counts[phase] = Math.max(0, counts[phase] - 1);
            publish();
        },
        current: (): ChatStatus => status.get(),
        isBusy: (phase: ChatPhase): boolean => counts[phase] > 0,
        // A mode switch owns this: every transient busy flag belongs to the previous
        // namespace, and a detached operation's stale finally must neither clear nor
        // re-take it here (switchMode's reset, :3405-3412).
        reset: (): void => {
            counts.sending = 0;
            counts.saving = 0;
            counts.loading = 0;
            publish();
        }
    };
};

// ——— The epoch guard (R7) ———————————————————————————————————————————————————————
// The `ChatGuard` / `ChatEpoch` shapes live in ../contract (they are part of the
// shared vocabulary: any plugin that runs a long flow needs the same pair), and
// this file is the only implementation of them.
import type { ChatActivity, ChatEpoch, ChatGuard, ChatPhase } from '../contract';

/**
 * Reads the settings namespace without ever throwing: the persisted shape is
 * user-editable, and `loadAssistantSettings` already degrades corrupt/legacy
 * JSON to the online default (api/offline.ts:133-146).
 */
const readSettings = (): { mode: ChatMode; providerBase: string } => {
    const settings = loadAssistantSettings();
    return { mode: settings.mode, providerBase: settings.providerBase };
};

/**
 * The agent whose block prefixes NEW chats, resolved from the id in `chat.agent`
 * against the `chat.agents` registry (components/ChatAssistantApp.tsx:3935,
 * :4367). Null = "None": the chat opens with its own system prompt instead.
 */
export const resolveAgentPrefix = (
    agents: readonly AgentDefinition[],
    agentId: string
): AgentDefinition | null => {
    if (!agentId) return null;
    return agents.find((agent) => agent.id === agentId) ?? null;
};

/** True while a transcript holds no conversational turn (agent blocks attach then). */
export const isUnstartedTranscript = (transcript: ChatTranscript): boolean =>
    transcript.every((message) => message.role === 'system');

// ——— The plugin ————————————————————————————————————————————————————————————————

export function createCorePlugin(options: ChatPluginOptions = {}): DashboardPlugin {
    // Options are captured in the closure (deployment configuration, fixed for
    // the instance): the conversations/provider facades the source plugin
    // publishes rebuild themselves from these plus the live mode/base cells.
    const config = describeChatOptions(options);

    return {
        id: PLUGIN_IDS.chatCore,
        setup(api) {
            const settings = readSettings();

            // ——— every `chat.*` cell, in the contract's declaration order ——————
            // Values follow the frozen shape table in the T3 brief exactly; the
            // other workers code against these references.
            const mode: DashboardState<ChatMode> = api.state<ChatMode>(
                CHAT_MODE_STATE,
                settings.mode === 'offline' ? 'offline' : 'online'
            );
            const providerBase: DashboardState<string> = api.state<string>(
                CHAT_PROVIDER_BASE_STATE,
                settings.providerBase
            );
            const sessions: DashboardState<readonly ChatSession[]> = api.state<
                readonly ChatSession[]
            >(CHAT_SESSIONS_STATE, Object.freeze([]));
            const activeSessionId: DashboardState<string | null> = api.state<string | null>(
                CHAT_ACTIVE_SESSION_STATE,
                null
            );
            const transcript: DashboardState<ChatTranscript> = api.state<ChatTranscript>(
                CHAT_TRANSCRIPT_STATE,
                Object.freeze([])
            );
            // Derived-only: never written by a component (see the header note).
            const turns: DashboardState<readonly ChatTurn[]> = api.state<readonly ChatTurn[]>(
                CHAT_TURNS_STATE,
                Object.freeze([])
            );
            // The cell accepts the full contract vocabulary, but only the four
            // documented labels are ever written by these plugins: 'idle',
            // 'loading' (a session read), 'sending' (a stream) and 'saving' (a
            // storage write). Streaming progress is `chat.streaming`, and a
            // failure is `chat.error` — the status chip stays a coarse label.
            const status: DashboardState<ChatStatus> = api.state<ChatStatus>(
                CHAT_STATUS_STATE,
                'idle'
            );
            const error: DashboardState<string> = api.state<string>(CHAT_ERROR_STATE, '');
            const draft: DashboardState<string> = api.state<string>(CHAT_DRAFT_STATE, '');
            const model: DashboardState<string> = api.state<string>(
                CHAT_MODEL_STATE,
                readStoredModel()
            );
            const models: DashboardState<readonly string[]> = api.state<readonly string[]>(
                CHAT_MODELS_STATE,
                Object.freeze([])
            );
            // The agent applied to NEW chats (id, '' = none). Distinct from
            // `chat.activeAgentId`, which is the agent OPEN in the agent surface.
            const agent: DashboardState<string> = api.state<string>(CHAT_AGENT_STATE, '');
            const agents: DashboardState<readonly AgentDefinition[]> = api.state<
                readonly AgentDefinition[]
            >(CHAT_AGENTS_STATE, Object.freeze(readStoredAgents()));
            const activeAgentId: DashboardState<string | null> = api.state<string | null>(
                CHAT_ACTIVE_AGENT_STATE,
                null
            );
            // The tool store facade is registered by the agents/tools plugin,
            // which may be ordered AFTER this one, so the initial list is built
            // from the factory directly here (a plain object + localStorage, no
            // dashboard dependency). Every later edit rewrites the cell through
            // that plugin's own commands.
            const toolStore = createToolStore();
            const tools: DashboardState<readonly ToolDefinition[]> = api.state<
                readonly ToolDefinition[]
            >(CHAT_TOOLS_STATE, Object.freeze(toolStore.list()));
            const activeToolId: DashboardState<string | null> = api.state<string | null>(
                CHAT_ACTIVE_TOOL_STATE,
                null
            );
            const usage: DashboardState<ChatUsage | null> = api.state<ChatUsage | null>(
                CHAT_USAGE_STATE,
                null
            );
            const pending: DashboardState<ChatPendingTurn | null> = api.state<
                ChatPendingTurn | null
            >(CHAT_PENDING_STATE, null);
            const streaming: DashboardState<string> = api.state<string>(CHAT_STREAMING_STATE, '');
            const systemDraft: DashboardState<string> = api.state<string>(
                CHAT_SYSTEM_DRAFT_STATE,
                ''
            );
            const editingSystem: DashboardState<boolean> = api.state<boolean>(
                CHAT_EDITING_SYSTEM_STATE,
                false
            );
            const editingIndex: DashboardState<number | null> = api.state<number | null>(
                CHAT_EDITING_INDEX_STATE,
                null
            );
            const collapsedTurns: DashboardState<readonly number[]> = api.state<
                readonly number[]
            >(CHAT_COLLAPSED_TURNS_STATE, Object.freeze([]));
            const autoscroll: DashboardState<boolean> = api.state<boolean>(
                CHAT_AUTOSCROLL_STATE,
                true
            );
            const listening: DashboardState<boolean> = api.state<boolean>(
                CHAT_LISTENING_STATE,
                false
            );
            const sidebarTab: DashboardState<SidebarTab> = api.state<SidebarTab>(
                CHAT_SIDEBAR_TAB_STATE,
                'chat'
            );
            const drawerOpen: DashboardState<boolean> = api.state<boolean>(
                CHAT_DRAWER_OPEN_STATE,
                false
            );

            // The single handle object every sibling chat plugin resolves. Field
            // order matches the contract's id list so a missing cell is visible
            // in one read (the acceptance rule: every `chat.*` id registered).
            const cells: ChatCells = Object.freeze({
                mode,
                providerBase,
                sessions,
                activeSessionId,
                transcript,
                turns,
                status,
                error,
                draft,
                model,
                models,
                agent,
                agents,
                activeAgentId,
                tools,
                activeToolId,
                usage,
                pending,
                streaming,
                systemDraft,
                editingSystem,
                editingIndex,
                collapsedTurns,
                autoscroll,
                listening,
                sidebarTab,
                drawerOpen
            });

            // ——— the epoch guard ————————————————————————————————————————————————
            // Two counters, bumped by cell subscriptions (state is truth: whoever
            // writes the cell — a command, a view, an add-on plugin — detaches the
            // flows that snapshotted the older value).
            let namespaceEpoch = 0;
            let surfaceEpoch = 0;
            const epoch: ChatEpoch = {
                capture: (): ChatGuard => ({
                    namespace: namespaceEpoch,
                    surface: surfaceEpoch
                }),
                namespaceCurrent: (guard: ChatGuard): boolean => guard.namespace === namespaceEpoch,
                surfaceCurrent: (guard: ChatGuard): boolean =>
                    guard.namespace === namespaceEpoch && guard.surface === surfaceEpoch
            };

            // The busy tracker behind `chat.status` (see createChatActivity above):
            // created here because the mode-switch reset below owns its counters, and
            // every other chat plugin reaches it through the published service.
            const activity = createChatActivity(status);

            // A mode switch moves BOTH namespaces (storage records AND the
            // provider base) — components/ChatAssistantApp.tsx:3387-3419 bumped
            // `modeEpoch` first, before any reset, which is the order that keeps a
            // detached stream from re-applying itself after an away-and-back
            // bounce (the same mode string, a NEW epoch).
            //
            // The reset that follows is the ported `switchMode` body: the session
            // list, the open record and every in-flight surface flag belong to ONE
            // storage namespace, so a stale selection from the other mode must not
            // render while the new namespace's effects reload it. The composer
            // draft and the selected model are mode-agnostic and SURVIVE (the
            // oracle kept both, :3385-3386), and the catalog is cleared here because
            // the source plugin re-reads it for the new configuration.
            const resetNamespace = (): void => {
                sessions.set(Object.freeze([]));
                transcript.set(Object.freeze([]));
                usage.set(null);
                pending.set(null);
                streaming.set('');
                models.set(Object.freeze([]));
                collapsedTurns.set(Object.freeze([]));
                systemDraft.set('');
                editingSystem.set(false);
                editingIndex.set(null);
                // The busy flags belong to the namespace being left (switchMode's
                // transient-flag reset, :3405-3412), so the tracker drops every
                // count instead of writing one label.
                activity.reset();
                error.set('');
                // LAST: clearing the id is itself a surface switch, and everything
                // above has already been written.
                activeSessionId.set(null);
            };
            const onModeChange = mode.subscribe(() => {
                namespaceEpoch += 1;
                surfaceEpoch += 1;
                resetNamespace();
                // Every settings edit persists IMMEDIATELY, so a reload restores
                // the same configuration (`applySettings`, :3363-3365). A
                // locked-down storage keeps the session working and only loses the
                // restore (api/offline.ts:153-160 re-throws; the surface stays up).
                try {
                    saveAssistantSettings({
                        mode: mode.get() === 'offline' ? 'offline' : 'online',
                        providerBase: providerBase.get()
                    });
                } catch {
                    // Best-effort, by contract.
                }
            });

            // A provider-base edit re-persists the settings object too (the single
            // base is the whole offline configuration), but resets NOTHING: the
            // oracle's `updateProviderBase` only re-ran the catalog effect
            // (:3421-3427), and the source plugin owns that.
            const onProviderBaseChange = providerBase.subscribe(() => {
                try {
                    saveAssistantSettings({
                        mode: mode.get() === 'offline' ? 'offline' : 'online',
                        providerBase: providerBase.get()
                    });
                } catch {
                    // Best-effort, by contract.
                }
            });

            // A session switch invalidates the SURFACE only: an in-flight send
            // keeps persisting into the namespace it started in, and its sidebar
            // row keeps updating there, while nothing may touch the newly opened
            // transcript (the reported bug: the streaming bubbles rendered from
            // surface-agnostic buffers and flooded the chat the user had just
            // opened — components/ChatAssistantApp.tsx:2586-2605).
            const onSessionChange = activeSessionId.subscribe(() => {
                surfaceEpoch += 1;
                // The oracle gated the RENDER of these two buffers on its private
                // `activeSend` snapshot; the rebuilt state vocabulary has no
                // active-send cell to gate with, so the buffers are cleared when the
                // surface that owns them is left. The abandoned stream's writes are
                // already detached by the guard above and its completion still
                // persists in its own namespace, so the only thing lost is painting a
                // half-reply on a chat that never asked for it.
                pending.set(null);
                streaming.set('');
            });

            // ——— the derived `chat.turns` writer ————————————————————————————————
            // Recompute ONLY on the three inputs the view model joins, and skip an
            // equal write so the snapshot reference stays stable for
            // useSyncExternalStore while unrelated cells churn.
            const writeTurns = (): void => {
                const next = buildTurns(transcript.get(), collapsedTurns.get(), editingIndex.get());
                turns.set((previous) => (sameTurns(previous, next) ? previous : next));
            };
            const onTranscriptChange = transcript.subscribe(writeTurns);
            const onCollapsedChange = collapsedTurns.subscribe(writeTurns);
            const onEditingChange = editingIndex.subscribe(writeTurns);

            // Seed the derived cell once: a fresh dashboard already has a
            // (possibly empty) transcript, and a view that mounts later must read
            // a correct snapshot rather than derive it (events are live-only).
            writeTurns();

            // The handle object is a service, not a state cell: it is created once
            // and never replaced, so consumers may keep it for the instance's life.
            api.service<ChatCells>(CHAT_CELLS_SERVICE, cells);
            api.service<ChatEpoch>(CHAT_EPOCH_SERVICE, epoch);
            api.service<ChatActivity>(CHAT_ACTIVITY_SERVICE, activity);

            // ——— region content: contributed by plugins/surfaces.ts ——————————————
            // The core used to register a component placeholder per channel
            // (orders 10/20/30) while the real surfaces were still being built. T6
            // replaced them with the real owners (ChatSidebar / ChatStageSlot /
            // ChatInspector) at orders 40/50/60 in `chat.surfaces`, so this plugin is
            // headless again: it owns the state graph, the three handle services and
            // the epoch/activity guards, and renders nothing.
            //
            // Teardown: drop every subscription this plugin opened. The cells
            // themselves are detached by the framework, so only the handles are
            // the plugin's responsibility.
            return () => {
                onModeChange();
                // The provider-base subscription re-persists the settings object; its
                // handle was captured at :570 and belongs to this plugin, so teardown
                // drops it with every other one (an undisposed subscription outliving a
                // disposed dashboard is what made the state registry throw 'disposed'
                // in a late write).
                onProviderBaseChange();
                onSessionChange();
                onTranscriptChange();
                onCollapsedChange();
                onEditingChange();
            };
        }
    };
}

/** The default-configured core plugin (deployment defaults; see ./chat.ts). */
export const corePlugin: DashboardPlugin = createCorePlugin();
