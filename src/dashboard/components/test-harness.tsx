// LOCAL TEST HARNESS for the chat surface components.
//
// WHY IT EXISTS: the chat plugins (`src/dashboard/plugins/**`) are being written
// by another worker at the same time as these components, so a component test
// cannot compose the real `createChatDashboard()` graph and stay deterministic.
// This harness builds a `dashboard({ plugins: [...] })` that registers EXACTLY
// the cells, commands and the one service these components touch, with stub
// handlers that record their payloads. Assertions then come from the component's
// observable behaviour (what it renders, what it dispatches), never from CSS.
//
// THE RULES THE HARNESS ENCODES (both are live traps in the core):
//   1. every state id must be registered before a view reads it — `instance.state`
//      throws `unknown-state` otherwise (see packages/underload/dashboard/src/
//      extensions/registries.ts);
//   2. every command a view executes must exist — `execute` throws
//      `unknown-command`. Handlers return the contract's documented output type so
//      a component that reads a return value (`chat.autoscroll.toggle` -> boolean)
//      sees a realistic one.
//
// Test files own their seeds; nothing here mutates a seed after registration,
// because state change detection is SameValueZero and a mutated reference would
// notify nobody (see src/dashboard/state-hooks.ts:26-29).
import { dashboard } from '@underload/dashboard';
import type { Dashboard, DashboardPlugin, DashboardState } from '@underload/dashboard';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { ChatMessage, ConversationSummary } from '../../api';
import { createAgentDefinition, type AgentDefinition, type ToolDefinition } from '../../agents';
import * as ids from '../contract';
import type { ProviderLabelService } from './ModelPicker';
import type { SpeechClient } from '../services/speech';
import { WorkbenchProvider } from '../workbench';

/** Token counters as the wire reports them (`chat.usage`). */
export type HarnessUsage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };

/** Everything a test may seed. Defaults are the empty-surface values below. */
export type HarnessSeed = {
    sessions?: readonly ConversationSummary[];
    activeSessionId?: string | null;
    transcript?: readonly ChatMessage[];
    turns?: readonly ids.ChatTurn[];
    status?: ids.ChatStatus;
    error?: string;
    draft?: string;
    model?: string;
    models?: readonly string[];
    agents?: readonly AgentDefinition[];
    activeAgentId?: string | null;
    /** T4 — the agent that prefixes NEW chats (`chat.agent`, '' = none). */
    agent?: string;
    tools?: readonly ToolDefinition[];
    activeToolId?: string | null;
    usage?: HarnessUsage | null;
    pending?: ids.ChatPendingTurn | null;
    streaming?: string;
    systemDraft?: string;
    editingSystem?: boolean;
    editingIndex?: number | null;
    collapsedTurns?: readonly number[];
    autoscroll?: boolean;
    listening?: boolean;
    sidebarTab?: ids.SidebarTab;
    drawerOpen?: boolean;
    /** T5 — the persisted-configuration cells the settings surface edits. */
    mode?: ids.ChatMode;
    providerBase?: string;
    /** T5 — the skin cells StationSettings reads (they match the shell's defaults). */
    theme?: ids.DashboardTheme;
    density?: ids.DashboardDensity;
    motion?: ids.DashboardMotion;
    /**
     * T5 — the notice strip's rows. The real feed is the `chat.notices` SERVICE; the
     * harness registers it as a cell and publishes the handle, so a test seeds and
     * re-writes it exactly like any other value (see the service note below).
     */
    notices?: readonly ids.ChatNotice[];
    /** `chat.provider` stub: ids and the index-aligned "base (provider)" labels. */
    providerCatalog?: readonly string[];
    providerLabels?: readonly string[];
};

/** What `createHarness` hands back: the instance plus the recorded dispatches. */
export type Harness = {
    instance: Dashboard;
    /** Payloads executed per command id, in call order. */
    calls: Map<string, unknown[]>;
    /** Recorded payloads for one command id (empty array when never called). */
    callsOf: (commandId: string) => unknown[];
    /** The live value of a registered cell. */
    read: <T>(stateId: string) => T;
    /** Write a cell the way a plugin would, then let React re-render. */
    write: <T>(stateId: string, value: T) => void;
};

/**
 * Empty-surface defaults, matching what the chat core plugin registers before any
 * conversation is loaded (so a test only names what its scenario is about).
 */
const DEFAULTS = {
    sessions: [] as readonly ConversationSummary[],
    activeSessionId: null as string | null,
    transcript: [] as readonly ChatMessage[],
    turns: [] as readonly ids.ChatTurn[],
    status: 'idle' as ids.ChatStatus,
    error: '',
    draft: '',
    model: '',
    models: [] as readonly string[],
    agents: [] as readonly AgentDefinition[],
    activeAgentId: null as string | null,
    // T4: the composer's agent prefix. '' = "None", the oracle's default
    // (components/ChatAssistantApp.tsx:2516 `agentChoice('')`).
    agent: '',
    tools: [] as readonly ToolDefinition[],
    activeToolId: null as string | null,
    usage: null as HarnessUsage | null,
    pending: null as ids.ChatPendingTurn | null,
    streaming: '',
    systemDraft: '',
    editingSystem: false,
    editingIndex: null as number | null,
    collapsedTurns: [] as readonly number[],
    autoscroll: true,
    listening: false,
    sidebarTab: 'chat' as ids.SidebarTab,
    drawerOpen: false,
    // T5 defaults: the online configuration and the ink/comfortable/full skin the
    // shell boots with (plugins/theme.ts:57-67 in an environment with no media
    // preference, which is exactly what jsdom is).
    mode: 'online' as ids.ChatMode,
    providerBase: '',
    theme: 'ink' as ids.DashboardTheme,
    density: 'comfortable' as ids.DashboardDensity,
    motion: 'full' as ids.DashboardMotion,
    notices: [] as readonly ids.ChatNotice[],
    providerCatalog: [] as readonly string[],
    providerLabels: [] as readonly string[]
};

/**
 * The command ids the chat surface is allowed to execute, with the return value
 * the contract documents for each. Registering the full list is deliberate: a
 * component that dispatches an id outside the contract fails LOUDLY at execute
 * time (`unknown-command`) instead of silently passing.
 */
const COMMAND_RETURNS: Record<string, unknown> = {
    [ids.CHAT_SESSION_CREATE_COMMAND]: 'session-created',
    [ids.CHAT_SESSION_SELECT_COMMAND]: undefined,
    [ids.CHAT_SESSION_DELETE_COMMAND]: undefined,
    [ids.CHAT_SESSION_RENAME_COMMAND]: undefined,
    [ids.CHAT_MESSAGE_SEND_COMMAND]: Promise.resolve(),
    [ids.CHAT_MESSAGE_CANCEL_COMMAND]: true,
    [ids.CHAT_MESSAGE_COPY_COMMAND]: undefined,
    [ids.CHAT_MESSAGE_FORK_COMMAND]: Promise.resolve('forked-session'),
    [ids.CHAT_MESSAGE_ROLE_COMMAND]: undefined,
    [ids.CHAT_MESSAGE_DELETE_COMMAND]: undefined,
    [ids.CHAT_MESSAGE_UPDATE_COMMAND]: undefined,
    [ids.CHAT_TURN_TOGGLE_COMMAND]: undefined,
    [ids.CHAT_SYSTEM_BEGIN_COMMAND]: undefined,
    [ids.CHAT_SYSTEM_SAVE_COMMAND]: Promise.resolve(),
    [ids.CHAT_SYSTEM_CANCEL_COMMAND]: undefined,
    [ids.CHAT_DRAFT_SET_COMMAND]: undefined,
    [ids.CHAT_MODEL_SET_COMMAND]: undefined,
    [ids.CHAT_AGENT_SET_COMMAND]: undefined,
    // T4 — the registry surfaces. The create ids answer with the new row's id (the
    // contract's `-> string`), and every handler below also mutates the cell the view
    // reads back, for the same reason `chat.draft.set` does.
    [ids.CHAT_AGENT_CREATE_COMMAND]: 'agent-1',
    [ids.CHAT_AGENT_SAVE_COMMAND]: undefined,
    [ids.CHAT_AGENT_DELETE_COMMAND]: undefined,
    [ids.CHAT_TOOL_CREATE_COMMAND]: 'tool-1',
    [ids.CHAT_TOOL_SAVE_COMMAND]: undefined,
    [ids.CHAT_TOOL_DELETE_COMMAND]: undefined,
    [ids.CHAT_AUTOSCROLL_TOGGLE_COMMAND]: true,
    [ids.CHAT_COMPOSER_FOCUS_COMMAND]: undefined,
    [ids.CHAT_VOICE_START_COMMAND]: undefined,
    [ids.CHAT_VOICE_STOP_COMMAND]: undefined,
    // T5 — the settings + skin commands, with the outputs the contract documents.
    [ids.CHAT_MODE_SET_COMMAND]: undefined,
    [ids.CHAT_PROVIDER_BASE_SET_COMMAND]: undefined,
    [ids.CHAT_NOTICE_DISMISS_COMMAND]: 0,
    [ids.UI_THEME_SET_COMMAND]: 'ink' as ids.DashboardTheme,
    [ids.UI_DENSITY_SET_COMMAND]: 'comfortable' as ids.DashboardDensity,
    [ids.UI_MOTION_SET_COMMAND]: 'full' as ids.DashboardMotion
};

/**
 * Insert-or-replace one entry by id, keeping the existing position (the same rule
 * `services/registries.ts:121-127` implements for the durable stores: re-saving a row
 * never reorders the registry, a new id is appended).
 */
const upsertById = <T extends { id: string }>(list: readonly T[], entry: T): readonly T[] => {
    const index = list.findIndex((candidate) => candidate.id === entry.id);
    if (index < 0) return Object.freeze([...list, entry]);
    const next = [...list];
    next[index] = entry;
    return Object.freeze(next);
};

/**
 * The harness's fresh-tool record. It mirrors `createToolDefinition`
 * (plugins/tools.ts: lowest free `tool-N`, coded, `DEFAULT_TOOL_SOURCE`) but is
 * written out here on purpose — the harness stays plugin-blind so a component test can
 * never depend on a plugin module (components/index.ts:9-11). The production
 * allocator is pinned by plugins/tools.test.ts. The source is non-empty because the
 * tool store's persisted-entry guard rejects `code: ''` (registries.ts:69).
 */
const createToolSeed = (existing: readonly ToolDefinition[]): ToolDefinition => {
    const used = new Set(existing.map((tool) => tool.id));
    let counter = 1;
    while (used.has(`tool-${counter}`)) counter += 1;
    return {
        id: `tool-${counter}`,
        name: 'New tool',
        native: false,
        language: 'javascript',
        code: '// New tool implementation\n'
    };
};

/**
 * Build a composed instance for one test. `seed` overrides only what the scenario
 * is about; everything else lands on the empty-surface default.
 */
export function createHarness(seed: HarnessSeed = {}): Harness {
    const values = { ...DEFAULTS, ...seed };
    const calls = new Map<string, unknown[]>();

    // The chat cells + commands + provider facade live in ONE plugin: the harness
    // is not modelling plugin boundaries, only the surface contract.
    const harnessPlugin: DashboardPlugin = {
        id: 'harness',
        setup(api) {
            api.state<readonly ConversationSummary[]>(ids.CHAT_SESSIONS_STATE, values.sessions);
            api.state<string | null>(ids.CHAT_ACTIVE_SESSION_STATE, values.activeSessionId);
            api.state<readonly ChatMessage[]>(ids.CHAT_TRANSCRIPT_STATE, values.transcript);
            api.state<readonly ids.ChatTurn[]>(ids.CHAT_TURNS_STATE, values.turns);
            api.state<ids.ChatStatus>(ids.CHAT_STATUS_STATE, values.status);
            api.state<string>(ids.CHAT_ERROR_STATE, values.error);
            // Handle kept for the two commands whose contract is "publish the value
            // into the cell the views read back". A constant stub would let a test
            // pass against behaviour the real plugin never produces: typing in the
            // composer must actually change `chat.draft`, and toggling the follow
            // switch must actually flip `chat.autoscroll`.
            const draftCell = api.state<string>(ids.CHAT_DRAFT_STATE, values.draft);
            // Handle kept (not just registered): `chat.autoscroll.toggle` must flip
            // the REAL cell, because the stage's follow gate reads it back.
            const autoscrollCell = api.state<boolean>(ids.CHAT_AUTOSCROLL_STATE, values.autoscroll);
            api.state<string>(ids.CHAT_MODEL_STATE, values.model);
            api.state<readonly string[]>(ids.CHAT_MODELS_STATE, values.models);
            // T4 handles: the agent + tool registries. Kept (not merely registered)
            // because six of the commands below are "mutate the registry AND the
            // selection a view reads back" — a constant stub would let AgentWorkspace
            // pass a test while its name field still displayed the old definition.
            const agentsCell = api.state<readonly AgentDefinition[]>(ids.CHAT_AGENTS_STATE, values.agents);
            const activeAgentCell = api.state<string | null>(ids.CHAT_ACTIVE_AGENT_STATE, values.activeAgentId);
            const agentCell = api.state<string>(ids.CHAT_AGENT_STATE, values.agent);
            const toolsCell = api.state<readonly ToolDefinition[]>(ids.CHAT_TOOLS_STATE, values.tools);
            const activeToolCell = api.state<string | null>(ids.CHAT_ACTIVE_TOOL_STATE, values.activeToolId);
            api.state<ids.ChatUsage | null>(ids.CHAT_USAGE_STATE, values.usage);
            api.state<ids.ChatPendingTurn | null>(ids.CHAT_PENDING_STATE, values.pending);
            api.state<string>(ids.CHAT_STREAMING_STATE, values.streaming);
            api.state<string>(ids.CHAT_SYSTEM_DRAFT_STATE, values.systemDraft);
            api.state<boolean>(ids.CHAT_EDITING_SYSTEM_STATE, values.editingSystem);
            api.state<number | null>(ids.CHAT_EDITING_INDEX_STATE, values.editingIndex);
            api.state<readonly number[]>(ids.CHAT_COLLAPSED_TURNS_STATE, values.collapsedTurns);
            api.state<boolean>(ids.CHAT_LISTENING_STATE, values.listening);
            // T4: `chat.agent.create` / `chat.tool.create` move the rail to their own
            // tab (plugins/agents.ts, plugins/tools.ts), so the handle is needed.
            const sidebarTabCell = api.state<ids.SidebarTab>(ids.CHAT_SIDEBAR_TAB_STATE, values.sidebarTab);
            api.state<boolean>(ids.CHAT_DRAWER_OPEN_STATE, values.drawerOpen);

            // ——— T5 cells —————————————————————————————————————————————————————
            // Cell HANDLES are kept (not just registrations) because five of the
            // commands below are "publish the value into the cell the view reads
            // back": a constant stub would let StationSettings pass a test while
            // showing a mode it never changed.
            const modeCell = api.state<ids.ChatMode>(ids.CHAT_MODE_STATE, values.mode);
            const providerBaseCell = api.state<string>(
                ids.CHAT_PROVIDER_BASE_STATE,
                values.providerBase
            );
            const themeCell = api.state<ids.DashboardTheme>(ids.UI_THEME_STATE, values.theme);
            const densityCell = api.state<ids.DashboardDensity>(
                ids.UI_DENSITY_STATE,
                values.density
            );
            const motionCell = api.state<ids.DashboardMotion>(ids.UI_MOTION_STATE, values.motion);
            // The notice feed. In the real graph this is a SERVICE whose value is a
            // state handle (plugins/notices.ts), never a `chat.*` state cell — every
            // `chat.*` cell belongs to the chat core. The state and service registries
            // are independent (packages/underload/dashboard/src/extensions/registries.ts),
            // so the harness registers the SAME id twice on purpose: as a cell, so a
            // test seeds and re-writes it through `write()`, and as the service the
            // view resolves. Same id, one observable, exactly the handle shape the
            // production service publishes.
            const noticesCell = api.state<readonly ids.ChatNotice[]>(
                ids.CHAT_NOTICES_SERVICE,
                values.notices
            );
            api.service<ids.ChatNoticeFeed>(ids.CHAT_NOTICES_SERVICE, noticesCell);

            // The speech facade, so a voice control rendered against this harness
            // resolves `chat.speech` instead of `unknown-service`. jsdom exposes no
            // Web Speech API, and the honest stub says so: `available()` is false and
            // `start()` rejects with the actionable message
            // (services/speech.ts:67-84). A component test that needs a live session
            // injects its own client through `createVoicePlugin({ speech })`.
            api.service<SpeechClient>(ids.CHAT_SPEECH_SERVICE, {
                available: async () => false,
                start: async () => {
                    throw new Error('Voice input is not available in this test environment.');
                }
            });

            // The provider facade is a Promise pair, index-aligned by contract
            // (`labels()` follows `catalog()`), and it never rejects here.
            api.service<ProviderLabelService>(ids.CHAT_PROVIDER_SERVICE, {
                catalog: async () => [...values.providerCatalog],
                labels: async () => [...values.providerLabels]
            });

            // The commands whose contract is "publish the input into the cell a view
            // reads back", i.e. everything the settings surface edits. A constant stub
            // for these would let a control pass a test while displaying a value it
            // never changed, so the harness mirrors the write the real plugin performs
            // (plugins/settings.ts, plugins/theme.ts). `chat.draft.set` and
            // `chat.autoscroll.toggle` are the pre-existing pair, handled below.
            const publishes = new Map<string, DashboardState<unknown>>([
                [ids.CHAT_MODE_SET_COMMAND, modeCell as unknown as DashboardState<unknown>],
                [ids.CHAT_PROVIDER_BASE_SET_COMMAND, providerBaseCell as unknown as DashboardState<unknown>],
                [ids.UI_THEME_SET_COMMAND, themeCell as unknown as DashboardState<unknown>],
                [ids.UI_DENSITY_SET_COMMAND, densityCell as unknown as DashboardState<unknown>],
                [ids.UI_MOTION_SET_COMMAND, motionCell as unknown as DashboardState<unknown>]
            ]);

            for (const [commandId, output] of Object.entries(COMMAND_RETURNS)) {
                // `<unknown, unknown>`: the harness is id-agnostic, so neither the
                // input nor the output is statically known here, and the core's
                // generic defaults (void) would reject the recorded payload.
                api.command<unknown, unknown>(commandId, (input) => {
                    const recorded = calls.get(commandId);
                    if (recorded === undefined) calls.set(commandId, [input]);
                    else recorded.push(input);
                    // The two commands whose contract is "publish the value into the
                    // cell the views read back". A constant stub would let a test
                    // pass against behaviour the real plugin never produces: typing
                    // must actually change `chat.draft`, and toggling the follow
                    // switch must actually flip `chat.autoscroll`.
                    if (commandId === ids.CHAT_AUTOSCROLL_TOGGLE_COMMAND) {
                        autoscrollCell.set(!autoscrollCell.get());
                        return autoscrollCell.get();
                    }
                    if (commandId === ids.CHAT_DRAFT_SET_COMMAND) {
                        draftCell.set(String(input ?? ''));
                        return undefined;
                    }
                    // The settings/skin pair above: the cell takes the input and the
                    // command answers with the settled value, as the contract says.
                    const target = publishes.get(commandId);
                    if (target !== undefined) {
                        target.set(input);
                        return target.get();
                    }
                    // `chat.notice.dismiss` mirrors plugins/notices.ts: an id removes
                    // one row, no input clears the strip, and the settled row count is
                    // the return value. Modelling it (rather than recording only) is
                    // what lets a strip test assert the row actually left the screen.
                    if (commandId === ids.CHAT_NOTICE_DISMISS_COMMAND) {
                        noticesCell.set(
                            input === undefined || input === null
                                ? []
                                : noticesCell.get().filter((row) => row.id !== input)
                        );
                        return noticesCell.get().length;
                    }
                    // T4 — the agent + tool registries. Each branch performs the same
                    // cell writes its production plugin performs (plugins/agents.ts,
                    // plugins/tools.ts), so a surface test asserts the whole loop the
                    // operator sees: keystroke -> save -> the field re-renders from the
                    // store. The agent id allocation is the production one
                    // (`createAgentDefinition`); the tool seed mirrors the plugin's
                    // `createToolDefinition`, which plugins/tools.test.ts pins.
                    if (commandId === ids.CHAT_AGENT_CREATE_COMMAND) {
                        const agent = createAgentDefinition([...agentsCell.get()]);
                        agentsCell.set(upsertById(agentsCell.get(), agent));
                        activeAgentCell.set(agent.id);
                        sidebarTabCell.set('agent');
                        return agent.id;
                    }
                    if (commandId === ids.CHAT_AGENT_SAVE_COMMAND) {
                        const agent = input as AgentDefinition;
                        if (agent && typeof agent.id === 'string' && agent.id !== '') {
                            agentsCell.set(upsertById(agentsCell.get(), agent));
                        }
                        return undefined;
                    }
                    if (commandId === ids.CHAT_AGENT_DELETE_COMMAND) {
                        const id = String(input ?? '');
                        agentsCell.set(Object.freeze(agentsCell.get().filter((entry) => entry.id !== id)));
                        if (activeAgentCell.get() === id) activeAgentCell.set(null);
                        if (agentCell.get() === id) agentCell.set('');
                        return undefined;
                    }
                    if (commandId === ids.CHAT_AGENT_SET_COMMAND) {
                        agentCell.set(String(input ?? ''));
                        return undefined;
                    }
                    if (commandId === ids.CHAT_TOOL_CREATE_COMMAND) {
                        const tool = createToolSeed(toolsCell.get());
                        toolsCell.set(upsertById(toolsCell.get(), tool));
                        activeToolCell.set(tool.id);
                        sidebarTabCell.set('tool');
                        return tool.id;
                    }
                    if (commandId === ids.CHAT_TOOL_SAVE_COMMAND) {
                        const tool = input as ToolDefinition;
                        if (tool && typeof tool.id === 'string' && tool.id !== '') {
                            toolsCell.set(upsertById(toolsCell.get(), tool));
                        }
                        return undefined;
                    }
                    if (commandId === ids.CHAT_TOOL_DELETE_COMMAND) {
                        // A native row is runtime-provided: removing it leaves it
                        // listed, so its selection stays (registries.ts:43-50).
                        const id = String(input ?? '');
                        const kept = Object.freeze(
                            toolsCell.get().filter((entry) => entry.id !== id || entry.native)
                        );
                        toolsCell.set(kept);
                        if (activeToolCell.get() === id && !kept.some((entry) => entry.id === id)) {
                            activeToolCell.set(null);
                        }
                        return undefined;
                    }
                    return output;
                });
            }
        }
    };

    const instance = dashboard({ plugins: [harnessPlugin] });

    return {
        instance,
        calls,
        callsOf: (commandId: string) => calls.get(commandId) ?? [],
        read: <T,>(stateId: string) => instance.state<T>(stateId).get(),
        write: <T,>(stateId: string, value: T) => instance.state<T>(stateId).set(value)
    };
}

/** A `.station` root so the components render inside the skin they are styled for. */
export function renderWithHarness(ui: ReactElement, seed: HarnessSeed = {}): RenderResult & Harness {
    const harness = createHarness(seed);
    const result = render(
        <WorkbenchProvider instance={harness.instance}>
            <div className="station" data-theme="ink" data-density="comfortable" data-motion="full">
                {ui}
            </div>
        </WorkbenchProvider>
    );
    return { ...result, ...harness };
}

/** One conversation summary, so a scenario reads as data rather than a literal. */
export const makeSession = (
    conversationId: string,
    title: string,
    overrides: Partial<ConversationSummary> = {}
): ConversationSummary => ({
    conversationId,
    title,
    model: 'modal/glm-5.3-flash',
    status: 'complete',
    messageCount: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
});

/**
 * One notice-strip row (T5). Defaults are what `chat.notices` emits for an event-fed
 * row: tone 'info' and a wall-clock instant, so a test only names the id and text its
 * assertions are about.
 */
export const makeNotice = (
    id: number,
    message: string,
    overrides: Partial<ids.ChatNotice> = {}
): ids.ChatNotice => ({
    id,
    message,
    tone: 'info',
    at: 1767729600000,
    ...overrides
});

/** One turn of the derived view model, with the inert defaults filled in. */
export const makeTurn = (
    index: number,
    role: ids.ChatRole,
    content: string,
    overrides: Partial<ids.ChatTurn> = {}
): ids.ChatTurn => ({
    index,
    message: { role, content, ...(role === 'assistant' ? { model: 'vultr/coder' } : {}) },
    role,
    collapsed: false,
    editing: false,
    model: role === 'assistant' ? 'vultr/coder' : '',
    ...overrides
});

/**
 * Stub `window.matchMedia` for the chat core's viewport seam
 * (`src/dashboard/viewport.ts`, which asks `(min-width: 900px)`). jsdom implements
 * NO matchMedia at all, and both gates must be exercisable: the composer's
 * Enter-to-send rule (desktop only) and the sidebar's off-canvas drawer (mobile).
 *
 * `addEventListener` is present because the seam subscribes through it; the
 * returned function restores the previous global.
 */
export function stubViewport(mode: 'desktop' | 'mobile'): () => void {
    const previous = (window as Window & { matchMedia?: unknown }).matchMedia;
    const desktop = mode === 'desktop';
    const listeners = new Set<() => void>();
    const matchMedia = ((query: string) => {
        // Desktop answers the seam's (min-width: 900px) query truthfully and any
        // (max-width: ...) probe falsely — and the other way round on a phone.
        // Anything else answers "no preference".
        const matches = query.includes('min-width') ? desktop : query.includes('max-width') ? !desktop : false;
        return {
            matches,
            media: query,
            addEventListener: (_type: string, cb: () => void) => {
                listeners.add(cb);
            },
            removeEventListener: (_type: string, cb: () => void) => {
                listeners.delete(cb);
            },
            addListener: (cb: () => void) => listeners.add(cb),
            removeListener: (cb: () => void) => listeners.delete(cb)
        };
    }) as unknown as typeof window.matchMedia;
    (window as unknown as { matchMedia: typeof window.matchMedia }).matchMedia = matchMedia;

    return () => {
        (window as unknown as { matchMedia: typeof window.matchMedia }).matchMedia = previous as typeof window.matchMedia;
        listeners.clear();
    };
}
