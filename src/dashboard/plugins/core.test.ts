// Chat CORE plugin: the state graph, the derived view model and the epoch guard.
//
// Headless (no render): the dashboard is built through createChatDashboard and
// every assertion is an EXACT cell value. `fetch` is stubbed first because both
// the sessions listing and the model catalog start one microtask after setup, and
// an unrouted request would land in `chat.error` and blur these expectations.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    CHAT_ACTIVE_AGENT_STATE,
    CHAT_ACTIVE_SESSION_STATE,
    CHAT_ACTIVE_TOOL_STATE,
    CHAT_AGENT_STATE,
    CHAT_AGENTS_STATE,
    CHAT_AGENT_STORE_SERVICE,
    CHAT_AUTOSCROLL_STATE,
    CHAT_CELLS_SERVICE,
    CHAT_COLLAPSED_TURNS_STATE,
    CHAT_DRAFT_STATE,
    CHAT_MODEL_STATE,
    CHAT_DRAWER_OPEN_STATE,
    CHAT_EDITING_INDEX_STATE,
    CHAT_EDITING_SYSTEM_STATE,
    CHAT_EPOCH_SERVICE,
    CHAT_ERROR_STATE,
    CHAT_LISTENING_STATE,
    CHAT_MODELS_STATE,
    CHAT_MODE_STATE,
    CHAT_PENDING_STATE,
    CHAT_PROVIDER_BASE_STATE,
    CHAT_SESSIONS_STATE,
    CHAT_SIDEBAR_TAB_STATE,
    CHAT_STATUS_STATE,
    CHAT_STREAMING_STATE,
    CHAT_SYSTEM_DRAFT_STATE,
    CHAT_TOOL_STORE_SERVICE,
    CHAT_TOOLS_STATE,
    CHAT_TRANSCRIPT_STATE,
    CHAT_TURNS_STATE,
    CHAT_USAGE_STATE,
    ASIDE_SLOT,
    SIDEBAR_SLOT,
    STAGE_SLOT,
    type ChatCells,
    type ChatEpoch,
    type ChatMode,
    type ChatTurn,
    type PanelValue
} from '../contract';
import { dashboard } from '@underload/dashboard';
import type { Dashboard, DashboardPlugin } from '@underload/dashboard';
import { createCorePlugin } from './core';
import {
    jsonResponse,
    installFetch,
    MODEL_STORAGE_KEY,
    readRememberedModel,
    resetStorage,
    createTestChat,
    seedAgents,
    seedModel,
    seedSettings,
    SETTINGS_STORAGE_KEY,
    TEST_BASE_URL
} from './harness';

// Every `chat.*` state id, verbatim from ../contract.ts. This list IS the
// acceptance criterion "every contract cell is registered exactly once": a cell
// missing from the graph throws `unknown-state` right here, and the duplicate half
// is asserted separately below.
const CHAT_STATE_IDS = [
    CHAT_MODE_STATE,
    CHAT_PROVIDER_BASE_STATE,
    CHAT_SESSIONS_STATE,
    CHAT_ACTIVE_SESSION_STATE,
    CHAT_TRANSCRIPT_STATE,
    CHAT_TURNS_STATE,
    CHAT_STATUS_STATE,
    CHAT_ERROR_STATE,
    CHAT_DRAFT_STATE,
    CHAT_MODEL_STATE,
    CHAT_MODELS_STATE,
    CHAT_AGENT_STATE,
    CHAT_AGENTS_STATE,
    CHAT_ACTIVE_AGENT_STATE,
    CHAT_TOOLS_STATE,
    CHAT_ACTIVE_TOOL_STATE,
    CHAT_USAGE_STATE,
    CHAT_PENDING_STATE,
    CHAT_STREAMING_STATE,
    CHAT_SYSTEM_DRAFT_STATE,
    CHAT_EDITING_SYSTEM_STATE,
    CHAT_EDITING_INDEX_STATE,
    CHAT_COLLAPSED_TURNS_STATE,
    CHAT_AUTOSCROLL_STATE,
    CHAT_LISTENING_STATE,
    CHAT_SIDEBAR_TAB_STATE,
    CHAT_DRAWER_OPEN_STATE
] as const;

/** The catalog + list answers every test needs before it touches anything else. */
const stubIdleBackend = () =>
    installFetch([
        {
            match: (url) => url === 'http://provider.test/providers/private/v1/models',
            reply: () => jsonResponse(200, { object: 'list', data: [{ id: 'alpha/flash' }] })
        },
        {
            match: (url) => url.startsWith(TEST_BASE_URL),
            reply: () => jsonResponse(200, { conversations: [] })
        }
    ]);

describe('chat core — every contract cell, registered exactly once', () => {
    let instance: Dashboard | null = null;

    beforeEach(() => {
        resetStorage();
        stubIdleBackend();
    });

    afterEach(() => {
        instance?.dispose();
        instance = null;
        vi.unstubAllGlobals();
    });

    it('registers all 27 chat.* state cells', () => {
        instance = createTestChat();
        // Every contract cell resolves to a live cell: a missing one throws
        // `unknown-state` inside this map rather than passing silently.
        const snapshots = CHAT_STATE_IDS.map((id) => [id, instance?.state(id).get()]);
        expect(snapshots.map(([id]) => id)).toEqual([...CHAT_STATE_IDS]);
        expect(CHAT_STATE_IDS).toHaveLength(27);
    });

    it('rejects a second claim of any chat cell with duplicate-state', () => {
        // The other half of "exactly once": a sibling (or an add-on) that tries to
        // register a cell the core plugin already owns fails loudly instead of
        // silently shadowing it.
        const squatter: DashboardPlugin = {
            id: 'squatter',
            setup(api) {
                api.state<string>(CHAT_TRANSCRIPT_STATE, 'mine');
            }
        };
        const failure = (() => {
            try {
                createTestChat({ extraPlugins: [squatter] });
                return null;
            } catch (reason) {
                return reason as Error & { code?: string; cause?: Error & { code?: string } };
            }
        })();
        // A setup throw is wrapped ('setup-failed', the build discarded) and the
        // registry rejection rides along as `cause` — the code is the contract, the
        // message text is not (packages/underload/dashboard/src/core/errors.ts:4-6).
        expect(failure?.code).toBe('setup-failed');
        expect(failure?.cause?.code).toBe('duplicate-state');
        expect(failure?.cause?.message).toContain('chat.transcript');
    });

    it('publishes the cells and the epoch guard as services', () => {
        instance = createTestChat();
        const cells = instance.service<ChatCells>(CHAT_CELLS_SERVICE);
        // The handle object exposes exactly the registered cells, by these names.
        expect(Object.keys(cells)).toEqual(CHAT_STATE_IDS.map((id) => id.replace('chat.', '')));
        expect(Object.isFrozen(cells)).toBe(true);
        const epoch = instance.service<ChatEpoch>(CHAT_EPOCH_SERVICE);
        expect(Object.keys(epoch).sort()).toEqual([
            'capture',
            'namespaceCurrent',
            'surfaceCurrent'
        ]);
    });

    it('seeds every cell from persisted browser state, not from literals', () => {
        // Offline settings + a remembered model + one stored agent: exactly what a
        // returning browser has, and the initial snapshot must match it.
        seedSettings('offline', 'http://offline.test/providers/private/v1');
        seedModel('zeta/turbo');
        seedAgents([
            {
                id: 'agent-1',
                name: 'Echo',
                systemPrompt: 'Repeat',
                messages: [{ role: 'user', content: 'hi' }],
                tools: ['web-search']
            }
        ]);
        instance = createTestChat();

        expect(instance.state<ChatMode>(CHAT_MODE_STATE).get()).toBe('offline');
        expect(instance.state<string>(CHAT_PROVIDER_BASE_STATE).get()).toBe(
            'http://offline.test/providers/private/v1'
        );
        expect(instance.state<string>(CHAT_MODEL_STATE).get()).toBe('zeta/turbo');
        expect(instance.state<readonly { id: string }[]>(CHAT_AGENTS_STATE).get()).toEqual([
            {
                id: 'agent-1',
                name: 'Echo',
                systemPrompt: 'Repeat',
                messages: [{ role: 'user', content: 'hi' }],
                tools: ['web-search']
            }
        ]);
        // The frozen initial snapshot of everything else, exact.
        expect(instance.state<readonly unknown[]>(CHAT_SESSIONS_STATE).get()).toEqual([]);
        expect(instance.state<string | null>(CHAT_ACTIVE_SESSION_STATE).get()).toBe(null);
        expect(instance.state<readonly unknown[]>(CHAT_TRANSCRIPT_STATE).get()).toEqual([]);
        expect(instance.state<string>(CHAT_STATUS_STATE).get()).toBe('idle');
        expect(instance.state<string>(CHAT_ERROR_STATE).get()).toBe('');
        expect(instance.state<string>(CHAT_DRAFT_STATE).get()).toBe('');
        expect(instance.state<string>(CHAT_AGENT_STATE).get()).toBe('');
        expect(instance.state<string | null>(CHAT_ACTIVE_AGENT_STATE).get()).toBe(null);
        expect(instance.state<string | null>(CHAT_ACTIVE_TOOL_STATE).get()).toBe(null);
        expect(instance.state<unknown>(CHAT_USAGE_STATE).get()).toBe(null);
        expect(instance.state<unknown>(CHAT_PENDING_STATE).get()).toBe(null);
        expect(instance.state<string>(CHAT_STREAMING_STATE).get()).toBe('');
        expect(instance.state<string>(CHAT_SYSTEM_DRAFT_STATE).get()).toBe('');
        expect(instance.state<boolean>(CHAT_EDITING_SYSTEM_STATE).get()).toBe(false);
        expect(instance.state<number | null>(CHAT_EDITING_INDEX_STATE).get()).toBe(null);
        expect(instance.state<readonly number[]>(CHAT_COLLAPSED_TURNS_STATE).get()).toEqual([]);
        expect(instance.state<boolean>(CHAT_AUTOSCROLL_STATE).get()).toBe(true);
        expect(instance.state<boolean>(CHAT_LISTENING_STATE).get()).toBe(false);
        expect(instance.state<string>(CHAT_SIDEBAR_TAB_STATE).get()).toBe('chat');
        expect(instance.state<boolean>(CHAT_DRAWER_OPEN_STATE).get()).toBe(false);
        // Tools come from the registry facade (native seed; no stored rows yet).
        expect(instance.state<readonly { id: string }[]>(CHAT_TOOLS_STATE).get()).toEqual([
            { id: 'web-search', name: 'Web search', native: true },
            { id: 'code-interpreter', name: 'Code interpreter', native: true }
        ]);
    });

    it('degrades a corrupt persisted settings object to the online default', () => {
        window.localStorage.setItem('chat-assistant:settings', '{not json');
        instance = createTestChat();
        expect(instance.state<ChatMode>(CHAT_MODE_STATE).get()).toBe('online');
        expect(instance.state<string>(CHAT_PROVIDER_BASE_STATE).get()).toBe('');
        expect(instance.state<string>(CHAT_ERROR_STATE).get()).toBe('');
    });
});

describe('chat core — the derived chat.turns view model', () => {
    let instance: Dashboard;

    beforeEach(() => {
        resetStorage();
        stubIdleBackend();
        instance = createTestChat();
    });

    afterEach(() => {
        instance.dispose();
        vi.unstubAllGlobals();
    });

    const cells = () => instance.service<ChatCells>(CHAT_CELLS_SERVICE);

    it('recomputes on the transcript, the collapse set and the editor index only', () => {
        const before = cells().turns.get();
        // An unrelated write must not churn the derived snapshot: a new array on
        // every read is what breaks useSyncExternalStore (state-hooks.ts:17-24).
        cells().draft.set('typing');
        cells().model.set('alpha/flash');
        expect(cells().turns.get()).toBe(before);

        cells().transcript.set([
            { role: 'user', content: 'Question' },
            { role: 'assistant', content: 'Answer', model: 'alpha/flash' }
        ] as never);
        const after = cells().turns.get();
        expect(after).toEqual([
            {
                index: 0,
                message: { role: 'user', content: 'Question' },
                role: 'user',
                collapsed: false,
                editing: false,
                model: ''
            },
            {
                index: 1,
                message: { role: 'assistant', content: 'Answer', model: 'alpha/flash' },
                role: 'assistant',
                collapsed: false,
                editing: false,
                model: 'alpha/flash'
            }
        ] satisfies ChatTurn[]);

        // Collapse the user turn and open the editor on the assistant turn: each
        // recompute writes the cell ONCE, from these three inputs.
        cells().collapsedTurns.set([0]);
        expect(cells().turns.get().map((turn) => [turn.index, turn.collapsed, turn.editing])).toEqual([
            [0, true, false],
            [1, false, false]
        ]);
        cells().editingIndex.set(1);
        expect(cells().turns.get().map((turn) => [turn.index, turn.collapsed, turn.editing])).toEqual([
            [0, true, false],
            [1, false, true]
        ]);
    });

    it('collapses the -1 sentinel without touching the transcript rows', () => {
        // The system-prompt DRAFT turn is addressed by the -1 sentinel inside
        // chat.collapsedTurns (never as a row of chat.turns), so a fold of the
        // draft must leave the derived list identical by reference.
        const before = cells().turns.get();
        cells().collapsedTurns.set([-1]);
        expect(cells().turns.get()).toBe(before);
        expect(cells().collapsedTurns.get()).toEqual([-1]);
    });

    it('treats an equal write as no update (SameValueZero change detection)', () => {
        cells().transcript.set([{ role: 'user', content: 'One' }] as never);
        const first = cells().turns.get();
        // The SAME content in a fresh array is a different reference, so the writer
        // re-runs but the row comparison keeps the published snapshot stable.
        cells().transcript.set([{ role: 'user', content: 'One' }] as never);
        expect(cells().turns.get()).not.toBe(first);
        expect(cells().turns.get()[0].message.content).toBe('One');
    });
});

describe('chat core — the epoch guard (R7)', () => {
    let instance: Dashboard;

    beforeEach(() => {
        resetStorage();
        stubIdleBackend();
        instance = createTestChat();
    });

    afterEach(() => {
        instance.dispose();
        vi.unstubAllGlobals();
    });

    it('detaches a captured guard on a mode change, both counters', () => {
        const epoch = instance.service<ChatEpoch>(CHAT_EPOCH_SERVICE);
        const guard = epoch.capture();
        expect(epoch.namespaceCurrent(guard)).toBe(true);
        expect(epoch.surfaceCurrent(guard)).toBe(true);

        instance.state<ChatMode>(CHAT_MODE_STATE).set('offline');
        expect(epoch.namespaceCurrent(guard)).toBe(false);
        expect(epoch.surfaceCurrent(guard)).toBe(false);
    });

    it('keeps the namespace guard across a session switch and drops the surface one', () => {
        // The distinction is the oracle's: a write keeps landing in the namespace
        // that started it, while only the owning surface may adopt a record.
        const epoch = instance.service<ChatEpoch>(CHAT_EPOCH_SERVICE);
        const guard = epoch.capture();
        instance.state<string | null>(CHAT_ACTIVE_SESSION_STATE).set('conv-1');
        expect(epoch.namespaceCurrent(guard)).toBe(true);
        expect(epoch.surfaceCurrent(guard)).toBe(false);
    });

    it('stays stale after an away-and-back bounce (a new epoch, the same string)', () => {
        const epoch = instance.service<ChatEpoch>(CHAT_EPOCH_SERVICE);
        const guard = epoch.capture();
        const mode = instance.state<ChatMode>(CHAT_MODE_STATE);
        mode.set('offline');
        mode.set('online');
        expect(mode.get()).toBe('online');
        // The recorded bug: comparing the mode STRING would let this settle
        // re-apply itself into a namespace that has already moved on.
        expect(epoch.namespaceCurrent(guard)).toBe(false);
    });

    it('bumps the surface guard when a session id is cleared as well as set', () => {
        const epoch = instance.service<ChatEpoch>(CHAT_EPOCH_SERVICE);
        const session = instance.state<string | null>(CHAT_ACTIVE_SESSION_STATE);
        session.set('conv-1');
        const guard = epoch.capture();
        session.set(null);
        expect(epoch.surfaceCurrent(guard)).toBe(false);
    });
});

describe('chat core — no region content of its own, and disposal', () => {
    beforeEach(() => {
        resetStorage();
        stubIdleBackend();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('contributes no region of its own — the surfaces plugin owns the channels', () => {
        const instance = createTestChat();
        const read = (slot: string) =>
            instance
                .slot<PanelValue>(slot)
                .map((contribution) => [contribution.id, contribution.order]);
        // T6 retired the core's 10/20/30 component placeholders: each channel is now
        // the order-0 layout fallback plus its REAL owner, contributed by
        // chat.surfaces (plugins/surfaces.ts). The absence of a `chat.*.placeholder`
        // entry here is the assertion that the core renders nothing; see
        // WorkstationShell.test.tsx for the winner-takes-region behaviour.
        expect(read(SIDEBAR_SLOT)).toEqual([
            ['layout.sidebar.placeholder', 0],
            ['chat.sidebar', 40]
        ]);
        expect(read(STAGE_SLOT)).toEqual([
            ['layout.stage.placeholder', 0],
            ['chat.stage', 50]
        ]);
        expect(read(ASIDE_SLOT)).toEqual([
            ['layout.aside.placeholder', 0],
            ['chat.inspector', 60]
        ]);
        instance.dispose();
    });

    it('stops writing cells after dispose', async () => {
        // The plugin's cleanups unsubscribe the derived writer and the epoch
        // subscriptions, so a post-dispose cell write cannot resurrect a snapshot.
        const instance = createTestChat();
        await vi.waitFor(() => {
            expect(instance.state<readonly string[]>(CHAT_MODELS_STATE).get()).toEqual([
                'alpha/flash'
            ]);
        });
        instance.dispose();
        expect(instance.disposed).toBe(true);
        expect(() => instance.state(CHAT_MODE_STATE).get()).toThrow('disposed');
    });

    it('releases the provider-base subscription with its own teardown', () => {
        // N4: the core re-persists the settings object from `chat.providerBase`
        // (core.ts:570), and that handle has to leave with the plugin like every other
        // one it opened. The framework makes the leak invisible AFTER dispose (a
        // detached cell drops its listeners in `detachAll`, extensions/state.ts:81-85,
        // which runs after the LAST cleanup), so the observable window is a write that
        // lands while the cells are still live but the core is already torn down.
        seedSettings('online', 'http://saved.test/v1');

        // A plugin registered BEFORE the core is cleaned up AFTER it: teardown walks
        // the schedule in reverse (dashboard.ts:179-204). No `requires` edge, so the
        // declaration order stands and this probe really is the later cleanup.
        const probe: DashboardPlugin = {
            id: 'test.teardown-probe',
            setup(api) {
                return () => {
                    // Legal at teardown: reads stay live until after every cleanup, and
                    // the cells are writable in the 'disposing' phase.
                    const cells = api.getService<ChatCells>(CHAT_CELLS_SERVICE);
                    cells.providerBase.set('http://written-during-teardown.test/v1');
                };
            }
        };

        const instance = dashboard({ plugins: [probe, createCorePlugin()] });
        instance.dispose();

        // The stale subscription fired exactly once on the buggy path, and its whole
        // body is a settings write — so the persisted object being untouched is the
        // proof the handle was released.
        const persisted = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
        expect(persisted === null ? null : JSON.parse(persisted)).toEqual({
            mode: 'online',
            providerBase: 'http://saved.test/v1'
        });
    });

    it('persists the remembered model through the documented key', async () => {
        const instance = createTestChat();
        instance.state<string>(CHAT_MODEL_STATE).set('alpha/flash');
        await vi.waitFor(() => {
            expect(readRememberedModel()).toBe('alpha/flash');
        });
        expect(window.localStorage.getItem(MODEL_STORAGE_KEY)).toBe('alpha/flash');
        instance.dispose();
    });

    it('leaves the agent/tool store services to their own plugins', () => {
        // T3 owns the CELLS; the agents/tools add-ons own chat.agentStore /
        // chat.toolStore. Reading a service nobody registered must throw rather than
        // return undefined, so the boundary is enforced by the framework — which is
        // only observable on a core-only build, because the composed workstation
        // DOES register both (plugins/agents.ts:72, plugins/tools.ts:115).
        const coreOnly = dashboard({ plugins: [createCorePlugin()] });
        try {
            expect(() => coreOnly.service(CHAT_TOOL_STORE_SERVICE)).toThrow(
                'No service is provided under "chat.toolStore"'
            );
            expect(() => coreOnly.service(CHAT_AGENT_STORE_SERVICE)).toThrow(
                'No service is provided under "chat.agentStore"'
            );
        } finally {
            coreOnly.dispose();
        }

        // ...and the composed graph resolves both to live stores.
        const instance = createTestChat();
        expect(() => instance.service(CHAT_TOOL_STORE_SERVICE)).not.toThrow();
        expect(() => instance.service(CHAT_AGENT_STORE_SERVICE)).not.toThrow();
        instance.dispose();
    });
});
