// Chat AGENTS plugin tests: the client-side agent registry.
//
// Headless, no render: the real composition (createTestChat -> createChatDashboard)
// with the agents/tools plugins appended through the documented add-on seam, jsdom's
// own localStorage standing in for the browser (cleared before every case, so each
// test starts from a known registry), and a catch-all `fetch` double so the sessions
// plugin's mount listing never reaches the network and never writes `chat.error`.
//
// Every assertion is an EXACT value: the full AgentDefinition objects in the cell,
// the parsed JSON actually sitting under `chat-assistant:agents`, the two selection
// cells and the composer's agent prefix. The storage read is the point of the file —
// the cell is only trustworthy as a projection of the store (plugins/agents.ts:26-31).
//
// WHY THE PLUGINS ARE APPENDED, NOT ASSUMED (see `REGISTRIES_IN_COMPOSITION` below):
// composition.ts is owned by the task that finalises the graph. Until it registers
// these two plugins, the test supplies them through `extraPlugins`; once it does, the
// seam must stay EMPTY, because a second registration of `chat.agent.create` throws
// `duplicate-command` and discards the whole dashboard
// (packages/underload/dashboard/src/dashboard.ts:234-244). The probe reads the
// `chat.agentStore` SERVICE — a service read has no effect on state or storage.
// T6 ANSWERED IT: plugins/extras.ts registers both registries, so the probe is true
// and `buildChat()` composes the shipped graph unchanged. The probe (and the import
// of both service ids it needs) stays as the guard for a variant composition that
// drops them again.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dashboard } from '@underload/dashboard';
import type { AgentDefinition } from '../../agents';
import { createChatDashboard } from '../composition';
import {
    CHAT_ACTIVE_AGENT_STATE,
    CHAT_AGENT_CREATE_COMMAND,
    CHAT_AGENT_DELETE_COMMAND,
    CHAT_AGENT_SAVE_COMMAND,
    CHAT_AGENT_SET_COMMAND,
    CHAT_AGENT_STATE,
    CHAT_AGENT_STORE_SERVICE,
    CHAT_AGENTS_STATE,
    CHAT_ERROR_STATE,
    CHAT_SIDEBAR_TAB_STATE,
    CHAT_SESSIONS_STATE,
    CHAT_STATUS_STATE,
    CHAT_TOOL_STORE_SERVICE,
    type ChatSession
} from '../contract';
import { createAgentsPlugin } from './agents';
import { createToolsPlugin } from './tools';
import {
    AGENTS_STORAGE_KEY,
    createTestChat,
    installFetch,
    jsonResponse,
    resetStorage,
    seedAgents,
    TEST_BASE_URL,
    TEST_PROVIDER_URL,
    type FetchDouble
} from './harness';

/** Reads the persisted registry back exactly as the agents module wrote it. */
const readStored = (): unknown[] => {
    const raw = window.localStorage.getItem(AGENTS_STORAGE_KEY);
    return raw === null ? [] : (JSON.parse(raw) as unknown[]);
};

/** An agent definition spelled out in full, so a test never asserts a partial row. */
const agentFixture = (
    id: string,
    name: string,
    overrides: Partial<AgentDefinition> = {}
): AgentDefinition => ({
    id,
    name,
    systemPrompt: '',
    messages: [],
    tools: [],
    ...overrides
});

/**
 * Does the shipped composition already register the registries? Probed once, at
 * module scope, against the same origins `createTestChat` uses.
 */
const REGISTRIES_IN_COMPOSITION = (() => {
    const probe = createChatDashboard({ baseUrl: TEST_BASE_URL, providerUrl: TEST_PROVIDER_URL });
    try {
        probe.service<unknown>(CHAT_AGENT_STORE_SERVICE);
        probe.service<unknown>(CHAT_TOOL_STORE_SERVICE);
        return true;
    } catch {
        return false;
    } finally {
        probe.dispose();
    }
})();

/** The catalog + storage doubles every case installs (see the header note). */
let network: FetchDouble | null = null;
const stubNetwork = () => {
    network = installFetch([
        {
            match: (url) => url.includes('/models'),
            reply: () => jsonResponse(200, { object: 'list', data: [] })
        },
        {
            match: () => true,
            reply: () => jsonResponse(200, { conversations: [] })
        }
    ]);
    return network;
};

/** Build the dashboard under test, appending the plugins only when needed. */
const buildChat = (): Dashboard =>
    createTestChat(
        REGISTRIES_IN_COMPOSITION
            ? {}
            : { extraPlugins: [createAgentsPlugin(), createToolsPlugin()] }
    );

/**
 * Wait for the sessions plugin's mount listing to settle. `chat.status` is that
 * listing's busy label (plugins/sessions.ts:131, :158), so a test that asserts the
 * registry flows never take a busy slot has to establish the idle baseline first.
 * The listing is deferred one microtask (plugins/sessions.ts:354), so "idle" only
 * means anything once the first request has actually been issued — waiting for the
 * double's call log is what makes the baseline real rather than a pre-flight glance.
 */
const settleListing = async (dashboard: Dashboard): Promise<void> => {
    await vi.waitFor(() => {
        expect(network === null ? 0 : network.callsFor(TEST_BASE_URL).length).toBeGreaterThan(0);
    });
    await vi.waitFor(() => {
        expect(dashboard.state<string>(CHAT_STATUS_STATE).get()).toBe('idle');
    });
};

describe('chat agents — registry adoption', () => {
    let instance: Dashboard | null = null;

    beforeEach(() => {
        resetStorage();
        stubNetwork();
    });

    afterEach(() => {
        instance?.dispose();
        instance = null;
        vi.unstubAllGlobals();
    });

    it('adopts the persisted registry into chat.agents on setup', async () => {
        seedAgents([
            agentFixture('agent-1', 'Scout', {
                systemPrompt: 'You search first.',
                messages: [{ role: 'user', content: 'Hello' }],
                tools: ['web-search']
            })
        ]);
        instance = buildChat();

        expect(instance.state<readonly AgentDefinition[]>(CHAT_AGENTS_STATE).get()).toEqual([
            {
                id: 'agent-1',
                name: 'Scout',
                systemPrompt: 'You search first.',
                messages: [{ role: 'user', content: 'Hello' }],
                tools: ['web-search']
            }
        ]);
        // A registry read is a synchronous localStorage read: no banner, and the rail
        // still starts on the Chat tab. (`chat.status` gets its own check below, once
        // the sessions plugin's background listing has settled.)
        await settleListing(instance);
        expect(instance.state<string>(CHAT_ERROR_STATE).get()).toBe('');
        expect(instance.state<'chat' | 'agent' | 'tool' | 'settings'>(CHAT_SIDEBAR_TAB_STATE).get()).toBe('chat');
    });

    it('normalizes a legacy row that carries no message preset', () => {
        // Definitions written before agents carried `messages` load with an empty
        // preset, so no consumer has to branch on the field (src/agents:96-123).
        window.localStorage.setItem(
            AGENTS_STORAGE_KEY,
            JSON.stringify([{ id: 'agent-9', name: 'Legacy', systemPrompt: 'p', tools: ['code-interpreter'] }])
        );
        instance = buildChat();

        expect(instance.state<readonly AgentDefinition[]>(CHAT_AGENTS_STATE).get()).toEqual([
            {
                id: 'agent-9',
                name: 'Legacy',
                systemPrompt: 'p',
                messages: [],
                tools: ['code-interpreter']
            }
        ]);
    });

    it('degrades a corrupt registry to an empty list instead of failing the dashboard', () => {
        window.localStorage.setItem(AGENTS_STORAGE_KEY, '{"not":"an array"}');
        instance = buildChat();

        // The registry degrades (src/agents:110-127) and the dashboard still boots:
        // the sibling cell is intact, which is what "never a thrown error" means here.
        expect(instance.state<readonly AgentDefinition[]>(CHAT_AGENTS_STATE).get()).toEqual([]);
        expect(instance.state<readonly ChatSession[]>(CHAT_SESSIONS_STATE).get()).toEqual([]);
    });
});

describe('chat agents — create', () => {
    let instance: Dashboard | null = null;

    beforeEach(() => {
        resetStorage();
        stubNetwork();
    });

    afterEach(() => {
        instance?.dispose();
        instance = null;
        vi.unstubAllGlobals();
    });

    it('creates a fresh definition, opens it and moves the rail to the Agent tab', async () => {
        instance = buildChat();
        await settleListing(instance);

        const id = await instance.execute<void, string>(CHAT_AGENT_CREATE_COMMAND);

        expect(id).toBe('agent-1');
        const created = agentFixture('agent-1', 'New agent');
        expect(instance.state<readonly AgentDefinition[]>(CHAT_AGENTS_STATE).get()).toEqual([created]);
        // The new row is the open one, and the rail shows the registry it belongs to
        // (the oracle's `startNewAgent`, ChatAssistantApp.tsx:3445-3450).
        expect(instance.state<string | null>(CHAT_ACTIVE_AGENT_STATE).get()).toBe('agent-1');
        expect(instance.state<'chat' | 'agent' | 'tool' | 'settings'>(CHAT_SIDEBAR_TAB_STATE).get()).toBe('agent');
        expect(readStored()).toEqual([created]);
        // No conversation state is touched, and the flow takes no busy slot: New agent
        // is not New chat (:3443-3444), and a localStorage write is not a request.
        expect(instance.state<string>(CHAT_STATUS_STATE).get()).toBe('idle');
        expect(instance.state<string>(CHAT_ERROR_STATE).get()).toBe('');
    });

    it('allocates the lowest free id, and a second press lands on the next one', async () => {
        // agent-1 and agent-3 exist, so the new row is agent-2 (src/agents:138-146) —
        // the rule that keeps row testids stable across deletions.
        seedAgents([agentFixture('agent-1', 'First'), agentFixture('agent-3', 'Third')]);
        instance = buildChat();

        const second = await instance.execute<void, string>(CHAT_AGENT_CREATE_COMMAND);
        expect(second).toBe('agent-2');
        const third = await instance.execute<void, string>(CHAT_AGENT_CREATE_COMMAND);
        expect(third).toBe('agent-4');

        // A new row is APPENDED: the registry order is storage order, and the strip
        // sorts nothing (services/registries.ts:136-138).
        expect(readStored()).toEqual([
            agentFixture('agent-1', 'First'),
            agentFixture('agent-3', 'Third'),
            agentFixture('agent-2', 'New agent'),
            agentFixture('agent-4', 'New agent')
        ]);
        expect(instance.state<readonly AgentDefinition[]>(CHAT_AGENTS_STATE).get()).toEqual([
            agentFixture('agent-1', 'First'),
            agentFixture('agent-3', 'Third'),
            agentFixture('agent-2', 'New agent'),
            agentFixture('agent-4', 'New agent')
        ]);
    });

    it('persists what it created, so a rebuilt dashboard restores the same registry', async () => {
        instance = buildChat();
        await instance.execute<void, string>(CHAT_AGENT_CREATE_COMMAND);
        instance.dispose();

        const rebuilt = buildChat();
        try {
            expect(rebuilt.state<readonly AgentDefinition[]>(CHAT_AGENTS_STATE).get()).toEqual([
                agentFixture('agent-1', 'New agent')
            ]);
            // The OPEN row is surface state, not durable state: a fresh dashboard
            // boots with no agent selected (plugins/core.ts:409-411).
            expect(rebuilt.state<string | null>(CHAT_ACTIVE_AGENT_STATE).get()).toBe(null);
        } finally {
            rebuilt.dispose();
        }
    });
});

describe('chat agents — save', () => {
    let instance: Dashboard | null = null;

    beforeEach(() => {
        resetStorage();
        stubNetwork();
        seedAgents([agentFixture('agent-1', 'First'), agentFixture('agent-2', 'Second')]);
        instance = buildChat();
    });

    afterEach(() => {
        instance?.dispose();
        instance = null;
        vi.unstubAllGlobals();
    });

    it('replaces the row in place and persists the whole definition', async () => {
        await settleListing(instance);
        const patched = agentFixture('agent-2', 'Renamed by hand', {
            systemPrompt: 'Answer briefly.',
            messages: [
                { role: 'user', content: 'Hi' },
                { role: 'assistant', content: 'Hello' }
            ],
            tools: ['web-search', 'code-interpreter']
        });

        await instance.execute<AgentDefinition, void>(CHAT_AGENT_SAVE_COMMAND, patched);

        // Order is preserved: re-saving a row never reorders the registry
        // (registries.ts:118-127), which is what the sidebar's stable rows depend on.
        const expected = [agentFixture('agent-1', 'First'), patched];
        expect(instance.state<readonly AgentDefinition[]>(CHAT_AGENTS_STATE).get()).toEqual(expected);
        expect(readStored()).toEqual(expected);
        // A save is not a navigation: the open row and the composer prefix are untouched.
        expect(instance.state<string | null>(CHAT_ACTIVE_AGENT_STATE).get()).toBe(null);
        expect(instance.state<string>(CHAT_STATUS_STATE).get()).toBe('idle');
    });

    it('appends a definition whose id is new (an add-on writing a foreign row)', async () => {
        const foreign = agentFixture('agent-7', 'Imported', { systemPrompt: 'ctx' });
        await instance.execute<AgentDefinition, void>(CHAT_AGENT_SAVE_COMMAND, foreign);

        expect(readStored()).toEqual([
            agentFixture('agent-1', 'First'),
            agentFixture('agent-2', 'Second'),
            foreign
        ]);
    });

    it('ignores a payload with no id instead of writing an unreachable row', async () => {
        const before = JSON.stringify(readStored());
        await instance.execute<AgentDefinition, void>(CHAT_AGENT_SAVE_COMMAND, {
            id: '',
            name: 'Nameless',
            systemPrompt: '',
            messages: [],
            tools: []
        });

        expect(JSON.stringify(readStored())).toBe(before);
        expect(instance.state<readonly AgentDefinition[]>(CHAT_AGENTS_STATE).get()).toEqual([
            agentFixture('agent-1', 'First'),
            agentFixture('agent-2', 'Second')
        ]);
    });
});

describe('chat agents — delete and the composer prefix', () => {
    let instance: Dashboard | null = null;

    beforeEach(() => {
        resetStorage();
        stubNetwork();
        seedAgents([agentFixture('agent-1', 'First'), agentFixture('agent-2', 'Second')]);
        instance = buildChat();
    });

    afterEach(() => {
        instance?.dispose();
        instance = null;
        vi.unstubAllGlobals();
    });

    it('deleting the open agent drops the row and clears both selections', async () => {
        // The composer's picker and the editor's open row are INDEPENDENT cells in
        // the oracle (`agentChoice` :2516 vs `selectedAgentId` :2648); a delete that
        // removes the definition clears whichever of them named it.
        instance.execute<string, void>(CHAT_AGENT_SET_COMMAND, 'agent-1');
        instance.state<string | null>(CHAT_ACTIVE_AGENT_STATE).set('agent-1');

        await instance.execute<string, void>(CHAT_AGENT_DELETE_COMMAND, 'agent-1');

        expect(instance.state<readonly AgentDefinition[]>(CHAT_AGENTS_STATE).get()).toEqual([
            agentFixture('agent-2', 'Second')
        ]);
        expect(instance.state<string | null>(CHAT_ACTIVE_AGENT_STATE).get()).toBe(null);
        expect(instance.state<string>(CHAT_AGENT_STATE).get()).toBe('');
        expect(readStored()).toEqual([agentFixture('agent-2', 'Second')]);
    });

    it('deleting a different agent leaves the open row and the prefix alone', async () => {
        instance.execute<string, void>(CHAT_AGENT_SET_COMMAND, 'agent-1');
        instance.state<string | null>(CHAT_ACTIVE_AGENT_STATE).set('agent-1');

        await instance.execute<string, void>(CHAT_AGENT_DELETE_COMMAND, 'agent-2');

        expect(instance.state<readonly AgentDefinition[]>(CHAT_AGENTS_STATE).get()).toEqual([
            agentFixture('agent-1', 'First')
        ]);
        expect(instance.state<string | null>(CHAT_ACTIVE_AGENT_STATE).get()).toBe('agent-1');
        expect(instance.state<string>(CHAT_AGENT_STATE).get()).toBe('agent-1');
        expect(readStored()).toEqual([agentFixture('agent-1', 'First')]);
    });

    it('chat.agent.set publishes, clears, and refuses an id the registry does not have', () => {
        instance.execute<string, void>(CHAT_AGENT_SET_COMMAND, 'agent-2');
        expect(instance.state<string>(CHAT_AGENT_STATE).get()).toBe('agent-2');

        instance.execute<string, void>(CHAT_AGENT_SET_COMMAND, '');
        expect(instance.state<string>(CHAT_AGENT_STATE).get()).toBe('');

        // A stale id cannot prefix a chat; the send flow would resolve it to null
        // anyway (plugins/core.ts:332-338), so the write is refused rather than stored.
        instance.execute<string, void>(CHAT_AGENT_SET_COMMAND, 'agent-gone');
        expect(instance.state<string>(CHAT_AGENT_STATE).get()).toBe('');
    });
});
