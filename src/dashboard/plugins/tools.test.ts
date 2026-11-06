// Chat TOOLS plugin tests: the tool registry (native seed + persisted custom tools).
//
// Same headless setup as plugins/agents.test.ts: the real composition with the
// registry plugins appended through the add-on seam when composition.ts does not
// register them yet, jsdom localStorage for the durable layer, and a catch-all fetch
// double so the sessions listing never reaches the network.
//
// The assertions here are only interesting because of the merge rule the store
// documents (services/registries.ts:152-165): `list()` answers `AVAILABLE_TOOLS`
// first and then the persisted entries, "deduplicated by id with the NATIVE SEED
// winning". So a create lands AFTER the two runtime tools, a persisted row named
// `web-search` can never shadow the seed, and a delete of a native id removes nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dashboard } from '@underload/dashboard';
import type { AgentDefinition, ToolDefinition } from '../../agents';
import { createChatDashboard } from '../composition';
import {
    CHAT_ACTIVE_TOOL_STATE,
    CHAT_AGENTS_STATE,
    CHAT_AGENT_STORE_SERVICE,
    CHAT_ERROR_STATE,
    CHAT_SIDEBAR_TAB_STATE,
    CHAT_STATUS_STATE,
    CHAT_TOOL_CREATE_COMMAND,
    CHAT_TOOL_DELETE_COMMAND,
    CHAT_TOOL_SAVE_COMMAND,
    CHAT_TOOL_STORE_SERVICE,
    CHAT_TOOLS_STATE
} from '../contract';
import {
    createToolsPlugin,
    DEFAULT_TOOL_LANGUAGE,
    DEFAULT_TOOL_NAME,
    DEFAULT_TOOL_SOURCE
} from './tools';
import { createAgentsPlugin } from './agents';
import {
    createTestChat,
    installFetch,
    jsonResponse,
    resetStorage,
    seedAgents,
    AGENTS_STORAGE_KEY,
    TEST_BASE_URL,
    TEST_PROVIDER_URL,
    TOOLS_STORAGE_KEY,
    type FetchDouble
} from './harness';

/**
 * The runtime-provided seed, spelled out because the tests below assert the merged
 * list in full (src/agents/index.ts:79-82). A native entry carries NO `language` or
 * `code` key at all — that is the single-shape invariant of the registry (:44-60).
 */
const NATIVE_TOOLS: ToolDefinition[] = [
    { id: 'web-search', name: 'Web search', native: true },
    { id: 'code-interpreter', name: 'Code interpreter', native: true }
];

/** One coded (custom, persisted) tool, in the shape the store round-trips. */
const codedFixture = (
    id: string,
    name: string,
    overrides: Partial<ToolDefinition> = {}
): ToolDefinition => ({
    id,
    name,
    native: false,
    language: 'javascript',
    code: `run('${id}')`,
    ...overrides
});

/** Reads the persisted tool list exactly as `ToolStore` wrote it. */
const readStoredTools = (): unknown[] => {
    const raw = window.localStorage.getItem(TOOLS_STORAGE_KEY);
    return raw === null ? [] : (JSON.parse(raw) as unknown[]);
};

/** Seeds the persisted (custom) tool registry raw, so a malformed row can be tested. */
const seedStoredTools = (tools: readonly unknown[]): void => {
    window.localStorage.setItem(TOOLS_STORAGE_KEY, JSON.stringify([...tools]));
};

/**
 * Reads the persisted AGENT registry, i.e. the write the tool delete performs when it
 * prunes a dangling tool id out of an agent's allowed set (plugins/tools.ts). The
 * helper is local (and raw) on purpose: asserting on the stored bytes proves the
 * pruning is durable instead of only visible in the current cell.
 */
const readStoredAgents = (): unknown[] => {
    const raw = window.localStorage.getItem(AGENTS_STORAGE_KEY);
    return raw === null ? [] : (JSON.parse(raw) as unknown[]);
};

/** Does the shipped composition already register the registries? See agents.test.ts. */
const REGISTRIES_IN_COMPOSITION = (() => {
    const probe = createChatDashboard({ baseUrl: TEST_BASE_URL, providerUrl: TEST_PROVIDER_URL });
    try {
        probe.service<unknown>(CHAT_TOOL_STORE_SERVICE);
        probe.service<unknown>(CHAT_AGENT_STORE_SERVICE);
        return true;
    } catch {
        return false;
    } finally {
        probe.dispose();
    }
})();

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

const buildChat = (): Dashboard =>
    createTestChat(
        REGISTRIES_IN_COMPOSITION
            ? {}
            : { extraPlugins: [createAgentsPlugin(), createToolsPlugin()] }
    );

/** Waits past the sessions plugin's deferred mount listing (see agents.test.ts). */
const settleListing = async (dashboard: Dashboard): Promise<void> => {
    await vi.waitFor(() => {
        expect(network === null ? 0 : network.callsFor(TEST_BASE_URL).length).toBeGreaterThan(0);
    });
    await vi.waitFor(() => {
        expect(dashboard.state<string>(CHAT_STATUS_STATE).get()).toBe('idle');
    });
};

describe('chat tools — registry adoption', () => {
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

    it('lists the native seed first, then the persisted custom tools', () => {
        seedStoredTools([codedFixture('tool-1', 'Scratchpad')]);
        instance = buildChat();

        expect(instance.state<readonly ToolDefinition[]>(CHAT_TOOLS_STATE).get()).toEqual([
            ...NATIVE_TOOLS,
            codedFixture('tool-1', 'Scratchpad')
        ]);
        expect(instance.state<string>(CHAT_ERROR_STATE).get()).toBe('');
    });

    it('lets the native seed win an id clash, so a hand-written row cannot shadow a runtime tool', () => {
        // The merge rule from registries.ts:152-165 asserted through the cell.
        seedStoredTools([codedFixture('web-search', 'Hijacked search', { native: true, code: undefined })]);
        instance = buildChat();

        expect(instance.state<readonly ToolDefinition[]>(CHAT_TOOLS_STATE).get()).toEqual(NATIVE_TOOLS);
    });

    it('skips a malformed persisted row and keeps the rest of the registry', () => {
        // `isStoredTool` (registries.ts:62-71) rejects a row with no name; the rest
        // of the list still loads, which is what "degrade, never throw" means here.
        seedStoredTools([
            { id: 'tool-bad', native: false },
            codedFixture('tool-good', 'Good tool')
        ]);
        instance = buildChat();

        expect(instance.state<readonly ToolDefinition[]>(CHAT_TOOLS_STATE).get()).toEqual([
            ...NATIVE_TOOLS,
            codedFixture('tool-good', 'Good tool')
        ]);
    });

    it('answers the seed alone when storage is corrupt', () => {
        window.localStorage.setItem(TOOLS_STORAGE_KEY, 'not json');
        instance = buildChat();

        expect(instance.state<readonly ToolDefinition[]>(CHAT_TOOLS_STATE).get()).toEqual(NATIVE_TOOLS);
    });
});

describe('chat tools — create', () => {
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

    it('creates a coded tool, opens it and moves the rail to the Tool tab', async () => {
        instance = buildChat();
        await settleListing(instance);

        const id = await instance.execute<void, string>(CHAT_TOOL_CREATE_COMMAND);

        expect(id).toBe('tool-1');
        const created = codedFixture('tool-1', DEFAULT_TOOL_NAME, {
            language: DEFAULT_TOOL_LANGUAGE,
            code: DEFAULT_TOOL_SOURCE
        });
        // Appended AFTER the runtime seed: a custom row never displaces a native one.
        expect(instance.state<readonly ToolDefinition[]>(CHAT_TOOLS_STATE).get()).toEqual([
            ...NATIVE_TOOLS,
            created
        ]);
        expect(instance.state<string | null>(CHAT_ACTIVE_TOOL_STATE).get()).toBe('tool-1');
        expect(instance.state<'chat' | 'agent' | 'tool' | 'settings'>(CHAT_SIDEBAR_TAB_STATE).get()).toBe('tool');
        // Only the CUSTOM registry is persisted; the seed is code, not stored data
        // (registries.ts:167-169 writes `readStoredTools()` plus the new row).
        expect(readStoredTools()).toEqual([created]);
        // A registry write is not a request: no busy label, no banner.
        expect(instance.state<string>(CHAT_STATUS_STATE).get()).toBe('idle');
        expect(instance.state<string>(CHAT_ERROR_STATE).get()).toBe('');
    });

    it('allocates the lowest free id and appends a second press after the first', async () => {
        seedStoredTools([codedFixture('tool-1', 'Scratchpad')]);
        instance = buildChat();

        const next = await instance.execute<void, string>(CHAT_TOOL_CREATE_COMMAND);
        expect(next).toBe('tool-2');
        const third = await instance.execute<void, string>(CHAT_TOOL_CREATE_COMMAND);
        expect(third).toBe('tool-3');

        expect(readStoredTools()).toEqual([
            codedFixture('tool-1', 'Scratchpad'),
            codedFixture('tool-2', DEFAULT_TOOL_NAME, { code: DEFAULT_TOOL_SOURCE }),
            codedFixture('tool-3', DEFAULT_TOOL_NAME, { code: DEFAULT_TOOL_SOURCE })
        ]);
    });

    it('persists what it created, so a rebuilt dashboard restores the same row', async () => {
        instance = buildChat();
        await instance.execute<void, string>(CHAT_TOOL_CREATE_COMMAND);
        instance.dispose();

        const rebuilt = buildChat();
        try {
            // The non-empty default source is what survives the reload: the persisted
            // guard rejects `code: ''` (registries.ts:69), which is why a fresh tool
            // is created with DEFAULT_TOOL_SOURCE rather than a blank body.
            expect(rebuilt.state<readonly ToolDefinition[]>(CHAT_TOOLS_STATE).get()).toEqual([
                ...NATIVE_TOOLS,
                codedFixture('tool-1', DEFAULT_TOOL_NAME, {
                    language: DEFAULT_TOOL_LANGUAGE,
                    code: DEFAULT_TOOL_SOURCE
                })
            ]);
            // The open row is surface state: a fresh dashboard selects nothing.
            expect(rebuilt.state<string | null>(CHAT_ACTIVE_TOOL_STATE).get()).toBe(null);
        } finally {
            rebuilt.dispose();
        }
    });
});

describe('chat tools — save', () => {
    let instance: Dashboard | null = null;

    beforeEach(() => {
        resetStorage();
        stubNetwork();
        seedStoredTools([
            codedFixture('tool-1', 'Scratchpad'),
            codedFixture('tool-2', 'Formatter', { language: 'typescript' })
        ]);
        instance = buildChat();
    });

    afterEach(() => {
        instance?.dispose();
        instance = null;
        vi.unstubAllGlobals();
    });

    it('replaces the row in place and persists name, language and source', async () => {
        const patched = codedFixture('tool-2', 'Renamed formatter', {
            language: 'javascript',
            code: 'export function run() { return 1; }'
        });
        await instance.execute<ToolDefinition, void>(CHAT_TOOL_SAVE_COMMAND, patched);

        // Position preserved: re-saving never reorders the registry (:118-127).
        const expected = [
            ...NATIVE_TOOLS,
            codedFixture('tool-1', 'Scratchpad'),
            patched
        ];
        expect(instance.state<readonly ToolDefinition[]>(CHAT_TOOLS_STATE).get()).toEqual(expected);
        expect(readStoredTools()).toEqual([
            codedFixture('tool-1', 'Scratchpad'),
            patched
        ]);
        expect(instance.state<string>(CHAT_STATUS_STATE).get()).toBe('idle');
    });

    it('persists a native rename but the seed still answers the next read', async () => {
        // A native row's identity is runtime-owned: the write lands, the read still
        // shows the seed (the merge rule), which is why the panel draws a native tool
        // as read-only text instead of a field that would silently not stick.
        const renamed: ToolDefinition = { id: 'web-search', name: 'Hijacked search', native: true };
        await instance.execute<ToolDefinition, void>(CHAT_TOOL_SAVE_COMMAND, renamed);

        // The cell re-reads through the merge, so the seed's name stands.
        expect(instance.state<readonly ToolDefinition[]>(CHAT_TOOLS_STATE).get()).toEqual([
            ...NATIVE_TOOLS,
            codedFixture('tool-1', 'Scratchpad'),
            codedFixture('tool-2', 'Formatter', { language: 'typescript' })
        ]);
        expect(readStoredTools()).toEqual([
            codedFixture('tool-1', 'Scratchpad'),
            codedFixture('tool-2', 'Formatter', { language: 'typescript' }),
            renamed
        ]);
    });

    it('ignores a payload with no id', async () => {
        const before = JSON.stringify(readStoredTools());
        await instance.execute<ToolDefinition, void>(CHAT_TOOL_SAVE_COMMAND, {
            id: '',
            name: 'Nameless',
            native: false,
            language: 'javascript',
            code: 'x'
        });

        expect(JSON.stringify(readStoredTools())).toBe(before);
        expect(instance.state<readonly ToolDefinition[]>(CHAT_TOOLS_STATE).get()).toEqual([
            ...NATIVE_TOOLS,
            codedFixture('tool-1', 'Scratchpad'),
            codedFixture('tool-2', 'Formatter', { language: 'typescript' })
        ]);
    });
});

describe('chat tools — delete', () => {
    let instance: Dashboard | null = null;

    beforeEach(() => {
        resetStorage();
        stubNetwork();
        seedStoredTools([
            codedFixture('tool-1', 'Scratchpad'),
            codedFixture('tool-2', 'Formatter', { language: 'typescript' })
        ]);
        instance = buildChat();
    });

    afterEach(() => {
        instance?.dispose();
        instance = null;
        vi.unstubAllGlobals();
    });

    it('drops a coded row, persists the removal and clears the selection of the open tool', async () => {
        instance.state<string | null>(CHAT_ACTIVE_TOOL_STATE).set('tool-2');

        await instance.execute<string, void>(CHAT_TOOL_DELETE_COMMAND, 'tool-2');

        expect(instance.state<readonly ToolDefinition[]>(CHAT_TOOLS_STATE).get()).toEqual([
            ...NATIVE_TOOLS,
            codedFixture('tool-1', 'Scratchpad')
        ]);
        expect(instance.state<string | null>(CHAT_ACTIVE_TOOL_STATE).get()).toBe(null);
        expect(readStoredTools()).toEqual([codedFixture('tool-1', 'Scratchpad')]);
    });

    it('leaves a different tool open when the deleted row is not the open one', async () => {
        instance.state<string | null>(CHAT_ACTIVE_TOOL_STATE).set('tool-1');

        await instance.execute<string, void>(CHAT_TOOL_DELETE_COMMAND, 'tool-2');

        expect(instance.state<string | null>(CHAT_ACTIVE_TOOL_STATE).get()).toBe('tool-1');
        expect(instance.state<readonly ToolDefinition[]>(CHAT_TOOLS_STATE).get()).toEqual([
            ...NATIVE_TOOLS,
            codedFixture('tool-1', 'Scratchpad')
        ]);
    });

    it('cannot delete a runtime tool: the row stays listed and its selection stays open', async () => {
        instance.state<string | null>(CHAT_ACTIVE_TOOL_STATE).set('web-search');

        await instance.execute<string, void>(CHAT_TOOL_DELETE_COMMAND, 'web-search');

        // `remove` only rewrites the PERSISTED list (registries.ts:43-50, :171-173),
        // so the seed is still there — and clearing the selection of a row that is
        // still on screen would be the lie the panel cannot render.
        expect(instance.state<readonly ToolDefinition[]>(CHAT_TOOLS_STATE).get()).toEqual([
            ...NATIVE_TOOLS,
            codedFixture('tool-1', 'Scratchpad'),
            codedFixture('tool-2', 'Formatter', { language: 'typescript' })
        ]);
        expect(instance.state<string | null>(CHAT_ACTIVE_TOOL_STATE).get()).toBe('web-search');
        // Nothing was persisted: no entry named web-search was ever written.
        expect(readStoredTools()).toEqual([
            codedFixture('tool-1', 'Scratchpad'),
            codedFixture('tool-2', 'Formatter', { language: 'typescript' })
        ]);
    });

    it('prunes a deleted tool id out of every saved agent so the rail stops counting it', async () => {
        // Agents reference tool IDS (src/agents:25-30), and the rail renders an agent
        // row as "`N` turns · `N` tools" straight from `chat.agents`
        // (ChatSidebar.tsx:94 `agentMeta`). Counting an id that no longer resolves to a
        // registry row is the stale metadata this pins away.
        seedAgents([
            {
                id: 'agent-1',
                name: 'Scout',
                systemPrompt: 'Look first',
                messages: [{ role: 'user', content: 'Hello' }],
                tools: ['web-search', 'tool-2', 'tool-1']
            }
        ]);
        instance.dispose();
        instance = buildChat();
        // Past the mount listing, so the busy label below is attributable to nothing
        // but the registry writes this command performs.
        await settleListing(instance);

        await instance.execute<string, void>(CHAT_TOOL_DELETE_COMMAND, 'tool-2');

        expect(instance.state<readonly ToolDefinition[]>(CHAT_TOOLS_STATE).get()).toEqual([
            ...NATIVE_TOOLS,
            codedFixture('tool-1', 'Scratchpad')
        ]);
        // Only the dangling id is dropped: order, the still-valid references and every
        // other field of the definition are untouched.
        expect(
            instance.state<readonly AgentDefinition[]>(CHAT_AGENTS_STATE).get()
        ).toEqual([
            {
                id: 'agent-1',
                name: 'Scout',
                systemPrompt: 'Look first',
                messages: [{ role: 'user', content: 'Hello' }],
                tools: ['web-search', 'tool-1']
            }
        ]);
        // And the write is durable, so the next dashboard agrees with this one.
        expect(readStoredAgents()).toEqual([
            {
                id: 'agent-1',
                name: 'Scout',
                systemPrompt: 'Look first',
                messages: [{ role: 'user', content: 'Hello' }],
                tools: ['web-search', 'tool-1']
            }
        ]);
        // The tool side of the graph is unaffected: the deletion is the only request.
        expect(instance.state<string>(CHAT_STATUS_STATE).get()).toBe('idle');
    });

    it('leaves an agent reference to a runtime tool alone, because that tool still exists', async () => {
        // A native id survives `remove` (registries.ts:43-50), so the reference is not
        // stale and pruning it would be the bug in the other direction.
        seedAgents([
            { id: 'agent-1', name: 'Scout', systemPrompt: '', messages: [], tools: ['web-search'] }
        ]);
        instance.dispose();
        instance = buildChat();

        await instance.execute<string, void>(CHAT_TOOL_DELETE_COMMAND, 'web-search');

        expect(
            instance.state<readonly AgentDefinition[]>(CHAT_AGENTS_STATE).get()
        ).toEqual([{ id: 'agent-1', name: 'Scout', systemPrompt: '', messages: [], tools: ['web-search'] }]);
        expect(readStoredAgents()).toEqual([
            { id: 'agent-1', name: 'Scout', systemPrompt: '', messages: [], tools: ['web-search'] }
        ]);
    });

    it('does not rewrite an agent that never referenced the deleted tool', async () => {
        // The pruning is per reference, not a blanket rewrite: an agent whose tool set
        // is untouched keeps its exact persisted bytes.
        seedAgents([
            { id: 'agent-1', name: 'Scout', systemPrompt: '', messages: [], tools: ['tool-1'] }
        ]);
        instance.dispose();
        instance = buildChat();
        const before = window.localStorage.getItem(AGENTS_STORAGE_KEY);

        await instance.execute<string, void>(CHAT_TOOL_DELETE_COMMAND, 'tool-2');

        expect(window.localStorage.getItem(AGENTS_STORAGE_KEY)).toBe(before);
        expect(
            instance.state<readonly AgentDefinition[]>(CHAT_AGENTS_STATE).get()
        ).toEqual([{ id: 'agent-1', name: 'Scout', systemPrompt: '', messages: [], tools: ['tool-1'] }]);
    });
});
