// Vendored workstation contract — every id and every view-local type the rebuilt
// chat-assistant UI shares.
//
// Adapted from packages/underload/dashboard/example/src/app/contract.ts (the
// example is a DEV-only surface of that package: `files: ["dist","src"]` keeps it
// out of the tarball and its resolution tests forbid importing it across package
// boundaries, so the skin is VENDORED here instead of imported by path).
//
// ONE module, no imports from plugins or components:
//   - plugins import the ids and register against them;
//   - components import the same ids to read state/services and run commands;
//   - tests import the same ids to assert exact values.
// That keeps plugin<->component imports acyclic and makes a rename one line that
// every consumer typechecks.
//
// The core vocabulary itself (`dashboard()`, Dashboard, DashboardPlugin,
// DashboardState, DashboardContribution) comes from '@underload/dashboard' and is
// imported where used; this file adds only this distribution's own names.
//
// ---------------------------------------------------------------------------
// DATA-TESTID GRAMMAR — downstream workers use these strings VERBATIM.
// The shell owns exactly three of them (station-root, station-bar, and the
// per-region `region-{id}` attributes listed below the grammar); every other id
// is emitted by the plugin/component that owns that surface.
//
//   station-root              the `.station` element (WorkstationShell)
//   station-bar               the header strip inside station-root
//   sidebar                   the sidebar surface (sessions plugin)
//   sidebar-tab-{tab}         one sidebar tab button, {tab} in
//                             chat | agent | tool | settings
//   session-entry-{id}        one conversation row in the sidebar, {id} = the
//                             session id exactly as stored (conversationId)
//   transcript                the transcript list container
//   message-turn-{index}      one rendered turn, {index} = ChatTurn.index as a
//                             decimal, 0-based, no padding
//   turn-controls-{index}     the control row of that same turn
//   streaming-loading         the live "reply in flight" affordance
//   composer                  the composer form container
//   composer-input            the composer text input/textarea
//   model-select              the model <select>
//   agent-select              the agent <select>
//   send-button               the send / stop control of the composer
//   voice-button              the voice-to-text toggle
//   error-banner              the non-modal error strip
//   notice-strip              the transient notice strip
//   aside-panel               the aside surface (details/settings)
//
// Shell-owned extras (NOT part of the downstream grammar, do not reuse):
//   region-sidebar | region-stage | region-aside   the three grid columns
//   theme-toggle | density-toggle                  the bar's skin affordances
// The bar's brand chip is static chrome built from the `layout.brand` service;
// STATUS_SLOT contributions render next to it and carry their own ids.
// ---------------------------------------------------------------------------
import type { ComponentType, ReactNode } from 'react';
// Type-only import of the core's cell handle: erased at build time, and it is
// what lets `ChatCells` (below) name the exact type of every registered cell
// without any plugin having to re-declare it.
import type { DashboardState } from '@underload/dashboard';
// Type-only imports: erased at build time, so pulling the wire/registry types in
// costs the dashboard bundle nothing and keeps the view model in step with the
// server format (full parity with the pre-rebuild UI).
import type { AssistantMode, ChatMessage, ConversationRecord, ConversationSummary } from '../api';
import type { AgentDefinition, ToolDefinition } from '../agents';

// ——— Slot names ——————————————————————————————————————————————————————————————
// The shell renders three region channels plus the chip strip. Slot names are
// open (the first contribution creates the channel) but the shell only reads
// these four, so a feature plugin that wants to be seen contributes here.

/** Sidebar rail: session list / agent + tool registry / settings tabs. */
export const SIDEBAR_SLOT = 'layout.sidebar';

/** Centre stage: transcript + composer (one owner per region, see the shell). */
export const STAGE_SLOT = 'layout.stage';

/** Inspector aside: turn details, usage, skin settings. */
export const ASIDE_SLOT = 'layout.aside';

/** Small live chips rendered in the station bar. */
export const STATUS_SLOT = 'layout.status';

/** Shape of one slot contribution as returned by `instance.slot<T>(name)`. */
export type Contribution<T> = { id: string; order: number; value: T };

// ——— Regions (layout vocabulary) ——————————————————————————————————————————————

/** The three viewport columns. Their CSS owns width; plugins own content. */
export type RegionId = 'sidebar' | 'stage' | 'aside';

/**
 * Region metadata published by the layout plugin (`layout.regions` service).
 * `slot` is the channel the shell reads for that column.
 */
export type RegionSpec = {
    id: RegionId;
    /** Accessible name put on the region's `aria-label`. */
    label: string;
    /** Visual order left-to-right on wide viewports. */
    order: number;
    slot: string;
};

/** Brand metadata published by the layout plugin (`layout.brand` service). */
export type BrandSpec = {
    /** Station bar heading. */
    name: string;
    /** Secondary line under the heading. */
    tagline: string;
    /** Accent-bordered chip in the bar's chip group. */
    chip: string;
    /** Footer note under the grid. */
    notice: string;
};

/**
 * Value registered in a region slot.
 *
 * Two shapes, discriminated by the presence of `component`:
 *   - `{ title, hint?, body }` — the shell renders the panel chrome (head with
 *     title + hint) and puts `body` in the body slot;
 *   - `{ component }` — the shell renders the component with NO props, inside no
 *     chrome, so the feature owns its whole surface (this is what the chat
 *     plugins use).
 * A value may carry both: `component` wins (the shell checks it first).
 */
export type PanelDescriptor = { title: string; hint?: string; body?: ReactNode };
export type PanelComponent = { component: ComponentType };
export type PanelValue = PanelDescriptor | PanelComponent;

/** Narrowing helper the shell (and any other slot reader) uses. */
export const isPanelComponent = (value: PanelValue): value is PanelComponent =>
    typeof (value as PanelComponent).component === 'function';

/** Value registered in STATUS_SLOT: one live chip in the station bar. */
export type StatusValue = { label: string; component: ComponentType };

// ——— Skin vocabulary ——————————————————————————————————————————————————————————
// Token names are shared with the vendored skin (see styles/tokens.css): the
// attribute values below are what `.station[data-*]` selectors match.

/** 'ink' is the dark workstation skin (default), 'slate' the light variant. */
export type DashboardTheme = 'ink' | 'slate';
export type DashboardDensity = 'comfortable' | 'compact';
export type DashboardMotion = 'full' | 'reduced';

// ——— Domain model (mirrors the server wire format, see ../api) —————————————————

/** The only roles the storage API accepts. */
export type ChatRole = ChatMessage['role'];

/** 'online' = the storage server + private provider relay, 'offline' = browser-local. */
export type ChatMode = AssistantMode;

/** One conversation row of the sidebar (`chat.sessions`). */
export type ChatSession = ConversationSummary;

/** The active session's message list (`chat.transcript`). */
export type ChatTranscript = readonly ChatMessage[];

/** Provider token counters as reported on the wire (`chat.usage`). */
export type ChatUsage = NonNullable<ConversationRecord['usage']>;

/**
 * Activity label for the bar chip (`chat.status`). T1 fixes the vocabulary so
 * the chip, the composer and the tests describe one state the same way; the
 * domain plugin owns which command moves it where.
 */
export type ChatStatus = 'idle' | 'loading' | 'sending' | 'streaming' | 'saving' | 'error';

/**
 * View model of one rendered turn (`chat.turns`).
 *
 * Derived from `chat.transcript` + `chat.collapsedTurns` + the editing flag: the
 * transcript is the wire truth, turns are what the list paints, so a component
 * never joins those three cells itself (a fresh array per render would break
 * `useSyncExternalStore` — see state-hooks.ts).
 */
export type ChatTurn = {
    /** 0-based position in the transcript; also the testid suffix. */
    index: number;
    message: ChatMessage;
    role: ChatRole;
    /** True when this turn's body is collapsed to its first line. */
    collapsed: boolean;
    /** True while this turn's bubble is the inline contentEditable editor. */
    editing: boolean;
    /** Producing model, '' when unknown (user/system turns, older records). */
    model: string;
};

/** Which registry the sidebar is showing (`chat.sidebarTab`). */
export type SidebarTab = 'chat' | 'agent' | 'tool' | 'settings';

/**
 * Every `chat.*` state cell, as one frozen handle object (`chat.cells` service).
 * Field order mirrors the state-id block below, so "the plugin registered every
 * cell" is one readable list; the cell TYPE is exactly what the id's comment says
 * (the same shapes the T3 brief freezes and the other workers code against).
 */
export type ChatCells = {
    mode: DashboardState<ChatMode>;
    providerBase: DashboardState<string>;
    sessions: DashboardState<readonly ChatSession[]>;
    activeSessionId: DashboardState<string | null>;
    transcript: DashboardState<ChatTranscript>;
    turns: DashboardState<readonly ChatTurn[]>;
    status: DashboardState<ChatStatus>;
    error: DashboardState<string>;
    draft: DashboardState<string>;
    model: DashboardState<string>;
    models: DashboardState<readonly string[]>;
    agent: DashboardState<string>;
    agents: DashboardState<readonly AgentDefinition[]>;
    activeAgentId: DashboardState<string | null>;
    tools: DashboardState<readonly ToolDefinition[]>;
    activeToolId: DashboardState<string | null>;
    usage: DashboardState<ChatUsage | null>;
    pending: DashboardState<ChatPendingTurn | null>;
    streaming: DashboardState<string>;
    systemDraft: DashboardState<string>;
    editingSystem: DashboardState<boolean>;
    /** number | null — the transcript index whose bubble is the inline editor. */
    editingIndex: DashboardState<number | null>;
    collapsedTurns: DashboardState<readonly number[]>;
    autoscroll: DashboardState<boolean>;
    listening: DashboardState<boolean>;
    sidebarTab: DashboardState<SidebarTab>;
    drawerOpen: DashboardState<boolean>;
};

/**
 * One snapshotted staleness pair, taken BEFORE the first await of any chat flow
 * (see CHAT_EPOCH_SERVICE). `namespace` invalidates when the storage/provider
 * namespace changes (a mode switch); `surface` additionally invalidates when the
 * OPENED session changes. A flow picks the check its settle actually writes for:
 * a sidebar row belongs to the namespace, a transcript/editor/banner batch belongs
 * to the surface. Ported from the oracle's single `modeEpoch` counter
 * (components/ChatAssistantApp.tsx:2612-2624) plus the surface identity it tracked
 * separately through `activeSend.conversationId` (:3903, :4066-4067).
 */
export type ChatGuard = { namespace: number; surface: number };

/** The epoch guard published as `chat.cells.epoch` by plugins/core.ts. */
export type ChatEpoch = {
    /** Snapshot both counters as of now. Call before the first await. */
    capture(): ChatGuard;
    /** True while the mode/namespace has not changed since `guard`. */
    namespaceCurrent(guard: ChatGuard): boolean;
    /** True while neither the mode NOR the opened session has changed. */
    surfaceCurrent(guard: ChatGuard): boolean;
};

/**
 * The three phases a chat flow can be in, i.e. the four-value `chat.status`
 * vocabulary minus 'idle'. 'sending' is a stream, 'loading' a session read,
 * 'saving' any storage write.
 */
export type ChatPhase = Extract<ChatStatus, 'loading' | 'sending' | 'saving'>;

/** The refcounted busy tracker published as `chat.cells.activity`. */
export type ChatActivity = {
    /** Enter a phase; the cell shows the strongest active phase. */
    begin(phase: ChatPhase): void;
    /** Leave a phase; 'idle' returns only when the LAST flow has left. */
    end(phase: ChatPhase): void;
    /** The label every flow publishes, idempotently ('idle' when nothing runs). */
    current(): ChatStatus;
    /** True while ANY flow is in `phase` — the guard the oracle's booleans gave it. */
    isBusy(phase: ChatPhase): boolean;
    /**
     * Drop every count at once. The core plugin calls it on a mode switch: the
     * transient busy flags belong to the previous namespace, and a detached
     * operation's stale finally must neither clear nor re-take them there
     * (components/ChatAssistantApp.tsx:3405-3412).
     */
    reset(): void;
};

/** Coarse viewport class the shell derives from matchMedia. */
export type ViewportMode = 'desktop' | 'mobile';

// ——— Shared composite command inputs —————————————————————————————————————————
// Commands whose input is more than one primitive are named here so the caller
// and the handler cannot drift apart.

export type SessionRenameInput = { sessionId: string; title: string };
export type MessageRoleInput = { index: number; role: ChatRole };
export type MessageUpdateInput = { index: number; content: string };

/**
 * The in-flight user bubble (`chat.pending`), null when nothing is generating.
 * Added by T3: the oracle held this in two surface-agnostic strings
 * (`pendingUser`/`streaming`) and gated the bubbles at RENDER time on a private
 * `activeSend` snapshot. As a state value the turn carries its own timestamp, so
 * the view has an exact "since when is this pending" for the loading affordance
 * and the stale-buffer rule (`at` is a wall-clock `Date.now()`).
 */
export type ChatPendingTurn = { text: string; at: number };

// ——— State ids ————————————————————————————————————————————————————————————————
// Global id space: a duplicate id anywhere is rejected (`duplicate-state`), and
// the cell's type is only ever what the registering plugin says it is.
//
// T1 registers ONLY the `ui.*` cells (see plugins/theme.ts). Every `chat.*` cell
// is registered by the chat domain plugin; until then `instance.state('chat.*')`
// throws `unknown-state`, which is why the shell reads nothing below `ui.*`.

/** ChatMode — the online/offline switch (persisted, see ../api/offline.ts). */
export const CHAT_MODE_STATE = 'chat.mode';
/** string — offline provider base (settings), '' = the deployment default. */
export const CHAT_PROVIDER_BASE_STATE = 'chat.providerBase';
/** readonly ChatSession[] — the sidebar history list. */
export const CHAT_SESSIONS_STATE = 'chat.sessions';
/** string — the open session id, null = the new-chat surface. */
export const CHAT_ACTIVE_SESSION_STATE = 'chat.activeSessionId';
/** ChatTranscript — message list of the open session (wire truth). */
export const CHAT_TRANSCRIPT_STATE = 'chat.transcript';
/** ChatStatus — activity label for the bar chip. */
export const CHAT_STATUS_STATE = 'chat.status';
/** string — last failure's message, '' = none (error-banner). */
export const CHAT_ERROR_STATE = 'chat.error';
/** string — composer draft text. */
export const CHAT_DRAFT_STATE = 'chat.draft';
/** string — the selected provider model id. */
export const CHAT_MODEL_STATE = 'chat.model';
/** Agent id applied to NEW chats (see chat.agent.set; '' = none). */
export const CHAT_AGENT_STATE = 'chat.agent';
/** readonly string[] — the provider model catalog. */
export const CHAT_MODELS_STATE = 'chat.models';
/** string — draft system prompt while the agent editor is open. */
export const CHAT_SYSTEM_DRAFT_STATE = 'chat.systemDraft';
/** boolean — the system prompt editor is open. */
export const CHAT_EDITING_SYSTEM_STATE = 'chat.editingSystem';
/** readonly number[] — indices of collapsed turns (immutable sets). */
export const CHAT_COLLAPSED_TURNS_STATE = 'chat.collapsedTurns';
/** readonly AgentDefinition[] — the agent registry. */
export const CHAT_AGENTS_STATE = 'chat.agents';
/** readonly ToolDefinition[] — the tool registry. */
export const CHAT_TOOLS_STATE = 'chat.tools';
/** string — selected agent id, '' = none. */
export const CHAT_ACTIVE_AGENT_STATE = 'chat.activeAgentId';
/** string — selected tool id, '' = none. */
export const CHAT_ACTIVE_TOOL_STATE = 'chat.activeToolId';
/** ChatUsage | null — token counters of the open session. */
export const CHAT_USAGE_STATE = 'chat.usage';
/** ChatPendingTurn | null — user text whose reply is in flight, null = none. */
export const CHAT_PENDING_STATE = 'chat.pending';
/** string — partial assistant text, '' = not streaming. */
export const CHAT_STREAMING_STATE = 'chat.streaming';
/** boolean — the speech recognizer is listening. */
export const CHAT_LISTENING_STATE = 'chat.listening';
/** boolean — keep the transcript pinned to the bottom. */
export const CHAT_AUTOSCROLL_STATE = 'chat.autoscroll';
/** SidebarTab — which registry the sidebar shows. */
export const CHAT_SIDEBAR_TAB_STATE = 'chat.sidebarTab';
/** boolean — mobile sidebar drawer. */
export const CHAT_DRAWER_OPEN_STATE = 'chat.drawerOpen';
/** readonly ChatTurn[] — derived view model (see ChatTurn). */
export const CHAT_TURNS_STATE = 'chat.turns';
/**
 * number | null — transcript index whose bubble IS the inline contentEditable
 * editor, null = none. Added by T3: `ChatTurn.editing` has to be derived from
 * state (a component-local editor index could not feed `chat.turns`, which is
 * the single derived view-model cell the list paints). The system-prompt DRAFT
 * turn is not addressed here — it is `chat.editingSystem` plus the `-1`
 * sentinel inside `chat.collapsedTurns` (see plugins/system-prompt.ts).
 */
export const CHAT_EDITING_INDEX_STATE = 'chat.editingIndex';

/** DashboardTheme — projected onto `.station[data-theme]`. */
export const UI_THEME_STATE = 'ui.theme';
/** DashboardDensity — projected onto `.station[data-density]`. */
export const UI_DENSITY_STATE = 'ui.density';
/** DashboardMotion — projected onto `.station[data-motion]`. */
export const UI_MOTION_STATE = 'ui.motion';

// ——— Service ids ———————————————————————————————————————————————————————————————
// Facade shapes belong to the plugin that registers them (the consumer names the
// type at the call site); T1 pins only the id, plus the two layout services the
// shell needs.

/** BrandSpec — layout plugin, read by the station bar. */
export const LAYOUT_BRAND_SERVICE = 'layout.brand';
/** readonly RegionSpec[] — layout plugin, read by the station grid. */
export const LAYOUT_REGIONS_SERVICE = 'layout.regions';
/** Conversation storage facade (CRUD over ../api or the browser-local store). */
export const CHAT_CONVERSATIONS_SERVICE = 'chat.conversations';
/** Inference provider facade (model catalog + streamed completions). */
export const CHAT_PROVIDER_SERVICE = 'chat.provider';
/** Speech facade wrapping the Web Speech API (../api/speech.ts). */
export const CHAT_SPEECH_SERVICE = 'chat.speech';
/** Agent registry store facade (../agents/index.ts). */
export const CHAT_AGENT_STORE_SERVICE = 'chat.agentStore';
/** Tool registry store facade (../agents/index.ts). */
export const CHAT_TOOL_STORE_SERVICE = 'chat.toolStore';
/**
 * ChatCells — the handle object every `chat.*` state cell lives in, published by
 * the chat CORE plugin (plugins/core.ts). Added by T3 because the plugin API has
 * no state reader: `DashboardPluginAPI` exposes only `state()` (a REGISTER call,
 * and duplicate ids throw `duplicate-state`), so a sibling chat plugin could
 * otherwise not reach the transcript at all. The core plugin owns every
 * `chat.*` cell; the sessions/source/transcript/system-prompt plugins resolve
 * this service lazily inside their handlers (`api.getService(CHAT_CELLS_SERVICE)`)
 * and read/write the cells — they never call `api.state()` for a `chat.*` id.
 * Views keep reading cells through `useDashboardValue(id)`, i.e. by id, and do
 * not need this service.
 */
export const CHAT_CELLS_SERVICE = 'chat.cells';
/**
 * ChatEpoch — the R7 staleness guard published by the chat core plugin
 * (plugins/core.ts): `{ capture, namespaceCurrent, surfaceCurrent }`. Every
 * long-running chat flow snapshots the pair before its first await and drops the
 * whole settle when the pair no longer matches, which is how an online->offline
 * switch (or a session switch) mid-flight detaches a stale response from the
 * surface it no longer owns while its storage write still lands in the namespace
 * it started in.
 */
export const CHAT_EPOCH_SERVICE = 'chat.cells.epoch';
/**
 * ChatActivity — the refcounted busy tracker behind `chat.status`, published by
 * the chat core plugin (plugins/core.ts). Added by T3 because `chat.status` is ONE
 * cell while the pre-rebuild UI tracked SIX independent booleans (`loading`,
 * `deleting`, `savingEdit`, `savingTitle`, `savingSystemPrompt`, `activeSend`,
 * components/ChatAssistantApp.tsx:2577-2605): with one label and no refcount, two
 * overlapping flows (a session listing and a send) race each other's writes and the
 * surface either shows a stale spinner or drops a live one. The tracker publishes
 * the strongest ACTIVE phase and returns to 'idle' only when the last flow in that
 * phase finishes. Shape:
 * `{ begin(phase), end(phase), current(), isBusy(phase) }`.
 */
export const CHAT_ACTIVITY_SERVICE = 'chat.cells.activity';
/**
 * ChatNoticeFeed — the transient notice strip's observable feed, published by
 * `chat.notices` (plugins/notices.ts, added by T5). A SERVICE rather than a state
 * cell because every `chat.*` STATE id belongs to the chat core; the handle is
 * state-shaped (`DashboardState<readonly ChatNotice[]>`), so a view subscribes with
 * `useDashboardState(instance.service(CHAT_NOTICES_SERVICE))` and never polls.
 * Rows arrive from `chat.notice` events, leave through `chat.notice.dismiss`, and
 * are dropped when the storage namespace changes (a mode switch). Errors do NOT
 * live here: they stay in `chat.error`, whose strip is the stage's (testid
 * `error-banner`, ChatStage.tsx:320-324).
 */
export const CHAT_NOTICES_SERVICE = 'chat.notices';

// ——— Command ids ———————————————————————————————————————————————————————————————
// Signature convention (documented per command so handler and caller agree):
//
//   chat.session.create      void              -> string              new session id
//   chat.session.select      string            -> void
//   chat.session.delete      string            -> void
//   chat.session.rename      SessionRenameInput-> void
//   chat.message.send        void              -> Promise<void>       sends chat.draft
//   chat.message.cancel      void              -> boolean             false = nothing in flight
//   chat.message.copy        number            -> void                turn index
//   chat.message.fork        number            -> Promise<string>     new session id
//   chat.message.role        MessageRoleInput  -> void
//   chat.message.delete      number            -> void
//   chat.message.update      MessageUpdateInput-> void                auto-save on blur
//   chat.turn.toggle         number            -> void                collapse expand
//   chat.system.begin        void              -> void
//   chat.system.save         void              -> Promise<void>
//   chat.system.cancel       void              -> void
//   chat.draft.set           string            -> void
//   chat.model.set           string            -> void
//   chat.agent.set           string            -> void                '' clears
//   chat.agent.create        void              -> string
//   chat.agent.save          AgentDefinition   -> void
//   chat.agent.delete        string            -> void
//   chat.tool.create         void              -> string
//   chat.tool.save           ToolDefinition    -> void
//   chat.tool.delete         string            -> void
//   chat.voice.start         void              -> void
//   chat.voice.stop          void              -> void
//   chat.mode.set            ChatMode          -> void
//   chat.providerBase.set    string            -> void
//   chat.notice.dismiss      number|void       -> number            rows left in the strip
// Added by T5 (voice): the two voice handlers are ASYNC at the seam —
// chat.voice.start hands back a Promise<void> (the Web Speech pre-check resolves
// through `chat.speech.start()`) and chat.voice.stop reports whether a session was
// torn down (boolean). Both stay `-> void` above because no caller reads them:
// VoiceButton.tsx:41 fires and forgets, which is exactly the oracle's toggle
// contract (components/ChatAssistantApp.tsx:4174-4270).
//   chat.autoscroll.toggle   void              -> boolean             new value
//   chat.composer.focus      void              -> void
//
// Skin commands (T1's theme plugin owns these; `ui.*` ids match `ui.*` state):
//
//   ui.theme.set             DashboardTheme    -> DashboardTheme      validated
//   ui.theme.toggle          void              -> DashboardTheme
//   ui.density.set           DashboardDensity  -> DashboardDensity    validated
//   ui.motion.set            DashboardMotion   -> DashboardMotion     validated

export const CHAT_SESSION_CREATE_COMMAND = 'chat.session.create';
export const CHAT_SESSION_SELECT_COMMAND = 'chat.session.select';
export const CHAT_SESSION_DELETE_COMMAND = 'chat.session.delete';
export const CHAT_SESSION_RENAME_COMMAND = 'chat.session.rename';

export const CHAT_MESSAGE_SEND_COMMAND = 'chat.message.send';
export const CHAT_MESSAGE_CANCEL_COMMAND = 'chat.message.cancel';
export const CHAT_MESSAGE_COPY_COMMAND = 'chat.message.copy';
export const CHAT_MESSAGE_FORK_COMMAND = 'chat.message.fork';
export const CHAT_MESSAGE_ROLE_COMMAND = 'chat.message.role';
export const CHAT_MESSAGE_DELETE_COMMAND = 'chat.message.delete';
export const CHAT_MESSAGE_UPDATE_COMMAND = 'chat.message.update';

export const CHAT_TURN_TOGGLE_COMMAND = 'chat.turn.toggle';

export const CHAT_SYSTEM_BEGIN_COMMAND = 'chat.system.begin';
export const CHAT_SYSTEM_SAVE_COMMAND = 'chat.system.save';
export const CHAT_SYSTEM_CANCEL_COMMAND = 'chat.system.cancel';

export const CHAT_DRAFT_SET_COMMAND = 'chat.draft.set';
export const CHAT_MODEL_SET_COMMAND = 'chat.model.set';

export const CHAT_AGENT_SET_COMMAND = 'chat.agent.set';
export const CHAT_AGENT_CREATE_COMMAND = 'chat.agent.create';
export const CHAT_AGENT_SAVE_COMMAND = 'chat.agent.save';
export const CHAT_AGENT_DELETE_COMMAND = 'chat.agent.delete';

export const CHAT_TOOL_CREATE_COMMAND = 'chat.tool.create';
export const CHAT_TOOL_SAVE_COMMAND = 'chat.tool.save';
export const CHAT_TOOL_DELETE_COMMAND = 'chat.tool.delete';

export const CHAT_VOICE_START_COMMAND = 'chat.voice.start';
export const CHAT_VOICE_STOP_COMMAND = 'chat.voice.stop';

export const CHAT_MODE_SET_COMMAND = 'chat.mode.set';
export const CHAT_PROVIDER_BASE_SET_COMMAND = 'chat.providerBase.set';
export const CHAT_AUTOSCROLL_TOGGLE_COMMAND = 'chat.autoscroll.toggle';
export const CHAT_COMPOSER_FOCUS_COMMAND = 'chat.composer.focus';
/**
 * Removes one notice row (input = the row id) or the whole strip (no input), and
 * dismisses the surfaced `chat.error` alongside it. Registered by `chat.notices`
 * (plugins/notices.ts, added by T5); returns the rows still on screen.
 */
export const CHAT_NOTICE_DISMISS_COMMAND = 'chat.notice.dismiss';

export const UI_THEME_SET_COMMAND = 'ui.theme.set';
export const UI_THEME_TOGGLE_COMMAND = 'ui.theme.toggle';
export const UI_DENSITY_SET_COMMAND = 'ui.density.set';
export const UI_MOTION_SET_COMMAND = 'ui.motion.set';

// ——— Event ids ————————————————————————————————————————————————————————————————
// Events are LIVE ONLY: nothing is queued or replayed, so a view that mounts
// later must read state(id).get() for the truth. Payloads pass by reference —
// never mutate a payload you did not create.

/** { sessionId, title } */
export const CHAT_SESSION_CREATED_EVENT = 'chat.session.created';
/** { sessionId } */
export const CHAT_SESSION_SELECTED_EVENT = 'chat.session.selected';
/** { message } */
export const CHAT_ERROR_EVENT = 'chat.error';
/** { message } */
export const CHAT_NOTICE_EVENT = 'chat.notice';
/** { sessionId, requestId } */
export const CHAT_STREAM_STARTED_EVENT = 'chat.stream.started';
/** { sessionId, requestId, text } */
export const CHAT_STREAM_DELTA_EVENT = 'chat.stream.delta';
/** { sessionId, requestId, text } */
export const CHAT_STREAM_COMPLETED_EVENT = 'chat.stream.completed';
/** { sessionId, requestId, text } */
export const CHAT_STREAM_CANCELLED_EVENT = 'chat.stream.cancelled';/** { sessionId, turnCount } */
export const CHAT_TRANSCRIPT_UPDATED_EVENT = 'chat.transcript.updated';
/** DashboardTheme — emitted by ui.theme.set / ui.theme.toggle for repaint hosts. */
export const UI_THEME_CHANGED_EVENT = 'ui.theme.changed';

// ——— Event payload types ————————————————————————————————————————————————————————

export type SessionCreatedEvent = { sessionId: string; title: string };
export type SessionSelectedEvent = { sessionId: string };
export type NoticeEvent = { message: string };
/**
 * One row of the transient notice strip (`chat.notices` service), added by T5.
 * NOT a state cell: every `chat.*` state id belongs to the chat core, so the
 * strip's feed is published as a SERVICE (CHAT_NOTICES_SERVICE) whose value is a
 * state-shaped handle — `useDashboardState` consumes it unchanged.
 */
export type ChatNoticeTone = 'info' | 'success' | 'warn';
export type ChatNotice = {
    /** Monotonic row id: the React key AND the `chat.notice.dismiss` input. */
    id: number;
    message: string;
    tone: ChatNoticeTone;
    /** Wall-clock emission instant (`Date.now()`), for ordering and stale rows. */
    at: number;
};
/** Observable feed of the strip's rows (immutable writes, SameValueZero no-ops). */
export type ChatNoticeFeed = DashboardState<readonly ChatNotice[]>;
export type StreamStartedEvent = { sessionId: string; requestId: string };
export type StreamDeltaEvent = { sessionId: string; requestId: string; text: string };
export type StreamCompletedEvent = { sessionId: string; requestId: string; text: string };
/**
 * `text` is whatever arrived before the abort (possibly ''), the same snapshot the
 * completed event carries — the provider facade resolves an aborted stream rather
 * than rejecting it (services/provider.ts:189-194), so the partial reply survives
 * to the surface that is still rendering it.
 */
export type StreamCancelledEvent = { sessionId: string; requestId: string; text: string };
export type TranscriptUpdatedEvent = { sessionId: string; turnCount: number };

// ——— Contribution ids ———————————————————————————————————————————————————————————
// Unique PER SLOT, so the same suffix may appear in two channels; a duplicate
// inside one channel throws `duplicate-contribution`.
//
// FINAL CONTRIBUTION GRAPH (what the shell renders, one winner per channel):
//
//   layout.sidebar  layout.sidebar.placeholder  0   descriptor fallback (layout.ts)
//                   chat.sidebar               40   ChatSidebar                (surfaces.ts)
//   layout.stage    layout.stage.placeholder   0   descriptor fallback (layout.ts)
//                   chat.stage                50   ChatStageSlot              (surfaces.ts)
//   layout.aside    layout.aside.placeholder   0   descriptor fallback (layout.ts)
//                   chat.inspector            60   ChatInspector              (surfaces.ts)
//   layout.status   (nothing registered — the bar shows the brand chip; an add-on
//                    that wants a live chip takes any order, the channel is open)
//
// THE BANDS: 0 is the layout fallback, 40/50/60 are the real surfaces. T3's
// component placeholders at 10/20/30 are retired (the `chat.*.placeholder` ids are
// gone from the graph and components/Placeholder*.tsx is deleted), so a new
// contribution that wants to REPLACE a column takes that column's band + 10 and one
// that wants to sit BELOW it takes a lower number. Never tie inside one channel:
// the shell renders the last contribution of the sorted list, and ties resolve to
// the plugin that registered later (see WorkstationShell.tsx:62-81).
//
// Plugin ids of the add-ons are declared by their own modules, not here, because
// PLUGIN_IDS below was frozen before they existed: `chat.agents`
// (plugins/agents.ts:51), `chat.tools` (plugins/tools.ts:46), `chat.inputs`
// (plugins/inputs.ts:46) and `chat.surfaces` (plugins/surfaces.ts:53).

/** Plugin-owned contribution ids (also the React key of the rendered region). */
export const PLUGIN_IDS = {
    layout: 'layout',
    theme: 'theme',
    // T3 (chat core) plugin ids. Registration order == this declaration order,
    // and `requires` is the only reordering mechanism, so the graph stays:
    // layout -> theme -> chat.core -> chat.sessions -> chat.source ->
    // chat.transcript -> chat.system-prompt -> add-ons.
    chatCore: 'chat.core',
    chatSessions: 'chat.sessions',
    chatSource: 'chat.source',
    chatTranscript: 'chat.transcript',
    chatSystemPrompt: 'chat.system-prompt',
    // T5 add-on ids (settings / voice / notices). All three run AFTER the chat set
    // (they read `chat.cells`, `chat.cells.epoch`, `chat.cells.activity` and the
    // `chat.message.send` / `chat.message.cancel` commands), so composition.ts or
    // plugins/extras.ts must append them in this order:
    //   chat.settings -> chat.voice -> chat.notices
    // `chat.notices` last because it subscribes to the `chat.error` / `chat.notice`
    // events every earlier plugin emits, and `chat.voice` before
    // `chat.notices` only matters for readability of the strip's ordering. The
    // remaining add-ons (`chat.agents`, `chat.tools`, `chat.inputs`,
    // `chat.surfaces`) sit between the chat set and these three, or after them, as
    // plugins/extras.ts documents.
    chatSettings: 'chat.settings',
    chatVoice: 'chat.voice',
    chatNotices: 'chat.notices'
} as const;

/**
 * T1's placeholder contributions, one per region. They are the order-0 fallback:
 * a channel with no owner still renders the shell's panel chrome instead of an
 * empty column, and any real contribution replaces them (the shell renders only
 * the highest-ordered contribution per region — see WorkstationShell.tsx).
 */
export const LAYOUT_SIDEBAR_PLACEHOLDER = 'layout.sidebar.placeholder';
export const LAYOUT_STAGE_PLACEHOLDER = 'layout.stage.placeholder';
export const LAYOUT_ASIDE_PLACEHOLDER = 'layout.aside.placeholder';
